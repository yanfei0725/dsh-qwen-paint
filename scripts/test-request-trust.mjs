/**
 * 请求信任判定回归测试（2026-10-16 新增 · DSH STORE AUTH001 整改）
 *
 * ## 背景
 *   审核指出 `isLocalRequest` 只看 Host 和 socket 的本机地址、**缺失值也放行**，
 *   不检查 Origin / Sec-Fetch-Site ⇒ 来自其它网页、目标地址为本机的请求会被放行
 *   （confused deputy / CSRF）。整改后判定逻辑与官方 `api-request-trust.ts` 等价。
 *
 * ## 验收条件（审核原文）
 *   本机 socket／Host 配合 `Origin: https://untrusted.example` 或
 *   `Sec-Fetch-Site: cross-site` 的请求，**必须在读取私有数据、写配置或执行命令前被拒绝**；
 *   受信任的目标宿主请求正常；缺失信任上下文明确拒绝。
 *
 * 运行：node scripts/test-request-trust.mjs
 */
import { __internal } from '../lib/index.js'

const { isTrustedRequest, guardWriteRequest } = __internal

let pass = 0
let fail = 0
const fails = []

function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

/** 造一个"本机"请求（Host + socket 都回环）。 */
function req(headers = {}, remote = '127.0.0.1') {
  return { headers, socket: { remoteAddress: remote } }
}

console.log('[1] 正常放行（受信任的本机请求）')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188' })) === true, 'Host 回环 + 无 Origin → 放行')
ok(isTrustedRequest(req({ host: 'localhost:3000' })) === true, 'Host localhost + 无 Origin → 放行')
ok(isTrustedRequest(req({ host: '[::1]:8188' })) === true, 'Host [::1] → 放行')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', origin: 'http://127.0.0.1:8188' })) === true,
  'Host 回环 + 同源 Origin → 放行')
ok(isTrustedRequest(req({ host: 'localhost:3000', origin: 'http://localhost:3000' })) === true,
  'Host localhost:3000 + Origin 同源 → 放行')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', 'sec-fetch-site': 'same-origin' })) === true,
  'Sec-Fetch-Site: same-origin → 放行')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', 'sec-fetch-site': 'none' })) === true,
  'Sec-Fetch-Site: none（用户直接导航）→ 放行')

console.log('\n[2] 跨站 / 不可信 Origin —— 必须拒绝（AUTH001 核心）')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', origin: 'https://untrusted.example' })) === false,
  'Host 回环 + Origin https://untrusted.example → 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', 'sec-fetch-site': 'cross-site' })) === false,
  'Host 回环 + Sec-Fetch-Site: cross-site → 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:8188' })) === false,
  'cross-site 标记**压过**同源 Origin → 拒绝')
ok(isTrustedRequest(req({ host: 'localhost:3000', origin: 'http://localhost:9999' })) === false,
  'Origin 同主机但**端口不同** → 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', origin: 'null' })) === false,
  'Origin: null（沙箱 iframe / file:）→ 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188', origin: 'file:///etc/passwd' })) === false,
  'Origin: file:// → 拒绝')

console.log('\n[3] Host 围栏（防 DNS rebinding）')
ok(isTrustedRequest(req({})) === false, 'Host 缺失 → 拒绝（旧版这里是"缺失也放行"）')
ok(isTrustedRequest(req({ host: '' })) === false, 'Host 空串 → 拒绝')
ok(isTrustedRequest(req({ host: 'evil.example' })) === false, 'Host 非回环域名 → 拒绝')
ok(isTrustedRequest(req({ host: 'evil.example', origin: 'http://evil.example' })) === false,
  'Host 非回环 + 自洽 Origin → 仍拒绝')
ok(isTrustedRequest(req({ host: 'localhost.evil.com' })) === false,
  'Host localhost.evil.com（伪装）→ 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1.evil.com' })) === false,
  'Host 127.0.0.1.evil.com（伪装）→ 拒绝')

console.log('\n[4] socket 附加检查')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188' }, '10.0.0.5')) === false,
  'Host 回环但 socket 来自 10.0.0.5 → 拒绝')
ok(isTrustedRequest(req({ host: '127.0.0.1:8188' }, '::ffff:127.0.0.1')) === true,
  'socket ::ffff:127.0.0.1（IPv4 映射）→ 放行')

console.log('\n[5] 不抛异常（任何畸形输入都只回 false）')
for (const bad of [undefined, null, {}, { headers: null }, { headers: { host: 123 } }]) {
  let threw = false
  try { isTrustedRequest(bad) } catch { threw = true }
  ok(threw === false, `畸形输入 ${JSON.stringify(bad)} 不抛异常`)
}

console.log('\n[6] 回归锁：写状态必须走 POST（源码级）')
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const idx = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
  const cli = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

  // 服务端：GET 必须只读 —— 存在只读白名单 + 405 拒绝分支
  ok(/READ_ONLY_PARAMS\s*=\s*new Set\(\[[^\]]*\]\)/u.test(idx), '服务端有 READ_ONLY_PARAMS 只读白名单')
  ok(/写操作必须用 POST/u.test(idx), '服务端对 GET 带写参数会 405 拒绝')
  ok(/const queryLc = new Map\(\)[\s\S]{0,400}?if \(isWriteReq\)/u.test(idx),
    'queryLc 只在 POST 分支里填充（GET 时为空 ⇒ 所有写分支自然失效）')
  ok(/isTrustedRequest/u.test(idx) && /sec-fetch-site/u.test(idx), '服务端判定含 Sec-Fetch-Site 检查')

  // 客户端：不得再有"GET 带 query 写状态"的调用
  const badGet = cli.match(/fetch\(`[^`]*status\.json\?[^`]*`/gu) ?? []
  const offenders = badGet.filter((s) => !/ping=/u.test(s))
  ok(offenders.length === 0, `客户端无 GET 写调用（发现 ${offenders.length} 处）`)
  ok(/function postStatus\(/u.test(cli), '客户端有统一的 postStatus 写入口')
  ok(/method: 'POST'/u.test(cli), '客户端写请求用 POST')
  // 顺手修掉的那个真 bug：`${API}` 从未定义。
  // ⚠ 只查**代码用法**（fetch 模板串），注释里对这个 bug 的说明不算。
  ok(!/fetch\(`\$\{API\}/u.test(cli), '客户端不再用未定义的 `${API}` 发请求')
}

console.log('\n[7] 写入口守卫：错误方法 → 405、错误媒体类型 → 415')
{
  /** 造一个能捕获状态码的假 res（respondJson 只用 writeHead + end）。 */
  const mockRes = () => ({
    code: null,
    body: null,
    writeHead(c) { this.code = c },
    end(t) { this.body = t },
  })
  const run = (method, contentType) => {
    const res = mockRes()
    const headers = contentType === undefined ? {} : { 'content-type': contentType }
    const passed = guardWriteRequest({ method, headers }, res)
    return { passed, code: res.code, body: res.body }
  }

  // 方法不对 —— 必须在任何动作前 405
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const r = run(m, 'application/json')
    ok(r.passed === false && r.code === 405, `${m} + JSON → 405（不放行）`)
  }
  // 媒体类型不对 —— 415
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    const r = run('POST', ct)
    ok(r.passed === false && r.code === 415, `POST + ${ct || '(缺失)'} → 415`)
  }
  // 缺 Content-Type 也是 415
  ok(run('POST', undefined).code === 415, 'POST + 无 Content-Type → 415')
  // 正确请求放行
  ok(run('POST', 'application/json').passed === true, 'POST + application/json → 放行')
  ok(run('POST', 'application/json; charset=utf-8').passed === true, '带 charset 参数也放行')
  ok(run('post', 'Application/JSON').passed === true, '方法/类型大小写不敏感')
  // 405 响应要带 Allow 头（便于调用方纠正）
  ok(/POST/u.test(run('GET', 'application/json').body ?? ''), '405 响应体提示应使用 POST')
}

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
