/**
 * scripts/test-history-export.mjs —— 历史条目的「可带走」形态与缩略图通路。
 *
 * 覆盖：
 *   · F30 结构化 alt（字段、prompt 截断、空值不污染）
 *   · G32 Markdown 引用（图片/非图分支、**绝不泄漏绝对路径**、多行 prompt）
 *   · G33 继续编辑候选（按 kind 过滤、绝对路径、缺绝对路径时如实提示）
 *   · G36 缩略图：data_url 三道闸（前缀 / 体积 / 魔数）+ 端点围栏 + 落盘位置 + 回滚
 *
 * ⚠ ok() 的签名是 (cond, name, extra)。
 *   2026-11-14 我在这里写反过一次，整份套件变成「✓ true」式假绿。
 *   helper 里已加运行时自检：name 不是非空字符串就直接抛错，写反当场炸。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ALT_PROMPT_CHARS, buildAlt, buildMarkdown, buildContinueHints, decorateHistoryItem,
} from '../lib/history-export.js'
import {
  THUMB_DIR_NAME, THUMB_MAX_BYTES, decodeThumbDataUrl,
  makeHistoryHandlers, historyRouteTable,
} from '../lib/history-endpoints.js'
import { createHistoryStore } from '../lib/history-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
const failures = []

const ok = (cond, name, extra) => {
  // ★ 防假绿自检：参数写反时 name 会变成 true/false 或空串。宁可当场抛错，
  //   也不要产出一页「OK true」让人误以为全过了。
  if (typeof name !== 'string' || name.trim() === '' || name === 'true' || name === 'false') {
    throw new Error(`ok() 参数顺序可能写反（name=${JSON.stringify(name)}）；签名是 (cond, name, extra)`)
  }
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-hex-'))
const logs = []
const log = (level, msg) => logs.push({ level, msg })

// ── 1. F30 结构化 alt ───────────────────────────────────────────────────────
console.log('\n=== 1. F30 结构化 alt 元数据 ===')
{
  const item = {
    id: 1, kind: 'image', prompt: '一只橘猫坐在窗台上看雨，窗外是东京的街道',
    model: 'qwen-image-2.1', tool_name: 'draw_image', seed: 12345,
    width: 1024, height: 768, file_path: 'qwen-paint/2026-11-14/cat.png',
    extra: { style: '日系胶片' },
  }
  const alt = buildAlt(item)
  eq(alt.kind, 'image', 'kind 原样保留')
  eq(alt.label, '图片', 'kind 有中文标签')
  eq(alt.size, '1024×768', '尺寸拼成 W×H')
  eq(alt.style_card, '日系胶片', '★ extra.style 兼容成 style_card（早期记录只有 style）')
  eq(alt.file_name, 'cat.png', '只留文件名，不含目录')
  ok(!alt.text.includes('qwen-paint'), '★ alt.text 里没有目录名（只给检索用的摘要）')
  ok(alt.text.includes('图片') && alt.text.includes('1024×768'), 'alt.text 按「类型 · 尺寸 · 摘要」拼装')
  ok(alt.text.includes('日系胶片'), 'alt.text 带风格卡')

  const long = buildAlt({ ...item, prompt: 'x'.repeat(300) })
  eq(long.prompt_excerpt.length, ALT_PROMPT_CHARS + 1, `超长 prompt 截到 ${ALT_PROMPT_CHARS} 字 + 省略号`)
  ok(long.prompt_excerpt.endsWith('…'), '截断后带省略号，读者知道被截了')

  const bare = buildAlt({ id: 2, kind: 'other', file_path: 'a.bin' })
  eq(bare.size, '', '没有宽高 → size 是空串而不是 ×')
  eq(bare.text, '文件', '全空时 alt.text 只剩类型标签，不出现「 · · 」这种空段')
  ok(bare.seed === null, '没有 seed 就是 null（不是 0）')

  const jsonStyle = buildAlt({ id: 3, kind: 'image', extra: { style_card: '赛博朋克', style: '旧值' } })
  eq(jsonStyle.style_card, '赛博朋克', 'style_card 优先于 style（新字段压旧字段）')
}

// ── 2. G32 Markdown 引用 ────────────────────────────────────────────────────
console.log('\n=== 2. G32 复制为 Markdown 引用 ===')
{
  const img = {
    id: 1, kind: 'image', prompt: '赛博朋克城市夜景', model: 'qwen-image-2.1',
    tool_name: 'draw_image', steps: 20, cfg: 2.5, seed: 777,
    width: 1024, height: 1024, created_at: '2026-11-14T02:00:00.000Z',
    file_path: 'qwen-paint/2026-11-14/shot.png', path: 'K:/out/qwen-paint/2026-11-14/shot.png',
    extra: { style: '霓虹' },
  }
  const md = buildMarkdown(img)
  ok(md.includes('![赛博朋克城市夜景](qwen-paint/2026-11-14/shot.png)')
    || md.includes('![图片 · 1024×1024 · 赛博朋克城市夜景 · 风格 霓虹](qwen-paint/2026-11-14/shot.png)'),
  '图片用 ![]() 语法，alt 用结构化摘要')
  ok(md.includes('(qwen-paint/2026-11-14/shot.png)'), '链接用相对 outputDir 的路径')
  ok(!md.includes('K:/out'), '★★ Markdown 里没有绝对路径（不把本机目录结构带进笔记）')
  ok(md.includes('- 种子：777'), '带种子')
  ok(md.includes('- 尺寸：1024×1024'), '带尺寸')
  ok(md.includes('- 风格卡：霓虹'), '带风格卡')
  ok(md.includes('> 提示词：') && md.includes('> 赛博朋克城市夜景'), '提示词用引用块包住')

  const video = buildMarkdown({ id: 2, kind: 'video', file_path: 'v/clip.mp4', prompt: '' })
  ok(video.startsWith('[clip.mp4](v/clip.mp4)'), '★ 视频用普通链接（![]() 在多数渲染器里会变破图）')
  ok(!video.includes('> 提示词：'), '没有提示词就不硬塞一个空引用块')

  const multi = buildMarkdown({ id: 3, kind: 'image', file_path: 'a.png', prompt: '第一行\n第二行' })
  ok(multi.includes('> 第一行') && multi.includes('> 第二行'), '多行 prompt 每行都加 >，不破坏引用块')
  ok(!/\n[^>]第二行/u.test(multi.split('> 第一行')[1] ?? ''), '第二行确实在引用块内')

  const noPath = buildMarkdown({ id: 4, kind: 'image', prompt: 'x' })
  ok(noPath.includes('（无路径）'), '没有路径时明说，不产出 ![]() 空链接')

  const truncated = buildMarkdown({ id: 5, kind: 'image', file_path: 'a.png', prompt: 'y'.repeat(1000) })
  ok(truncated.includes('…'), '超长 prompt 截断并标注')
  ok(truncated.length < 1200, '截断后长度可控（不会把整段 1000 字都塞进去）')
}

// ── 3. G33 继续编辑候选 ─────────────────────────────────────────────────────
console.log('\n=== 3. G33 快捷继续编辑 ===')
{
  const img = { id: 1, kind: 'image', file_path: 'a.png', path: 'K:/out/a.png' }
  const hints = buildContinueHints(img)
  eq(hints.length, 3, '图片给 3 个后续动作（重绘 / 超分 / 图生视频）')
  eq(hints.map((h) => h.tool).join(','), 'inpaint_image,upscale_image,generate_video', '工具名与真实工具对齐')
  ok(hints.every((h) => h.text.includes('K:/out/a.png')), '★ 指令里带绝对路径（粘贴就能直接用）')
  ok(hints.every((h) => !h.text.includes('K:/out/a.png\n（注意')), '有绝对路径时不追加相对路径提示')

  const rel = buildContinueHints({ id: 2, kind: 'image', file_path: 'a.png' })
  ok(rel.length > 0 && rel[0].text.includes('只有相对输出目录的路径'), '★ 只有相对路径时如实提示（不假装能直接用）')

  const video = buildContinueHints({ id: 3, kind: 'video', file_path: 'v.mp4', path: 'K:/o/v.mp4' })
  eq(video.map((h) => h.id).join(','), 'frames,audio', '视频给抽帧 / 换音轨')

  const audio = buildContinueHints({ id: 4, kind: 'audio', file_path: 'a.wav', path: 'K:/o/a.wav' })
  eq(audio.map((h) => h.id).join(','), 'clone,track', '★ 音频给「复刻音色 / 当音轨」——正好对应本轮 D21/D22')
  ok(audio[0].text.includes('reference_audio'), '复刻指令点名 reference_audio 参数')
  ok(audio[1].text.includes('audio_track'), '音轨指令点名 audio_track 参数')

  eq(buildContinueHints({ id: 5, kind: 'other', file_path: 'x.bin' }).length, 0, '其它类型没有后续动作（返回空数组）')
  eq(buildContinueHints({ id: 6, kind: 'image' }).length, 0, '连路径都没有就返回空，不产出指向空串的指令')

  const spaced = buildContinueHints({ id: 7, kind: 'image', file_path: 'a.png', path: 'K:/my out/a b.png' })
  ok(spaced[0].text.includes('"K:/my out/a b.png"'), '路径含空格时自动加引号（否则粘出去会被拆成两个参数）')
}

// ── 4. decorateHistoryItem 的降级 ───────────────────────────────────────────
console.log('\n=== 4. decorateHistoryItem 逐条兜底 ===')
{
  const d = decorateHistoryItem({ id: 1, kind: 'image', file_path: 'a.png' })
  ok(d.alt && typeof d.alt === 'object', '正常条目带 alt')
  ok(typeof d.markdown === 'string' && d.markdown.length > 0, '正常条目带 markdown')
  ok(Array.isArray(d.continue_hints) && d.continue_hints.length > 0, '正常条目带 continue_hints')

  const bad = decorateHistoryItem({ id: 2, kind: 'image', file_path: 'a.png',
    get prompt() { throw new Error('故意炸') } })
  ok(bad !== null, '★ 某字段 getter 抛错也不让整条消失')
  ok(bad.markdown === '' || typeof bad.markdown === 'string', '算不出来就降级为空串，不产出半截文本')
  ok(!('id' in Object.getPrototypeOf(bad)), '返回的是普通对象（不是带 getter 的原对象）')
}

// ── 5. G36 data_url 三道闸 ──────────────────────────────────────────────────
console.log('\n=== 5. G36 缩略图 data_url 校验 ===')
{
  // 最小合法魔数样本（内容不完整但足够过魔数检查）
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
  const webpHead = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'ascii'),
  ])
  const d = (mime, buf) => `data:image/${mime};base64,${buf.toString('base64')}`

  const okPng = decodeThumbDataUrl(d('png', pngHead))
  ok(okPng.buf && okPng.ext === 'png', '合法 PNG 解码通过')
  const okJpeg = decodeThumbDataUrl(d('jpeg', jpegHead))
  ok(okJpeg.buf && okJpeg.ext === 'jpeg', '合法 JPEG 解码通过')
  const okWebp = decodeThumbDataUrl(d('webp', webpHead))
  ok(okWebp.buf && okWebp.ext === 'webp', '★ 合法 WebP 通过（魔数是 RIFF/WEBP，不是 FF D8）')

  eq(decodeThumbDataUrl('').error, 'data_url 必填', '空串被拒')
  ok(String(decodeThumbDataUrl('http://x/a.png').error).includes('base64'), '★ 普通 URL 被拒（只收 data: base64）')
  ok(String(decodeThumbDataUrl('data:image/svg+xml;base64,PHN2Zz4=').error).includes('不支持'), '★★ SVG 被拒（能带脚本，是 XSS 面）')
  ok(String(decodeThumbDataUrl('data:text/html;base64,PHNjcmlwdD4=').error).includes('base64'), 'text/html 被拒')
  ok(String(decodeThumbDataUrl(d('png', jpegHead)).error).includes('不符'), '★★ 声明 png 实际给 jpeg → 魔数复核抓住')
  ok(String(decodeThumbDataUrl(d('webp', pngHead)).error).includes('不符'), '声明 webp 实际给 png → 抓住')

  const huge = Buffer.concat([webpHead, Buffer.alloc(THUMB_MAX_BYTES + 1024)])
  ok(String(decodeThumbDataUrl(d('webp', huge)).error).includes('过大'), `超过 ${THUMB_MAX_BYTES} 字节被拒`)
  ok(THUMB_MAX_BYTES * 4 / 3 < 256 * 1024, '★ 上限换算成 base64 后仍在 readJsonBody 的 256KB 之内（否则会静默 400）')
}

// ── 6. G36 端点：围栏 + 落盘 + 回滚 ─────────────────────────────────────────
console.log('\n=== 6. G36 缩略图端点 ===')
{
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(path.join(outDir, 'qwen-paint'), { recursive: true })
  fs.writeFileSync(path.join(outDir, 'qwen-paint', 'a.png'), 'x')

  const store = createHistoryStore({ outputDir: outDir, log })
  ok(store.record({ file_path: 'qwen-paint/a.png', prompt: 'hi', kind: 'image' }), '测试前置：记录写入成功')
  const listed = await store.query({ limit: 1 })
  const id = listed.items[0].id

  const makeRes = () => { const r = { out: null }; r.setHeader = () => {}; r.end = () => {}; return r }
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const handlers = makeHistoryHandlers({
    isLocalRequest: (req) => req.local !== false,
    guardWriteRequest: (req, res) => {
      if (String(req.method).toUpperCase() !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return false }
      if (String(req.headers?.['content-type'] ?? '') !== 'application/json') { respondJson(res, { ok: false, reason: 'json only' }, 415); return false }
      return true
    },
    respondJson,
    readJsonBody: async (req) => req.body ?? {},
    store, log, outputDir: outDir,
  })
  const run = async (handler, req) => { const res = makeRes(); await handler(req, res); return res.out }

  const webpBody = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'ascii'), Buffer.alloc(64, 7),
  ])
  const goodBody = { id, data_url: `data:image/webp;base64,${webpBody.toString('base64')}` }

  const forbidden = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/api/qwen-paint/history/thumb', local: false, headers: { 'content-type': 'application/json' }, body: goodBody })
  eq(forbidden.code, 403, '★ 非本机请求 → 403')

  const wrongMethod = await run(handlers.historyThumbHandler,
    { method: 'GET', url: '/api/qwen-paint/history/thumb', local: true, headers: {} })
  eq(wrongMethod.code, 405, 'GET → 405（写操作只收 POST）')

  const wrongType = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/api/qwen-paint/history/thumb', local: true, headers: { 'content-type': 'text/plain' }, body: goodBody })
  eq(wrongType.code, 415, '非 JSON Content-Type → 415')

  const badId = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/', local: true, headers: { 'content-type': 'application/json' }, body: { id: '../etc', data_url: goodBody.data_url } })
  eq(badId.code, 400, '★ id 非正整数 → 400（不给路径注入留口子）')

  const missing = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/', local: true, headers: { 'content-type': 'application/json' }, body: { id: 999999, data_url: goodBody.data_url } })
  eq(missing.code, 404, 'id 不存在 → 404')
  eq(fs.existsSync(path.join(outDir, THUMB_DIR_NAME, '999999.webp')), false, '★★ 回滚：id 不存在时刚写的文件被删掉，不留孤儿')

  const good = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/', local: true, headers: { 'content-type': 'application/json' }, body: goodBody })
  eq(good.code, 200, '合法请求 → 200')
  eq(good.body.thumb, `${THUMB_DIR_NAME}/${id}.webp`, '返回相对输出目录的 thumb 路径')
  const thumbAbs = path.join(outDir, THUMB_DIR_NAME, `${id}.webp`)
  ok(fs.existsSync(thumbAbs), '缩略图真的落盘了')
  eq(fs.readFileSync(thumbAbs).length, webpBody.length, '落盘字节数与请求一致')

  // ★ 文件名只由 id + 白名单扩展名拼成：调用方给什么 name 都改不了落点。
  const withTraversal = await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/', local: true, headers: { 'content-type': 'application/json' },
      body: { id, data_url: goodBody.data_url, filename: '../../../evil.webp', name: '../../x' } })
  eq(withTraversal.code, 200, '多传 filename/name 字段不影响成功')
  eq(fs.existsSync(path.join(tmp, 'evil.webp')), false, '★★ 传 ../ 也写不到输出目录外面')
  ok(!fs.readdirSync(outDir).includes('evil.webp'), '输出目录里也没有多出来的文件')

  // 换格式后旧文件要清掉，否则同一 id 会留两份
  const pngBody = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  await run(handlers.historyThumbHandler,
    { method: 'POST', url: '/', local: true, headers: { 'content-type': 'application/json' },
      body: { id, data_url: `data:image/png;base64,${pngBody.toString('base64')}` } })
  eq(fs.existsSync(thumbAbs), false, '★ 换成 png 后旧 .webp 被清掉（同一 id 不留两份）')
  ok(fs.existsSync(path.join(outDir, THUMB_DIR_NAME, `${id}.png`)), '新的 .png 已就位')

  // 列表要把 thumb_url 带出来，前端才能直接用
  const after = await store.query({ limit: 1 })
  ok(typeof after.items[0].thumb_url === 'string' && after.items[0].thumb_url.includes(encodeURIComponent(`${id}.png`)),
    '★ /history 条目带 thumb_url（否则前端每次都要自己拼）')
  ok(String(after.items[0].extra?.thumb ?? '').endsWith(`${id}.png`), 'extra.thumb 记了相对路径')

  eq(historyRouteTable(handlers).length, 5, '路由表共 5 条（含 thumb 与 D25 草图台）')
  store.close()
}

// ── 7. 无 outputDir 时的行为 ────────────────────────────────────────────────
console.log('\n=== 7. outputDir 未配置 ===')
{
  const store = createHistoryStore({ outputDir: '', log })
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const handlers = makeHistoryHandlers({
    isLocalRequest: () => true,
    guardWriteRequest: () => true,
    respondJson,
    readJsonBody: async (req) => req.body ?? {},
    store, log, outputDir: '',
  })
  const res = { out: null }
  await handlers.historyThumbHandler({
    method: 'POST', url: '/', headers: {}, body: { id: 1, data_url: 'data:image/png;base64,AAAA' },
  }, res)
  eq(res.out.code, 400, '没配输出目录 → 400 并给明确原因')
  ok(String(res.out.body.reason).includes('输出目录未配置'), '原因写的是「输出目录未配置」，不是泛泛的失败')
  store.close()
}

// ── 8. 假绿自检本身有效 ─────────────────────────────────────────────────────
console.log('\n=== 8. helper 自检 ===')
{
  let threw = false
  try { ok(true, true) } catch { threw = true }
  ok(threw, '★★ ok(true, true) 会抛错 —— 参数写反不再产出假绿')
  let threw2 = false
  try { ok(1, '') } catch { threw2 = true }
  ok(threw2, 'ok(1, "") 也会抛错（空消息一律视为写反）')
}

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\ntest-history-export: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
