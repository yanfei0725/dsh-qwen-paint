/* backend-header-gif-tool: 设计说明已外置 → docs/backend-headers-design-notes.md#backend-header-gif-tool */
import path from 'node:path'

export const GIF_TOOL_NAME = 'convert_to_gif'

/** GIF 工具超时上限（>0，避免宿主侧无限等待）。 */
export const GIF_TOOL_TIMEOUT_MS = 120 * 1000

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']
const DITHERS = ['none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a']
const DEFAULT_DITHER = 'sierra2_4a'

/**
 * 输出路径的目录围栏。
 *
 * 与 lib/asr-client.js 的 resolveAudioPath 同源：path.resolve 后必须仍落在
 * outputDir + 分隔符之内；额外显式拒绝任何 `..` 段（双保险，避免不同平台
 * resolve 的规范化差异被利用）。outputDir 未配置时直接拒绝 —— 写操作没有
 * 围栏就没有边界，绝不替调用方猜目录。
 *
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function resolveGifOutputPath({ target, outputDir } = {}) {
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
  return { ok: true, path: full }
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
function extOf(file) {
  const s = String(file ?? '')
  const dot = s.lastIndexOf('.')
  return dot >= 0 ? s.slice(dot).toLowerCase() : ''
}

/** 解析调用方给出的输入形态，返回 { mode, inputs, error }。 */
function resolveInputs(args) {
  const list = Array.isArray(args.sources)
    ? args.sources.map((x) => String(x ?? '').trim()).filter(Boolean)
    : []
  if (list.length > 0) return { mode: 'sequence', inputs: list }
  const src = String(args.source ?? '').trim()
  if (!src) return { mode: '', inputs: [], error: '请给 source（单文件）或 sources（图片序列）' }
  const forced = String(args.mode ?? '').trim().toLowerCase()
  if (forced === 'video' || forced === 'image' || forced === 'sequence') {
    return { mode: forced, inputs: [src] }
  }
  const ext = extOf(src)
  if (VIDEO_EXTS.includes(ext)) return { mode: 'video', inputs: [src] }
  if (IMAGE_EXTS.includes(ext)) return { mode: 'image', inputs: [src] }
  return { mode: '', inputs: [], error: '无法识别输入类型，请用 mode 指定 image / sequence / video' }
}

/** 调色板抖动 / 尺寸之后的公共滤镜链（单遍 palettegen + paletteuse）。 */
function paletteChain(cfg) {
  return 'fps=' + cfg.fps + ',scale=' + cfg.width + ':' + cfg.height + ':flags=lanczos,'
    + 'split[a][b];[a]palettegen=max_colors=' + cfg.maxColors + '[p];[b][p]paletteuse=dither=' + cfg.dither
}

/**
 * 纯参数构建：按 mode 拼出 ffmpeg argv（数组，不真执行）。
 * 三种形态都在 command 里显式体现 fps / scale / palette / loop / 时长 / 输出路径。
 */
function buildFfmpegCommand({ mode, inputs, out, cfg }) {
  const cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error']
  if (mode === 'sequence') {
    const per = String(Math.max(0.04, cfg.duration / inputs.length))
    for (const f of inputs) {
      cmd.push('-loop', '1', '-t', per, '-i', f)
    }
    const labels = inputs.map((_, i) => '[' + i + ':v]').join('')
    cmd.push('-filter_complex', labels + 'concat=n=' + inputs.length + ':v=1:a=0[cat];[cat]' + paletteChain(cfg))
  } else if (mode === 'image') {
    cmd.push('-loop', '1', '-t', String(cfg.duration), '-i', inputs[0])
    cmd.push('-vf', paletteChain(cfg))
  } else {
    cmd.push('-ss', '0', '-t', String(cfg.duration), '-i', inputs[0], '-an')
    cmd.push('-vf', paletteChain(cfg))
  }
  cmd.push('-loop', String(cfg.loop), '-y', out)
  return cmd
}

/** 保证 8 个声明字段永远齐全（withDeclaredOutput 会按 output.schema 白名单裁剪，漏写即丢字段）。 */
function shapeResult(patch) {
  return {
    ok: patch.ok === true,
    path: patch.path ?? '',
    width: patch.width ?? 0,
    height: patch.height ?? 0,
    frames: patch.frames ?? 0,
    fps: patch.fps ?? 0,
    command: Array.isArray(patch.command) ? patch.command : [],
    reason: String(patch.reason ?? ''),
  }
}

/**
 * @param {object} deps
 * @param {Function} [deps.runCommand] 已探测到 ffmpeg 可用时注入的命令执行器；未注入即离线降级
 * @param {Function} [deps.readFile]   真执行前校验输入可读
 * @param {Function} [deps.writeFile]  真执行时写一份参数留痕
 * @param {string}   [deps.outputDir]  出图目录（目录围栏的基准）
 * @param {Function} [deps.log]         本机日志
 */
export function makeGifTool(deps = {}) {
  const { runCommand, readFile, writeFile, outputDir, log } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }

  return {
    name: GIF_TOOL_NAME,
    description: '把单张图 / 图片序列 / 视频转换成 GIF：构建完整 ffmpeg 参数，并在宿主已探测到 '
      + 'ffmpeg 可用（注入 runCommand）时真正生成文件。纯本机、不联网；未注入 runCommand 时'
      + '返回 ok:false 与明确降级理由，command 字段仍给出可用参数，绝不真起进程、绝不谎称已出图。'
      + ' 参数：单图给 source，图片序列给 sources 数组，视频给 source 且 mode 可写 video；'
      + 'target 是输出 GIF 文件名（相对出图目录，必须留在该目录内）；'
      + '可配 fps / width / height / duration / loop / dither / maxColors。'
      + ' 什么时候用：用户要把图片或视频做成动图时。视频 / 单图的 frames 是按时长与帧率的估算，未解码源，不是实测帧数。',
    timeoutMs: GIF_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: '单个图片或视频文件路径（本机绝对路径）。与 sources 二选一。' },
        sources: { type: 'array', items: { type: 'string' }, description: '图片序列路径数组；给了它就按序列模式，忽略 source。' },
        target: { type: 'string', description: '输出 GIF 文件名 / 相对出图目录的子路径；必须落在 outputDir 内，不允许 .. 穿越。' },
        mode: { type: 'string', description: '显式输入形态：image / sequence / video；不传则按 sources 与扩展名自动推断。' },
        fps: { type: 'integer', description: '帧率，1-60，默认 12。' },
        width: { type: 'integer', description: '输出宽，16-4096，默认 480。' },
        height: { type: 'integer', description: '输出高，-1 表示按原比例自适应，默认 -1。' },
        duration: { type: 'number', description: '时长（秒），0.1-60，默认 3；视频按它截取，单图/序列按它铺帧。' },
        loop: { type: 'integer', description: 'GIF 循环次数：-1 不循环，0 无限循环，>0 指定次数，默认 0。' },
        dither: { type: 'string', description: '抖动算法：none / bayer / heckbert / floyd_steinberg / sierra2 / sierra2_4a，默认 sierra2_4a。' },
        maxColors: { type: 'integer', description: '调色板最大颜色数，2-256，默认 128。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '是否真正生成了 GIF。' },
          path: { type: 'string', description: '围栏后的输出 GIF 绝对路径。' },
          width: { type: 'integer', description: '目标宽度。' },
          height: { type: 'integer', description: '目标高度（-1 表示按比例）。' },
          frames: { type: 'integer', description: '帧数：序列为输入张数，单图为 1，视频为时长×帧率的估算值。' },
          fps: { type: 'number', description: '实际采用的帧率。' },
          command: { type: 'array', items: { type: 'string' }, description: '构建出的 ffmpeg 参数数组（未执行也可参考）。' },
          reason: { type: 'string', description: '结果说明 / 降级理由。' },
        },
      },
      // ★ 2026-11-19 宿主 output 契约补齐（diag：register.extras 失败于 convert_to_gif
      //   "must declare output { schema, render, presentationMeta? }"—— extras 组 44 条端点
      //   因此整组没注册，lab/doctor/tts/creative 全 401/404 的根源）。
      render: (_args, value) => {
        const v = value ?? {}
        const text = v.ok === true
          ? `已生成 GIF：${v.path ?? ''}（${v.width ?? '?'}x${v.height ?? '?'}，${v.frames ?? '?'} 帧 @${v.fps ?? '?'}fps）`
          : `未生成 GIF：${v.reason ?? '未知原因'}${Array.isArray(v.command) && v.command.length > 0 ? '（command 里有可参考的 ffmpeg 参数）' : ''}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args = {}) {
      // 所有分支都经 shapeResult 收口，保证 8 个声明字段不缺。
      try {
        const picked = resolveInputs(args)
        if (picked.error) {
          return shapeResult({ ok: false, reason: picked.error })
        }
        const guarded = resolveGifOutputPath({ target: args.target, outputDir })
        if (!guarded.ok) {
          return shapeResult({ ok: false, reason: guarded.reason })
        }
        const ditherRaw = String(args.dither ?? '').trim()
        const cfg = {
          fps: clampInt(args.fps, 1, 60, 12),
          width: clampInt(args.width, 16, 4096, 480),
          height: clampInt(args.height, -1, 4096, -1),
          duration: clampNum(args.duration, 0.1, 60, 3),
          loop: clampInt(args.loop, -1, 1000, 0),
          dither: DITHERS.includes(ditherRaw) ? ditherRaw : DEFAULT_DITHER,
          maxColors: clampInt(args.maxColors, 2, 256, 128),
        }
        const command = buildFfmpegCommand({ mode: picked.mode, inputs: picked.inputs, out: guarded.path, cfg })
        const frames = picked.mode === 'sequence'
          ? picked.inputs.length
          : (picked.mode === 'video' ? Math.max(1, Math.round(cfg.duration * cfg.fps)) : 1)
        const common = {
          path: guarded.path, width: cfg.width, height: cfg.height,
          frames, fps: cfg.fps, command,
        }

        // 能力探测 → 可用才启用：没有注入 runCommand 就明确降级，绝不真起进程。
        if (typeof runCommand !== 'function') {
          return shapeResult({
            ...common,
            ok: false,
            reason: '离线降级：未注入命令执行器（未探测到可用 ffmpeg），仅返回 ffmpeg 参数供参考，未生成文件。',
          })
        }

        // 真执行路径：校验输入可读 → 落一份参数留痕 → 调用执行器。
        if (typeof readFile === 'function') {
          for (const f of picked.inputs) await readFile(f)
        }
        if (typeof writeFile === 'function') {
          await writeFile(guarded.path + '.args.json', JSON.stringify({ mode: picked.mode, ...cfg, command }, null, 2))
        }
        const run = await runCommand(command, { timeoutMs: GIF_TOOL_TIMEOUT_MS })
        const failed = run && run.ok === false
        return shapeResult({
          ...common,
          ok: !failed,
          reason: failed
            ? 'ffmpeg 执行失败（详见插件日志）；未生成 GIF。'
            : '已生成 GIF（ffmpeg 由宿主注入的执行器运行）。',
        })
      } catch (error) {
        // 只写本机日志，回固定文案，绝不回吐 error.message（可能带本机绝对路径）。
        warn(`GIF 转换失败：${error?.message ?? error}`)
        return shapeResult({ ok: false, reason: 'GIF 转换暂不可用（详见插件日志）' })
      }
    },
  }
}
