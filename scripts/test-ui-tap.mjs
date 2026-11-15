#!/usr/bin/env node
/**
 * UI 点按专项回归 —— 2026-11-15 第五次报障「悬浮球没反应 / 叉叉也点不动」。
 *
 * ## 两个真根因（实采，不是猜）
 *   ① assets/setup-guide.js::installPointerFallback() 的宿主兜底是在
 *      pointerup / mouseup / touchend 时调 target.click() **合成 click**。
 *      ⇒ 按钮必须自己绑 click 才救得活。此前 cp-fab 在 hasPointer 分支
 *      只绑 pointerup，把 cp-fab 加进兜底白名单也接不住 ⇒「没反应」。
 *   ② wire() 只在首次 mount 跑一次，绑的是 firstPanel 上的 .cp-x；
 *      rebuild() 会 render() 造全新 panel + 全新叉叉 ⇒ 旧监听随旧节点消失，
 *      叉叉永久点不动。
 *
 * ## 本套守什么
 *   ① 四事件点按 + 300ms 冷却 + 拖动抑制，用假 DOM 节点**真派发事件**验证；
 *   ② 叉叉绑定确实在 render() 里（每次重建都重绑）、wire() 不再 click-only；
 *   ③ fab 确实补绑 click，且与 setup-guide 合成 click 的链路对得上；
 *   ④ UI_BUILD 自证标记导出 / 落到浮标属性，用于分辨真机是否加载了新脚本；
 *   ⑤ 改动能生效的链路：asset-route.js 对 JS 是 no-store，client.js 按 id 去重
 *      ⇒ 必须刷新 DSH 页面才会重新拉脚本（不是改完立刻热更）。
 *
 * helper 风格：**ok(name, cond, extra)**（与 test-fab-clamp.mjs 一致）。
 * 内建写反自检：第一个参数不是字符串就抛错，杜绝 (cond, name) 写反。
 *
 * 全离线：零联网、零出图、零子进程、不依赖任何外部可执行文件。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')
const GUIDE = readFileSync(path.join(ROOT, 'assets', 'setup-guide.js'), 'utf8')
const ROUTE = readFileSync(path.join(ROOT, 'lib', 'asset-route.js'), 'utf8')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (typeof name !== 'string') throw new Error('ok() 参数顺序写反：第一个参数必须是名称字符串')
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}
// 写反自检：ok(true, true) 必须抛（说明 helper 真的在守参数顺序）
try {
  ok(true, true)
  throw new Error('helper 写反自检失效：ok(true, true) 竟然没抛')
} catch (err) {
  if (!/参数顺序写反/.test(String(err?.message))) throw err
}

// ---- 最小假 DOM：readyState=loading ⇒ 只注册 DOMContentLoaded，不触发 mount() ----
const noop = () => {}
const document = { readyState: 'loading', addEventListener: noop, head: null }
const window = { document }
const sandbox = {
  window, document, console,
  Promise, Number, Math, JSON, Object, Array, String, Set, Boolean, Date, Error, RegExp,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
}
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'assets/panel.js' })

const ui = sandbox.window.ComfyPipelinePanel
const tap = ui?.api?.tap

function makeNode() {
  const handlers = {}
  return {
    handlers,
    addEventListener(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn) },
    emit(type) { (handlers[type] || []).forEach((fn) => fn({ type })) },
    count(type) { return (handlers[type] || []).length },
  }
}

console.log('=== 1. 点按契约导出 ===')
ok('vm 加载后 window.ComfyPipelinePanel 存在且带 uiBuild', Boolean(ui) && typeof ui.uiBuild === 'string' && ui.uiBuild.length > 0, String(ui?.uiBuild))
ok('api.tap 四个成员齐全', Boolean(tap) && typeof tap.bind === 'function' && typeof tap.fire === 'function'
  && Array.isArray(tap.events) && Number.isFinite(tap.cooldownMs))
ok('★ 四种抬起事件逐字相等（含 click）', tap && tap.events.join('|') === 'click|pointerup|mouseup|touchend', tap?.events?.join('|'))
ok('冷却 300ms', tap?.cooldownMs === 300, String(tap?.cooldownMs))
ok('UI_BUILD 为本轮修正版', ui?.uiBuild === '2026-11-15.5', String(ui?.uiBuild))

console.log('=== 2. 假 DOM 真派发：四事件 / 冷却 / 抑制 / 容错 ===')
const node = makeNode()
let calls = 0
const state = tap.bind(node, () => { calls += 1 })
ok('bindTap 真的把四种事件都挂上（每种 1 个监听）',
  tap.events.every((t) => node.count(t) === 1), JSON.stringify(Object.fromEntries(tap.events.map((t) => [t, node.count(t)]))))
node.emit('click')
ok('派发 click 触发一次回调', calls === 1, String(calls))
node.emit('pointerup'); node.emit('mouseup'); node.emit('touchend')
ok('★ 同一次手势四种事件齐发仍只算一次（300ms 冷却）', calls === 1, String(calls))
state.last = 0 // 模拟时间已过冷却窗口（不 mock 全局 Date）
node.emit('mouseup')
ok('冷却窗口过后可再次触发', calls === 2, String(calls))
state.suppressUntil = Date.now() + 60000
node.emit('click')
ok('★ 拖动抑制期间任何抬起事件都不触发（拖完不误开关面板）', calls === 2, String(calls))
state.suppressUntil = 0; state.last = 0
node.emit('touchend')
ok('抑制解除后恢复可点', calls === 3, String(calls))

const shared = { last: 0, suppressUntil: 0 }
const n1 = makeNode(), n2 = makeNode()
let sharedCalls = 0
tap.bind(n1, () => { sharedCalls += 1 }, null, shared)
tap.bind(n2, () => { sharedCalls += 1 }, null, shared)
n1.emit('click'); n2.emit('mouseup')
ok('★ 两个节点共享 state 时一次手势只响应一次（fab 拖动链与兜底链不双触发）', sharedCalls === 1, String(sharedCalls))

let threw = false
const bad = makeNode()
tap.bind(bad, () => { throw new Error('故意抛错') })
try { bad.emit('click') } catch (err) { threw = true }
ok('回调抛错被 bindTap 吞掉，不冒泡卡死面板', threw === false)
ok('无 addEventListener 的假节点不抛错且返回 state',
  (() => { const s = tap.bind({}, () => {}); return s && typeof s.last === 'number' })())
ok('tapFire 空 state 首次放行、紧接着第二次拒绝',
  (() => { const s = { last: 0, suppressUntil: 0 }; return tap.fire(s) === true && tap.fire(s) === false })())

console.log('=== 3. 源码级：叉叉重建后仍生效，wire() 不再 click-only ===')
const iRender = SRC.indexOf('function render()')
const iRebuild = SRC.indexOf('function rebuild()')
const iWire = SRC.indexOf('function wire()')
const renderBody = SRC.slice(iRender, iRebuild)
const wireBody = SRC.slice(iWire, SRC.indexOf('/* ---------- 实验室资源懒加载', iWire))
ok('render() / rebuild() / wire() 三处都能定位', iRender > 0 && iRebuild > iRender && iWire > iRebuild)
ok('★★ 叉叉绑定确实在 render() 函数体内（每次重建都重绑）', renderBody.includes('bindTap(x, close)'))
ok('★★ render() 里不再有 click-only 的叉叉绑定', !renderBody.includes("addEventListener('click', close)"))
ok('★ rebuild() 确实调用 render()', /function rebuild\(\)[\s\S]{0,600}?render\(\)/u.test(SRC))
ok('★★ wire() 里不再缓存 firstPanel / 不再 querySelector(.cp-x)',
  !/var firstPanel\s*=/u.test(wireBody) && !wireBody.includes("querySelector('.cp-x')"))
ok('★ 源码里 firstPanel 只出现在注释（无悬空变量引用）',
  SRC.split('\n').filter((l) => l.includes('firstPanel')).every((l) => /^\s*(\*|\/\/)/u.test(l)),
  SRC.split('\n').filter((l) => l.includes('firstPanel') && !/^\s*(\*|\/\/)/u.test(l)).join(' | '))

console.log('=== 4. 源码级：浮标补绑 click 与宿主兜底真的对得上 ===')
ok('★★ hasPointer 分支给 fab 补绑 click / mouseup / touchend',
  SRC.includes("bindTap(fab, toggle, ['click', 'mouseup', 'touchend'], fabTap)"))
ok('★★ fab 的兜底与拖动链共享同一个 fabTap state',
  SRC.includes('var fabTap = { last: 0, suppressUntil: 0 }')
  && SRC.includes("bindTap(fab, toggle, ['click', 'mouseup', 'touchend'], fabTap)"))
ok('★★ setup-guide 的宿主兜底确实在三种抬起事件上合成 click（联动的因）',
  GUIDE.includes("var UP = ['pointerup', 'mouseup', 'touchend']") && GUIDE.includes('target.click()'))
ok('★★ cp-fab 仍在兜底白名单 SCOPE 内（上一轮修的联动没被冲掉）',
  /var SCOPE = \[[^\]]*'cp-fab'/u.test(GUIDE))
ok('★★ fab / x 都没有 data-dshqp-direct（否则兜底会主动跳过它们）',
  !/fab\.setAttribute\('data-dshqp-direct'/u.test(SRC) && !/x\.setAttribute\('data-dshqp-direct'/u.test(SRC))
ok('无 Pointer Events 的回退分支也走 bindTap 四事件',
  SRC.includes('bindTap(fab, toggle, TAP_EVENTS, fabTap)'))
ok('finish() 纯点按走 tapFire(fabTap)，不再裸调 toggle()',
  SRC.includes('if (tapFire(fabTap)) toggle()') && !SRC.includes('// 纯点按：由 pointerup 判定，不依赖会被吞掉的 click'))
ok('★ 拖动开始 / 结束 / 取消三处都设抑制（拖完不误开关）',
  (SRC.match(/fabTap\.suppressUntil = Date\.now\(\) \+ 350/gu) || []).length === 3,
  String((SRC.match(/fabTap\.suppressUntil = Date\.now\(\) \+ 350/gu) || []).length))
ok('pointerdown 解除上一次拖动抑制', SRC.includes('fabTap.suppressUntil = 0'))
ok('★★ pointerdown 重置 last（新手势可点，冷却只去同一手势的重）',
  SRC.includes('fabTap.last = 0') && SRC.includes('fabTap.suppressUntil = 0'))
ok('★★ 键盘路径不与鼠标手势共用冷却（连续点按/Enter 不被吞）',
  /keydown[\s\S]{0,300}?toggle\(\) \/\/ 键盘路径不与鼠标手势共用冷却/u.test(SRC))

console.log('=== 5. 真机生效链路 + 自证标记 ===')
ok('★★ 浮标带 data-cp-ui-build 属性（可 hover / devtools 确认真机版本）',
  SRC.includes("fab.setAttribute('data-cp-ui-build', UI_BUILD)"))
ok('★ 浮标 title 带 UI 构建号（不用开 devtools 也能看）',
  SRC.includes("fab.title = 'Comfy 控制 · UI ' + UI_BUILD"))
ok('★ UI 构建号导出到 window.ComfyPipelinePanel.uiBuild', SRC.includes('uiBuild: UI_BUILD'))
ok('★★ asset-route.js 对 JS/CSS 是 no-store（改完不会吃一小时缓存）',
  ROUTE.includes("(mime === JS || mime === CSS) ? 'no-store'"))
ok('★ panel.js 确实在 ASSET_ROUTES 里（走上面那条 no-store 路由）',
  ROUTE.includes("['/comfy-pipeline/panel.js', 'panel.js', JS]"))
ok('★ client.js 按 id 去重 ⇒ 同一页面不会重新加载脚本，必须刷新 DSH 页面',
  CLIENT.includes('document.getElementById(PANEL_JS_ID) !== null'))
ok('★ client.js 注入的正是 comfy-pipeline/panel.js',
  CLIENT.includes("script.src = 'comfy-pipeline/panel.js'"))

console.log('=== test-ui-tap：' + pass + ' 项通过，' + fail + ' 项失败 ===')
if (fail > 0) process.exitCode = 1
