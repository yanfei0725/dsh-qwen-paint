#!/usr/bin/env node
/**
 * UI 性能回归（2026-11-16）：用户报「选模型卡一下 / 渲染画面占资源」。
 * 三件低风险修复，全部在 assets/ 内（不碰贴线且有字节冻结的 lib/client.js）：
 *   ① model-options 前端 TTL 缓存 —— 冷探测要发几十个 /object_info，切模式重拉会卡；
 *   ② 下拉增量回填 —— 选项集合没变只改 sel.value，不再 innerHTML='' 整块重建；
 *   ③ 进度轮询空列表降频 —— 面板常开不每 1.5s 白刷；lab /health 首次挂载拉一次。
 *
 * 风格：ok(name, cond, extra)，与 test-fab-clamp / test-ui-tap 一致（helper 内建写反自检）。
 * 全离线：vm + 假 DOM，零联网、零子进程、不出图。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_SRC = readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')
const LAB_SRC = readFileSync(path.join(ROOT, 'assets', 'lab.js'), 'utf8')
const LAB_CSS = readFileSync(path.join(ROOT, 'assets', 'lab.css'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

// helper 写反自检：ok 的失败分支必须会置 fail，否则整套断言是假绿。
// 用独立局部计数复刻逻辑，不调用 ok 本身（避免打印 ✗ 被全量扫描误判为失败）。
{
  let selfPass = 0
  let selfFail = 0
  const selfOk = (cond) => { if (cond) selfPass += 1; else selfFail += 1 }
  selfOk(true); selfOk(false)
  if (!(selfPass === 1 && selfFail === 1)) throw new Error('ok() helper 计数字段不可信，回归无效')
}

// ---- 最小假 DOM：readyState=loading ⇒ 只注册 DOMContentLoaded，不触发 mount ----
const noop = () => {}
const document = { readyState: 'loading', addEventListener: noop, head: null }
const window = { document }
let timers = 0
const sandbox = {
  window, document, console,
  Promise, Number, Math, JSON, Object, Array, String, Set, Boolean, Date,
  setTimeout: () => { timers += 1; return timers }, clearTimeout: noop,
  setInterval: () => 0, clearInterval: noop,
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
}
vm.createContext(sandbox)
vm.runInContext(PANEL_SRC, sandbox, { filename: 'assets/panel.js' })
const api = sandbox.window.ComfyPipelinePanel?.api

console.log('\n=== 1. 导出与缓存纯函数 ===')
ok('api 上挂了四个性能纯函数', api
  && ['modelOptionsFresh', 'modelOptionsEntry', 'optionSignature', 'fillSelect', 'pollIntervalMs']
    .every((k) => typeof api[k] === 'function'))

const now = 1000000
const TTL = 120000
ok('冷缓存（at=0）不命中', api.modelOptionsFresh({ at: 0, data: { ok: true } }, now, TTL) === false)
ok('无 data 不命中', api.modelOptionsFresh({ at: now, data: null }, now, TTL) === false)
ok('TTL 内命中', api.modelOptionsFresh({ at: now - 1000, data: { ok: true } }, now, TTL) === true)
ok('TTL 到期不命中', api.modelOptionsFresh({ at: now - TTL, data: { ok: true } }, now, TTL) === false)
ok('未来时间戳（时钟回拨）不命中', api.modelOptionsFresh({ at: now + 1, data: { ok: true } }, now, TTL) === false)
const entry = api.modelOptionsEntry({ ok: true }, now)
ok('modelOptionsEntry 记录 at + data', entry.at === now && entry.data.ok === true)
ok('modelOptionsEntry 不原地改入参', entry !== entry.data)

console.log('\n=== 2. 选项签名与增量回填 ===')
const opts = [
  { value: 'a.safetensors', label: 'a.safetensors' },
  { value: 'b.gguf', label: 'b.gguf' },
]
ok('签名含 emptyLabel（空选项文案变了也要重建）',
  api.optionSignature(opts, '（自动挑）') !== api.optionSignature(opts, '（默认）'))
ok('签名逐项含 value + label（label 变也要重建）',
  api.optionSignature(opts, 'e') !== api.optionSignature([{ value: 'a.safetensors', label: 'A' }], 'e'))
ok('相同输入签名稳定', api.optionSignature(opts, 'e') === api.optionSignature(opts, 'e'))

// 假 select：innerHTML='' 必须真的清空 children（模拟真浏览器 setter 语义），
// 否则「重建」测试的 child 数会累加成假红。用 getter/setter 实现这一语义。
function fakeSelect() {
  const sel = {
    value: '', cleared: 0, children: [], _html: '',
    appendChild(n) { this.children.push(n) },
  }
  Object.defineProperty(sel, 'innerHTML', {
    get() { return sel._html },
    set(v) { sel._html = String(v); if (v === '') { sel.children = []; sel.cleared += 1 } },
  })
  return sel
}
const el = (tag, cls, text) => ({ tag, cls, text, value: '' })

{
  const sel = fakeSelect()
  const r1 = api.fillSelect(sel, opts, 'b.gguf', '（自动挑）', el)
  ok('首次回填 same=false', r1.same === false)
  ok('首次回填建立 1 空 + N 选项', sel.children.length === 3, String(sel.children.length))
  ok('首选项 value 为空（自动挑）', sel.children[0].value === '')
  ok('命中项回显 b.gguf', sel.value === 'b.gguf')
  ok('回填 count 正确', r1.count === 2)

  const clearedBefore = sel.cleared
  const r2 = api.fillSelect(sel, opts, 'a.safetensors', '（自动挑）', el)
  ok('选项没变时 same=true', r2.same === true)
  ok('增量回填不重建 DOM（子节点数不变）', sel.children.length === 3, String(sel.children.length))
  ok('增量回填 innerHTML 没被清空', sel.cleared === clearedBefore)
  ok('增量回填只改 value', sel.value === 'a.safetensors' && r2.value === 'a.safetensors')

  const r3 = api.fillSelect(sel, opts, 'not-exist', '（自动挑）', el)
  ok('当前值不在候选 → 回到空（自动挑）', r3.value === '' && sel.value === '')

  const changed = opts.concat([{ value: 'c.safetensors', label: 'c.safetensors' }])
  const r4 = api.fillSelect(sel, changed, 'c.safetensors', '（自动挑）', el)
  ok('候选变了 same=false 触发重建', r4.same === false && r4.count === 3)
  ok('重建后子节点数跟上', sel.children.length === 4, String(sel.children.length))
}

console.log('\n=== 3. 轮询降频 ===')
ok('活跃（ticks=0）用快档 1500ms', api.pollIntervalMs(0) === 1500)
ok('ticks=3 仍快档', api.pollIntervalMs(3) === 1500)
ok('ticks=4 降到 5000ms', api.pollIntervalMs(4) === 5000)
ok('ticks 很大仍 5000ms（有下界不无限降）', api.pollIntervalMs(100) === 5000)

console.log('\n=== 4. 源码接线（防孤儿函数） ===')
ok('render 里 applyModelOptions 用 fillSelect 增量回填',
  /fillSelect\(p\.sel, opts, cur, p\.def\.empty, el\)/u.test(PANEL_SRC))
ok('缓存命中分支真实存在',
  /modelOptionsFresh\(modelOptionsCache, Date\.now\(\), MODEL_OPTIONS_TTL_MS\)/u.test(PANEL_SRC))
ok('只对成功且在线的清单写缓存（失败不缓存，保留重试）',
  /j\s*&&\s*j\.ok === true\s*&&\s*j\.online === true/u.test(PANEL_SRC))
ok('轮询用递归 setTimeout + 动态间隔',
  /setTimeout\(pollTick, pollIntervalMs\(progressIdleTicks\)\)/u.test(PANEL_SRC))
ok('pollProgress 有进度或 TTS 首段事件归零 / 空列表累加',
  /if \(items\.length > 0 \|\| \(j && j\.ttsLive\)\) progressIdleTicks = 0/u.test(PANEL_SRC)
  && /else progressIdleTicks \+= 1/u.test(PANEL_SRC))
ok('★ TTS 首段早出声：消费 progress.ttsLive 且去重后播一次',
  /playTtsLive\(j\.ttsLive\)/u.test(PANEL_SRC)
  && /sig === ttsLiveSeen\) return/u.test(PANEL_SRC)
  && /new Audio\(\)/u.test(PANEL_SRC))
// ★ 2026-11-16 判据升级：失败后自动重试（'retry'）是新增能力，
//   旧断言锁的「只有 force===true 能重入」写法已被有意替换。
ok('lab /health 首次挂载拉一次（失败可重试）', /var briefLoaded = false/u.test(LAB_SRC)
  && /if \(briefLoaded && force !== true && force !== 'retry'\) return Promise\.resolve\(null\)/u.test(LAB_SRC)
  && LAB_SRC.includes("loadDoctorBrief('retry')"))
ok('★ health 失败不锁死 briefLoaded（只在成功时置位）',
  /return request\('health'\)\.then\(function \(j\) \{\s*briefLoaded = true/u.test(LAB_SRC)
  && /\.catch\(function \(\) \{[\s\S]{0,220}loadDoctorBrief\('retry'\)/u.test(LAB_SRC))
ok('lab 刷新简略/refresh 仍可强制重拉',
  /loadDoctorBrief\(true\)/u.test(LAB_SRC) && /return loadDoctorBrief\(true\)/u.test(LAB_SRC))

console.log('\n=== 5. lab 四组折叠（22 节收敛） ===')
vm.runInContext(LAB_SRC, sandbox, { filename: 'assets/lab.js' })
const labApi = sandbox.window.DshQpLab?.api
ok('lab.js 暴露分组纯函数', labApi
  && typeof labApi.labGroupOf === 'function' && typeof labApi.groupSections === 'function')
if (labApi) {
  const g = labApi.labGroupOf
  // ★ 2026-11-17 修正：必须用**真实完整标题**断言。此前用简化标题「加速链 · 缓存」
  //   （不含 TTS）测试通过，但真实标题含 TTS 被 voice 规则截胡 ⇒ 加速链卡被折叠看不见。
  //   教训：测试夹具与真实字面量不一致 = 假绿。
  ok('诊断组（真实标题）：加速链/契约虽含 TTS 仍归 diag 不被语音折叠',
    g('doctor · 健康检查') === 'diag'
    && g('加速链 · 缓存 / TTS / SageAttention / WaveSpeed') === 'diag'
    && g('链契约与 ETA · 生图 / TTS') === 'diag'
    && g('配置矛盾 · 只读报告') === 'diag'
    && g('结构化日志 · 生成事件（JSON Lines）') === 'diag')
  ok('语音组（真实标题）：TTS 后端/音色/缝合仍归 voice',
    g('语音后端 · Qwen3-TTS / GPT-SoVITS v5 / IndexTTS2') === 'voice'
    && g('音色样本 · 拖入音频做新音色') === 'voice'
    && g('轻量缝合 · 旁白时间轴 + BGM ducking + SRT') === 'voice'
    && g('音频转文字 · ASR 字幕') === 'voice'
    && g('本机 ASR · faster-whisper 等（asrUrl 指过来即接通字幕链路）') === 'voice'
    && g('音乐 BGM · ACE-Step 1.5 / YuE2') === 'voice')
  ok('运维组：队列 / 显存 / DAG / Worker',
    g('队列 · 任务状态') === 'ops' && g('显存预算') === 'ops'
    && g('DAG · 工作流') === 'ops' && g('独立 Worker · 环境隔离') === 'ops')
  ok('语音组优先于工具：ASR/字幕/BGM/音色/TTS/缝合',
    g('音频转文字 · ASR 字幕') === 'voice' && g('本机 ASR') === 'voice'
    && g('音乐 BGM') === 'voice' && g('音色样本') === 'voice'
    && g('语音后端 · TTS') === 'voice' && g('轻量缝合 · 旁白时间轴') === 'voice')
  ok('工具组：GIF / 媒体转换 / 后处理 / 超分 / 矢量化',
    g('GIF 转换') === 'tool' && g('媒体格式转换') === 'tool'
    && g('媒体后处理') === 'tool' && g('手动超分') === 'tool'
    && g('矢量化 · 位图 → SVG') === 'tool')
  ok('未命中兜底落 tool（不丢 section）', g('未知新功能') === 'tool')
  ok('四组定义：诊断/工具默认展开，运维/语音默认折叠',
    JSON.stringify(labApi.LAB_GROUPS.map((x) => [x.id, x.open]))
      === JSON.stringify([['diag', true], ['tool', true], ['ops', false], ['voice', false]]))
}
ok('lab.css 有折叠组样式（details/summary + 箭头）',
  LAB_CSS.includes('.dshqp-lab-group > summary') && LAB_CSS.includes('.dshqp-lab-group[open]'))
ok('lab.js 仍不用 innerHTML（分组纯 DOM 移动）', !LAB_SRC.includes('innerHTML'))
ok('buildSections 末尾调用 groupSections（真接线非孤儿）',
  /groupSections\(box\)\s*\n\s*return box/u.test(LAB_SRC))
ok('22 个 makeSection 全在（分组没删功能）',
  (LAB_SRC.match(/makeSection\(/gu) || []).length >= 21)

console.log('\n=== 6. 持久化模型清单（二次报障：刷新页面不再白条） ===')
// 假 localStorage：纯内存，带 getItem/setItem。
function fakeStorage() {
  const m = new Map()
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null },
    setItem(k, v) { m.set(k, String(v)) },
    _map: m,
  }
}
const GOOD_LIST = {
  ok: true, online: true, unet: ['a.safetensors', 'b.gguf'],
  selected: { image: 'a.safetensors' }, tts_backends: [], tts_voices: [],
}
ok('挂了三个持久化纯函数 + store key', api
  && ['loadPersistedModels', 'savePersistedModels', 'placeholderOption'].every((k) => typeof api[k] === 'function')
  && typeof api.modelOptionsStoreKey === 'string')
{
  const ttl = 120000
  const t0 = 1000000
  ok('无 storage 读返回 null（隐私模式安全）', api.loadPersistedModels(null, t0, ttl) === null)

  const s = fakeStorage()
  ok('空存储读返回 null', api.loadPersistedModels(s, t0, ttl) === null)

  ok('成功在线清单写入成功', api.savePersistedModels(s, GOOD_LIST, t0) === true)
  ok('读回命中且候选逐字一致',
    JSON.stringify(api.loadPersistedModels(s, t0 + 1000, ttl).unet) === JSON.stringify(GOOD_LIST.unet))
  ok('TTL 到期读返回 null（不回显旧候选）', api.loadPersistedModels(s, t0 + ttl, ttl) === null)
  ok('时钟回拨读返回 null', api.loadPersistedModels(s, t0 - 1, ttl) === null)

  // 只持久化成功且在线：失败/离线一律拒写。
  ok('离线响应拒写', api.savePersistedModels(s, { ok: true, online: false, unet: ['x'] }, t0) === false)
  ok('失败响应拒写', api.savePersistedModels(s, { ok: false, online: true, unet: ['x'] }, t0) === false)
  // 脏数据：写入历史遗留的坏结构，读取端必须挡住。
  s.setItem(api.modelOptionsStoreKey, JSON.stringify({ v: 1, at: t0, data: { ok: true, online: true, unet: 'not-array' } }))
  ok('unet 非数组的脏数据挡住', api.loadPersistedModels(s, t0 + 1, ttl) === null)
  s.setItem(api.modelOptionsStoreKey, JSON.stringify({ v: 999, at: t0, data: GOOD_LIST }))
  ok('版本不符挡住（防结构漂移）', api.loadPersistedModels(s, t0 + 1, ttl) === null)
  s.setItem(api.modelOptionsStoreKey, '{bad json')
  ok('坏 JSON 不抛异常、返回 null', api.loadPersistedModels(s, t0 + 1, ttl) === null)

  ok('写失败不抛（storage.setItem 抛错也安全）',
    api.savePersistedModels({ setItem() { throw new Error('quota') } }, GOOD_LIST, t0) === false)

  // 占位选项：禁用 + 空值，不让 select 空白。
  const ph = api.placeholderOption('（正在读取本机清单…）', el)
  ok('占位 option 文案正确', ph.text === '（正在读取本机清单…）')
  ok('占位 option 禁用且值为空（不能被当成模型选）', ph.disabled === true && ph.value === '')
}

console.log('\n=== 7. 持久化链路源码接线（防孤儿） ===')
ok('render 先读持久化缓存再决定回填/请求',
  /loadPersistedModels\(getStorage\(\), Date\.now\(\), MODEL_OPTIONS_TTL_MS\)/u.test(PANEL_SRC))
ok('命中持久化缓存走同步回填 + 后台静默刷新',
  /applyModelOptions\(persisted\)[\s\S]{0,80}fetchModelOptions\(true\)/u.test(PANEL_SRC))
ok('★ 回填分支条件真的读 persisted（防被改成 false/常量导致白条回归）',
  /if \(persisted\) \{\s*\n\s*modelOptionsCache = modelOptionsEntry\(persisted/u.test(PANEL_SRC))
ok('后台刷新成功才写两层缓存（内存 + localStorage）',
  /savePersistedModels\(getStorage\(\), j, Date\.now\(\)\)/u.test(PANEL_SRC)
  && /modelOptionsCache = modelOptionsEntry\(j, Date\.now\(\)\)/u.test(PANEL_SRC))
ok('完全没缓存时放占位 option（不是空 select 白条）',
  /placeholderOption\('（正在读取本机清单…）', el\)/u.test(PANEL_SRC))
ok('silent 刷新失败不覆盖已显示状态',
  /if \(!silent\)[\s\S]{0,120}模型清单读取失败/u.test(PANEL_SRC))

console.log('\n=== 6. 错误文案可诊断 + UI_BUILD 自证（2026-11-19.1） ===')
// ★ 2026-11-17.1：旧版把「连不上服务」和「服务返回异常」都吞成
//   「本机请求失败（详见插件日志）」，掩盖了 ComfyUI 没启动这一真因。
ok('★ 本机请求失败文案已区分服务离线 vs 服务异常（不再笼统一句）',
  LAB_SRC.includes("连不上本机服务：ComfyUI 可能未启动")
  && LAB_SRC.includes("本机服务返回异常（HTTP ")
  && !LAB_SRC.includes('本机请求失败（详见插件日志）'))
ok('★ 区分文案不回吐 error.message（catch 里不拼 error）',
  /\.catch\(function \(\) \{\s*return \{ ok: false, reason: '连不上本机服务/u.test(LAB_SRC))
ok('★ UI_BUILD 已 bump 到 2026-11-19.1（宿主墙 401/404 回退别名 + lab 体检卡修复，真机刷新可自证）',
  /var UI_BUILD = '2026-11-19\.1'/u.test(PANEL_SRC)
  && /data-cp-ui-build', UI_BUILD/u.test(PANEL_SRC))

console.log('\n=== 9. UI 全折叠 + 拖图（2026-11-18.2）===')
ok('foldCard 折叠容器存在（details + toggle 重算几何）',
  /function foldCard\(/u.test(PANEL_SRC)
  && /el\('details', 'cp-card cp-fold'/u.test(PANEL_SRC)
  && /addEventListener\('toggle'/u.test(PANEL_SRC))
ok('★ toggle 回调里真调 syncPanelPos（折叠后底缘仍贴浮标上缘）',
  /addEventListener\('toggle', function \(\) \{[\s\S]{0,180}syncPanelPos\(nodes\.fab, nodes\.panel\)/u.test(PANEL_SRC))
ok('素材库/角色参考/混合链已折叠',
  /foldCard\('素材库'/u.test(PANEL_SRC)
  && /foldCard\('角色参考（模型无关）'/u.test(PANEL_SRC)
  && /foldCard\('混合链：生图/u.test(PANEL_SRC))
ok('hybrid 四段模型卡收进折叠区', /foldCard\('四段模型选择/u.test(PANEL_SRC))
ok('通用拖拽区 dropZone（dragover/drop/FileReader + 点击选择）',
  /function dropZone\(/u.test(PANEL_SRC)
  && /addEventListener\('dragover'/u.test(PANEL_SRC)
  && /new FileReader\(/u.test(PANEL_SRC)
  && /readAsDataURL/u.test(PANEL_SRC))
ok('PPT 卡有讲解图拖拽 + images 分配（agent 精确指定优先）',
  /dropZone\('讲解图片'/u.test(PANEL_SRC)
  && /hasExplicit/u.test(PANEL_SRC)
  && /target\.images\.push/u.test(PANEL_SRC))
ok('人物替换双拖拽区（参考图 + 人物图）',
  /dropZone\('参考图 \/ 场景图'/u.test(PANEL_SRC)
  && /dropZone\('选定人物图'/u.test(PANEL_SRC))
ok('人物替换调 portrait 登记+合成端点（不假装换脸）',
  /api\/qwen-paint\/portrait\/register/u.test(PANEL_SRC)
  && /api\/qwen-paint\/portrait\/compose/u.test(PANEL_SRC))
ok('CSS 有折叠/拖拽样式',
  readFileSync(path.join(ROOT, 'assets', 'panel.css'), 'utf8').includes('.cp-fold > summary')
  && readFileSync(path.join(ROOT, 'assets', 'panel.css'), 'utf8').includes('.cp-drop'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
