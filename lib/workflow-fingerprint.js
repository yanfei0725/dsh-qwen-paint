// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-workflow-fingerprint
import { createHash } from 'node:crypto'

/**
 * 稳定序列化：键排序列、忽略 undefined。
 * ★ 不能用 `JSON.stringify` —— 对象键顺序一变哈希就变，
 *   那指纹每天都会因为无关改动而红。
 */
export function stableJson(value, depth = 0) {
  if (depth > 12) return '"<deep>"'
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'undefined') return '"<undefined>"'
  if (t === 'number') return Number.isFinite(value) ? String(value) : `"<${String(value)}>"`
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (t === 'function') return '"<fn>"'
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, depth + 1)).join(',')}]`
  if (t === 'object') {
    // Set / Map 也见得到（caps.nodes 有时是 Set）—— 排序后当数组处理，保证确定性。
    if (typeof value.forEach === 'function' && typeof value.size === 'number') {
      const arr = []
      value.forEach((v) => arr.push(v))
      return `[${arr.map((v) => stableJson(v, depth + 1)).sort().join(',')}]`
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k], depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

/** 图的 sha256 指纹（前 32 位十六进制，够用且好比对）。 */
export function fingerprint(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex').slice(0, 32)
}

/**
 * 找出两个结构第一处差异，返回可读路径。
 * 给失败信息用 —— 「图变了」如果不说变在哪，等于没报错。
 */
export function firstDiff(a, b, at = '$') {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb) return { path: at, a: ta, b: tb }
  if (ta === 'array') {
    if (a.length !== b.length) return { path: `${at}.length`, a: a.length, b: b.length }
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.join(',') !== kb.join(',')) {
      const onlyA = ka.filter((k) => !(k in b))
      const onlyB = kb.filter((k) => !(k in a))
      return { path: at, a: `多出 ${onlyA.join(',') || '-'}`, b: `多出 ${onlyB.join(',') || '-'}` }
    }
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${at}.${k}`)
      if (d) return d
    }
    return null
  }
  return Object.is(a, b) ? null : { path: at, a, b }
}
