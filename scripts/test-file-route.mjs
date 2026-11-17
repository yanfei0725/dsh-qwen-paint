/**
 * /api/qwen-paint/file 媒体字节路由 —— 行为级离线回归
 *
 * 重点锁住：
 *  · 目录穿越被拒（`..`、绝对路径跑到 outputDir 外、junction/realpath 越界）
 *  · 只服务本机请求、只收 GET/HEAD
 *  · 大小上限生效（流式化后仍保留 413 契约）
 *  · 按扩展名给 MIME，未知一律 octet-stream；带 nosniff（防嗅探成 HTML 执行）
 *  · ★ 2026-11-18 审计：流式响应（Writable 夹具）+ Range 206 + 媒体可变长缓存
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { makeFileBytesHandler, MEDIA_MIME, MAX_SERVE_BYTES } from '../lib/file-route.js'

let passed = 0
const failures = []
const ok = (cond, msg) => { if (cond) { passed += 1; console.log(`✓ ${msg}`) } else failures.push(msg) }
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-fr-'))
const inside = path.join(tmp, 'a.png')
fs.writeFileSync(inside, Buffer.from('PNG'))
const big = path.join(tmp, 'big.mp4')
fs.writeFileSync(big, Buffer.alloc(2048))
const outside = path.join(os.tmpdir(), 'dshqp-fr-outside.txt')
fs.writeFileSync(outside, 'x')
const dir = path.join(tmp, 'sub')
fs.mkdirSync(dir)

/** 流式响应夹具：真 Writable，捕获写入的字节（与 http.ServerResponse 同形的最小面）。 */
function mkRes() {
  const chunks = []
  const writable = new Writable({
    write(c, e, cb) { chunks.push(c); cb() },
    final(cb) { r.ended = true; cb() },
    destroy(err, cb) { cb?.() },
  })
  const r = Object.assign(writable, { headers: {}, ended: false })
  const origEnd = writable.end.bind(writable)
  r.writeHead = (code, headers) => { r.code = code; r.headers = headers }
  r.end = (b) => { if (b) chunks.push(b); origEnd() }
  Object.defineProperty(r, 'body', {
    get() { return chunks.length ? Buffer.concat(chunks) : null },
  })
  return r
}
function mkHandler(opts = {}) {
  const respond = []
  const h = makeFileBytesHandler({
    isLocalRequest: () => opts.local !== false,
    respondJson: (res, body, status) => respond.push({ body, status: status ?? 200 }),
    cfg: { outputDir: tmp },
    maxBytes: opts.maxBytes,
  })
  return { h, respond }
}
const reqOf = (method, p, headers = undefined) => ({ method, url: `/?path=${encodeURIComponent(p)}`, ...(headers ? { headers } : {}) })

/* 1. 正常吐字节（流式，Writable 捕获） */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside), res)
  eq(res.code, 200, '正常取图 → 200')
  eq(res.headers['content-type'], 'image/png', 'png 的 MIME 正确')
  ok(Buffer.isBuffer(res.body) && res.body.length === 3 && res.body.toString() === 'PNG', '字节完整返回（流式写入）')
}
/* 2. 安全响应头 + 媒体缓存（2026-11-18：生成文件名不可变 → 媒体可缓存） */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside), res)
  eq(res.headers['x-content-type-options'], 'nosniff', '★ 带 nosniff（防嗅探成 HTML 执行）')
  ok(String(res.headers['content-security-policy'] ?? '').includes("default-src 'none'"), '★ 带 CSP 兜底')
  eq(res.headers['cache-control'], 'private, max-age=86400', '★ 已知媒体类型可缓存（历史面板不再逐图重传）')
  eq(res.headers['accept-ranges'], 'bytes', '★ 支持字节段（视频 seek 不再整体缓冲）')
}
/* 2b. 未知类型保守 no-store（不猜不缓存） */
{
  const f = path.join(tmp, 'x.html')
  fs.writeFileSync(f, '<script>alert(1)</script>')
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', f), res)
  eq(res.headers['content-type'], 'application/octet-stream', '★★ .html 不当页面类型（回落 octet-stream）')
  eq(res.headers['cache-control'], 'no-store', '★ octet-stream 保守 no-store')
}
/* 3. 视频 MIME */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', big), res)
  eq(res.headers['content-type'], 'video/mp4', '★ mp4 按 video/mp4 吐（否则 <video> 黑屏）')
}
/* 3b. Range：单段 206 */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside, { range: 'bytes=1-2' }), res)
  eq(res.code, 206, 'Range 单段 → 206')
  eq(res.headers['content-range'], 'bytes 1-2/3', 'Content-Range 正确')
  ok(res.body && res.body.toString() === 'NG', 'Range 字节段正确')
}
/* 3c. Range：后缀 -2 */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside, { range: 'bytes=-2' }), res)
  eq(res.code, 206, '后缀 Range → 206')
  ok(res.body && res.body.toString() === 'NG', '后缀字节段正确')
}
/* 3d. Range：越界 → 416 */
{
  const { h, respond } = mkHandler()
  await h(reqOf('GET', inside, { range: 'bytes=99-' }), mkRes())
  eq(respond[0]?.status, 416, '★ start 越界 → 416')
  ok(/越界/u.test(String(respond[0]?.body?.reason ?? '')), '416 理由带文件大小')
  const { h: h2 } = mkHandler()
  const res2 = mkRes()
  await h2(reqOf('GET', inside, { range: 'bytes=abc-def' }), res2)
  eq(res2.code, 200, '畸形 Range 忽略（回全量 200，浏览器可处理）')
}
/* 4. 穿越被拒 */
{
  const { h, respond } = mkHandler()
  await h(reqOf('GET', outside), mkRes())
  eq(respond[0].status, 403, '★★ outputDir 外的路径 → 403')
  const { h: h2, respond: r2 } = mkHandler()
  await h2(reqOf('GET', path.join(tmp, '..', 'evil.png')), mkRes())
  eq(r2[0].status, 403, '★★ `..` 穿越 → 403')
}
/* 5. 目录 / 空路径 / 方法 */
{
  const { h, respond } = mkHandler()
  await h(reqOf('GET', dir), mkRes())
  eq(respond[0].status, 404, '目录不是文件 → 404')

  const { h: h2, respond: r2 } = mkHandler()
  await h2({ method: 'GET', url: '/' }, mkRes())
  eq(r2[0].status, 400, '缺 path → 400')

  const { h: h3, respond: r3 } = mkHandler()
  await h3({ method: 'POST', url: '/?path=x' }, mkRes())
  eq(r3[0].status, 405, 'POST → 405（只读路由）')

  const { h: h4, respond: r4 } = mkHandler({ local: false })
  await h4(reqOf('GET', inside), mkRes())
  eq(r4[0].status, 403, '★ 非本机请求 → 403')
}
/* 6. 大小上限 */
{
  const { h, respond } = mkHandler({ maxBytes: 1024 })
  await h(reqOf('GET', big), mkRes())
  eq(respond[0].status, 413, '★★ 超过上限 → 413（流式化后仍保留契约）')
  ok(/太大/u.test(respond[0].body.reason), '理由说清是文件太大')
}
/* 7. HEAD 不回 body */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('HEAD', inside), res)
  eq(res.code, 200, 'HEAD → 200')
  eq(res.headers['content-length'], 3, 'HEAD 带 content-length')
  ok(res.body === null, 'HEAD 不回 body')
}
/* 8. 常量健全 */
{
  ok(MEDIA_MIME['.png'] === 'image/png' && MEDIA_MIME['.mp4'] === 'video/mp4', 'MIME 白名单含图与视频')
  ok(MEDIA_MIME['.svg'] === undefined, '★ 白名单里没有 svg（svg 可带脚本）')
  ok(MAX_SERVE_BYTES === 512 * 1024 * 1024, '默认上限 512 MB')
}

fs.rmSync(tmp, { recursive: true, force: true })
try { fs.unlinkSync(outside) } catch { /* 无所谓 */ }

console.log(`\ntest-file-route: ${passed} 项断言通过${failures.length ? `，${failures.length} 项失败` : ''}`)
for (const f of failures) console.error(`  ✗ ${f}`)
if (failures.length) process.exit(1)
