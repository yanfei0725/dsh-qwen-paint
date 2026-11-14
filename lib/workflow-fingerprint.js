/**
 * lib/workflow-fingerprint.js —— A1 的最后一层护栏：图结构指纹。
 *
 * ★★ 为什么生图链 / TTS 链**没有**像视频链那样改成运行时清单：
 *   视频链是单分支的（一个 `Wan22ImageToVideoLatent` + 若干条件补丁），
 *   清单能一比一表达。
 *   生图链不是这样：它按 caps 折成 basic/full，按「有没有参考图/控制图/批量」
 *   分裂出十几条分支，还夹着 turbo LoRA、TE-Speed、前缀缓存的可选节点。
 *   硬把它塞进当前这套「主图 + 条件补丁」的 schema，要么表达不了，
 *   要么得给 schema 加一层"脚本"，那清单就不再是清单了。
 *   **半迁移比不迁移更危险**：两边都能跑，两边都会漂。
 *
 *   所以这里换一道更便宜、也更硬的护栏：**图结构指纹**。
 *   每次跑固定夹具，把产出的节点图做稳定序列化再算 sha256，与仓库里
 *   记录下来的一串指纹比对。图只要变了（多一个节点、改一个常量、少一个连线）
 *   就当场红，并指出第一个差异路径。
 *
 *   这抓住了清单化真正想要的东西 —— **图不是悄悄变的**，
 *   而没有付出"把复杂分支硬塞进 schema"的代价。
 *
 * ★ 指纹只存哈希，不存整张图：既不会把本机路径/权重名带进仓库，
 *   也不会因为格式化差异产生噪音。
 */
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
