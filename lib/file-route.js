// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-file-route
import fsp from 'node:fs/promises'
import fs from 'node:fs'
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
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
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
      // ★ 2026-11-17 审计：junction 可穿透文本前缀围栏（实测穿透读），realpath 复验。
      //   走到这文件必已存在（stat 过了），直接对文件与根各做一次 realpath 比对。
      const [realFull, realBase] = await Promise.all([fsp.realpath(full), fsp.realpath(base)])
      if (!(realFull === realBase || realFull.startsWith(realBase + path.sep))) {
        respondJson(res, { ok: false, reason: 'path 必须在出图目录内（链接目标越界）' }, 403)
        return
      }
      if (st.size > maxBytes) {
        respondJson(res, { ok: false, reason: `文件太大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB），请直接从出图目录打开` }, 413)
        return
      }
      // ★ 2026-11-18 审计（第二轮 N1/P2-5）：流式 + Range + 媒体缓存。
      //   ① 此前 readFile 整读——512MB 上限内的 mp4 照样整体进进程内存，并发请求叠加；
      //   ② 全量 no-store 让历史面板每次打开都重传所有缩略图/视频。生成文件名经
      //      uniquePath 永不复用（内容不可变）→ 已知媒体 MIME 可安全缓存；未知类型
      //      （octet-stream）保守 no-store。文本类脚本的 no-store 在 asset-route（有
      //      事故注释背书），本文件此前无背书，属未审视的历史遗留而非刻意。
      const mime = MEDIA_MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream'
      const cacheable = /^(image|video|audio)\//u.test(mime)
      const baseHeaders = {
        'content-type': mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': cacheable ? 'private, max-age=86400' : 'no-store',
        'accept-ranges': 'bytes',
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...baseHeaders, 'content-length': st.size })
        res.end()
        return
      }
      // Range：只支持单段 bytes（浏览器 seek 都是单段）；多段/其它单位直接回全量 200。
      let start = 0
      let end = st.size - 1
      let code = 200
      const rangeHeader = String(req.headers?.range ?? '').trim()
      const rm = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader)
      if (rm && (rm[1] !== '' || rm[2] !== '')) {
        if (rm[1] === '') {
          const n = Number(rm[2])
          if (!(n > 0)) {
            respondJson(res, { ok: false, reason: `Range 起点越界（文件共 ${st.size} 字节）` }, 416); return
          }
          start = Math.max(0, st.size - n)
        } else {
          start = Number(rm[1])
          end = rm[2] === '' ? st.size - 1 : Math.min(Number(rm[2]), st.size - 1)
        }
        if (start > end) {
          respondJson(res, { ok: false, reason: `Range 起点越界（文件共 ${st.size} 字节）` }, 416); return
        }
        code = 206
      }
      res.writeHead(code, {
        ...baseHeaders,
        'content-length': end - start + 1,
        ...(code === 206 ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
      })
      // 流式：内存峰值从"整个文件"降到流缓冲水位；视频 seek 只读所需字节段。
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(full, { start, end })
        rs.on('error', reject)
        res.on('close', resolve)   // 客户端中途断开也算完成（半截下载是常态）
        rs.on('end', resolve)
        rs.pipe(res)
      }).catch((error) => {
        // ★ 2026-11-13：只记本机日志，不回吐 error.message（可能带本机绝对路径）。
        log?.('warn', `媒体字节路由失败：${error?.message ?? error}`)
        try { respondJson(res, { ok: false, reason: '文件暂不可读（详见插件日志）' }, 404) } catch { /* 头已发出就只能断开 */ }
      })
    } catch (error) {
      // ★ 2026-11-13：只记本机日志，不回吐 error.message（可能带本机绝对路径）。
      log?.('warn', `媒体字节路由失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '文件暂不可读（详见插件日志）' }, 404)
    }
  }
}
