/**
 * 断言风格：ok(名称, 条件)。全离线、零子进程（注入假 runArgv）。
 * 覆盖：路径围栏 / box 归一化 / 请求组装 / 结果解析 / 节点发现 / 行为级降级 /
 *       内置 exe 存在性 / 生产接线非孤儿（身份保持编排 + Rust CPU 合成底座）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PORTRAIT_ENGINE, PORTRAIT_EXE, builtinPortraitPath, isInsideOutputDir,
  normalizeBox, buildPortraitRequest, parsePortraitResult, composePortrait,
} from '../lib/local-portrait.js'
import {
  IDENTITY_NODES, discoverIdentityNodes, PORTRAIT_ROUTE_PATHS, portraitRouteTable,
} from '../lib/portrait-endpoints.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond, extra) => {
  if (cond) pass++
  else failures.push(name + (extra ? ' | ' + extra : ''))
}
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

const OUT = path.join(ROOT, 'output')
const BASE = path.join(OUT, 'base.png')
const PERSON = path.join(OUT, 'person.png')
const OUTF = path.join(OUT, 'composed.png')

console.log('=== 1. 路径围栏（出图目录内，拒越权） ===')
ok('出图目录内的路径放行', isInsideOutputDir(OUT + '/x.png', OUT) === true)
ok('.. 穿越被拒', isInsideOutputDir(OUT + '/../secret.png', OUT) === false)
ok('目录外的绝对路径被拒', isInsideOutputDir('C:/Windows/x.png', OUT) === false)
ok('空路径被拒', isInsideOutputDir('', OUT) === false)
ok('就是目录本身被拒', isInsideOutputDir(OUT, OUT) === false)

console.log('=== 2. box 归一化 ===')
ok('越界值夹进 0..1', (() => { const b = normalizeBox({ x: -1, y: 2, w: 0.5, h: 0.4 }); return b.x === 0 && b.y === 1 })())
ok('w/h>0 判 ok', normalizeBox({ w: 0.3, h: 0.6 }).ok === true)
ok('w=0 判失败', normalizeBox({ w: 0, h: 0.6 }).ok === false)
ok('NaN 不抛、归零', Number.isFinite(normalizeBox({ w: 'x' }).w))

console.log('=== 3. 请求组装（stdin JSON 形状） ===')
{
  const req = buildPortraitRequest({ base: BASE, person: PERSON, out: OUTF,
    box: { x: 0.25, y: 0.1, w: 0.5, h: 0.7 }, feather: 8, chroma: [0, 255, 0], tolerance: 40 })
  ok('op=compose', req.op === 'compose')
  ok('三路径逐字带入', req.base === BASE && req.person === PERSON && req.out === OUTF)
  ok('box 带入', req.box.x === 0.25 && req.box.w === 0.5)
  ok('feather/chroma/tolerance 带入', req.feather === 8 && req.chroma[1] === 255 && req.tolerance === 40)
  const req2 = buildPortraitRequest({ box: { w: 1, h: 1 }, feather: -1, chroma: ['x', 999, -5] })
  ok('负 feather 不写入', req2.feather === undefined)
  ok('非法 chroma 夹进 0..255', req2.chroma[1] === 255 && req2.chroma[2] === 0)
}

console.log('=== 4. 结果解析（坏输出降级，不抛） ===')
ok('成功解析', parsePortraitResult(JSON.stringify({ ok: true, out: OUTF, width: 200, height: 120 })).ok === true)
ok('失败 reason 透出', parsePortraitResult('{"ok":false,"reason":"box 错"}').reason === 'box 错')
ok('坏 JSON 降级', parsePortraitResult('not-json').ok === false)
ok('空输出降级', parsePortraitResult('').ok === false)
ok('多行只取末行 JSON', parsePortraitResult('noise\n{"ok":true,"out":"x.png"}').ok === true)

console.log('=== 5. 身份保持节点发现（发现即报 / 缺件降级） ===')
{
  const has = discoverIdentityNodes(['InstantIDNode', 'PulidApply', 'Foo'])
  ok('探到两个后端', has.backends.length === 2 && has.available === true)
  ok('节点名回填', has.backends[0].nodes.includes('InstantIDNode'))
  ok('带安装引导', has.backends[0].guide.length > 10)
  const none = discoverIdentityNodes(['KSampler', 'VAEDecode'])
  ok('无相关节点降级', none.degraded === true && none.available === false)
  ok('降级 reason 诚实（不谎称换脸）', /不能身份保持重绘|未探到/u.test(none.reason))
}

console.log('=== 6. 行为级：composePortrait（假 runArgv） ===')
{
  const builtin = { binPath: 'C:/fake/dshqp-portrait.exe', display: 'x', source: '内置' }
  const deps = { outputDir: OUT, builtin, runArgv: async (bin, args, stdinText) => {
    const req = JSON.parse(stdinText)
    return { stdout: JSON.stringify({ ok: true, out: req.out, width: 200, height: 120, engine: PORTRAIT_ENGINE }) }
  } }
  const r = await composePortrait(deps, { base: BASE, person: PERSON, out: OUTF, box: { w: 0.4, h: 0.6 } })
  ok('成功路径 ok', r.ok === true && r.degraded === false && r.engine === PORTRAIT_ENGINE)
  ok('成功带回路径', r.path === OUTF)
  // 围栏拒绝：out 越界
  const r2 = await composePortrait(deps, { base: BASE, person: PERSON, out: 'C:/Windows/x.png', box: { w: 0.4, h: 0.6 } })
  ok('out 越界被围栏拒（且不执行 exe）', r2.ok === false && r2.degraded === true)
  // 无执行器降级
  const r3 = await composePortrait({ outputDir: OUT, builtin }, { base: BASE, person: PERSON, out: OUTF, box: { w: 0.4, h: 0.6 } })
  ok('无执行器降级', r3.ok === false && /未注入命令执行器/u.test(r3.reason))
  // 执行器抛错降级，不泄漏 error.message
  const r4 = await composePortrait({ outputDir: OUT, builtin,
    runArgv: async () => { throw new Error('C:\\secret\\leak') } },
    { base: BASE, person: PERSON, out: OUTF, box: { w: 0.4, h: 0.6 } })
  ok('抛错降级不回吐本机路径', r4.ok === false && !/secret/u.test(r4.reason))
  // 回报路径二次围栏
  const r5 = await composePortrait({ outputDir: OUT, builtin,
    runArgv: async () => ({ stdout: JSON.stringify({ ok: true, out: 'C:/Windows/evil.png' }) }) },
    { base: BASE, person: PERSON, out: OUTF, box: { w: 0.4, h: 0.6 } })
  ok('合成器回报越界路径被拒', r5.ok === false && /越界/u.test(r5.reason))
  // 无内置 exe
  const r6 = await composePortrait({ outputDir: OUT, builtin: null }, { box: { w: 1, h: 1 } })
  ok('无内置 exe 降级', r6.ok === false && /未找到内置图片合成器/u.test(r6.reason))
}

console.log('=== 7. 内置 exe 与 Rust 源码存在性 ===')
ok('assets/bin 内置 exe 存在', fs.existsSync(path.join(ROOT, 'assets/bin', PORTRAIT_EXE)))
ok('exe 非空（>100KB）', (() => { try { return fs.statSync(path.join(ROOT, 'assets/bin', PORTRAIT_EXE)).size > 100000 } catch { return false } })())
ok('Rust 源码可复现构建（main.rs + Cargo.toml）',
  fs.existsSync(path.join(ROOT, 'tools-rust/dshqp-portrait/src/main.rs'))
  && fs.existsSync(path.join(ROOT, 'tools-rust/dshqp-portrait/Cargo.toml')))
ok('Cargo.lock 锁定依赖', fs.existsSync(path.join(ROOT, 'tools-rust/dshqp-portrait/Cargo.lock')))

console.log('=== 8. 生产接线非孤儿 ===')
{
  const reg = read('lib/tool-registry.js')
  ok('portraitRouteTable 已 import', /from '\.\/portrait-endpoints\.js'/u.test(reg))
  ok('portraitRouteTable 已挂进 routes', /\.\.\.portraitRouteTable\(/u.test(reg))
  ok('execStdin 传给 portrait 端点', /execStdin: deps\.execStdin \|\| defaultExecStdin/u.test(reg))
  const endpoints = read('lib/portrait-endpoints.js')
  ok('三条端点齐全（capabilities/register/compose）',
    Object.values(PORTRAIT_ROUTE_PATHS).every((p) => endpoints.includes(p)))
  ok('复用 decodeThumbDataUrl 拖拽上传', /decodeThumbDataUrl/u.test(endpoints))
  const localP = read('lib/local-portrait.js')
  ok('内置 exe 相对解析（不硬编码本机路径）', /\.\.\/assets\/bin\//u.test(localP) && /new URL\(/u.test(localP))
  ok('二次围栏在 compose 主链', /isInsideOutputDir\(parsed\.out/u.test(localP))
}
{
  const t = portraitRouteTable({ isLocalRequest: () => true, outputDir: OUT })
  ok('端点表返回 3 条路由', t.length === 3)
  ok('capabilities 是 GET', t[0].method === 'GET')
  ok('register/compose 是 POST', t[1].method === 'POST' && t[2].method === 'POST')
  ok('身份保持引导表含 InstantID/PuLID', IDENTITY_NODES.some((n) => n.id === 'instantid') && IDENTITY_NODES.some((n) => n.id === 'pulid'))
}

console.log('\n=== 结果 ===')
console.log(`通过 ${pass}，失败 ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  FAIL', f); process.exit(1) }
console.log('全部通过')
