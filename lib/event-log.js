// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-event-log
import { appendFileSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'
import { normalizeEvent, summarizeLog, STRUCTURED_LOG_VERSION } from './structured-log.js'
import { setGenerationLogHook } from './history-store.js'

export const EVENT_LOG_FILE = '.qwen-paint-events.jsonl'
export const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024
const MAX_LINES = 200

/** 纯构造：不 Mkdir、不预创建文件；第一次 append 才落盘。 */
export function createEventLog({ outputDir, log, maxBytes = EVENT_LOG_MAX_BYTES, now } = {}) {
  const dir = String(outputDir ?? '').trim()
  const file = dir ? path.join(dir, EVENT_LOG_FILE) : ''
  const enabled = file !== ''
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }

  function rotateIfNeeded() {
    if (!enabled || !existsSync(file)) return
    try {
      if (statSync(file).size < maxBytes) return
      renameSync(file, file + '.1')
    } catch {
      warn('结构化日志轮转失败，本次仍尝试追加')
    }
  }

  function readLines(limit = 50) {
    if (!enabled || !existsSync(file)) return []
    try {
      const n = Math.max(1, Math.min(MAX_LINES, Math.trunc(Number(limit) || 50)))
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n)
    } catch {
      return []
    }
  }

  function append(event = {}) {
    if (!enabled) return { ok: false, reason: '未配置出图目录，结构化日志未启用' }
    try {
      rotateIfNeeded()
      const ts = typeof now === 'function' ? now() : Date.now()
      const line = JSON.stringify(normalizeEvent(event, ts))
      appendFileSync(file, line + '\n', 'utf8')
      return { ok: true, line }
    } catch {
      warn('结构化日志写入失败（不影响出图）')
      return { ok: false, reason: '结构化日志写入失败（详见插件日志）' }
    }
  }

  function summarize() {
    return summarizeLog(readLines(MAX_LINES))
  }

  function recent(limit = 20) {
    const out = []
    for (const line of readLines(limit)) {
      try { out.push(JSON.parse(line)) } catch { /* 坏行跳过，不阻断 */ }
    }
    return out
  }

  return { enabled, append, readLines, summarize, recent }
}

/**
 * ★ 2026-11-15：把一次「生成历史条目」翻译成结构化事件。
 *
 * 隐私红线：**只挑白名单字段**。entry 里的 file_path（可能是本机绝对路径）
 * 与 prompt 全文都不进事件 —— prompt 交给 normalizeEvent 只留 sha256 前 12 位。
 * 细分耗时主链路没有打点 ⇒ 四个阶段一律 null，只填本机实测的 total_ms；
 * 这是「没测到」而不是「0 毫秒」，统计端靠 null 区分。
 */
export function generationEventFromHistory(entry = {}) {
  const extra = (entry.extra && typeof entry.extra === 'object') ? entry.extra : {}
  const seconds = Number(extra.seconds)
  const fallbackTotal = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
  // ★ 2026-11-16：若上游（完成钩子 / 宿主）补报了来自 ComfyUI /history 的真实 timings，
  //   逐个字段做非负数字校验后采用；缺省仍是 null（「没测到」不是「0」）。
  //   normalizeEvent 会再过一遍白名单，这里提前裁一遍避免脏值进日志。
  const reported = (entry.timings && typeof entry.timings === 'object') ? entry.timings
    : (extra.timings && typeof extra.timings === 'object') ? extra.timings : null
  const pickTiming = (key) => {
    const v = reported ? Number(reported[key]) : NaN
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : null
  }
  const totalMs = pickTiming('total_ms') ?? fallbackTotal
  return {
    event: 'generation_complete',
    tool: entry.tool_name || '',
    kind: entry.kind || 'other',
    model: entry.model || '',
    width: entry.width,
    height: entry.height,
    steps: entry.steps,
    seed: Number.isFinite(entry.seed) ? entry.seed : null,
    prompt: entry.prompt,
    accel_chain: [],
    degraded: false,
    degrade_reasons: [],
    timings: {
      queue_ms: pickTiming('queue_ms'),
      load_ms: pickTiming('load_ms'),
      sample_ms: pickTiming('sample_ms'),
      decode_ms: pickTiming('decode_ms'),
      total_ms: totalMs,
    },
    duration_ms: totalMs,
    ok: true,
  }
}

/**
 * 把 eventLog 挂到生成完成钩子上。由 lib/tool-registry.js 在注册阶段调用一次；
 * 传 null 可解绑（测试用）。返回是否成功挂上。
 */
export function attachGenerationLogging(store) {
  if (!store || typeof store.append !== 'function') return false
  return setGenerationLogHook((entry) => {
    store.append(generationEventFromHistory(entry))
  })
}

/**
 * GET  /api/qwen-paint/events  —— 本机围栏，返回统计摘要 + 最近若干条（脱敏）
 * POST /api/qwen-paint/events  —— 本机围栏，上报一次生成事件（字段过 normalizeEvent）
 *
 * 同一路径只能注册一个 handler（reg(path, handler) 会以 path 为键覆盖），
 * 所以 GET / POST 在 handler 内按 req.method 分支，而不是拆成两条路由。
 */
export function eventLogRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, readJsonBody, log } = deps
  const store = deps.eventLog || createEventLog({ outputDir: deps.outputDir, log })
  const fail = (res) => respondJson(res, { ok: false, reason: '结构化日志暂不可用（详见插件日志）' }, 500)
  return [{
    path: '/api/qwen-paint/events',
    method: 'GET, POST',
    handler: async (req, res) => {
      if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
        respondJson(res, { ok: false, reason: 'local requests only' }, 403)
        return
      }
      try {
        if (String(req?.method || 'GET').toUpperCase() === 'POST') {
          const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) || {} : {}
          const r = store.append(body)
          respondJson(res, { ok: r.ok, logged: r.ok, reason: r.reason || '' }, r.ok ? 200 : 503)
          return
        }
        const u = new URL(String(req?.url || '/'), 'http://127.0.0.1')
        const limit = Number(u.searchParams.get('limit') || 20)
        respondJson(res, {
          ok: true,
          version: STRUCTURED_LOG_VERSION,
          enabled: store.enabled,
          timing_keys: ['queue_ms', 'load_ms', 'sample_ms', 'decode_ms', 'total_ms'],
          summary: store.summarize(),
          recent: store.recent(limit),
          note: '插件侧自动写入加速链快照 + 每次生成完成事件（含本机实测总耗时与尺寸）；'
            + 'queue/load/sample/decode 四段细分耗时主链路未打点，日志里为 null，'
            + '需要时由宿主在生成完成时 POST 补报。',
        }, 200)
      } catch (error) {
        log?.('warn', '结构化日志端点异常：' + (error?.message ?? error))
        fail(res)
      }
    },
  }]
}
