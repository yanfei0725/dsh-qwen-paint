/**
 * scripts/test-animation-kit.mjs —— 自研轻量代码动画三件套回归。
 * 断言签名铁律：ok(label, cond, detail)，标签在第一个参数。
 * 覆盖：分镜切句与画面类型推断、SVG 五种渲染、image 降级到 draw_image、
 *      合成 argv 构建（含字幕/配音）、路径围栏、未注入执行器降级、接线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)
let passed = 0, failed = 0
function ok(label, cond, detail) {
  if (cond) { passed += 1; console.log('  OK  ', label) }
  else { failed += 1; console.log('  FAIL', label, detail === undefined ? '' : `→ ${detail}`) }
}
function eq(a, e, label) { ok(label, JSON.stringify(a) === JSON.stringify(e), `实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(e)}`) }
function section(t) { console.log(`\n=== ${t} ===`) }

const kit = await imp('lib/animation-kit.js')
const wrote = []
const [sb, rf, cv] = kit.makeAnimationTools({
  outputDir: '\x4B:/fake/output',
  writeFile: async (p, c) => { wrote.push({ p, c }) },
})

section('工具1 plan_storyboard（分镜编排）')
{
  ok('画面类型推断：公式', kit.inferVisualType('看向量的叉乘公式') === 'formula')
  ok('画面类型推断：流程', kit.inferVisualType('算法按步骤执行流程图') === 'flow')
  ok('画面类型推断：图表', kit.inferVisualType('看增长趋势柱状图数据') === 'chart')
  ok('画面类型推断：简笔', kit.inferVisualType('小人走路动作') === 'stick')
  ok('画面类型推断：真实画面兜底', kit.inferVisualType('一只橘猫坐在窗边') === 'image')
  const r = await sb.execute({ script: '先看公式推导。然后算法走流程图。最后看增长趋势。', seconds: 9 })
  ok('分镜成功', r.ok === true, r.reason)
  eq(r.shots, 3, '切成 3 镜')
  eq(r.storyboard.map((s) => s.visual.type), ['formula', 'flow', 'chart'], '三镜类型正确')
  ok('时间戳均分', r.storyboard[1].from === 3 && r.storyboard[1].to === 6)
  ok('每镜有字幕/配音词/提示', r.storyboard.every((s) => s.subtitle && s.narration && s.visual.hint))
  ok('note 明说未对齐语音', r.note.includes('未与语音对齐'))
  const empty = await sb.execute({ script: '   ' })
  ok('空脚本降级', empty.ok === false && empty.reason.includes('为空'))
  const noSec = await sb.execute({ script: '一句话。' })
  ok('不给秒数按每句 3 秒', noSec.seconds === 3)
}

section('工具2 render_frame（SVG 渲染 + draw_image 降级）')
{
  for (const type of ['formula', 'flow', 'chart', 'stick', 'diagram']) {
    const r = await rf.execute({ type, hint: '示例内容 3 5 7' })
    ok(`${type} 生成完整 SVG`, r.ok === true && r.backend === 'svg' && r.svg.startsWith('<svg') && r.svg.includes('</svg>'), r.reason)
  }
  const chart = await rf.execute({ type: 'chart', hint: '数据 3 5 2 7' })
  ok('chart 用提示里的数字画柱', (chart.svg.match(/<rect/g) || []).length >= 4)
  const flow = await rf.execute({ type: 'flow', hint: '开始→处理→结束' })
  ok('flow 画三个框 + 箭头', (flow.svg.match(/<rect/g) || []).length === 4 && flow.svg.includes('marker-end'))
  const img = await rf.execute({ type: 'image', hint: '一只猫' })
  ok('image 降级到 draw_image', img.ok === false && img.backend === 'draw_image' && img.reason.includes('draw_image'))
  const bad = await rf.execute({ type: 'wat', hint: 'x' })
  ok('未知类型拒绝', bad.ok === false && bad.reason.includes('不支持'))
  const noHint = await rf.execute({ type: 'chart', hint: '' })
  ok('空提示拒绝', noHint.ok === false)
  const landed = await rf.execute({ type: 'diagram', hint: '关系图', target: 'frames/shot1.svg' })
  ok('给 target + writeFile 时落盘', landed.ok === true && landed.path.includes('shot1.svg') && wrote.length === 1, landed.reason)
  ok('落盘内容就是返回的 svg', wrote[0]?.c === landed.svg)
  const noWrite = kit.makeAnimationTools({ outputDir: '\x4B:/fake/output' })[1]
  const nw = await noWrite.execute({ type: 'diagram', hint: 'x', target: 'a.svg' })
  ok('未注入 writeFile 不假称落盘', nw.ok === false && nw.reason.includes('未注入 writeFile') && nw.svg !== '')
  const escape = await rf.execute({ type: 'diagram', hint: 'x', target: '../escape.svg' })
  ok('路径 .. 穿越被拒', escape.ok === false && escape.reason.includes('.. 穿越'))
}

section('工具3 compose_video（合成 argv + 降级）')
{
  const cmd = kit.buildComposeCommand({ frames: ['/a.png', '/b.png', '/c.png'], out: '/out.mp4', fps: 24 })
  ok('argv 首元素是 ffmpeg', cmd[0] === 'ffmpeg')
  ok('argv 数组含三帧输入', (cmd.filter((x) => x === '-i').length) === 3)
  ok('concat filter 正确', cmd.some((x) => x.includes('concat=n=3:v=1:a=0')))
  ok('H.264/yuv420p 固定', cmd.includes('libx264') && cmd.includes('yuv420p'))
  const withSrt = kit.buildComposeCommand({ frames: ['/a.png', '/b.png'], out: '/o.mp4', fps: 24, srt: '\x4B:/x/sub.srt' })
  ok('SRT 烧录进 filter', withSrt.some((x) => x.includes('subtitles=')))
  const withAudio = kit.buildComposeCommand({ frames: ['/a.png', '/b.png'], out: '/o.mp4', fps: 24, audio: '/voice.m4a' })
  ok('配音混流', withAudio.includes('/voice.m4a') && withAudio.includes('-shortest'))
  const r = await cv.execute({ frames: ['/a.png', '/b.png'], target: 'out.mp4' })
  ok('未注入执行器降级', r.ok === false && r.reason.includes('未生成 MP4') && r.command[0] === 'ffmpeg')
  const one = await cv.execute({ frames: ['/a.png'], target: 'out.mp4' })
  ok('少于 2 帧拒绝', one.ok === false && one.reason.includes('至少'))
  const esc = await cv.execute({ frames: ['/a.png', '/b.png'], target: 'C:/absolute.mp4' })
  ok('绝对路径拒绝', esc.ok === false && esc.reason.includes('相对路径'))
  // 注入假执行器 → 真执行路径
  let gotCmd = null
  const cvReal = kit.makeAnimationTools({ outputDir: '\x4B:/fake/output',
    runCommand: async (c) => { gotCmd = c; return { ok: true } } })[2]
  const okRun = await cvReal.execute({ frames: ['/a.png', '/b.png'], target: 'real.mp4' })
  ok('注入执行器后真出片', okRun.ok === true && Array.isArray(gotCmd))
  const cvFail = kit.makeAnimationTools({ outputDir: '\x4B:/fake/output',
    runCommand: async () => ({ ok: false }) })[2]
  const failRun = await cvFail.execute({ frames: ['/a.png', '/b.png'], target: 'fail.mp4' })
  ok('执行失败如实回 ok:false', failRun.ok === false && failRun.reason.includes('未生成'))
}

section('接线与体积')
{
  eq(kit.KIT_TOOL_NAMES, ['plan_storyboard', 'render_frame', 'compose_video'], 'KIT_TOOL_NAMES 常量正确')
  ok('tool-registry 已注册三工具',
    ['plan_storyboard', 'render_frame', 'compose_video'].every((n) => read('lib/tool-registry.js').includes(`'${n}'`))
    && read('lib/tool-registry.js').includes('makeAnimationTools'))
  ok('selftest 期望清单含三工具',
    ['plan_storyboard', 'render_frame', 'compose_video'].every((n) => read('scripts/selftest.mjs').includes(`'${n}'`)))
  ok('工具描述/引导已同步',
    read('lib/tool-descriptions.js').includes('plan_storyboard:')
    && read('lib/agent-guide.js').includes('compose_video: { when:'))
  const libTotal = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + Buffer.byteLength(fs.readFileSync(path.join(ROOT, 'lib', f))), 0)
  ok('lib 合计未爆 2 MB 红线', libTotal <= 2097152, `实际 ${libTotal}`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('全部通过 ✓')
