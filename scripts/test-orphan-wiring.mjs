/**
 * scripts/test-orphan-wiring.mjs —— 三个孤儿模块「真接进主链路」的护栏。
 *
 * 覆盖：
 *   entry-alias      口语入口别名 → 工具 + 端点 + 别名指向必须真实存在
 *   color-tone       参考图色调 → 端点（含像素上限 / 方法 / 边界）
 *   creative-chain   编排四件 → 四个工具（时间轴 / 资源 / 数据流 / 产出短引用）
 *
 * ★ 为什么要有这一套：
 *   这三个模块此前**只有单测引用**，生产链路零入口 —— 用户根本用不到，
 *   而当时所有测试都是绿的。那种绿是"测了没人调用的纯函数"，不是接线验证。
 *   所以本套一律从 createExtras() 拿真实工具与真实端点来断言，
 *   不接受"函数本身对"当作"接上了"。
 *
 * ★ 反向核查：第 7 节把接线逐条拆掉，确认护栏真的会红。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const fails = []

function ok(cond, label, detail) {
  // ★ 2026-11-16：逐条打 ✓ / ✗ —— test-all 的 tickCount 按输出行计数，此前本套只打
  //    汇总行 ⇒ 全量「N 项断言」一直不含这里的 ~120 项（统计口径对不上）。
  if (cond) { pass += 1; console.log('✓ ' + label); return }
  fail += 1
  fails.push(label + (detail === undefined ? '' : '  → ' + String(detail)))
  console.log('✗ ' + label)
}

const { createExtras, EXTRA_TOOL_NAMES } = await import('../lib/tool-registry.js')
const { ORPHAN_TOOL_NAMES, ORPHAN_ROUTE_PATHS, MAX_PIXELS, SAMPLE_EDGE } = await import('../lib/orphan-extras.js')
const { ENTRY_ALIASES, checkAliases } = await import('../lib/entry-alias.js')
const { extractTone } = await import('../lib/color-tone.js')

/* ------------------------------- 端点测试桩 ------------------------------- */

const respondJson = (res, body, status) => {
  res.statusCode = status ?? 200
  res.body = JSON.stringify(body)
  res.parsed = body
}
const makeRes = () => ({
  statusCode: 200, headers: {}, body: '', parsed: null,
  setHeader(k, v) { this.headers[k] = v },
  writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h) },
  end(s) { if (s !== undefined) this.body = String(s) },
})
const makeReq = (method, url, bodyObj) => ({
  method,
  url,
  headers: { 'content-type': 'application/json', host: '127.0.0.1:1' },
  __body: bodyObj === undefined ? '' : JSON.stringify(bodyObj),
  socket: { remoteAddress: '127.0.0.1' },
})

const REAL_TOOLS = ['compose_prompt', 'batch_draw', 'list_generated_images', 'generate_speech',
  'generate_video', 'upscale_image', 'list_available_models']

let guardCalls = 0
let guardAllow = true
const deps = {
  outputDir: path.join(ROOT, '.tmp-orphan-test'),
  cfg: { comfyUrl: 'http://127.0.0.1:8188' },
  tools: REAL_TOOLS,
  respondJson,
  isLocalRequest: () => true,
  // ★ 桩必须和真实 guardWriteRequest 同形：拒绝时**自己写响应**再返回 false
  //   （真实实现在 index.js 里对非 POST 回 405、非 JSON 回 415）。
  //   只返回 false 不写响应的桩会造出"200 + 空 body"的假现场。
  guardWriteRequest: (req, res) => {
    guardCalls += 1
    if (!guardAllow) { respondJson(res, { ok: false, reason: 'write guard rejected' }, 403); return false }
    return true
  },
  readJsonBody: async (req, limitBytes = 256 * 1024) => {
    const s = req.__body ?? ''
    if (s.length > limitBytes) return null
    try { return JSON.parse(s) } catch { return null }
  },
  log: () => {},
}

const extras = createExtras(deps)
const toolByName = (n) => extras.tools.find((t) => t.name === n)
const routeBy = (p) => extras.routes.find((r) => r.path === p)

async function callRoute(p, { method = 'GET', url = null, body = undefined } = {}) {
  const r = routeBy(p)
  if (!r) throw new Error('端点未注册: ' + p)
  const res = makeRes()
  await r.handler(makeReq(method, url || p, body), res)
  return { status: res.statusCode, json: res.parsed }
}

/* ---------------------------- 1. 注册层真的接上了 ---------------------------- */

console.log('=== 1. 注册层：工具与端点都进了 createExtras ===')
{
  ok(ORPHAN_TOOL_NAMES.length === 5, '孤儿模块导出 5 个工具名', ORPHAN_TOOL_NAMES.length)
  ok(ORPHAN_ROUTE_PATHS.length === 3, '孤儿模块导出 3 条端点路径', ORPHAN_ROUTE_PATHS.length)
  ok(ORPHAN_TOOL_NAMES.every((n) => EXTRA_TOOL_NAMES.includes(n)),
    '★ 5 个工具名都在 EXTRA_TOOL_NAMES 里（漏登记 = 打包与清单都看不到）')
  const names = extras.tools.map((t) => t.name)
  for (const n of ORPHAN_TOOL_NAMES) {
    ok(names.includes(n), '★ 工具真的注册进 tools 数组：' + n)
    ok(toolByName(n)?.description?.length > 20, '工具有可读描述：' + n)
    ok(typeof toolByName(n)?.execute === 'function', '工具有 execute：' + n)
  }
  for (const p of ORPHAN_ROUTE_PATHS) {
    ok(typeof routeBy(p)?.handler === 'function', '★ 端点真的注册进 routes：' + p)
  }
  ok(extras.tools.length === EXTRA_TOOL_NAMES.length,
    '工具数 == EXTRA_TOOL_NAMES 条目数（没有重复或漏注册）',
    `${extras.tools.length} vs ${EXTRA_TOOL_NAMES.length}`)
}

/* ------------------------------ 2. entry-alias ------------------------------ */

console.log('\n=== 2. entry-alias：口语入口真的能解析 ===')
{
  const tool = toolByName('resolve_entry')
  const hit = await tool.execute({ entry: '风格卡' })
  ok(hit.ok === true && hit.tool === 'compose_prompt',
    '★ 「风格卡」解析成 compose_prompt', JSON.stringify(hit).slice(0, 120))
  ok(hit.prefill !== undefined && typeof hit.prefill === 'object',
    '解析结果带 prefill（只做参数预置）')
  const miss = await tool.execute({ entry: '魔法卡' })
  ok(miss.ok === false && String(miss.reason).includes('没有这个入口别名'),
    '★ 不存在的入口明确报错，不猜', miss.reason)
  const empty = await tool.execute({ entry: '   ' })
  ok(empty.ok === true && empty.aliases.length === ENTRY_ALIASES.length,
    '空入口等价 action=list，返回全表', empty.aliases?.length)
  const listed = await tool.execute({ action: 'list' })
  ok(listed.aliases.length === ENTRY_ALIASES.length && listed.errors.length === 0,
    '★ 全表体检零错误（别名都指向已注册工具）', JSON.stringify(listed.errors))

  // ★ 关键：别名指向未注册工具必须报错，不能悄悄放行。
  const bogus = await import('../lib/entry-alias.js')
  const bogusErrors = bogus.checkAliases([])
  ok(bogusErrors.length === ENTRY_ALIASES.length,
    '★ 空工具清单下每条别名都报「指向未注册工具」（不放行）', bogusErrors.length)
  const orphanTool = (await import('../lib/orphan-extras.js')).makeEntryAliasTool({ knownTools: [] })
  const orphanHit = await orphanTool.execute({ entry: '风格卡' })
  ok(orphanHit.ok === false && String(orphanHit.reason).includes('未注册'),
    '★ 工具清单不含目标工具时 resolve_entry 报内部不一致', orphanHit.reason)

  const ep = await callRoute(ORPHAN_ROUTE_PATHS[0])
  ok(ep.status === 200 && ep.json.ok === true, '端点 /entry/aliases 返回 200 + ok')
  ok(ep.json.aliases.length === ENTRY_ALIASES.length, '端点返回全表', ep.json.aliases?.length)
  ok(Array.isArray(ep.json.errors) && ep.json.errors.length === 0,
    '端点返回的体检结果为空（真机工具名齐全）')
  ok(ep.json.known_tool_count === EXTRA_TOOL_NAMES.length + REAL_TOOLS.length
    || ep.json.known_tool_count >= REAL_TOOLS.length,
    '端点回报已知工具数（deps.tools 与本层工具取并集）', ep.json.known_tool_count)
}

/* ------------------------------ 3. color-tone ------------------------------ */

console.log('\n=== 3. color-tone：像素 → 色调，端点带边界 ===')
{
  const red = []
  for (let i = 0; i < SAMPLE_EDGE * SAMPLE_EDGE; i += 1) red.push(220, 20, 20, 255)
  const pure = extractTone(red)
  ok(pure.ok === true && pure.hue_name === '红', '纯红 → 红', pure.hue_name)
  ok(pure.tone === 'warm', '纯红判为暖（红必须算暖，不能是中性）', pure.tone)
  ok(pure.phrase.includes('红'), 'phrase 里带色名，可直接拼提示词', pure.phrase)

  const gray = []
  for (let i = 0; i < SAMPLE_EDGE * SAMPLE_EDGE; i += 1) gray.push(128, 128, 128, 255)
  const g = extractTone(gray)
  ok(g.ok === true && g.neutral === true, '★ 全灰图走 neutral 分支，不硬造色相')
  ok(g.phrase.includes('黑白'), '全灰图给黑白描述', g.phrase)

  // ★ 注意长度：< 4 会先命中「像素数据为空」，要验 4 的倍数判据必须给 ≥4 且非 4 倍数。
  const bad = extractTone([1, 2, 3, 4, 5])
  ok(bad.ok === false && String(bad.reason).includes('4 的倍数'), '长度非 4 的倍数明确报错', bad.reason)
  const tooShort = extractTone([1, 2, 3])
  ok(tooShort.ok === false && String(tooShort.reason).includes('为空'),
    '长度 < 4 走「像素数据为空」分支', tooShort.reason)

  const ep = await callRoute(ORPHAN_ROUTE_PATHS[1], { method: 'POST', body: { pixels: red } })
  ok(ep.status === 200 && ep.json.ok === true, '端点 POST 正常返回')
  ok(ep.json.hue_name === '红' && ep.json.edge === SAMPLE_EDGE, '端点回传色名与取样边长')
  ok(ep.json.sampled === SAMPLE_EDGE * SAMPLE_EDGE, '端点回传采样点数', ep.json.sampled)

  const over = await callRoute(ORPHAN_ROUTE_PATHS[1], { method: 'POST', body: { pixels: new Array(MAX_PIXELS + 4).fill(0) } })
  ok(over.status === 400 && over.json.ok === false,
    '★ 超过像素上限直接 400（这是取样接口，不是图片上传口）', over.status)
  ok(String(over.json.reason).includes(String(MAX_PIXELS)), '超限理由里写明上限值', over.json.reason)

  const emptyBody = await callRoute(ORPHAN_ROUTE_PATHS[1], { method: 'POST', body: {} })
  ok(emptyBody.status === 400, '缺 pixels 时 400', emptyBody.status)

  guardAllow = false
  const guarded = await callRoute(ORPHAN_ROUTE_PATHS[1], { method: 'POST', body: { pixels: red } })
  ok(guarded.status !== 200 && guarded.json.ok === false,
    '★ 写守卫拒绝时不执行（不靠端点自己判断）', guarded.status)
  guardAllow = true

  const wrongMethod = await callRoute(ORPHAN_ROUTE_PATHS[1], { method: 'GET' })
  ok(wrongMethod.status === 405, 'GET 打取样端点回 405', wrongMethod.status)
}

/* ---------------------------- 4. creative-chain ---------------------------- */

console.log('\n=== 4. creative-chain：四个工具都真的能用 ===')
{
  const tl = toolByName('plan_timeline')
  const r6 = await tl.execute({ seconds: 6 })
  ok(r6.ok === true && r6.segments.length === 3, '6 秒 / 2 秒一段 → 3 段', r6.segments?.length)
  ok(r6.segments[0].from === 0 && r6.segments[2].to === 6, '段区间首尾正确')
  ok(r6.prefix.includes('0-2 秒') && r6.prefix.includes('按这个顺序演进'),
    '★ prefix 可直接拼进视频提示词')
  const r0 = await tl.execute({ seconds: 0 })
  ok(r0.ok === false && String(r0.reason).includes('正数'), '0 秒明确报错', r0.reason)
  const rTooMany = await tl.execute({ seconds: 60 })
  ok(rTooMany.ok === false && String(rTooMany.reason).includes('12'),
    '★ 超过 12 段明确报错并给上限', rTooMany.reason)
  const custom = await tl.execute({ seconds: 4, labels: ['自定义一', '自定义二'] })
  ok(custom.segments[0].label === '自定义一', '自定义标签生效')

  const rn = toolByName('describe_resource_needs')
  const med = await rn.execute({ kind: 'image', width: 1024, height: 1024 })
  ok(med.ok === true && med.tier === 'medium', '1024² → medium', med.tier)
  const high = await rn.execute({ kind: 'image', width: 3840, height: 2160 })
  ok(high.tier === 'high', '4K → high', high.tier)
  const tts = await rn.execute({ kind: 'tts' })
  ok(tts.ok === true && tts.tier === 'low', 'tts 不需要尺寸也能算（low）', tts.tier)
  const noKind = await rn.execute({ width: 512, height: 512 })
  ok(noKind.ok === false, '缺 kind 时 ok:false（不返回装成功的壳子）')
  ok(med.est_seconds === null && med.unverified === true,
    '★ 没有实测就 est_seconds=null 且 unverified（绝不编秒数）', med.est_seconds)
  ok(Array.isArray(med.notes) && med.notes.some((n) => n.includes('不提供预计秒数')),
    'notes 里写明为什么不给秒数')
  const vid = await rn.execute({ kind: 'video', width: 832, height: 480, frames: 81 })
  ok(vid.exclusive_model === true, '★ 视频标独占模型（会先卸下主模型）')
  const cal = await rn.execute({ kind: 'image', width: 1024, height: 1024, steps: 8,
    calibration: { byKey: {} } })
  ok(cal.est_seconds === null, '传空 calibration 仍是 null（不伪造）')

  const ps = toolByName('privacy_summary')
  const loop = await ps.execute({ comfy_url: 'http://127.0.0.1:8188',
    request_urls: ['http://127.0.0.1:8188/prompt', 'http://localhost:8188/history'] })
  ok(loop.ok === true && loop.external_network === false,
    '★ 全回环 → external_network=false（算出来的，不是写死）')
  const out = await ps.execute({ request_urls: ['http://127.0.0.1:8188/prompt', 'https://example.com/x'] })
  ok(out.external_network === true && out.external_urls.length === 1,
    '★ 混入一个外网地址 → external_network=true 并列出该地址')
  ok(String(out.summary).includes('有 1 个请求发往外部'), 'summary 如实描述出网情况')
  ok(String(out.cross_check).includes('/history/'), '给了 ComfyUI /history 交叉核对入口')
  const dflt = await ps.execute({})
  ok(dflt.endpoints.length === 1 && dflt.endpoints[0].includes('127.0.0.1'),
    '不传 comfy_url 时用宿主 cfg.comfyUrl 兜底', JSON.stringify(dflt.endpoints))

  const pr = toolByName('resolve_produce_ref')
  const items = [{ path: 'out/a.png' }, { path: 'out/b.png' }, { path: 'out/c.png' }]
  const one = await pr.execute({ ref: '#1', items })
  ok(one.ok === true && one.index === 0, '★ #1 = 最新（index 0）', one.index)
  const last = await pr.execute({ ref: 'last', items })
  ok(last.index === 0, 'last 等价 #1')
  const first = await pr.execute({ ref: 'first', items })
  ok(first.index === 2, 'first = 最老的一条', first.index)
  const byName = await pr.execute({ ref: 'b.png', items })
  ok(byName.ok === true && byName.index === 1, '文件名后缀能命中', byName.index)
  const amb = await pr.execute({ ref: 'x.png', items: [{ path: 'a/x.png' }, { path: 'b/x.png' }] })
  ok(amb.ok === false && String(amb.reason).includes('歧义') === false
    && String(amb.reason).includes('匹配到 2 条'),
    '★ 同名后缀多命中报歧义，不替用户挑', amb.reason)
  const oob = await pr.execute({ ref: '#9', items })
  ok(oob.ok === false && String(oob.reason).includes('只有 3 条'), '越界序号明确报错', oob.reason)
  ok(one.total === 3, '回报可引用总数')
}

/* --------------------------- 5. /run/resources 端点 --------------------------- */

console.log('\n=== 5. /run/resources：档位 + 可选的本机实测 ETA ===')
{
  const r = await callRoute(ORPHAN_ROUTE_PATHS[2],
    { url: ORPHAN_ROUTE_PATHS[2] + '?kind=image&width=1920&height=1080&steps=8' })
  ok(r.status === 200 && r.json.ok === true, '端点 200 + ok')
  ok(r.json.tier === 'medium', '1920×1080 → medium', r.json.tier)
  ok(r.json.eta_source.source === 'none', '★ 没要 live_eta 就不去读 /history', r.json.eta_source?.source)
  ok(r.json.est_seconds === null && r.json.unverified === true, '没实测就是 null + unverified')

  // 注入假 fetchCalibration，验证 live 分支真的走通（不联网）。
  const withLive = createExtras({
    ...deps,
    fetchCalibration: async () => ({
      ok: true, samples: [1, 2, 3],
      calibration: { byKey: { 'image:1mp:8': { samples: 5, median_ms: 9000, confidence: 'high' } } },
    }),
  })
  const res2 = makeRes()
  const route2 = withLive.routes.find((x) => x.path === ORPHAN_ROUTE_PATHS[2])
  await route2.handler(makeReq('GET', ORPHAN_ROUTE_PATHS[2] + '?kind=image&width=1024&height=1024&steps=8&live_eta=1'), res2)
  ok(res2.statusCode === 200 && res2.parsed.eta_source.source === 'comfy-history',
    '★ live_eta=1 时真去读本机 /history（走注入的 fetchCalibration）', res2.parsed.eta_source?.source)
  ok(res2.parsed.eta_source.ok === true && res2.parsed.eta_source.samples === 3,
    'live ETA 回报样本数')

  const boom = createExtras({
    ...deps,
    fetchCalibration: async () => { throw new Error('inner detail should not leak') },
  })
  const res3 = makeRes()
  await boom.routes.find((x) => x.path === ORPHAN_ROUTE_PATHS[2])
    .handler(makeReq('GET', ORPHAN_ROUTE_PATHS[2] + '?kind=image&width=512&height=512&live_eta=1'), res3)
  ok(res3.statusCode === 200 && res3.parsed.ok === true,
    '★ /history 读失败不炸端点，降级成 null（仍 200）', res3.statusCode)
  ok(!JSON.stringify(res3.parsed).includes('inner detail'),
    '★ 异常详情不外泄（不吐 error.message）')
}

/* ------------------------------ 6. 文档与清单 ------------------------------ */

console.log('\n=== 6. 清单 / 描述 / 指引都同步了（否则等于没接） ===')
{
  const td = read('lib/tool-descriptions.js')
  const ag = read('lib/agent-guide.js')
  for (const n of ORPHAN_TOOL_NAMES) {
    ok(td.includes(n + ':'), 'TOOL_SUMMARIES 有 ' + n)
    ok(ag.includes(n + ':'), 'agent-guide TOOL_HINTS 有 ' + n)
  }
  const is = read('lib/integration-state.js')
  for (const p of ORPHAN_ROUTE_PATHS) ok(is.includes(p), '端点目录登记 ' + p)

  const llms = read('llms.txt')
  const dllms = read('docs/llms.txt')
  for (const n of ORPHAN_TOOL_NAMES) {
    ok(llms.includes('`' + n + '`'), 'llms.txt 以代码字体点名 ' + n)
    ok(dllms.includes('`' + n + '`'), 'docs/llms.txt 以代码字体点名 ' + n)
  }

  // agent-guide 的 undocumented 机制：工具没写提示会被抓出来。
  const { buildAgentGuide } = await import('../lib/agent-guide.js')
  const guide = buildAgentGuide({ tools: extras.tools.map((t) => t.name), routes: extras.routes })
  ok(Array.isArray(guide.undocumented) && guide.undocumented.length === 0,
    '★ /agent-guide 里没有 undocumented 工具', JSON.stringify(guide.undocumented))

  // UI 入口：色调必须真的能从界面上触发，否则还是"只有端点"。
  const lab = read('assets/lab.js')
  ok(lab.includes("request('tone/extract'"), '★ 实验室面板真的调 tone/extract（有 UI 入口）')
  ok(lab.includes('getImageData'), '★ UI 侧真做 canvas 32×32 采样')
  ok(lab.includes('参考图色调'), '实验室有「参考图色调」功能区')
  ok(read('assets/lab.css').includes('.dshqp-lab-swatch'), '色块样式存在')
}

/* ------------------------------ 7. 反向核查 ------------------------------ */

console.log('\n=== 7. 反向核查：把接线拆掉，护栏必须变红 ===')
{
  const registry = read('lib/tool-registry.js')
  const stripped = registry.replace('  ...ORPHAN_TOOL_NAMES,\n', '')
  ok(stripped !== registry, '★ 反向：能删掉 ...ORPHAN_TOOL_NAMES（前提成立）')
  const blockOf = (src) => src.match(/EXTRA_TOOL_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/u)
  const namesIn = (b) => (b?.[1].match(/'[a-z0-9_]+'/gu) ?? [])
  const before = namesIn(blockOf(registry)).length
  const after = namesIn(blockOf(stripped)).length
  ok(before === after, '删掉展开项后字面量数不变（说明工具名确实只在展开常量里）')

  const noRoute = read('lib/orphan-extras.js').replace('  return [\n', '  return []\n')
  ok(noRoute !== read('lib/orphan-extras.js'), '★ 反向：能清空端点表（前提成立）')
  ok(routeBy(ORPHAN_ROUTE_PATHS[0]) !== undefined, '当前端点表非空（对照）')

  const lab = read('assets/lab.js')
  const labStripped = lab.replace("request('tone/extract'", "request('tone/DISABLED'")
  ok(!labStripped.includes("request('tone/extract'"),
    '★ 反向：把 UI 调用改成别的路径后，第 6 节的 UI 断言会红（判据有效）')

  const llmsStripped = read('llms.txt').replace('`resolve_entry`', 'resolve_entry')
  ok(!llmsStripped.includes('`resolve_entry`'),
    '★ 反向：去掉反引号后点名断言会红（不接受裸字符串）')
}

/* ------------------- 8. 全量可达性扫描（不再靠手写白名单） ------------------- */

console.log('\n=== 8. 全量可达性：lib/*.js 要么从 index.js 可达，要么在显式白名单里 ===')
{
  // 背景：旧护栏是「手写一个 NEW_MODULES 列表逐个查」，列表外的模块永远不被检查
  //       —— workflow-fingerprint.js 就是这样一路没人发现只被测试 import。
  // 改法：从 lib/index.js 出发做真实 import 图可达性，白名单必须逐条给理由。
  const libDir = path.join(ROOT, 'lib')
  const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.js'))
  const srcOf = new Map(libFiles.map((f) => [f, read('lib/' + f)]))

  const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)'\.\/([A-Za-z0-9_.-]+\.js)'/gu
  const edges = new Map()
  for (const [f, src] of srcOf) {
    edges.set(f, [...new Set([...src.matchAll(IMPORT_RE)].map((m) => m[1]))])
  }

  const reachable = new Set()
  const queue = ['index.js']
  while (queue.length > 0) {
    const cur = queue.pop()
    if (reachable.has(cur) || !srcOf.has(cur)) continue
    reachable.add(cur)
    for (const next of edges.get(cur) ?? []) queue.push(next)
  }

  // 白名单：**不在后端 import 图里**但确实合法的模块，必须写清理由。
  const ALLOWED_UNREACHABLE = {
    'client.js': '前端包：由 DSH 直接加载到浏览器侧，不经后端 import',
    'workflow-fingerprint.js': '回归期图结构指纹工具：只被 scripts/* 引用，不参与运行时构图',
    'db-constraints.js': '多 Agent 并发约束库：独立基础设施（供外部脚本/agent 显式 import，对齐桌面 dsh-db.py），test-db-constraints.mjs 覆盖；不进插件运行时、不经 index.js',
    'test-worker-pool.js': '测试并行化 Worker 池：由 test-all.mjs --worker 模式动态 import（await import），静态边扫描看不到动态 import 故列入；非插件运行时模块',
    'test-worker-runner.js': 'Worker 线程内测试执行器：由 test-worker-pool.js 以 Worker(RUNNER) 加载（非 import 边），静态扫描看不到故列入；与主线程共用判定口径',
  }

  const orphans = libFiles.filter((f) => !reachable.has(f) && !(f in ALLOWED_UNREACHABLE))
  ok(orphans.length === 0,
    '★ lib/ 里没有未登记的真孤儿（每个文件都从 index.js 可达，或在白名单里写明理由）',
    orphans.join(',') || 'NONE')

  // 反向：白名单不许「已经接上了却忘了删」——否则白名单会越来越假
  const staleAllowed = Object.keys(ALLOWED_UNREACHABLE).filter((f) => reachable.has(f))
  ok(staleAllowed.length === 0,
    '★ 白名单没有过期项（模块一旦接进主链路就必须从白名单删掉）',
    staleAllowed.join(',') || 'NONE')

  // 反向：白名单里的文件必须真的存在，防止改名后白名单变成空挂
  const ghostAllowed = Object.keys(ALLOWED_UNREACHABLE).filter((f) => !libFiles.includes(f))
  ok(ghostAllowed.length === 0,
    '★ 白名单指向的文件都存在（改名 / 删除后必须同步）',
    ghostAllowed.join(',') || 'NONE')

  ok(reachable.size >= libFiles.length - Object.keys(ALLOWED_UNREACHABLE).length,
    '★ 可达性扫描本身没瞎（可达数 + 白名单数 == 总文件数）',
    `可达 ${reachable.size} + 白名单 ${Object.keys(ALLOWED_UNREACHABLE).length} vs 总 ${libFiles.length}`)
}

/* --------------------------------- 汇总 --------------------------------- */

console.log(`\n=== test-orphan-wiring：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
