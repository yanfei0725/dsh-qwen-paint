/**
 * test-pptx-lite.mjs —— 轻量档 PPTX（纯 JS 零依赖零 GPU）专项回归。
 *
 * 断言风格：ok(名称, 条件)。全离线、零子进程。覆盖：ZIP 结构（PK 签名 / EOCD / 条目数）/
 * OOXML 组成（content types / rels / slides）/ XML 转义 / 围栏 / 工具成功与降级 /
 * 注册层与文档点名同步 / 体积红线。PowerPoint 兼容性本身 unverified（如实边界）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPptxDeck, makePptxTool } from '../lib/pptx-lite.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('✓ ' + name); return }
  fail += 1
  fails.push(name)
  console.log('✗ ' + name, extra ?? '')
}
ok('自检：本文件 ok() 是「名称, 条件」顺序（写反自检占位）', true)

/* ---------------- §1 ZIP 结构 ---------------- */

const deck = buildPptxDeck({ title: '测试', slides: [
  { title: '第一页', bullets: ['要点 1', '要点 2'] },
  { title: '第二页 <&>"' , bullets: [] },
  { title: '第三页', bullets: ['b'] },
] })
ok('3 页 deck 构建成功', deck.ok === true && deck.slideCount === 3)
const buf = deck.buffer
ok('ZIP 头 PK\x03\x04', buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04)
ok('EOCD PK\x05\x06 存在', buf.includes(Buffer.from([0x50, 0x4B, 0x05, 0x06])))
ok('中央目录 PK\x01\x02 存在', buf.includes(Buffer.from([0x50, 0x4B, 0x01, 0x02])))
ok('store 条目（method 0）—— 无压缩依赖', !buf.includes(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00])))
ok('空 slides → ok:false', buildPptxDeck({ slides: [] }).ok === false)
ok('>50 页 → ok:false（轻量档上限）', buildPptxDeck({ slides: Array.from({ length: 51 }, () => ({ title: 'x' })) }).ok === false)

/* ---------------- §2 OOXML 组成 ---------------- */

const s = buf.toString('latin1')
ok('[Content_Types].xml 条目存在', s.includes('[Content_Types].xml'))
ok('presentation.xml 条目存在', s.includes('ppt/presentation.xml'))
ok('slideMaster1 / slideLayout1 / theme1 条目存在', s.includes('ppt/slideMasters/slideMaster1.xml')
  && s.includes('ppt/slideLayouts/slideLayout1.xml') && s.includes('ppt/theme/theme1.xml'))
ok('每页 slideN.xml 与 rels 成对（3 页 = 6 个条目）', s.includes('ppt/slides/slide3.xml')
  && s.includes('ppt/slides/_rels/slide3.xml.rels') && !s.includes('ppt/slides/slide4.xml'))
ok('presentation 引用 3 个 sldId', s.includes('r:id="rId4"'))

/* ---------------- §3 XML 转义 ---------------- */

const esc = buildPptxDeck({ title: 'A<&>"\'', slides: [{ title: 'A<&>"\'', bullets: [] }] })
const escStr = esc.buffer.toString('utf8')
ok('XML 特殊字符被转义（&lt; &amp; &quot; &apos;）', escStr.includes('&lt;') && escStr.includes('&amp;')
  && escStr.includes('&quot;') && escStr.includes('&apos;'))
ok('不残留未转义的原始 <&>', !escStr.includes('<a:t>A<&>') && !escStr.includes("'<"))

/* ---------------- §4 工具边界（围栏 + 成功路径） ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-pptx-'))
const tool = makePptxTool({ outputDir: tmp })
const t0 = await tool.execute({ title: 'x', slides: [{ title: 's' }], target: '../evil.pptx' })
ok('输出穿越被拒', t0.ok === false && t0.degraded === true)
const t05 = await tool.execute({ title: 'x', slides: [{ title: 's' }], target: 'out.txt' })
ok('非 .pptx 目标被拒', t05.ok === false && String(t05.reason).includes('.pptx'))
const t1 = await tool.execute({ title: '测试标题', slides: [
  { title: '章节一', bullets: ['要点 A', '要点 B'] },
  { title: '章节二', bullets: [] },
], target: 'out.pptx' })
ok('轻量档永远可执行（无外部引擎）→ executed:true', t1.executed === true && t1.degraded === false && t1.ok === true)
const written = path.join(tmp, 'out.pptx')
ok('文件真实落盘且非空', fs.existsSync(written) && fs.statSync(written).size > 1000)
ok('回填 slides 数与字节数', t1.slides === 2 && t1.bytes === fs.statSync(written).size)
ok('note 如实标注兼容性 unverified', String(t1.note).includes('unverified'))
const t2 = await tool.execute({ title: 'x', slides: [], target: 'out.pptx' })
ok('空 slides 工具层如实拒（绝不谎称已落盘）', t2.executed === false && t2.ok === false)
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------- §5 注册层与文档点名同步 ---------------- */

ok('tool-registry 注册 make_pptx', read('lib/tool-registry.js').includes("'make_pptx'")
  && read('lib/tool-registry.js').includes('makePptxTool'))
ok('integration-state 目录含 pptx 路由', read('lib/integration-state.js').includes('/api/qwen-paint/pptx'))
ok('selftest EXPECTED_TOOLS 含 make_pptx', read('scripts/selftest.mjs').includes("'make_pptx'"))
ok('tool-descriptions 与 agent-guide 点名', read('lib/tool-descriptions.js').includes('make_pptx')
  && read('lib/agent-guide.js').includes('make_pptx'))
ok('两份 llms 以代码字体点名 make_pptx', read('llms.txt').includes('`make_pptx`')
  && read('docs/llms.txt').includes('`make_pptx`'))
// ★ 2026-11-16 判据升级（原断言是「lab UI 有 PPT 入口」，与用户明确要求冲突）：
//   用户要求「lab.js 移除 PPT 段」，PPT 升为面板第四模式 ⇒ 改为断言 panel 有 PPT 卡
//   且 lab 不再有 PPT 输入控件（双向锁，防有人把段加回 lab 造成两份入口）。
ok('panel UI 有 PPT 卡（第四模式）+ lab 不再重复放一份',
  read('assets/panel.js').includes('cp-ppt-card')
  && read('assets/panel.js').includes('api/qwen-paint/pptx')
  && !read('assets/lab.js').includes('cp-ppt-'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-pptx-lite.mjs'))

/* ---------------- §5b 拖图插页（2026-11-18：用户拖几张图，agent 决定插哪页） ---------------- */

import { imageExtOf, imageBytesOf } from '../lib/pptx-lite.js'
// 1x1 合法 PNG / 最小 JPEG 魔数
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF9zX0AAAAASUVORK5CYII=', 'base64')
ok('imageExtOf：PNG 魔数', imageExtOf(PNG1) === 'png')
ok('imageExtOf：JPEG 魔数', imageExtOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1])) === 'jpeg')
ok('imageExtOf：非图片返回空', imageExtOf(Buffer.from('not an image at all')) === '')
ok('imageBytesOf：data URL 解码', (() => { const b = imageBytesOf('data:image/png;base64,' + PNG1.toString('base64')); return b && b.equals(PNG1) })())
ok('imageBytesOf：裸 base64', (() => { const b = imageBytesOf(PNG1.toString('base64')); return b && b.equals(PNG1) })())
ok('imageBytesOf：Buffer 直通', imageBytesOf(PNG1) === PNG1)
ok('imageBytesOf：空/非法返回 null', imageBytesOf('') === null && imageBytesOf('@@@') === null)

const imgDeck = buildPptxDeck({ title: '旅游', slides: [
  { title: '风景页', bullets: ['雪山'], images: [{ data: PNG1, name: '雪山', x: 0.5, y: 0.5, w: 0.4, h: 0.4 }] },
  { title: '美食页', bullets: ['火锅'], images: [{ data: 'data:image/png;base64,' + PNG1.toString('base64'), name: '火锅' }] },
  { title: '纯文字页', bullets: ['无图'] },
] })
ok('带图 deck 构建成功且 imageCount=2', imgDeck.ok === true && imgDeck.imageCount === 2)
const imgs = imgDeck.buffer.toString('latin1')
ok('ppt/media/image1.png 真写入 ZIP', imgs.includes('ppt/media/image1.png'))
ok('ppt/media/image2.png 真写入 ZIP（跨页全局唯一编号）', imgs.includes('ppt/media/image2.png'))
ok('图片字节真进包（PNG 签名出现在 media 条目）', imgs.includes('IHDR') && imgs.includes('IDAT'))
ok('slide1 rels 指向 image1.png', /slide1\.xml\.rels[\s\S]{0,400}image1\.png/u.test(imgs) || imgs.includes('../media/image1.png'))
ok('Content_Types 声明 png Default', /<Default Extension="png" ContentType="image\/png"/u.test(imgs))
ok('含 p:pic 图形元素（图片真挂到幻灯片）', imgs.includes('<p:pic>') && imgs.includes('<a:blip r:embed='))
ok('纯文字页无图（agent 决定插哪页）', (imgs.match(/<p:pic>/gu) || []).length === 2)
ok('坏图跳过不伪造（魔数不符的 images 被忽略）', (() => {
  const d = buildPptxDeck({ slides: [{ title: 'x', images: [{ data: Buffer.from('fake-fake-fake-fake') }] }] })
  return d.ok === true && d.imageCount === 0 && !d.buffer.toString('latin1').includes('ppt/media/')
})())
ok('工具输出 schema 含 images 字段', read('lib/pptx-lite.js').includes('slides: NUM, images: NUM, bytes: NUM'))

/* ---------------- §6 体积红线 ---------------- */

ok('lib/pptx-lite.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'pptx-lite.js')).size <= 262144)

console.log(`\n=== test-pptx-lite：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
