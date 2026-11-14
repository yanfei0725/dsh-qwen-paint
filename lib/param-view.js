/**
 * lib/param-view.js —— D23 参数可视化：把"这次到底用的什么参数"摆成一张可核对的表。
 *
 * ★★ 为什么需要它：同一次出图，真正生效的参数来自四个地方 ——
 *   ① 用户显式给的（`#1`、`832×1216`）
 *   ② 清单/代码里的默认值（步数 25）
 *   ③ 被对齐规则改过的（给了 830 宽，实际按 64 的倍数跑到 832）
 *   ④ 写死在链路里的常量（CFG 2.5、采样器 euler）
 *   过去这四类在日志里混成一团，用户看到"宽 832"却不知道自己给的是 830，
 *   于是以为参数没生效。本模块的唯一职责：**每行都标清楚它从哪来**。
 *
 * ★ 不制造信息：清单里没有的键不出行；值没变的"改动"不算改动。
 */

/** 参数来源标记。顺序即展示优先级。 */
export const ORIGINS = ['user', 'default', 'aligned', 'const', 'unset']

const ORIGIN_LABEL = {
  user: '你指定',
  default: '默认值',
  aligned: '已对齐',
  const: '链路固定',
  unset: '未填',
}

/**
 * 按清单的 align 规则算出对齐后的值。
 * ★ 规则必须与 `video-workflow.js::alignFrames / alignEdge` 同口径，
 *   否则"已对齐"这个标记会变成谎话。这里只做展示用换算，**不改真值**。
 */
export function applyAlign(value, align) {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  if (align === 'edge') {
    const step = 16
    return Math.max(step, Math.round(n / step) * step)
  }
  if (align === 'frames4n1') {
    // 4n+1 对齐：9,13,17…161
    const k = Math.round((n - 1) / 4)
    return Math.max(9, k * 4 + 1)
  }
  return value
}

const fmtValue = (v) => {
  if (v === undefined) return ''
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)))
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (Array.isArray(v)) return `${v.length} 项`
  return String(v)
}

/**
 * 生成参数表。
 *
 * @param {object} manifest 工作流清单（用 params / consts 作骨架）
 * @param {object} values   调用方实际给的参数
 * @returns {{ok:boolean, reason:string, rows:Array, changed:string[], summary:string, counts:object}}
 */
export function describeParams(manifest, values) {
  const params = manifest?.params
  if (!params || typeof params !== 'object' || Object.keys(params).length === 0) {
    // 没有清单骨架时不能瞎猜参数名 —— 返回空表并说明，比编一堆键好。
    return { ok: false, reason: '该链路没有声明参数清单，无法列出参数来源', rows: [], changed: [], summary: '', counts: {} }
  }
  const vals = values ?? {}
  const rows = []
  const changed = []

  for (const key of Object.keys(params)) {
    const spec = params[key] ?? {}
    const given = vals[key]
    const hasGiven = given !== undefined && given !== null
    const def = spec.default
    let value = hasGiven ? given : def
    let origin = hasGiven ? 'user' : ('default' in spec ? 'default' : 'unset')

    // 对齐检查：给了但对不上 → 标 aligned 并写清原值与终值。
    if (spec.align && value !== undefined && value !== null && value !== '') {
      const aligned = applyAlign(value, spec.align)
      if (aligned !== value) {
        rows.push({
          key, label: spec.label ?? key, value: aligned, raw: value,
          origin: hasGiven ? 'aligned' : 'aligned', origin_label: ORIGIN_LABEL.aligned,
          note: `你给的是 ${fmtValue(value)}，按 ${spec.align === 'edge' ? '16 的倍数' : '4n+1'} 对齐后实际 ${fmtValue(aligned)}`,
        })
        changed.push(key)
        continue
      }
      value = aligned
    }

    // 与默认值相同的"用户指定"不算改动，但要保留来源标记（用户确实点了它）。
    if (hasGiven && 'default' in spec && given !== def) changed.push(key)

    rows.push({
      key,
      label: spec.label ?? key,
      value: value === undefined ? '' : value,
      display: fmtValue(value),
      origin,
      origin_label: ORIGIN_LABEL[origin],
      note: origin === 'unset' ? '清单没给默认值，本次也没填' : '',
    })
  }

  const consts = manifest?.consts
  if (consts && typeof consts === 'object') {
    for (const key of Object.keys(consts)) {
      rows.push({
        key, label: key, value: consts[key], display: fmtValue(consts[key]),
        origin: 'const', origin_label: ORIGIN_LABEL.const,
        note: '写死在链路里，本次出图不可调',
      })
    }
  }

  const counts = rows.reduce((acc, r) => { acc[r.origin] = (acc[r.origin] ?? 0) + 1; return acc }, {})
  const userBits = rows.filter((r) => r.origin === 'user' && r.display !== '')
  const head = userBits.slice(0, 4).map((r) => `${r.label}=${r.display}`).join('，')
  let summary = userBits.length === 0
    ? '本次全部参数走默认值'
    : `本次你指定了 ${userBits.length} 项：${head}${userBits.length > 4 ? ' 等' : ''}`
  if (changed.length > 0) summary += `；其中 ${changed.length} 项被对齐规则调整过（${changed.join('、')}）`

  return { ok: true, reason: '', rows, changed, summary: `${summary}。`, counts }
}
