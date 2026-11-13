/**
 * lib/video-frames-endpoints.js —— 视频选帧 / 时间段截取的**本机 HTTP 端点**。
 *
 * ## 为什么存在
 *   用户要的是"像剪辑软件那样，自己选帧去改 / 自己选一段时间截出来"。
 *   插件原来只有 `generate_video`，产物是一整个 mp4，用户既改不了中间某一帧，
 *   也切不出其中一段。
 *
 * ## 两条路，优先走**不需要 ffmpeg** 的那条
 *   · `POST /frame-save`：浏览器 `<video>` + `<canvas>` 已经把帧画出来了，
 *     这里只负责把 PNG 落盘。**零外部依赖**，用户机器上没有 ffmpeg 也能用。
 *   · `POST /frame` / `POST /clip` / `POST /replace-frame` / `GET /probe`：需要 ffmpeg / ffprobe。
 *     找不到就**如实返回 `needFfmpeg: true`**，绝不假装成功。
 *
 * ## 安全边界（与其它本机端点同一口径）
 *   · 顶层 `isLocalRequest` 可信围栏；POST only + `guardWriteRequest`；
 *   · body 走有界 `readJsonBody`；
 *   · **所有**输入视频路径必须是 `outputDir` 内的文件（`assertInsideOutput`），
 *     防止把任意本机文件当视频喂给 ffmpeg；
 *   · 只用 `execFile` 传 argv 数组，**不拼 shell 字符串**（无注入面）；
 *   · 产物一律写进 `outputDir`，文件名由时间戳生成，不含原视频名；
 *   · 不发起任何网络请求、不下载任何东西。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildClipArgs, buildFrameArgs, buildReplaceFrameArgs,
  makeClipName, makeFrameName, parseProbe,
  resolveReplaceFrame, resolveSelection,
} from './video-frames.js'

const execFileAsync = promisify(execFile)
const MAX_FRAME_CHARS = 24 * 1024 * 1024
const PNG_PREFIX = 'data:image/png;base64,'
const CMD_TIMEOUT_MS = 120000

/** 判断 `target` 是否在 `root` 内（按解析后的真实路径比，防 `..` 穿越）。 */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * @param {object} deps
 * @param {(req:object)=>boolean} deps.isLocalRequest
 * @param {(req:object,res:object)=>boolean} deps.guardWriteRequest
 * @param {(res:object,body:object,status?:number)=>void} deps.respondJson
 * @param {(req:object)=>Promise<object>} deps.readJsonBody
 * @param {object} deps.cfg 插件配置（含 outputDir）
 * @param {(level:string,msg:string)=>void} [deps.log]
 * @param {(cmd:string,args:string[])=>Promise<{stdout:string}>} [deps.run] 便于离线测试注入
 */
export function makeVideoFrameHandlers(deps) {
  const { isLocalRequest, guardWriteRequest, respondJson, readJsonBody, cfg, log } = deps
  const run = typeof deps.run === 'function'
    ? deps.run
    : (cmd, args) => execFileAsync(cmd, args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })

  /* ---------- ffmpeg / ffprobe 探测（带缓存，失败不缓存太久） ---------- */
  let toolCache = null
  async function detectTools() {
    if (toolCache !== null && Date.now() - toolCache.at < 10 * 60 * 1000) return toolCache.value
    const envPath = String(process.env.FFMPEG_PATH ?? '').trim()
    const candidates = []
    if (envPath !== '') {
      // 同目录下的 ffprobe：保留原扩展名（Windows 是 .exe，POSIX 没有扩展名）
      const ext = path.extname(envPath)
      const sibling = path.join(path.dirname(envPath), `ffprobe${ext}`)
      candidates.push({ ffmpeg: envPath, ffprobe: sibling })
    }
    candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
    let value = { ffmpeg: null, ffprobe: null, source: '' }
    for (const c of candidates) {
      try {
        await run(c.ffmpeg, ['-version'])
        value = { ffmpeg: c.ffmpeg, ffprobe: null, source: c.ffmpeg === 'ffmpeg' ? 'PATH' : 'FFMPEG_PATH' }
        try {
          await run(c.ffprobe, ['-version'])
          value.ffprobe = c.ffprobe
        } catch { /* 没 ffprobe 也能截，只是探不到 fps */ }
        break
      } catch { /* 换下一个候选 */ }
    }
    toolCache = { at: Date.now(), value }
    return value
  }

  /** 把 body 里的视频路径校验成 outputDir 内的真实文件。失败返回 {error}。 */
  async function resolveVideo(body) {
    const raw = String(body?.path ?? body?.video ?? '').trim()
    if (raw === '') return { error: { reason: 'path 必填（要处理的视频路径）', status: 400 } }
    const resolved = path.resolve(raw)
    if (!isInside(cfg.outputDir, resolved)) {
      return { error: { reason: '只允许处理出图目录内的视频（不接受任意本机路径）', status: 400 } }
    }
    try {
      const st = await fsp.stat(resolved)
      if (!st.isFile()) return { error: { reason: '这不是一个文件', status: 400 } }
      return { path: resolved, size: st.size }
    } catch {
      return { error: { reason: '找不到这个视频文件', status: 404 } }
    }
  }

  /* ---------- GET /probe：时长 / 帧率 / 分辨率 ---------- */
  const probeHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'GET') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const found = await resolveVideo({ path: url.searchParams.get('path') })
      if (found.error) { respondJson(res, { ok: false, reason: found.error.reason }, found.error.status); return }
      const tools = await detectTools()
      if (tools.ffprobe === null) {
        respondJson(res, {
          ok: false,
          needFfmpeg: tools.ffmpeg === null,
          reason: tools.ffmpeg === null
            ? '没找到 ffmpeg —— 装一个并加进 PATH，或用 FFMPEG_PATH 指定；界面里仍可直接抽帧（走浏览器画布）'
            : '找到 ffmpeg 但没找到 ffprobe —— 时长请按播放器显示填，帧率按生成时的设置填',
        })
        return
      }
      const { stdout } = await run(tools.ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', found.path,
      ])
      const info = parseProbe(stdout)
      respondJson(res, { ok: true, path: found.path, size: found.size, ...info, source: tools.source })
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  /* ---------- POST /frame-save：浏览器画布已经抽好的帧，落盘即可（零依赖） ---------- */
  const frameSaveHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const png = String(body.png ?? body.imageDataUrl ?? '')
      if (!png.startsWith(PNG_PREFIX)) {
        respondJson(res, { ok: false, reason: 'png 必须是 data:image/png;base64,…' }, 400); return
      }
      if (png.length > MAX_FRAME_CHARS) {
        respondJson(res, { ok: false, reason: '这一帧太大（超过 24 MB）' }, 413); return
      }
      const bytes = Buffer.from(png.slice(PNG_PREFIX.length), 'base64')
      if (bytes.length === 0) { respondJson(res, { ok: false, reason: 'PNG 内容为空' }, 400); return }
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const out = path.join(cfg.outputDir, makeFrameName('dshqp-frame', Number(body.frame) || 0))
      await fsp.writeFile(out, bytes)
      log?.('info', `[选帧] 已保存一帧：${out}`)
      respondJson(res, { ok: true, path: out, bytes: bytes.length })
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  /* ---------- POST /frame：用 ffmpeg 按帧号 / 时间抽单帧 ---------- */
  const frameHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const found = await resolveVideo(body)
      if (found.error) { respondJson(res, { ok: false, reason: found.error.reason }, found.error.status); return }
      const sel = resolveSelection({ ...body, mode: body?.mode ?? 'frames' })
      if (!sel.ok) { respondJson(res, { ok: false, reason: sel.reason }, 400); return }
      const tools = await detectTools()
      if (tools.ffmpeg === null) {
        respondJson(res, { ok: false, needFfmpeg: true, reason: '没找到 ffmpeg，抽帧需要它；界面里可直接用浏览器画布抽帧' }, 503)
        return
      }
      const atSec = sel.startSec
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const out = path.join(cfg.outputDir, makeFrameName('dshqp-frame', sel.startFrame))
      await run(tools.ffmpeg, buildFrameArgs({ input: found.path, output: out, atSec }))
      respondJson(res, { ok: true, path: out, atSec, frame: sel.startFrame, fps: sel.fps, warnings: sel.warnings })
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  /* ---------- POST /clip：截一段时间成 mp4 ---------- */
  const clipHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const found = await resolveVideo(body)
      if (found.error) { respondJson(res, { ok: false, reason: found.error.reason }, found.error.status); return }
      const sel = resolveSelection(body)
      if (!sel.ok) { respondJson(res, { ok: false, reason: sel.reason }, 400); return }
      const tools = await detectTools()
      if (tools.ffmpeg === null) {
        respondJson(res, { ok: false, needFfmpeg: true, reason: '没找到 ffmpeg，截片段需要它；装一个并加进 PATH 即可' }, 503)
        return
      }
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const out = path.join(cfg.outputDir, makeClipName('dshqp-clip'))
      const durationSec = Math.max(0.04, sel.endSec - sel.startSec)
      await run(tools.ffmpeg, buildClipArgs({
        input: found.path, output: out, startSec: sel.startSec, durationSec,
        reencode: body?.reencode !== false,
      }))
      const st = await fsp.stat(out)
      log?.('info', `[选帧] 已截出片段：${out}（${durationSec.toFixed(2)} s）`)
      respondJson(res, {
        ok: true, path: out, bytes: st.size,
        startSec: sel.startSec, endSec: sel.endSec, durationSec,
        startFrame: sel.startFrame, endFrame: sel.endFrame, fps: sel.fps,
        warnings: sel.warnings,
      })
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  /* ---------- POST /replace-frame：把改好的一帧贴回原视频 ---------- */
  const replaceFrameHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const found = await resolveVideo(body)
      if (found.error) { respondJson(res, { ok: false, reason: found.error.reason }, found.error.status); return }

      const rawImage = String(body?.image ?? '').trim()
      if (rawImage === '') { respondJson(res, { ok: false, reason: 'image 必填（改好的那一帧图片）' }, 400); return }
      const imagePath = path.resolve(rawImage)
      if (!isInside(cfg.outputDir, imagePath)) {
        respondJson(res, { ok: false, reason: '改好的帧图片也必须在出图目录内' }, 400); return
      }
      try {
        const st = await fsp.stat(imagePath)
        if (!st.isFile()) throw new Error('not a file')
      } catch {
        respondJson(res, { ok: false, reason: '找不到这张改好的帧图片' }, 404); return
      }

      const sel = resolveReplaceFrame({ frame: body?.frame, fps: body?.fps })
      if (!sel.ok) { respondJson(res, { ok: false, reason: sel.reason }, 400); return }
      const tools = await detectTools()
      if (tools.ffmpeg === null) {
        respondJson(res, { ok: false, needFfmpeg: true, reason: '贴回这一帧需要 ffmpeg；装一个并加进 PATH 即可' }, 503)
        return
      }
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const out = path.join(cfg.outputDir, makeClipName('dshqp-replaced'))
      await run(tools.ffmpeg, buildReplaceFrameArgs({
        input: found.path, image: imagePath, output: out,
        startSec: sel.startSec, durationSec: sel.durationSec,
      }))
      const st = await fsp.stat(out)
      log?.('info', `[选帧] 已把第 ${sel.frame} 帧贴回：${out}`)
      respondJson(res, {
        ok: true, path: out, bytes: st.size, frame: sel.frame,
        startSec: sel.startSec, durationSec: sel.durationSec, fps: sel.fps,
      })
    } catch (error) {
      respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
    }
  }

  return { probeHandler, frameSaveHandler, frameHandler, clipHandler, replaceFrameHandler }
}

/**
 * 一次性把五个端点注册上去（含「改完的帧回贴」），返回 disposer 数组。
 * 放在这里是为了**别让 lib/index.js 继续膨胀**（DSH Store 单文件 256 KB 硬上限，
 * selftest.mjs 有断言）；host 那边只留一行调用。
 *
 * @param {(route:{kind:string,path:string,handler:Function})=>Function} register
 * @param {object} deps 同 makeVideoFrameHandlers
 * @returns {Function[]}
 */
export function registerVideoFrameRoutes(register, deps) {
  const h = makeVideoFrameHandlers(deps)
  return [
    register({ kind: 'exact', path: '/api/qwen-paint/video/probe', handler: h.probeHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/video/frame-save', handler: h.frameSaveHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/video/frame', handler: h.frameHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/video/clip', handler: h.clipHandler }),
    register({ kind: 'exact', path: '/api/qwen-paint/video/replace-frame', handler: h.replaceFrameHandler }),
  ]
}
