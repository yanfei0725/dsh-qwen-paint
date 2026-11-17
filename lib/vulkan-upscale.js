// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-vulkan-upscale
import path from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'

export const VULKAN_UPSCALE_ENGINES = Object.freeze([
  {
    id: 'realesrgan-ncnn-vulkan',
    label: 'Real-ESRGAN · Vulkan 直跑',
    version: 'v0.2.0',
    license: 'MIT',
    repo: 'xinntao/Real-ESRGAN-ncnn-vulkan',
    note: '轻量（windows 包 2,159,606 B，exe + 模型全含）；模型清单以解压后 models/ 实际探测为准。',
    scaleRange: Object.freeze([2, 4]),
    assets: Object.freeze({
      win32: Object.freeze({
        name: 'realesrgan-ncnn-vulkan-v0.2.0-windows.zip', bytes: 2159606,
        url: 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/v0.2.0/realesrgan-ncnn-vulkan-v0.2.0-windows.zip',
      }),
      linux: Object.freeze({
        name: 'realesrgan-ncnn-vulkan-v0.2.0-ubuntu.zip', bytes: 3654741,
        url: 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/v0.2.0/realesrgan-ncnn-vulkan-v0.2.0-ubuntu.zip',
      }),
    }),
    exeName: Object.freeze({ win32: 'realesrgan-ncnn-vulkan.exe', linux: 'realesrgan-ncnn-vulkan' }),
  },
  {
    id: 'realcugan-ncnn-vulkan',
    label: 'Real-CUGAN · Vulkan 直跑（动漫向）',
    version: '20220728',
    license: 'MIT',
    repo: 'nihui/realcugan-ncnn-vulkan',
    note: 'windows 包 45,977,449 B（含 models-pro / models-se / models-nose 三组动漫模型，以实际解压为准）；-n 传模型目录名。',
    scaleRange: Object.freeze([1, 3]),
    assets: Object.freeze({
      win32: Object.freeze({
        name: 'realcugan-ncnn-vulkan-20220728-windows.zip', bytes: 45977449,
        url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip',
      }),
      linux: Object.freeze({
        name: 'realcugan-ncnn-vulkan-20220728-ubuntu.zip', bytes: 46704187,
        url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-ubuntu.zip',
      }),
    }),
    exeName: Object.freeze({ win32: 'realcugan-ncnn-vulkan.exe', linux: 'realcugan-ncnn-vulkan' }),
  },
])

export const VULKAN_ENGINE_IDS = Object.freeze(VULKAN_UPSCALE_ENGINES.map((e) => e.id))
const FORMATS = Object.freeze(['png', 'jpg', 'webp'])

export function listVulkanEngines() {
  return VULKAN_UPSCALE_ENGINES.map((e) => ({
    id: e.id, label: e.label, version: e.version, license: e.license, repo: e.repo,
    note: e.note, scaleRange: e.scaleRange.slice(), assets: e.assets, exeName: e.exeName,
  }))
}

export function resolveVulkanEngine(id) {
  return VULKAN_UPSCALE_ENGINES.find((e) => e.id === String(id ?? '').trim()) ?? null
}

const platKey = (platform = process.platform) => (platform === 'win32' ? 'win32' : 'linux')

/** 安装目录 → 可执行文件。请求体不给路径，目录只来自 cfg.vulkanUpscalePath（用户显式配置）。 */
export function vulkanExePath(engineId, installDir, platform = process.platform) {
  const e = resolveVulkanEngine(engineId)
  if (!e) return { ok: false, reason: '未知 Vulkan 引擎：' + String(engineId ?? '') }
  const dir = String(installDir ?? '').trim()
  if (!dir) return { ok: false, reason: '未配置 vulkanUpscalePath（引擎未安装；安装见 scripts/vulkan-upscale-catalog.mjs）' }
  const asset = e.assets[platKey(platform)]
  if (!asset) return { ok: false, reason: '当前平台没有预编译包：' + platKey(platform) }
  const exe = path.resolve(dir, e.exeName[platKey(platform)])
  if (!existsSync(exe)) return { ok: false, reason: '安装目录里没有 ' + e.exeName[platKey(platform)] + '：' + dir }
  return { ok: true, exe, dir: path.resolve(dir) }
}

/** 动态探测：引擎是否可用 + models/ 里真实有哪些模型（不硬编码）。 */
export function detectVulkanEngines(installDir, platform = process.platform) {
  const dir = String(installDir ?? '').trim()
  return VULKAN_UPSCALE_ENGINES.map((e) => {
    const p = vulkanExePath(e.id, dir, platform)
    if (!p.ok) return { id: e.id, label: e.label, available: false, exePath: '', models: [], reason: p.reason }
    const modelsDir = path.join(p.dir, 'models')
    const models = existsSync(modelsDir)
      ? readdirSync(modelsDir).filter((f) => f.endsWith('.param')).map((f) => f.replace(/\.param$/u, ''))
      : []
    return { id: e.id, label: e.label, available: true, exePath: p.exe, models, reason: '' }
  })
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * 构造 argv（纯函数）。argv 是**单元素数组**语义（exe 由 runVulkanUpscale 用 execFile 的
 * 第一个参数传入），这里不含 exe 本体；model 拒绝路径分隔符与 ..。
 */
export function buildVulkanArgs({
  engineId, input, output, model = '', scale, tileSize = 0, gpuId = 0,
  format = 'png', modelsAvailable = [],
} = {}) {
  const e = resolveVulkanEngine(engineId)
  if (!e) return { ok: false, reason: '未知 Vulkan 引擎：' + String(engineId ?? ''), argv: [] }
  const inp = String(input ?? '').trim()
  const out = String(output ?? '').trim()
  if (!inp || !out) return { ok: false, reason: '输入 / 输出路径缺失', argv: [] }
  const fmt = String(format ?? 'png').trim().toLowerCase()
  if (!FORMATS.includes(fmt)) return { ok: false, reason: 'format 只支持 png / jpg / webp', argv: [] }
  let w = String(model ?? '').trim()
  if (/[\\/]/u.test(w) || w.includes('..')) return { ok: false, reason: 'model 只能是模型名，不允许路径分隔符或 ..', argv: [] }
  const clamps = []
  if (!w) {
    w = String(modelsAvailable[0] ?? '').trim()
    if (!w) return { ok: false, reason: '本机 models/ 未探测到模型且未显式给 model；请先安装引擎或显式指定模型名', argv: [] }
    clamps.push('model 未显式给出 → 取本机探测到的第一个：' + w)
  }
  const s = clamp(scale, e.scaleRange[0], e.scaleRange[1], Math.min(4, e.scaleRange[1]))
  if (Number(scale) !== s) clamps.push('scale ' + String(scale) + ' → ' + s + '（' + e.id + ' 支持 ' + e.scaleRange.join('~') + '）')
  const t = clamp(tileSize, 0, 4096, 0)
  const g = clamp(gpuId, -1, 8, 0)
  const argv = ['-i', inp, '-o', out, '-s', String(s), '-n', w, '-t', String(t), '-g', String(g), '-f', fmt]
  return { ok: true, argv, usedModel: w, scale: s, tile: t, gpuId: g, format: fmt, clamps, engine: e.id, reason: '' }
}

/**
 * 真实执行：execFile（argv 数组、windowsHide、超时可控）。
 * 失败只回固定文案 + 退出码，原始 stderr 只进本机日志，绝不回吐给请求方。
 */
export async function runVulkanUpscale({
  installDir, engineId, sourcePath, outputPath,
  params = {}, timeoutMs = 300000, platform = process.platform,
  execFileFn = execFile, log = () => {},
} = {}) {
  const e = resolveVulkanEngine(engineId)
  if (!e) return { ok: false, executed: false, degraded: true, reason: '未知 Vulkan 引擎：' + String(engineId ?? ''), notes: [] }
  const exe = vulkanExePath(engineId, installDir, platform)
  if (!exe.ok) return { ok: false, executed: false, degraded: true, reason: exe.reason, notes: [] }
  const models = detectVulkanEngines(installDir, platform).find((x) => x.id === e.id)?.models ?? []
  const built = buildVulkanArgs({
    engineId, input: sourcePath, output: outputPath,
    model: params.model, scale: params.scale, tileSize: params.tileSize,
    gpuId: params.gpuId, format: params.format, modelsAvailable: models,
  })
  if (!built.ok) return { ok: false, executed: false, degraded: true, reason: built.reason, notes: [] }
  const notes = built.clamps.slice()
  const ignored = []
  if (Number(params.denoise) > 0) ignored.push('denoise（该引擎不支持，未生效）')
  if (Number(params.sharpen) > 0) ignored.push('sharpen（该引擎不支持，未生效）')
  if (ignored.length > 0) notes.push(...ignored)
  const started = Date.now()
  try {
    await new Promise((resolve, reject) => {
      const child = execFileFn(exe.exe, built.argv, { timeout: Math.max(5000, timeoutMs), windowsHide: true }, (err) => {
        if (err) reject(err); else resolve()
      })
      child.on('error', reject)
    })
  } catch (err) {
    try { log('info', '[vulkan-upscale] 执行失败：' + (err?.message ?? String(err))) } catch { /* 忽略 */ }
    const code = Number(err?.code ?? 0)
    return {
      ok: false, executed: false, degraded: false,
      reason: '执行失败（退出码 ' + (Number.isFinite(code) && code !== 0 ? code : '非零') + '；详情见本机日志，原始报错不回传）',
      notes, engine: e.id, argv: built.argv,
    }
  }
  return {
    ok: true, executed: true, degraded: false, reason: '',
    path: String(outputPath), engine: e.id, ms: Date.now() - started,
    argv: built.argv, model: built.usedModel, scale: built.scale, format: built.format,
    notes, note: 'Vulkan 直跑完成；产物由引擎直接写出，未经 ComfyUI。',
  }
}
