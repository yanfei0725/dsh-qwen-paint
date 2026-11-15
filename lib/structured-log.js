/**
 * lib/structured-log.js —— 结构化事件日志（JSON Lines）。
 *
 * 目的：把「面向调试的文本日志」补成可跨版本做性能趋势分析的事件流。
 * 只记事实：尺寸 / 实际启用的加速链 / 降级原因 / 耗时分解（队列·加载·采样·解码）。
 *
 * 隐私红线（与项目其它端点一致）：
 *   · 不写本机绝对路径、真实用户名、凭据；文件路径一律不进日志；
 *   · prompt 只留 sha256 前 12 位，绝不存全文；
 *   · 不写用户提供的加速倍率数字（那些是 unverified 资料，不是本机实测）。
 * 本模块不碰文件系统：落盘由调用方注入的 appendLine 决定，轮转只发事件。
 */
import { createHash } from 'node:crypto'
import { sanitizeReason } from './http-errors.js'

export const STRUCTURED_LOG_VERSION = 1
export const TIMING_KEYS = Object.freeze(['queue_ms', 'load_ms', 'sample_ms', 'decode_ms', 'total_ms'])

/** 供回归反查「日志里没夹带私人内容」的判据。本机路径 / 用户目录 / UNC / 凭据。 */
export const PRIVATE_PATTERNS = Object.freeze([
  /[A-Za-z]:[\\/]/u,
  /\/(?:Users|home|var|tmp|opt|etc|mnt|media)\//u,
  /\\\\[^\\]+\\[^\\]+/u,
  /(?:npm_|ghp_|github_pat_)[A-Za-z0-9]{20,}/u,
])

const MAX_STR = 240
const MAX_LIST = 8
// ★ 所有字符串字段一律过项目统一消毒闸门：调用方哪怕误把本机路径 / 用户名
//   塞进 model / tool / reason，也不可能混进日志（隐私红线，不能靠调用方自觉）。
const clip = (v) => sanitizeReason(String(v ?? '')).slice(0, MAX_STR)
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null)

/** prompt 只留指纹，不落全文。 */
export function promptHash(prompt) {
  const s = String(prompt ?? '')
  return s === '' ? '' : createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
}

/** 归一成单行合法 JSON 的对象；undefined / NaN 一律变 null，数组有上限。 */
export function normalizeEvent(event = {}, ts = null) {
  const timings = {}
  for (const k of TIMING_KEYS) timings[k] = num(event.timings?.[k])
  const chain = Array.isArray(event.accel_chain)
    ? event.accel_chain.slice(0, MAX_LIST).map((x) => clip(x)) : []
  const reasons = Array.isArray(event.degrade_reasons)
    ? event.degrade_reasons.slice(0, MAX_LIST).map((x) => clip(x)) : []
  return {
    v: STRUCTURED_LOG_VERSION,
    ts: Number.isFinite(ts) ? ts : null,
    event: clip(event.event || 'generation'),
    tool: clip(event.tool),
    kind: clip(event.kind),
    model: clip(event.model),
    width: num(event.width),
    height: num(event.height),
    steps: num(event.steps),
    seed: Number.isFinite(event.seed) ? event.seed : null,
    accel_chain: chain,
    degraded: event.degraded === true,
    degrade_reasons: reasons,
    timings,
    vram_budget_mb: num(event.vram_budget_mb),
    duration_ms: num(event.duration_ms),
    ok: event.ok === true,
    prompt_hash: event.prompt_hash ? clip(event.prompt_hash) : promptHash(event.prompt),
  }
}

/**
 * @param {object} deps
 * @param {(line:string)=>void} [deps.appendLine] 落盘由调用方决定
 * @param {()=>number} [deps.now]
 * @param {boolean} [deps.enabled] 关闭时 emit 零分配、不调用 appendLine
 */
export function makeStructuredLogger({ appendLine, now, enabled = true } = {}) {
  const on = enabled === true && typeof appendLine === 'function'
  return {
    enabled: on,
    emit(event = {}) {
      if (!on) return false
      try {
        const t = typeof now === 'function' ? now() : Date.now()
        const line = JSON.stringify(normalizeEvent(event, t))
        appendLine(line + '\n')
        return true
      } catch {
        // 日志失败绝不影响出图主链路，也不把异常内容写进任何响应。
        return false
      }
    },
  }
}

export function recordGeneration(logger, event = {}) {
  if (!logger || typeof logger.emit !== 'function') return false
  return logger.emit({ event: 'generation', ...event })
}

/** 跨版本性能趋势聚合：均值 / p50 / p95 / 降级率 / 按加速链与类型分组。纯函数。 */
export function summarizeLog(lines = []) {
  const rows = []
  for (const line of lines) {
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object') rows.push(o)
    } catch { /* 坏行跳过，不阻断统计 */ }
  }
  const totals = rows.map((r) => r.timings?.total_ms)
    .filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  const pct = (p) => totals.length === 0
    ? null : totals[Math.min(totals.length - 1, Math.floor(p * totals.length))]
  const mean = totals.length === 0
    ? null : Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
  const byChain = {}
  for (const r of rows) {
    const key = Array.isArray(r.accel_chain) && r.accel_chain.length
      ? [...r.accel_chain].sort().join('+') : '(none)'
    byChain[key] = (byChain[key] || 0) + 1
  }
  const byKind = {}
  for (const r of rows) {
    const key = r.kind || '(unknown)'
    byKind[key] = (byKind[key] || 0) + 1
  }
  return {
    rows: rows.length,
    mean_ms: mean,
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
    degraded_rate: rows.length === 0 ? null
      : Math.round(rows.filter((r) => r.degraded === true).length / rows.length * 1000) / 10,
    by_chain: byChain,
    by_kind: byKind,
    versions: [...new Set(rows.map((r) => r.v))].sort(),
  }
}
