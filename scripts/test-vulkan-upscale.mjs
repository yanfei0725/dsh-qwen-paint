/**
 * test-vulkan-upscale.mjs —— Vulkan 直跑超分（0.35.0 内置执行路径）专项回归。
 *
 * 断言风格：ok(名称, 条件)（本项目两种 ok() 风格之一，本文件自建 helper 并内建写反自检）。
 * 全离线、零联网、零子进程真跑（执行器用注入的假 execFile）、零出图；
 * tmp 目录用完即删。覆盖：资产与许可事实 / argv 构造与逐项 clamp / 探测诚实降级 /
 * 计划与执行边界（未安装绝不谎称）/ 文档与描述点名同步 / 体积红线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  VULKAN_UPSCALE_ENGINES, VULKAN_ENGINE_IDS, listVulkanEngines, resolveVulkanEngine,
  vulkanExePath, detectVulkanEngines, buildVulkanArgs, runVulkanUpscale,
} from '../lib/vulkan-upscale.js'
import { buildManualUpscalePlan } from '../lib/manual-upscale.js'
import { makeManualUpscaleTool } from '../lib/creative-extras.js'

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

/* ---------------- §1 目录事实（许可 / 权威字节数 / 双源） ---------------- */

ok('目录里有且只有两个 Vulkan 引擎', VULKAN_UPSCALE_ENGINES.length === 2
  && VULKAN_ENGINE_IDS.join(',') === 'realesrgan-ncnn-vulkan,realcugan-ncnn-vulkan')
ok('两个引擎许可都是 MIT', VULKAN_UPSCALE_ENGINES.every((e) => e.license === 'MIT'))
const re = resolveVulkanEngine('realesrgan-ncnn-vulkan')
const rc = resolveVulkanEngine('realcugan-ncnn-vulkan')
ok('realesrgan windows 权威字节数 2,159,606', re?.assets?.win32?.bytes === 2159606)
ok('realesrgan ubuntu 权威字节数 3,654,741', re?.assets?.linux?.bytes === 3654741)
ok('realcugan windows 权威字节数 45,977,449', rc?.assets?.win32?.bytes === 45977449)
ok('realcugan ubuntu 权威字节数 46,704,187', rc?.assets?.linux?.bytes === 46704187)
ok('全部资产只含官方 GitHub Releases 源（可执行文件不加第三方加速镜像）', VULKAN_UPSCALE_ENGINES.every((e) =>
  Object.values(e.assets).every((a) => a.url.startsWith('https://github.com/') && a.mirror === undefined)))
ok('exe 名按平台区分（win32 带 .exe）', VULKAN_UPSCALE_ENGINES.every((e) =>
  e.exeName.win32.endsWith('.exe') && !e.exeName.linux.endsWith('.exe')))
ok('scaleRange：realesrgan 2~4 / realcugan 1~3', re.scaleRange.join(',') === '2,4' && rc.scaleRange.join(',') === '1,3')

/* ---------------- §2 argv 构造与逐项 clamp ---------------- */

const a1 = buildVulkanArgs({ engineId: 'realesrgan-ncnn-vulkan', input: 'a.png', output: 'b.png', scale: 8, modelsAvailable: ['realesrgan-x4plus'] })
ok('argv 是数组且 -i 在 -o 之前', Array.isArray(a1.argv) && a1.argv[0] === '-i' && a1.argv[1] === 'a.png' && a1.argv[2] === '-o')
ok('realesrgan scale 8 → clamp 4 且有说明', a1.argv[4] === '-s' && a1.argv[5] === '4' && a1.clamps.length > 0)
ok('model 未给 → 取本机探测到的第一个', a1.usedModel === 'realesrgan-x4plus')
const a2 = buildVulkanArgs({ engineId: 'realcugan-ncnn-vulkan', input: 'a.png', output: 'b.png', scale: 8, model: 'models-pro' })
ok('realcugan scale 8 → clamp 3', a2.argv[4] === '-s' && a2.argv[5] === '3')
ok('tile 0（自动）合法', buildVulkanArgs({ engineId: 'realesrgan-ncnn-vulkan', input: 'a', output: 'b', scale: 4, model: 'm', tileSize: 0 }).argv.includes('0'))
ok('format 只认 png/jpg/webp（exe 拒绝）', buildVulkanArgs({ engineId: 'realesrgan-ncnn-vulkan', input: 'a', output: 'b', scale: 4, model: 'm', format: 'exe' }).ok === false)
ok('model 拒绝路径分隔符与 ..', buildVulkanArgs({ engineId: 'realesrgan-ncnn-vulkan', input: 'a', output: 'b', scale: 4, model: '../evil' }).ok === false
  && buildVulkanArgs({ engineId: 'realesrgan-ncnn-vulkan', input: 'a', output: 'b', scale: 4, model: 'a/b' }).ok === false)
ok('argv 里没有独立 shell 元字符 token', [a1.argv, a2.argv].every((argv) =>
  !argv.some((x) => x === ';' || x === '&&' || x === '|' || x === 'rm' || x === '-rf')))
ok('未知引擎 → ok:false', buildVulkanArgs({ engineId: 'nope', input: 'a', output: 'b' }).ok === false)

/* ---------------- §3 探测诚实降级 ---------------- */

const emptyDetect = detectVulkanEngines('')
ok('未配置安装目录 → 两引擎都 available:false 且给理由', emptyDetect.length === 2
  && emptyDetect.every((x) => x.available === false && x.reason.length > 0))
const ghostDetect = detectVulkanEngines(path.join(os.tmpdir(), 'dshqp-no-such-dir-9x'))
ok('不存在的目录 → available:false（不假装已安装）', ghostDetect.every((x) => x.available === false))

/* ---------------- §4 计划层边界（manual-upscale 集成） ---------------- */

const plan = buildManualUpscalePlan({ source: 'a.png', target: 'b.png', engine: 'realesrgan-ncnn-vulkan',
  scale: 8, denoise: 0.5, outputDir: 'T:/fence-test-out' })
ok('Vulkan 引擎的计划 ok 且 workflowDraft 为 null（不经 ComfyUI）', plan.ok === true && plan.plan?.workflowDraft === null)
ok('计划带 vulkan 执行器指引与 clamp 后倍率', plan.plan?.vulkan?.engineId === 'realesrgan-ncnn-vulkan' && plan.plan?.scale === 4)
ok('denoise > 0 被显式 ignored（不静默丢弃）', Array.isArray(plan.plan?.ignored) && plan.plan.ignored.some((x) => x.includes('denoise')))
const planC = buildManualUpscalePlan({ source: 'a.png', target: 'b.png', engine: 'realcugan-ncnn-vulkan', scale: 8, outputDir: 'T:/fence-test-out' })
ok('realcugan 计划 scale clamp 3', planC.plan?.scale === 3)
const planBad = buildManualUpscalePlan({ source: '../outside.png', target: 'b.png', engine: 'realesrgan-ncnn-vulkan', outputDir: 'T:/fence-test-out' })
ok('源穿越在计划层就被拒（围栏沿用）', planBad.ok === false)

/* ---------------- §5 执行边界（注入假 execFile，真 tmp 目录） ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-vulkan-'))
fs.writeFileSync(path.join(tmp, 'realesrgan-ncnn-vulkan.exe'), 'fake-exe')
fs.mkdirSync(path.join(tmp, 'models'))
fs.writeFileSync(path.join(tmp, 'models', 'realesrgan-x4plus.param'), 'fake')
fs.writeFileSync(path.join(tmp, 'models', 'realesrgan-x4plus.bin'), 'fake')
const detect = detectVulkanEngines(tmp)
ok('tmp 假安装目录探测：available + 模型动态列出', detect[0].available === true && detect[0].models.includes('realesrgan-x4plus'))
ok('未配置安装目录 → 执行器如实降级（degraded + 理由）', (await runVulkanUpscale({ installDir: '', engineId: 'realesrgan-ncnn-vulkan', sourcePath: 'a', outputPath: 'b' })).degraded === true)
let captured = null
const fakeExec = (exe, argv, opts, cb) => { captured = { exe, argv, opts }; setImmediate(() => cb(null)); return { on() {} } }
const runOk = await runVulkanUpscale({ installDir: tmp, engineId: 'realesrgan-ncnn-vulkan',
  sourcePath: path.join(tmp, 'in.png'), outputPath: path.join(tmp, 'out.png'),
  params: { scale: 4, model: 'realesrgan-x4plus' }, execFileFn: fakeExec })
ok('已安装 → 真实执行 executed:true 且回产物路径', runOk.executed === true && runOk.path === path.join(tmp, 'out.png'))
ok('execFile 收到 argv 数组与超时（不经 shell）', Array.isArray(captured.argv) && typeof captured.opts.timeout === 'number' && captured.argv[0] === '-i')
const BOOM = 'BOOM_MARKER-secret-detail'
const fakeFail = (exe, argv, opts, cb) => { setImmediate(() => cb(new Error(BOOM))); return { on() {} } }
const runBad = await runVulkanUpscale({ installDir: tmp, engineId: 'realesrgan-ncnn-vulkan',
  sourcePath: 'a', outputPath: 'b', execFileFn: fakeFail })
ok('执行失败 → ok:false 且固定文案不回吐原始错误', runBad.ok === false && runBad.executed === false && !String(runBad.reason).includes(BOOM))
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------- §6 工具与端点边界（creative-extras 集成） ---------------- */

const tool = makeManualUpscaleTool({ cfg: { vulkanUpscalePath: '' }, outputDir: 'T:/fence-test-out' })
const t1 = await tool.execute({ source: 'a.png', target: 'b.png', engine: 'realesrgan-ncnn-vulkan', scale: 4 })
ok('未安装引擎时工具 executed:false 且如实降级', t1.executed === false && t1.degraded === true && t1.ok === false)
ok('工具 note 绝不谎称已放大', String(t1.note).includes('未完成') && !String(t1.note).includes('产物已落盘'))
const t2 = await tool.execute({ source: 'a.png', target: 'b.png', engine: 'auto' })
ok('ComfyUI 系引擎维持原诚实边界（草案不执行）', t2.executed === false && String(t2.note).includes('未注入真实执行器'))
ok('工具超时上限放宽到 10 分钟（真实执行需要）', tool.timeoutMs === 10 * 60 * 1000)
ok('工具 output schema 带 run 字段', JSON.stringify(tool.output.schema).includes('run'))

/* ---------------- §7 文档与描述点名同步 ---------------- */

ok('tool-descriptions 点名两个引擎', read('lib/tool-descriptions.js').includes('realesrgan-ncnn-vulkan')
  && read('lib/tool-descriptions.js').includes('realcugan-ncnn-vulkan'))
ok('agent-guide 点名两个引擎（params 枚举）', read('lib/agent-guide.js').includes('realesrgan-ncnn-vulkan')
  && read('lib/agent-guide.js').includes('realcugan-ncnn-vulkan'))
ok('两份 llms 以代码字体点名两个引擎', read('llms.txt').includes('`realesrgan-ncnn-vulkan`')
  && read('llms.txt').includes('`realcugan-ncnn-vulkan`')
  && read('docs/llms.txt').includes('`realesrgan-ncnn-vulkan`')
  && read('docs/llms.txt').includes('`realcugan-ncnn-vulkan`'))
ok('UI 输入提示含两个引擎', read('assets/lab.js').includes('realesrgan-ncnn-vulkan'))
ok('setup.mjs 挂了 --vulkan-upscale 下载步', read('scripts/setup.mjs').includes('--vulkan-upscale')
  && read('scripts/setup.mjs').includes('runVulkanUpscaleStep'))
ok('schema-defaults 有 vulkanUpscalePath 配置位', read('lib/schema-defaults.js').includes('vulkanUpscalePath'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-vulkan-upscale.mjs'))

/* ---------------- §8 体积红线 ---------------- */

ok('lib/vulkan-upscale.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'vulkan-upscale.js')).size <= 262144)
ok('下载目录脚本存在且导入同一数据源', fs.existsSync(path.join(ROOT, 'scripts', 'vulkan-upscale-catalog.mjs'))
  && read('scripts/vulkan-upscale-catalog.mjs').includes('../lib/vulkan-upscale.js'))

console.log(`\n=== test-vulkan-upscale：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
