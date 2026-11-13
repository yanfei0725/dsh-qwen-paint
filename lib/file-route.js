/**
 * lib/file-route.js —— 插件自己的**媒体字节路由** `/api/qwen-paint/file`。
 *
 * ## 为什么需要它
 *   内核 `/api/file?path=…` 只服务"**已登记**"的文件（deliverables）。
 *   `draw_image` 的产物走 `tools/result` 钩子登记，所以能显示；
 *   而**面板圈选重绘 / 图片编辑台 / 视频选帧**都是直接 `execute()` 出来的、没有登记
 *   ⇒ 用 `api/file?path=` 看结果，大概率是裂图（"图片无法预览"）。
 *   ✓ 正解：插件自己吐字节 —— 只服务 **outputDir 之内**的文件（路径包含检查），
 *     不依赖登记，也绕开了内核那道门。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 已贴着 DSH Store 的 256 KB 单文件上限（selftest.mjs 有硬断言）。
 *   这段是**自包含**的（只要 isLocalRequest / respondJson / cfg），外置零风险。
 *
 * ## 安全边界
 *   · 只收 GET / HEAD；只服务本机请求；
 *   · 路径解析后**必须仍落在 outputDir 内**（挡掉 `..` 穿越）；
 *   · 先 `stat` 再读：不是文件 → 404；超过 512 MB → 413（不再无脑 readFile 把内存吃光）；
 *   · `x-content-type-options: nosniff` + 未知扩展名回落 octet-stream：
 *     出图目录里万一混进 `.html` / `.svg`，也只会被**下载**，不会被当页面执行；
 *   · `content-security-policy: default-src 'none'; sandbox` 再兜一层。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 默认单文件上限：够放一段短视频，又不至于把进程内存吃穿。 */
export const MAX_SERVE_BYTES = 512 * 1024 * 1024

/** 扩展名 → MIME 白名单。**不在表里的一律 octet-stream**（不猜、不嗅探）。 */
export const MEDIA_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
}

/**
 * @param {object} deps
 * @param {(req:object)=>boolean} deps.isLocalRequest
 * @param {(res:object, body:object, status?:number)=>void} deps.respondJson
 * @param {object} deps.cfg 插件配置（用 `cfg.outputDir`）
 * @param {number} [deps.maxBytes] 覆盖默认上限（测试用）
 * @param {(level:string, msg:string)=>void} [deps.log] 本机日志（异常细节只进这里）
 * @returns {(req:object, res:object)=>Promise<void>}
 */
export function makeFileBytesHandler(deps) {
  const { isLocalRequest, respondJson, cfg, log } = deps
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : MAX_SERVE_BYTES

  return async function fileBytesHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondJson(res, { ok: false, reason: 'GET only' }, 405); return
    }
    if (!isLocalRequest(req)) {
      respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
    }
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const raw = String(u.searchParams.get('path') ?? '')
      if (raw === '') { respondJson(res, { ok: false, reason: 'path required' }, 400); return }
      const base = path.resolve(cfg.outputDir)
      const full = path.resolve(raw)
      // 路径包含检查：`..` 之类的穿越在这里被挡掉（解析后必须仍落在 outputDir 内）
      if (full !== base && !full.startsWith(base + path.sep)) {
        respondJson(res, { ok: false, reason: 'path 必须在出图目录内' }, 403); return
      }
      // 先看大小再读 —— 出图目录里现在会有 mp4，无脑 readFile 会把内存吃穿
      const st = await fsp.stat(full)
      if (!st.isFile()) { respondJson(res, { ok: false, reason: '不是文件' }, 404); return }
      if (st.size > maxBytes) {
        respondJson(res, { ok: false, reason: `文件太大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB），请直接从出图目录打开` }, 413)
        return
      }
      const bytes = await fsp.readFile(full)
      res.writeHead(200, {
        'content-type': MEDIA_MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
        'content-length': bytes.length,
        'cache-control': 'no-store',
        // 视频要能拖动进度条；这里明确告知不支持 Range（浏览器会整体缓冲后再 seek）
        'accept-ranges': 'none',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      // ★ 2026-11-13：只记本机日志，不回吐 error.message（可能带本机绝对路径）。
      log?.('warn', `媒体字节路由失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '文件暂不可读（详见插件日志）' }, 404)
    }
  }
}
