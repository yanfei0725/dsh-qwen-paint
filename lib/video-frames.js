/**
 * lib/video-frames.js —— 视频选帧 / 时间段截取的**纯逻辑层**。
 *
 * ## 为什么单独一层
 *   "时间码 ↔ 帧号"的换算最容易出错（fps、取整、含头含尾、越界），
 *   而它又完全不需要网络、不需要 ffmpeg、不需要文件系统 —— 抽出来就能离线回归。
 *   真正碰 ffmpeg 的部分放在 `video-frames-endpoints.js`。
 *
 * ## 两种模式（用户明确要的两种）
 *   · `frames`：按帧号选 —— 起始帧 / 结束帧 / 每隔 N 帧 / 最多取几帧；
 *   · `time`  ：按时间选 —— 起止时间码（`1:30` / `00:01:30.5` 都认），按 fps 换算成帧。
 *   两者最终都归一到同一份 `{ startFrame, endFrame, startSec, endSec }`，
 *   下游（抽单帧 / 截片段 / 批量抽帧）只认这一份，不各自换算一遍。
 *
 * ## 红线
 *   · 不写死任何本机绝对路径（ffmpeg 位置由调用方探测后传入）；
 *   · 不做任何网络请求；
 *   · 参数一律 clamp 到合理区间，绝不把用户输入的离谱值直接喂给 ffmpeg。
 */

/** 生成视频的默认帧率（Wan 系列常见档位；用户可改）。 */
export const DEFAULT_FPS = 24
export const MIN_FPS = 8
export const MAX_FPS = 120
/** 单次截取的最长秒数 —— 防「一不小心选了整段 4K」把磁盘写爆。 */
export const MAX_CLIP_SECONDS = 120
/** 批量抽帧上限 —— 再多多半不是真要那么多帧，而是参数填错了。 */
export const MAX_PICK_FRAMES = 240
/** 默认「最多取几帧」。 */
export const DEFAULT_MAX_FRAMES = 24

/**
 * 解析时间码 → 秒。认这几种写法：
 *   `90` / `90.5`        → 90 / 90.5 秒
 *   `1:30`               → 90 秒
 *   `1:02:03.5`          → 3723.5 秒
 * 空串 / 认不出来 → `null`（调用方据此报错，**不猜 0**）。
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseTimecode(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null
  const s = String(input ?? '').trim()
  if (s === '') return null
  // 只允许数字 / 冒号 / 点，别的一律判非法（防止把命令行片段当时间码）
  if (!/^\d{1,3}(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/u.test(s)) return null
  const parts = s.split(':')
  if (parts.length > 3) return null
  let total = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isFinite(n) || n < 0) return null
    total = total * 60 + n
  }
  return Number(total.toFixed(3))
}

/**
 * 秒 → 时间码（`M:SS.s` 或 `H:MM:SS.s`）。用于给用户看，不参与计算。
 * @param {unknown} seconds
 * @returns {string}
 */
export function formatTimecode(seconds) {
  const sec = Number(seconds)
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0'
  const total = Math.round(sec * 10) / 10
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s < 10 ? `0${s.toFixed(1)}` : s.toFixed(1)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 帧号 → 秒。 */
export function frameToSec(frame, fps) {
  const f = Number(frame)
  const r = Number(fps)
  if (!Number.isFinite(f) || !Number.isFinite(r) || r <= 0) return 0
  return Number((f / r).toFixed(6))
}

/** 秒 → 帧号（向下取整；越界夹到 0）。 */
export function secToFrame(sec, fps) {
  const s = Number(sec)
  const r = Number(fps)
  if (!Number.isFinite(s) || !Number.isFinite(r) || r <= 0 || s <= 0) return 0
  return Math.floor(s * r)
}

/** fps 归一：非法值回落默认，越界夹紧，并如实记一条 warning。 */
function normalizeFps(raw, warnings) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    if (raw !== undefined && raw !== null && raw !== '') {
      warnings.push(`帧率 ${JSON.stringify(raw)} 认不出来，按默认 ${DEFAULT_FPS} fps 处理`)
    }
    return DEFAULT_FPS
  }
  if (n < MIN_FPS || n > MAX_FPS) {
    const clamped = Math.min(MAX_FPS, Math.max(MIN_FPS, n))
    warnings.push(`帧率 ${n} 超出 ${MIN_FPS}~${MAX_FPS}，按 ${clamped} fps 处理`)
    return clamped
  }
  return n
}

/**
 * 把「按帧 / 按时间」两种选法归一到同一份区间。
 *
 * @param {object} opts
 * @param {'frames'|'time'} [opts.mode] 默认 frames
 * @param {number} [opts.fps] 视频帧率（未知时给默认）
 * @param {number} [opts.totalFrames] 总帧数（未知可不传）
 * @param {number} [opts.durationSec] 总时长（未知可不传）
 * @param {number} [opts.startFrame] / [opts.endFrame]
 * @param {string|number} [opts.startTime] / [opts.endTime] 时间码
 * @param {number} [opts.everyNth] 每隔 N 帧取一帧（默认 1）
 * @param {number} [opts.maxFrames] 最多取几帧（默认 24）
 * @returns {{ok:boolean, reason?:string, mode:string, fps:number, startFrame:number,
 *            endFrame:number, count:number, startSec:number, endSec:number,
 *            durationSec:number, everyNth:number, pickedFrames:number[],
 *            truncated:boolean, warnings:string[]}}
 */
export function resolveSelection(opts = {}) {
  const warnings = []
  const mode = String(opts.mode ?? 'frames').toLowerCase() === 'time' ? 'time' : 'frames'
  const fps = normalizeFps(opts.fps, warnings)
  const totalFramesRaw = Number(opts.totalFrames)
  const totalFrames = Number.isFinite(totalFramesRaw) && totalFramesRaw > 0
    ? Math.trunc(totalFramesRaw) : 0
  const durationRaw = Number(opts.durationSec)
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0

  let startFrame = 0
  let endFrame = 0

  if (mode === 'time') {
    const s = parseTimecode(opts.startTime)
    const e = parseTimecode(opts.endTime)
    if (s === null) return { ok: false, reason: '起始时间码认不出来（支持 90 / 1:30 / 00:01:30.5）', warnings }
    if (e === null) return { ok: false, reason: '结束时间码认不出来（支持 90 / 1:30 / 00:01:30.5）', warnings }
    if (e <= s) return { ok: false, reason: `结束时间（${formatTimecode(e)}）必须晚于起始时间（${formatTimecode(s)}）`, warnings }
    if (durationSec > 0 && s >= durationSec) {
      return { ok: false, reason: `起始时间 ${formatTimecode(s)} 已超出视频总长 ${formatTimecode(durationSec)}`, warnings }
    }
    let eClamped = e
    if (durationSec > 0 && e > durationSec) {
      eClamped = durationSec
      warnings.push(`结束时间超出总长，已夹到 ${formatTimecode(durationSec)}`)
    }
    if (eClamped - s > MAX_CLIP_SECONDS) {
      warnings.push(`所选区间超过 ${MAX_CLIP_SECONDS} 秒上限，已截断`)
    }
    const eFinal = Math.min(eClamped, s + MAX_CLIP_SECONDS)
    startFrame = secToFrame(s, fps)
    // 含头含尾：endSec 处的帧本身也算在内
    endFrame = Math.max(startFrame, Math.ceil(eFinal * fps) - 1)
    if (totalFrames > 0) endFrame = Math.min(endFrame, totalFrames - 1)
    return finish({ mode, fps, startFrame, endFrame, totalFrames, durationSec, opts, warnings })
  }

  const sfRaw = Number(opts.startFrame)
  const efRaw = Number(opts.endFrame)
  if (!Number.isFinite(sfRaw) || sfRaw < 0) {
    return { ok: false, reason: '起始帧必须是不小于 0 的整数', warnings }
  }
  if (!Number.isFinite(efRaw)) {
    return { ok: false, reason: '结束帧必须是整数', warnings }
  }
  startFrame = Math.trunc(sfRaw)
  endFrame = Math.trunc(efRaw)
  if (totalFrames > 0) {
    if (startFrame > totalFrames - 1) {
      return { ok: false, reason: `起始帧 ${startFrame} 超出总帧数 ${totalFrames}（最后一帧是 ${totalFrames - 1}）`, warnings }
    }
    if (endFrame > totalFrames - 1) {
      endFrame = totalFrames - 1
      warnings.push(`结束帧超出总帧数，已夹到最后一帧 ${endFrame}`)
    }
  }
  if (endFrame < startFrame) {
    return { ok: false, reason: `结束帧（${endFrame}）必须不小于起始帧（${startFrame}）`, warnings }
  }
  return finish({ mode, fps, startFrame, endFrame, totalFrames, durationSec, opts, warnings })
}

/** 统一收尾：算帧数、时间、抽帧步长与实际会取到的帧号。 */
function finish({ mode, fps, startFrame, endFrame, totalFrames, durationSec, opts, warnings }) {
  const count = endFrame - startFrame + 1
  const startSec = frameToSec(startFrame, fps)
  const endSec = frameToSec(endFrame + 1, fps)
  if (durationSec > 0 && endSec - startSec > MAX_CLIP_SECONDS) {
    warnings.push(`区间超过 ${MAX_CLIP_SECONDS} 秒，截片段时会被截断`)
  }
  const everyNthRaw = Number(opts.everyNth)
  const everyNth = Number.isFinite(everyNthRaw) && everyNthRaw >= 1 ? Math.trunc(everyNthRaw) : 1
  const maxRaw = Number(opts.maxFrames)
  const maxFrames = Number.isFinite(maxRaw) && maxRaw >= 1
    ? Math.min(MAX_PICK_FRAMES, Math.trunc(maxRaw)) : DEFAULT_MAX_FRAMES

  const pickedFrames = []
  for (let f = startFrame; f <= endFrame; f += everyNth) {
    pickedFrames.push(f)
    if (pickedFrames.length >= maxFrames) break
  }
  const truncated = pickedFrames.length < Math.ceil(count / everyNth)
  if (truncated) warnings.push(`按每 ${everyNth} 帧取一帧会超过 ${maxFrames} 张上限，只取前 ${pickedFrames.length} 张`)

  return {
    ok: true,
    mode,
    fps,
    startFrame,
    endFrame,
    count,
    startSec,
    endSec,
    durationSec,
    totalFrames: totalFrames > 0 ? totalFrames : 0,
    everyNth,
    maxFrames,
    pickedFrames,
    truncated,
    warnings,
  }
}

/**
 * 抽单帧的 ffmpeg 参数（不含可执行文件名）。
 * `-ss` 放在 `-i` **之前**：快速定位（关键帧跳转），比解码到目标位置快一个量级。
 * @param {{input:string, output:string, atSec:number}} o
 * @returns {string[]}
 */
export function buildFrameArgs({ input, output, atSec }) {
  const t = Math.max(0, Number(atSec) || 0)
  return ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', String(input),
    '-frames:v', '1', '-y', String(output)]
}

/**
 * 截片段的 ffmpeg 参数。
 *  · `reencode=false` → `-c copy`，秒出、不损画质，但起点会吸附到最近关键帧；
 *  · `reencode=true`  → 重编码，起点精确，但慢一些。
 * 默认重编码：用户是拿这段去继续改的，**起点准比快更重要**。
 * @param {{input:string, output:string, startSec:number, durationSec:number, reencode?:boolean}} o
 * @returns {string[]}
 */
export function buildClipArgs({ input, output, startSec, durationSec, reencode = true }) {
  const ss = Math.max(0, Number(startSec) || 0)
  const dur = Math.min(MAX_CLIP_SECONDS, Math.max(0.04, Number(durationSec) || 0))
  const head = ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', String(input), '-t', String(dur)]
  if (reencode === false) return [...head, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', String(output)]
  return [...head, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', String(output)]
}

/**
 * 从 ffprobe 的 JSON 里取时长与帧率。取不到就给 `null`（**不猜**）。
 * @param {string} text ffprobe -print_format json 的 stdout
 * @returns {{durationSec:number|null, fps:number|null, width:number|null, height:number|null}}
 */
export function parseProbe(text) {
  const empty = { durationSec: null, fps: null, width: null, height: null }
  let json
  try { json = JSON.parse(String(text ?? '')) } catch { return empty }
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const video = streams.find((s) => s?.codec_type === 'video') ?? streams[0] ?? null
  if (video === null) return empty
  const dur = Number(video.duration ?? json?.format?.duration)
  const durationSec = Number.isFinite(dur) && dur > 0 ? Number(dur.toFixed(3)) : null
  let fps = null
  const rate = String(video.avg_frame_rate ?? video.r_frame_rate ?? '')
  const m = rate.match(/^(\d+)\/(\d+)$/u)
  if (m) {
    const num = Number(m[1])
    const den = Number(m[2])
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) fps = Number((num / den).toFixed(3))
  }
  const w = Number(video.width)
  const h = Number(video.height)
  return {
    durationSec,
    fps,
    width: Number.isFinite(w) && w > 0 ? w : null,
    height: Number.isFinite(h) && h > 0 ? h : null,
  }
}

/** 输出文件名：只用时间戳 + 序号，**不含原视频名**（避免把用户文件名带到别处）。 */
export function makeFrameName(prefix, index, stamp = Date.now()) {
  const i = Math.max(0, Math.trunc(Number(index) || 0))
  return `${prefix}-${stamp}-${String(i).padStart(4, '0')}.png`
}

export function makeClipName(prefix, stamp = Date.now()) {
  return `${prefix}-${stamp}.mp4`
}

/* ------------------------------------------- 改完的帧回贴成视频（B3→B1 续） ---- */

/** 允许贴回的最大帧号（防误填把整段盖掉）。 */
export const MAX_REPLACE_FRAME = 100000

/**
 * 帧号 → overlay 的时间区间。单帧只覆盖 `[frame/fps, (frame+1)/fps)`，
 * 用半开区间避免把下一帧也盖掉。非法值一律返回 `{ok:false}`，不猜 0。
 * @param {{frame?:number|string, fps?:number|string}} o
 */
export function resolveReplaceFrame({ frame, fps } = {}) {
  const f = Number(frame)
  const r = Number(fps)
  if (!Number.isFinite(f) || f < 0) return { ok: false, reason: '帧号必须是不小于 0 的整数' }
  if (!Number.isFinite(r) || r < MIN_FPS || r > MAX_FPS) {
    return { ok: false, reason: `帧率需在 ${MIN_FPS}~${MAX_FPS} 之间` }
  }
  const fr = Math.min(MAX_REPLACE_FRAME, Math.trunc(f))
  const startSec = Number((fr / r).toFixed(6))
  const durationSec = Number((1 / r).toFixed(6))
  return {
    ok: true,
    frame: fr,
    fps: r,
    startSec,
    durationSec,
    endSec: Number((startSec + durationSec).toFixed(6)),
  }
}

/**
 * 「把改好的一帧贴回视频」的 ffmpeg 参数（不含可执行文件名）。
 *
 * · 两个输入都是**单个 argv 元素**，绝不与命令行其它部分拼接（无注入面）；
 * · `[0:v][1:v]overlay` 把改好的图居中叠到原视频上；
 *   `(W-w)/2:(H-h)/2` 用的是 overlay 的主/叠加尺寸变量，同尺寸时正好铺满；
 * · `enable` 用半开区间 `gte(t,S)*lt(t,E)`，只在这一帧对应的时间生效；
 * · `-map 0:a?` 保留原音轨（没有音轨也不报错），输出统一 H.264/AAC mp4。
 *
 * ⚠ 这里只**构造参数**，不执行、不联网、不生成媒体；真机执行在端点层。
 */
export function buildReplaceFrameArgs({ input, image, output, startSec, durationSec }) {
  const s = Math.max(0, Number(startSec) || 0)
  const d = Math.min(1, Math.max(1 / MAX_FPS, Number(durationSec) || 1 / DEFAULT_FPS))
  const e = Number((s + d).toFixed(6))
  const filter = `[0:v][1:v]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${s})*lt(t,${e})'[v]`
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', String(input), '-i', String(image),
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    '-y', String(output),
  ]
}
