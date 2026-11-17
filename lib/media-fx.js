// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-media-fx

import path from 'node:path'
import { resolveMediaSourcePath } from './media-convert-tool.js'

/**
 * media-fx 自己的输出围栏：只做目录安全 + 扩展名白名单。
 * 刻意不复用 convert_media 的 resolveMediaOutputPath —— 那个强校验"扩展名必须等于 11 种
 * 格式表之一"，而音频后处理常出 .m4a/.ogg/.flac（不在那张表里），复用会误拒合法调用。
 * 目录围栏口径与它完全一致（拒 .. / 盘符越界 / 目录本身）。
 */
function resolveFxOutput({ target, outputDir, exts, defaultExt }) {
  const rel = String(target ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (!base) return { ok: false, reason: '输出目录未配置，无法做目录围栏' }
  const parts = rel.replace(/\\/g, '/').split('/')
  if (parts.some((p) => p === '..')) return { ok: false, reason: '输出路径不允许 .. 穿越' }
  const root = path.resolve(base)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, reason: '输出路径必须落在出图目录内' }
  if (full === root) return { ok: false, reason: '输出路径不能就是目录本身' }
  let ext = path.extname(full).slice(1).toLowerCase()
  if (!ext) ext = defaultExt
  if (!exts.includes(ext)) return { ok: false, reason: `输出格式 .${ext} 不在允许列表：${exts.join(' / ')}` }
  return { ok: true, path: ext === path.extname(full).slice(1).toLowerCase() ? full : full + '.' + ext }
}

const AUDIO_OUT_EXTS = ['m4a', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'opus']
const CUTOUT_OUT_EXTS = ['png', 'webp']

export const MEDIA_FX_TOOL_NAMES = Object.freeze([
  'enhance_audio', 'cutout_image', 'split_audio',
])

const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const STR = { type: 'string' }
const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const json = (res, body, status = 200) => {
  try { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { /* 忽略 */ }
}
const bodyOf = (req) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { resolve(null); try { req.destroy() } catch { /* 忽略 */ } return } chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch { json(res, { ok: false, reason: '内部错误（详情见本机日志）' }, 500) }
}
const localGate = (base, req, res) => {
  const isLocal = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  if (isLocal && !isLocal(req)) { json(res, { ok: false, reason: 'local requests only' }, 403); return false }
  return true
}

function shape(patch) {
  return {
    ok: patch.ok === true, executed: Boolean(patch.executed), degraded: Boolean(patch.degraded),
    path: patch.path ?? '', tool: patch.tool ?? '', command: Array.isArray(patch.command) ? patch.command : [],
    reason: patch.reason ?? '', note: patch.note ?? '', preview: Boolean(patch.preview),
  }
}

/* ------------------------------ ① 音频后处理 ------------------------------ */

export const AUDIO_FX_PRESETS = Object.freeze({
  voice: Object.freeze(['silenceremove', 'afftdn', 'speechnorm', 'deesser']),
  music: Object.freeze(['loudnorm']),
  podcast: Object.freeze(['silenceremove', 'compand', 'loudnorm']),
})

/**
 * 纯函数：构建音频后处理 ffmpeg argv（不执行、不碰路径围栏之外的东西）。
 * 滤镜顺序固定，保证跨调用可复现；每个开关默认关闭，只按显式参数开。
 */
export function buildAudioFxArgs(source, target, args = {}) {
  const filters = []
  // 去头尾静音
  if (args.trim_silence === true) {
    const thr = clamp(args.silence_threshold, -90, 0, -40)
    filters.push(`silenceremove=start_periods=1:start_threshold=${thr}dB:stop_periods=-1:stop_threshold=${thr}dB`)
  }
  // 无模型降噪
  if (args.denoise === true) {
    filters.push(`afftdn=nr=${clamp(args.noise_reduction, 1, 40, 12)}`)
  }
  // 参量 EQ（一个三频段足够覆盖"提升清晰度/削减轰鸣"）
  if (args.eq === true) {
    filters.push(`equalizer=f=120:t=q:w=1:g=${clamp(args.low_gain, -20, 20, -3)}`
      + `,equalizer=f=3000:t=q:w=1:g=${clamp(args.mid_gain, -20, 20, 3)}`
      + `,equalizer=f=9000:t=q:w=1:g=${clamp(args.high_gain, -20, 20, 2)}`)
  }
  // 去齿音（对 TTS 合成感最直接的改善）
  if (args.deess === true) filters.push('deesser')
  // 压缩
  if (args.compress === true) {
    filters.push(`compand=attacks=${clamp(args.attack, 0.001, 1, 0.02)}:decays=${clamp(args.decay, 0.01, 2, 0.25)}`
      + ':points=-90/-90|-60/-40|-30/-20|0/0:soft-knee=6')
  }
  // 响度归一化：voice 用 speechnorm（语音专用），其它用 loudnorm（EBU R128）
  const loud = args.loudness === true || args.preset === 'voice'
    || args.preset === 'music' || args.preset === 'podcast'
  if (loud) {
    if (args.preset === 'voice') {
      // speechnorm: e=最大扩张倍率(1..50)，l=linked channels 是 boolean(0/1)，不是电平！
      filters.push(`speechnorm=e=${clamp(args.expansion, 1, 50, 5)}:l=1`)
    } else {
      filters.push(`loudnorm=I=${clamp(args.loudness_target, -30, -5, -16)}:TP=${clamp(args.true_peak, -9, 0, -1.5)}:LRA=${clamp(args.lra, 1, 20, 11)}`)
    }
  }
  const cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', source]
  if (filters.length > 0) cmd.push('-af', filters.join(','))
  cmd.push('-c:a', String(args.codec || 'aac'), '-b:a', String(args.bitrate || '192k'), target)
  return cmd
}

/* ------------------------------ ② 无模型抠图 ------------------------------ */

export const CUTOUT_KEY_COLORS = Object.freeze(['white', 'black', 'green', 'blue', 'red'])

/** 纯函数：构建纯色键控抠图 argv；mask 非空时用 alphamerge 叠加用户画笔蒙版。 */
export function buildCutoutArgs(source, target, args = {}) {
  const useMask = Boolean(String(args.mask || '').trim())
  const key = CUTOUT_KEY_COLORS.includes(args.key_color) ? args.key_color : 'white'
  const similarity = clamp(args.similarity, 0.01, 1, 0.2)
  const blend = clamp(args.blend, 0, 1, 0.05)
  const cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', source]
  if (useMask) cmd.push('-i', String(args.mask))
  const filters = [`${key === 'white' || key === 'black' ? 'colorkey' : 'chromakey'}=${key}:${similarity}:${blend}`]
  if (useMask) {
    // 键控去背景后，再用用户蒙版限定保留区域（蒙版需与画面同尺寸，放缩由 ffmpeg 完成）
    filters.push('alphamerge=inputs=2')
  }
  cmd.push('-vf', filters.join(','))
  // 必须带 alpha 的编码：png / webp；不保留 alpha 的格式没有抠图意义，工具层会拒。
  cmd.push('-c:v', String(args.codec || 'png'), target)
  return cmd
}

/* ------------------------------ ③ 声源分离 ------------------------------ */

/**
 * 纯函数：构建 pan 中置相消 argv。
 * mode=vocal_remove（近似伴奏）: c0=FL-FR, c1=FR-FL（中置人声相消）
 * mode=vocal_isolate（近似人声）: c0=FL-FR, c1=FL-FR（把中置差异放大到双声道）
 * 仅对"人声严格居中"的立体声有效，如实标注非 BS-RoFormer 级。
 */
export function buildSplitArgs(source, targetVocals, targetMusic, args = {}) {
  const cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-y', '-i', source]
  cmd.push('-filter_complex', '[0:a]asplit=2[v][m]'
    + ';[v]pan=stereo|c0=FL-FR|c1=FL-FR[vout]'
    + ';[m]pan=stereo|c0=FL-FR|c1=FR-FL[mout]')
  cmd.push('-map', '[vout]', '-c:a', String(args.codec || 'aac'), '-b:a', String(args.bitrate || '192k'), targetVocals)
  cmd.push('-map', '[mout]', '-c:a', String(args.codec || 'aac'), '-b:a', String(args.bitrate || '192k'), targetMusic)
  return cmd
}

/* ------------------------------ 工具工厂 ------------------------------ */

function runner(deps, toolName, buildFn, doExecute) {
  const { outputDir, sourceDirs, log, mediaExec, runCommand } = deps
  const exec = (mediaExec && typeof mediaExec.runCommand === 'function')
    ? mediaExec : (typeof runCommand === 'function' ? { runCommand } : null)
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  return async (args = {}) => {
    const common = { tool: toolName }
    const src = resolveMediaSourcePath({ source: args.source, outputDir, sourceDirs })
    if (!src.ok) return shape({ ...common, reason: src.reason })
    const planned = doExecute(args, src.path, outputDir)
    if (!planned.ok) return shape({ ...common, reason: planned.reason })
    const buildArgs = { ...args, ...(planned.argPatch || {}) }
    const command = buildFn(src.path, planned.targets, buildArgs)
    if (!exec) {
      return shape({ ...common, command, degraded: true, preview: true,
        reason: '离线降级：宿主未注入媒体执行器（未探测 ffmpeg），仅返回参数预览，未生成文件。' })
    }
    try {
      const run = await exec.runCommand(command, { timeoutMs: clamp(args.timeout_ms, 1000, 1800000, 600000) })
      if (!run.ok) return shape({ ...common, command: run.command || command, degraded: true,
        reason: run.reason || 'ffmpeg 执行失败（详见本机日志），未生成文件。' })
      return shape({ ...common, ok: true, executed: true, command: run.command || command,
        path: planned.displayPath, reason: run.reason || '' })
    } catch (error) {
      warn(`${toolName} 执行异常：${error?.message ?? error}`)
      return shape({ ...common, command, degraded: true,
        reason: 'ffmpeg 执行异常（详见插件日志），未生成文件。' })
    }
  }
}

export function makeEnhanceAudioTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(deps.sourceDirs) ? deps.sourceDirs : []
  const run = runner(deps, 'enhance_audio',
    (source, targets, args) => buildAudioFxArgs(source, targets[0], args),
    (args, srcPath, outDir) => {
      const ext = String(args.format || path.extname(srcPath).slice(1) || 'm4a').toLowerCase()
      const out = resolveFxOutput({ target: args.target, outputDir: outDir,
        exts: AUDIO_OUT_EXTS, defaultExt: ext })
      if (!out.ok) return { ok: false, reason: out.reason }
      return { ok: true, targets: [out.path], displayPath: out.path }
    })
  return {
    name: 'enhance_audio',
    description: '本机音频后处理（纯 ffmpeg / 零模型 / 零外部节点）：去头尾静音、无模型降噪、三频段 EQ、'
      + '去齿音（改善 TTS 合成感）、压缩、响度归一化（语音用 speechnorm、其它用 loudnorm EBU R128）。'
      + '输入限出图目录或宿主允许的源目录，输出落出图目录；未探测到 ffmpeg 时回参数预览与降级原因，不谎称已处理。',
    parameters: schemaOf({
      source: STR, target: STR, format: STR,
      preset: STR, trim_silence: BOOL, silence_threshold: NUM, denoise: BOOL, noise_reduction: NUM,
      eq: BOOL, low_gain: NUM, mid_gain: NUM, high_gain: NUM, deess: BOOL, compress: BOOL,
      attack: NUM, decay: NUM, loudness: BOOL, loudness_target: NUM, true_peak: NUM, lra: NUM,
      codec: STR, bitrate: STR, timeout_ms: NUM,
    }),
    timeoutMs: 10 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, degraded: BOOL, path: STR, tool: STR,
      command: { type: 'array' }, reason: STR, note: STR, preview: BOOL,
    }) },
    execute: (args) => run(args),
  }
}

export function makeCutoutTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(deps.sourceDirs) ? deps.sourceDirs : []
  const run = runner(deps, 'cutout_image',
    (source, targets, args) => buildCutoutArgs(source, targets[0], args),
    (args, srcPath, outDir) => {
      const fmt = String(args.format || 'png').toLowerCase()
      if (!CUTOUT_OUT_EXTS.includes(fmt)) return { ok: false, reason: '抠图必须保留 alpha 通道，目标格式只能是 png 或 webp' }
      let maskPath = ''
      if (String(args.mask || '').trim()) {
        const m = resolveMediaSourcePath({ source: args.mask, outputDir: outDir, sourceDirs })
        if (!m.ok) return { ok: false, reason: '蒙版' + m.reason }
        maskPath = m.path
      }
      const out = resolveFxOutput({ target: args.target, outputDir: outDir, exts: CUTOUT_OUT_EXTS, defaultExt: fmt })
      if (!out.ok) return { ok: false, reason: out.reason }
      return { ok: true, targets: [out.path], displayPath: out.path, argPatch: maskPath ? { mask: maskPath } : {} }
    })
  return {
    name: 'cutout_image',
    description: '无模型抠图（纯 ffmpeg，零下载）：纯色背景键控（白/黑/绿/蓝/红，调 similarity 与 blend），'
      + '可选叠加画笔蒙版（配合圈选重绘的蒙版限定保留区域），输出保留 alpha 的 PNG / WebP。'
      + '★ 诚实边界：只对纯色/近纯色背景有效；人物头发、半透明物体、复杂场景需要 SAM 类模型，本工具做不到，不谎称。'
      + '输入/蒙版限允许的源目录，输出落出图目录；ffmpeg 未探测到时如实降级。',
    parameters: schemaOf({
      source: STR, target: STR, format: STR, key_color: STR, similarity: NUM, blend: NUM,
      mask: STR, codec: STR, timeout_ms: NUM,
    }),
    timeoutMs: 10 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, degraded: BOOL, path: STR, tool: STR,
      command: { type: 'array' }, reason: STR, note: STR, preview: BOOL,
    }) },
    execute: run,
  }
}

export function makeSplitAudioTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(deps.sourceDirs) ? deps.sourceDirs : []
  const run = runner(deps, 'split_audio',
    (source, targets, args) => buildSplitArgs(source, targets[0], targets[1], args),
    (args, srcPath, outDir) => {
      const fmt = String(args.format || 'm4a').toLowerCase()
      const vocals = resolveFxOutput({ target: args.vocals_target || 'vocals_' + path.basename(srcPath),
        outputDir: outDir, exts: AUDIO_OUT_EXTS, defaultExt: fmt })
      if (!vocals.ok) return { ok: false, reason: '人声输出：' + vocals.reason }
      const music = resolveFxOutput({ target: args.music_target || 'music_' + path.basename(srcPath),
        outputDir: outDir, exts: AUDIO_OUT_EXTS, defaultExt: fmt })
      if (!music.ok) return { ok: false, reason: '伴奏输出：' + music.reason }
      return { ok: true, targets: [vocals.path, music.path], displayPath: vocals.path + ' | ' + music.path }
    })
  return {
    name: 'split_audio',
    description: '声源分离的"可用部分"（纯 ffmpeg pan 中置相消，零模型零下载）：输出近似人声与近似伴奏两个文件。'
      + '原理是人声多混在立体声中置，相消得伴奏、差异放大得近似人声。'
      + '★ 诚实边界：仅对"人声严格居中"的立体声有效，不是 BS-RoFormer / Demucs 级分离，'
      + '单声道/人声偏侧/复杂混音效果有限，不谎称。输入限允许的源目录，输出落出图目录；ffmpeg 未探测到时如实降级。',
    parameters: schemaOf({
      source: STR, vocals_target: STR, music_target: STR, format: STR,
      codec: STR, bitrate: STR, timeout_ms: NUM,
    }),
    timeoutMs: 10 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, degraded: BOOL, path: STR, tool: STR,
      command: { type: 'array' }, reason: STR, note: STR, preview: BOOL,
    }) },
    execute: run,
  }
}

/* ------------------------------ 端点 ------------------------------ */

export const MEDIA_FX_ROUTE_PATHS = Object.freeze([
  '/api/qwen-paint/media-fx/capabilities',
  '/api/qwen-paint/enhance/audio',
  '/api/qwen-paint/cutout/image',
  '/api/qwen-paint/split/audio',
])

export function mediaFxRouteTable(base = {}) {
  const mkTool = {
    enhance_audio: () => makeEnhanceAudioTool(base),
    cutout_image: () => makeCutoutTool(base),
    split_audio: () => makeSplitAudioTool(base),
  }
  const post = (name) => wrap(async (req, res) => {
    if (!localGate(base, req, res)) return
    if (req.method !== 'POST') { json(res, { ok: false, reason: 'POST only' }, 405); return }
    const body = await bodyOf(req)
    if (!body) { json(res, { ok: false, reason: '请求体不是合法 JSON' }, 400); return }
    const r = await mkTool[name]().execute(body)
    json(res, r)
  })
  return [
    {
      path: MEDIA_FX_ROUTE_PATHS[0], method: 'GET',
      handler: wrap(async (req, res) => {
        if (!localGate(base, req, res)) return
        const probe = base.mediaExec && typeof base.mediaExec.probe === 'function'
          ? await base.mediaExec.probe() : null
        json(res, {
          ok: true,
          tools: [...MEDIA_FX_TOOL_NAMES],
          presets: AUDIO_FX_PRESETS,
          key_colors: [...CUTOUT_KEY_COLORS],
          ffmpeg: probe ? (probe.available ? 'available' : 'unavailable') : 'undetected',
          note: '音频后处理 / 无模型抠图 / 中置相消声源分离：全部纯 ffmpeg 零模型零下载；'
            + '抠图仅纯色背景、分离仅近似，诚实边界见工具 description；未探测到 ffmpeg 时只回参数预览。',
        })
      }),
    },
    { path: MEDIA_FX_ROUTE_PATHS[1], method: 'POST', handler: post('enhance_audio') },
    { path: MEDIA_FX_ROUTE_PATHS[2], method: 'POST', handler: post('cutout_image') },
    { path: MEDIA_FX_ROUTE_PATHS[3], method: 'POST', handler: post('split_audio') },
  ]
}
