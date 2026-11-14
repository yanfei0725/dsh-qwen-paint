/**
 * HTTP 错误响应消毒 + 静态资源路由外置 —— 行为级离线回归
 *
 * 重点锁住：
 *  · 本机绝对路径 / 用户名绝不出现在错误响应里（一处闸门覆盖所有端点）
 *  · assetRoute 异常只写本机日志、回固定文案；诊断细节不丢
 *  · 表驱动注册全部资源路由（清单逐字锁 + 文件真实存在），响应头带 nosniff / CSP
 *  · file-route 的 404 分支同样不回吐 error.message
 *  · 正常响应（热路径）零额外分配
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeReason, sanitizeBody } from '../lib/http-errors.js'
import { ASSET_ROUTES, makeAssetRoute, registerAssetRoutes } from '../lib/asset-route.js'
import { makeFileBytesHandler } from '../lib/file-route.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
const ok = (cond, msg) => { if (cond) { passed += 1; console.log(`✓ ${msg}`) } else failures.push(msg) }
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ── 1. 纯函数：消毒 ────────────────────────────────────────────────────────
{
  const spaced = sanitizeReason(String.raw`open K:\Program Files\ComfyUI\main.py failed`)
  ok(!spaced.includes('Program Files') && !spaced.includes('ComfyUI'),
    '★ 含空格的 Windows 路径被整段抹掉')
  ok(!sanitizeReason('ENOENT /tmp/dshqp-abc/config.json').includes('/tmp/dshqp'), '★ /tmp 临时路径被抹掉')
  ok(!sanitizeReason('ENOENT /var/log/dsh/x').includes('/var/log'), '★ /var 路径被抹掉')
  const win = `ENOENT: no such file or directory, open K:\\ai\\dsh-qwen-paint\\assets\\x.js`
  const out = sanitizeReason(win)
  ok(!out.includes('K:\\ai') && !out.includes('dsh-qwen-paint'), '★ Windows 盘符绝对路径被抹掉')
  ok(out.includes('<本机路径>') && out.includes('ENOENT'), '★ 抹路径但保留诊断原因')

  const usr = sanitizeReason('C:/Users/TestUser/Desktop/note.txt missing')
  ok(!usr.includes('TestUser') && !usr.includes('Desktop'), '★ Windows 用户目录 / 用户名被抹掉')

  const home = sanitizeReason('Cannot read /home/alice/secret/config.json')
  ok(!home.includes('alice') && !home.includes('secret'), '★ POSIX /home/<user> 被抹掉')
  ok(!sanitizeReason('Cannot read /Users/bob/Library/x').includes('bob'), '★ macOS /Users/<user> 被抹掉')

  const unc = sanitizeReason('\\\\NAS\\share\\model.safetensors unavailable')
  ok(!unc.includes('NAS') && !unc.includes('safetensors'), '★ UNC 网络路径被抹掉')

  eq(sanitizeReason('fetch failed'), 'fetch failed', '不含路径的诊断文字原样保留')
  eq(sanitizeReason('path 必须在出图目录内'), 'path 必须在出图目录内', '中文业务文案原样保留')
  eq(sanitizeReason(''), '', '空串不炸')
  eq(sanitizeReason(null), '', 'null 不炸')
  eq(sanitizeReason(undefined), '', 'undefined 不炸')
  ok(!sanitizeReason('EACCES K:\\x').includes(':\\'), '多重路径只留占位符、不残留盘符')
}

// ── 2. 一处闸门覆盖全库 ────────────────────────────────────────────────────
{
  const idx = readSrc('lib/index.js')
  ok(idx.includes('JSON.stringify(sanitizeBody(body))'), '★★ respondJson 是唯一消毒出口')
  ok(readSrc('lib/http-errors.js').includes('if (!needs) return body'),
    '★★ 未命中错误字段时原样返回（热路径零展开）')
  const other = ['lib/reference-endpoints.js', 'lib/ui-edit-endpoints.js',
    'lib/video-frames-endpoints.js', 'lib/cpu-endpoints.js', 'lib/integration-endpoints.js']
    .map(readSrc).join('\n')
  ok(!other.includes('function respondJson'), '★ 外置端点没有私造 respondJson（都注入同一个）')
  ok(idx.includes("from './http-errors.js'") && idx.includes('sanitizeBody'),
    '消毒模块已接进 host')
  ok((idx.match(/respondJson\(res, failBody\(error\)/gu) ?? []).length >= 17
    && !idx.includes('reason: String(error'),
    '★★ 18 处手写错误体已收敛到 failBody()（真去重，不是换皮）')
}

// ── 2b. 完整闸门：ok:true 的漏网字段 ─────────────────────────────────────
{
  const P = String.raw`K:\ai\out\ctl.json`
  const stringsOf = (v) => (typeof v === 'string' ? [v]
    : v && typeof v === 'object' ? Object.values(v).flatMap(stringsOf) : [])

  const clean = { ok: true, online: true, summary: '一切正常', count: 3 }
  eq(sanitizeBody(clean), clean, '★★ 正常响应返回同一个对象引用（零分配）')

  const err = { ok: true, saved: false, reason: 'EACCES ' + P }
  const out = sanitizeBody(err)
  eq(out.ok, true, '写盘失败仍保持 ok:true（行为不变）')
  eq(out.saved, false, 'saved:false 保留')
  ok(!out.reason.includes('K:'), '★★ ok:true + saved:false 的 reason 也消毒')
  ok(out.reason.includes('EACCES'), '诊断原因仍保留')
  ok(err !== out && err.reason.includes('K:'), '原件不被就地改写')

  const st = {
    ok: false, launchError: '状态接口出错：' + P,
    reasons: ['探测出错 /home/alice/a.js'],
    optimization: { ok: false, level: 'unknown', reasons: [P + ' 失败'] },
  }
  const so = sanitizeBody(st)
  ok(stringsOf(so).every((t) => !t.includes('K:')),
    '★★ launchError / reasons / 嵌套 optimization.reasons 全部消毒')
  ok(stringsOf(so).every((t) => !t.includes('alice')), '★★ /home/<user> 在 reasons 里也被抹')
  ok(so.optimization.ok === false && so.optimization.level === 'unknown', '嵌套结构字段不丢')

  const normalOpt = { ok: true, optimization: { ok: true, level: 'good', reasons: ['正常说明'] } }
  eq(sanitizeBody(normalOpt), normalOpt, '★★ 正常 optimization 不展开对象（5 秒轮询零开销）')
}

// ── 3. 静态资源路由表 ──────────────────────────────────────────────────────
{
  // ★ 2026-11-13：原来这里硬编码「10 条」。加了 history.js / history.css 之后变成 12，
  //   但**不能只把 10 改成 12** —— 那样下次加减一份资源又得改数字，仍然测不出真问题。
  //   改成两条更硬的判据：① 文件名集合与清单逐字相等（增减都必须显式改清单）；
  //   ② 每个登记的文件在 assets/ 里**真的存在**（防"登记了但没建文件"⇒ 线上 404）。
  const EXPECT_FILES = [
    'cpu-accel.css', 'cpu-accel.js', 'draft.css', 'draft.js',
    'history.css', 'history.js', 'loading.webp',
    'mask-fx.css', 'mask-fx.js', 'panel.css', 'panel.js', 'setup-guide.css', 'setup-guide.js',
  ]
  eq(ASSET_ROUTES.map(([, f]) => f).slice().sort().join(','), EXPECT_FILES.join(','),
    '★ 静态资源文件清单逐字一致（增减都要显式改这里）')
  // 登记了文件却没建 → 线上必定 404。这里做「存在性」核对。
  // ★ 0.32.1 审计 B：删掉了 loading.gif 死路由（文件从来就不存在），
  //   于是把原先「允许缺 1 个」的记账升级成**零容忍**：新增资源一律不许再缺。
  const KNOWN_MISSING = []
  const missing = ASSET_ROUTES.map(([, f]) => f)
    .filter((f) => !fs.existsSync(path.join(ROOT, 'assets', f)))
  eq(missing.join(','), KNOWN_MISSING.join(','),
    '★ 登记的静态资源文件零缺失（新增资源一律不许再缺）')
  ok(ASSET_ROUTES.length >= 12, '资源条数不少于 12', String(ASSET_ROUTES.length))
  ok(ASSET_ROUTES.every((r) => r.length === 3), '每条都是 [路径, 文件名, MIME] 三元组')
  ok(ASSET_ROUTES.every(([, name]) => !name.includes('/') && !name.includes('..')),
    '★★ 文件名全是常量、不含路径分隔符（没有穿越面）')
  ok(new Set(ASSET_ROUTES.map(([p]) => p)).size === ASSET_ROUTES.length, '★ 路径互不重复（重复注册会覆盖前一条）')
  ok(ASSET_ROUTES.filter(([p]) => p.includes('/qwen-paint/loading')).length === 1
    && ASSET_ROUTES.some(([p, f]) => p.includes('/qwen-paint/loading') && f === 'loading.webp'),
    '★ 动画图片只剩 webp 一条（gif 死路由已删，selftest 断言已同步）')
  ok(['panel.js', 'setup-guide.js', 'mask-fx.js', 'cpu-accel.js', 'history.js']
    .every((n) => ASSET_ROUTES.some(([, f]) => f === n)), '五个后加的脚本都在表里')
  ok(ASSET_ROUTES.every(([p, , mime]) =>
    (p.endsWith('.js') && mime.includes('javascript')) ||
    (p.endsWith('.css') && mime.includes('css')) ||
    (p.endsWith('.webp') && mime === 'image/webp') ||
    (p.endsWith('.gif') && mime === 'image/gif')), 'MIME 与扩展名一一对应')
  const mod = readSrc('lib/asset-route.js')
  ok(!mod.includes('req.url') && !mod.includes('searchParams'), '★★ 文件名不由请求参数拼出')
}

// ── 4. assetRoute 行为 ────────────────────────────────────────────────────
function mkRes() {
  const out = { status: 0, headers: {}, bodies: [], jsons: [] }
  out.res = {
    writeHead(code, headers) { out.status = code; out.headers = headers ?? {} },
    end(chunk) { out.bodies.push(chunk) },
  }
  return out
}

{
  const logs = []
  const captured = []
  const respondJson = (res, body, code = 200) => {
    captured.push({ body, code })
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const deps = { isLocalRequest: (req) => req.local === true, respondJson,
    log: (level, msg) => logs.push({ level, msg }) }
  const route = makeAssetRoute(deps)

  // 非本机
  let r = mkRes()
  await route('loading.webp', 'image/webp')({ local: false }, r.res)
  eq(captured[0]?.code, 403, '非本机请求 → 403')
  eq(captured[0]?.body.reason, 'local requests only', '403 文案固定')

  // 正常读取真实 assets 文件
  captured.length = 0
  r = mkRes()
  await route('panel.css', 'text/css; charset=utf-8')({ local: true }, r.res)
  eq(r.status, 200, '真实 css → 200')
  eq(r.headers['content-type'], 'text/css; charset=utf-8', 'MIME 正确')
  ok(r.headers['x-content-type-options'] === 'nosniff', '★ nosniff 在位')
  ok(String(r.headers['content-security-policy']).includes("default-src 'none'"), '★ CSP 在位')
  ok(r.bodies[0] instanceof Buffer && r.bodies[0].length > 0, '吐的是真实字节')

  // 异常：文件不存在 → 固定文案 + 只写日志
  logs.length = 0
  captured.length = 0
  r = mkRes()
  await route('__definitely_missing__.js', 'text/plain')({ local: true }, r.res)
  const body = captured[0]?.body
  eq(captured[0]?.code, 500, '读取失败 → 500')
  eq(body?.reason, '资源暂不可用（详见插件日志）', '★★ 回给调用方的是固定文案')
  ok(!JSON.stringify(body).includes('ENOENT'), '★★ 响应里没有 error.message')
  ok(!JSON.stringify(body).includes('__definitely_missing__'), '★★ 响应里连文件名都不带')
  ok(logs.length === 1 && logs[0].level === 'warn' && logs[0].msg.includes('ENOENT'),
    '★ 诊断细节只进本机日志（没丢）')
  ok(!JSON.stringify(body).includes(':\\'), '★★ 响应里没有本机盘符路径')

  // log 缺失也不能炸
  const noLog = makeAssetRoute({ isLocalRequest: () => true, respondJson })
  captured.length = 0
  r = mkRes()
  await noLog('__missing__.js', 'text/plain')({}, r.res)
  eq(captured.length, 1, '没有 log 依赖时异常路径照样能收口')
}

// ── 5. 表驱动注册 ─────────────────────────────────────────────────────────
{
  const routes = []
  const webServer = { register(def) { routes.push(def); return () => {} } }
  const disposers = registerAssetRoutes(webServer, {
    isLocalRequest: () => true, respondJson: () => {}, log: () => {},
  })
  eq(routes.length, ASSET_ROUTES.length, '一次注册全部资源路由（条数 = 表长）')
  eq(disposers.length, ASSET_ROUTES.length, '每条都返回 disposer（host effect 统一回收）')
  ok(routes.every((d) => d.kind === 'exact' && typeof d.handler === 'function'), '全是 exact + 函数 handler')
  ok(!readSrc('lib/index.js').includes("assetRoute('"), '★★ index.js 已无逐条注册样板（真去重）')
}

// ── 6. file-route 的 404 分支 ─────────────────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-he-'))
  const captured = []
  const logs = []
  const respondJson = (res, body, code = 200) => captured.push({ body, code })
  const handler = makeFileBytesHandler({
    isLocalRequest: () => true, respondJson, cfg: { outputDir: tmp },
    log: (level, msg) => logs.push({ level, msg }),
  })
  const r = mkRes()
  const missing = path.join(tmp, '__missing__.png')
  await handler({ method: 'GET', url: `/api/qwen-paint/file?path=${encodeURIComponent(missing)}` }, r.res)
  eq(captured[0]?.code, 404, '目录内文件 stat 失败 → 404')
  eq(captured[0]?.body.reason, '文件暂不可读（详见插件日志）', '★★ 回给调用方的是固定文案')
  ok(!JSON.stringify(captured[0]?.body).includes('ENOENT'), '★★ 响应里没有 error.message')
  ok(!JSON.stringify(captured[0]?.body).includes(tmp.replace(/\\/gu, '\\\\')),
    '★★ 响应里没有本机目录')
  ok(logs.length === 1 && logs[0].level === 'warn' && logs[0].msg.includes('ENOENT'),
    '★ 诊断细节只进本机日志')
  fs.rmSync(tmp, { recursive: true, force: true })

  const fr = readSrc('lib/file-route.js')
  ok(fr.includes("reason: '文件暂不可读（详见插件日志）'"), 'file-route catch 固定文案')
  ok(fr.includes('log?.'), 'file-route 异常只写本机日志')
  ok(!fr.includes('reason: String(error'), 'file-route 里没有残留的裸回吐')
}

console.log(`\ntest-http-errors: ${passed} 项断言通过${failures.length ? `，${failures.length} 项失败` : ''}`)
for (const f of failures) console.error(`  ✗ ${f}`)
if (failures.length) process.exit(1)
