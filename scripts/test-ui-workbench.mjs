#!/usr/bin/env node
/**
 * test-ui-workbench.mjs —— 「图片编辑台 / 傻瓜化入口 / 安装引导」离线回归。
 *
 * 锁住三件容易悄悄回退的事：
 *   ① 四个图片工具是不是**真的**从 UI 够得着（端点注册 + 菜单 + 结果图可见按钮）；
 *   ② /quick-edit 的安全围栏与参数约束（本机请求、PNG 蒙版前缀、一次性蒙版删干净、
 *      方向 / 倍数 clamp、工具未注册 503）；
 *   ③ 装完之后的引导是否还在（历史上引导只写到「重启 DSH」就断了）。
 *
 * 纯 JS：注入假 deps，不联网、不派生子进程、不生成任何图片 / 视频 / 音频。
 * 运行：node scripts/test-ui-workbench.mjs
 */
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeUiEditHandlers } from '../lib/ui-edit-endpoints.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const INDEX = read('lib/index.js')
const CLIENT = read('lib/client.js')
const INSTALL = read('INSTALL.md')
const QUICK = read('scripts/quickstart.mjs')
const DSH = read('给DSH安装的话.md')

let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fails.push(name); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('[1] UI 接线：功能真的够得着')
ok('两个图片编辑端点已注册',
  INDEX.includes("path: '/api/qwen-paint/recent-images'")
  && INDEX.includes("path: '/api/qwen-paint/quick-edit'"))
ok('三个工具引用在注册时已保存（端点才能直接 execute）',
  ['removeToolRef = removeTool', 'outpaintToolRef = outpaintTool', 'upscaleToolRef = upscaleTool']
    .every((s) => INDEX.includes(s)))
// ★ 2026-11-12 变更：用户原话「这个你放的地方也太不明显了吧你把它改的明显一点」。
//   三个常用动作从"夹在一堆设置项中间"改成**菜单最上方的独立分组 + 强调样式**。
ok('★★ 常用动作提到菜单最上方并高亮（不再夹在设置项中间）',
  CLIENT.includes('常用（点开就能用）') && CLIENT.includes('dshqp-menu-hot'))
ok('★ 三个菜单入口都接了分发',
  CLIENT.includes("entry.kind === 'workbench'") && CLIENT.includes("entry.kind === 'recent-inpaint'")
  && CLIENT.includes("entry.kind === 'video-timeline'"))
ok('★ 多图与单图结果下方都有可见按钮（不再只靠悬停提示）',
  CLIENT.includes('imageActionBar(p)') && CLIENT.includes('imageActionBar(filePath)'))
ok('★ 圈选浮层支持「圈出要移除的东西」', CLIENT.includes("opts.mode === 'remove'"))
ok('★ 圈选浮层有常用说法预设（不知道写什么也能点）', CLIENT.includes('dshqp-mask-presets'))
// ★ 2026-11-13 变更：payload 多带一个可选 maskFx（蒙版精修参数）。
//   端点没换、image/prompt/maskPng 三个必填字段一个没少，所以这不是放宽断言，
//   而是把「原形状 + 新字段」一起锁死：既防回退，也防有人偷偷改掉必填字段。
ok('★ 默认局部重绘仍走原端点，且蒙版参数随 payload 一起下发',
  CLIENT.includes("'api/qwen-paint/inpaint'")
  && CLIENT.includes('{ image: imagePath, prompt: text, maskPng, maskFx: fx }')
  && CLIENT.includes('maskPng = window.DshQpMaskFx')
  && CLIENT.includes('const fx = window.DshQpMaskFx'))
ok('★ 工作台是独立浮层、开窗前清残留（不碰消息树 / 不叠层）',
  CLIENT.includes('.dshqp-wb-overlay') && CLIENT.includes('dshqp-mask-overlay dshqp-wb-overlay'))

console.log('\n[2] 端点行为与安全围栏（注入假 deps，全程离线）')
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-wb-'))
const calls = []
const tools = {
  remove_image: { execute: async (args) => { calls.push({ name: 'remove_image', args }); return { path: '/tmp/r.png', files: [], seconds: 1 } } },
  outpaint_image: { execute: async (args) => { calls.push({ name: 'outpaint_image', args }); return { path: '/tmp/o.png', files: [], seconds: 1 } } },
  upscale_image: { execute: async (args) => { calls.push({ name: 'upscale_image', args }); return { path: '/tmp/u.png', files: [], seconds: 1 } } },
}
let maskPathUsed = ''
const deps = {
  isLocalRequest: (req) => req.local === true,
  guardWriteRequest: () => true,
  respondJson: (res, body, status = 200) => { res.status = status; res.body = body },
  readJsonBody: async (req) => req.body ?? {},
  cfg: { outputDir: tmp },
  makeMaskPath: () => {
    maskPathUsed = path.join(tmp, `mask-${Math.random().toString(36).slice(2, 10)}.png`)
    return maskPathUsed
  },
  getTool: (name) => tools[name] ?? null,
  readRecent: async () => [
    { path: '/a/1.png', files: ['/a/2.png', '/a/1.png'] },
    { path: '/a/3.png' },
  ],
  log: () => {},
}
const { recentImagesHandler, quickEditHandler } = makeUiEditHandlers(deps)
const mkRes = () => ({ status: 0, body: null })
const mkReq = (body, method = 'POST', local = true) => ({ method, local, body })
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64')

{
  const r = mkRes()
  await recentImagesHandler(mkReq({}, 'GET'), r)
  ok('GET 最近图片：去重 + 展开 files',
    r.status === 200 && r.body.ok === true && r.body.count === 3
    && r.body.items[0].path === '/a/1.png' && r.body.items[1].path === '/a/2.png',
    JSON.stringify(r.body))
}
{
  const r = mkRes()
  await recentImagesHandler(mkReq({}, 'GET', false), r)
  ok('★ 非本机请求读最近图片直接 403', r.status === 403)
}
{
  const r = mkRes()
  await recentImagesHandler(mkReq({}, 'POST'), r)
  ok('读最近图片只收 GET（其余 405）', r.status === 405)
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'remove', image: '/a/1.png', maskPng: PNG }, 'POST', false), r)
  ok('★ 非本机请求触发编辑直接 403（顶层围栏在动作之前）', r.status === 403)
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'nonsense', image: '/a/1.png' }), r)
  ok('不认识的 action 拒绝（400）', r.status === 400 && /action/.test(r.body.reason))
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'upscale' }), r)
  ok('缺 image 拒绝（400）', r.status === 400 && /先选一张图|image/.test(r.body.reason))
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'remove', image: '/a/1.png', maskPng: 'javascript:alert(1)' }), r)
  ok('★ 蒙版只接受 PNG data URI（挡任意文件写入）', r.status === 400)
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'remove', image: '/a/1.png', maskPng: PNG }), r)
  const used = calls.filter((c) => c.name === 'remove_image')
  let deleted = false
  try { await fsp.stat(maskPathUsed); deleted = false } catch { deleted = true }
  ok('★ remove 走 remove_image 工具且回显结果',
    r.status === 200 && r.body.ok === true && used.length === 1 && typeof used[0].args.mask === 'string')
  ok('★★ 一次性蒙版用完即删（出图目录不堆垃圾）', deleted, maskPathUsed)
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'outpaint', image: '/a/1.png', left: 0, right: 0, up: 0, down: 0 }), r)
  ok('四向全 0 拒绝（避免白跑一次出图）', r.status === 400)
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'outpaint', image: '/a/1.png' }), r)
  const used = calls.filter((c) => c.name === 'outpaint_image')
  ok('扩图不填方向时默认向右 50%', r.status === 200 && used.length === 1 && used[0].args.right === 50,
    JSON.stringify(used[0]?.args))
}
{
  const r = mkRes()
  await quickEditHandler(mkReq({ action: 'upscale', image: '/a/1.png', scale: 999 }), r)
  const used = calls.filter((c) => c.name === 'upscale_image')
  ok('★ 放大倍数 clamp 到 16（不把离谱值喂给工具）', used.length === 1 && used[0].args.scale === 16,
    String(used[0]?.args.scale))
}
{
  const noTool = { ...deps, getTool: () => null }
  const h = makeUiEditHandlers(noTool)
  const r = mkRes()
  await h.quickEditHandler(mkReq({ action: 'upscale', image: '/a/1.png', scale: 2 }), r)
  ok('工具未注册时明确 503，不假装成功', r.status === 503)
}
try { await fsp.rmdir(tmp) } catch { /* 空目录留着也无害 */ }

console.log('\n[3] 装完之后的引导不能回退')
ok('★ INSTALL 第五节已重写成「装完第一件事」', INSTALL.includes('装完第一件事：验证 → 上手 → 功能速查'))
ok('★ 功能速查表覆盖圈选重绘 / 移除 / 扩图 / 放大 / 视频选帧',
  ['圈选重绘', '移除', '四向扩图', '高清放大', '图片编辑台', '视频选帧'].every((s) => INSTALL.includes(s)))
ok('★ 过期的「应该弹出两组菜单」已删', !INSTALL.includes('应该弹出两组菜单'))
ok('★ 有「没反应怎么自查」清单', INSTALL.includes('按顺序自查'))
ok('★ 一键安装脚本装完会讲功能入口（不再只说重启 + 画猫）',
  QUICK.includes('圈选重绘') && QUICK.includes('更多编辑') && QUICK.includes('五、装完第一件事'))
ok('★ 给 DSH 的安装话术补了「装完之后」段',
  DSH.includes('④ 装完之后') && DSH.includes('不要只回一句'))
ok('★ README 首屏有「功能在哪点」', read('README.md').includes('快速上手 · 功能在哪点'))

console.log('\n[4] 体积红线')
{
  const sizes = readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, size: statSync(path.join(ROOT, 'lib', f)).size }))
  const over = sizes.filter((x) => x.size > 262144)
  ok('每个 lib/*.js ≤ 262144 B（DSH Store 单文件上限）', over.length === 0, JSON.stringify(over))
}

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length > 0) {
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
