/** vectorize —— 设计说明逐字外置：docs/bgm-opt-design-notes.md#bgm-opt-space-vectorize */
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolveUpscaleSourcePath, resolveUpscaleOutputPath } from './manual-upscale.js'

export const VECTORIZE_ENGINES = Object.freeze([
  {
    id: 'vtracer',
    label: 'VTracer · 彩色矢量化（MIT）',
    license: 'MIT',
    repo: 'visioncortex/vtracer',
    version: '1.0.0-alpha.4',
    manualOnly: false,
    note: '官方 Release 单源（win 包 965,231 B，linux musl 1,291,110 B）；输入 png/jpg/webp/bmp；彩色直接转。',
    assets: Object.freeze({
      win32: Object.freeze({
        name: 'vtracer-x86_64-pc-windows-msvc.zip', bytes: 965231,
        url: 'https://github.com/visioncortex/vtracer/releases/download/1.0.0-alpha.4/vtracer-x86_64-pc-windows-msvc.zip',
      }),
      linux: Object.freeze({
        name: 'vtracer-x86_64-unknown-linux-musl.tar.gz', bytes: 1291110,
        url: 'https://github.com/visioncortex/vtracer/releases/download/1.0.0-alpha.4/vtracer-x86_64-unknown-linux-musl.tar.gz',
      }),
    }),
    exeName: Object.freeze({ win32: 'vtracer.exe', linux: 'vtracer' }),
    presets: Object.freeze(['bw', 'poster', 'photo']),
    modes: Object.freeze(['pixel', 'polygon', 'spline']),
    inputExts: Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.bmp']),
  },
  {
    id: 'potrace',
    label: 'Potrace · 黑白线稿矢量化（GPL-2.0+，用户自备 exe）',
    license: 'GPL-2.0-or-later',
    repo: 'https://sourceforge.net/projects/potrace/',
    manualOnly: true,
    note: '官方 windows 分发在 SourceForge 且无固定权威直链 ⇒ 不进下载目录；把 potrace.exe 所在目录（或完整 exe 路径）填进 cfg.potracePath 即用。',
    exeName: Object.freeze({ win32: 'potrace.exe', linux: 'potrace' }),
    inputExts: Object.freeze(['.bmp', '.pbm', '.pgm', '.ppm']),
  },
])

export const VECTORIZE_ENGINE_IDS = Object.freeze(VECTORIZE_ENGINES.map((e) => e.id))

export function listVectorizeEngines() {
  return VECTORIZE_ENGINES.map((e) => ({
    id: e.id, label: e.label, license: e.license, version: e.version ?? '',
    repo: e.repo, manualOnly: e.manualOnly === true, note: e.note,
    assets: e.assets ?? null, presets: e.presets ?? null, modes: e.modes ?? null,
    inputExts: e.inputExts.slice(),
  }))
}

export function resolveVectorizeEngine(id) {
  return VECTORIZE_ENGINES.find((e) => e.id === String(id ?? '').trim()) ?? null
}

const platKey = (platform = process.platform) => (platform === 'win32' ? 'win32' : 'linux')

/** cfg → exe 路径。vtracer 走 cfg.vtracerPath（安装目录）；potrace 走 cfg.potracePath（目录或完整 exe）。 */
export function vectorizeExePath(engineId, cfg = {}, platform = process.platform) {
  const e = resolveVectorizeEngine(engineId)
  if (!e) return { ok: false, reason: '未知矢量化引擎：' + String(engineId ?? '') }
  // ★ 三元式里的 ?? 必须整段括起来：String(engineId==='potrace' ? a : b ?? '') 会把
  //   未配置分支变成字符串 'undefined'（真 bug，专项当场抓到）。
  const raw = String((engineId === 'potrace' ? cfg?.potracePath : cfg?.vtracerPath) ?? '').trim()
  const key = engineId === 'potrace' ? 'potracePath' : 'vtracerPath'
  if (!raw) return { ok: false, reason: '未配置 ' + key + (e.manualOnly ? '（potrace 为用户自备 exe：官方 SourceForge 项目页下载后把目录填进来即可）' : '（安装见 scripts/vectorize-catalog.mjs）') }
  const p = path.resolve(raw)
  if (existsSync(p) && statSync(p).isFile()) return { ok: true, exe: p, dir: path.dirname(p) }
  const exe = path.join(p, e.exeName[platKey(platform)])
  if (existsSync(exe)) return { ok: true, exe, dir: p }
  return { ok: false, reason: key + ' 里没有 ' + e.exeName[platKey(platform)] + '：' + p }
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * argv（纯函数）。vtracer 官方最简形态是位置参数：`vtracer input.svg output.svg [flags]`；
 * potrace：`potrace -s -o out.svg [-t turdsize] in.bmp`。
 */
export function buildVectorizeArgs({ engineId, input, output, preset = '', mode = '',
  filterSpeckle, colorPrecision, gradientStep, turdsize } = {}) {
  const e = resolveVectorizeEngine(engineId)
  if (!e) return { ok: false, reason: '未知矢量化引擎：' + String(engineId ?? ''), argv: [] }
  const inp = String(input ?? '').trim()
  const out = String(output ?? '').trim()
  if (!inp || !out) return { ok: false, reason: '输入 / 输出路径缺失', argv: [] }
  if (e.id === 'vtracer') {
    const argv = [inp, out]
    const notes = []
    const ps = String(preset ?? '').trim().toLowerCase()
    if (ps) {
      if (!e.presets.includes(ps)) return { ok: false, reason: 'preset 只支持 ' + e.presets.join(' / '), argv: [] }
      argv.push('--preset', ps)
    }
    const m = String(mode ?? '').trim().toLowerCase()
    if (m) {
      if (!e.modes.includes(m)) return { ok: false, reason: 'mode 只支持 ' + e.modes.join(' / '), argv: [] }
      argv.push('-m', m)
    }
    if (filterSpeckle !== undefined && filterSpeckle !== null && filterSpeckle !== '') {
      const f = clamp(filterSpeckle, 0, 128, 4)
      argv.push('-f', String(f))
      if (Number(filterSpeckle) !== f) notes.push('filter_speckle → ' + f + '（0~128）')
    }
    if (colorPrecision !== undefined && colorPrecision !== null && colorPrecision !== '') {
      const c = clamp(colorPrecision, 1, 8, 6)
      argv.push('-p', String(c))
      if (Number(colorPrecision) !== c) notes.push('color_precision → ' + c + '（1~8）')
    }
    if (gradientStep !== undefined && gradientStep !== null && gradientStep !== '') {
      const g = clamp(gradientStep, 0, 255, 16)
      argv.push('-g', String(g))
      if (Number(gradientStep) !== g) notes.push('gradient_step → ' + g + '（0~255）')
    }
    return { ok: true, argv, engine: e.id, notes }
  }
  // potrace：黑白位图专用
  const ext = path.extname(inp).toLowerCase()
  if (!e.inputExts.includes(ext)) {
    return { ok: false, reason: 'potrace 只吃黑白位图（bmp/pbm/pgm/ppm），收到 ' + (ext || '无扩展名') + '：彩色图请改用 vtracer 引擎（直接吃 png/jpg/webp）', argv: [] }
  }
  const t = clamp(turdsize, 0, 100, 2)
  const argv = ['-s', '-o', out]
  if (Number(turdsize ?? 2) !== t) {
    argv.push('-t', String(t))
  } else {
    argv.push('-t', String(t))
  }
  argv.push(inp)
  return { ok: true, argv, engine: e.id, notes: [] }
}

/**
 * 真实执行：execFile（argv 数组、windowsHide、超时可控）。
 * 失败回固定文案 + 退出码，原始 stderr 只进本机日志。
 */
export async function runVectorize({
  engineId, cfg = {}, sourcePath, outputPath,
  params = {}, timeoutMs = 120000, platform = process.platform,
  execFileFn = execFile, log = () => {},
} = {}) {
  const e = resolveVectorizeEngine(engineId)
  if (!e) return { ok: false, executed: false, degraded: true, reason: '未知矢量化引擎：' + String(engineId ?? ''), notes: [] }
  const exe = vectorizeExePath(engineId, cfg, platform)
  if (!exe.ok) return { ok: false, executed: false, degraded: true, reason: exe.reason, notes: [] }
  const built = buildVectorizeArgs({
    engineId, input: sourcePath, output: outputPath,
    preset: params.preset, mode: params.mode,
    filterSpeckle: params.filter_speckle, colorPrecision: params.color_precision,
    gradientStep: params.gradient_step, turdsize: params.turdsize,
  })
  if (!built.ok) return { ok: false, executed: false, degraded: true, reason: built.reason, notes: [] }
  const started = Date.now()
  try {
    await new Promise((resolve, reject) => {
      const child = execFileFn(exe.exe, built.argv, { timeout: Math.max(5000, timeoutMs), windowsHide: true }, (err) => {
        if (err) reject(err); else resolve()
      })
      child.on('error', reject)
    })
  } catch (err) {
    try { log('info', '[vectorize] 执行失败：' + (err?.message ?? String(err))) } catch { /* 忽略 */ }
    const code = Number(err?.code ?? 0)
    return {
      ok: false, executed: false, degraded: false,
      reason: '执行失败（退出码 ' + (Number.isFinite(code) && code !== 0 ? code : '非零') + '；详情见本机日志，原始报错不回传）',
      notes: built.notes ?? [], engine: e.id, argv: built.argv,
    }
  }
  return {
    ok: true, executed: true, degraded: false, reason: '',
    path: String(outputPath), engine: e.id, ms: Date.now() - started,
    argv: built.argv, notes: built.notes ?? [],
    note: '矢量化完成：SVG 由引擎直接写出，落在本机出图目录内。',
  }
}

/* ------------------------------ 工具与端点 ------------------------------ */

const json = (res, body, status = 200) => {
  try { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { /* 忽略 */ }
}
const bodyOf = (req) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { resolve(null); try { req.destroy() } catch { /* 忽略 */ } ; return } chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})
const postOnly = (req, res) => {
  if (req.method !== 'POST') { json(res, { ok: false, reason: 'POST only' }, 405); return false }
  return true
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch { json(res, { ok: false, reason: '内部错误（详情见本机日志）' }, 500) }
}

const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const STR = { type: 'string' }
const OBJ = { type: 'object' }
const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })

export function makeVectorizeTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(deps.sourceDirs) ? deps.sourceDirs : []
  const cfg = deps.cfg || {}
  return {
    name: 'vectorize_image',
    description: '位图 → SVG 矢量化（两步法）：engine=vtracer（MIT，彩色，官方 Release 单源下载、默认不装）'
      + '或 potrace（GPL-2.0+，黑白线稿，用户自备 exe，只吃 bmp/pbm/pgm/ppm）；输入限出图目录内，'
      + 'SVG 落在出图目录内；未安装/未配置时如实降级，绝不谎称已矢量化。',
    parameters: schemaOf({
      source: STR, target: STR, engine: STR, preset: STR, mode: STR,
      filter_speckle: NUM, color_precision: NUM, gradient_step: NUM, turdsize: NUM,
    }),
    timeoutMs: 2 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, output_path: STR, degraded: BOOL,
      reason: STR, run: OBJ, engine: STR, note: STR,
    }) },
    async execute(args = {}) {
      const src = resolveUpscaleSourcePath({ source: args?.source, outputDir, sourceDirs })
      if (!src.ok) return { ok: false, executed: false, output_path: '', degraded: true,
        reason: src.reason, run: {}, engine: String(args?.engine ?? ''), note: '输入必须在出图目录（或允许的源目录）内。' }
      const out = resolveUpscaleOutputPath({ target: args?.target, outputDir })
      if (!out.ok) return { ok: false, executed: false, output_path: '', degraded: true,
        reason: out.reason, run: {}, engine: String(args?.engine ?? ''), note: '输出 SVG 必须落在出图目录内。' }
      const run = await runVectorize({ engineId: args?.engine, cfg, sourcePath: src.path, outputPath: out.path,
        params: { preset: args?.preset, mode: args?.mode, filter_speckle: args?.filter_speckle,
          color_precision: args?.color_precision, gradient_step: args?.gradient_step, turdsize: args?.turdsize },
        timeoutMs: 2 * 60 * 1000, log: (...a) => { try { deps.log?.('info', ...a) } catch { /* 忽略 */ } } })
      return {
        ok: run.ok, executed: Boolean(run.executed), output_path: String(run.path ?? ''),
        degraded: run.degraded === true, reason: run.reason ?? '',
        run: { engine: run.engine ?? '', ms: run.ms ?? 0, notes: run.notes ?? [] },
        engine: run.engine ?? String(args?.engine ?? ''),
        note: run.executed ? run.note : '未安装或未配置引擎：' + (run.reason ?? '') + '（绝不谎称已矢量化）',
      }
    },
  }
}

export const VECTORIZE_ROUTE_PATHS = Object.freeze([
  '/api/qwen-paint/vectorize/capabilities',
  '/api/qwen-paint/vectorize',
])

export function vectorizeRouteTable(base = {}) {
  const outputDir = String(base.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(base.sourceDirs) ? base.sourceDirs : []
  const cfg = base.cfg || {}
  const log = base.log
  return [
    {
      path: VECTORIZE_ROUTE_PATHS[0], method: 'GET',
      handler: wrap(async (req, res) => {
        json(res, { ok: true, engines: listVectorizeEngines(),
          detected: { vtracer: vectorizeExePath('vtracer', cfg).ok, potrace: vectorizeExePath('potrace', cfg).ok },
          note: '位图 → SVG 矢量化：vtracer（彩色，MIT，官方 Release 单源下载、默认不装）+ potrace（黑白线稿，用户自备 exe）；输入限出图目录，SVG 落出图目录内。' })
      }),
    },
    {
      path: VECTORIZE_ROUTE_PATHS[1], method: 'POST',
      handler: wrap(async (req, res) => {
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const tool = makeVectorizeTool({ outputDir, sourceDirs, cfg, log })
        const r = await tool.execute(body ?? {})
        json(res, r)
      }),
    },
  ]
}
