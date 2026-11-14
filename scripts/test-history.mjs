#!/usr/bin/env node
/**
 * test-history.mjs —— 生成历史（SQLite 存储 / 端点 / Agent 工具 / 前端）离线回归
 *
 * 全程零联网、零 ComfyUI、零媒体生成：
 *   ① 真跑 `node:sqlite`，但库文件只落在**系统临时目录**，跑完即删；
 *   ② 端点用注入假 req/res，不启真实 HTTP 服务；
 *   ③ 前端只做源码级锁（不 eval 浏览器脚本）。
 *
 * 锁住的事：
 *   · 只存相对 outputDir 的路径，绝对路径与目录外文件一律拒绝入库；
 *   · 重复 file_path 忽略（draw 详细版优先于钩子兜底版）；
 *   · 软删除只改 deleted=1，**绝不删磁盘文件**；
 *   · 无 node:sqlite（Node < 22.5）时如实降级：available/persistent=false，不假装有数据；
 *   · 端点围栏：非本机 403 / 非 GET 405 / 写操作 POST+JSON / 非法 id 400；
 *   · 异常只进本机日志，响应里不出现 error.message（防本机路径外泄）；
 *   · 前端脚本不拼 innerHTML、fetch 只打本机端点、点按走四事件兜底。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  HISTORY_DB_NAME, HISTORY_KINDS, HISTORY_NODE_MIN, kindOf,
  toRelativePath, createHistoryStore,
} from '../lib/history-store.js'
import { makeHistoryHandlers, historyRouteTable } from '../lib/history-endpoints.js'
import { HISTORY_TOOL_NAME, makeHistoryTool } from '../lib/history-tool.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sizeOf = (rel) => fs.statSync(path.join(ROOT, rel)).size
let pass = 0
const failures = []
// ⚠ 参数顺序是 (cond, msg, extra) —— 与 test-http-errors.mjs 一致。
//   第一版写成了 (name, cond)，结果整份套件的断言全在判「消息字符串非空」，
//   140 项"全绿"其实是全假绿（输出全是 `OK true`）。这类假断言比没有断言更危险。
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-hist-'))
const logs = []
const log = (level, msg) => logs.push({ level, msg })

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────
console.log('=== 1. 路径与类型（纯函数） ===')
{
  eq(kindOf('a.png'), 'image', 'png → image')
  eq(kindOf('a.MP4'), 'video', '大写扩展名也认（大小写不敏感）')
  eq(kindOf('a.flac'), 'audio', 'flac → audio')
  eq(kindOf('a.xyz'), 'other', '未知扩展名 → other')
  eq(kindOf(''), 'other', '空串 → other 不抛错')

  const outDir = path.join(tmp, 'out')
  eq(toRelativePath(outDir, path.join(outDir, 'sub', 'a.png')), 'sub/a.png', '★ 目录内绝对路径转 POSIX 相对路径')
  eq(toRelativePath(outDir, outDir), '', '目录自身 → 空串（拒绝入库）')
  eq(toRelativePath(outDir, path.join(tmp, 'outside.png')), '', '★★ 目录外路径 → 空串（拒绝入库）')
  eq(toRelativePath(outDir, ''), '', '空路径 → 空串')
  eq(toRelativePath('', path.join(outDir, 'a.png')), '', 'outputDir 未配置 → 空串')
  ok(HISTORY_KINDS.join(',') === 'image,video,audio,other', '类型白名单顺序稳定')
  ok(HISTORY_NODE_MIN === '22.5.0', 'Node 下限常量 = 22.5.0（node:sqlite 引入版本）')
}

// ── 2. 真 SQLite 存储 ───────────────────────────────────────────────────────
console.log('\n=== 2. SQLite 存储（真跑 node:sqlite，库在临时目录） ===')
const outDir = path.join(tmp, 'out')
{
  fs.mkdirSync(outDir, { recursive: true })
  const store = createHistoryStore({ outputDir: outDir, log })
  eq(store.available, true, '★ 本机 Node 有 node:sqlite → available')
  eq(store.persistent, true, '持久化打开')
  // ★ 语义变更（2026-11-13 审计）：db_file 从「绝对路径」改成「只给文件名」。
  //   /history 的响应会被浏览器、外部集成、代理日志三处消费，不该带本机目录结构。
  eq(store.db_file, HISTORY_DB_NAME, '★ db_file 只给文件名（不再暴露本机绝对路径）')
  ok(!store.db_file.includes(path.sep) && !store.db_file.includes('/') && !store.db_file.includes(':'),
    '★★ db_file 不含任何路径分隔符 / 盘符')
  ok(path.isAbsolute(store.db_path) && store.db_path.endsWith(HISTORY_DB_NAME),
    '★ db_path 才是真实路径（内部 / 测试用，绝不进 HTTP 响应）')
  ok(fs.existsSync(path.join(outDir, HISTORY_DB_NAME)), 'DB 文件真的创建在 outputDir 里')

  const absImg = path.join(outDir, '2026', 'cat.png')
  // 真建一个文件：软删除断言要证明「记录没了但文件还在」，不能用不存在的路径空转。
  fs.mkdirSync(path.dirname(absImg), { recursive: true })
  fs.writeFileSync(absImg, 'fake-png-bytes')
  eq(store.record({ file_path: absImg, prompt: '一只柴犬', tool_name: 'draw_image', model: 'qwen', steps: 8, cfg: 2.5, seed: 42, width: 720, height: 720 }), true, '目录内绝对路径可写入')
  eq(store.record({ file_path: absImg, prompt: '重复写入应被忽略' }), true, '重复写入不抛错（INSERT OR IGNORE）')
  eq(store.record({ file_path: path.join(tmp, 'outside.png'), prompt: 'x' }), false, '★★ 目录外路径拒绝入库')
  eq(store.record({ file_path: '' }), false, '空路径拒绝入库')
  eq(store.record({ file_path: path.join(outDir, 'clip.mp4'), prompt: '日落', kind: 'video', width: 1280, height: 720 }), true, '视频可写入')
  eq(store.record({ file_path: path.join(outDir, 'voice.mp3'), prompt: '旁白', kind: 'audio' }), true, '音频可写入')
  eq(store.record({ file_path: path.join(outDir, 'note.txt'), prompt: '杂项' }), true, '未知扩展名可写入（kind 推断为 other）')

  // ★★ 2026-11-13 第一轮审计抓到的**真漏洞**：
  //   record() 此前只挡 `path.isAbsolute`，「不是绝对路径」就原样收下，
  //   于是 `../outside.png` / `a/../../outside.png` 被判成合法相对路径入库，
  //   之后 asRow() 用 path.join(outputDir, rel) 一拼就**逃出出图目录**，
  //   再经 /api/qwen-paint/file?path= 就能读到目录外的文件。
  //   下面每条都必须返回 false，且不能改变后面 total=4 的断言。
  for (const bad of ['../outside.png', '..\\outside.png', 'a/../../outside.png',
    'C:outside.png', 'C:outside/x.png', '..', '']) {
    eq(store.record({ file_path: bad, prompt: '穿越尝试' }), false,
      '★★ 越界路径拒绝入库：' + JSON.stringify(bad))
  }

  const all = await store.query({})
  eq(all.total, 4, '★ 重复 file_path 被忽略：4 条不同文件 = 4 行')
  ok(all.items.every((x) => !path.isAbsolute(x.file_path)), '★★ DB 里只存相对路径（迁移目录不失效、不入库绝对路径）')
  ok(all.items.every((x) => typeof x.preview_url === 'string' && x.preview_url.startsWith('api/qwen-paint/file?path=')),
    '每条带本机预览 URL（相对路径，不写死主机）')
  // preview_url 必须能让 /api/qwen-paint/file 读到文件，所以保留绝对路径。
  // 真正要锁的是「解码后仍落在 outputDir 内」—— db 被篡改也不能把预览引到目录外。
  // （此前那条「URL 里没有临时目录明文」是假安全：encodeURIComponent 早把
  //   `C:\Users\…` 编成 `C%3A%5CUsers…`，明文当然搜不到，但路径照样在里面。）
  ok(all.items.every((x) => {
    const p = decodeURIComponent(String(x.preview_url).slice('api/qwen-paint/file?path='.length))
    return path.resolve(p).startsWith(path.resolve(outDir) + path.sep)
  }), '★★ 预览 URL 解码后仍落在 outputDir 内（越界读不到）')
  eq(all.items.find((x) => x.file_path.endsWith('cat.png'))?.kind, 'image', 'kind 自动推断 = image')
  eq(all.items.find((x) => x.file_path.endsWith('clip.mp4'))?.kind, 'video', 'kind 自动推断 = video')

  const byKind = await store.query({ kind: 'video' })
  eq(byKind.total, 1, '按类型筛选')
  const byKw = await store.query({ keyword: '柴犬' })
  eq(byKw.total, 1, '★ 关键词命中提示词')
  eq((await store.query({ keyword: '不存在的东西' })).total, 0, '关键词无命中 → 0')
  const byFile = await store.query({ keyword: 'clip' })
  eq(byFile.total, 1, '关键词也匹配文件名')

  const p1 = await store.query({ limit: 2, offset: 0 })
  const p2 = await store.query({ limit: 2, offset: 2 })
  eq(p1.items.length, 2, 'limit 生效')
  eq(p2.items.length, 2, 'offset 生效')
  eq(p1.total, 4, '分页时 total 仍是全量')
  ok(p1.items.map((x) => x.id).join() !== p2.items.map((x) => x.id).join(), '两页不重叠')
  eq((await store.query({ limit: 999 })).limit, 50, '★ limit 上限 clamp 到 50（不接受 999）')
  eq((await store.query({ limit: 0 })).limit, 1, '★ limit 下限 clamp 到 1')
  eq((await store.query({ limit: -5, offset: -3 })).offset, 0, '★ 负 offset clamp 到 0')

  const inj = await store.query({ keyword: "'; DROP TABLE images; --" })
  eq(inj.ok, true, '★★ SQL 注入串不抛错（参数化）')
  eq((await store.query({})).total, 4, '★★ 注入后表还在（4 条未丢）')

  const stats = store.stats()
  eq(stats.total, 4, 'stats 总数')
  eq(stats.by_kind.video, 1, 'stats 按类型统计')

  const target = (await store.query({ keyword: '柴犬' })).items[0]
  eq(store.remove(target.id), true, '软删除成功')
  eq((await store.query({ keyword: '柴犬' })).total, 0, '★ 软删除后列表里查不到')
  eq(store.remove(target.id), false, '重复软删除如实返回 false（不假装成功）')
  eq(store.remove('abc'), false, '非整数 id 返回 false')
  ok(fs.existsSync(absImg) === true, '★★ 软删除只动数据库：磁盘上的图片文件仍在（绝不删用户文件）')
  ok(String(readSrc('lib/history-store.js')).includes('绝不删用户磁盘上的图片'), '源码注释保留「绝不删用户磁盘文件」约束')

  const { DatabaseSync } = await import('node:sqlite')
  // ⚠ 必须用 db_path（真实路径）；store.db_file 现在只是文件名，
  //   拿它 new DatabaseSync 会在**当前目录**新建空库，然后报 no such table。
  const raw = new DatabaseSync(store.db_path)
  const row = raw.prepare('SELECT deleted FROM images WHERE id = ?').get(target.id)
  eq(Number(row.deleted), 1, '★★ 软删除是 deleted=1，不是物理 DELETE')
  raw.close()

  store.close()
  eq(store.record({ file_path: path.join(outDir, 'after-close.png') }), false, 'close 后写入返回 false 不抛错')
}

// ── 3. 无 node:sqlite 的降级 ────────────────────────────────────────────────
console.log('\n=== 3. 降级（Node < 22.5 没有 node:sqlite） ===')
{
  const fallbackRows = [
    { path: path.join(outDir, 'old.png'), prompt: '旧的柴犬', backend: 'comfyui', steps: 8, seed: 7, width: 512, height: 512, ts: '2026-11-01T10:00:00.000Z' },
    { path: path.join(outDir, 'old.mp4'), prompt: '旧的视频', ts: '2026-11-02T10:00:00.000Z' },
  ]
  const deg = createHistoryStore({
    outputDir: outDir,
    log,
    sqliteModule: null,
    fallbackRecent: async () => fallbackRows,
  })
  eq(deg.available, false, '★★ 无 node:sqlite → available=false')
  eq(deg.persistent, false, '★★ persistent=false（不假装持久化）')
  ok(deg.reason.includes('22.5'), '降级原因写明 Node 版本要求')
  eq(deg.record({ file_path: path.join(outDir, 'x.png') }), false, '降级时写入返回 false')

  const q = await deg.query({ keyword: '柴犬' })
  eq(q.total, 1, '★ 降级时按关键词过滤既有 JSONL')
  eq(q.persistent, false, '降级查询结果自带 persistent=false')
  eq((await deg.query({ kind: 'video' })).total, 1, '降级时按类型过滤')
  eq((await deg.query({})).total, 2, '降级时不过滤 = 全部')
  ok((await deg.query({})).items.every((x) => typeof x.preview_url === 'string'), '降级项也给预览 URL（界面不用分叉）')
  eq(deg.stats().total, 0, '降级时 stats 如实返回 0（不编数）')

  const broken = createHistoryStore({
    outputDir: outDir, log, fallbackRecent: async () => { throw new Error('JSONL 读失败') },
    sqliteModule: null,
  })
  const q2 = await broken.query({})
  eq(q2.total, 0, 'fallback 抛错也不崩，返回空列表')
}

// ── 4. 端点围栏 ─────────────────────────────────────────────────────────────
console.log('\n=== 4. 端点信任围栏 ===')
const makeRes = () => {
  const res = { out: null }
  return res
}
const respondJson = (res, body, code = 200) => { res.out = { code, body } }
const jsonBody = (obj) => ({ headers: { 'content-type': 'application/json' }, body: obj })
{
  // 极简 store 替身：只测端点行为，不重复测 SQLite
  const calls = []
  const fakeStore = {
    query: async (o) => { calls.push(['query', o]); return { ok: true, items: [], total: 0, limit: 20, offset: 0, available: true, persistent: true } },
    stats: () => ({ ok: true, total: 0, by_kind: {}, available: true, persistent: true }),
    remove: (id) => { calls.push(['remove', id]); return id === 7 },
  }
  const h = makeHistoryHandlers({
    isLocalRequest: (req) => req.local !== false,
    guardWriteRequest: (req, res) => {
      if (String(req.method).toUpperCase() !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return false }
      if (String(req.headers?.['content-type'] ?? '') !== 'application/json') { respondJson(res, { ok: false, reason: 'json only' }, 415); return false }
      return true
    },
    respondJson,
    readJsonBody: async (req) => req.body ?? {},
    store: fakeStore,
    log,
  })

  const run = async (handler, req) => { const res = makeRes(); await handler(req, res); return res.out }

  eq((await run(h.historyHandler, { method: 'GET', url: '/api/qwen-paint/history' }))?.code, 200, 'GET 历史 200')
  eq((await run(h.historyHandler, { method: 'GET', local: false, url: '/' }))?.code, 403, '★ 非本机 → 403')
  eq((await run(h.historyHandler, { method: 'POST', url: '/' }))?.code, 405, '历史列表 GET only')
  eq((await run(h.historyHandler, { method: 'HEAD', url: '/' }))?.code, 200, 'HEAD 也放行（只读语义）')

  eq((await run(h.historyStatsHandler, { method: 'GET' }))?.code, 200, 'GET 汇总 200')
  eq((await run(h.historyStatsHandler, { method: 'GET', local: false }))?.code, 403, '汇总非本机 403')

  eq((await run(h.historyDeleteHandler, { method: 'POST', local: false, ...jsonBody({ id: 7 }) }))?.code, 403, '删除非本机 403')
  eq((await run(h.historyDeleteHandler, { method: 'GET' }))?.code, 405, '删除 GET → 405')
  eq((await run(h.historyDeleteHandler, { method: 'POST', headers: {}, body: { id: 7 } }))?.code, 415, '删除无 JSON content-type → 415')
  eq((await run(h.historyDeleteHandler, { method: 'POST', ...jsonBody({ id: 0 }) }))?.code, 400, 'id=0 → 400')
  eq((await run(h.historyDeleteHandler, { method: 'POST', ...jsonBody({ id: 'abc' }) }))?.code, 400, 'id 非数字 → 400')
  const del = await run(h.historyDeleteHandler, { method: 'POST', ...jsonBody({ id: 7 }) })
  eq(del?.body?.removed, true, '删除成功 removed=true')
  ok(String(del?.body?.note ?? '').includes('磁盘文件保留'), '★ 回包明说「磁盘文件保留」（不让人误以为删了图）')
  eq((await run(h.historyDeleteHandler, { method: 'POST', ...jsonBody({ id: 8 }) }))?.body?.removed, false, '不存在的 id 如实 removed=false')

  // URL 查询参数 → store.query 的映射
  calls.length = 0
  await run(h.historyHandler, { method: 'GET', url: '/api/qwen-paint/history?q=%E6%9F%B4%E7%8A%AC&kind=video&from=2026-11-01&to=2026-11-30&limit=5&offset=10' })
  const mapped = calls.find((c) => c[0] === 'query')?.[1]
  eq(mapped?.keyword, '柴犬', 'q 参数映射到 keyword（URL 解码正确）')
  eq(mapped?.kind, 'video', 'kind 透传')
  eq(mapped?.from, '2026-11-01', 'from 透传')
  eq(mapped?.to, '2026-11-30', 'to 透传')
  eq(mapped?.limit, '5', 'limit 透传（clamp 由 store 负责）')
  calls.length = 0
  await run(h.historyHandler, { method: 'GET', url: '/api/qwen-paint/history?keyword=abc&date_from=2026-01-01' })
  const alias = calls.find((c) => c[0] === 'query')?.[1]
  eq(alias?.keyword, 'abc', 'keyword 是 q 的别名')
  eq(alias?.from, '2026-01-01', 'date_from 是 from 的别名')

  // 异常：只进日志，不回吐 message
  const boom = makeHistoryHandlers({
    isLocalRequest: () => true,
    guardWriteRequest: () => true,
    respondJson,
    readJsonBody: async () => { throw new Error('K:/secret/private.db locked') },
    store: { query: async () => { throw new Error('K:/secret/private.db') }, stats: () => { throw new Error('K:/secret') }, remove: () => { throw new Error('K:/secret') } },
    log,
  })
  const e1 = await run(boom.historyHandler, { method: 'GET', url: '/' })
  const e2 = await run(boom.historyStatsHandler, { method: 'GET' })
  const e3 = await run(boom.historyDeleteHandler, { method: 'POST', ...jsonBody({ id: 1 }) })
  for (const [name, r] of [['列表', e1], ['汇总', e2], ['删除', e3]]) {
    eq(r?.code, 500, `${name}异常 → 500`)
    ok(!JSON.stringify(r?.body).includes('K:/secret'), `★★ ${name}异常不回吐本机路径`)
    ok(String(r?.body?.reason ?? '').includes('详见插件日志'), `${name}异常回固定文案`)
  }
  ok(logs.some((l) => l.level === 'warn' && l.msg.includes('K:/secret')), '★ 诊断细节只进本机日志')

  const table = historyRouteTable(h)
  // ★ 判据升级：不再断言「N 条」（增一条就得改数字，很容易变成"把数字改大"糊过去），
  //   改成**集合逐字相等**。新增端点时必须显式登记到下表，等于强制过一次脑子。
  const paths = table.map(([p]) => p).sort()
  const expectPaths = [
    // D25 草图台（data_url 落盘）与缩略图共用同一套三道闸，所以归在这张表里。
    '/api/qwen-paint/draft',
    '/api/qwen-paint/history',
    '/api/qwen-paint/history/delete',
    '/api/qwen-paint/history/stats',
    '/api/qwen-paint/history/thumb',
  ].sort()
  eq(paths.join(' , '), expectPaths.join(' , '), '路由表逐字等于预期集合')
  ok(table.every(([p, fn]) => p.startsWith('/api/qwen-paint/') && typeof fn === 'function'), '路由路径与本机前缀一致')
  ok(table.every(([, fn]) => typeof fn === 'function'), '每个路由都绑了可调用的 handler')
}

// ── 5. Agent 工具 ──────────────────────────────────────────────────────────
console.log('\n=== 5. Agent 工具 list_generated_images ===')
{
  const seen = []
  const tool = makeHistoryTool({
    log,
    store: {
      query: async (o) => {
        seen.push(o)
        return { ok: true, items: [{ id: 1, file_path: 'a.png' }], total: 1, limit: 20, offset: 0, available: true, persistent: true }
      },
    },
  })
  eq(tool.name, HISTORY_TOOL_NAME, '工具名 = list_generated_images')
  eq(HISTORY_TOOL_NAME, 'list_generated_images', '★ 工具名与宿主注册名一致（改名要同步 selftest 计数）')
  ok(tool.description.includes('本机') && tool.description.includes('再改'), '描述说明本地只读 + 复查用途')
  ok(tool.description.includes('available=false'), '★ 描述里解释降级语义（不让 Agent 误判成"没有历史"）')
  ok(tool.parameters.type === 'object' && tool.parameters.additionalProperties === false, 'parameters 闭合')
  const pkeys = Object.keys(tool.parameters.properties).sort().join(',')
  eq(pkeys, 'date_from,date_to,keyword,kind,limit,offset', '参数集合')
  ok(!JSON.stringify(tool.parameters).includes('"enum"'), '★ 不用 enum（宿主 assertSupportedJsonSchema 不认）')
  ok(!JSON.stringify(tool.parameters).includes('"format"'), '★ 不用 format')

  const r = await tool.execute({ keyword: '柴犬', kind: 'video', date_from: '2026-11-01', limit: 5 })
  eq(r.ok, true, 'execute 成功')
  eq(r.persistent, true, '持久化时 persistent=true')
  ok(String(r.note).includes('SQLite'), 'note 说明数据来自 SQLite')
  eq(seen[0]?.keyword, '柴犬', 'keyword 透传')
  eq(seen[0]?.kind, 'video', '合法 kind 透传')
  eq(seen[0]?.limit, 5, 'limit 透传')

  await tool.execute({ kind: 'bogus' })
  eq(seen[1]?.kind, '', '★★ 非法 kind 被清空（不让 SQL 层去猜）')

  const degTool = makeHistoryTool({
    log,
    store: { query: async () => ({ ok: true, items: [], total: 0, limit: 20, offset: 0, available: false, persistent: false }) },
  })
  const dr = await degTool.execute({})
  eq(dr.persistent, false, '降级时 persistent=false')
  ok(String(dr.note).includes('未持久化'), '★ 降级 note 如实说明')

  const badTool = makeHistoryTool({ log, store: { query: async () => { throw new Error('K:/x') } } })
  const br = await badTool.execute({})
  eq(br.ok, false, 'store 抛错时 ok=false')
  eq(br.items.length, 0, '抛错时 items 为空数组（不是 undefined）')
  ok(!JSON.stringify(br).includes('K:/x'), '★ 工具回包不含本机路径')
}

// ── 6. 前端接线（源码级） ───────────────────────────────────────────────────
console.log('\n=== 6. 前端与宿主接线 ===')
{
  const hs = readSrc('assets/history.js')
  const css = readSrc('assets/history.css')
  const idx = readSrc('lib/index.js')
  const client = readSrc('lib/client.js')
  const ar = readSrc('lib/asset-route.js')

  ok(ar.includes("'/qwen-paint/history.js'") && ar.includes("'/qwen-paint/history.css'"),
    '★ 两条静态路由已登记（否则脚本 404、界面永远不出现）')
  ok(client.includes("'qwen-paint/history.js'"), '★ client.js 的 loadQpExtras 挂载了 history.js')
  ok(idx.includes('makeHistoryHandlers') && idx.includes('historyRouteTable'), 'index.js 接线了历史端点')
  ok(idx.includes('historyStore?.record('), '★ 出图 / 交付后真的写历史（不是只建了表）')
  ok(idx.includes('makeHistoryTool') && idx.includes('registerTool(historyTool)'), '★ Agent 工具已注册')

  ok(!/innerHTML\s*=/u.test(hs), '★★ 前端不用 innerHTML（杜绝把提示词当 HTML 执行）')
  ok(!/insertAdjacentHTML|document\.write|eval\(/u.test(hs), '★★ 无 insertAdjacentHTML / document.write / eval')
  // 逐个抓 fetch 的第一个实参：只允许「本机历史端点的三个常量 / 查询构造器」，
  // 不接受任何 http(s) 绝对地址或第三方主机（第一版用 /fetch\([^)]*\)/ 抓，遇到
  // 嵌套括号就断在 buildQuery( 里，断言永远打不到点上 —— 那等于没测）。
  const fetchTargets = [...hs.matchAll(/fetch\(\s*(buildQuery\(\)|[A-Za-z_$][\w$.]*)/gu)].map((m) => m[1])
  ok(fetchTargets.length >= 3, '前端至少有 3 个 fetch（列表 / 汇总 / 删除）', fetchTargets.join(','))
  ok(fetchTargets.every((t) => ['buildQuery()', 'DEL_API', 'STATS_API', 'LIST_API'].includes(t)),
    '★★ 每个 fetch 只打本机历史端点（不接受外部 URL）', fetchTargets.join(','))
  ok(/'api\/qwen-paint\/history'/.test(hs) && /'api\/qwen-paint\/history\/delete'/.test(hs),
    '端点字符串是相对路径（跟随当前页 origin，不写死主机）')
  ok(!/https?:\/\//u.test(hs), '★★ 前端脚本里没有任何绝对外网 URL')
  ok(!/comfyUrl|127\.0\.0\.1:8188/u.test(hs), '前端不直连 ComfyUI（一律走本机插件端点）')
  ok(hs.includes("'click', 'pointerup', 'mouseup', 'touchend'"), '★ 点按四事件兜底（宿主会吞 click）')
  ok(hs.includes('data-dshqp-direct'), '★ 上报直接绑定标记，避免兜底重复触发')
  ok(hs.includes('300'), '★ 有 300ms 冷却去重')
  ok(hs.includes('data-dshqp-hist'), '菜单注入有幂等标记')
  ok(hs.includes('querySelector(\'[data-dshqp-hist="1"]\')'), '★ 用「条目还在不在」判定，菜单重建也不会漏注入')
  ok(hs.includes('hidden = true') || hs.includes('hidden = false'), '面板用 hidden 控制显隐')
  ok(!/[A-Za-z]:[\\/]|Users[\\/]|K:[\\/]ai/u.test(hs), '★★ 前端脚本不含本机绝对路径')

  ok(css.includes('.hs-overlay') && css.includes('z-index'), '样式表有浮层与层级')
  ok(!/url\(\s*['"]?https?:/u.test(css), '样式表不引外链资源')
  const vars = (css.match(/var\(--qp-[a-z-]+/gu) ?? []).map((s) => s.replace('var(', ''))
  const known = new Set(['--qp-accent', '--qp-accent-soft', '--qp-bg', '--qp-fg', '--qp-field',
    '--qp-field-hover', '--qp-line', '--qp-line-strong', '--qp-muted', '--qp-on-accent', '--qp-scrim', '--qp-shadow'])
  const unknown = [...new Set(vars)].filter((v) => !known.has(v))
  ok(unknown.length === 0, '★ 只用项目真实存在的 --qp-* 变量', unknown.join(','))

  ok(sizeOf('lib/index.js') <= 262144, 'lib/index.js ≤ 262144 B', sizeOf('lib/index.js'))
  ok(sizeOf('lib/client.js') <= 262144, '★★ lib/client.js ≤ 262144 B（余量极小）', sizeOf('lib/client.js'))
  ok(sizeOf('assets/history.js') <= 262144, 'assets/history.js ≤ 262144 B')
  ok(sizeOf('assets/history.css') <= 262144, 'assets/history.css ≤ 262144 B')
}

// ── 7. 前端真跑一遍（vm + 假 DOM，真派发事件） ──────────────────────────────
console.log('\n=== 7. 前端行为：菜单注入 / 点开 / Escape 关掉 ===')
{
  /**
   * 只造 history.js 真正用到的那点 DOM。判据是**行为**不是源码字符串：
   * 注入进菜单了没、点了开不开、Esc 关不关、列表渲不渲染。
   * （上一版这套东西只做源码锁，等于「我写了字符串就算完成」—— 用户两次报「点不动」，
   *   正是因为没人真派发过一个事件。）
   */
  const makeNode = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(), className: '', id: '', type: '', title: '',
      placeholder: '', value: '', hidden: false, disabled: false, loading: '', alt: '',
      src: '', rel: '', href: '', style: {}, attrs: {}, dataset: {}, children: [],
      parentNode: null, listeners: {}, _text: '',
      get firstChild() { return this.children[0] ?? null },
      get textContent() { return this._text },
      set textContent(v) { this._text = String(v); this.children = [] },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c },
      insertBefore(c, ref) {
        const i = this.children.indexOf(ref)
        this.children.splice(i < 0 ? this.children.length : i, 0, c)
        c.parentNode = this
        return c
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this) },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) },
      querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
      querySelectorAll(sel) {
        const raw = String(sel)
        let hit
        if (raw.startsWith('#')) { const w = raw.slice(1); hit = (c) => c.id === w } else if (raw.startsWith('.')) { const w = raw.slice(1); hit = (c) => String(c.className).split(/\s+/u).includes(w) } else if (raw.startsWith('[')) {
          const m = raw.match(/^\[([\w-]+)="([^"]*)"\]$/u)
          hit = (c) => Boolean(m) && c.getAttribute(m[1]) === m[2]
        } else hit = (c) => c.tagName === raw.toUpperCase()
        const out = []
        const walk = (node) => { for (const c of node.children) { if (hit(c)) out.push(c); walk(c) } }
        walk(this)
        return out
      },
    }
    return n
  }

  /** 跑一次 history.js，返回沙箱与可操作的 DOM 手柄。 */
  const boot = (withMenu) => {
    const head = makeNode('head')
    const body = makeNode('body')
    const docListeners = {}
    const document = {
      readyState: 'complete', body, head,
      createElement: (t) => makeNode(t),
      addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn) },
      getElementById(id) { return head.querySelectorAll('#' + id)[0] ?? body.querySelectorAll('#' + id)[0] ?? null },
      querySelectorAll(sel) { return [...head.querySelectorAll(sel), ...body.querySelectorAll(sel)] },
    }
    const observers = []
    class MutationObserverFake {
      constructor(cb) { this.cb = cb; observers.push(this) }
      observe() { /* 记录即可，测试里手动 tick */ }
      disconnect() {}
    }
    const fires = []
    const payload = {
      ok: true, available: true, persistent: true, total: 2, limit: 20, offset: 0,
      items: [
        { id: 1, kind: 'image', file_path: 'a/cat.png', path: '/abs/a/cat.png', prompt: '一只柴犬', tool_name: 'draw_image', created_at: '2026-11-13T01:02:03.000Z', width: 720, height: 720, preview_url: 'api/qwen-paint/file?path=%2Fabs%2Fa%2Fcat.png' },
        { id: 2, kind: 'video', file_path: 'a/clip.mp4', path: '/abs/a/clip.mp4', prompt: '日落', tool_name: 'generate_video', created_at: '2026-11-13T02:00:00.000Z' },
      ],
    }
    const fetchFake = (url, opt) => { fires.push({ url: String(url), opt }); return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }) }
    const window = { document, fetch: fetchFake, setTimeout, clearTimeout, MutationObserver: MutationObserverFake }
    const sandbox = {
      window, document, fetch: fetchFake, console, MutationObserver: MutationObserverFake,
      navigator: { clipboard: null }, setTimeout, clearTimeout,
      Promise, Date, Number, Math, JSON, Object, Array, String, Boolean, Set, RegExp, Error, isNaN,
    }
    vm.createContext(sandbox)
    let menu = null
    if (withMenu) {
      menu = makeNode('div')
      menu.className = 'dshqp-menu'
      body.appendChild(menu)
    }
    let err = null
    try { vm.runInContext(readSrc('assets/history.js'), sandbox, { filename: 'assets/history.js' }) } catch (e) { err = e }
    return { sandbox, document, body, head, menu, docListeners, observers, fires, err }
  }

  // ⚠ 必须**先派 target 自己的监听器、再往上冒泡** —— 第一版只调了 document 上的监听器，
  //   结果「点开面板」「按 Esc 关闭」全测不到：事件根本没到控件上。
  const fire = (docListeners, target, type, props = {}) => {
    const ev = { type, target, key: props.key, preventDefault() {}, ...props }
    for (const fn of docListeners[type] ?? []) fn(ev)
    let n = target
    while (n) {
      for (const fn of n.listeners?.[type] ?? []) fn(ev)
      n = n.parentNode
    }
    return ev
  }

  // —— 7.1 启动 + 菜单注入 ——
  const A = boot(true)
  ok(A.err === null, 'vm 里 mount() 不抛错', A.err?.message)
  const api = A.sandbox.window.DshQpHistory
  ok(Boolean(api && api.__hs === true), '导出 DshQpHistory 且带 __hs 哨兵')
  ok(typeof api.open === 'function' && typeof api.close === 'function' && typeof api.reload === 'function',
    '导出 open / close / reload')

  const injected = A.menu.querySelectorAll('[data-dshqp-hist="1"]')
  eq(injected.length, 1, '★ 菜单里注入了一条「生成历史」')
  ok(String(injected[0]?.textContent).includes('生成历史'), '注入项文字含「生成历史」')
  ok(A.menu.children[0]?.className.includes('dshqp-menu-head')
    && A.menu.children[1] === injected[0], '★ 整组插在菜单最前面（标题 + 条目；用户抱怨过"入口太隐蔽"）')
  eq(String(A.menu.children[0]?.textContent), '历史', '分组标题是「历史」')
  const overlay = A.body.querySelector('.hs-overlay')
  ok(Boolean(overlay), '面板已挂到 body')
  eq(overlay?.hidden, true, '面板初始收起（不挡界面）')

  // 再扫一次不应重复注入
  A.observers[0]?.cb()
  eq(A.menu.querySelectorAll('[data-dshqp-hist="1"]').length, 1, '★ 重复扫描不重复注入（幂等）')

  // —— 7.2 点开：只派 pointerup（宿主吞 click 的典型情形） ——
  fire(A.docListeners, injected[0], 'pointerup')
  ok(overlay.hidden === false, '★★ 只派 pointerup 也能打开面板（不依赖 click）')
  await new Promise((r) => setImmediate(r))
  const listRows = overlay.querySelectorAll('.hs-row')
  eq(listRows.length, 2, '列表渲染了 2 条记录')
  ok(String(listRows[0].querySelectorAll('.hs-prompt')[0]?.textContent).includes('柴犬'), '第一条显示提示词')
  ok(String(listRows[0].querySelectorAll('.hs-meta')[0]?.textContent).includes('720×720'), 'meta 带尺寸')
  eq(listRows[1].querySelectorAll('.hs-badge')[0]?.textContent, '视', '视频条目显示类型徽标（占位字）')
  ok(A.fires.some((f) => f.url.startsWith('api/qwen-paint/history?')), '★ 打开时真的请求了本机历史端点')
  ok(A.fires.every((f) => !/^https?:/u.test(f.url)), '★★ 所有请求都是相对路径（不出网）')

  // —— 7.3 Escape 关掉 ——
  fire(A.docListeners, A.body, 'keydown', { key: 'Escape' })
  ok(overlay.hidden === true, '★★ Escape 能关掉面板（不只是靠鼠标）')

  // —— 7.4 大图预览 + Escape 先关预览 ——
  api.open()
  await new Promise((r) => setImmediate(r))
  const thumb = overlay.querySelectorAll('.hs-thumb')[0]
  fire(A.docListeners, thumb, 'click')
  const preview = A.body.querySelector('.hs-preview')
  ok(Boolean(preview), '点缩略图打开预览浮层')
  fire(A.docListeners, A.body, 'keydown', { key: 'Escape' })
  eq(A.body.querySelector('.hs-preview'), null, '★ Escape 优先关预览')
  eq(overlay.hidden, false, '★ 关预览时面板仍开着（不会一起消失）')
  fire(A.docListeners, A.body, 'keydown', { key: 'Escape' })
  eq(overlay.hidden, true, '再按 Escape 才关面板')

  // —— 7.5 api.close() 幂等 ——
  api.close()
  eq(overlay.hidden, true, 'close() 幂等（已关再关不抛错）')

  // —— 7.6 没有菜单时也能工作；菜单后出现靠 MutationObserver 补注入 ——
  const B = boot(false)
  ok(B.err === null, '没有 .dshqp-menu 时 mount() 也不抛错')
  ok(B.sandbox.window.DshQpHistory?.__hs === true, '照样导出 API（菜单后到也不影响功能）')
  const late = makeNode('div')
  late.className = 'dshqp-menu'
  B.body.appendChild(late)
  B.observers[0]?.cb()
  eq(late.querySelectorAll('[data-dshqp-hist="1"]').length, 1, '★ 菜单后出现时 MutationObserver 补注入成功')

  // —— 7.7 降级态（available=false）不假装有数据 ——
  const C = boot(true)
  // 脚本里调的是裸 fetch（vm 全局），不是 window.fetch —— 两处都要换。
  const degradedFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, items: [], total: 0, available: false, persistent: false, reason: 'node:sqlite 不可用（需要 Node >= 22.5.0）' }) })
  C.sandbox.fetch = degradedFetch
  C.sandbox.window.fetch = degradedFetch
  C.sandbox.window.DshQpHistory.open()
  await new Promise((r) => setImmediate(r))
  const cOverlay = C.body.querySelector('.hs-overlay')
  const emptyText = String(cOverlay.querySelectorAll('.hs-empty')[0]?.textContent ?? '')
  ok(emptyText.includes('node:sqlite') || emptyText.includes('不持久化'), '★ 降级时明说"不持久化"，不编造记录', emptyText.slice(0, 60))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\ntest-history: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : ''}`)
for (const f of failures) console.error(`  ✗ ${f}`)
if (failures.length) process.exit(1)
