/** lib/video-post-tools.js —— 视频后处理内置最小实现：精准裁剪 + ProRes 导出。
 *  与 media-convert-tool.js 同口径：只用 lib/media-exec.js 的真 ffmpeg 封装；
 *  未探测到 ffmpeg / 编码器缺失时返回 degraded:true + command 预览，绝不伪造文件。
 */
import path from 'node:path'
import {
  resolveMediaSourcePath, resolveMediaOutputPath,
} from './media-convert-tool.js'

export const VIDEO_TRIM_CROP_TOOL = 'video_trim_crop'
export const VIDEO_PRORES_EXPORT_TOOL = 'video_prores_export'
export const VIDEO_TRIM_CROP_PATH = '/api/qwen-paint/video/trim-crop'
export const VIDEO_PRORES_EXPORT_PATH = '/api/qwen-paint/video/prores-export'
const TIMEOUT_MS = 180000

const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const int = (v, fallback) => Math.round(num(v, fallback))

/** 裁剪 argv：仅切片且无需裁剪时走 -c copy；其余走 libx264 重编码。 */
export function buildTrimCropCommand({ source, out, start, end, crop, forceReencode = false } = {}) {
  const ss = num(start, 0)
  if (ss < 0) return { ok: false, reason: 'start 不能小于 0' }
  let duration = null
  if (end !== undefined && end !== null && String(end).trim() !== '') {
    const en = num(end, NaN)
    if (!Number.isFinite(en) || en <= ss) return { ok: false, reason: 'end 必须是大于 start 的秒数' }
    duration = en - ss
  }
  let vf = null
  if (crop && (crop.w !== undefined || crop.h !== undefined)) {
    const w = int(crop.w, 0); const h = int(crop.h, 0)
    const x = int(crop.x, 0); const y = int(crop.y, 0)
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      return { ok: false, reason: 'crop 需要 w/h > 0 且 x/y >= 0 的整数' }
    }
    vf = `crop=${w}:${h}:${x}:${y}`
  }
  const argv = ['-y', '-ss', String(ss), '-i', source]
  if (duration !== null) argv.push('-t', String(Number(duration.toFixed(3))))
  if (vf) argv.push('-vf', vf)
  const reencoded = Boolean(vf) || forceReencode === true
  if (reencoded) argv.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy')
  else argv.push('-c', 'copy', '-avoid_negative_ts', 'make_zero')
  argv.push(out)
  return { ok: true, command: argv, reencoded,
    reason: reencoded ? '重编码保证时间/裁剪精度' : '-c copy 按关键帧切，时间精度受 GOP 限制' }
}

const PRORES_PROFILES = Object.freeze({
  proxy: { n: 0, pix: 'yuv422p10le' },
  lt: { n: 1, pix: 'yuv422p10le' },
  standard: { n: 2, pix: 'yuv422p10le' },
  hq: { n: 3, pix: 'yuv422p10le' },
  4444: { n: 4, pix: 'yuva444p10le' },
})

/** ProRes argv：导出用 prores_ks；profile 名映射到 0..4，像素格式与之匹配。 */
export function buildProresCommand({ source, out, profile = 'standard' } = {}) {
  const p = PRORES_PROFILES[String(profile).toLowerCase()]
  if (!p) return { ok: false, reason: 'prores profile 只能是 proxy/lt/standard/hq/4444' }
  return {
    ok: true,
    command: ['-y', '-i', source, '-c:v', 'prores_ks', '-profile:v', String(p.n),
      '-pix_fmt', p.pix, '-c:a', 'pcm_s16le', out],
    profile: String(profile).toLowerCase(), pixel_format: p.pix,
    reason: 'ProRes 导出；编码器是否可用取决于本机 ffmpeg 构建',
  }
}

function commonExecute(deps, built, outPath, extra = {}) {
  const shape = (o) => ({ ok: false, degraded: true, path: '', reason: '', command: built.command || [], ...extra, ...o })
  if (!built.ok) return shape({ reason: built.reason })
  const exec = deps.mediaExec && typeof deps.mediaExec.runCommand === 'function'
    ? deps.mediaExec
    : (typeof deps.runCommand === 'function' ? { runCommand: deps.runCommand } : null)
  if (!exec) {
    return shape({ reason: '未注入媒体执行器，仅返回 ffmpeg 参数预览，未生成文件' })
  }
  return (async () => {
    try {
      if (typeof exec.probe === 'function') {
        const probe = await exec.probe()
        if (probe && probe.available === false) {
          return shape({ reason: '未探测到可用的 ffmpeg，仅返回参数预览，未生成文件' })
        }
      }
      const run = await exec.runCommand(built.command, { timeoutMs: TIMEOUT_MS })
      return {
        ok: run?.ok === true, degraded: run?.ok !== true,
        path: run?.ok === true ? outPath : '',
        reason: String(run?.reason ?? ''), command: built.command, ...extra,
      }
    } catch {
      return shape({ reason: '视频后处理执行失败（详见插件日志），未生成文件' })
    }
  })()
}

function resolveIO(deps, args, ext) {
  const src = resolveMediaSourcePath({ source: args?.source, outputDir: deps.outputDir, sourceDirs: deps.sourceDirs })
  if (!src.ok) return { error: src.reason }
  const base = path.basename(src.path).replace(/\.[^.]+$/u, '')
  const target = args?.target ? String(args.target) : `${base}_post.${ext}`
  const out = resolveMediaOutputPath({ target, outputDir: deps.outputDir, format: ext })
  if (!out.ok) return { error: out.reason }
  return { source: src.path, out: out.path }
}

const SHAPE = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean' }, path: { type: 'string' }, reason: { type: 'string' },
    command: { type: 'array', items: { type: 'string' } }, degraded: { type: 'boolean' },
  },
}

export function makeVideoPostTools(deps = {}) {
  const trimTool = {
    name: VIDEO_TRIM_CROP_TOOL,
    description: '裁剪/切片本机视频：按秒截取并可选矩形裁剪。无裁剪时可 -c copy 快速切（按关键帧，时间近似）；'
      + '要精度或带 crop 时重编码。源文件必须在出图目录或允许的源目录内，输出只在出图目录；'
      + '未探测到 ffmpeg 时只给参数预览，不谎称已生成。',
    timeoutMs: TIMEOUT_MS,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: '源视频路径（出图目录或允许的源目录内）。' },
        target: { type: 'string', description: '输出文件名，默认 <原名>_post.mp4。' },
        start: { type: 'number', description: '起始秒，默认 0。' },
        end: { type: 'number', description: '结束秒，不给则到结尾。' },
        crop: { type: 'object', additionalProperties: false,
          properties: { w: { type: 'integer' }, h: { type: 'integer' }, x: { type: 'integer' }, y: { type: 'integer' } } },
        force_reencode: { type: 'boolean', description: 'true 时即使无裁剪也重编码，保证精确到帧。' },
      },
      required: ['source'],
    },
    output: { schema: { ...SHAPE, properties: { ...SHAPE.properties, reencoded: { type: 'boolean' } } } },
    async execute(args = {}) {
      const io = resolveIO(deps, args, 'mp4')
      if (io.error) return { ok: false, degraded: true, reason: io.error, command: [], path: '' }
      const built = buildTrimCropCommand({
        source: io.source, out: io.out, start: args.start, end: args.end,
        crop: args.crop, forceReencode: args.force_reencode === true,
      })
      return commonExecute(deps, built, io.out, { reencoded: built.reencoded === true })
    },
  }
  const proresTool = {
    name: VIDEO_PRORES_EXPORT_TOOL,
    description: '把本机视频导出为 Apple ProRes（MOV 容器）。profile 支持 proxy/lt/standard/hq/4444；'
      + '纯 ffmpeg 执行，编码器缺失时明确降级。源文件围栏与 convert_media 一致，输出只在出图目录。',
    timeoutMs: TIMEOUT_MS,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        source: { type: 'string', description: '源视频路径（出图目录或允许的源目录内）。' },
        target: { type: 'string', description: '输出 MOV 文件名，默认 <原名>_post.mov。' },
        profile: { type: 'string', description: 'proxy / lt / standard / hq / 4444，默认 standard。' },
      },
      required: ['source'],
    },
    output: { schema: { ...SHAPE, properties: { ...SHAPE.properties,
      profile: { type: 'string' }, pixel_format: { type: 'string' } } } },
    async execute(args = {}) {
      const io = resolveIO(deps, args, 'mov')
      if (io.error) return { ok: false, degraded: true, reason: io.error, command: [], path: '' }
      const built = buildProresCommand({ source: io.source, out: io.out, profile: args.profile ?? 'standard' })
      return commonExecute(deps, built, io.out, { profile: built.profile, pixel_format: built.pixel_format })
    },
  }
  return [trimTool, proresTool]
}

/** 本机 HTTP 端点：两条 POST，回环校验 + 写守卫 + 有界 body，与媒体转换端点同口径。 */
export function videoPostRouteTable(deps = {}) {
  const { isLocalRequest, respondJson, readJsonBody, guardWriteRequest, log } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const tools = makeVideoPostTools(deps)
  const handlerFor = (tool) => async (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
    }
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      respondJson(res, { ok: false, reason: 'POST only' }, 405); return
    }
    if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return
    try {
      const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) ?? {} : {}
      respondJson(res, await tool.execute(body))
    } catch (error) {
      warn(`视频后处理端点失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '视频后处理暂不可用（详见插件日志）' }, 500)
    }
  }
  return [
    { path: VIDEO_TRIM_CROP_PATH, method: 'POST', handler: handlerFor(tools[0]) },
    { path: VIDEO_PRORES_EXPORT_PATH, method: 'POST', handler: handlerFor(tools[1]) },
  ]
}
