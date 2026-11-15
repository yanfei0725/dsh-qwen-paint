/**
 * lib/manual-upscale.js —— 手动超分参数层（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   用户**手动**指定超分引擎 / 倍率 / 降噪 / 锐化 / 分块大小，
 *   而不是依赖「生成后自动放大」（cfg.upscaleAfter）或工具默认值。
 *
 * ## 与既有 upscale_image 的关系
 *   lib/index.js 的 makeUpscaleTool() 已经支持 auto / vosr2 / realesrgan / scale 2-16，
 *   但它是「工具 + 自动放大」两条路径共用的，且没有降噪 / 锐化 / 自定义模型权重入口。
 *   本模块**不改动它**（index.js 贴 DSH Store 单文件上限），提供独立的手动参数层：
 *     · 构造可审阅的工作流草案与参数；
 *     · 只有调用方注入真实执行器时才允许执行，否则返回参数预览 + 明确降级。
 *
 * ## 安全
 *   输入必须落在 outputDir 或显式允许的 sourceDirs 内，拒绝 .. 穿越与任意本机路径；
 *   输出必须落在 outputDir 内。异常只写本机日志，回固定文案。
 */
import path from 'node:path'

export const UPSCALE_ENGINES = Object.freeze([
  { id: 'auto', label: '自动（按本机探测结果选）', needsWeight: false },
  { id: 'vosr2', label: 'VOSR2', needsWeight: false },
  { id: 'realesrgan', label: 'RealESRGAN（放大模型权重）', needsWeight: true },
  { id: 'custom', label: '自定义权重文件', needsWeight: true },
])

export const MANUAL_SCALE_CHOICES = Object.freeze([2, 3, 4, 6, 8, 16])
export const MANUAL_UPSCALE_NOTE = '手动超分：全部参数由用户显式给出，不自动执行、不自动下载权重。'

export function resolveUpscaleSourcePath({ source, outputDir, sourceDirs = [] } = {}) {
  const src = String(source ?? '').trim()
  if (!src) return { ok: false, reason: '没给源图片（source）' }
  const roots = [outputDir, ...sourceDirs].map((d) => String(d ?? '').trim()).filter(Boolean).map((d) => path.resolve(d))
  if (roots.length === 0) return { ok: false, reason: '没有配置任何允许的源目录' }
  if (src.replace(/\\/g, '/').split('/').some((p) => p === '..')) {
    return { ok: false, reason: '输入路径不允许 .. 穿越' }
  }
  const abs = path.isAbsolute(src) ? path.resolve(src) : path.resolve(roots[0], src)
  for (const root of roots) {
    if (abs === root) continue
    if (abs.startsWith(root + path.sep)) return { ok: true, path: abs }
  }
  return { ok: false, reason: '源图片不在允许的目录内：请把图片放进公布的出图目录' }
}

export function resolveUpscaleOutputPath({ target, outputDir } = {}) {
  const rel = String(target ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (!rel) return { ok: false, reason: '没给输出文件名（target）' }
  if (!base) return { ok: false, reason: '出图目录未配置，无法做目录围栏' }
  if (rel.replace(/\\/g, '/').split('/').some((p) => p === '..')) {
    return { ok: false, reason: '输出路径不允许 .. 穿越' }
  }
  const root = path.resolve(base)
  const full = path.resolve(root, rel)
  if (full === root || !full.startsWith(root + path.sep)) {
    return { ok: false, reason: '输出路径必须落在出图目录内' }
  }
  return { ok: true, path: full }
}

export function listUpscaleEngines() {
  return UPSCALE_ENGINES.map((e) => ({ ...e, scaleChoices: MANUAL_SCALE_CHOICES.slice() }))
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * 构造**手动**超分计划（纯函数、零 I/O）。
 * 绝不声称已经放大：execute 由调用方注入，未注入时 degraded + 参数预览。
 */
export function buildManualUpscalePlan({
  source, target, engine = 'auto', scale = 4, model = '',
  denoise = 0, sharpen = 0, tileSize = 512, vaeTileSize = 1024,
  colorAlignment = 'wavelet', seed = 0,
  outputDir, sourceDirs = [], installed = {},
} = {}) {
  const e = UPSCALE_ENGINES.find((x) => x.id === String(engine ?? '').trim())
  if (!e) return { ok: false, degraded: true, reason: '未知超分引擎', plan: null }
  const src = resolveUpscaleSourcePath({ source, outputDir, sourceDirs })
  if (!src.ok) return { ok: false, degraded: true, reason: src.reason, plan: null }
  const out = resolveUpscaleOutputPath({ target, outputDir })
  if (!out.ok) return { ok: false, degraded: true, reason: out.reason, plan: null }
  const s = clamp(scale, 2, 16, 4)
  const w = String(model ?? '').trim().replace(/\\/g, '/').split('/').pop().slice(0, 160)
  if (e.needsWeight && !w) {
    return { ok: false, degraded: true, reason: '该引擎需要显式给出放大模型权重文件名（model）', plan: null }
  }
  const plan = {
    engine: e.id,
    scale: s,
    model: w,
    denoise: Number(clamp(denoise, 0, 1, 0).toFixed(3)),
    sharpen: Number(clamp(sharpen, 0, 1, 0).toFixed(3)),
    tile_size: clamp(tileSize, 64, 4096, 512),
    vae_tile_size: clamp(vaeTileSize, 64, 4096, 1024),
    color_alignment: String(colorAlignment ?? 'wavelet').slice(0, 40),
    seed: Math.trunc(clamp(seed, 0, 2147483647, 0)),
    // 只回显工作流草案；真实槽位由 /object_info 决定，绝不硬塞未核实的输入名。
    workflowDraft: {
      loader: e.id === 'realesrgan' || e.id === 'custom' ? 'UpscaleModelLoader' : 'VOSR2ModelLoader',
      upscale: e.id === 'realesrgan' || e.id === 'custom' ? 'ImageUpscaleWithModel' : 'VOSR2Upscale',
      save: 'SaveImage',
    },
    detectors: {
      // 只有真机探测到才算可用；这里不写死任何模型名。
      enginesProbed: Boolean(installed && typeof installed === 'object'),
    },
    note: MANUAL_UPSCALE_NOTE,
    unverified: true,
  }
  return { ok: true, degraded: false, reason: '', plan, sourcePath: src.path, outputPath: out.path }
}
