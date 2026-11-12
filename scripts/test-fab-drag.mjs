#!/usr/bin/env node
/**
 * 浮标拖动 / 开关交互回归。
 *
 * 为什么单独一套：`test-pipeline-panel.mjs` 的假 DOM 没有 `window.PointerEvent`，
 * 走的是「无 PE 环境」的 click 兜底分支 —— Pointer Events 的拖动与 tap/drag 分离
 * 根本没被执行过。这里补一个带 PointerEvent / localStorage / getBoundingClientRect
 * 的假 DOM，真派发 pointerdown/move/up，把两件事钉成断言：
 *
 *   ① 纯点按由 pointerup 判定并开关面板（不再依赖会被吞掉的 click）；
 *   ② rebuild() 换掉 panel 之后仍能再打开 —— 旧代码把开关闭包缓存了第一个 panel，
 *      切一次模式后判断永久卡在 close() 分支，面板再也打不开（"点不动"）。
 *
 * 交互层任何 API 都带 typeof 守卫，本套同时充当「真 PE 环境下 mount 不抛错」的验证。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')
const FAB_POS_KEY = 'comfyPipelineFabPos'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- 假 DOM：够 render() + wire() + 一套 pointer 手势跑完 ----
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '', id: '', textContent: '', value: '', type: '',
    min: '', max: '', step: '', title: '', href: '', rel: '', src: '',
    defer: false, disabled: false, hidden: false,
    offsetWidth: 132, offsetHeight: 42,
    style: {},
    children: [], listeners: {}, parentNode: null,
    _classes() { return String(this.className).split(/\s+/).filter(Boolean) },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c) },
      remove(c) { this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { left: 100, top: 700, width: 132, height: 42 } },
    contains(other) {
      if (other === this) return true
      return this.children.some((c) => (typeof c.contains === 'function' ? c.contains(other) : false))
    },
    querySelector(sel) {
      const raw = String(sel); const byClass = raw.startsWith('.')
      const want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => (byClass ? c._classes().includes(want) : c.tagName === want)
      const walk = (n) => {
        for (const c of n.children) { if (hit(c)) return c; const f = walk(c); if (f) return f }
        return null
      }
      return walk(this)
    },
    querySelectorAll(sel) {
      const raw = String(sel); const byClass = raw.startsWith('.')
      const want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => (byClass ? c._classes().includes(want) : c.tagName === want)
      const out = []
      const walk = (n) => { for (const c of n.children) { if (hit(c)) out.push(c); walk(c) } }
      walk(this)
      return out
    },
  }
  return node
}

const body = makeNode('body')
const document = {
  readyState: 'loading',
  body,
  createElement: (tag) => makeNode(tag),
  addEventListener() {},
  getElementById: () => null,
}

const store = {}
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
}

const SCHEMA = {
  version: 1,
  modes: [
    { id: 'image', label: '生图模式', backends: ['qwen21'], deliver: 'png' },
    { id: 'video', label: '视频模式', backends: ['wan22'], deliver: 'mp4' },
    { id: 'hybrid', label: '混合模式', chain: ['image', 'tts', 'video'], deliver: 'mp4+wav' },
  ],
  controls: {
    common: [
      { key: 'aspect', type: 'slider', min: 0, max: 6, step: 1, ticks: ['1:1', '3:4', '4:3', '2:3', '3:2', '16:9', '9:16'], default: 0 },
      { key: 'speedPercent', type: 'slider', min: 25, max: 100, step: 5, default: 100 },
    ],
    video: [],
    advanced: [
      { key: 'seed', type: 'number', min: -1, max: 2 ** 32 - 1, default: -1 },
      { key: 'count', type: 'number', min: 1, max: 4, step: 1, default: 1 },
      { key: 'steps', type: 'slider', min: 4, max: 40, step: 1, default: 8 },
      { key: 'fps', type: 'slider', min: 8, max: 30, step: 1, default: 24 },
      { key: 'denoise', type: 'slider', min: 0.1, max: 1, step: 0.05, default: 0.85 },
      { key: 'tileSize', type: 'slider', min: 256, max: 1024, step: 128, default: 512 },
      { key: 'chunkOverlap', type: 'slider', min: 0, max: 16, step: 2, default: 8 },
      { key: 'frames', type: 'slider', min: 9, max: 81, step: 4, default: 49 },
      { key: 'motion', type: 'slider', min: 0, max: 10, step: 1, default: 5 },
    ],
  },
  speedMap: { image: { 100: { size: 1024 } }, video: {} },
  speedTiers: [25, 50, 75, 100],
}

const noopTimer = () => 0
const fetch = (url, init) => {
  const u = String(url)
  const isPost = Boolean(init && init.method === 'POST')
  if (u.includes('controls')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      ok: true, saved: true,
      controls: { mode: 'image', aspect: 0, speedPercent: 100, seed: -1, steps: 8, count: 1, fps: 24, denoise: 0.85, tileSize: 512, chunkOverlap: 8, frames: 49, motion: 5 },
      summary: '就绪',
    }) })
  }
  if (u.includes('library')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, styles: [], skillsAvailable: [], selected: 'none', instruction: '', skills: [] }) })
  }
  if (u.includes('modes')) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  if (u.includes('progress')) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  void isPost
}

const window = {
  PointerEvent: function PointerEvent() {}, // ★ 让 wire() 走 Pointer Events 分支
  innerWidth: 1280, innerHeight: 800,
  localStorage,
  ComfyPipelineSchema: SCHEMA,
  document,
  fetch,
  setTimeout: noopTimer, clearTimeout() {}, setInterval: noopTimer, clearInterval() {},
}

const sandbox = {
  window, document, fetch, console,
  setTimeout: noopTimer, clearTimeout() {}, setInterval: noopTimer, clearInterval() {},
  Promise, Number, Math, JSON, Object, Array, String, Set, Boolean,
}
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'assets/panel.js' })

const panel = sandbox.window.ComfyPipelinePanel
ok('window.ComfyPipelinePanel 带 __cp 哨兵', Boolean(panel && panel.__cp === true))

const mounted = await panel.mount().then(() => true).catch((err) => { console.log('   mount 抛错：', err && err.message); return false })
ok('★ PE 环境下 mount() 真跑一遍不抛错', mounted === true)

await new Promise((r) => setTimeout(r, 0)) // 放行 loadLibrary 的 paintLibrary
const fab = body.querySelector('.cp-fab')
let panelEl = body.querySelector('.cp-panel')
ok('浮标与面板都挂到 body', Boolean(fab) && Boolean(panelEl))
ok('面板初始收起（hidden=true）', panelEl && panelEl.hidden === true)
ok('★ wire() 走 Pointer Events 分支（注册了 pointerdown）',
  Boolean(fab && fab.listeners.pointerdown && fab.listeners.pointerdown.length >= 1))

const fire = (type, ev) => {
  const list = (fab && fab.listeners[type]) || []
  for (const fn of list) fn(ev)
}
const pt = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} })

// ---- ① 纯点按：pointerup 判定开关 ----
fire('pointerdown', pt(100, 100))
fire('pointerup', pt(100, 100))
ok('★ 点按一次 → 面板打开（由 pointerup 判定，不依赖 click）', panelEl.hidden === false)
fire('pointerdown', pt(100, 100))
fire('pointerup', pt(101, 101)) // 1px 位移仍在阈值内，算点按
ok('★ 再点按 → 面板关闭（轻移 ≤5px 仍算点按）', panelEl.hidden === true)

// ---- ② 拖动：不 toggle、改位置、落盘、清拖动态 ----
const leftBefore = fab.style.left
fire('pointerdown', pt(100, 100))
fire('pointermove', pt(200, 160))
fire('pointerup', pt(200, 160))
ok('★ 拖动后不误开面板（tap/drag 分离）', panelEl.hidden === true)
ok('★ 拖动改写了浮标坐标', fab.style.left !== leftBefore && typeof fab.style.left === 'string',
  `${leftBefore} → ${fab.style.left}`)
ok('★ 拖动后 is-dragging 已清除', !fab.classList.contains('is-dragging'))
ok('★ 拖动位置落盘 localStorage', typeof store[FAB_POS_KEY] === 'string' && store[FAB_POS_KEY].includes('left'),
  String(store[FAB_POS_KEY]))
panel.open()
ok('★ 打开时面板跟随浮标（left/top 被设置）',
  typeof panelEl.style.left === 'string' && typeof panelEl.style.top === 'string',
  `${panelEl.style.left} / ${panelEl.style.top}`)
panel.close()

// ---- ③ 根因：rebuild（切模式）后仍能再打开 ----
const tabs = panelEl.querySelectorAll('.cp-tab')
const videoTab = tabs.find((t) => String(t.textContent).includes('视频'))
ok('拿到视频模式 tab', Boolean(videoTab))
videoTab.listeners.click.forEach((fn) => fn({ target: null }))
await new Promise((r) => setTimeout(r, 0))
panelEl = body.querySelector('.cp-panel') // rebuild 换了节点
ok('★ 切模式后 panel 已重建为新节点', Boolean(panelEl))
fire('pointerdown', pt(300, 300))
fire('pointerup', pt(300, 300))
ok('★★ rebuild 后点按仍能打开面板（旧代码在这里永久卡 close = 「点不动」）',
  panelEl.hidden === false)
fire('pointerdown', pt(300, 300))
fire('pointerup', pt(300, 300))
ok('★★ rebuild 后还能再关闭（状态机没卡死）', panelEl.hidden === true)

// ---- ④ 键盘兜底 ----
fire('keydown', { key: 'Enter', preventDefault() {} })
ok('★ 键盘 Enter 能开关面板', panelEl.hidden === false)
fire('keydown', { key: ' ', preventDefault() {} })
ok('★ 键盘 Space 能开关面板', panelEl.hidden === true)

// ---- ⑤ 源码级：开关判定读当前 nodes.panel，不再缓存旧引用 ----
ok('★ 源码不再有「缓存 panel.hidden 再判断」的旧模式',
  SRC.indexOf('panel.hidden ? open() : close()') < 0)
ok('★ toggle() 读当前 nodes.panel.hidden',
  SRC.includes('if (nodes.panel.hidden) open(); else close()'))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
