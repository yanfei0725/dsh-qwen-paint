/** 自研轻量代码动画三件套，不依赖 manim/Remotion。纯计算/不联网/目录围栏；
 * 宿主注入 runCommand（探测到 ffmpeg）才真出片，否则回 argv 预览不谎称；
 * SVG 是示意图非 LaTeX；异常只写日志回固定文案，不回吐 error.message。 */
import path from 'node:path'
import { splitScript } from './subtitle-plan.js'
import {
  resolveAnimQuality, frameFingerprint, storyboardKey, createFrameCache,
  collapseRepeatedFrames, repeatsOf, checkTimelineAlignment,
} from './anim-opt.js'
import { probeEncoders, probeRaster, resvgCommand, checkFontSafety } from './render-backends.js'
import { createTileCache, createBackendSlot, diffTiles } from './anim-cache.js'
export const KIT_TOOL_NAMES = Object.freeze(['plan_storyboard', 'render_frame', 'compose_video'])
const clampInt = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
const escXml = (s) => String(s ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

export function resolveAnimOutput({ target, outputDir } = {}) {
  const rel = String(target ?? '').trim(), base = String(outputDir ?? '').trim()
  if (!rel) return { ok: false, reason: '没给输出文件名（target）' }
  if (!base) return { ok: false, reason: '输出目录未配置，无法做目录围栏' }
  if (rel.replace(/\\/g, '/').split('/').some((p) => p === '..')) return { ok: false, reason: '输出路径不允许 .. 穿越' }
  if (path.isAbsolute(rel) || /^[A-Za-z]:/u.test(rel)) return { ok: false, reason: '输出路径必须是相对路径' }
  const root = path.resolve(base), full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, reason: '输出路径必须落在出图目录内' }
  if (full === root) return { ok: false, reason: '输出路径不能就是目录本身' }
  return { ok: true, path: full }
}

export function inferVisualType(line) {
  const s = String(line ?? '')
  if (/公式|方程|推导|向量|矩阵|定理|积分|∑|∫|=|latex|math|证明/u.test(s)) return 'formula'
  if (/流程|步骤|算法|伪代码|循环|判断|流程图|flow/u.test(s)) return 'flow'
  if (/柱状|折线|饼图|图表|数据|增长|对比|趋势|chart/u.test(s)) return 'chart'
  if (/小人|火柴人|动作|走路|跑步|stick/u.test(s)) return 'stick'
  if (/示意|箭头|方框|节点|关系|结构|diagram/u.test(s)) return 'diagram'
  return 'image'
}
const shapeSb = (p) => ({ ok: p.ok === true, storyboard: p.storyboard ?? [], seconds: p.seconds ?? 0,
  shots: p.shots ?? 0, svgShots: p.svgShots ?? 0, imageShots: p.imageShots ?? 0,
  reason: String(p.reason ?? ''), note: String(p.note ?? '') })
export function makePlanStoryboardTool(deps = {}) {
  return {
    name: 'plan_storyboard',
    description: '解说脚本→分镜 JSON：按句切分，逐镜给时长/字幕/配音词/画面类型'
      + '（formula/flow/chart/stick/diagram 走纯 JS SVG，image 交 draw_image）与提示。纯 JS 零依赖，时间戳均分未对齐语音。',
    timeoutMs: 30000,
    parameters: { type: 'object', additionalProperties: false, properties: {
      script: { type: 'string', description: '解说脚本文本' }, title: { type: 'string', description: '分镜标题，可选' },
      seconds: { type: 'number', description: '总时长秒数，默认每句 3 秒' },
      maxChars: { type: 'integer', description: '单句字幕最大字数 8-40，默认 18' },
    }, required: ['script'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean' }, storyboard: { type: 'array', items: { type: 'object' } },
      seconds: { type: 'number' }, shots: { type: 'integer' }, svgShots: { type: 'integer' },
      imageShots: { type: 'integer' }, reason: { type: 'string' }, note: { type: 'string' },
    } } },
    async execute(args = {}) {
      try {
        const lines = splitScript(args.script, { maxChars: clampInt(args.maxChars, 8, 40, 18) })
        if (lines.length === 0) return shapeSb({ ok: false, reason: '脚本为空，没有可拆分镜的句子' })
        const t = Number(args.seconds), seconds = Number.isFinite(t) && t > 0 ? t : lines.length * 3, per = seconds / lines.length
        const storyboard = lines.map((line, i) => ({ index: i + 1,
          from: Number((i * per).toFixed(3)), to: Number(((i + 1) * per).toFixed(3)), seconds: Number(per.toFixed(3)),
          subtitle: line, narration: line, visual: { type: inferVisualType(line), hint: line } }))
        const svgShots = storyboard.filter((s) => s.visual.type !== 'image').length
        return shapeSb({ ok: true, storyboard, seconds, shots: storyboard.length, svgShots, imageShots: storyboard.length - svgShots,
          note: `共 ${storyboard.length} 镜，按 ${seconds}s 均分（每镜约 ${per.toFixed(2)}s）；${svgShots} 镜可用 SVG、${storyboard.length - svgShots} 镜需 draw_image。时间戳未与语音对齐。` })
      } catch (error) {
        try { deps.log?.('warn', '分镜失败：' + (error?.message ?? error)) } catch { /* 忽略 */ }
        return shapeSb({ ok: false, reason: '分镜暂不可用（详见插件日志）' })
      }
    },
  }
}

const txt = (x, y, s, size = 20, fill = '#222') =>
  `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle"${fill ? ` fill="${fill}"` : ''}>${escXml(s)}</text>`
const short = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
/** 五种示意图：示意性质，非 LaTeX / 真实数据解析。 */
export function renderSvgBody(type, hint, width, height) {
  const cx = width / 2, label = short(hint, 24)
  if (type === 'chart') {
    const nums = (String(hint).match(/\d+(?:\.\d+)?/gu) ?? []).slice(0, 8).map(Number)
    const vals = nums.length >= 2 ? nums : [3, 5, 2, 7, 4], max = Math.max(...vals, 1), gap = width / (vals.length + 1)
    return txt(cx, 34, label) + vals.map((v, i) => {
      const h = (v / max) * (height - 90)
      return `<rect x="${(gap * (i + 1) - 22).toFixed(1)}" y="${(height - 45 - h).toFixed(1)}" width="44" height="${h.toFixed(1)}" fill="#4f8ef7"/>` + txt((gap * (i + 1)).toFixed(1), height - 28, String(v), 14)
    }).join('')
  }
  if (type === 'flow') {
    const parts = String(hint).split(/[→>｜|、,，]/u).map((s) => s.trim()).filter(Boolean).slice(0, 5)
    const arr = parts.length >= 2 ? parts : ['开始', '处理', '结束'], bw = (width - 40) / arr.length
    return arr.map((s, i) => {
      const x = 20 + i * bw
      return `<rect x="${x.toFixed(1)}" y="${height / 2 - 26}" width="${(bw - 22).toFixed(1)}" height="52" rx="8" fill="#eef4ff" stroke="#4f8ef7"/>`
        + txt((x + (bw - 22) / 2).toFixed(1), height / 2 + 5, short(s, 8), 14)
        + (i < arr.length - 1 ? `<path d="M ${(x + bw - 20).toFixed(1)} ${height / 2} L ${(x + bw - 2).toFixed(1)} ${height / 2}" stroke="#4f8ef7" stroke-width="2" marker-end="url(#ar)"/>` : '')
    }).join('')
  }
  if (type === 'stick') {
    const hy = height * 0.32
    return txt(cx, 34, label) + `<circle cx="${cx}" cy="${hy}" r="22" fill="#fff" stroke="#222" stroke-width="3"/>`
      + `<path d="M ${cx} ${hy + 22} L ${cx} ${hy + 90} M ${cx} ${hy + 40} L ${cx - 34} ${hy + 70} M ${cx} ${hy + 40} L ${cx + 34} ${hy + 66} M ${cx} ${hy + 90} L ${cx - 28} ${hy + 140} M ${cx} ${hy + 90} L ${cx + 28} ${hy + 140}" stroke="#222" stroke-width="3" fill="none"/>`
  }
  if (type === 'formula') return txt(cx, 34, '公式示意', 18) + txt(cx, height / 2, label, 24, '#1a5fb4') + txt(cx, height - 26, '非 LaTeX，复杂公式走 draw_image', 12, '#888')
  return txt(cx, 34, label)
    + `<rect x="${cx - 120}" y="${height / 2 - 40}" width="240" height="80" rx="12" fill="#eef4ff" stroke="#4f8ef7" stroke-width="2"/>`
    + txt(cx, height / 2 + 6, short(hint, 16), 16)
}
export function buildSvg({ type, hint, width, height } = {}) {
  const w = clampInt(width, 320, 1920, 960), h = clampInt(height, 180, 1080, 540)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="100%" height="100%" fill="#fff"/><defs><marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#4f8ef7"/></marker></defs>`
    + renderSvgBody(type, hint, w, h) + '</svg>'
}
const shapeFrame = (p) => ({ ok: p.ok === true, backend: p.backend ?? '', svg: p.svg ?? '', path: p.path ?? '', hint: String(p.hint ?? ''),
  fingerprint: String(p.fingerprint ?? ''), cache: String(p.cache ?? ''), quality: String(p.quality ?? ''),
  raster: String(p.raster ?? ''), reason: String(p.reason ?? '') })
export function makeRenderFrameTool(deps = {}) {
  return {
    name: 'render_frame',
    description: '分镜画面→帧：formula/flow/chart/stick/diagram 用纯 JS 生成 SVG 示意图（示意、非 LaTeX 级），'
      + 'image 时提示改用 draw_image。svg 字段始终给完整 SVG；注入 writeFile+outputDir 才落盘出图目录内。零依赖不联网。',
    timeoutMs: 20000,
    parameters: { type: 'object', additionalProperties: false, properties: {
      type: { type: 'string', description: '画面类型 formula/flow/chart/stick/diagram/image' },
      hint: { type: 'string', description: '画面提示文案（分镜 visual.hint）' },
      width: { type: 'integer', description: '宽 320-1920，默认 960；quality=draft 时未显式给则用 480' },
      height: { type: 'integer', description: '高 180-1080，默认 540；quality=draft 时未显式给则用 270' },
      target: { type: 'string', description: '输出 SVG 文件名（相对出图目录），给了才落盘' },
      quality: { type: 'string', enum: ['draft', 'final'], description: '可选档位：draft 低采样(480×270) / final 原默认(960×540)；显式 width/height 优先' },
    }, required: ['type', 'hint'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean' }, backend: { type: 'string' }, svg: { type: 'string' },
      path: { type: 'string' }, hint: { type: 'string' },
      fingerprint: { type: 'string' }, cache: { type: 'string' }, quality: { type: 'string' }, raster: { type: 'string' }, reason: { type: 'string' },
    } } },
    async execute(args = {}) {
      try {
        const type = String(args.type ?? 'diagram').trim(), hint = String(args.hint ?? '').trim()
        if (hint === '') return shapeFrame({ ok: false, reason: '画面提示（hint）不能为空' })
        if (type === 'image') return shapeFrame({ ok: false, backend: 'draw_image', hint, reason: '该镜需真实画面：请用 draw_image 以 hint 出图，再把路径作为帧。' })
        if (!['formula', 'flow', 'chart', 'stick', 'diagram'].includes(type)) return shapeFrame({ ok: false, reason: `不支持的画面类型 ${type}` })
        // ③ 档位：显式 width/height 优先，档位只补缺省；档位名回传给调用方。
        const preset = resolveAnimQuality(args.quality)
        const w = args.width === undefined && preset ? preset.width : args.width
        const h = args.height === undefined && preset ? preset.height : args.height
        const quality = preset ? String(args.quality).toLowerCase() : ''
        const key = storyboardKey({ type, hint, width: w, height: h })
        const cache = deps.outputDir && deps.fs && deps.path ? createFrameCache({ outputDir: deps.outputDir, fs: deps.fs, path: deps.path }) : null
        const hit = cache ? cache.lookup(key) : null
        // ② 命中分镜缓存：svg 逐字复用，落盘路径沿用（文件在则不再写）。
        if (hit) return shapeFrame({ ok: true, backend: 'svg', svg: hit.svg, path: hit.path, hint,
          fingerprint: frameFingerprint(hit.svg), cache: 'hit', quality, reason: '命中分镜缓存（type+hint+尺寸未变），未重渲。' })
        const svg = buildSvg({ type, hint, width: w, height: h })
        let outPath = ''
        if (String(args.target ?? '').trim() !== '') {
          const g = resolveAnimOutput({ target: args.target, outputDir: deps.outputDir })
          if (!g.ok) return shapeFrame({ ok: false, backend: 'svg', svg, hint, reason: g.reason })
          if (typeof deps.writeFile !== 'function') return shapeFrame({ ok: false, backend: 'svg', svg, hint, reason: '未注入 writeFile，未落盘；svg 字段已给完整内容。' })
          await deps.writeFile(g.path, svg); outPath = g.path
        }
        if (cache) cache.remember(key, { svg, rel: outPath ? path.relative(deps.outputDir, outPath) : '' })
        // ⑥ 可选光栅后端：宿主注入 rasterBackend 才调用（resvg/Edge 由宿主探测决定），
        //    未注入保持原样只回 SVG，绝不谎称已光栅化。
        let raster = ''
        if (typeof deps.rasterBackend === 'function') {
          try {
            const r = await deps.rasterBackend(svg, { width: w, height: h, svgPath: outPath, outputDir: deps.outputDir })
            if (r && r.ok === true) raster = String(r.backend ?? 'raster') + (r.path ? ':' + String(r.path) : '')
            else try { deps.log?.('warn', '光栅后端未生效，保留 SVG：' + String(r?.reason ?? '')) } catch { /* 忽略 */ }
          } catch { try { deps.log?.('warn', '光栅后端执行失败，保留 SVG') } catch { /* 忽略 */ } }
        }
        return shapeFrame({ ok: true, backend: 'svg', svg, path: outPath, hint, fingerprint: frameFingerprint(svg),
          cache: 'miss', quality, raster, reason: outPath ? '已生成 SVG 示意图（落盘）。' : '已生成 SVG 示意图（未落盘）。' })
      } catch (error) {
        try { deps.log?.('warn', '渲染帧失败：' + (error?.message ?? error)) } catch { /* 忽略 */ }
        return shapeFrame({ ok: false, reason: '帧渲染暂不可用（详见插件日志）' })
      }
    },
  }
}

/** VFR 用的 concat 清单：每帧一条 file + duration（repeat/fps），末帧再列一次兑现最后一段时长。
 *  只有 concat 分离器能精确按 duration 出时间戳；filter concat 会按输入帧率重采样，时长会漂。 */
export function buildConcatList({ frames, repeats, fps }) {
  const rep = Array.isArray(repeats) && repeats.length === frames.length ? repeats.map((n) => Math.max(1, Number(n) || 1)) : frames.map(() => 1)
  const q = (s) => String(s).replace(/'/gu, "'\\''")
  const lines = []
  frames.forEach((f, i) => { lines.push(`file '${q(f)}'`, `duration ${(rep[i] / fps).toFixed(4)}`) })
  if (frames.length > 0) lines.push(`file '${q(frames[frames.length - 1])}'`)
  return lines.join('\n') + '\n'
}

/** repeats 可选：第 i 帧连续出现几次（静态帧去重后），每帧时长 = repeat/fps。
 *  videoEncoder 可选：探测择优出的编码器；不传仍是 libx264（保持旧调用零变化）。
 *  fpsMode 'vfr' 必须同时给 concatList（由 compose 工具写盘），否则**退回 CFR**，不假装是 VFR。
 *  ⚠ vfr 只省「补出来的重复帧」，动态段仍是一帧一图；不是内容感知抽帧。 */
export function buildComposeCommand({ frames, out, fps, srt, audio, repeats, videoEncoder, fpsMode, concatList }) {
  const enc = String(videoEncoder ?? '').trim() || 'libx264'
  const subs = String(srt ?? '').trim() !== '' ? `subtitles='${String(srt).replace(/\\/g, '/').replace(/:/g, '\\:')}'` : ''
  // ★ VFR 走 concat 分离器：duration 精确、不重采样；没有清单就老实退回 CFR。
  if (String(fpsMode ?? '').toLowerCase() === 'vfr' && String(concatList ?? '').trim() !== '') {
    const cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concatList]
    const aud = String(audio ?? '').trim()
    if (aud !== '') cmd.push('-i', aud)
    if (subs !== '') cmd.push('-vf', subs)
    cmd.push('-map', '0:v')
    if (aud !== '') cmd.push('-map', 'a:0', '-c:a', 'aac', '-shortest')
    cmd.push('-c:v', enc, '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-y', out)
    return cmd
  }
  const cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error']
  const rep = Array.isArray(repeats) && repeats.length === frames.length ? repeats.map((n) => Math.max(1, Number(n) || 1)) : frames.map(() => 1)
  const framesOut = frames.length
  for (let i = 0; i < frames.length; i += 1) {
    const dur = String(rep[i] / fps).replace(/0+$/u, '').replace(/\.$/u, '')
    cmd.push('-loop', '1', '-t', dur, '-i', frames[i])
  }
  const chain = [frames.map((_, i) => `[${i}:v]`).join('') + `concat=n=${framesOut}:v=1:a=0[v]`]
  let vLabel = '[v]'
  if (subs !== '') { chain.push(`[v]${subs}[vs]`); vLabel = '[vs]' }
  const map = ['-map', vLabel]
  if (String(audio ?? '').trim() !== '') { cmd.push('-i', audio); map.push('-map', 'a:0', '-c:a', 'aac', '-shortest') }
  cmd.push('-filter_complex', chain.join(';'), ...map, '-c:v', enc, '-pix_fmt', 'yuv420p', '-r', String(fps), '-y', out)
  return cmd
}
const shapeCompose = (p) => ({ ok: p.ok === true, path: p.path ?? '', command: Array.isArray(p.command) ? p.command : [], frames: p.frames ?? 0,
  fps: p.fps ?? 0, dedup: p.dedup ?? false, timing: p.timing ?? null, quality: String(p.quality ?? ''),
  encoder: String(p.encoder ?? 'libx264'), encoderLabel: String(p.encoderLabel ?? 'CPU x264（软件）'),
  fpsMode: String(p.fpsMode ?? 'cfr'), reason: String(p.reason ?? '') })
export function makeComposeVideoTool(deps = {}) {
  return {
    name: 'compose_video',
    description: '帧序列+字幕+配音→MP4 的 ffmpeg argv（图片 concat + SRT 烧录 + 配音混流，H.264/yuv420p）。'
      + '仅宿主注入 runCommand（已探测 ffmpeg）时真出文件，否则 ok:false + argv 预览，绝不谎称出片。字幕用 subtitle-plan、配音用 generate_speech。',
    timeoutMs: 300000,
    parameters: { type: 'object', additionalProperties: false, properties: {
      frames: { type: 'array', items: { type: 'string' }, description: '帧图片路径数组，按播放顺序，至少 2 张' },
      target: { type: 'string', description: '输出 MP4 文件名（相对出图目录，走围栏）' },
      fps: { type: 'integer', description: '帧率 1-60，默认 24；quality 档位可代填' },
      srt: { type: 'string', description: '可选：SRT 字幕路径，烧录进画面' },
      audio: { type: 'string', description: '可选：配音音频路径，与视频混流' },
      quality: { type: 'string', enum: ['draft', 'final'], description: '可选档位：draft=12fps / final=24fps；显式 fps 优先' },
      dedupe: { type: 'boolean', description: '可选：折叠相邻同路径帧为一帧并延长时长（静态帧去重，默认 false 保持原样）' },
      strictTiming: { type: 'boolean', description: '可选：时序不齐时拒绝合成（默认 false 仅告警，不阻断旧流程）' },
      fpsMode: { type: 'string', enum: ['cfr', 'vfr'], description: '可选帧模式：cfr 恒定帧率（默认，旧行为）；vfr 不补重复帧并统一 PTS，配合 dedupe 更省体积' },
      storyboard: { type: 'array', items: { type: 'object' }, description: '可选：分镜时间轴（含 from/to），用于合成前时序校验' },
      srtCues: { type: 'array', items: { type: 'object' }, description: '可选：字幕 cue（含 to），用于合成前时序校验' },
      audioSeconds: { type: 'number', description: '可选：配音时长秒（probeAudioDuration 可探），用于合成前时序校验' },
    }, required: ['frames', 'target'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      ok: { type: 'boolean' }, path: { type: 'string' }, command: { type: 'array', items: { type: 'string' } },
      frames: { type: 'integer' }, fps: { type: 'number' }, dedup: { type: 'boolean' }, timing: { type: 'object' },
      fpsMode: { type: 'string' }, quality: { type: 'string' }, encoder: { type: 'string' }, encoderLabel: { type: 'string' }, reason: { type: 'string' },
    } } },
    async execute(args = {}) {
      try {
        let frames = (Array.isArray(args.frames) ? args.frames : []).map((f) => String(f ?? '').trim()).filter(Boolean)
        if (frames.length < 2) return shapeCompose({ ok: false, reason: 'frames 至少需要 2 张帧图片' })
        const g = resolveAnimOutput({ target: args.target, outputDir: deps.outputDir })
        if (!g.ok) return shapeCompose({ ok: false, reason: g.reason })
        // ③ 档位：显式 fps 优先，quality 只补缺省。
        const preset = resolveAnimQuality(args.quality)
        const fps = clampInt(args.fps === undefined && preset ? preset.fps : args.fps, 1, 60, 24)
        const quality = preset ? String(args.quality).toLowerCase() : ''
        // ① 静态帧去重：相邻同路径折叠为一帧，repeat 延长其 -t，concat 帧数随之减少。
        const collapsed = args.dedupe === true ? collapseRepeatedFrames(frames) : null
        const repeats = collapsed ? repeatsOf(collapsed) : null
        const dedup = collapsed !== null
        if (dedup) frames = collapsed.map((x) => x.path)
        // ④ 时序校验前置：缺数据跳过；不齐默认只告警，strictTiming 才拒绝。
        const timing = checkTimelineAlignment({ storyboard: args.storyboard, srtCues: args.srtCues,
          audioSeconds: args.audioSeconds, frames: dedup ? collapsed.reduce((n, x) => n + x.repeat, 0) : frames.length, fps })
        if (timing.checked > 0 && !timing.ok && args.strictTiming === true) {
          return shapeCompose({ ok: false, path: g.path, frames: frames.length, fps, dedup, timing, quality, reason: '时序校验未通过，已拒绝合成：' + timing.summary })
        }
        const srt = String(args.srt ?? '').trim(), audio = String(args.audio ?? '').trim()
        // ⑥ 帧模式：vfr 走 concat 清单（精确 duration、不补帧）；缺 writeFile 时如实退回 CFR。
        let fpsMode = String(args.fpsMode ?? '').toLowerCase() === 'vfr' ? 'vfr' : 'cfr'
        let concatList = '', modeNote = ''
        if (fpsMode === 'vfr') {
          if (typeof deps.writeFile === 'function') {
            concatList = g.path.replace(/\.mp4$/iu, '') + '.concat.txt'
            await deps.writeFile(concatList, buildConcatList({ frames, repeats, fps }))
          } else { fpsMode = 'cfr'; modeNote = '；VFR 需写 concat 清单但未注入 writeFile，已退回 CFR' }
        }
        // ⑤ 硬件编码择优：宿主注入 probeEncoder 才实测；否则 libx264，绝不谎称硬编生效。
        const enc = await probeEncoders({ probeEncoder: deps.probeEncoder })
        const command = buildComposeCommand({ frames, out: g.path, fps, srt, audio, repeats, videoEncoder: enc.selected, fpsMode, concatList })
        const common = { path: g.path, command, frames: frames.length, fps, dedup, timing, quality, fpsMode,
          encoder: enc.selected, encoderLabel: enc.label }
        const timingNote = timing.checked > 0 && !timing.ok ? `；⚠ ${timing.summary}` : ''
        const encNote = '；编码器：' + enc.label + (enc.probed ? '' : '（未实测，保守软件编码）')
          + (fpsMode === 'vfr' ? '；帧模式：VFR（静态段不补帧，concat 清单精确控时）' : '') + modeNote
        if (typeof deps.runCommand !== 'function') return shapeCompose({ ...common, ok: false, reason: '离线降级：未探测到 ffmpeg，仅回 argv 预览，未生成 MP4。' + timingNote + encNote })
        if (typeof deps.readFile === 'function') for (const f of frames) await deps.readFile(f)
        const run = await deps.runCommand(command, { timeoutMs: 300000 }), failed = run && run.ok === false
        return shapeCompose({ ...common, ok: !failed, reason: (failed ? 'ffmpeg 执行失败（详见插件日志）；未生成 MP4。' : '已生成 MP4（宿主执行器运行）。') + timingNote + encNote })
      } catch (error) {
        try { deps.log?.('warn', '合成视频失败：' + (error?.message ?? error)) } catch { /* 忽略 */ }
        return shapeCompose({ ok: false, reason: '视频合成暂不可用（详见插件日志）' })
      }
    },
  }
}

export function makeAnimationTools(deps = {}) { return [makePlanStoryboardTool(deps), makeRenderFrameTool(deps), makeComposeVideoTool(deps)] }
