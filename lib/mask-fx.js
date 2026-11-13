/**
 * lib/mask-fx.js —— 蒙版编辑增强的**参数规范化与工作流接线**（纯函数，零联网零副作用）。
 *
 * ## 真接线，不做假滑块
 *   `lib/turbo-workflow.js` 的 `InpaintCropImproved` 早就有两个真实消费点：
 *     · mask_expand_pixels  ← cfg.inpaintMaskGrow   （默认 8）
 *     · mask_blend_pixels   ← cfg.inpaintMaskBlend  （默认 32）
 *   本模块把 UI 里的「羽化 / 边缘融合 / 外扩 / 重绘强度 / 反选」规范化成这两个节点参数
 *   以及可下发的 sigma 裁剪；非法值一律 clamp，绝不把任意数字塞进工作流。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 贴着 DSH Store 单文件上限；新端点一律外置，host 只注入依赖与注册。
 */

/** UI 可调范围（与 assets/mask-fx.js 的滑块 min/max 一一对应，测试里会锁死）。 */
export const MASK_FX_LIMITS = Object.freeze({
  feather: { min: 0, max: 256, def: 32 },       // 羽化像素 → mask_blend_pixels
  edgeBlend: { min: 0, max: 100, def: 0 },      // 边缘融合 % → 叠加到 feather（0 = 不额外加成，保证默认零漂移）
  grow: { min: 0, max: 64, def: 8 },            // 外扩像素 → mask_expand_pixels
  denoise: { min: 0.3, max: 1, def: 0.7 },      // 重绘强度 → sigma 序列裁剪
  softness: { min: 0, max: 100, def: 50 },      // 笔刷软硬（前端画布生效）
})

export const MASK_FX_DEFAULTS = Object.freeze({
  feather: MASK_FX_LIMITS.feather.def,
  edgeBlend: MASK_FX_LIMITS.edgeBlend.def,
  grow: MASK_FX_LIMITS.grow.def,
  denoise: MASK_FX_LIMITS.denoise.def,
  softness: MASK_FX_LIMITS.softness.def,
  invert: false,
  preview: true,
  unloadMemory: false,
})

function clampNumber(value, limit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return limit.def
  return Math.min(limit.max, Math.max(limit.min, Math.round(n * 100) / 100))
}

/**
 * 把任意来源（UI body / query / 旧客户端）的蒙版参数规范化成可信对象。
 * 未知字段一律丢弃，布尔只认 true/false/"true"/"false"/1/0。
 */
export function normalizeMaskFx(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const bool = (v, d) => {
    if (v === true || v === 1 || v === 'true' || v === '1') return true
    if (v === false || v === 0 || v === 'false' || v === '0') return false
    return d
  }
  return {
    feather: clampNumber(r.feather, MASK_FX_LIMITS.feather),
    edgeBlend: clampNumber(r.edgeBlend, MASK_FX_LIMITS.edgeBlend),
    grow: clampNumber(r.grow, MASK_FX_LIMITS.grow),
    denoise: clampNumber(r.denoise, MASK_FX_LIMITS.denoise),
    softness: clampNumber(r.softness, MASK_FX_LIMITS.softness),
    invert: bool(r.invert, MASK_FX_DEFAULTS.invert),
    preview: bool(r.preview, MASK_FX_DEFAULTS.preview),
    unloadMemory: bool(r.unloadMemory, MASK_FX_DEFAULTS.unloadMemory),
  }
}

/**
 * 生成真正喂给 `InpaintCropImproved` 的参数覆盖。
 * 边缘融合按百分比追加到羽化像素上（100% 时最多 +64px），再 clamp 到节点上限 256。
 */
export function maskWorkflowPatch(fx) {
  const f = normalizeMaskFx(fx)
  const blend = Math.min(256, Math.max(0,
    Math.round(f.feather + (f.edgeBlend / 100) * 64)))
  return {
    mask_expand_pixels: Math.max(0, Math.trunc(f.grow)),
    mask_blend_pixels: blend,
    mask_invert: f.invert === true,
    mask_fill_holes: true,
    mask_hipass_filter: 0.1,
  }
}

/**
 * 按重绘强度裁剪官方 9 步编辑 sigma 序列。
 * 强度 1.0 = 全序列；越低越靠后开始（保留更多原图）。至少留 2 个值 + 0 结尾。
 * 输入是 `OFFICIAL_EDIT_SIGMAS_9` 那种逗号分隔字符串。
 */
export function sigmasForDenoise(sigmaText, denoise) {
  const src = String(sigmaText ?? '')
  const all = src.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
  if (all.length < 3) return src
  const d = clampNumber(denoise, MASK_FX_LIMITS.denoise)
  // ★ 默认 0.7 必须**原序列逐字不变**：既有回归锁住官方 9 步 sigma，
  //   不能因为新增了一个可调项就悄悄改变默认出图行为（零漂移原则）。
  if (d === MASK_FX_LIMITS.denoise.def) return src
  const ratio = Math.min(1, d / MASK_FX_LIMITS.denoise.def)
  const keep = Math.max(3, Math.round(all.length * ratio))
  const tail = all.slice(all.length - keep)
  // 保证以 0 收尾（ComfyUI 的 ManualSigmas 要求末值为 0）
  if (tail[tail.length - 1] !== 0) tail[tail.length - 1] = 0
  return tail.join(', ')
}

/**
 * ★ 真接线：把 UI 的蒙版参数转成 `buildTaskWorkflow` 需要的 cfg 覆盖。
 *
 * 零漂移原则：**没传 maskFx 时原样返回同一个 cfg 引用**，既有回归与默认出图
 * 行为一个字节都不变；只有 UI 明确带了参数才构造浅拷贝覆盖，且只动三个字段：
 *   · inpaintMaskGrow  → InpaintCropImproved.mask_expand_pixels
 *   · inpaintMaskBlend → InpaintCropImproved.mask_blend_pixels
 *   · officialEditSigmas → 按重绘强度裁剪（默认 0.7 时逐字不变）
 * 其余配置（启动参数、上传路径、颜色匹配等）仍完全沿用原 cfg。
 *
 * @param {object|undefined} fx UI 传入的蒙版参数（会被 normalizeMaskFx 钳制）
 * @param {object} cfg 插件配置
 * @param {string} sigmaText 官方 9 步编辑 sigma 串（由调用方给，保持本模块纯函数）
 */
export function workflowOverridesForMaskFx(fx, cfg, sigmaText = '') {
  if (!fx || typeof fx !== 'object' || Array.isArray(fx)) return cfg
  const f = normalizeMaskFx(fx)
  const p = maskWorkflowPatch(f)
  const base = (cfg && typeof cfg === 'object') ? cfg : {}
  const sigmas = typeof sigmaText === 'string' && sigmaText.trim() !== ''
    ? sigmasForDenoise(sigmaText, f.denoise)
    : ''
  return {
    ...base,
    inpaintMaskGrow: p.mask_expand_pixels,
    inpaintMaskBlend: p.mask_blend_pixels,
    // ★ 2026-11-13 审计修：反选原来只算出来、没写进 cfg，被 turbo-workflow 的
    //   硬编码 false 盖掉 —— 现在真的落到 InpaintCropImproved.mask_invert。
    inpaintMaskInvert: p.mask_invert === true,
    ...(sigmas !== '' ? { officialEditSigmas: sigmas } : {}),
  }
}

/** 给 UI 显示的一句话摘要，避免出现"用户以为生效其实没接"的误会。 */
export function describeMaskFx(fx) {
  const f = normalizeMaskFx(fx)
  const p = maskWorkflowPatch(f)
  return `羽化 ${f.feather}px · 边缘融合 ${f.edgeBlend}% · 外扩 ${p.mask_expand_pixels}px`
    + ` · 混合 ${p.mask_blend_pixels}px · 重绘强度 ${f.denoise}`
    + `${f.invert ? ' · 反选' : ''}${f.unloadMemory ? ' · 卸载内存' : ''}`
}

/** 「卸载内存模式」的可选值。auto 只在每次任务完成后触发一次 /free。 */
export const MEMORY_MODES = Object.freeze(['off', 'auto', 'manual'])

export function normalizeMemoryMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  return MEMORY_MODES.includes(v) ? v : 'off'
}
