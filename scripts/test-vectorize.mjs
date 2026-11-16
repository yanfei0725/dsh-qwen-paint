/**
 * test-vectorize.mjs —— 位图 → SVG 矢量化（0.35.0）专项回归。
 *
 * 断言风格：ok(名称, 条件)（本文件自建 helper）。全离线、零联网、零子进程真跑
 * （执行器注入假 execFile）、tmp 目录用完即删。
 * 覆盖：目录事实（许可 / 权威字节数 / 官方单源）/ argv 构造与 clamp / 探测诚实降级 /
 * 计划与执行边界（未安装绝不谎称）/ potrace 黑白位图限制 / 注册层点名与文档同步 / 体积红线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  VECTORIZE_ENGINES, VECTORIZE_ENGINE_IDS, listVectorizeEngines, resolveVectorizeEngine,
  vectorizeExePath, buildVectorizeArgs, runVectorize, makeVectorizeTool,
} from '../lib/vectorize.js'

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

/* ---------------- §1 目录事实 ---------------- */

ok('矢量化引擎有且只有 vtracer + potrace', VECTORIZE_ENGINE_IDS.join(',') === 'vtracer,potrace')
ok('vtracer 许可 MIT', resolveVectorizeEngine('vtracer')?.license === 'MIT')
ok('potrace 许可 GPL-2.0-or-later 且 manualOnly', resolveVectorizeEngine('potrace')?.license === 'GPL-2.0-or-later'
  && resolveVectorizeEngine('potrace')?.manualOnly === true)
ok('vtracer win32 权威字节数 965,231', resolveVectorizeEngine('vtracer')?.assets?.win32?.bytes === 965231)
ok('vtracer linux musl 权威字节数 1,291,110', resolveVectorizeEngine('vtracer')?.assets?.linux?.bytes === 1291110)
ok('资产只含官方 GitHub Releases 源（可执行文件不加第三方加速镜像）',
  Object.values(resolveVectorizeEngine('vtracer').assets).every((a) => a.url.startsWith('https://github.com/visioncortex/vtracer/releases/')))
ok('potrace 不进下载目录（manualOnly，无 assets）', resolveVectorizeEngine('potrace').assets === undefined)

/* ---------------- §2 argv 构造与 clamp ---------------- */

const a1 = buildVectorizeArgs({ engineId: 'vtracer', input: 'a.png', output: 'b.svg' })
ok('vtracer 位置参数：argv[0]=input argv[1]=output', a1.argv[0] === 'a.png' && a1.argv[1] === 'b.svg')
const a2 = buildVectorizeArgs({ engineId: 'vtracer', input: 'a.png', output: 'b.svg', preset: 'bw', mode: 'polygon', filterSpeckle: 999, colorPrecision: 99 })
ok('preset/mode 合法值进 argv，filter/color 被 clamp', a2.argv.includes('--preset') && a2.argv.includes('bw')
  && a2.argv.includes('-m') && a2.argv.includes('polygon') && a2.argv.includes('128') && a2.argv.includes('8'))
ok('preset 非法值 → ok:false', buildVectorizeArgs({ engineId: 'vtracer', input: 'a', output: 'b', preset: 'nope' }).ok === false)
const a3 = buildVectorizeArgs({ engineId: 'potrace', input: 'a.bmp', output: 'b.svg', turdsize: 9 })
ok('potrace argv：-s -o 输出 -t turdsize 输入', a3.argv[0] === '-s' && a3.argv[1] === '-o' && a3.argv[2] === 'b.svg' && a3.argv.includes('a.bmp'))
ok('potrace 拒绝彩色 png 并引导 vtracer', buildVectorizeArgs({ engineId: 'potrace', input: 'a.png', output: 'b.svg' }).ok === false
  && String(buildVectorizeArgs({ engineId: 'potrace', input: 'a.png', output: 'b.svg' }).reason).includes('vtracer'))
ok('未知引擎 → ok:false', buildVectorizeArgs({ engineId: 'nope', input: 'a', output: 'b' }).ok === false)
ok('argv 无独立 shell 元字符 token', [a1.argv, a2.argv, a3.argv].every((argv) =>
  !argv.some((x) => x === ';' || x === '&&' || x === '|' || x === 'rm' || x === '-rf')))

/* ---------------- §3 探测诚实降级 ---------------- */

ok('未配置 vtracerPath → exe 解析 degraded 带理由', vectorizeExePath('vtracer', {}).ok === false
  && String(vectorizeExePath('vtracer', {}).reason).includes('vtracerPath'))
ok('未配置 potracePath → 提示用户自备 exe', String(vectorizeExePath('potrace', {}).reason).includes('自备'))

/* ---------------- §4 执行边界（注入假 execFile，真 tmp 目录） ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-vtracer-'))
fs.writeFileSync(path.join(tmp, 'vtracer.exe'), 'fake-exe')
var captured = null
const runOk = await runVectorize({ engineId: 'vtracer', cfg: { vtracerPath: tmp },
  sourcePath: path.join(tmp, 'in.png'), outputPath: path.join(tmp, 'out.svg'),
  execFileFn: (exe, argv, opts, cb) => { captured = { exe, argv, opts }; setImmediate(() => cb(null)); return { on() {} } } })
ok('已安装 → executed:true 且回产物路径', runOk.executed === true && runOk.path === path.join(tmp, 'out.svg'))
ok('execFile 收到 argv 数组与超时', Array.isArray(captured.argv) && typeof captured.opts.timeout === 'number')
const BOOM = 'BOOM_MARKER-secret'
const runBad = await runVectorize({ engineId: 'vtracer', cfg: { vtracerPath: tmp },
  sourcePath: 'a.png', outputPath: 'b.svg', execFileFn: (exe, argv, opts, cb) => { setImmediate(() => cb(new Error(BOOM))); return { on() {} } } })
ok('执行失败 → 固定文案不回吐原始错误', runBad.ok === false && !String(runBad.reason).includes(BOOM))
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------- §5 工具边界 ---------------- */

const tool = makeVectorizeTool({ cfg: {}, outputDir: 'T:/fence-test-out' })
const t1 = await tool.execute({ source: 'a.png', target: 'b.svg', engine: 'vtracer' })
ok('未安装引擎时工具 executed:false 且如实降级', t1.executed === false && t1.degraded === true && t1.ok === false)
ok('工具 note 绝不谎称已矢量化', String(t1.note).includes('未安装或未配置') && !String(t1.note).includes('矢量化完成'))
const t2 = await tool.execute({ source: '../outside.png', target: 'b.svg', engine: 'vtracer' })
ok('源穿越在工具层被拒（围栏沿用）', t2.ok === false && (String(t2.reason).includes('不允许') || String(t2.reason).includes('不在允许的目录')))
const t3 = await tool.execute({ source: 'a.png', target: '../evil.svg', engine: 'vtracer' })
ok('输出穿越被拒（SVG 也必须落出图目录）', t3.ok === false)

/* ---------------- §6 注册层与文档点名同步 ---------------- */

ok('tool-registry 注册 vectorize_image', read('lib/tool-registry.js').includes("'vectorize_image'")
  && read('lib/tool-registry.js').includes('makeVectorizeTool'))
ok('tool-registry 注册两条矢量路由', read('lib/tool-registry.js').includes('vectorizeRouteTable'))
ok('integration-state 目录 +2 条', read('lib/integration-state.js').includes('/api/qwen-paint/vectorize/capabilities')
  && read('lib/integration-state.js').includes('/api/qwen-paint/vectorize'))
ok('selftest EXPECTED_TOOLS 含 vectorize_image', read('scripts/selftest.mjs').includes("'vectorize_image'"))
ok('tool-descriptions 与 agent-guide 点名', read('lib/tool-descriptions.js').includes('vectorize_image')
  && read('lib/agent-guide.js').includes('vectorize_image'))
ok('两份 llms 以代码字体点名 vectorize_image', read('llms.txt').includes('`vectorize_image`')
  && read('docs/llms.txt').includes('`vectorize_image`'))
ok('setup.mjs 挂了 --vectorize 下载步', read('scripts/setup.mjs').includes('--vectorize')
  && read('scripts/setup.mjs').includes('runVectorizeStep'))
ok('package.json files 含 vectorize-catalog.mjs', read('package.json').includes('scripts/vectorize-catalog.mjs'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-vectorize.mjs'))
ok('lab UI 有矢量化入口', read('assets/lab.js').includes('vectorize'))

/* ---------------- §7 体积红线 ---------------- */

ok('lib/vectorize.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'vectorize.js')).size <= 262144)
ok('下载目录脚本存在且导入同一数据源', fs.existsSync(path.join(ROOT, 'scripts', 'vectorize-catalog.mjs'))
  && read('scripts/vectorize-catalog.mjs').includes('../lib/vectorize.js'))

console.log(`\n=== test-vectorize：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
