/** accel-profiles —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#ttsll2-space-accel-profiles */

/** 加速档清单。`vendor` 为空 = 不限厂商。 */
export const ACCEL_PROFILES = [
  {
    id: 'sage',
    label: 'SageAttention',
    vendor: 'nvidia',
    nodes: ['PatchSageAttentionKJ', 'SageAttention'],
    // Wan 链里对应的插件节点（真正能接进去的那一个）
    wanNode: 'WanVideoMemoryEfficientSageAttentionPatch',
    note: 'NVIDIA 专用内核；A 卡/I 卡上装了也跑不动',
  },
  {
    id: 'spectrum',
    label: 'Spectrum 跳步',
    vendor: '',
    nodes: ['SpectrumQwenPatch'],
    // ⚠ 这个节点是**千问图链专用**的，Wan 视频链没有对应的 patch 节点 ⇒ wanNode 空。
    wanNode: null,
    note: '通用跳步，图链可用；Wan 视频链本机无对应节点',
  },
  {
    id: 'easycache',
    label: 'EasyCache',
    vendor: '',
    nodes: ['EasyCache'],
    // VHS 视频链上没有 EasyCache 的对应接法 ⇒ wanNode 空（只在图链上生效）
    wanNode: null,
    note: '长任务（>100 帧）收益最大',
  },
]

/** 长任务的帧数阈值（超过就优先 easycache）。 */
export const LONG_TASK_FRAMES = 100

/** 按 id 取档。 */
export function profileById(id, profiles = ACCEL_PROFILES) {
  const want = String(id ?? '')
  return profiles.find((p) => p.id === want) ?? null
}

/**
 * 挑一个**已安装**的加速档。
 *
 * @param {object} opt
 * @param {number} [opt.frames=0]      本单总帧数（图像任务按 1 算）
 * @param {string} [opt.vendor='']     显卡厂商（'nvidia' | 'amd' | 'intel' | 'apple' | ''）
 * @param {Set|Array} [opt.installed]  已安装的档 id 集合；**缺省视为"什么都没装"**
 * @returns {string|null} 档 id；null = 不加速（正常跑）
 */
export function pick({ frames = 0, vendor = '', installed = [] } = {}) {
  const have = installed instanceof Set ? installed : new Set(Array.isArray(installed) ? installed : [])
  const v = String(vendor ?? '').toLowerCase()
  const f = Number.isFinite(frames) && frames > 0 ? frames : 0

  // 候选顺序：厂商专属优先；长任务把 easycache 提到最前（它专治长任务）
  const order = []
  if (v === 'nvidia') order.push('sage')
  if (f > LONG_TASK_FRAMES) order.push('easycache')
  order.push('spectrum')
  if (f <= LONG_TASK_FRAMES) order.push('easycache')

  for (const id of order) {
    if (!have.has(id)) continue
    const profile = profileById(id)
    // 厂商专属档在别的卡上不要选（装了也白装）
    if (profile && profile.vendor !== '' && profile.vendor !== v) continue
    return id
  }
  return null
}

/** 已装档集合（把 probe 结果换成 pick 的入参形状）。 */
export function installedIds(probe) {
  const ids = new Set()
  if (!probe || typeof probe !== 'object') return ids
  const packs = Array.isArray(probe.packs) ? probe.packs : []
  for (const pack of packs) {
    const id = String(pack?.id ?? '')
    if (id === '' || pack?.installed !== true) continue
    ids.add(id)
  }
  return ids
}

/** 人话说明（日志/面板用）。null 也要说人话，别让调用方自己编。 */
export function describePick(id) {
  if (id === null || id === undefined) return '不加速（没有已安装的加速档 → 正常生成）'
  const p = profileById(id)
  return p ? `加速档：${p.label}（${p.note}）` : `加速档：${String(id)}`
}

/**
 * Wan 链加速注入的**纯判定**（runVideo 与资源声明同源；2026-11-20 从 index.js 抽出直测）。
 * 不碰 workflow / log —— 注入执行与日志措辞留在调用方（runVideo 还要写 plan.accel）。
 *
 * @param {object} [opt.caps]    能力快照（caps.nodes 节点表 + caps.gpu.vendor）
 * @param {number} [opt.frames]  本单总帧数
 * @returns {{id: string|null, profile: object|null, canInject: boolean}}
 *   canInject=true 仅当「选中的档有 Wan 链对应节点 **且** 该节点本机真装了」。
 */
export function planWanAccel({ caps, frames = 0 } = {}) {
  const has = (n) => caps?.nodes?.[n] === true
  const installed = []
  if (has('EasyCache')) installed.push('easycache')
  if (has('SpectrumQwenPatch')) installed.push('spectrum')
  if (has('PatchSageAttentionKJ') || has('SageAttention')) installed.push('sage')
  const id = pick({ frames, vendor: String(caps?.gpu?.vendor ?? ''), installed })
  const profile = id === null ? null : profileById(id)
  const canInject = profile !== null && !!profile.wanNode && has(profile.wanNode)
  return { id, profile, canInject }
}
