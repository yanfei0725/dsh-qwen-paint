#!/usr/bin/env node
/**
 * `assets/panel.js` 行为回归（v3 §15.4 第 3 步的前端竖切）。
 *
 * 为什么不是"源码字符串断言"：
 *   本项目出过 `client.js:1813 Uncaught ReferenceError: data is not defined` ——
 *   语法合法、静态检查全绿、**只有真渲染才炸**，整个面板永远打不开。
 *   所以这里用 `node:vm` + 一套极简假 DOM **真跑一遍 render()**，把这类错拦在提交前。
 *
 * 覆盖：
 *   ① 非 ESM 硬约束（面板不能 import/export）
 *   ② 契约纯函数：clamp 对齐、16→4 档吸附、画幅刻度、载荷只含已知键
 *   ③ 真渲染：不抛错、浮标与面板都挂上、禁用项确实 disabled
 *   ④ 保存请求：相对路径 `api/comfy-pipeline/controls`、content-type json、body 是洗过的载荷
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- ① 非 ESM 硬约束 ----
ok('★ 面板源码零静态 import / export（<script defer> 纯脚本）',
  !/^[ \t]*import\s/m.test(SRC) && !/^[ \t]*export\s/m.test(SRC))
ok('★ 面板不碰 React 树（不 require / 不 import react）', !/require\(['"]react/.test(SRC))
ok('面板自带防双挂载哨兵（__cp === true 直接 return）', SRC.includes('existing.__cp === true'))

// ---- 极简假 DOM（够 render() 跑完，不多做） ----
function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    id: '',
    textContent: '',
    value: '',
    type: '',
    min: '',
    max: '',
    step: '',
    title: '',
    href: '',
    rel: '',
    src: '',
    defer: false,
    disabled: false,
    hidden: false,
    style: {},
    children: [],
    listeners: {},
    _classes() { return String(this.className).split(/\s+/).filter(Boolean) },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    contains(other) {
      if (other === this) return true
      return this.children.some((c) => (typeof c.contains === 'function' ? c.contains(other) : false))
    },
    querySelector(sel) {
      const raw = String(sel)
      const byClass = raw.startsWith('.')
      const want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => (byClass ? c._classes().includes(want) : c.tagName === want)
      const walk = (n) => {
        for (const c of n.children) {
          if (hit(c)) return c
          const found = walk(c)
          if (found) return found
        }
        return null
      }
      return walk(this)
    },
    querySelectorAll(sel) {
      const raw = String(sel)
      const byClass = raw.startsWith('.')
      const want = byClass ? raw.slice(1) : raw.toUpperCase()
      const hit = (c) => (byClass ? c._classes().includes(want) : c.tagName === want)
      const out = []
      const walk = (n) => {
        for (const c of n.children) {
          if (hit(c)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
    classList: { add() {}, remove() {} },
  }
  return node
}

const body = makeNode('body')
const head = makeNode('head')
const posted = []
const document = {
  readyState: 'loading', // 自挂载只登记监听，测试自己决定什么时候 mount
  body,
  head,
  createElement: (tag) => makeNode(tag),
  addEventListener() {},
  getElementById: () => null,
}
const calls = []
const fetch = (url, init) => {
  calls.push({ url, init })
  if (String(url).includes('schema')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        schema: {
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
            ],
          },
          speedMap: {
            image: { 100: { size: 1024, steps: 8, refs: 16 }, 75: { size: 896, steps: 8, refs: 8 }, 50: { size: 768, steps: 4, refs: 4 }, 25: { size: 640, steps: 4, refs: 1 } },
            video: { 100: {}, 75: {}, 50: {}, 25: {} },
          },
          speedTiers: [25, 50, 75, 100],
          eta: { formula: 'baseMs(mode) × (speed/100) × (frames/49) × (h/720)²', label: '估算' },
        },
      }),
    })
  }
  if (String(url).includes('controls')) {
    const isPost = Boolean(init && init.method === 'POST')
    const bodyJson = isPost && init.body ? JSON.parse(init.body) : null
    if (isPost) posted.push({ url, init, body: bodyJson })
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        saved: true,
        reason: '',
        controls: { mode: 'image', aspect: 0, speedPercent: 100, seed: -1, steps: 8, count: 1, fps: 24, denoise: 0.85, tileSize: 512, chunkOverlap: 8 },
        summary: '生图模式 · 1:1 · 速度 100%',
      }),
    })
  }
  return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
}

const sandbox = { window: {}, document, fetch, console, setTimeout, clearTimeout, Number, Math, JSON, Object, Array, String }
sandbox.window.document = document
sandbox.window.fetch = fetch
sandbox.window.setTimeout = setTimeout
sandbox.window.clearTimeout = clearTimeout
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'assets/panel.js' })

const panel = sandbox.window.ComfyPipelinePanel
ok('脚本执行后 window.ComfyPipelinePanel 存在且带 __cp 哨兵', Boolean(panel && panel.__cp === true))
ok('导出 mount/open/close/getState 四个函数 + api 对象',
  ['mount', 'open', 'close', 'getState'].every((k) => typeof panel[k] === 'function')
  && panel.api !== null && typeof panel.api === 'object')

// ---- ③ 真渲染 ----
const before = body.children.length
const mounted = await panel.mount().then(() => true).catch((err) => { console.log('   mount 抛错：', err && err.message); return false })
ok('★★ mount() 真跑一遍 render() 不抛错（对照历史 data is not defined）', mounted === true)

// ---- ② 纯函数（mount 之后跑：契约是 mount 时才从端点上取到的） ----
const api = panel.api
ok('★ 16 档吸附：63 → 75、40 → 50、25 → 25、100 → 100',
  api.quantize(63) === 75 && api.quantize(40) === 50 && api.quantize(25) === 25 && api.quantize(100) === 100,
  [63, 40, 25, 100].map((v) => `${v}→${api.quantize(v)}`).join(' '))
ok('★ 画幅刻度 7 项（与 config.js 的 ASPECTS 同源）',
  api.aspectTicks().length === 7 && api.aspectTicks()[5] === '16:9', api.aspectTicks().join(','))
ok('clamp 按 step 从 min 起算：speedPercent 63 → 65',
  api.clampByDef({ min: 25, max: 100, step: 5 }, 63) === 65, String(api.clampByDef({ min: 25, max: 100, step: 5 }, 63)))
ok('clamp 越界夹住：speedPercent 999 → 100 / -5 → 25',
  api.clampByDef({ min: 25, max: 100, step: 5 }, 999) === 100 && api.clampByDef({ min: 25, max: 100, step: 5 }, -5) === 25)
ok('★★ seed = -1 不被夹成 0（min=-1 才保得住"随机"）',
  api.buildPayload({ seed: -1 }).seed === -1, String(api.buildPayload({ seed: -1 }).seed))
ok('载荷只含契约里的键（未知键丢弃）',
  !('evil' in api.buildPayload({ evil: 1, speedPercent: 50 })),
  JSON.stringify(api.buildPayload({ evil: 1, speedPercent: 50 })))
ok('非法 mode 退回 image', api.buildPayload({ mode: 'nonsense' }).mode === 'image')
ok('速度档的边长/参考图上限取自契约 SPEED_MAP',
  api.speedEdge(25) === 640 && api.speedRefs(100) === 16, `${api.speedEdge(25)}/${api.speedRefs(100)}`)
ok('describe 标「吸附」而非谎称精确档位', /吸附 \d+ 档/.test(api.describe({ aspect: 5, speedPercent: 100 })))

const fab = body.querySelector('.cp-fab')
const panelEl = body.querySelector('.cp-panel')
ok('浮标与面板都已挂到 body', Boolean(fab) && Boolean(panelEl), `body 子节点 ${body.children.length - before}`)
ok('面板初始是收起的（hidden）', panelEl && panelEl.hidden === true)
panel.open()
ok('open() 后 hidden=false', panelEl && panelEl.hidden === false)
const tabs = panelEl.querySelectorAll('.cp-tab')
ok('三个模式 tab 都在', tabs.length === 3, String(tabs.length))
ok('★ 视频/混合 tab 是 disabled（后端未接入，不装能拨的假滑块）',
  tabs.filter((t) => t.disabled === true).length === 2, tabs.map((t) => `${t.textContent}:${t.disabled}`).join(','))
ok('未接入原因写进了 note（不是静默禁用）',
  String(panelEl.querySelector('.cp-note').textContent).includes('后端工作流尚未接入'))
const fields = panelEl.querySelectorAll('.cp-field')
ok('常用 2 项 + 高级 7 项都渲染出来了', fields.length === 9, String(fields.length))
const disabledInputs = panelEl.querySelectorAll('input').filter((i) => i.disabled === true)
ok('★ fps/denoise/tileSize/chunkOverlap 四项输入确实 disabled',
  disabledInputs.length === 4, String(disabledInputs.length))
const ranges = panelEl.querySelectorAll('input').filter((i) => i.type === 'range')
ok('滑块走 input[type=range]（速度%、steps、画幅等）', ranges.length >= 3, String(ranges.length))

// ---- ④ 保存请求 ----
const speedInput = panelEl.querySelectorAll('input').find((i) => i.type === 'range' && i.min === '25' && i.max === '100')
ok('速度滑块 min/max 来自契约（25..100）', Boolean(speedInput), speedInput ? `${speedInput.min}..${speedInput.max}` : '缺')
speedInput.value = '63'
speedInput.listeners.input.forEach((fn) => fn({ target: speedInput }))
await new Promise((r) => setTimeout(r, 420))
ok('拨滑块后发出了一次 POST', posted.length === 1, String(posted.length))
ok('★ POST 走相对路径 api/comfy-pipeline/controls（同源，非绝对外部地址）',
  posted[0] && posted[0].url === 'api/comfy-pipeline/controls', posted[0] ? posted[0].url : '无')
ok('POST 带 content-type: application/json', posted[0] && posted[0].init.headers['content-type'] === 'application/json')
ok('★ POST body 是洗过的载荷（63 → 65 已对齐）',
  posted[0] && posted[0].body.speedPercent === 65, posted[0] ? String(posted[0].body.speedPercent) : '无')
ok('POST body 不含未声明的键', posted[0] && !('evil' in posted[0].body))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
