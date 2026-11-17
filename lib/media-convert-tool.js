/** media-convert-tool —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#tts-lowlatency-space-media-convert-tool */
import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import {
  FORMAT_GROUPS, FORMAT_TABLE, resolveFormat, sourceKindOf, planConversion,
  buildMediaConvertCommand, normalizeMediaOptions,
} from './media-formats.js'

export const MEDIA_TOOL_NAME = 'convert_media'
export const MEDIA_TOOL_TIMEOUT_MS = 180 * 1000

/** 输出路径围栏：与 lib/gif-tool.js::resolveGifOutputPath 同口径，额外校验扩展名与目标格式一致。 */
export function resolveMediaOutputPath({ target, outputDir, format } = {}) {
  const rel = String(target ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (!rel) return { ok: false, reason: '没给输出文件名（target）' }
  if (!base) return { ok: false, reason: '输出目录未配置，无法做目录围栏' }
  const parts = rel.replace(/\\/g, '/').split('/')
  if (parts.some((p) => p === '..')) return { ok: false, reason: '输出路径不允许 .. 穿越' }
  const root = path.resolve(base)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, reason: '输出路径必须落在出图目录内' }
  }
  if (full === root) return { ok: false, reason: '输出路径不能就是目录本身' }
  const r = resolveFormat(format)
  if (!r.ok) return { ok: false, reason: r.reason }
  const ext = path.extname(full).slice(1).toLowerCase()
  if (ext && ext !== r.format && ext !== 'jpeg') {
    return { ok: false, reason: `输出文件扩展名 .${ext} 与目标格式 ${r.format} 不一致，请把 target 改成 .${r.format}` }
  }
  const final = ext ? full : full + '.' + r.format
  return { ok: true, path: final, format: r.format }
}

/** 输入路径围栏：只允许落在 outputDir 或显式注入的 sourceDirs 内。 */
export function resolveMediaSourcePath({ source, outputDir, sourceDirs = [] } = {}) {
  const src = String(source ?? '').trim()
  if (!src) return { ok: false, reason: '没给输入文件（source）' }
  const roots = [outputDir, ...sourceDirs].map((d) => String(d ?? '').trim()).filter(Boolean).map((d) => path.resolve(d))
  if (roots.length === 0) return { ok: false, reason: '没有配置任何允许的源目录，拒绝读取任意本机路径' }
  // 相对路径一律相对**出图目录**解析（不是进程 cwd），这样 UI / Agent 传文件名即可用。
  // 显式 `..` 段先拒掉，避免 path.resolve 规范化后绕过围栏。
  if (src.replace(/\\/g, '/').split('/').some((p) => p === '..')) {
    return { ok: false, reason: '输入路径不允许 .. 穿越' }
  }
  const abs = path.isAbsolute(src) ? path.resolve(src) : path.resolve(roots[0], src)
  for (const root of roots) {
    if (abs === root) continue
    if (abs.startsWith(root + path.sep)) {
      // ★ 2026-11-17 审计：junction 可穿透文本前缀围栏（已实证），realpath 复验（与 manual-upscale 同口径）。
      //   根目录不存在时跳过复验：不存在的目录藏不了 junction（夹具语义被 test-media-convert 锁定）。
      if (existsSync(root)) {
        let probe = abs
        for (let i = 0; i < 48 && !existsSync(probe); i += 1) probe = path.dirname(probe)
        let real, realRoot
        try { real = realpathSync(probe); realRoot = realpathSync(root) } catch {
          return { ok: false, reason: '输入文件路径无法解析' }
        }
        if (!(real === realRoot || real.startsWith(realRoot + path.sep))) {
          return { ok: false, reason: '输入文件不在允许的源目录内（链接目标越界）' }
        }
      }
      return { ok: true, path: abs }
    }
  }
  return {
    ok: false,
    reason: '输入文件不在允许的源目录内：请把素材放进公布的出图目录，或由宿主配置 sourceDirs；'
      + '本工具不读取任意本机路径，避免把敏感文件喂给 ffmpeg。',
  }
}

/** 保证声明字段永远齐全（withDeclaredOutput 会按 output.schema 白名单裁剪，漏写即丢字段）。 */
function shapeResult(patch) {
  return {
    ok: patch.ok === true,
    path: patch.path ?? '',
    format: patch.format ?? '',
    source_kind: patch.source_kind ?? 'other',
    from_ext: patch.from_ext ?? '',
    to_kind: patch.to_kind ?? '',
    command: Array.isArray(patch.command) ? patch.command : [],
    reason: String(patch.reason ?? ''),
    degraded: patch.degraded === true,
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.mediaExec]     lib/media-exec.js 的执行器（含 probe / runCommand）
 * @param {Function} [deps.runCommand]  兼容旧注入式的执行器（优先用 mediaExec）
 * @param {string}   [deps.outputDir]   出图目录（输出围栏基准 + 默认输入允许目录）
 * @param {string[]} [deps.sourceDirs]  额外允许的源目录（宿主注入）
 * @param {Function} [deps.readFile]    真执行前校验输入可读
 * @param {Function} [deps.log]
 */
export function makeMediaConvertTool(deps = {}) {
  const { outputDir, sourceDirs, readFile, log } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const exec = deps.mediaExec && typeof deps.mediaExec.runCommand === 'function'
    ? deps.mediaExec
    : (typeof deps.runCommand === 'function' ? { runCommand: deps.runCommand } : null)

  return {
    name: MEDIA_TOOL_NAME,
    description: '把本机媒体文件转换成指定格式：图片 JPG / PNG / WebP，视频 MP4 / MKV / MOV / WebM，'
      + '音频 MP3 / AAC / WAV / FLAC；既能转插件刚生成的图片/视频/音频，也能转用户自己的素材，'
      + '还支持把 GIF / APNG / 动图 WebP 转成视频（动图转视频）。纯本机、不联网。'
      + '参数：source（源文件路径，必须落在公布的出图目录或宿主允许的源目录内）、'
      + 'target（输出文件名，相对出图目录，扩展名须与目标格式一致或省略自动补齐）、'
      + 'format（目标格式）；webp 动图请给 source_kind:"animated"，动图取首帧成静态图给 still:true。'
      + '可配 quality / crf / bitrate / fps / width / duration / loop_count / preset。'
      + '同类格式互转；跨类（如图片→音频）会明确拒绝。'
      + '什么时候用：用户要「把这张图存成 WebP」「视频转 MKV」「音频转 FLAC」「把动图做成 MP4」时。'
      + '诚实边界：必须探测到本机 ffmpeg 才会真正生成文件；未探测到或编码器缺失时'
      + '返回 ok:false 与明确原因，command 字段仍给出完整参数供参考，绝不假装已转换。',
    timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '输入文件路径（本机路径，须落在允许的源目录内）。' },
        target: { type: 'string', description: '输出文件名 / 相对出图目录子路径；须落在出图目录内，不允许 .. 穿越；省略则自动生成。' },
        format: { type: 'string', description: '目标格式：jpg / png / webp / mp4 / mkv / mov / webm / mp3 / aac / wav / flac。' },
        source_kind: { type: 'string', description: '显式声明输入类别：image / video / audio / animated；不给则按扩展名推断。' },
        still: { type: 'boolean', description: '动图取首帧转静态图时为 true（默认 false）。' },
        quality: { type: 'integer', description: '图片质量 1-100，默认 90（JPG 会映射到 mjpeg q:v）。' },
        crf: { type: 'integer', description: '视频质量 0-63，默认 23。' },
        bitrate: { type: 'integer', description: '音频码率 kbps 32-512，默认 192。' },
        fps: { type: 'integer', description: '动图转视频的帧率 1-60，默认 12。' },
        width: { type: 'integer', description: '动图转视频宽度；默认 -2 表示按原比例对齐偶数。' },
        duration: { type: 'number', description: '动图转视频最长时长（秒），0 表示不截断。' },
        loop_count: { type: 'integer', description: '动图转视频重复遍数 0-20；0 表示只转一遍（GIF 循环次数不自动延续）。' },
        preset: { type: 'string', description: 'H.264 preset：ultrafast / veryfast / fast / medium / slow，默认 medium。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '是否真正生成了目标格式文件。' },
          path: { type: 'string', description: '围栏后的输出绝对路径。' },
          format: { type: 'string', description: '目标格式。' },
          source_kind: { type: 'string', description: '输入类别（image / video / audio / animated）。' },
          from_ext: { type: 'string', description: '源文件扩展名。' },
          to_kind: { type: 'string', description: '目标类别。' },
          command: { type: 'array', items: { type: 'string' }, description: '构建出的 ffmpeg 参数数组（未执行也可参考）。' },
          reason: { type: 'string', description: '结果说明 / 降级或拒绝理由。' },
          degraded: { type: 'boolean', description: 'true 表示本次没有真正生成文件（离线降级）。' },
        },
      },
    },
    async execute(args = {}) {
      try {
        const fmt = resolveFormat(args.format)
        if (!fmt.ok) return shapeResult({ ok: false, reason: fmt.reason, degraded: true })

        const sourceKind = sourceKindOf(args.source, args.source_kind)
        const plan = planConversion({ sourceKind, format: fmt.format, still: args.still === true })
        if (!plan.ok) return shapeResult({ ok: false, reason: plan.reason, source_kind: sourceKind, degraded: true })

        const src = resolveMediaSourcePath({ source: args.source, outputDir, sourceDirs })
        if (!src.ok) return shapeResult({ ok: false, reason: src.reason, source_kind: sourceKind, degraded: true })

        const autoTarget = args.target
          ? String(args.target)
          : path.basename(src.path).replace(/\.[^.]+$/u, '') + '_converted.' + fmt.format
        const out = resolveMediaOutputPath({ target: autoTarget, outputDir, format: fmt.format })
        if (!out.ok) return shapeResult({ ok: false, reason: out.reason, source_kind: sourceKind, degraded: true })

        const built = buildMediaConvertCommand({
          source: src.path, out: out.path, format: fmt.format,
          sourceKind, still: args.still === true, options: args,
        })
        if (!built.ok) return shapeResult({ ok: false, reason: built.reason, source_kind: sourceKind, degraded: true })

        const fromExt = path.extname(src.path).slice(1).toLowerCase()
        const common = {
          path: out.path, format: fmt.format, source_kind: sourceKind,
          from_ext: fromExt, to_kind: plan.to, command: built.command,
        }
        // 能力探测 → 可用才启用：没有执行器就明确降级，绝不真起进程。
        if (!exec) {
          return shapeResult({
            ...common, ok: false, degraded: true,
            reason: '离线降级：宿主未注入媒体执行器（未探测 ffmpeg），仅返回 ffmpeg 参数供参考，未生成文件。',
          })
        }
        if (typeof readFile === 'function') await readFile(src.path)
        const run = await exec.runCommand(built.command, { timeoutMs: MEDIA_TOOL_TIMEOUT_MS })
        return shapeResult({
          ...common,
          ok: run?.ok === true,
          command: Array.isArray(run?.command) ? run.command : built.command,
          reason: String(run?.reason ?? '执行器未给出结论'),
          degraded: run?.ok !== true,
        })
      } catch (error) {
        warn(`媒体格式转换失败：${error?.message ?? error}`)
        return shapeResult({ ok: false, reason: '媒体格式转换暂不可用（详见插件日志）', degraded: true })
      }
    },
  }
}

/** 供端点/文档复用：把格式组与表拼成简短清单（不含本机信息）。 */
export function describeMediaFormats() {
  return Object.entries(FORMAT_GROUPS).map(([kind, list]) => ({
    kind,
    formats: list.map((f) => ({ id: f, label: FORMAT_TABLE[f].label, codec: FORMAT_TABLE[f].codec })),
  }))
}

/** 供后转码复用：判断当前文件扩展名是否已经是目标格式（避免无意义的自转换）。 */
export function needsConversion(sourceFile, targetFormat) {
  const r = resolveFormat(targetFormat)
  if (!r.ok) return false
  const ext = path.extname(String(sourceFile ?? '')).slice(1).toLowerCase()
  if (ext === r.format || (r.format === 'jpg' && ext === 'jpeg')) return false
  return true
}

export { normalizeMediaOptions }
