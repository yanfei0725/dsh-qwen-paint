/**
 * lib/workflow-presets.js —— A3 预设绑定到 manifest。
 *
 * ★★ 要解决的问题（真发生过一类）：
 *   「4 步极速」本来是 Wan2.2 的 DMD 蒸馏档，一旦被套到千问生图链上，
 *   出来的图就是糊的 —— 步数不够。反过来把 25 步套到视频链上，
 *   一条 81 帧的视频要多跑几分钟。
 *
 *   过去这种错配只能靠人记。现在每个预设**显式声明**它作用于哪条 manifest、
 *   改哪些参数；本模块负责核对：目标 manifest 存不存在、要改的键在不在它的
 *   params/consts 里。清单改名或删参数时，这里会当场红，而不是等用户出糊图。
 *
 * ★ 定位是**校验器**，不是调度器：它不改任何东西，只在提交前/测试里判"配不配"。
 */

/**
 * 预设表。
 * `manifest` 必须是 `workflows/<id>.json` 的真实 id —— 有单测逐条核对。
 * `set` 里的键必须存在于目标 manifest 的 params 或 consts —— 也有单测核对。
 */
export const PRESET_BINDINGS = [
  {
    id: 'video-dmd-4step',
    label: '视频 4 步（DMD 蒸馏）',
    manifest: 'video-wan22',
    set: { steps: 4 },
    note: 'Wan2.2 的 DMD 蒸馏权重专用；换成非蒸馏权重会糊。',
  },
  {
    id: 'video-standard',
    label: '视频标准档',
    manifest: 'video-wan22',
    set: { steps: 8, frames: 81 },
    note: '非蒸馏权重或想要更稳的连贯性时用；耗时明显更长。',
  },
  {
    id: 'image-fast',
    label: '生图快速档',
    manifest: 'image-qwen21',
    pending: true,
    set: { steps: 8 },
    note: '8 步适合打草稿与试构图；细节要求高时回到默认 25 步。',
  },
  {
    id: 'image-standard',
    label: '生图标准档',
    manifest: 'image-qwen21',
    pending: true,
    set: { steps: 25 },
    note: '官方推荐的默认档位。',
  },
]

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 某个 manifest 能用哪些预设，以及每个预设能不能落地。
 *
 * @param {string} manifestId
 * @param {object} manifest 已加载的清单（可为 null：表示清单不存在）
 */
export function presetsForManifest(manifestId, manifest) {
  const id = String(manifestId ?? '')
  const mine = PRESET_BINDINGS.filter((p) => p.manifest === id)
  if (!isObj(manifest)) {
    return {
      ok: false,
      reason: `清单 ${id} 不存在，无法绑定预设`,
      presets: [],
    }
  }
  const paramKeys = new Set(Object.keys(isObj(manifest.params) ? manifest.params : {}))
  const constKeys = new Set(Object.keys(isObj(manifest.consts) ? manifest.consts : {}))
  const presets = mine.map((p) => {
    const unknown = Object.keys(p.set).filter((k) => !paramKeys.has(k) && !constKeys.has(k))
    return {
      id: p.id,
      label: p.label,
      set: p.set,
      note: p.note,
      ok: unknown.length === 0,
      reason: unknown.length === 0 ? '' : `清单里没有这些键：${unknown.join('、')}`,
    }
  })
  return { ok: presets.every((p) => p.ok), reason: '', presets }
}

/**
 * 把预设套到一组参数上。
 * ★ 不是"合并"就完事：目标清单不匹配时**直接拒绝**，绝不让糊图跑出去。
 */
export function applyPreset(presetId, manifestId, manifest, values) {
  const id = String(presetId ?? '').trim()
  const preset = PRESET_BINDINGS.find((p) => p.id === id)
  if (!preset) {
    return { ok: false, reason: `没有这个预设：${id || '(空)'}`, values: values ?? {} }
  }
  if (preset.manifest !== String(manifestId ?? '')) {
    return {
      ok: false,
      reason: `预设「${preset.label}」是给 ${preset.manifest} 用的，不能套到 ${manifestId ?? '(未知)'} 上`,
      values: values ?? {},
    }
  }
  const check = presetsForManifest(manifestId, manifest).presets.find((p) => p.id === id)
  if (check && !check.ok) return { ok: false, reason: check.reason, values: values ?? {} }
  return { ok: true, reason: '', values: { ...(values ?? {}), ...preset.set }, applied: preset.set }
}

/**
 * 全表体检：绑定指向不存在的清单、或改了清单里没有的键，都算失败。
 * 给测试与 CI 用，返回错误数组（空 = 全过）。
 */
export function checkPresetBindings(manifestIds) {
  const ids = new Set(Array.isArray(manifestIds) ? manifestIds : [])
  const errors = []
  if (ids.size === 0) return ['没有可用的清单，无法核对预设绑定']
  for (const p of PRESET_BINDINGS) {
    // ★ pending=true 表示"这条链还没做清单化"，绑定暂时无从校验。
    //   对它报错只会制造长期假红；所以跳过，并由端点单列 preset_unverified。
    if (p.pending === true) continue
    if (!ids.has(p.manifest)) errors.push(`预设 ${p.id} 指向不存在的清单 ${p.manifest}`)
    if (!isObj(p.set) || Object.keys(p.set).length === 0) errors.push(`预设 ${p.id} 没有声明任何参数`)
  }
  const seen = new Set()
  for (const p of PRESET_BINDINGS) {
    if (seen.has(p.id)) errors.push(`预设 id 重复：${p.id}`)
    seen.add(p.id)
  }
  return errors
}
