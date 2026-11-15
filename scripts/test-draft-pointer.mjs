/**
 * scripts/test-draft-pointer.mjs —— 2026-11-15：草图台指针事件的**离线仿真验收**。
 *
 * ⚠ 诚实边界：这不是真机验收。真 DSH 宿主里的点按仍需要用户在浏览器里手工确认。
 *   本项目硬规矩「不为验证生成图片 / 视频 / 音频」，所以 smoke.mjs --submit
 *   （会真出一张 512 图）也**不在回归里执行**，只锁它的开关契约。
 *   本文件能证明的是：draft.js 的指针链路在可执行的假 DOM 里真的会落笔、
 *   会捕获指针、会正确收笔，且只绑 click 的旧写法已被四事件兜底取代。
 *
 * §1 静态契约  §2 假 DOM 指针序列仿真  §3 smoke.mjs 只读 / --submit 开关契约
 *
 * ⚠ 本文件统一用 ok(cond, label) 顺序；helper 内建写反自检。
 *
 * 运行：node scripts/test-draft-pointer.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const fails = []

/** ⚠ 参数顺序：cond 在前，label 在后。写反（ok(true, true)）必须当场抛。 */
function ok(cond, label) {
  if (typeof label !== 'string') throw new Error('ok() 参数顺序写反：必须是 (cond, label)')
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

const DRAFT = read('assets/draft.js')
const SMOKE = read('scripts/smoke.mjs')

/* ═════════════════ 1. 静态契约 ═════════════════ */
console.log('=== 1. draft.js 指针 / 点按 / 隐私静态契约 ===')
{
  const events = [...DRAFT.matchAll(/addEventListener\('([^']+)'/g)].map((m) => m[1])
  const unique = [...new Set(events)]
  ok(['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']
    .every((e) => unique.includes(e)), '★ 画布五个 pointer 事件齐全（含 cancel / leave 收笔）')
  ok(DRAFT.includes("var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']"),
    '★ 按钮四事件点按兜底（只绑 click 会复现「点不动」）')
  ok(DRAFT.includes('now - lastAt < 300'), '★ 300ms 冷却去重（同一手势只算一次）')
  ok(DRAFT.includes('setPointerCapture(ev.pointerId)'),
    '★ pointerdown 里捕获指针（指针移出画布也不丢笔画）')
  ok(DRAFT.includes('strokeTo({ x: state.last.x + 0.01'),
    '★ 单击也留一个点（轻点一下不会空白）')
  // ⚠ 文件头注释里写了「① 不用 innerHTML」，直接 includes 会把说明文字当成使用。
  //   判据必须是「非注释代码里没有把 innerHTML 当 API 用」。
  const codeOnly = DRAFT.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  ok(!codeOnly.includes('innerHTML'), '★ 非注释代码里不用 innerHTML（杜绝注入面）')
  ok(!/https?:\/\//.test(DRAFT), '★ 不加载任何外部 URL')
  ok(DRAFT.includes("var SAVE_API = 'api/qwen-paint/draft'"),
    '★ 只发本机相对路径请求')
  ok(DRAFT.includes('草稿**不进生成历史**'), '★ 草稿不进生成历史的设计约束仍写在文件头')
}

/* ═════════════════ 2. 假 DOM 指针序列仿真 ═════════════════ */
console.log('=== 2. 真加载 draft.js 并跑一遍指针序列（离线仿真，非真机） ===')

/** 最小 DOM：只实现 draft.js 真正用到的 API，任何多余能力都不给。 */
function makeHarness() {
  const calls = { fillRect: 0, beginPath: 0, moveTo: 0, lineTo: 0, stroke: 0 }
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    fillRect() { calls.fillRect += 1 }, beginPath() { calls.beginPath += 1 },
    moveTo() { calls.moveTo += 1 }, lineTo() { calls.lineTo += 1 }, stroke() { calls.stroke += 1 },
  }
  const canvases = []
  let capturedPointer = null
  let prevented = 0
  const docListeners = {}

  function node(tag) {
    const listeners = {}
    const n = {
      tagName: String(tag).toUpperCase(),
      className: '', textContent: '', value: '', type: '', href: '', rel: '', id: '',
      title: '', disabled: false, hidden: false, width: 0, height: 0,
      parentNode: null, firstChild: null, style: {}, children: [], listeners,
      appendChild(c) { n.children.push(c); c.parentNode = n; n.firstChild = n.children[0]; return c },
      insertBefore(c) { n.children.unshift(c); c.parentNode = n; n.firstChild = n.children[0]; return c },
      setAttribute(k, v) { n[k] = v },
      getAttribute(k) { return n[k] },
      addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn) },
      removeEventListener() {},
      emit(t, ev) { for (const fn of listeners[t] || []) fn(ev) },
      classList: { add() {}, remove() {} },
      querySelector() { return null },
      querySelectorAll() { return [] },
      getBoundingClientRect() { return { left: 0, top: 0, width: 512, height: 512, right: 512, bottom: 512 } },
      getContext() { return ctx },
      toDataURL() { return 'data:image/png;base64,AA' },
      setPointerCapture(id) { capturedPointer = id },
    }
    if (String(tag).toLowerCase() === 'canvas') canvases.push(n)
    return n
  }

  const body = node('body')
  const head = node('head')
  const document = {
    readyState: 'complete', body, head,
    createElement: node,
    getElementById() { return null },
    querySelectorAll() { return [] },
    addEventListener(t, fn) { (docListeners[t] || (docListeners[t] = [])).push(fn) },
  }
  const window = {}
  const sandbox = {
    window, document,
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
    Date, Math, JSON, String, Number, Boolean, Array, Object, Error, Promise, RegExp, console,
  }
  vm.createContext(sandbox)
  vm.runInContext(DRAFT, sandbox, { filename: 'assets/draft.js' })
  return { window, document, body, canvases, calls, docListeners,
    capture: () => capturedPointer, prevented: () => prevented,
    prevent() { prevented += 1 } }
}

const H = makeHarness()
ok(H.window.DshQpDraft && H.window.DshQpDraft.__dr === true,
  '★ draft.js 在假 DOM 里成功挂载 window.DshQpDraft（语法/运行时无误）')
ok(H.canvases.length === 1, `★ 面板只建了一个 canvas（实际 ${H.canvases.length}）`)
const cv = H.canvases[0]
ok(cv.width === 512 && cv.height === 512, '★ mount 时画布已按 512 初始化')
ok(H.calls.fillRect >= 1, '★ 白底已铺（透明底会被当成空图）')

const gesture = (o) => ({ preventDefault() { H.prevent() }, ...o })
const before = { stroke: H.calls.stroke, lineTo: H.calls.lineTo }
cv.emit('pointerdown', gesture({ button: 0, pointerId: 7, clientX: 10, clientY: 10 }))
ok(H.calls.stroke === before.stroke + 1, '★ pointerdown 立刻落一个点（单击可见）')
ok(H.capture() === 7, '★ pointerdown 真的调用了 setPointerCapture(7)')
cv.emit('pointermove', gesture({ clientX: 80, clientY: 90 }))
ok(H.calls.stroke === before.stroke + 2 && H.calls.lineTo >= before.lineTo + 2,
  '★ pointermove 真的画了一条线（beginPath → moveTo → lineTo → stroke）')
ok(H.prevented() >= 2, '★ down / move 都 preventDefault（宿主不会滚动抢走手势）')
cv.emit('pointerup', {})
const afterUp = H.calls.stroke
cv.emit('pointermove', gesture({ clientX: 200, clientY: 200 }))
ok(H.calls.stroke === afterUp, '★ pointerup 后再移动不再落笔（正确收笔）')

cv.emit('pointerdown', gesture({ button: 0, pointerId: 8, clientX: 20, clientY: 20 }))
const afterDown2 = H.calls.stroke
cv.emit('pointercancel', {})
cv.emit('pointermove', gesture({ clientX: 300, clientY: 300 }))
ok(H.calls.stroke === afterDown2, '★ pointercancel 也正确收笔（指针被系统打断不残留 drawing=true）')
cv.emit('pointerdown', gesture({ button: 2, pointerId: 9, clientX: 30, clientY: 30 }))
ok(H.calls.stroke === afterDown2, '★ 非左键（button=2）不落笔')

// 按钮四事件点按：× 按钮 close() 会把 overlay.hidden 置 true。
// 面板树是 overlay → box → head → ×，必须递归找，不能假定固定层级。
function findNode(root, predicate) {
  if (!root) return undefined
  if (predicate(root)) return root
  for (const c of root.children || []) {
    const hit = findNode(c, predicate)
    if (hit) return hit
  }
  return undefined
}
const overlay = H.body.children[0]
const closeBtn = findNode(overlay, (n) => String(n.className).includes('dshqp-dr-x'))
ok(closeBtn !== undefined, '★ 找到关闭按钮（tap 兜底的验收目标）')
H.window.DshQpDraft.open()
ok(overlay.hidden === false, '★ open() 展开面板')
closeBtn.emit('pointerup', { type: 'pointerup' })
ok(overlay.hidden === true, '★ 只发 pointerup（DSH 宿主吞 click 的场景）也能关掉面板')
H.window.DshQpDraft.open()
closeBtn.emit('pointerup', { type: 'pointerup' })
ok(overlay.hidden === false, '★ 300ms 冷却生效：紧接着的第二次 pointerup 被去重')

/* ═════════════════ 3. smoke.mjs 开关契约 ═════════════════ */
console.log('=== 3. smoke.mjs：默认只读，--submit 必须显式 ===')
{
  ok(SMOKE.includes('const SUBMIT = hasFlag(\'submit\')'), '★ --submit 是显式开关')
  ok(SMOKE.includes("skip('提交最小任务', '未加 --submit（默认不出图）')"),
    '★ 不加 flag 时提交项被 SKIP（默认绝不生成图片）')
  ok(SMOKE.includes('if (!SUBMIT)') && SMOKE.includes('} else {'), '★ 提交分支只在 flag 下进入')
  ok(SMOKE.includes('离线 SKIP') && SMOKE.includes('这是预期行为，不是失败'),
    '★ 离线一律 SKIP 且退出码 0（CI 不会每天假红）')
  ok(SMOKE.includes('不进离线回归 SUITES'), '★ 真机脚本故意不登记 SUITES（不是漏登）')
  ok(!/node scripts\/smoke\.mjs --submit/.test(DRAFT), '★ 草稿链路不会触发真机提交')
}

console.log(`=== test-draft-pointer：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1) }
