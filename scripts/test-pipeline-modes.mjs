#!/usr/bin/env node
/**
 * 混合模式 tab 的**动态可用性**回归：vm + 假 DOM 真跑 mount()。
 * 专抓「/modes 端点说可用了、面板还写死 disabled」以及「端点挂了却把图/视频也误关」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

function makeNode(tag) {
  const node = {
    // 差异化 UI 用 data-mode 挂根属性 ⇒ 假 DOM 也要会 set/getAttribute（与真浏览器一致）
    attrs: {},
    setAttribute(name, value) { this.attrs[String(name)] = String(value) },
    getAttribute(name) { return this.attrs[String(name)] ?? null },
    tagName: String(tag).toUpperCase(), className: '', id: '', textContent: '', value: '',
    type: '', min: '', max: '', step: '', title: '', hidden: false, disabled: false,
    style: {}, children: [], listeners: {},
    _classes() { return String(this.className).split(/\s+/).filter(Boolean) },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) },
    contains(o) { return o === this || this.children.some((c) => c.contains && c.contains(o)) },
    querySelector(sel) {
      const raw = String(sel), byClass = raw.startsWith('.'), want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => byClass ? c._classes().includes(want) : c.tagName === want
      const walk = (p) => { for (const c of p.children) { if (hit(c)) return c; const f = walk(c); if (f) return f } return null }
      return walk(this)
    },
    querySelectorAll(sel) {
      const raw = String(sel), byClass = raw.startsWith('.'), want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => byClass ? c._classes().includes(want) : c.tagName === want
      const out = []
      const walk = (p) => { for (const c of p.children) { if (hit(c)) out.push(c); walk(c) } }
      walk(this)
      return out
    },
    classList: { add() {}, remove() {} },
  }
  return node
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
    video: [
      { key: 'motion', type: 'slider', min: 0, max: 100, step: 5, default: 50 },
      { key: 'duration', type: 'slider', min: 1, max: 10, step: 0.5, default: 4 },
      { key: 'frames', type: 'slider', min: 9, max: 161, step: 8, default: 49 },
    ],
    advanced: [
      { key: 'seed', type: 'number', min: -1, max: 2 ** 32 - 1, default: -1 },
      { key: 'count', type: 'number', min: 1, max: 4, step: 1, default: 1 },
      { key: 'steps', type: 'slider', min: 4, max: 40, step: 1, default: 8 },
      { key: 'fps', type: 'slider', min: 8, max: 30, step: 1, default: 24 },
      { key: 'denoise', type: 'slider', min: 0.1, max: 1, step: 0.05, default: 0.85 },
      { key: 'tileSize', type: 'slider', min: 256, max: 1024, step: 128, default: 512 },
      { key: 'chunkOverlap', type: 'slider', min: 0, max: 16, step: 2, default: 8 },
    ],
  },
  speedMap: { image: { 100: { size: 1024 }, 75: {}, 50: {}, 25: {} }, video: { 100: {}, 75: {}, 50: {}, 25: {} } },
  speedTiers: [25, 50, 75, 100],
}
const CONTROLS = {
  mode: 'image', aspect: 0, speedPercent: 100, seed: -1, steps: 8, count: 1,
  fps: 24, denoise: 0.85, tileSize: 512, chunkOverlap: 8, frames: 49, motion: 50, duration: 4,
}

/** 每个场景独立 vm —— mount() 有 nodes 短路，不能复用同一个面板对象。 */
function runScenario(modesResp) {
  const body = makeNode('body')
  const document = {
    readyState: 'loading', body, head: makeNode('head'),
    createElement: (t) => makeNode(t), addEventListener() {}, getElementById: () => null,
  }
  const calls = []
  const fetch = (url) => {
    calls.push(String(url))
    const u = String(url)
    if (u.includes('schema')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, schema: SCHEMA }) })
    if (u.includes('controls')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, controls: CONTROLS, saved: true }) })
    if (u.includes('modes')) return Promise.resolve({ ok: true, json: () => Promise.resolve(modesResp) })
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
  }
  const sandbox = {
    window: {}, document, fetch, console, setTimeout, clearTimeout, setInterval, clearInterval,
    Number, Math, JSON, Object, Array, String,
  }
  sandbox.window.document = document
  sandbox.window.fetch = fetch
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox, { filename: 'assets/panel.js' })
  return { panel: sandbox.window.ComfyPipelinePanel, calls, body }
}

const tabByText = (body, word) => body.querySelectorAll('button').filter((b) => b.className.includes('cp-tab')).find((b) => b.textContent.includes(word))

console.log('panel /modes 动态可用性回归')

// 场景 A：端点探到 TTS 后端 ⇒ hybrid 自动放行
{
  const { panel, calls, body } = runScenario({
    ok: true,
    modes: [
      { id: 'image', label: '生图模式', available: true },
      { id: 'video', label: '视频模式', available: true },
      { id: 'hybrid', label: '混合模式', available: true },
    ],
    hybrid: { available: true, tier: 'qwen3-tts', label: 'Qwen3-TTS 主模型', reason: '' },
  })
  await panel.mount()
  ok('★ mount() 真的请求了 /api/comfy-pipeline/modes', () => {
    assert.ok(calls.some((u) => u.includes('modes')))
  })
  ok('★ 探到 TTS 后端 ⇒ 三个 tab 全部可选（不再是写死 disabled）', () => {
    const tabs = body.querySelectorAll('button').filter((b) => b.className.includes('cp-tab'))
    assert.equal(tabs.length, 3)
    assert.equal(tabs.every((t) => t.disabled === false), true)
  })
  ok('★ getModes().hybrid === true（端点结果真的进了闭包状态）', () => {
    assert.equal(panel.getModes().hybrid, true)
    assert.equal(panel.getModes().image, true)
    assert.equal(panel.getModes().video, true)
  })
  ok('可用模式的 title 是「交付 …」，note 为空（没有缺件提示）', () => {
    assert.ok(tabByText(body, '混合').title.includes('交付'))
    assert.equal(body.querySelectorAll('p').filter((p) => p.className.includes('cp-note'))[0].textContent, '')
  })
}

// 场景 B：端点明确缺件 ⇒ hybrid 禁用 + 完整清单进 title
{
  const reason = '混合模式需要 TTS 段，但本机没探到可用后端。ComfyUI/models/text_encoders/ … 候选链：Qwen3-TTS 主模型…'
  const { panel, body } = runScenario({
    ok: true,
    modes: [
      { id: 'image', label: '生图模式', available: true },
      { id: 'video', label: '视频模式', available: true },
      { id: 'hybrid', label: '混合模式', available: false },
    ],
    hybrid: { available: false, tier: null, label: '', reason },
  })
  await panel.mount()
  ok('★ 缺件 ⇒ hybrid tab disabled，且图/视频不受牵连', () => {
    const tabs = body.querySelectorAll('button').filter((b) => b.className.includes('cp-tab'))
    assert.equal(tabs.find((t) => t.textContent.includes('混合')).disabled, true)
    assert.equal(tabs.filter((t) => t.disabled === true).length, 1)
  })
  ok('★ 缺件清单（ttsMissingReport）完整进 tab 的 title', () => {
    assert.ok(tabByText(body, '混合').title.includes('text_encoders'))
    assert.ok(tabByText(body, '混合').title.includes('候选链'))
  })
  ok('note 保留「本插件没有的后端段」并提示去 title 看清单', () => {
    const note = body.querySelectorAll('p').filter((p) => p.className.includes('cp-note'))[0].textContent
    assert.ok(note.includes('本插件没有的后端段'))
    assert.ok(note.includes('缺件清单见 tab 标题悬浮'))
  })
  ok('getModes().hybrid === false', () => assert.equal(panel.getModes().hybrid, false))
}

// 场景 C：端点整体挂掉 ⇒ 保持默认（图/视频可用、混合禁用），绝不误关
{
  const { panel, body } = runScenario({ ok: false })
  await panel.mount()
  ok('★ /modes 挂掉 ⇒ 安全降级回默认，不把已可用模式误关', () => {
    const tabs = body.querySelectorAll('button').filter((b) => b.className.includes('cp-tab'))
    assert.equal(tabs.filter((t) => t.disabled === true).length, 1)
    assert.equal(panel.getModes().hybrid, false)
    assert.equal(panel.getModes().image, true)
  })
}

console.log(`\n✓ 全部通过（${n} 项）`)
