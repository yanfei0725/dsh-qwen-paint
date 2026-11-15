/**
 * lib/iterate-tool.js - 单张图的多轮迭代优化工具（iterate_image）。
 *
 * 目标：对一张已有的图，按策略连跑若干轮、每轮产出候选，最后按策略挑出 best。
 *
 * 三条硬边界：
 *   ① 所有出图 I/O 全部通过 deps.runOne 注入。本模块不 import 主模块、不碰
 *      ComfyUI、不联网、不读文件、不起子进程。
 *   ② 离线默认降级：没有注入 runOne 时返回 ok:false + 明确 reason，
 *      绝不真出图、绝不假装成功。能力走探测 + 降级，不硬编码任何第三方节点包为已安装。
 *   ③ image_path 必须过 outputDir 目录围栏，判据与 lib/asr-client.js 的
 *      resolveAudioPath 完全一致（resolve 后必须仍落在 outputDir 内），只是换成图片措辞。
 *
 * output.schema.properties 必须声明 execute 返回的全部顶层字段：
 * 「漏写一个字段 = Agent 收到空对象」（见 lib/tool-contracts.js 的 slimResult）。
 * 因此只回 {ok, rounds, candidates, best, reason} 五个键，best 恒为对象（无结果时 {}）。
 *
 * 代码风格：ESM、export function/const、字符串只用 ASCII 直引号。
 */
import path from 'node:path'

export const ITERATE_TOOL_NAME = 'iterate_image'
export const STRATEGIES = Object.freeze([
  'seed_variant', 'prompt_delta', 'inpaint_refine', 'upscale_relook',
])
export const ITERATE_ROUNDS_MAX = 8
export const ITERATE_ROUNDS_DEFAULT = 3

/**
 * 目录围栏：resolve 后必须仍以 outputDir + 分隔符开头（outputDir 本身也算合法）。
 * 与 lib/asr-client.js::resolveAudioPath 同一判据，纯字符串计算，不读文件。
 * 没给 outputDir 时不替调用方猜目录（与 asr 口径一致），此时只校验非空。
 */
export function resolveImagePath({ imagePath, outputDir } = {}) {
  const file = String(imagePath ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (file === '') return { ok: false, reason: '没给图片路径' }
  if (base === '') return { ok: true, file }
  const root = path.resolve(base)
  const full = path.resolve(file)
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, reason: '图片路径必须落在出图目录内' }
  }
  return { ok: true, file: full }
}

function numericScore(candidate) {
  const r = candidate && candidate.result
  if (r && typeof r === 'object' && Number.isFinite(r.score)) return r.score
  if (typeof r === 'number' && Number.isFinite(r)) return r
  return candidate && Number.isFinite(candidate.round) ? candidate.round : 0
}

/**
 * 按策略从成功候选中挑 best：
 *   · seed_variant / upscale_relook —— 比较型：score 高者胜，平分取靠后轮次。
 *   · prompt_delta / inpaint_refine —— 渐进型：以轮次为主（越靠后累积越全），
 *     同轮次才比 score。
 * 纯函数，可单测；无成功候选时返回 {}（避免 null 进 object schema）。
 */
export function selectBest(candidates, strategy) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.ok === true) : []
  if (list.length === 0) return {}
  const progressive = strategy === 'prompt_delta' || strategy === 'inpaint_refine'
  let best = list[0]
  for (let i = 1; i < list.length; i += 1) {
    const c = list[i]
    if (progressive) {
      if (c.round > best.round) best = c
      else if (c.round === best.round && numericScore(c) > numericScore(best)) best = c
    } else {
      const sc = numericScore(c)
      const sb = numericScore(best)
      if (sc > sb || (sc === sb && c.round > best.round)) best = c
    }
  }
  return best
}

/** 逐轮构造传给 runOne 的参数。确定性（不用 Math.random），便于离线断言。 */
function buildRoundParams(imagePath, args, round, strategy, prev) {
  const base = {
    image_path: imagePath,
    strategy,
    round,
    feedback: String(args.feedback ?? ''),
  }
  if (strategy === 'seed_variant') {
    return { ...base, seed: 1000 + round * 7919, variant: round }
  }
  if (strategy === 'prompt_delta') {
    return { ...base, prompt_delta: round, accumulate: true }
  }
  if (strategy === 'inpaint_refine') {
    return { ...base, source: prev ?? null, refine_pass: round }
  }
  return { ...base, source: prev ?? null, scale: 1 + round * 0.25 }
}

function briefError(e) {
  const raw = e && typeof e === 'object' && e.message !== undefined ? e.message : e
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'
}

export function makeIterateTool(deps = {}) {
  const runOne = deps.runOne
  const cfg = deps.cfg ?? {}
  const log = deps.log

  return {
    name: ITERATE_TOOL_NAME,
    description: '对单张图做多轮迭代优化：连跑若干轮、每轮产出候选，最后按策略挑出 best。'
      + '适合「这张不错但想再抽几个种子」「按反馈逐轮加细节」「局部精修」「放大后再看一眼」。'
      + '【参数】image_path（必填，必须落在出图目录内，越界会被目录围栏拒绝）、'
      + 'rounds（轮数，1 到 ' + ITERATE_ROUNDS_MAX + '，默认 ' + ITERATE_ROUNDS_DEFAULT + '）、'
      + 'strategy（seed_variant / prompt_delta / inpaint_refine / upscale_relook 四选一）、'
      + 'feedback（可选，逐轮反馈文本，透传给每轮候选参数）。'
      + '【策略】seed_variant：换种子抽变体，按 score 挑最好；'
      + 'prompt_delta：把 feedback 逐轮累积，取最后一轮；'
      + 'inpaint_refine：以上一轮结果为源做局部精修，取最后一轮；'
      + 'upscale_relook：逐轮放大复看，按 score 挑最好。'
      + '单轮失败会记入候选并继续，不拖垮整批；全部失败时 ok=false。'
      + '【降级】未注入本地出图函数时返回 ok=false + 明确 reason，绝不真出图、不联网、不起子进程。',
    timeoutMs: 30 * 60 * 1000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image_path'],
      properties: {
        image_path: { type: 'string', description: '源图路径（必填），必须落在 outputDir 出图目录内。' },
        rounds: { type: 'integer', description: '迭代轮数，1 到 8，默认 3；超过上限会被拒绝。' },
        strategy: { type: 'string', description: 'seed_variant / prompt_delta / inpaint_refine / upscale_relook。' },
        feedback: { type: 'string', description: '逐轮反馈文本；按策略透传给每轮候选参数。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          rounds: { type: 'integer' },
          candidates: { type: 'array', items: { type: 'object' } },
          best: { type: 'object' },
          reason: { type: 'string' },
        },
      },
    },

    async execute(args = {}) {
      const fail = (reason) => ({ ok: false, rounds: 0, candidates: [], best: {}, reason })

      // 1) 参数校验（含目录围栏）先做：任何情况下都先拦，先于离线降级检查。
      const strategy = String(args.strategy ?? '').trim()
      if (!STRATEGIES.includes(strategy)) {
        return fail('strategy 必须是四种之一：' + STRATEGIES.join(' / '))
      }
      const resolved = resolveImagePath({ imagePath: args.image_path, outputDir: cfg.outputDir })
      if (!resolved.ok) return fail('目录围栏拒绝：' + resolved.reason)
      const roundsRaw = args.rounds === undefined || args.rounds === null || args.rounds === ''
        ? ITERATE_ROUNDS_DEFAULT
        : Number(args.rounds)
      if (!Number.isInteger(roundsRaw) || roundsRaw < 1) {
        return fail('rounds 必须是 >= 1 的整数')
      }
      if (roundsRaw > ITERATE_ROUNDS_MAX) {
        return fail('rounds 超过上限 ' + ITERATE_ROUNDS_MAX + '，请减少轮数')
      }

      // 2) 离线降级：没注入出图函数就到此为止，绝不真出图 / 联网 / 起子进程。
      if (typeof runOne !== 'function') {
        return fail('离线降级：未注入出图函数 runOne，本工具绝不真出图、绝不联网、绝不真起子进程。'
          + '请由宿主注入本地出图实现后再用；当前仅完成参数校验与目录围栏。')
      }

      // 3) 真逻辑：逐轮产出候选；单轮失败记账并续跑（与 batch-tool 的部分成功同口径）。
      const candidates = []
      let prev = null
      for (let round = 1; round <= roundsRaw; round += 1) {
        const params = buildRoundParams(resolved.file, args, round, strategy, prev)
        const one = { round, strategy, ok: false, params, result: null, error: '' }
        try {
          const r = await runOne(params, { strategy, round })
          one.ok = true
          one.result = r === undefined ? null : r
          prev = one.result
        } catch (error) {
          one.ok = false
          one.error = briefError(error)
          try { log?.('warn', 'iterate_image 第 ' + round + ' 轮失败：' + one.error) } catch { /* 忽略 */ }
        }
        candidates.push(one)
      }

      const best = selectBest(candidates, strategy)
      const ok = Object.keys(best).length > 0
      const bits = [strategy, '完成 ' + candidates.length + '/' + roundsRaw + ' 轮']
      if (!ok) bits.push('没有可用候选')
      return {
        ok,
        rounds: candidates.length,
        candidates,
        best,
        reason: ok ? bits.join('；') + '，best 已按策略规则挑出。' : bits.join('；') + '。',
      }
    },
  }
}
