/**
 * lib/batch-tool.js —— C11 批量参数扫描 + C12 批量部分成功。
 *
 * 解决的问题：想比较「同一句 prompt 换 4 个种子」或「横版 vs 竖版」哪个更好，
 * 现在只能一次次手动点。批量扫描把组合一次提交，并保证**单次失败不拖垮整批**。
 *
 * ★★ 两条硬设计：
 *   ① **单次迭代独立结算**：第 3 张失败时，前 2 张照样交付、后 2 张照样继续。
 *      上一代的常见写法是整批 try 包住循环 —— 一张失败全批回滚，前面的算力全白烧。
 *   ② **失败后做轻量复位**：ComfyUI 在 OOM / 节点报错后可能残留队列或模型驻留状态，
 *      直接进下一张会让后面连续的都失败。所以失败后等队列清空再继续
 *      （只在"真的失败过"时才等，正常情况下零开销）。
 *
 * `runOne` 是**注入**的（由 index.js 传 runDraw）。好处是这个模块不 import 主模块，
 * 不会形成循环依赖，也能在回归里塞一个假 runOne 把编排逻辑测透，不产生任何图。
 */
import { diagnoseError } from './diagnose-error.js'
import { makeIdempotency, hashArgs } from './idempotency.js'
import { sessionResidency, RESIDENCY_KEYS } from './model-residency.js'

/** 单批最多生成多少张。再多就该拆批了 —— 一次跑 40 张中途出问题很难收场。 */
export const BATCH_MAX = 16
export const BATCH_DEFAULT = 4

const intList = (v, max) => {
  if (!Array.isArray(v)) return []
  const out = []
  for (const x of v) {
    const n = Number(x)
    if (!Number.isInteger(n)) continue
    if (!out.includes(n)) out.push(n)
  }
  return out.slice(0, max)
}

/**
 * 尺寸解析：接受 "1024x1024" / "1024X1024" / {width,height}。
 * 返回 `{width, height}` 或 null。**不在这里对齐到 16 的倍数** ——
 * 对齐是出图链自己的事（`alignEdge`），这里要是也校一遍，两处口径迟早不一致。
 */
const parseSize = (s) => {
  if (s && typeof s === 'object' && Number.isFinite(s.width) && Number.isFinite(s.height)) {
    return { width: Math.trunc(s.width), height: Math.trunc(s.height) }
  }
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/iu.exec(String(s ?? ''))
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * 展开参数组合。纯函数，可单测。
 *
 * @returns {{ok:boolean, reason:string, combos:Array<{seed:number|null,width?:number,height?:number}>}}
 */
export function buildSweep({ seeds, sizes, count } = {}) {
  const seedList = intList(seeds, BATCH_MAX)
  const sizeList = []
  if (Array.isArray(sizes)) {
    for (const s of sizes) {
      const p = parseSize(s)
      if (p && !sizeList.some((x) => x.width === p.width && x.height === p.height)) sizeList.push(p)
      if (sizeList.length >= 4) break
    }
  }

  // 一个维度都没给：按 count 生成随机种子（这是"多抽几张看看"的最常见用法）。
  if (seedList.length === 0 && sizeList.length === 0) {
    const n = Number.isFinite(count) ? Math.trunc(count) : BATCH_DEFAULT
    if (n < 1) return { ok: false, reason: 'count 必须是 ≥ 1 的整数', combos: [] }
    if (n > BATCH_MAX) return { ok: false, reason: `单批最多 ${BATCH_MAX} 张，请拆批`, combos: [] }
    return {
      ok: true, reason: '',
      combos: Array.from({ length: n }, () => ({ seed: null })),
    }
  }

  const effSeeds = seedList.length > 0 ? seedList : [null]
  const effSizes = sizeList.length > 0 ? sizeList : [null]
  const combos = []
  for (const s of effSeeds) {
    for (const z of effSizes) {
      combos.push({ seed: s, width: z?.width, height: z?.height })
    }
  }
  if (combos.length > BATCH_MAX) {
    return { ok: false, reason: `组合数 ${combos.length} 超过单批上限 ${BATCH_MAX}，请减少种子或尺寸`, combos: [] }
  }
  return { ok: true, reason: '', combos }
}

/** 错误摘要：只留能定位问题的那一句，不把整段堆栈塞进结果。 */
const briefError = (e) => {
  const m = String(e?.message ?? e ?? '').replace(/\s+/g, ' ').trim()
  return m.length > 200 ? `${m.slice(0, 200)}…` : (m || '未知错误')
}

/**
 * 失败项的诊断摘要（C17 真正被用上的地方）。
 *
 * 只带前两条修法：批量里一次可能失败十几张，每条都挂三套完整方案会把结果撑爆；
 * 需要完整诊断时再单独查那一条。
 */
const failureDiagnosis = (e) => {
  try {
    const d = diagnoseError(e)
    return {
      code: d.code,
      title: d.title,
      node: d.node,
      retryable: d.retryable,
      fixes: d.fixes.slice(0, 2).map((f) => ({ action: f.action, gain: f.gain })),
    }
  } catch {
    return { code: 'unknown', title: '诊断失败', node: '', retryable: true, fixes: [] }
  }
}

/**
 * 等 ComfyUI 队列清空（失败后的轻量复位）。
 *
 * ★ 只在一轮里**真的出现过失败**之后才调用；正常批量零额外开销。
 *   超时就放弃等待继续下一张 —— 复位是尽力而为，不是硬前置。
 */
async function waitQueueIdle({ cfg, fetchFn, signal, timeoutMs = 15000, intervalMs = 700 }) {
  if (!cfg?.comfyUrl || typeof fetchFn !== 'function') return { waited: false, reason: '缺少 ComfyUI 地址' }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${cfg.comfyUrl}/queue`, { method: 'GET', signal, timeoutMs: 3000 })
      if (!res?.ok) return { waited: false, reason: `HTTP ${res?.status}` }
      const q = await res.json()
      const running = Array.isArray(q?.queue_running) ? q.queue_running.length : 0
      const pending = Array.isArray(q?.queue_pending) ? q.queue_pending.length : 0
      if (running === 0 && pending === 0) return { waited: true, reason: '' }
    } catch {
      // 查队列失败不该阻断批量：直接当作"没等到"，下一张照跑。
      return { waited: false, reason: '查队列失败' }
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { waited: false, reason: '等待队列清空超时（继续下一张）' }
}

export const BATCH_TOOL_NAME = 'batch_draw'

export function makeBatchTool(deps = {}) {
  const { cfg, log, runOne } = deps
  const fetchFn = deps.fetchFn ?? null
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  // 2 分钟去重窗口：挡住连点与网络重试，又不至于拦掉正常的"再来一批"。
  const idem = deps.idem ?? makeIdempotency({ ttlMs: 120_000, max: 16 })

  const tool = {
    name: BATCH_TOOL_NAME,
    description: '批量出图：固定 prompt，一次遍历多个种子 / 多个尺寸，逐张独立结算。'
      + '**单张失败不会中断整批** —— 成功的那几张照常交付，失败项在 items 里标出原因（fail 计数与 total 一定自洽）。'
      + '适合「同一句 prompt 换 4 个种子挑一张」「横版竖版各来两张」。'
      + '不传 seeds / sizes 时按 count 生成随机种子。单批上限 16 张，再多请拆批。'
      + '失败后会自动等 ComfyUI 队列清空再继续（避免一次 OOM 之后连片失败）。'
      + '要精确复现某一张，用返回的 items[].seed 单张重跑 draw_image。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '提示词（必填）。整批共用同一句。' },
        seeds: { type: 'array', items: { type: 'integer' }, description: '要遍历的种子列表；与 sizes 做笛卡尔积。' },
        sizes: { type: 'array', items: { type: 'string' }, description: '要遍历的尺寸列表，形如 "1024x1024"、"832x1216"；最多 4 个。' },
        count: { type: 'integer', description: '不传 seeds/sizes 时按此数量生成随机种子（默认 4，上限 16）。' },
        negative: { type: 'string', description: '负向提示词，整批共用。' },
        width: { type: 'integer', description: '未在 sizes 里指定尺寸时使用。' },
        height: { type: 'integer', description: '未在 sizes 里指定尺寸时使用。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer' },
          ok_count: { type: 'integer' },
          fail_count: { type: 'integer' },
          items: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
    },

    async runOnce(args = {}, exec = {}) {
      const t0 = Date.now()
      if (typeof runOne !== 'function') {
        return {
          ok: false, total: 0, ok_count: 0, fail_count: 0, items: [],
          note: '插件内部错误：批量工具缺少出图函数。这是插件的 bug，请重载插件后重试。',
        }
      }
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt === '') {
        return { ok: false, total: 0, ok_count: 0, fail_count: 0, items: [], note: 'prompt 不能为空。' }
      }

      const sweep = buildSweep({ seeds: args?.seeds, sizes: args?.sizes, count: args?.count })
      if (!sweep.ok) {
        return { ok: false, total: 0, ok_count: 0, fail_count: 0, items: [], note: sweep.reason }
      }

      const items = []
      let okCount = 0
      let failCount = 0
      let sawFailure = false
      let resetNote = ''

      for (let i = 0; i < sweep.combos.length; i += 1) {
        const c = sweep.combos[i]
        const one = {
          index: i + 1,
          seed: c.seed,
          width: c.width ?? (Number.isFinite(args?.width) ? Math.trunc(args.width) : null),
          height: c.height ?? (Number.isFinite(args?.height) ? Math.trunc(args.height) : null),
          ok: false,
          path: '',
          error: '',
        }
        try {
          // 透传公共参数，只覆盖本次迭代的 seed / 尺寸。
          const call = { ...args, prompt }
          delete call.seeds; delete call.sizes; delete call.count
          if (c.seed !== null) call.seed = c.seed
          if (c.width !== undefined) call.width = c.width
          if (c.height !== undefined) call.height = c.height
          const r = await runOne(call, exec)
          // runOne 的返回结构由 index.js 的 runDraw 决定：优先取 files[0] / path。
          const path = String(r?.path ?? (Array.isArray(r?.files) ? r.files[0] : '') ?? '')
          one.ok = true
          one.path = path
          okCount += 1
          try { log?.('info', `批量 ${i + 1}/${sweep.combos.length} 完成：${path || '(无路径)'}`) } catch { /* 忽略 */ }
        } catch (error) {
          // ★ 这里就是 C12 的核心：吞掉单次异常、记账、继续。
          one.ok = false
          one.error = briefError(error)
          one.diagnosis = failureDiagnosis(error)
          failCount += 1
          sawFailure = true
          try { log?.('warn', `批量 ${i + 1}/${sweep.combos.length} 失败：${one.error}`) } catch { /* 忽略 */ }
        }
        items.push(one)

        // 失败过就复位一次（只在后面还有任务时才有意义）。
        if (sawFailure && i < sweep.combos.length - 1) {
          const reset = await waitQueueIdle({ cfg, fetchFn, signal: exec?.signal, sleep })
          if (!reset.waited && reset.reason !== '') resetNote = reset.reason
        }
      }

      const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
      const bits = [`共 ${items.length} 张`, `成功 ${okCount}`, `失败 ${failCount}`, `耗时 ${seconds}s`]
      if (failCount > 0) bits.push('失败项已在 items 里标出原因，可按 items[].seed 单张重跑')
      if (resetNote !== '') bits.push(`复位提示：${resetNote}`)
      return {
        ok: failCount === 0,
        total: items.length,
        ok_count: okCount,
        fail_count: failCount,
        items,
        note: bits.join('，') + '。',
      }
    },
  }

  /**
   * C16 幂等保护 + B5 驻留提示，然后交给 runOnce。
   *
   * ★★ 为什么批量特别需要幂等：一批 8 张就是 8 次完整采样。
   *   Agent 的网络重试、用户手滑连点，过去都会变成"再跑 8 张"。
   *   同参数 2 分钟内重复提交现在直接复用结果；改了 seed / 尺寸 / prompt 就是另一批，照常跑。
   */
  tool.execute = async (args = {}, exec = {}) => {
    const key = hashArgs(BATCH_TOOL_NAME, {
      prompt: args?.prompt,
      seeds: args?.seeds,
      sizes: args?.sizes,
      count: args?.count,
      width: args?.width,
      height: args?.height,
      negative: args?.negative,
    })
    // B5：上一轮是视频链的话，主模型已被卸下，首张会重新加载。
    let warm = ''
    try {
      const plan = sessionResidency.plan(RESIDENCY_KEYS.image)
      if (plan.load && plan.unload.length > 0) {
        warm = `上一轮驻留的是 ${plan.unload.join('、')}，本批第一张要把主模型重新加载（首张会明显慢一些，后面几张不受影响）。`
      }
      sessionResidency.touch(RESIDENCY_KEYS.image)
    } catch { /* 记账失败不影响出图 */ }

    const out = await idem.run(key, () => tool.runOnce(args, exec))
    const res = out?.value ?? {}
    if (out?.hit === true) {
      return {
        ...res,
        note: `${res.note ?? ''}（同一批参数刚刚跑过，这次直接复用上次结果，没有重复出图；`
          + '确需重跑请换 seed 或改尺寸）。',
      }
    }
    if (warm !== '') return { ...res, note: `${res.note ?? ''}${warm}` }
    return res
  }

  return tool
}
