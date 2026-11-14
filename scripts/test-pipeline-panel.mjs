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
// ★ 差异化测试注入**真实**的 MODE_PLANS（与 lib/mode-schema.js 同源，不复制一份防漂移）
import { MODE_PLANS } from '../lib/mode-schema.js'

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
    // ★ 差异化 UI 用 data-mode 挂根属性 ⇒ 假 DOM 也要会 set/getAttribute（真浏览器语义）
    attrs: {},
    setAttribute(name, value) { this.attrs[String(name)] = String(value) },
    getAttribute(name) { return this.attrs[String(name)] ?? null },
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
const libraryPosts = []
const referencePosts = []       // POST /reference/prefer：只该有 strategy 一个字段
const referenceSearchPosts = [] // POST /reference/search：必须逐次显式 consent
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
          version: 2,
          modePlans: MODE_PLANS,
          modes: [
            { id: 'image', label: '生图模式', backends: ['qwen21'], deliver: 'png' },
            { id: 'video', label: '视频模式', backends: ['wan22'], deliver: 'mp4' },
            { id: 'hybrid', label: '混合模式', chain: ['image', 'tts', 'video'], deliver: 'mp4+wav' },
          ],
          controls: {
            common: [
              { key: 'aspect', type: 'slider', min: 0, max: 6, step: 1, ticks: ['1:1', '3:4', '4:3', '2:3', '3:2', '16:9', '9:16'], default: 0 },
              { key: 'speedPercent', type: 'slider', min: 25, max: 100, step: 5, default: 100 },
              { key: 'negative', type: 'text', default: '', max: 300, label: '负面提示词' },
            ],
            video: [],
            advanced: [
              { key: 'seed', type: 'number', min: -1, max: 2 ** 32 - 1, default: -1 },
              { key: 'count', type: 'number', min: 1, max: 4, step: 1, default: 1 },
              { key: 'steps', type: 'slider', min: 4, max: 40, step: 1, default: 8 },
              { key: 'cfg', type: 'slider', min: 1, max: 8, step: 0.5, default: 1 },
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
  if (String(url).includes('modes')) {
    // ★ 三个模式全放行：差异化渲染的三模式都要能点进去（含混合）。
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        modes: [
          { id: 'image', available: true },
          { id: 'video', available: true },
          { id: 'hybrid', available: true },
        ],
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
        // 假服务端得**回显你提交的值**（真服务端也是这么做的：返回合并后的完整控制项），
        //   否则"切模式后 state 被回包覆盖成 image"会被误判成面板丢状态。
        controls: Object.assign({
          mode: 'image', aspect: 0, speedPercent: 100, negative: '', seed: -1, steps: 8,
          cfg: 1, count: 1, fps: 24, denoise: 0.85, tileSize: 512, chunkOverlap: 8,
        }, bodyJson || {}),
        summary: '生图模式 · 1:1 · 速度 100%',
      }),
    })
  }
  if (String(url).includes('library')) {
    const isPost = Boolean(init && init.method === 'POST')
    const bodyJson = isPost && init.body ? JSON.parse(init.body) : null
    if (isPost) libraryPosts.push(bodyJson)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        styles: [{ id: 'none', name: '不启用' }, { id: 'film', name: '胶片纪实' }],
        skillsAvailable: [
          { id: 'archify', name: 'archify', desc: '画架构图' },
          { id: 'drawio', name: 'drawio', desc: '流程图' },
        ],
        selected: 'none', instruction: '', skills: ['archify'],
      }),
    })
  }
  // 角色参考：能力快照（GET）+ 策略偏好（POST prefer）+ 逐次同意的检索（POST search）
  if (String(url).includes('reference')) {
    const isPost = Boolean(init && init.method === 'POST')
    const bodyJson = isPost && init.body ? JSON.parse(init.body) : null
    if (String(url).includes('/prefer')) {
      if (isPost) referencePosts.push({ url, body: bodyJson })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, preferred: bodyJson ? bodyJson.strategy : '', enabled: Boolean(bodyJson && bodyJson.strategy) }),
      })
    }
    if (String(url).includes('/search')) {
      if (isPost) referenceSearchPosts.push({ url, init, body: bodyJson })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true, count: 2,
          candidates: [
            { url: 'https://images.example.org/a.png', title: 'A' },
            { url: 'https://images.example.org/b.png', title: 'B' },
          ],
        }),
      })
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true, online: true, preferred: '', selected: 'universal-latent',
        selectedLabel: '通用兜底（VAEEncode → latent_image）', nodeCount: 42,
        mode: String(url).includes('mode=video') ? 'video' : 'image',
        strategies: [
          { id: 'ip-adapter-ref', label: 'IP-Adapter 参考', tier: 3, maxRefs: 4, available: false },
          { id: 'universal-latent', label: '通用兜底', tier: 0, maxRefs: 1, available: true },
        ],
        characterLock: null,
        web: { endpointPlaceholder: '<API_ENDPOINT>', consent: 'per-request-explicit', defaultAction: 'deny', outboundFields: ['query', 'limit', 'media'] },
      }),
    })
  }
  return Promise.resolve({ ok: false, json: () => Promise.resolve(null) })
}

// 面板开着时会 setInterval 轮询进度 ⇒ 假环境里也要有
const sandbox = { window: {}, document, fetch, console, setTimeout, clearTimeout, setInterval, clearInterval, Number, Math, JSON, Object, Array, String }
sandbox.window.document = document
sandbox.window.fetch = fetch
sandbox.window.setTimeout = setTimeout
sandbox.window.clearTimeout = clearTimeout
sandbox.window.setInterval = setInterval
sandbox.window.clearInterval = clearInterval
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

// loadLibrary() 在 mount 里是 fire-and-forget，放行微任务队列让 paintLibrary() 真跑完
await new Promise((r) => setTimeout(r, 0))
const fab = body.querySelector('.cp-fab')
let panelEl = body.querySelector('.cp-panel')
ok('浮标与面板都已挂到 body', Boolean(fab) && Boolean(panelEl), `body 子节点 ${body.children.length - before}`)
ok('面板初始是收起的（hidden）', panelEl && panelEl.hidden === true)
panel.open()
ok('open() 后 hidden=false', panelEl && panelEl.hidden === false)

// ★★ UI 现代化第二轮：技能改成整块可点的 Tag 胶囊（带颜色圆点），不再有原生小方块
const tags = panelEl.querySelectorAll('.cp-skill-tag')
ok('★ 技能渲染成 Tag 胶囊而不是 checkbox（原生小方块清零）',
  tags.length === 2 && panelEl.querySelectorAll('input[type=checkbox]').length === 0,
  `tags=${tags.length}`)
ok('★ 每个 Tag 都带颜色圆点', tags.every((x) => x.querySelector('.cp-skill-dot') !== null))
ok('★ 已装载的那个默认是 is-on（整块变色，不是勾左边方块）',
  tags.filter((x) => String(x.className).includes('is-on')).length === 1
  && tags.find((x) => String(x.className).includes('is-on')).value === 'archify')
const firstTag = tags[0]
firstTag.listeners.click.forEach((fn) => fn({ target: firstTag }))
ok('★ 点整块 Tag 会切状态（archify 取消 → 0 个 is-on）',
  tags.filter((x) => String(x.className).includes('is-on')).length === 0)
ok('★ 点整块 Tag 会落盘 skills', libraryPosts.length === 1
  && Array.isArray(libraryPosts[0].skills) && libraryPosts[0].skills.length === 0,
  JSON.stringify(libraryPosts))
ok('★ 面板源码里零 checkbox（防止哪天又退回原生方块）',
  SRC.indexOf("cb.type = 'checkbox'") < 0)

const tabs = panelEl.querySelectorAll('.cp-tab')
ok('三个模式 tab 都在', tabs.length === 3, String(tabs.length))
// ★ 2026-11-14 三模式差异化：假 modes 端点放行三模式，tab 全部可点。
ok('★ 三个模式 tab 全部可选（差异化渲染的前提是都能点进去）',
  tabs.every((t) => t.disabled !== true),
  tabs.map((t) => `${t.textContent}:${t.disabled}`).join(','))

// ---- ③b 生图模式：视频组整卡不渲染、视频向高级项隐藏、有自己的标语与强调色 ----
ok('★ 生图模式根元素带 data-mode=image（CSS 换强调色的钩子）',
  panelEl.getAttribute('data-mode') === 'image', String(panelEl.getAttribute('data-mode')))
ok('★ 生图模式有专属标语（不再是三个模式共用一行空白）',
  String(panelEl.querySelector('.cp-tagline').textContent).includes('千问 2.1'))
ok('★★ 生图模式不渲染视频参数卡（挂 disabled 滑块只会让人以为生图也有帧数）',
  panelEl.querySelectorAll('.cp-video-group').length === 0)
ok('★ 生图模式不渲染混合链说明卡', panelEl.querySelectorAll('.cp-tts-group').length === 0)
const fields = panelEl.querySelectorAll('.cp-field')
ok('★★ 生图模式 = 常用 3 + 高级 4（seed/steps/cfg/count）= 7 项（视频向的 denoise/tile/chunk 被藏掉）',
  fields.length === 7, String(fields.length))
const disabledInputs = panelEl.querySelectorAll('input').filter((i) => i.disabled === true)
ok('★★ 生图模式零 disabled 输入件（看得见的每一件都能用）',
  disabledInputs.length === 0, String(disabledInputs.length))
ok('★ 生图模式看不见「运动幅度」（它在视频组里）',
  !panelEl.querySelectorAll('.cp-label').some((l) => String(l.textContent).includes('运动幅度')))

// ★ 切到视频模式：DOM 重建、帧数/帧率变可用、浮标不重复
tabs.find((t) => t.textContent.includes('视频')).listeners.click.forEach((fn) => fn({ target: null }))
const panelEl2 = body.querySelector('.cp-panel')
const dis2 = panelEl2.querySelectorAll('input').filter((i) => i.disabled === true)
ok('★★ 切视频模式后：10 项 = 常用 3 + 视频 3 + 高级 4，视频组整卡回来了',
  panelEl2.querySelectorAll('.cp-field').length === 10, String(panelEl2.querySelectorAll('.cp-field').length))
ok('★ 视频组里帧数/帧率可用，只剩运动幅度禁用（disabled 0 → 1）', dis2.length === 1, String(dis2.length))
ok('★ 视频模式有自己的标语（与生图不同）',
  String(panelEl2.querySelector('.cp-tagline').textContent).includes('Wan22'))
ok('★ 根元素 data-mode 切成 video', panelEl2.getAttribute('data-mode') === 'video')
ok('★ 视频模式仍不渲染混合链说明卡', panelEl2.querySelectorAll('.cp-tts-group').length === 0)
// 假 DOM 不会把子节点文本汇总到父节点 textContent，所以按 `.cp-hint` 直接查
ok('★ 运动幅度渲染了，且写明“XT-5B 链没有这个参数”（不装假滑块）',
  panelEl2.querySelectorAll('.cp-hint').some((h) => String(h.textContent).includes('XT-5B')))
ok('★ 重建后浮标不会变成两个', body.querySelectorAll('.cp-fab').length === 1, String(body.querySelectorAll('.cp-fab').length))
ok('★ 重建后参数面板只有一个', body.querySelectorAll('.cp-panel').length === 1, String(body.querySelectorAll('.cp-panel').length))
await new Promise((r) => setTimeout(r, 460)) // scheduleSave 是 300ms 防抖
ok('切模式会发一次保存（mode 落盘）', posted.length >= 1 && posted[posted.length - 1].body.mode === 'video',
  posted.length > 1 ? String(posted[posted.length - 1].body.mode) : '没发出')
panelEl = panelEl2
const ranges = panelEl.querySelectorAll('input').filter((i) => i.type === 'range')
ok('滑块走 input[type=range]（速度%、steps、画幅等）', ranges.length >= 3, String(ranges.length))

// ---- ④ 保存请求 ----
const speedInput = panelEl.querySelectorAll('input').find((i) => i.type === 'range' && i.min === '25' && i.max === '100')
ok('速度滑块 min/max 来自契约（25..100）', Boolean(speedInput), speedInput ? `${speedInput.min}..${speedInput.max}` : '缺')
const beforeSpeed = posted.length
speedInput.value = '63'
speedInput.listeners.input.forEach((fn) => fn({ target: speedInput }))
await new Promise((r) => setTimeout(r, 460))
const last = posted[posted.length - 1]
ok('拨滑块后发出了一次 POST', posted.length === beforeSpeed + 1, `${beforeSpeed} → ${posted.length}`)
ok('★ POST 走相对路径 api/comfy-pipeline/controls（同源，非绝对外部地址）',
  last && last.url === 'api/comfy-pipeline/controls', last ? last.url : '无')
ok('POST 带 content-type: application/json', last && last.init.headers['content-type'] === 'application/json')
ok('★ POST body 是洗过的载荷（63 → 65 已对齐）',
  last && last.body.speedPercent === 65, last ? String(last.body.speedPercent) : '无')
ok('POST body 不含未声明的键', last && !('evil' in last.body))
ok('★ 切模式后再拨滑块，mode 仍是 video（state 不丢）', last && last.body.mode === 'video')

// ---- ⑤ 角色参考卡片：模型无关策略 + 逐次同意的联网检索 ----
// 全部用独立类名，绝不挤进上面锁死的「13 个 .cp-field / 6 个 disabled input」。
const refCards = panelEl.querySelectorAll('.cp-card').filter((c) => String(c.className).includes('cp-reference'))
ok('★ 角色参考是独立卡片（不占 .cp-field 名额）', refCards.length === 1, String(refCards.length))
const refSel = panelEl.querySelector('.cp-ref-select')
ok('★ 策略下拉含「不启用 / 自动协商 / 后端策略清单」', Boolean(refSel) && refSel.children.length === 4,
  refSel ? String(refSel.children.length) : '缺')
ok('★ 默认选中「不启用」（零漂移）', refSel && refSel.value === '')
ok('★★ 页面加载后不主动发任何联网检索请求（默认拒绝）', referenceSearchPosts.length === 0,
  String(referenceSearchPosts.length))
const refBtn = panelEl.querySelector('.cp-ref-search')
ok('★ 检索按钮标明「仅本次同意」（不是常开开关）',
  Boolean(refBtn) && String(refBtn.textContent).includes('仅本次同意'))
// 空查询词：点了也不出站，且如实提示
refBtn.listeners.click.forEach((fn) => fn({ target: refBtn }))
ok('★ 空查询词点了也不发请求（并如实说明没发）',
  referenceSearchPosts.length === 0
  && String(panelEl.querySelector('.cp-ref-result').textContent).includes('未发起任何联网请求'))
// 填查询词 → 一次点击 = 一次 consent:true
const refQuery = panelEl.querySelector('.cp-ref-query')
refQuery.value = '红发角色 三视图'
refQuery.listeners.input.forEach((fn) => fn({ target: refQuery }))
refBtn.listeners.click.forEach((fn) => fn({ target: refBtn }))
ok('★★ 每次检索都显式带 consent:true（一次点击只管一次）',
  referenceSearchPosts.length === 1
  && referenceSearchPosts[0].body.consent === true
  && referenceSearchPosts[0].body.query === '红发角色 三视图',
  JSON.stringify(referenceSearchPosts))
ok('★★ 出站载荷只有 query / consent / limit（不含提示词 seed 路径 凭据）',
  Object.keys(referenceSearchPosts[0].body).sort().join(',') === 'consent,limit,query',
  Object.keys(referenceSearchPosts[0].body).join(','))
await new Promise((r) => setTimeout(r, 0))
ok('★ 候选只以文本 URL 呈现（绝不渲染 img 自动下载字节）',
  panelEl.querySelectorAll('img').length === 0
  && String(panelEl.querySelector('.cp-ref-candidates').textContent).includes('https://'))
ok('★ 检索结束按钮恢复可用，同意不残留成开关', refBtn.disabled === false)
// 切策略：只发一个 id，不触发任何联网检索
refSel.value = 'auto'
refSel.listeners.change.forEach((fn) => fn({ target: refSel }))
ok('★ 切策略只 POST strategy 到 /prefer，且不触发联网检索',
  referencePosts.length === 1
  && referencePosts[0].url === 'api/comfy-pipeline/reference/prefer'
  && Object.keys(referencePosts[0].body).join(',') === 'strategy'
  && referencePosts[0].body.strategy === 'auto'
  && referenceSearchPosts.length === 1,
  JSON.stringify(referencePosts))
ok('★ 导出 getReferenceState 便于回归核对状态', typeof panel.getReferenceState === 'function')

// ---- ⑥ 混合模式：TTS 链说明卡出现、chunkOverlap 回到高级区、强调色换紫 ----
const tabsEnd = panelEl.querySelectorAll('.cp-tab')
tabsEnd.find((t) => t.textContent.includes('混合')).listeners.click.forEach((fn) => fn({ target: null }))
const panelEl3 = body.querySelector('.cp-panel')
ok('★ 混合模式根元素 data-mode=hybrid', panelEl3.getAttribute('data-mode') === 'hybrid')
ok('★ 混合模式有专属标语（提到 TTS 与不合流边界）',
  String(panelEl3.querySelector('.cp-tagline').textContent).includes('TTS')
  && String(panelEl3.querySelector('.cp-tagline').textContent).includes('不自动合流'))
ok('★★ 混合链说明卡出现（三段链：生图 → TTS → 视频；假 DOM 不汇总文本，按 hint 节点查）',
  panelEl3.querySelectorAll('.cp-tts-group').length === 1
  && panelEl3.querySelectorAll('.cp-hint').some((h) => String(h.textContent).includes('Wan22'))
  && panelEl3.querySelectorAll('.cp-hint').some((h) => String(h.textContent).includes('不自动合流')))
ok('★ 混合模式 = 11 项（常用 3 + 视频 3 + 高级 5，chunkOverlap 回来了）',
  panelEl3.querySelectorAll('.cp-field').length === 11, String(panelEl3.querySelectorAll('.cp-field').length))
const dis3 = panelEl3.querySelectorAll('input').filter((i) => i.disabled === true)
ok('★ 混合模式 disabled = 2（运动幅度 + 面板暂不开放调节的分块重叠）',
  dis3.length === 2, String(dis3.length))
ok('★ 视频组在混合模式同样可用：3 个输入件里只有运动幅度是 disabled',
  (function () {
    // 假 DOM 的选择器不支持后代语法（'.a b'），先取卡片再在卡片内查
    const card3 = panelEl3.querySelectorAll('.cp-video-group')[0]
    if (!card3) return false
    const inputs = card3.querySelectorAll('input')
    return inputs.length === 3 && inputs.filter((i) => i.disabled === true).length === 1
  })())

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
