// 设计说明外置 → docs/quality-fix-presets-design-notes.md；两档共用 int8 底座，蒸馏档 CFG 锁 1。
// Fix LoRA 权重文件名（本机实测存在，哈希见 catalog）。
export const FIX_LORA_FILE = 'qwen-image-2.1-fix-1.0-comfy.safetensors'
export const BASE_MODEL_FILE = 'qwen_image_2.1_int8_convrot.safetensors'
export const TURBO8_LORA_FILE = 'turbo8_lora_step2500.safetensors'

// 字段说明见 docs/quality-fix-presets-design-notes.md#quality-fix-note-002
export const QUALITY_FIX_PRESETS = [
  {
    id: 'qualityfix-fast',
    label: '预设B · 快速预览（T8 + Fix 0.75）',
    set: {
      steps: 8,
      cfg: 1,
      fixLora: FIX_LORA_FILE,
      fixLoraStrength: 0.75,
      turbo8Enabled: true,
      // T8 蒸馏：Euler+simple+官方sigma+CFG1，不换sigma/不分段CFG
      sampler: 'euler',
      scheduler: 'simple',
      sigmaMode: 'official-turbo',
      segmentCfg: false,
      vaeTiling: 'on',
      post: 'none',          // 预览档：关 USM/CLAHE/曲线，保持干净、优先速度
      promptMode: 'preview', // 精简负面，避免拖累蒸馏模型
    },
    note: '预设B：八步蒸馏链，Euler+官方Turbo sigma+CFG锁1（>1 会过曝崩文字）；Fix LoRA 0.75。不叠加任何后处理，优先速度。',
  },
  {
    id: 'qualityfix-high',
    label: '预设A · 高质量成品（原版2.1 + Fix 1.0）',
    set: {
      steps: 20,
      cfg: 2.8,
      fixLora: FIX_LORA_FILE,
      fixLoraStrength: 1.0,
      turbo8Enabled: false,
      // 高质量：DPM++ 2M Karras + 弱分段 CFG + 优化 sigma
      sampler: 'dpmpp_2m',
      scheduler: 'karras',
      sigmaMode: 'optimized',
      segmentCfg: true,      // 高位 CFG 起、后半段降，抑制过曝/色彩生硬
      vaeTiling: 'on',
      post: 'realistic',     // 写实增强：弱对比 + USM 0.35；人像走 portrait 档
      promptMode: 'quality', // 结构化模板 + 高质量负面词
    },
    note: '预设A：原生链 20 步 CFG 2.8，弱分段 CFG + 优化 sigma，SageAttention + VAE tiling；后处理弱对比+USM 0.35。Fix LoRA 满强度 1.0。',
  },
]

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 按 id 取一档预设（返回浅拷贝，避免调用方改脏常量）。 */
export function getQualityFixPreset(id) {
  const p = QUALITY_FIX_PRESETS.find((x) => x.id === String(id ?? '').trim())
  return p ? { ...p, set: { ...p.set } } : null
}

/**
 * 把一档预设套到出图参数上。只覆盖预设声明的键，其余原样保留。
 * 返回 { ok, reason, values, applied }。
 */
export function applyQualityFixPreset(id, values) {
  const preset = getQualityFixPreset(id)
  if (!preset) return { ok: false, reason: `没有这个画质修复预设：${String(id || '(空)')}`, values: values ?? {} }
  const merged = { ...(isObj(values) ? values : {}), ...preset.set }
  // 蒸馏链硬约束：turbo8 开启时 CFG 只能是 1
  if (merged.turbo8Enabled === true && Number(merged.cfg) !== 1) {
    merged.cfg = 1
  }
  return { ok: true, reason: '', values: merged, applied: { ...preset.set }, presetId: preset.id }
}

/** 全表体检：id 唯一、必需键齐全、蒸馏档 CFG=1、强度在 (0,1]、后处理/提示词档合法。 */
export function checkQualityFixPresets() {
  const errors = []
  const seen = new Set()
  const required = ['steps', 'cfg', 'fixLora', 'fixLoraStrength', 'turbo8Enabled',
    'sampler', 'scheduler', 'sigmaMode', 'segmentCfg', 'vaeTiling', 'post', 'promptMode']
  const POST_MODES = ['none', 'realistic', 'portrait']
  const PROMPT_MODES = ['preview', 'quality']
  const SIGMA_MODES = ['official-turbo', 'optimized']
  for (const p of QUALITY_FIX_PRESETS) {
    if (seen.has(p.id)) errors.push(`画质修复预设 id 重复：${p.id}`)
    seen.add(p.id)
    for (const k of required) if (!(k in p.set)) errors.push(`预设 ${p.id} 缺键：${k}`)
    if (!(Number(p.set.steps) >= 1)) errors.push(`预设 ${p.id} 步数非法`)
    const st = Number(p.set.fixLoraStrength)
    if (!(st > 0 && st <= 1)) errors.push(`预设 ${p.id} Fix LoRA 强度须在 (0,1]，收到 ${st}`)
    if (p.set.turbo8Enabled === true && Number(p.set.cfg) !== 1) {
      errors.push(`预设 ${p.id} 是蒸馏链但 CFG≠1`)
    }
    if (p.set.turbo8Enabled === true && p.set.segmentCfg !== false) {
      errors.push(`预设 ${p.id} 是蒸馏链但开了分段 CFG（会崩）`)
    }
    if (p.set.turbo8Enabled === true && p.set.sigmaMode !== 'official-turbo') {
      errors.push(`预设 ${p.id} 是蒸馏链但换了 sigma（会翻车）`)
    }
    if (typeof p.set.fixLora !== 'string' || p.set.fixLora === '') {
      errors.push(`预设 ${p.id} 未指定 Fix LoRA 文件`)
    }
    if (!POST_MODES.includes(p.set.post)) errors.push(`预设 ${p.id} 后处理档非法：${p.set.post}`)
    if (!PROMPT_MODES.includes(p.set.promptMode)) errors.push(`预设 ${p.id} 提示词档非法：${p.set.promptMode}`)
    if (!SIGMA_MODES.includes(p.set.sigmaMode)) errors.push(`预设 ${p.id} sigma 档非法：${p.set.sigmaMode}`)
  }
  if (QUALITY_FIX_PRESETS.length === 0) errors.push('没有任何画质修复预设')
  return errors
}
