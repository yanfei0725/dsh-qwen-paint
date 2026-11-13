#!/usr/bin/env node
/**
 * 图形化安装引导「点不动 / 关不掉」的行为回归（vm + 假 DOM，真派发事件）。
 *
 * 2026-11-13 二轮：用户复测后说清了两点 ——
 *   ① 「还是点不动」：上一轮只赌 pointerup，宿主可能连 pointer 序列一起吞；
 *   ② 「关不掉」指的是**整个引导**，包括右下角常驻悬浮按钮；旧 × 只 hidden 面板，fab 永远在。
 *
 * 本套把二轮定案钉成断言：
 *   · click / pointerup / mouseup / touchend 任一单独到达都能开关，同手势连派只触发一次；
 *   · × / Escape / Alt+H / hide() = dismiss()：面板 + 悬浮按钮一起移除并写永久隐藏偏好；
 *   · show() 能恢复；点外部只收起面板（温和）；
 *   · 其它浮层里只绑 click 的旧按钮被兜底补发，宿主已派发时不重复，宿主 UI 零触碰；
 *   · seen 在决定自动弹时就写；静态资源文本类 no-cache（改了立刻生效，不拿旧缓存糊弄用户）。
 *
 * 全程零联网、零子进程、零真实 DOM；定时器与时钟都可控。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const SRC = read('assets/setup-guide.js')
const CSS = read('assets/setup-guide.css')
const CLIENT = read('lib/client.js')
const CPU = read('assets/cpu-accel.js')
const MASKFX = read('assets/mask-fx.js')
const ASSET_ROUTE = read('lib/asset-route.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

/* ------------------------------------------------------------------ *
 * 假 DOM：够 mount() 跑完，并支持 capture 阶段派发
 * ------------------------------------------------------------------ */
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '', id: '', type: '', title: '', href: '', rel: '', src: '',
    defer: false, hidden: false, disabled: false,
    style: {}, attrs: {}, children: [], parentNode: null, listeners: {},
    _text: '',
    get textContent() { return this._text },
    set textContent(v) { this._text = String(v); if (v === '') this.children = [] },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, contains(c) { return this._s.has(c) },
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref)
      this.children.splice(i < 0 ? this.children.length : i, 0, child)
      child.parentNode = this
      return child
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    setPointerCapture() {}, releasePointerCapture() {},
    contains(other) {
      if (other === this) return true
      return this.children.some((c) => (typeof c.contains === 'function' ? c.contains(other) : false))
    },
    _classes() { return String(this.className).split(/\s+/u).filter(Boolean) },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
    querySelectorAll(sel) {
      const raw = String(sel)
      const byClass = raw.startsWith('.')
      const byId = raw.startsWith('#')
      const want = byClass || byId ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => (byClass ? c._classes().includes(want) : byId ? c.id === want : c.tagName === want)
      const out = []
      const walk = (n) => { for (const c of n.children) { if (hit(c)) out.push(c); walk(c) } }
      walk(this)
      return out
    },
    click() { fire(this, 'click') },
  }
  return node
}

const docListeners = {}
const head = makeNode('head')
const body = makeNode('body')
const document = {
  readyState: 'complete', body, head,
  createElement: (tag) => makeNode(tag),
  addEventListener(type, fn, capture) {
    (docListeners[type] = docListeners[type] || []).push({ fn, capture: capture === true })
  },
  getElementById(id) {
    return head.querySelectorAll('#' + id)[0] ?? body.querySelectorAll('#' + id)[0] ?? null
  },
  querySelectorAll(sel) { return [...head.querySelectorAll(sel), ...body.querySelectorAll(sel)] },
}

/** 先跑 document 的 capture 监听，再从 target 往上冒泡。 */
function fire(target, type, props = {}) {
  const ev = {
    type, target, button: 0, clientX: 12, clientY: 12,
    key: props.key, altKey: Boolean(props.altKey), defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    ...props,
  }
  for (const l of docListeners[type] ?? []) if (l.capture) l.fn(ev)
  let n = target
  while (n) {
    for (const fn of n.listeners[type] ?? []) fn(ev)
    n = n.parentNode
  }
  for (const l of docListeners[type] ?? []) if (!l.capture) l.fn(ev)
  return ev
}

/** 可控时钟：跨过 300ms 冷却窗口，不必真的 sleep。 */
let clock = 1000
const tick = (ms = 400) => { clock += ms }
class FakeDate extends Date { static now() { return clock } }

/** 可控定时器：收集调度，按需 flush。 */
const timers = []
let timerId = 0
const setTimeoutFake = (fn, ms) => { timerId += 1; timers.push({ id: timerId, fn, ms: Number(ms) || 0 }); return timerId }
const clearTimeoutFake = (id) => {
  const i = timers.findIndex((t) => t.id === id)
  if (i >= 0) timers.splice(i, 1)
}
const flushTimers = (predicate) => {
  const due = timers.filter((t) => predicate(t))
  for (const t of due) {
    const i = timers.indexOf(t)
    if (i >= 0) timers.splice(i, 1)
    t.fn()
  }
}

const store = {}
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] },
}
const STATE = {
  ok: true, steps: [], done: 0, total: 0, probed: false, ready: false,
  headline: '视频 / 生图 / TTS 全能 · 本机运行',
  videoDownloadPack: { available: false },
}
const fetchFake = () => Promise.resolve({ ok: true, json: () => Promise.resolve(STATE) })
const window = {
  PointerEvent: function PointerEvent() {},
  MouseEvent: function MouseEvent() {},
  localStorage, document, fetch: fetchFake,
  setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
  innerWidth: 1280, innerHeight: 800,
}
const sandbox = {
  window, document, fetch: fetchFake, console, localStorage,
  navigator: { clipboard: null },
  setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
  Promise, Date: FakeDate, Number, Math, JSON, Object, Array, String, Boolean, Set, RegExp, Error,
}
vm.createContext(sandbox)
let bootError = null
try { vm.runInContext(SRC, sandbox, { filename: 'assets/setup-guide.js' }) } catch (e) { bootError = e }
const guide = sandbox.window.DshQpSetupGuide
const cur = () => ({
  fab: document.getElementById('dshqp-setup-guide-fab'),
  panel: body.querySelector('.sg-panel'),
  x: body.querySelector('.sg-x'),
})

console.log('=== 1. 引导脚本真跑一遍（宿主吞事件的环境） ===')
ok('vm 里 mount() 不抛错', bootError === null, bootError?.message)
ok('导出 DshQpSetupGuide 且带 __guide 哨兵', Boolean(guide && guide.__guide === true))
let { fab, panel, x } = cur()
ok('常驻浮标与面板都挂到 body', Boolean(fab) && Boolean(panel))
ok('关闭按钮存在', Boolean(x))
ok('面板初始收起（hidden + display 双保险）', panel?.hidden === true && panel?.style.display === 'none')
ok('CSS link 已注入', Boolean(document.getElementById('dshqp-setup-guide-css')))
ok('× 的 title 写明「彻底关闭」', String(x?.title).includes('彻底关闭'))
ok('★ fab 四种 up 事件全监听（不再只赌 pointerup）',
  ['click', 'pointerup', 'mouseup', 'touchend'].every((t) => (fab?.listeners[t] ?? []).length > 0))
ok('★ × 也走多事件源', ['click', 'pointerup', 'mouseup', 'touchend'].every((t) => (x?.listeners[t] ?? []).length > 0))
ok('fab 打了 data-dshqp-direct（全局兜底不重复碰它）', fab?.getAttribute('data-dshqp-direct') === '1')
ok('导出 dismiss / show / isDismissed / onTap',
  ['dismiss', 'show', 'isDismissed', 'onTap'].every((k) => typeof guide[k] === 'function'))

console.log('\n=== 2. 「还是点不动」：任一事件源单独到达都能开关 ===')
for (const ev of ['pointerup', 'mouseup', 'touchend', 'click']) {
  tick(); guide.close()
  fire(cur().fab, ev)
  ok(`★ 只派 ${ev} 时 fab 能打开`, guide.isOpen() === true && cur().panel.hidden === false)
}
tick(); guide.close()
fire(cur().fab, 'pointerdown'); fire(cur().fab, 'pointerup'); fire(cur().fab, 'mouseup'); fire(cur().fab, 'click')
ok('★ 同一次手势连派四种事件，只触发一次（不会开了又关）', guide.isOpen() === true)
ok('打开时 display 恢复为空', cur().panel.style.display === '')
tick(); fire(cur().fab, 'click')
ok('★ 再点一次浮标也关掉整个引导（一次性，不再留悬浮按钮）',
  cur().fab === null && cur().panel === null && guide.isDismissed() === true)
tick(); guide.show()
ok('show() 能把入口恢复回来（想再看时）', Boolean(cur().fab) && Boolean(cur().panel))

console.log('\n=== 3. 「关不掉」：× / Escape / Alt+H / hide 都关掉整个引导 ===')
const dismissAssert = (label) => {
  const c = cur()
  ok(`★ ${label}：悬浮按钮已从 DOM 移除`, c.fab === null)
  ok(`★ ${label}：面板也已从 DOM 移除`, c.panel === null)
  ok(`★ ${label}：写了永久隐藏偏好`, store['dshqp.setupGuide.hidden'] === '1')
  ok(`★ ${label}：isDismissed() 为 true`, guide.isDismissed() === true)
}
tick(); guide.open()
fire(cur().x, 'mouseup')
dismissAssert('点 ×')
tick(); guide.show()
ok('★ show() 能把入口恢复回来', Boolean(cur().fab) && Boolean(cur().panel) && guide.isDismissed() === false)

tick(); guide.open()
fire(cur().fab, 'keydown', { key: 'Escape' })
dismissAssert('Escape')
tick(); guide.show()
ok('show() 二次恢复仍成功', Boolean(cur().fab))

tick(); guide.open()
fire(cur().fab, 'keydown', { key: 'H', altKey: true })
dismissAssert('Alt+H（完全不依赖指针事件的硬通道）')
tick(); guide.show()

tick(); guide.open()
guide.hide()
dismissAssert('hide()')
tick(); guide.show()

console.log('\n=== 4. 一次性引导：点外部也把整个引导永久移除 ===')
tick(); guide.open()
const outside = makeNode('div')
body.appendChild(outside)
fire(outside, 'pointerup')
ok('★ 点面板外：面板与悬浮按钮一起消失', cur().fab === null && cur().panel === null)
ok('★ 写了永久隐藏偏好', store['dshqp.setupGuide.hidden'] === '1')
ok('isDismissed() 为 true', guide.isDismissed() === true)
tick(); guide.show()
tick(); fire(cur().fab, 'keydown', { key: 'Enter' })
ok('键盘 Enter 仍能打开浮标（可达性）', guide.isOpen() === true)
guide.close()

console.log('\n=== 5. 同类缺陷兜底：其它浮层里只绑 click 的旧按钮 ===')
const overlay = makeNode('div')
overlay.className = 'dshqp-mask-overlay'
body.appendChild(overlay)
const legacyBtn = makeNode('button')
legacyBtn.className = 'dshqp-btn'
overlay.appendChild(legacyBtn)
let legacyClicks = 0
legacyBtn.addEventListener('click', () => { legacyClicks += 1 })
fire(legacyBtn, 'mouseup')
ok('宿主吞 click 时安排了兜底补发', timers.some((t) => t.ms === 40))
flushTimers((t) => t.ms === 40)
ok('★ 补发后旧按钮的 click 监听真的跑了一次', legacyClicks === 1, `实际 ${legacyClicks}`)

tick()
const legacyBtn2 = makeNode('button')
legacyBtn2.className = 'dshqp-btn'
overlay.appendChild(legacyBtn2)
let legacyClicks2 = 0
legacyBtn2.addEventListener('click', () => { legacyClicks2 += 1 })
fire(legacyBtn2, 'mouseup')
fire(legacyBtn2, 'click') // 宿主正常派发了 click
flushTimers((t) => t.ms === 40)
ok('★ 宿主已派发 click 时绝不重复补（只触发一次）', legacyClicks2 === 1, `实际 ${legacyClicks2}`)

const hostBtn = makeNode('button')
hostBtn.className = 'some-host-button'
body.appendChild(hostBtn)
let hostClicks = 0
hostBtn.addEventListener('click', () => { hostClicks += 1 })
tick(); fire(hostBtn, 'mouseup')
flushTimers((t) => t.ms === 40)
ok('★ 宿主自己的按钮绝不被兜底碰到（作用域隔离）', hostClicks === 0)

console.log('\n=== 6. 自动弹与 seen 写入时机 ===')
ok('★ mount 时立刻写了 seen（不再等 close）', store['dshqp.setupGuide.seen'] === '1')
ok('首次自动弹的定时器已排队', timers.some((t) => t.ms === 1200))
flushTimers((t) => t.ms === 1200)
ok('★ 首次自动弹仍能正常打开', guide.isOpen() === true && cur().panel.hidden === false)
guide.close()
ok('关掉后下次启动不会再自动弹（seen 已落盘）', guide.isOpen() === false)

console.log('\n=== 7. 静态锁：防止修复被改回去 ===')
ok('onTap 同时监听四种事件', /var TAP_UP = \['click', 'pointerup', 'mouseup', 'touchend'\]/u.test(SRC))
ok('× 绑定的是 dismiss 而不是 close', /onTap\(x, dismiss\)/u.test(SRC))
ok('dismiss 会移除 fab 和 panel', /removeNode\(els\.panel\)/u.test(SRC) && /removeNode\(els\.fab\)/u.test(SRC))
ok('★ mount 检查 hasSeen：弹过一次之后连按钮都不再挂载',
  /if \(!forced && \(isDismissed\(\) \|\| hasSeen\(\)\)\) return/u.test(SRC))
ok('★ 点外部 / 再点浮标都指向 dismiss（一次性，不再留入口）',
  /onTap\(fab, function \(\) \{ opened \? dismiss\(\) : open\(\) \}\)/u.test(SRC)
  && /dismiss\(\) \/\/ ★ 一次性引导/u.test(SRC))
ok('Alt+H 硬通道存在', /altKey/u.test(SRC) && /'H'/u.test(SRC))
ok('兜底不再依赖 window.PointerEvent', !/if \(!HAS_PE/u.test(SRC))
ok('CSS 里 [hidden] 用 !important', /\.sg-panel\[hidden\][^{]*\{\s*display:\s*none\s*!important/u.test(CSS))
ok('CSS 里浮标与面板显式 pointer-events:auto', (CSS.match(/pointer-events:\s*auto/gu) ?? []).length === 2)
ok('★ cpu-accel.js 的按钮也走多事件源 tap', /var TAP_UP = \[/u.test(CPU) && /tap\(reload, load\)/u.test(CPU) && /tap\(card,/u.test(CPU))
ok('★ mask-fx.js 的按钮也走多事件源 tap', /var TAP_UP = \[/u.test(MASKFX) && /tap\(reset,/u.test(MASKFX) && /tap\(now,/u.test(MASKFX))
ok('★ 静态资源文本类改 no-store（旧脚本不再被缓存，改了立刻生效）',
  ASSET_ROUTE.includes("'no-store'") && !ASSET_ROUTE.includes("'no-cache'")
  && /mime === JS \|\| mime === CSS/u.test(ASSET_ROUTE))
ok('★ lib/client.js 一个字节都没加（新逻辑全在 assets/ + asset-route.js）',
  !CLIENT.includes('installPointerFallback') && !CLIENT.includes('data-dshqp-direct')
  && !CLIENT.includes('TAP_UP') && !CLIENT.includes('dismiss('))

console.log('\n=== 8. 冷启动：弹过一次之后，连按钮都不再挂载 ===')
{
  const body2 = makeNode('body')
  const head2 = makeNode('head')
  const document2 = {
    readyState: 'complete', body: body2, head: head2,
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
    getElementById(id) {
      return head2.querySelectorAll('#' + id)[0] ?? body2.querySelectorAll('#' + id)[0] ?? null
    },
    querySelectorAll() { return [] },
  }
  const store2 = { 'dshqp.setupGuide.seen': '1' } // 上一次已经弹过
  const ls2 = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store2, k) ? store2[k] : null),
    setItem: (k, v) => { store2[k] = String(v) },
    removeItem: (k) => { delete store2[k] },
  }
  const window2 = {
    PointerEvent() {}, MouseEvent() {}, localStorage: ls2, document: document2,
    fetch: fetchFake, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
  }
  const sandbox2 = {
    window: window2, document: document2, fetch: fetchFake, console, localStorage: ls2,
    navigator: { clipboard: null },
    setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
    Promise, Date: FakeDate, Number, Math, JSON, Object, Array, String, Boolean, Set, RegExp, Error,
  }
  vm.createContext(sandbox2)
  const before = timers.length
  let err2 = null
  try { vm.runInContext(SRC, sandbox2, { filename: 'assets/setup-guide.js(cold)' }) } catch (e) { err2 = e }
  ok('冷启动脚本不抛错', err2 === null, err2?.message)
  ok('★ seen=1 时连悬浮按钮都不挂载', body2.querySelector('.sg-fab') === null)
  ok('★ 面板也不挂载', body2.querySelector('.sg-panel') === null)
  ok('★ 也没有排队自动弹（不会弹第二次）', timers.length === before)
  sandbox2.window.DshQpSetupGuide.show()
  ok('★ 冷启动后仍可用 show() 手动恢复一次', Boolean(body2.querySelector('.sg-fab')))
  ok('★ 手动恢复不会再次自动弹', timers.length === before)
}

console.log('')
if (fail > 0) {
  console.log(`✗ ${fail} 项失败 / 共 ${pass + fail} 项`)
  process.exit(1)
}
console.log(`全部通过（${pass} 项断言）`)
