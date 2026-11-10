/**
 * lib/accel-profiles.js —— 加速档的**互斥选择**（未装就退回"不加速"，绝不抛错）。
 *
 * ## 它修的是什么
 *   报告 v2 的写法：
 *     pick({ frames, vendor }) { if (frames > 100) return 'easycache'; ... }
 *     // 而 AccelPass 里：if (!installed.has(profile)) throw new Error('加速节点未安装')
 *   本机 **EasyCache 没装** ⇒ 任何 >100 帧的任务都会**直接抛错失败**，
 *   而不是降级成"不加速、正常跑"。违反 G7「兜底不写死」。
 *   ⇒ 本文件把 `installed` 变成 pick 的**入参**：只返回已装的档，没有就返回 null。
 *
 * ## 三档的适用面（都是第三方自定义节点，没装就是没装，不假装）
 *   · `sage`     SageAttention —— **只对 NVIDIA** 有意义（内核依赖 CUDA）。
 *   · `spectrum` ComfyUI-Spectrum-Qwen-Proper —— 跳步，图/视频都能用。
 *   · `easycache` EasyCache —— 长任务（帧多）收益最大，但本机未装。
 *
 * ## 返回值约定
 *   `pick()` 返回档 id 或 **null**。null 的含义是「这一单不加加速节点，正常跑」——
 *   调用方收到 null 必须**空跑**（跳过 pass），不得抛错。
 */

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
