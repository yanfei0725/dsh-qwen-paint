// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-orphan-extras
import { ENTRY_ALIASES, resolveAlias, aliasesOf, checkAliases } from './entry-alias.js'
import { SAMPLE_EDGE, extractTone, rgbToHsl, hueName } from './color-tone.js'
import {
  buildProduceRefs, resolveProduceRef, buildTimeline, timelineToPrefix,
  describeResourceNeeds, isLoopbackUrl, buildPrivacySummary,
} from './creative-chain.js'

export const ORPHAN_TOOL_NAMES = Object.freeze([
  'resolve_entry', 'plan_timeline', 'describe_resource_needs',
  'privacy_summary', 'resolve_produce_ref',
])

export const ORPHAN_ROUTE_PATHS = Object.freeze([
  '/api/qwen-paint/entry/aliases',
  '/api/qwen-paint/tone/extract',
  '/api/qwen-paint/run/resources',
])

/** 像素数组硬上限：32×32×4 = 4096。多一个都拒，避免有人拿它当图片上传口。 */
export const MAX_PIXELS = SAMPLE_EDGE * SAMPLE_EDGE * 4

const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const STR = { type: 'string' }
const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const ARR = { type: 'array', items: { type: 'object' } }
const OBJ = { type: 'object' }

/* ---------------------------------- 工具 ---------------------------------- */

/**
 * 口语入口解析。
 * @param {object} deps
 * @param {string[]} [deps.knownTools] 真实已注册的工具名（含本批外置工具），用于校验别名指向
 */
export function makeEntryAliasTool(deps = {}) {
  const known = Array.isArray(deps.knownTools) ? deps.knownTools.filter(Boolean) : []
  return {
    name: 'resolve_entry',
    description: '把口语入口名解析成真实工具名 + 预置参数。用户说了个"像工具但不在清单里"的词'
      + '（风格卡 / 批量出图 / 历史 / 配音 / 视频 / 放大 / 有哪些模型）时先用它，'
      + '不要直接回"没有这个工具"。action=list 列出全部别名表。'
      + '别名只能指向已注册工具：指向不存在的工具会明确报错（插件内部不一致），不新增影子工具。',
    parameters: schemaOf({ entry: STR, action: STR }),
    timeoutMs: 15 * 1000,
    output: {
      schema: schemaOf({
        ok: BOOL, alias: STR, tool: STR, prefill: OBJ, note: STR,
        aliases: ARR, errors: { type: 'array', items: STR }, reason: STR,
      }),
    },
    async execute(args = {}) {
      const entry = String(args?.entry ?? '').trim()
      const action = String(args?.action ?? '').trim().toLowerCase()
      if (action === 'list' || entry === '') {
        return {
          ok: true, alias: '', tool: '', prefill: {}, note: '',
          aliases: ENTRY_ALIASES.map((a) => ({ alias: a.alias, tool: a.tool, note: a.note })),
          errors: checkAliases(known), reason: '',
        }
      }
      const r = resolveAlias(entry, known)
      return {
        ok: r.ok, alias: r.alias, tool: r.tool, prefill: r.prefill ?? {},
        note: r.note, aliases: [], errors: [], reason: r.reason,
      }
    },
  }
}

/** 时间轴骨架（D20）。纯函数，不碰网络。 */
export function makeTimelineTool() {
  return {
    name: 'plan_timeline',
    description: '按目标时长切出**建议**时间轴（默认 2 秒一段，最多 12 段），并给出可直接拼进视频提示词的前缀。'
      + '这是结构建议不是硬约束：文生视频没有真实音频锚点时，模型对"第 3 秒发生什么"本就没有严格时序概念，'
      + '给骨架只是让提示词有条理地写下去。有配音时必须改用真实音频时长排轴，两者不可混用。',
    parameters: schemaOf({
      seconds: NUM, step: NUM, labels: { type: 'array', items: STR },
    }),
    timeoutMs: 15 * 1000,
    output: {
      schema: schemaOf({
        ok: BOOL, step: NUM, seconds: NUM, segments: ARR, prefix: STR, reason: STR,
      }),
    },
    async execute(args = {}) {
      const r = buildTimeline({
        seconds: args?.seconds,
        step: args?.step,
        labels: Array.isArray(args?.labels) ? args.labels : undefined,
      })
      return {
        ok: r.ok, step: r.step, seconds: r.seconds,
        segments: r.segments ?? [], prefix: r.ok ? timelineToPrefix(r) : '', reason: r.reason ?? '',
      }
    },
  }
}

/**
 * 资源需求声明（E27）。
 * 纯函数：calibration 由调用方传入（可来自 /run/resources 或 args），拿不到就是 null。
 */
export function makeResourceNeedsTool(deps = {}) {
  const calibration = deps.calibration
  return {
    name: 'describe_resource_needs',
    description: '提交前的资源需求声明：按输出像素数给相对档位（轻量 / 中等 / 偏重）、是否独占模型、'
      + '以及有没有本机同类实测的 ETA。**不编预计秒数**：没有实测记录时 est_seconds 为 null 并说明原因。'
      + '要拿本机实测 ETA 请先调 GET /api/qwen-paint/run/resources（内部读 ComfyUI /history），'
      + '再把返回的 calibration 传进来。',
    parameters: schemaOf({
      kind: STR, width: NUM, height: NUM, frames: NUM, scale: NUM, steps: NUM, calibration: OBJ,
    }),
    timeoutMs: 15 * 1000,
    output: {
      schema: schemaOf({
        ok: BOOL, kind: STR, tier: STR, tier_label: STR, pixel_estimate: NUM,
        exclusive_model: BOOL, est_seconds: NUM, eta_basis: STR, eta_samples: NUM,
        eta_confidence: STR, notes: { type: 'array', items: STR }, unverified: BOOL,
      }),
    },
    async execute(args = {}) {
      const r = describeResourceNeeds({
        kind: args?.kind,
        width: args?.width, height: args?.height, frames: args?.frames,
        scale: args?.scale, steps: args?.steps,
        calibration: args?.calibration && typeof args.calibration === 'object'
          ? args.calibration : calibration,
      })
      return { ...r, unverified: r.est_seconds === null }
    },
  }
}

/** 本轮数据流摘要（F31）。comfyUrl 缺省取宿主配置。 */
export function makePrivacySummaryTool(deps = {}) {
  const cfg = deps.cfg || {}
  return {
    name: 'privacy_summary',
    description: '本轮数据流摘要：发过哪些地址、是否访问外部网络（**按真实 URL 清单算出来的**，'
      + '不是写死 false）、加载了哪些模型、耗时多少，并提示可用 ComfyUI GET /history/<prompt_id> 交叉核对。'
      + '用户问"这些数据有没有出网 / 花不花钱"时用它，别凭印象答。',
    parameters: schemaOf({
      comfy_url: STR, request_urls: { type: 'array', items: STR },
      models: { type: 'array', items: STR }, seconds: NUM, prompt_id: STR,
    }),
    timeoutMs: 15 * 1000,
    output: {
      schema: schemaOf({
        ok: BOOL, endpoints: { type: 'array', items: STR }, request_count: NUM,
        external_network: BOOL, external_urls: { type: 'array', items: STR },
        models: { type: 'array', items: STR }, seconds: NUM, prompt_id: STR,
        summary: STR, cross_check: STR,
      }),
    },
    async execute(args = {}) {
      const comfyUrl = String(args?.comfy_url ?? '').trim() || String(cfg.comfyUrl ?? '').trim()
      return buildPrivacySummary({
        comfyUrl,
        requestUrls: Array.isArray(args?.request_urls) ? args.request_urls : [],
        models: Array.isArray(args?.models) ? args.models : [],
        seconds: args?.seconds,
        promptId: args?.prompt_id,
      })
    },
  }
}

/**
 * 产出短引用解析（D18）。
 * items 不给时读本机历史库最近 50 条 —— 这样"刚才那张"才真的能解析出来。
 */
export function makeProduceRefTool(deps = {}) {
  const admin = deps.historyAdmin
  return {
    name: 'resolve_produce_ref',
    description: '把「刚才那张」「#2」「last」「first」「fox.png」这类引用解析成某一条具体产出。'
      + '#1 永远是最新的一条。不给 items 时读本机历史库最近 50 条。'
      + '多个文件命中同一后缀时**报歧义**，绝不替用户挑一个。',
    parameters: schemaOf({ ref: STR, items: ARR, limit: NUM }),
    timeoutMs: 20 * 1000,
    output: {
      schema: schemaOf({
        ok: BOOL, index: NUM, item: OBJ, total: NUM, source: STR, reason: STR,
      }),
    },
    async execute(args = {}) {
      let items = Array.isArray(args?.items) ? args.items : []
      let source = 'args'
      if (items.length === 0 && admin && admin.available === true) {
        const lim = Number.isFinite(args?.limit) && args.limit > 0
          ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 50
        const got = admin.query({ limit: lim })
        if (got?.ok) {
          items = (got.rows ?? []).map((r) => ({
            id: r.id, kind: r.kind, path: r.file_path, created_at: r.created_at,
          }))
          source = 'history'
        }
      }
      const list = buildProduceRefs(items)
      const r = resolveProduceRef(args?.ref, list)
      return {
        ok: r.ok, index: r.index, item: r.item ?? {}, total: list.length,
        source, reason: r.reason,
      }
    },
  }
}

/* ---------------------------------- 端点 ---------------------------------- */

export function orphanRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, readJsonBody, guardWriteRequest, cfg, log } = deps
  const admin = deps.historyAdmin
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const json = (res, body, status) => respondJson(res, body, status ?? 200)

  const local = (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      json(res, { ok: false, reason: 'local requests only' }, 403); return false
    }
    return true
  }
  const postOnly = (req, res) => {
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      json(res, { ok: false, reason: 'POST only' }, 405); return false
    }
    if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return false
    return true
  }
  const wrap = (fn) => async (req, res) => {
    if (!local(req, res)) return
    try { await fn(req, res) } catch (error) {
      warn('孤儿模块端点异常：' + (error?.message ?? error))
      json(res, { ok: false, reason: '端点暂不可用（详见插件日志）' }, 500)
    }
  }
  const query = (req) => new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams

  return [
    // ① 口语入口别名全表 + 体检（重名 / 空字段 / 指向未注册工具）。
    {
      path: ORPHAN_ROUTE_PATHS[0], method: 'GET',
      handler: wrap(async (req, res) => {
        const known = Array.isArray(deps.knownTools) ? deps.knownTools : []
        json(res, {
          ok: true,
          aliases: ENTRY_ALIASES.map((a) => ({
            alias: a.alias, tool: a.tool, prefill: { ...a.prefill }, note: a.note,
          })),
          errors: checkAliases(known),
          known_tool_count: known.length,
          note: '别名只做参数预置，不改变工具语义，用户显式给的值优先；'
            + '别名指向未注册工具会进 errors，属于插件内部不一致。',
        })
      }),
    },
    // ② 参考图主色调提取：像素由浏览器 canvas 采样后送来（Node 侧无零依赖解码器）。
    {
      path: ORPHAN_ROUTE_PATHS[1], method: 'POST',
      handler: wrap(async (req, res) => {
        if (!postOnly(req, res)) return
        if (typeof readJsonBody !== 'function') {
          json(res, { ok: false, reason: '请求体不可读' }, 400); return
        }
        const body = (await readJsonBody(req, 96 * 1024)) ?? null
        if (!body) { json(res, { ok: false, reason: '请求体过大或不是合法 JSON' }, 400); return }
        const raw = body?.pixels ?? body?.data
        if (!Array.isArray(raw) || raw.length === 0) {
          json(res, {
            ok: false,
            reason: `需要 pixels 数组（RGBA，长度是 4 的倍数，上限 ${MAX_PIXELS}）`,
            edge: SAMPLE_EDGE,
          }, 400); return
        }
        if (raw.length > MAX_PIXELS) {
          json(res, {
            ok: false,
            reason: `像素数组过长（${raw.length} > ${MAX_PIXELS}）：这是取样接口，不是图片上传口`,
            edge: SAMPLE_EDGE,
          }, 400); return
        }
        const tone = extractTone(raw)
        json(res, { ...tone, edge: SAMPLE_EDGE })
      }),
    },
    // ③ 资源需求声明：内部读 ComfyUI /history 拿本机实测 ETA，拿不到就诚实给 null。
    {
      path: ORPHAN_ROUTE_PATHS[2], method: 'GET',
      handler: wrap(async (req, res) => {
        const q = query(req)
        const num = (k) => {
          const v = q.get(k)
          return v === null ? undefined : (Number(v) || undefined)
        }
        const kind = String(q.get('kind') ?? '').trim()
        let calibration
        let etaInfo = { source: 'none', ok: false, reason: '' }
        if (q.get('live_eta') === '1' && typeof deps.fetchCalibration === 'function') {
          try {
            const got = await deps.fetchCalibration({ cfg: cfg ?? {}, fetchFn: deps.fetchFn })
            calibration = got?.calibration
            etaInfo = {
              source: 'comfy-history', ok: got?.ok === true,
              reason: String(got?.reason ?? ''), samples: Array.isArray(got?.samples) ? got.samples.length : 0,
            }
          } catch {
            etaInfo = { source: 'comfy-history', ok: false, reason: '本机 /history 读取失败' }
          }
        }
        const r = describeResourceNeeds({
          kind,
          width: num('width'), height: num('height'), frames: num('frames'),
          scale: num('scale'), steps: num('steps'),
          calibration,
        })
        json(res, { ...r, eta_source: etaInfo, unverified: r.est_seconds === null })
      }),
    },
  ]
}

/** 给 /agent-guide 用的一段说明（工具与端点的对应关系）。 */
export function describeOrphanWiring() {
  return {
    tools: ORPHAN_TOOL_NAMES.slice(),
    routes: ORPHAN_ROUTE_PATHS.slice(),
    notes: [
      'resolve_entry：口语入口 → 真实工具名 + 预置参数；别名只做预置，不改语义。',
      'plan_timeline：建议时间轴（2 秒一段 / 上限 12 段）；有配音时必须改用真实音频时长排轴。',
      'describe_resource_needs：只给相对档位与是否独占模型；没实测就 est_seconds=null。',
      'privacy_summary：external_network 按真实 URL 清单算，不写死 false。',
      'resolve_produce_ref：#1 恒为最新；同名后缀多命中报歧义。',
      'color-tone 只做色调，不猜构图 / 光影 / 材质；取样在浏览器 canvas，Node 侧只算不碰文件。',
    ],
  }
}

export { SAMPLE_EDGE, extractTone, rgbToHsl, hueName, aliasesOf, isLoopbackUrl }
