#!/usr/bin/env node
/**
 * test-reference-web.mjs —— 联网参考图「硬同意门」离线回归。
 *
 * 纯 JS + 注入 fetchFn：全程不真联网、不派生子进程、不下载任何图片字节、
 * 不生成任何图片/视频。沙箱间歇性禁止 spawn 或禁止出站时本套件仍可独立跑通。
 *
 * 重点锁住的契约：
 *   · 默认拒绝：没有逐请求 consent:true 时连端点都不解析、fetch 一次都不调
 *   · ★ query plumbing：首参 query 必须真正进同意门（/reference/search 的真实调用形状）
 *   · 端点 SSRF：https 强制、占位符拒绝、内嵌凭据拒绝、IPv4 / IPv6 私网全拒
 *   · 载荷白名单：只发 query / limit / media，不夹带 prompt / seed / 本机路径 / 凭据
 *   · 候选过滤：非 http(s) / 内网 / 伪装域名 / 重复项一律剔除
 *   · 只返回候选 URL，不自动下载图片字节
 *
 * 运行：node scripts/test-reference-web.mjs
 */
import {
  WEB_ENDPOINT_PLACEHOLDER, CONSENT_REQUIRED, ENDPOINT_REQUIRED, ENDPOINT_UNSAFE, QUERY_REQUIRED,
  checkSearchEndpoint, assertWebConsent, buildSearchPayload, buildSearchRequest,
  normalizeCandidates, fetchReferenceCandidates, describeWebReference,
} from '../lib/reference-web.js'

let pass = 0
let fail = 0
const fails = []

function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}
function eq(actual, expected, label) {
  const c = actual === expected
  if (!c) console.log(`      实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
  ok(c, label)
}
function deep(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) console.log(`      实际=${a} 期望=${b}`)
  ok(a === b, label)
}

const EP = 'https://search.example.com/api'
const GOOD = { consent: true, endpoint: EP, limit: 4 }

// 全局护栏：整个套件不得触发真实 fetch。所有用例都显式注入 fetchFn。
const realFetch = globalThis.fetch
let realFetchCalls = 0
globalThis.fetch = async () => { realFetchCalls += 1; throw new Error('本套件禁止真实联网') }

console.log('\n[1] 常量与能力披露')
eq(WEB_ENDPOINT_PLACEHOLDER, '<API_ENDPOINT>', '端点占位符固定')
eq(CONSENT_REQUIRED, 'CONSENT_REQUIRED', '同意门错误码')
eq(ENDPOINT_REQUIRED, 'ENDPOINT_REQUIRED', '端点缺失错误码')
eq(ENDPOINT_UNSAFE, 'ENDPOINT_UNSAFE', '端点不安全错误码')
eq(QUERY_REQUIRED, 'QUERY_REQUIRED', '查询词缺失错误码')
const desc = describeWebReference()
eq(desc.consent, 'per-request-explicit', '★ 同意是逐请求显式，不是全局开关')
eq(desc.defaultAction, 'deny', '★ 默认动作是拒绝')
deep(desc.outboundFields, ['query', 'limit', 'media'], '对外披露的出站字段与实现一致')
eq(desc.endpointPlaceholder, WEB_ENDPOINT_PLACEHOLDER, '披露占位符')
ok(desc.note.includes('每次显式同意'), '说明里明写每次显式同意')
ok(desc.note.includes('不自动下载图片字节'), '说明里明写不自动下载图片字节')

console.log('\n[2] 硬同意门：默认拒绝，且同意判在最前')
const denyCases = [
  ['完全不传 consent', {}],
  ['consent:false', { consent: false }],
  ['consent:"true" 字符串', { consent: 'true' }],
  ['consent:1', { consent: 1 }],
  ['consent:null', { consent: null }],
]
for (const [label, opts] of denyCases) {
  const g = assertWebConsent({ ...opts, endpoint: EP, query: '角色设定图' })
  eq(g.ok, false, `默认拒绝：${label}`)
  eq(g.code, CONSENT_REQUIRED, `拒绝码正确：${label}`)
}
const order = assertWebConsent({ endpoint: 'http://127.0.0.1/', query: 'x' })
eq(order.code, CONSENT_REQUIRED, '★ 同意门在最前：不同意时连端点都不解析（即便端点恶意）')
const reqDeny = buildSearchRequest('角色设定图', { endpoint: EP })
eq(reqDeny.ok, false, 'buildSearchRequest 不同意时不构造请求')
eq(reqDeny.url, undefined, '不同意时没有 url')
eq(reqDeny.init, undefined, '不同意时没有 init')
let denyCalls = 0
const denied = await fetchReferenceCandidates('角色设定图', { endpoint: EP }, {
  fetchFn: async () => { denyCalls += 1; return { ok: true, json: async () => ({}) } },
})
eq(denied.code, CONSENT_REQUIRED, 'fetchReferenceCandidates 默认拒绝')
eq(denyCalls, 0, '★ 没同意 → fetch 一次都没调用')
eq(denied.count, 0, '拒绝时候选数 0')
deep(denied.candidates, [], '拒绝时候选列表为空')

console.log('\n[3] checkSearchEndpoint —— 端点必须外部 https，SSRF 全拒')
const unsafeEndpoints = [
  ['占位符未替换', WEB_ENDPOINT_PLACEHOLDER, ENDPOINT_REQUIRED],
  ['空串', '', ENDPOINT_REQUIRED],
  ['undefined', undefined, ENDPOINT_REQUIRED],
  ['非字符串', 123, ENDPOINT_REQUIRED],
  ['非 URL 文本', 'search.example.com/api', ENDPOINT_UNSAFE],
  ['file 协议', 'file:///etc/passwd', ENDPOINT_UNSAFE],
  ['http 明文', 'http://search.example.com/api', ENDPOINT_UNSAFE],
  ['内嵌用户名/密码', 'https://user:pw@search.example.com/api', ENDPOINT_UNSAFE],
  ['回环 IPv4', 'https://127.0.0.1:8188/search', ENDPOINT_UNSAFE],
  ['localhost', 'https://localhost/search', ENDPOINT_UNSAFE],
  ['localhost. 尾点 FQDN', 'https://localhost./search', ENDPOINT_UNSAFE],
  ['大写 LOCALHOST. 尾点', 'https://LOCALHOST./search', ENDPOINT_UNSAFE],
  ['localhost.evil.com 前缀伪装', 'https://localhost.evil.com/search', ENDPOINT_UNSAFE],
  ['127.0.0.1.evil.com 前缀伪装', 'https://127.0.0.1.evil.com/search', ENDPOINT_UNSAFE],
  ['10/8 私网', 'https://10.0.0.1/', ENDPOINT_UNSAFE],
  ['192.168/16 私网', 'https://192.168.1.1/', ENDPOINT_UNSAFE],
  ['172.16/12 私网下界', 'https://172.16.0.1/', ENDPOINT_UNSAFE],
  ['172.16/12 私网上界', 'https://172.31.255.255/', ENDPOINT_UNSAFE],
  ['云元数据 169.254.169.254', 'https://169.254.169.254/latest/meta-data/', ENDPOINT_UNSAFE],
  ['云元数据域名', 'https://metadata.google.internal/', ENDPOINT_UNSAFE],
  ['0.0.0.0', 'https://0.0.0.0/', ENDPOINT_UNSAFE],
  ['IPv6 回环', 'https://[::1]/', ENDPOINT_UNSAFE],
  ['IPv6 未指定 ::', 'https://[::]/', ENDPOINT_UNSAFE],
  ['IPv6 ULA fd00', 'https://[fd00::1]/', ENDPOINT_UNSAFE],
  ['IPv6 ULA fc00', 'https://[fc00::1]/', ENDPOINT_UNSAFE],
  ['IPv6 链路本地 fe80', 'https://[fe80::1]/', ENDPOINT_UNSAFE],
  ['IPv6 链路本地 febf', 'https://[febf::1]/', ENDPOINT_UNSAFE],
  ['IPv6 站点本地 fec0', 'https://[fec0::1]/', ENDPOINT_UNSAFE],
  ['IPv4-mapped 回环', 'https://[::ffff:7f00:1]/', ENDPOINT_UNSAFE],
  ['十进制整数 IPv4', 'https://2130706433/', ENDPOINT_UNSAFE],
  ['八进制 IPv4', 'https://0177.0.0.1/', ENDPOINT_UNSAFE],
  ['十六进制 IPv4', 'https://0x7f000001/', ENDPOINT_UNSAFE],
  ['短写 IPv4', 'https://127.1/', ENDPOINT_UNSAFE],
]
for (const [label, raw, code] of unsafeEndpoints) {
  const g = checkSearchEndpoint(raw)
  eq(g.ok, false, `拒绝端点：${label}`)
  eq(g.code, code, `拒绝码：${label}`)
}
for (const [raw, host] of [
  ['https://2130706433/', '127.0.0.1'], ['https://0177.0.0.1/', '127.0.0.1'],
  ['https://0x7f000001/', '127.0.0.1'], ['https://127.1/', '127.0.0.1'],
]) eq(new URL(raw).hostname, host, `WHATWG 规范化兜底依据：${raw}`)
for (const raw of [
  EP,
  'https://api.example.com:8443/v1/search?q=x',
  'https://172.32.0.1/',          // 172.32 不在 172.16/12 内，不误伤
  'https://8.8.8.8/',
  'https://[2001:db8::1]/',        // 公网 IPv6 2000::/3，不误伤
]) eq(checkSearchEndpoint(raw).ok, true, `合法端点放行：${raw}`)
eq(checkSearchEndpoint(EP).url.toString(), EP, '校验成功时回传 URL 对象')

console.log('\n[4] ★ query plumbing —— 首参必须真正进同意门')
// 这正是 /reference/search 端点的调用形状：首参带 query，opts 里没有 query。
const reqGood = buildSearchRequest('角色设定图', GOOD)
eq(reqGood.ok, true, '★ 端点真实调用形状必须通过同意门')
eq(reqGood.query, '角色设定图', '请求描述回显首参查询词')
eq(JSON.parse(reqGood.init.body).query, '角色设定图', '出站载荷里是首参查询词')
let captured = null
const hit = await fetchReferenceCandidates('角色设定图', GOOD, {
  fetchFn: async (url, init) => {
    captured = { url, init }
    return { ok: true, json: async () => ({ results: [{ url: 'https://cdn.example.com/a.png' }] }) }
  },
})
eq(hit.ok, true, '端到端检索成功')
eq(hit.query, '角色设定图', '返回值 query 是首参，不是空值')
eq(hit.count, 1, '候选数正确')
eq(captured.url, EP, '请求打到配置的端点')
eq(JSON.parse(captured.init.body).query, '角色设定图', '实际请求体带上了查询词')
eq(buildSearchRequest('首参', { ...GOOD, query: '显式' }).query, '显式', 'opts.query 显式给出时优先（兼容两种调用形状）')
for (const q of ['', '   ', undefined, null, 123]) {
  eq(buildSearchRequest(q, GOOD).code, QUERY_REQUIRED, `空/非法查询词拒绝：${JSON.stringify(q)}`)
}
let emptyCalls = 0
await fetchReferenceCandidates('', GOOD, {
  fetchFn: async () => { emptyCalls += 1; return { ok: true, json: async () => ({}) } },
})
eq(emptyCalls, 0, '空查询词时 fetch 零调用')
const longQ = '  ' + 'x'.repeat(300) + '  '
const trimmed = buildSearchRequest(longQ, GOOD)
eq(trimmed.query.length, 200, '查询词 trim 后截断到 200 字')
ok(!trimmed.query.startsWith(' '), '查询词已去首尾空白')

console.log('\n[5] 载荷白名单与请求构造')
const payload = JSON.parse(reqGood.init.body)
deep(Object.keys(payload).sort(), ['limit', 'media', 'query'], '★ 出站载荷只含三个白名单字段')
eq(payload.media, 'image', '明确只要图片候选')
eq(payload.limit, 4, 'limit 按请求值')
eq(reqGood.init.method, 'POST', '请求方法 POST')
eq(reqGood.init.redirect, 'error', '★ 不跟随重定向（302 到内网 = 越界，直接失败）')
deep(Object.keys(reqGood.init.headers), ['Content-Type'], '请求头只有 Content-Type')
const dirty = {
  ...GOOD,
  prompt: 'PRIVATE_PROMPT', seed: 42, localPath: 'C:/secret/file.png',
  token: 'PRIVATE_TOKEN', headers: { Authorization: 'Bearer PRIVATE_TOKEN' },
}
const dirtyPayload = JSON.stringify(buildSearchRequest('角色设定图', dirty).init)
for (const word of ['PRIVATE_PROMPT', 'PRIVATE_TOKEN', 'secret', 'Authorization', '42']) {
  ok(!dirtyPayload.includes(word), `★ 调用方夹带的 ${word} 绝不进入出站请求`)
}
deep(Object.keys(buildSearchRequest('角色设定图', dirty).init.headers), ['Content-Type'], '夹带的 Authorization 头被丢弃')
for (const [v, want] of [
  [0, 1], [1, 1], [16, 16], [99, 16], [-5, 1], [3.7, 3],
  [undefined, 6], ['8', 6], [null, 6], [Number.NaN, 6],
]) eq(buildSearchPayload('q', { limit: v }).limit, want, `limit clamp：${JSON.stringify(v)} → ${want}`)
eq(buildSearchPayload('  q  ').query, 'q', 'buildSearchPayload 也做 trim')

console.log('\n[6] normalizeCandidates —— 候选 URL 过滤')
const mixed = [
  'https://cdn.example.com/a.png',
  'not-a-url',
  'ftp://cdn.example.com/b.png',
  'javascript:alert(1)',
  'http://127.0.0.1/internal.png',
  'https://localhost./x.png',
  'https://localhost.evil.com/x.png',
  'https://[fd00::1]/x.png',
  'https://user:pw@cdn.example.com/leak.png',
  { url: 'https://cdn.example.com/c.png', title: 'C', source: 'S' },
  { image: 'https://cdn.example.com/d.png' },
  { link: 'https://cdn.example.com/e.png' },
  { url: 'https://cdn.example.com/a.png' },
  { results: ['https://cdn.example.com/f.png'] },
  { items: [{ url: 'https://cdn.example.com/g.png' }] },
  { data: { results: ['https://cdn.example.com/h.png'] } },
  { candidates: ['https://cdn.example.com/i.png'] },
]
const norm = normalizeCandidates(mixed)
// 合法候选是 a/c/d/e/f/g/h/i 共 8 个：第 13 项 a.png 是重复项，必须被去重。
eq(norm.length, 8, '去重后 8 个合法候选，其余全部剔除')
deep(norm.map((c) => c.url.slice('https://cdn.example.com/'.length)).sort(),
  ['a.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'h.png', 'i.png'],
  '★ 各种响应形状（url/image/link/results/items/data/candidates）都被正确提取')
ok(norm.every((c) => c.url.startsWith('https://cdn.example.com/')), '★ 内网 / 伪装域名 / 非 http(s) / 内嵌凭据全部被剔除')
eq(new Set(norm.map((c) => c.url)).size, norm.length, '★ 重复 URL 去重')
ok(norm.every((c) => typeof c.url === 'string' && typeof c.title === 'string' && typeof c.source === 'string'),
  '每条候选字段形状一致')
const capped = normalizeCandidates([{
  url: 'https://cdn.example.com/x.png', title: 'T'.repeat(300), source: 'S'.repeat(200),
}])
eq(capped[0].title.length, 120, 'title 截断到 120')
eq(capped[0].source.length, 80, 'source 截断到 80')
deep(normalizeCandidates(null), [], 'null → 空列表')
deep(normalizeCandidates(undefined), [], 'undefined → 空列表')
deep(normalizeCandidates({ results: null }), [], '空 results → 空列表')
deep(normalizeCandidates('https://cdn.example.com/x.png'),
  [{ url: 'https://cdn.example.com/x.png', title: '', source: '' }], '裸字符串响应形状也支持')

console.log('\n[7] fetchReferenceCandidates —— 注入 fetch 的各分支')
const savedFetch = globalThis.fetch
globalThis.fetch = undefined
const noFetch = await fetchReferenceCandidates('q', GOOD)
eq(noFetch.code, 'NO_FETCH', '没有 fetch 实现时明确报 NO_FETCH')
eq(noFetch.count, 0, 'NO_FETCH 时候选数 0')
globalThis.fetch = savedFetch

const httpErr = await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async () => ({ ok: false, status: 503 }),
})
eq(httpErr.code, 'HTTP_ERROR', 'HTTP 失败 → HTTP_ERROR')
ok(httpErr.reason.includes('503'), '错误信息带上状态码')
deep(httpErr.candidates, [], 'HTTP 失败时候选为空')
const threw = await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async () => { throw new Error('boom') },
})
eq(threw.code, 'FETCH_FAILED', 'fetch 抛异常 → FETCH_FAILED（不向上冒泡）')
ok(threw.reason.includes('boom'), '异常原因如实保留')
const textRes = await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async () => ({ ok: true, text: async () => '["https://cdn.example.com/t.png"]' }),
})
eq(textRes.count, 1, '只有 res.text() 的响应形状也能解析')
const badJson = await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async () => ({ ok: true, json: async () => { throw new Error('bad json') } }),
})
eq(badJson.code, 'FETCH_FAILED', '坏 JSON 不冒泡，转成 FETCH_FAILED')
const sig = { marker: 'signal' }
let seenInit = null
await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async (u, init) => { seenInit = init; return { ok: true, json: async () => ({}) } },
  signal: sig,
})
eq(seenInit.signal, sig, '外部 signal 透传给 fetch（可取消）')
let allCalls = []
const noDownload = await fetchReferenceCandidates('q', GOOD, {
  fetchFn: async (url) => {
    allCalls.push(url)
    return {
      ok: true,
      json: async () => ({ results: ['https://cdn.example.com/pic.png', 'https://cdn.example.com/pic2.png'] }),
    }
  },
})
eq(allCalls.length, 1, '★ 只请求检索端点一次，绝不自动下载候选图片字节')
eq(allCalls[0], EP, '唯一一次请求打在检索端点')
eq(noDownload.count, 2, '只返回候选 URL 清单')
ok(noDownload.candidates.every((c) => typeof c.url === 'string' && !('bytes' in c)), '候选里没有任何图片字节')

console.log('\n[8] 全程零真实联网')
globalThis.fetch = realFetch
eq(realFetchCalls, 0, '★ 整个套件未触发过真实 globalThis.fetch（全部走注入）')

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
