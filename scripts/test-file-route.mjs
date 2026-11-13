/**
 * /api/qwen-paint/file 媒体字节路由 —— 行为级离线回归
 *
 * 重点锁住：
 *  · 目录穿越被拒（`..`、绝对路径跑到 outputDir 外）
 *  · 只服务本机请求、只收 GET/HEAD
 *  · 大小上限生效（不再无脑 readFile 把内存吃穿）
 *  · 按扩展名给 MIME，未知一律 octet-stream；带 nosniff（防嗅探成 HTML 执行）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

function mkRes() {
  const r = { headers: {}, ended: false, body: null }
  r.writeHead = (code, headers) => { r.code = code; r.headers = headers }
  r.end = (b) => { r.ended = true; r.body = b }
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
const reqOf = (method, p) => ({ method, url: `/?path=${encodeURIComponent(p)}` })

/* 1. 正常吐字节 */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside), res)
  eq(res.code, 200, '正常取图 → 200')
  eq(res.headers['content-type'], 'image/png', 'png 的 MIME 正确')
  ok(Buffer.isBuffer(res.body) && res.body.length === 3, '字节完整返回')
}
/* 2. 安全响应头 */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', inside), res)
  eq(res.headers['x-content-type-options'], 'nosniff', '★ 带 nosniff（防嗅探成 HTML 执行）')
  ok(String(res.headers['content-security-policy'] ?? '').includes("default-src 'none'"), '★ 带 CSP 兜底')
  eq(res.headers['cache-control'], 'no-store', '不缓存')
}
/* 3. 视频 MIME */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', big), res)
  eq(res.headers['content-type'], 'video/mp4', '★ mp4 按 video/mp4 吐（否则 <video> 黑屏）')
}
/* 4. 未知扩展名不猜 */
{
  const f = path.join(tmp, 'x.html')
  fs.writeFileSync(f, '<script>alert(1)</script>')
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('GET', f), res)
  eq(res.headers['content-type'], 'application/octet-stream', '★★ .html 不当页面类型（回落 octet-stream）')
}
/* 5. 穿越被拒 */
{
  const { h, respond } = mkHandler()
  await h(reqOf('GET', outside), mkRes())
  eq(respond[0].status, 403, '★★ outputDir 外的路径 → 403')
  const { h: h2, respond: r2 } = mkHandler()
  await h2(reqOf('GET', path.join(tmp, '..', 'evil.png')), mkRes())
  eq(r2[0].status, 403, '★★ `..` 穿越 → 403')
}
/* 6. 目录 / 空路径 / 方法 */
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
/* 7. 大小上限 */
{
  const { h, respond } = mkHandler({ maxBytes: 1024 })
  await h(reqOf('GET', big), mkRes())
  eq(respond[0].status, 413, '★★ 超过上限 → 413（不读进内存）')
  ok(/太大/u.test(respond[0].body.reason), '理由说清是文件太大')
}
/* 8. HEAD 不回 body */
{
  const { h } = mkHandler()
  const res = mkRes()
  await h(reqOf('HEAD', inside), res)
  eq(res.code, 200, 'HEAD → 200')
  eq(res.body, undefined, 'HEAD 不回 body')
}
/* 9. 常量健全 */
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
