#!/usr/bin/env node
/**
 * 浮标几何 + 面板内嵌回归：零边距贴 DSH 边框 / 轻吸附保留微调 / 面板恒在浮标正上方。
 * ★ 2026-11-14 用户报障「拉不到右面去 / 限制那么多 / 只要对齐一点点」：
 *   移除「为右侧面板预留 pw」硬边界与强吸附。
 * ★ 2026-11-15 第三次报「我要它刚好靠边，不是你提前空那么多」：
 *   根因是全局 8px 边距 + CSS 默认 right:16px/bottom:64px + 面板与浮标间 12px。
 *   本套断言按**零边距**重写并加严：minLeft=0、maxLeft=vpW-fsW（浮标右缘精确等于视口宽）、
 *   面板 left/top 下界 0、CSS 默认 right/bottom=0；并锁「实验室不再是独立浮层」。
 * ★★ 2026-11-15 第四次纠正「展开界面直接放在悬浮球上方，不是右侧/左侧；
 *   边框对齐边框；浮标贴右不要变成更圆的球」：
 *   ⇒ geomPanelSide 左右翻边**整个删除**，改 geomPanelAbove：面板右缘 = 浮标右缘
 *     （贴右时 = vpW = DSH 右边框），底缘 = 浮标上缘 - 6px 呼吸空隙；上方不足只压缩高度。
 *   ⇒ .cp-fab 用 width:max-content + white-space:nowrap 锁死内容宽度，圆角/padding 不动。
 *   ⚠ 旧断言里 panelSide / side=left|right / 写死 8 / 1140 的都是**断言过期**
 *     （用户明确改了需求），不是改测试迁就 bug：新判据改成「精确几何等式」，
 *     并额外锁「源码里不许再出现左右翻边」。
 *
 * 为什么用 node:vm 加载源码断言：assets/panel.js 是 `<script defer>` 的非 ESM IIFE，
 * 不能有 export。几何抽成纯函数挂到 window.ComfyPipelinePanel.api.geom 后可直接调。
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
const LAB = readFileSync(path.join(ROOT, 'assets', 'lab.js'), 'utf8')
const LAB_CSS = readFileSync(path.join(ROOT, 'assets', 'lab.css'), 'utf8')
const PANEL_CSS = readFileSync(path.join(ROOT, 'assets', 'panel.css'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

// ---- 最小假 DOM：readyState=loading ⇒ 只注册 DOMContentLoaded，不触发 mount() ----
const noop = () => {}
const document = { readyState: 'loading', addEventListener: noop, head: null }
const window = { document }
const sandbox = {
  window, document, console,
  Promise, Number, Math, JSON, Object, Array, String, Set, Boolean, Date,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
}
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'assets/panel.js' })

const geom = sandbox.window.ComfyPipelinePanel?.api?.geom
ok('vm 加载后 window.ComfyPipelinePanel.api.geom 存在',
  Boolean(geom) && ['panelWidth', 'fabBounds', 'clampX', 'snapX', 'panelAbove', 'fabPos']
    .every((k) => typeof geom[k] === 'function'))

const VP_W = 1280
const VP_H = 800
const FS_W = 132
const FS_H = 42
const PW = 392

console.log('=== 1. 面板宽度与水平边界（★ 零边距精确贴 DSH 右边框） ===')
ok('panelWidth(1280) === 392', geom.panelWidth(VP_W) === PW, String(geom.panelWidth(VP_W)))
ok('panelWidth(300) === 300（窄视口也贴边，不再扣 16）', geom.panelWidth(300) === 300, String(geom.panelWidth(300)))
ok('panelWidth(10) === 10（下界 0，不再扣到 8）', geom.panelWidth(10) === 10, String(geom.panelWidth(10)))

const bounds = geom.fabBounds(VP_W, FS_W, PW)
const RIGHT_EDGE = VP_W - FS_W // 1148：浮标右缘精确等于视口右缘
ok('★ 边界 maxLeft = vpW - fsW = 1148（零边距，既不留 8 也不预留 pw）',
  bounds.maxLeft === RIGHT_EDGE, String(bounds.maxLeft))
ok('★ 边界 minLeft === 0（精确贴左边框）', bounds.minLeft === 0, String(bounds.minLeft))
ok('★ 浮标可以到达视口右缘（用户报障「拉不到右面去」）', bounds.maxLeft === RIGHT_EDGE, `${bounds.maxLeft} vs ${RIGHT_EDGE}`)
ok('★★ 浮标右缘零空隙：maxLeft + fsW === vpW（「刚好靠边」的硬判据）',
  bounds.maxLeft + FS_W === VP_W, String(bounds.maxLeft + FS_W))
ok('★★ 面板不再翻边：贴右时右缘与浮标右缘重合（边框对齐 DSH 边框）',
  geom.panelAbove(bounds.maxLeft, FS_W, VP_W, PW) + PW === VP_W,
  String(geom.panelAbove(bounds.maxLeft, FS_W, VP_W, PW)))

console.log('=== 2. 旧值 clamp（读旧 localStorage 也走同一零边距边界） ===')
ok('旧值远大于上限 → clamp 到 maxLeft', geom.clampX(99999, bounds) === RIGHT_EDGE, String(geom.clampX(99999, bounds)))
ok('旧值为负 → clamp 到 0', geom.clampX(-999, bounds) === 0, String(geom.clampX(-999, bounds)))
ok('旧值 NaN → 回落到 0', geom.clampX(NaN, bounds) === 0, String(geom.clampX(NaN, bounds)))
ok('旧值在界内保持不变', geom.clampX(200, bounds) === 200)
const p1 = geom.fabPos(99999, 99999, VP_W, VP_H, FS_W, FS_H)
ok('fabPos(越界旧值) → left=1148 / top=758（下边缘零空隙）',
  p1.left === RIGHT_EDGE && p1.top === VP_H - FS_H, `${p1.left}/${p1.top}`)
const p2 = geom.fabPos(-50, -50, VP_W, VP_H, FS_W, FS_H)
ok('fabPos(负旧值) → left=0 / top=0', p2.left === 0 && p2.top === 0, `${p2.left}/${p2.top}`)
ok('fabPos 返回 minLeft/maxLeft/pw 供上层复用',
  p1.minLeft === 0 && p1.maxLeft === RIGHT_EDGE && p1.pw === PW)

console.log('=== 3. 松手轻吸附（只在贴边时对齐，中间保留微调） ===')
ok('离左边 ≤24 → 吸到 0', geom.snapX(20, bounds) === 0, String(geom.snapX(20, bounds)))
ok('离右边 ≤24 → 吸到 maxLeft 1148', geom.snapX(1130, bounds) === RIGHT_EDGE, String(geom.snapX(1130, bounds)))
ok('★ 中间位置不吸附，保留用户「对齐一点点」的结果', geom.snapX(378, bounds) === 378, String(geom.snapX(378, bounds)))
ok('★ 靠右但未贴边（600）也不被弹回左端', geom.snapX(600, bounds) === 600, String(geom.snapX(600, bounds)))
const samples = [0, 9, 20, 200, 378, 400, 600, 900, 1130, 1148, 1e6, -1e6, NaN]
ok('任意输入吸附后始终落在 [0, maxLeft] 内（绝不越界）',
  samples.every((x) => {
    const v = geom.snapX(x, bounds)
    return v >= bounds.minLeft && v <= bounds.maxLeft
  }))
ok('★ 吸附结果只能是「贴左边 / 贴右边 / 保留 clamp 原值」三种',
  samples.every((x) => {
    const v = geom.snapX(x, bounds)
    return v === bounds.minLeft || v === bounds.maxLeft || v === geom.clampX(x, bounds)
  }))

console.log('=== 4. ★★ 面板恒在浮标正上方（不许左右翻边 / 边框对齐边框） ===')
const inView = (left, vpW, pw) => left >= 0 && left + pw <= vpW
const aboveRight = geom.panelAbove(bounds.maxLeft, FS_W, VP_W, PW)
ok('★★ 浮标贴右时面板右缘 === 视口右缘（边框对齐 DSH 边框）',
  aboveRight + PW === VP_W, String(aboveRight + PW))
ok('★★ 面板 left = 浮标右缘 - 面板宽 = 888', aboveRight === VP_W - PW, String(aboveRight))
ok('★★ 面板与浮标水平重叠且右缘重合（不是浮标右侧，也不是左侧）',
  aboveRight < bounds.maxLeft + FS_W && aboveRight + PW > bounds.maxLeft)
ok('★ 浮标贴左时面板被夹进视口（不越界、不翻边）',
  geom.panelAbove(0, FS_W, VP_W, PW) === 0, String(geom.panelAbove(0, FS_W, VP_W, PW)))
const narrowPw = geom.panelWidth(600)
const narrow = geom.panelAbove(300, FS_W, 600, narrowPw)
ok('窄视口下仍右缘对齐浮标右缘且不越界',
  narrow + narrowPw === 300 + FS_W && inView(narrow, 600, narrowPw), String(narrow))
const grid = []
for (const vpW of [400, 600, 1000, 1280, 1920]) {
  for (const fabLeft of [0, 100, 300, 600, 800]) {
    const pw = geom.panelWidth(vpW)
    grid.push([geom.panelAbove(fabLeft, FS_W, vpW, pw), vpW, pw])
  }
}
ok('多组视口/浮标位置下 panelAbove 结果都完整可见',
  grid.every(([left, vpW, pw]) => inView(left, vpW, pw)))
ok('★★ 源码里左右翻边逻辑已彻底删除（只判真实定义/调用，注释里的历史名不算）',
  !/function geomPanelSide\(/.test(SRC) && !SRC.includes('geomPanelSide(l, fs.w, vp.w, pw)')
  && !SRC.includes("side === 'right'") && !SRC.includes("side === 'left'"))

console.log('=== 5. 源码级：几何确实接进交互（不是只留着好看） ===')
ok('setFabPos 调用 geomFabPos（同一条 clamp）', SRC.includes('geomFabPos(left, top, vp.w, vp.h, fs.w, fs.h)'))
ok('★★ syncPanelPos 调用 geomPanelAbove（上方定位生效）', SRC.includes('geomPanelAbove(l, fs.w, vp.w, pw)'))
ok('★★ syncPanelPos 用面板真实 offsetWidth（content-box 下边框才对得上）',
  SRC.includes('panel.offsetWidth'))
ok('★★ syncPanelPos 不再 early-return（首次展开也按真实浮标高度对齐）',
  !SRC.includes('if (!Number.isFinite(l) || !Number.isFinite(t)) return'))
ok('★★ 上方放不下只压缩高度，绝不翻到浮标下方',
  SRC.includes('panel.style.maxHeight') && !SRC.includes('t + fs.h'))
ok('finish 松手调用 geomSnapFabX（靠边吸附生效）', SRC.includes('geomSnapFabX(p.left, bounds)'))
ok('恢复旧 localStorage 走 setFabPos（同一 clamp）', SRC.includes('if (saved) setFabPos(fab, saved.left, saved.top)'))
ok('★ 旧的「为面板预留 pw」硬边界已移除', !SRC.includes('vpW - fsW - pw - 8'))
ok('★ 轻吸附阈值只在贴边时生效（SNAP_NEAR 常量在场）', SRC.includes('SNAP_NEAR'))
ok('★ panel 节点已暴露给实验室浮层（getPanelNode）', SRC.includes('getPanelNode: function ()'))
ok('geom 六个纯函数都导出到 api', SRC.includes('geom: {'))
ok('懒加载按 id 去重挂 head', SRC.includes('if (doc.getElementById(a.id)) continue') && SRC.includes('head.appendChild(node)'))
ok('懒加载清单含 lab.js 与 lab.css',
  SRC.includes('qwen-paint/lab.js') && SRC.includes('qwen-paint/lab.css')
  && SRC.includes('dshqp-lab-js') && SRC.includes('dshqp-lab-css'))
ok('mount() 里调用 loadLabAssets()', SRC.includes('loadLabAssets()'))

console.log('=== 6. 点按兜底覆盖（全面排查：同类「点不动」隐患不再复现） ===')
// panel.js 的 5 个面板内按钮（skill-tag / tab / ref-search / reset / x）都是 <button>，
// 且都在 cp-panel 内 ⇒ 被 setup-guide 的 installPointerFallback() 覆盖；
// 但 cp-fab 没有 cp-panel 祖先，且在「无 Pointer Events」回退分支只绑 click ⇒ 必须单独进白名单。
ok('setup-guide 兜底白名单含 cp-panel（面板内按钮）', GUIDE.includes("'cp-panel'"))
ok('★ 兜底白名单含 cp-fab（无 Pointer Events 宿主的浮标只绑 click）', GUIDE.includes("'cp-fab'"))
ok('★ installPointerFallback 不只是定义，mount 里真的调用（防孤儿函数）',
  (GUIDE.match(/installPointerFallback\(\)/g) || []).length >= 2)
ok('兜底监听 pointerup / mouseup / touchend 三种 up 事件',
  ["'pointerup'", "'mouseup'", "'touchend'"].every((e) => GUIDE.includes(e)))
ok('兜底只认 BUTTON / A / radio / checkbox，不误伤宿主 DOM',
  GUIDE.includes("tag === 'BUTTON' || tag === 'A'"))
ok('panel.js 的 fab 是 <button>（兜底能识别）', SRC.includes("el('button', 'cp-fab')"))
ok('panel.js 的关闭按钮是 <button>（兜底能识别）', SRC.includes("el('button', 'cp-x'"))
// ★ 2026-11-15 第五次报障：旧断言「不依赖 click」恰恰是 bug 本身 ——
//   setup-guide 的宿主兜底靠 target.click() 合成 click，fab 不绑 click 就永远点不动。
//   定性为**断言过期**（用户报障 + 实采兜底实现），按新事实改写并加严。
ok('★★ 有 Pointer Events 时 fab 仍补绑 click / mouseup / touchend 三种抬起事件',
  SRC.includes("bindTap(fab, toggle, ['click', 'mouseup', 'touchend'], fabTap)"))
ok('★★ 叉叉在 render() 里用 bindTap 绑四事件（rebuild 后仍生效），wire() 不再 click-only',
  SRC.includes('bindTap(x, close)') && !SRC.includes("x.addEventListener('click', close)"))

console.log('=== 7. ★★ 2026-11-15：实验室独立浮层已删除 + CSS 默认留白已归零 ===')
ok('★ EDGE_GAP 常量为 0（零边距的唯一真相源）', SRC.includes('var EDGE_GAP = 0'))
ok('★ 几何里不再有 - 8 的视口边距', !SRC.includes('vpW - fsW - 8') && !SRC.includes('vp.h - ph - 8'))
ok('★ 面板与浮标之间不再塞 12px 空隙（只判真实赋值，注释里的历史说明不算）',
  SRC.includes('var above = t - ph') && !/var above = t - ph - 12/.test(SRC)
  && !/var py = [\s\S]{0,80}fs\.h \+ 12/.test(SRC))
ok('★ 拖动兜底坐标也走 EDGE_GAP（第一次拖动不会凭空跳 16px）',
  SRC.includes('vp.w - fs.w - EDGE_GAP') && !SRC.includes('vp.w - fs.w - 16'))
ok('★ .cp-fab 默认右下贴边（right:0 / bottom:0）',
  /\.cp-fab\s*\{[^}]*right:\s*0;[^}]*bottom:\s*0;/s.test(PANEL_CSS))
ok('★ .cp-panel 默认右边缘贴边、底边只让出浮标高度 42px',
  /\.cp-panel\s*\{[^}]*right:\s*0;[^}]*bottom:\s*42px;/s.test(PANEL_CSS))
ok('★ 旧的 16/64/12px 默认留白已全部移除',
  !PANEL_CSS.includes('right: 16px') && !PANEL_CSS.includes('bottom: 64px')
  && !PANEL_CSS.includes('right: 12px') && !PANEL_CSS.includes('bottom: 12px')
  && !PANEL_CSS.includes('calc(100vw - 32px)'))
ok('★★ lab.js 不再造独立浮标 / 悬浮窗 / 定位逻辑（只判真实代码特征）',
  !LAB.includes("el('div', 'dshqp-lab-mask')") && !LAB.includes("el('button', 'dshqp-lab-fab'")
  && !/function positionLab\(/.test(LAB) && !/function findHost\(/.test(LAB)
  && !/function tryRehost\(/.test(LAB) && !LAB.includes('els.mask ='))
ok('★★ lab.js 改为把功能区嵌进插槽（mountInto / findSlot / 不降级 body）',
  LAB.includes('function mountInto(host)') && LAB.includes('function findSlot()')
  && LAB.includes('els.sections') && !LAB.includes('findHost() || document.body'))
ok('★★ panel.js 真的有内嵌插槽并在首次加载 / rebuild 时重挂',
  SRC.includes("data-dshqp-lab-slot', '1'") && SRC.includes('lab.mountInto(nodes.labSlot)')
  && SRC.includes('lab.mountInto(labSlot)'))
ok('★★ lab.css 不再是 fixed 浮层，宽度由插槽决定',
  !LAB_CSS.includes('position: fixed') && !LAB_CSS.includes('left: 14px')
  && !LAB_CSS.includes('calc(100vw - 28px)') && !LAB_CSS.includes('.dshqp-lab-box')
  && LAB_CSS.includes('.dshqp-lab-slot') && LAB_CSS.includes('width: 100%'))

console.log('=== 8. ★★ 2026-11-15 第四次纠正：浮标不变形 + 正上方 + 边框对齐 ===')
ok('★ .cp-fab 宽度只由内容决定（width:max-content，贴右不被压成圆球）',
  /\.cp-fab\s*\{[^}]*width:\s*max-content;/s.test(PANEL_CSS))
ok('★ .cp-fab 文字不换行（white-space:nowrap）',
  /\.cp-fab\s*\{[^}]*white-space:\s*nowrap;/s.test(PANEL_CSS))
ok('★★ 浮标原有圆角 / 内边距 / 最小高度一个都没改（跟以前一样）',
  /\.cp-fab\s*\{[^}]*min-height:\s*42px;[^}]*padding:\s*10px 18px;/s.test(PANEL_CSS)
  && /\.cp-fab\s*\{[^}]*border-radius:\s*999px;/s.test(PANEL_CSS))
ok('★ 源码里没有按位置改浮标圆角 / 宽高的逻辑',
  !/fab\.style\.(borderRadius|width|height)/.test(SRC))
ok('★★ 面板底缘 = 浮标上缘 - 6px 呼吸空隙（2026-11-16 用户拍板；不再翻到下方）',
  SRC.includes('var py = Math.max(EDGE_GAP, above)') && SRC.includes('var above = t - ph - GAP_ABOVE')
  && SRC.includes('var GAP_ABOVE = 6'))
ok('★★ 面板右缘 = 浮标右缘（geomPanelAbove 用 fabLeft + fsW - pw）',
  SRC.includes('var raw = fabLeft + fsW - pw'))
ok('★★ data-cp-panel-side 固定 above（不会再出现 left / right）',
  SRC.includes("'data-cp-panel-side', 'above'") && !SRC.includes('side.side'))
ok('★ EDGE_GAP 仍为 0（零边距没被这次改动破坏）', SRC.includes('var EDGE_GAP = 0'))

console.log('=== test-fab-clamp：' + pass + ' 项通过，' + fail + ' 项失败 ===')
process.exit(fail === 0 ? 0 : 1)
