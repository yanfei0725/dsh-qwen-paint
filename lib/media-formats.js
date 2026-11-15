/**
 * lib/media-formats.js —— 媒体格式登记表（唯一真相源）+ ffmpeg 参数构建 + 输出格式预设。
 *
 * ## 用户需求（2026-11-15）
 *   「图片常用 JPG/PNG/WebP；视频常用 MP4/MKV/MOV/WebM；音频常用 MP3/AAC/WAV/FLAC。
 *     生成的图片视频音频可以指定或转换成我上面所说的格式，也支持动图转视频，
 *     也支持用户自己的各种图片以及视频音频转换格式；这些功能也要支持 agent 调用。」
 *
 * ## 诚实边界（★ 不许越线）
 *   · 这里只做**纯参数构建**：不解码媒体、不联网、不派生子进程、不碰磁盘。
 *     是否真的落盘由宿主注入的执行器决定（见 lib/media-exec.js）。
 *   · 编码器名（libx264 / libvpx-vp9 / libwebp / libmp3lame / libopus / flac …）是
 *     ffmpeg 的**标准编码器标识**，并不意味着本机 ffmpeg 一定编进去了；
 *     能力端点不许把它们写成「已验证可用」，执行失败要如实回报。
 *   · 有损/无损、透明通道、容器兼容性都标在表里，避免把 PNG→JPG 说成无损。
 *   · 跨媒体类别转换一律拒绝（图片不能转音频、音频不能转视频）；
 *     **唯一例外**是用户点名的「动图 → 视频」，以及动图取首帧 → 静态图。
 *   · 动图转视频：GIF 的循环次数不会自动变成视频时长，默认只转一遍；
 *     想更长时间由 fps / duration / loop_count 显式控制，绝不假装"自动保留循环"。
 *
 * ## 与既有 GIF 能力的分工
 *   `convert_to_gif` 是「图片/视频 → GIF」单向工具，保持不动；
 *   `convert_media` 负责 12 种常用格式之间互转 + 动图 → 视频，两者共用 ffmpeg 执行器。
 */

export const MEDIA_FORMAT_VERSION = 1

/** 用户点名的 11 种目标格式（jpeg 归入 jpg 别名）。顺序即展示顺序。 */
export const FORMAT_GROUPS = Object.freeze({
  image: Object.freeze(['jpg', 'png', 'webp']),
  video: Object.freeze(['mp4', 'mkv', 'mov', 'webm']),
  audio: Object.freeze(['mp3', 'aac', 'wav', 'flac']),
})

/** 允许作为输入的动图扩展名。webp 既能是静态图也能是动图，按 sourceKind 区分。 */
export const ANIMATED_INPUT_EXTS = Object.freeze(['gif', 'apng', 'webp'])

/** 只收用户点名的别名，不做「顺手支持」的隐式扩展。 */
export const FORMAT_ALIASES = Object.freeze({ jpeg: 'jpg', jpe: 'jpg' })

/**
 * 每个格式的公开描述。纯数据，可被端点直接 JSON 序列化（不含函数、不含本机信息）。
 *   kind / ext / label / codec / alpha / lossy / note 全是事实或已知限制，不是性能承诺。
 */
export const FORMAT_TABLE = Object.freeze({
  jpg: { kind: 'image', ext: 'jpg', label: 'JPEG', codec: 'mjpeg', alpha: false, lossy: true,
    note: '有损、不支持透明通道；从带 alpha 的源转出会丢掉透明度，请用白色/黑色底或改选 PNG/WebP。' },
  png: { kind: 'image', ext: 'png', label: 'PNG', codec: 'png', alpha: true, lossy: false,
    note: '无损、支持透明通道；体积通常比 JPG/WebP 大。' },
  webp: { kind: 'image', ext: 'webp', label: 'WebP', codec: 'libwebp', alpha: true, lossy: true,
    note: '默认有损但支持透明通道；quality 越高体积越大。' },

  mp4: { kind: 'video', ext: 'mp4', label: 'MP4 (H.264/AAC)', codec: 'libx264 + aac', alpha: false, lossy: true,
    note: '兼容性最好的容器；+faststart 便于边下边播。' },
  mkv: { kind: 'video', ext: 'mkv', label: 'Matroska (H.264/AAC)', codec: 'libx264 + aac', alpha: false, lossy: true,
    note: '容器由扩展名自动选择；可容纳更多音轨/字幕轨，本工具只转一条视频+一条音频。' },
  mov: { kind: 'video', ext: 'mov', label: 'QuickTime MOV (H.264/AAC)', codec: 'libx264 + aac', alpha: false, lossy: true,
    note: 'QuickTime 容器，编码与 MP4 相同，只是封装不同。' },
  webm: { kind: 'video', ext: 'webm', label: 'WebM (VP9/Opus)', codec: 'libvpx-vp9 + libopus', alpha: false, lossy: true,
    note: 'VP9 编码明显慢于 H.264；libvpx-vp9 / libopus 未编进本机 ffmpeg 时会执行失败并如实回报。' },

  mp3: { kind: 'audio', ext: 'mp3', label: 'MP3', codec: 'libmp3lame', alpha: false, lossy: true,
    note: '有损；libmp3lame 未编进本机 ffmpeg 时会执行失败并如实回报。' },
  aac: { kind: 'audio', ext: 'aac', label: 'AAC (ADTS)', codec: 'aac', alpha: false, lossy: true,
    note: '裸 ADTS 流（.aac），不是 .m4a 容器；有损。' },
  wav: { kind: 'audio', ext: 'wav', label: 'WAV (PCM 16-bit)', codec: 'pcm_s16le', alpha: false, lossy: false,
    note: '无损 PCM，体积最大；转成 16-bit 会做一次量化。' },
  flac: { kind: 'audio', ext: 'flac', label: 'FLAC', codec: 'flac', alpha: false, lossy: false,
    note: '无损压缩；从 MP3/AAC 等有损源转出不会恢复已丢失的细节。' },
})

export const FORMAT_NAMES = Object.freeze(Object.keys(FORMAT_TABLE).sort())
export const MEDIA_KINDS = Object.freeze(['image', 'video', 'audio', 'animated', 'other'])

/** 输出格式的「每个链一类」预设：进程内内存，重启即清空，不写配置文件。 */
export function createFormatPrefs(initial = {}) {
  const map = new Map()
  for (const [k, v] of Object.entries(initial || {})) {
    const r = resolveFormat(v)
    if (r.ok) map.set(String(k).toLowerCase(), r.format)
  }
  return {
    get(kind) { return map.get(String(kind).toLowerCase()) ?? null },
    set(kind, format) {
      const r = resolveFormat(format)
      if (!r.ok) return r
      const key = String(kind).toLowerCase()
      if (!['image', 'video', 'audio'].includes(key)) {
        return { ok: false, reason: '预设只支持 image / video / audio 三类' }
      }
      if (FORMAT_TABLE[r.format].kind !== key) {
        return { ok: false, reason: `格式 ${r.format} 属于 ${FORMAT_TABLE[r.format].kind}，不能设为 ${key} 的默认输出` }
      }
      map.set(key, r.format)
      return { ok: true, kind: key, format: r.format }
    },
    clear(kind) {
      const key = String(kind).toLowerCase()
      const had = map.has(key)
      map.delete(key)
      return { ok: true, kind: key, cleared: had }
    },
    snapshot() { return Object.fromEntries(map) },
  }
}

/** 格式归一化：去点、小写、收别名，未知格式明确拒绝（绝不猜）。 */
export function resolveFormat(value) {
  let s = String(value ?? '').trim().toLowerCase()
  if (s.startsWith('.')) s = s.slice(1)
  s = FORMAT_ALIASES[s] || s
  if (!s) return { ok: false, reason: '没给目标格式（format）' }
  if (!Object.prototype.hasOwnProperty.call(FORMAT_TABLE, s)) {
    return { ok: false, reason: `不支持的目标格式「${s}」；可用：${FORMAT_NAMES.join(' / ')}` }
  }
  return { ok: true, format: s, spec: FORMAT_TABLE[s] }
}

/** 按扩展名判定输入类别；declared 可显式声明 animated（webp 动图无法靠扩展名区分）。 */
export function sourceKindOf(file, declared = '') {
  const d = String(declared).trim().toLowerCase()
  if (d === 'animated' || d === 'image' || d === 'video' || d === 'audio') return d
  const s = String(file ?? '').toLowerCase()
  const dot = s.lastIndexOf('.')
  const ext = dot >= 0 ? s.slice(dot + 1).split(/[?#]/u)[0] : ''
  if (['gif', 'apng'].includes(ext)) return 'animated'
  if (['png', 'jpg', 'jpeg', 'jpe', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic'].includes(ext)) return 'image'
  if (['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext)) return 'video'
  if (['mp3', 'aac', 'wav', 'flac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio'
  return 'other'
}

/** 转换可行性裁决：同类互转 + 动图→视频/静态图；其余跨类拒绝并说清为什么。 */
export function planConversion({ sourceKind = 'other', format = '', still = false } = {}) {
  const r = resolveFormat(format)
  if (!r.ok) return { ok: false, reason: r.reason }
  const from = String(sourceKind).toLowerCase()
  const to = r.spec.kind
  if (from === 'other') {
    return { ok: false, reason: '认不出输入类型，请给 sourceKind（image / video / audio / animated）' }
  }
  if (from === to) {
    return { ok: true, format: r.format, from, to, crossKind: false,
      note: `${from} 类内格式转换。` }
  }
  if (from === 'animated' && to === 'video') {
    return { ok: true, format: r.format, from, to, crossKind: true, animated: true,
      note: '动图转视频：默认只转一遍，GIF 的循环次数不会自动变成视频时长；可用 loop_count 显式重复。' }
  }
  if (from === 'animated' && to === 'image' && still === true) {
    return { ok: true, format: r.format, from, to, crossKind: true, still: true,
      note: '动图取首帧转成静态图（需 still:true）。' }
  }
  return {
    ok: false, reason: `不支持 ${from} → ${to} 的跨类转换：本工具只做同类格式转换与「动图→视频」；`
      + '音频不能变图片、图片不能变音频，请换一个与目标同类的源文件或目标格式。',
  }
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
}

/** 所有可调项的边界；传给 ffmpeg 前一律过 clamp，杜绝 argv 注入面。 */
export function normalizeMediaOptions(raw = {}) {
  const o = (raw && typeof raw === 'object') ? raw : {}
  return {
    quality: clampInt(o.quality, 1, 100, 90),      // webp / jpg（jpg 会再映射到 2..31）
    crf: clampInt(o.crf, 0, 63, 23),              // H.264 / VP9
    bitrate: clampInt(o.bitrate, 32, 512, 192),   // kbps，音频 / 视频音轨
    fps: clampInt(o.fps, 1, 60, 12),              // 动图转视频
    width: clampInt(o.width, 16, 4096, -2),       // -2 = 按原比例对齐偶数
    duration: clampNum(o.duration, 0.1, 600, 0),  // 0 = 不截断
    loopCount: clampInt(o.loop_count ?? o.loopCount, 0, 20, 0),
    preset: ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'].includes(String(o.preset))
      ? String(o.preset) : 'medium',
  }
}

/**
 * 单个目标格式的 ffmpeg 编码参数（不含 -i / 输入 / 输出 / -y）。
 * 纯数据拼装，所有数值都来自 normalizeMediaOptions()，不拼接任何用户输入字符串。
 */
export function buildMediaFormatArgs(format, opts = {}) {
  const r = resolveFormat(format)
  if (!r.ok) return []
  const o = normalizeMediaOptions(opts)
  const jpgQ = Math.max(2, Math.min(31, Math.round(32 - o.quality * 0.3)))
  switch (r.format) {
    case 'jpg': return ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', String(jpgQ)]
    case 'png': return ['-frames:v', '1', '-c:v', 'png']
    case 'webp': return ['-frames:v', '1', '-c:v', 'libwebp', '-quality', String(o.quality)]
    case 'mp4': return ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', o.bitrate + 'k', '-movflags', '+faststart']
    case 'mkv': return ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', o.bitrate + 'k']
    case 'mov': return ['-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', o.bitrate + 'k']
    case 'webm': return ['-c:v', 'libvpx-vp9', '-crf', String(o.crf), '-b:v', '0',
      '-c:a', 'libopus', '-b:a', o.bitrate + 'k']
    case 'mp3': return ['-vn', '-c:a', 'libmp3lame', '-b:a', o.bitrate + 'k']
    case 'aac': return ['-vn', '-c:a', 'aac', '-b:a', o.bitrate + 'k', '-f', 'adts']
    case 'wav': return ['-vn', '-c:a', 'pcm_s16le']
    case 'flac': return ['-vn', '-c:a', 'flac']
    default: return []
  }
}

/**
 * 动图 → 视频的**输出侧**参数：统一帧率 + 偶数尺寸 + yuv420p（MP4/MOV 必需）。
 * `-stream_loop` 属于输入侧选项，必须由 buildMediaConvertCommand 放在 -i 之前，
 * 所以这里绝不返回它（单一来源，避免重复拼接后再 splice 清理）。
 */
export function buildAnimatedVideoArgs(opts = {}) {
  const o = normalizeMediaOptions(opts)
  const scale = o.width === -2
    ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos'
    : 'scale=' + o.width + ':trunc(ow/a/2)*2:flags=lanczos'
  const args = ['-vf', 'fps=' + o.fps + ',' + scale + ',format=yuv420p']
  if (o.duration > 0) args.push('-t', String(o.duration))
  return args
}

/**
 * 完整 ffmpeg argv（数组，绝不拼 shell 字符串）。
 * @returns {{ok:boolean, command?:string[], reason?:string, from?:string, to?:string}}
 */
export function buildMediaConvertCommand({ source, out, format, sourceKind, still = false, options = {} } = {}) {
  const src = String(source ?? '').trim()
  const target = String(out ?? '').trim()
  if (!src) return { ok: false, reason: '没给输入文件（source）' }
  if (!target) return { ok: false, reason: '没给输出文件（target）' }
  const plan = planConversion({ sourceKind: sourceKindOf(src, sourceKind), format, still })
  if (!plan.ok) return { ok: false, reason: plan.reason }
  const o = normalizeMediaOptions(options)
  const cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error']
  // -stream_loop 是输入选项，必须在 -i 之前；gif/apng 解复用默认忽略循环信息（只转一遍）。
  if (plan.animated && o.loopCount > 0) cmd.push('-stream_loop', String(o.loopCount - 1))
  cmd.push('-i', src)
  if (plan.animated) cmd.push(...buildAnimatedVideoArgs(options))
  // 动图取首帧时，图片类格式参数本身已带 -frames:v 1，不重复添加。
  let fmtArgs = buildMediaFormatArgs(plan.format, options)
  if (plan.animated && plan.to === 'video') {
    // GIF / APNG 没有音轨：显式 -an，并成对去掉「-c:a / -b:a + 值」，
    // 避免引入 libopus / aac 这类不必要的编码器依赖（本机未编入会白失败）。
    const cleaned = []
    let skipValue = false
    for (const a of fmtArgs) {
      if (a === '-c:a' || a === '-b:a') { skipValue = true; continue }
      if (skipValue) { skipValue = false; continue }
      cleaned.push(a)
    }
    cleaned.push('-an')
    fmtArgs = cleaned
  }
  cmd.push(...fmtArgs)
  cmd.push('-y', target)
  return { ok: true, command: cmd, from: plan.from, to: plan.to, crossKind: plan.crossKind }
}

/** 端点/文档共用的公开格式清单（纯数据，不含本机路径与探测结论）。 */
export function listFormats() {
  return {
    version: MEDIA_FORMAT_VERSION,
    groups: Object.fromEntries(Object.entries(FORMAT_GROUPS).map(([k, v]) => [k, [...v]])),
    formats: Object.fromEntries(Object.entries(FORMAT_TABLE).map(([k, v]) => [k, { ...v }])),
    aliases: { ...FORMAT_ALIASES },
    animated_inputs: [...ANIMATED_INPUT_EXTS],
    conversion_rules: [
      '同类互转：image↔image、video↔video、audio↔audio',
      '动图（gif/apng/webp 动图）→ 视频；动图 → 静态图需 still:true',
      '其它跨类转换一律拒绝并说明原因',
    ],
    caveat: '编码器标识是 ffmpeg 标准名，本机 ffmpeg 是否编入需实际执行才能确认；'
      + '未探测到 ffmpeg 或未注入执行器时只返回参数预览，不生成文件。',
  }
}
