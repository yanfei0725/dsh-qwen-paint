/**
 * lib/http-errors.js —— HTTP 错误响应的**统一消毒闸门**。
 *
 * ## 为什么要集中做，而不是逐个端点改
 *   项目里所有端点（含外置到 lib/*-endpoints.js 的那些）注入的都是同一个
 *   `respondJson`。如果逐处把 `String(error?.message ?? error)` 换成固定文案，
 *   要改 30 多遍、还会把「为什么失败」这个有用的诊断信息一起丢掉。
 *   ✓ 正解：在唯一的出口消毒 —— 保留诊断文字，只抹掉本机路径 / 用户名。
 *
 * ## 覆盖的字段（都是实测会带异常消息的）
 *   · `ok:false` 的 `reason`（最常见）
 *   · `ok:true, saved:false` 的 `reason`（写盘失败：pipeline-controls / style-library）
 *   · `reasons[]`、`launchError`、`error`
 *   · `optimization.reasons[]`（仅异常态 `ok:false` / `level:unknown`）
 *
 * ## 性能
 *   只有命中上述「错误语义字段」时才展开对象 + 跑正则；正常响应（含每 5 秒的
 *   状态轮询）连 `Object.keys` 都不做，热路径零额外分配。
 */
// 允许空格（Windows 路径常含 `Program Files`），只在引号 / 括号 / 分号 / 换行处收口。
const WIN_ABS = /[A-Za-z]:[\\/][^\r\n'"`),;]*/gu
const POSIX_DIRS = /(?:\/(?:Users|home|var|tmp|opt|etc|mnt|media)\/)[^\r\n'"`),;]*/gu
const UNC = /\\\\[^\r\n'"`),;]+/gu

/** 把异常文字里的本机路径 / 用户名换成占位符；不含路径时原样返回。 */
export function sanitizeReason(text) {
  const s = String(text ?? '')
  if (s === '') return s
  return s.replace(WIN_ABS, '<本机路径>')
    .replace(POSIX_DIRS, '<本机路径>')
    .replace(UNC, '<本机路径>')
}

/**
 * 端点 catch 的统一错误体。此前 18 处各手写一遍同样的对象字面量 —— 收敛成一处。
 * ⚠ 这里**不**消毒：消毒由 respondJson 这个唯一出口做，避免两处规则打架。
 */
export const failBody = (error) => ({ ok: false, reason: String(error?.message ?? error) })

/** 只对「错误语义字段」消毒；正常响应原样返回同一个对象引用。 */
export function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body
  const opt = body.optimization
  const optDirty = opt && (opt.ok === false || opt.level === 'unknown') && Array.isArray(opt.reasons)
  const needs = body.ok === false || body.saved === false
    || (typeof body.reason === 'string' && body.reason !== '')
    || Array.isArray(body.reasons)
    || typeof body.launchError === 'string' || typeof body.error === 'string'
    || optDirty
  if (!needs) return body

  const out = { ...body }
  if (typeof out.reason === 'string') out.reason = sanitizeReason(out.reason)
  if (typeof out.launchError === 'string') out.launchError = sanitizeReason(out.launchError)
  if (typeof out.error === 'string') out.error = sanitizeReason(out.error)
  if (Array.isArray(out.reasons)) {
    out.reasons = out.reasons.map((v) => (typeof v === 'string' ? sanitizeReason(v) : v))
  }
  if (optDirty) {
    out.optimization = { ...opt, reasons: opt.reasons.map((v) =>
      (typeof v === 'string' ? sanitizeReason(v) : v)) }
  }
  return out
}
