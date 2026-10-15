/**
 * net-guard 自测（纯 JS，不依赖网络/子进程 —— 沙箱会间歇性禁止 spawn，
 * 所以核心断言必须能独立跑通）。
 *
 * 覆盖：
 *   · isLoopbackUrl 放行/拒绝的各类地址
 *   · assertLocalUrl 的默认拒绝、allowRemote 放行、错误信息有效性
 *   · guardedFetch 是否真的强制 redirect:'error'（用桩替换全局 fetch）
 *   · filteredEnv 的代理/凭据剔除
 *
 * 运行：node scripts/test-net-guard.mjs
 */
import { isLoopbackUrl, assertLocalUrl, guardedFetch, filteredEnv } from '../lib/net-guard.js'

let pass = 0
let fail = 0
const fails = []

function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}
function eq(actual, expected, label) {
  const c = actual === expected
  if (!c) console.log(`      实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
  ok(c, label)
}

console.log('\n[1] isLoopbackUrl —— 应当放行')
for (const u of [
  'http://127.0.0.1:8188',
  'http://127.0.0.1',
  'https://127.0.0.1:8188',
  'http://localhost:8188',
  'http://LOCALHOST:8188',
  'http://[::1]:8188',
  'http://127.0.0.2:8188',
  'http://0.0.0.0:8188',
]) {
  ok(isLoopbackUrl(u).ok, `放行 ${u}`)
}

console.log('\n[2] isLoopbackUrl —— 应当拒绝')
for (const u of [
  'http://192.168.1.100:8188',
  'http://10.0.0.5:8188',
  'http://172.16.3.4:8188',
  'http://169.254.1.1:8188',
  'http://example.com:8188',
  'http://comfy.mydomain.net',
  'http://localhost.evil.com:8188',   // ★ 伪装成 localhost 的域名，必须拒绝
  'http://127.0.0.1.evil.com:8188',
  'ftp://127.0.0.1:21',
  'file:///etc/passwd',
  'not a url',
  '',
  null,
  undefined,
]) {
  ok(!isLoopbackUrl(u).ok, `拒绝 ${JSON.stringify(u)}`)
}

console.log('\n[3] assertLocalUrl —— 默认拒绝非回环')
{
  let threw = null
  try { assertLocalUrl('http://192.168.1.100:8188') } catch (e) { threw = e }
  ok(threw !== null, '非回环地址抛错')
  ok(threw && /127\.0\.0\.1/.test(threw.message), '错误信息提示了正确做法')
  ok(threw && /allowRemoteComfy/.test(threw.message), '错误信息提到 opt-in 开关')

  // 回环地址不抛错，且返回 URL 对象
  const u = assertLocalUrl('http://127.0.0.1:8188')
  ok(u instanceof URL, '回环地址返回 URL 对象')
  eq(u.port, '8188', '端口解析正确')
}

console.log('\n[4] assertLocalUrl —— allowRemote 显式放行')
{
  let threw = null
  let logged = false
  try {
    assertLocalUrl('http://192.168.1.100:8188', { allowRemote: true, log: () => { logged = true } })
  } catch (e) { threw = e }
  ok(threw === null, 'allowRemote=true 时不抛错')
  ok(logged, '放行时留了日志（可追溯）')

  // 但协议仍必须是 http/https
  let t2 = null
  try { assertLocalUrl('ftp://192.168.1.100', { allowRemote: true }) } catch (e) { t2 = e }
  ok(t2 !== null, 'allowRemote 也不放行非 http/https 协议')
}

console.log('\n[5] guardedFetch —— 强制 redirect:error')
{
  const realFetch = globalThis.fetch
  let seenInit = null
  let seenUrl = null
  globalThis.fetch = async (url, init) => { seenUrl = url; seenInit = init; return { ok: true } }

  await guardedFetch('http://127.0.0.1:8188/system_stats', { method: 'GET' })
  eq(seenUrl, 'http://127.0.0.1:8188/system_stats', 'URL 原样透传')
  eq(seenInit && seenInit.redirect, 'error', 'redirect 被强制为 error')
  eq(seenInit && seenInit.method, 'GET', '其它 init 字段保留')

  // 调用方就算硬写 redirect:'follow' 也会被覆盖
  await guardedFetch('http://127.0.0.1:8188/x', { redirect: 'follow' })
  eq(seenInit && seenInit.redirect, 'error', '调用方传入的 redirect:follow 被覆盖')

  // 非回环地址：根本不发请求
  let before = seenUrl
  let threw = null
  try { await guardedFetch('http://192.168.1.100:8188/x') } catch (e) { threw = e }
  ok(threw !== null, '非回环地址的 guardedFetch 抛错')
  eq(seenUrl, before, '非回环地址根本不会发出请求')

  globalThis.fetch = realFetch
}

console.log('\n[6] filteredEnv —— 剔除代理与凭据，保留系统键')
{
  const saved = {}
  const injected = {
    HTTP_PROXY: 'http://127.0.0.1:54536',
    HTTPS_PROXY: 'http://127.0.0.1:54536',
    GITHUB_TOKEN: 'ghp_xxxx',
    MY_API_KEY: 'sk-xxxx',
    DB_PASSWORD: 'hunter2',
    AWS_SECRET_ACCESS_KEY: 'yyyy',
    DSH_SESSION: 'abc',
    HIPFIRE_HOME: '/opt/hipfire',
  }
  for (const [k, v] of Object.entries(injected)) { saved[k] = process.env[k]; process.env[k] = v }
  try {
    const env = filteredEnv()
    ok(!('HTTP_PROXY' in env), 'HTTP_PROXY 被剔除')
    ok(!('HTTPS_PROXY' in env), 'HTTPS_PROXY 被剔除')
    ok(!('GITHUB_TOKEN' in env), 'GITHUB_TOKEN 被剔除')
    ok(!('MY_API_KEY' in env), 'MY_API_KEY 被剔除')
    ok(!('DB_PASSWORD' in env), 'DB_PASSWORD 被剔除')
    ok(!('AWS_SECRET_ACCESS_KEY' in env), 'AWS_SECRET_ACCESS_KEY 被剔除')
    eq(env.DSH_SESSION, 'abc', 'DSH_ 前缀非敏感键保留')
    eq(env.HIPFIRE_HOME, '/opt/hipfire', 'HIPFIRE_HOME 保留（功能必需）')
    // ⚠ Windows 上 process.env 的键名大小写不统一，必须大小写不敏感地查
    if (process.platform === 'win32') {
      const has = (n) => Object.keys(env).some((k) => k.toLowerCase() === n.toLowerCase())
      ok(has('SystemRoot'), 'Windows 保留 SystemRoot')
      ok(has('windir'), 'Windows 保留 windir')
      ok(has('ComSpec'), 'Windows 保留 ComSpec')
    }
    // 额外注入生效
    const env2 = filteredEnv({ EXTRA: '1' })
    eq(env2.EXTRA, '1', 'extra 参数注入生效')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
