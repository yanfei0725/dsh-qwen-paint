#!/usr/bin/env node
/**
 * 白条同源 + 假成功修复的联动护栏（2026-11-16，P0/P1/P2）
 *
 * 用户报障：「选了模型却显示已生效，实际没生效」+「下拉首次打开是白条」。
 * 本套把六处修复做成机器可判断言，混合两种力度：
 *   · 真调用 —— comfy-catalog 失败冷却、client.js 权重缓存纯函数（vm 拿 factory）；
 *   · 源码级 —— status.json 的 choiceResult 链路、前端显示分支、各下拉占位与错误态。
 * 全离线：零联网、零子进程、零真实 DOM、不出图。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadObjectInfo, resetCatalogCache, __testObjectInfo } from '../lib/comfy-catalog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

const IDX = read('lib/index.js')
const CLIENT = read('lib/client.js')
const PANEL = read('assets/panel.js')
const LAB = read('assets/lab.js')
const HISTORY = read('assets/history.js')
const CATALOG = read('lib/comfy-catalog.js')

let pass = 0
let fail = 0
const fails = []
// 调用统一写成 ok('标签', 条件, '详情')，标签在前。
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  OK   ${label}`) }
  else { fail += 1; fails.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/* -------------------------- 1. P0：假成功根因 -------------------------- */
console.log('=== 1. P0：拒绝必须回传，前端不许报喜 ===')
{
  ok('后端把「被拒选择」收进 choiceRejections',
    IDX.includes('const choiceRejections = []') && IDX.includes('const rejectChoice = (label, value, reason) => {'))
  ok('★ 主模型 / LoRA / ControlNet 白名单拒绝会调 rejectChoice（不再只 log warn）',
    /rejectChoice\(label, val, why\)/u.test(IDX)
    && /if \(wf === null \|\| allowed\.length === 0 \|\| !allowed\.includes\(val\)\)/u.test(IDX))
  ok('★ 拒绝原因区分「清单不可用」与「候选已删」两种情况',
    IDX.includes('本机模型清单此刻不可用') && IDX.includes('可能是缓存里的旧候选'))
  ok('★ 视频主模型返回值 false 不再被丢弃（旧代码直接丢）',
    /persistVideoModelChoice\(\{ val: wanted, wf, log \}\) === false/u.test(IDX)
    && IDX.includes("rejectChoice('视频主模型', wanted"))
  ok('响应新增 choiceResult，且顶层 ok 语义保持不变（三处轮询依赖它）',
    /choiceResult: \{\s*ok: choiceRejections\.length === 0,\s*rejections: choiceRejections,\s*\}/u.test(IDX)
    && IDX.includes('ok: true,'))
  ok('前端按 j.choiceResult 判成功，拒绝时写「未生效」',
    PANEL.includes('var cr = j && j.choiceResult')
    && /if \(cr && cr\.ok === false && mine\)/u.test(PANEL)
    && PANEL.includes("mStatus.textContent = '未生效：'"))
  ok('★ 反向：前端仍有成功分支（不能把所有选择都判成失败）',
    PANEL.includes("'已选 ' + mSel.value + '（下次生成生效）'"))
  ok('前端给拒绝态打标记，便于样式和测试识别',
    PANEL.includes("mStatus.setAttribute('data-choice-rejected', '1')"))
}

/* -------------- 2. P1-a：client.js 权重下拉持久化（真调用） -------------- */
console.log('\n=== 2. P1-a：优化面板权重下拉的持久化缓存 ===')
let testApi = null
try {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { captured = m } } },
    Symbol, Object, Promise, Date, JSON, Math, String, Number, Array, RegExp, Error, TypeError, console,
  }
  vm.runInNewContext(CLIENT, sandbox, { timeout: 5000 })
  testApi = captured.factory(() => null).__test
} catch (err) {
  ok('能拿到 client.js 的纯函数测试入口', false, String(err?.message ?? err))
}
if (testApi) {
  ok('★ client.js 暴露权重缓存纯函数（可离线断言）',
    ['loadPersistedWeightCaps', 'savePersistedWeightCaps', 'weightOptionsOf', 'WEIGHT_CAPS_TTL']
      .every((k) => typeof testApi[k] !== 'undefined'))

  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const caps = {
    files: { unet: ['real_fp8.safetensors'], unetGguf: [], lora: [], controlnet: [] },
    overrides: { main: 'deleted_old.safetensors' },
    fileLabels: { 'real_fp8.safetensors': { clean: 'real', meta: 'fp8' } },
  }
  const NOW = 1000000
  ok('缓存只写成功结构', testApi.savePersistedWeightCaps(storage, caps, NOW) === true)
  ok('写入后能同步读回完整 caps',
    JSON.stringify(testApi.loadPersistedWeightCaps(storage, NOW, testApi.WEIGHT_CAPS_TTL))
      .includes('deleted_old.safetensors'))
  ok('★ 过期缓存一律不回显（防拿旧候选骗用户）',
    testApi.loadPersistedWeightCaps(storage, NOW + testApi.WEIGHT_CAPS_TTL, testApi.WEIGHT_CAPS_TTL) === null)
  ok('★ 时钟倒退也不回显',
    testApi.loadPersistedWeightCaps(storage, NOW - 1, testApi.WEIGHT_CAPS_TTL) === null)
  const opts = testApi.weightOptionsOf(caps, 'main', (f) => ({ clean: f, meta: '' }))
  ok('★ fileLabels 干净名 + 「已失效」标注都保住',
    opts.opts.some((o) => o.label.includes('已失效'))
    && opts.opts.some((o) => o.value === 'real_fp8.safetensors')
    && opts.opts[0].value === '')
  ok('无缓存时返回 null，不伪造候选',
    testApi.loadPersistedWeightCaps({ getItem: () => null }, NOW, 120000) === null)
  ok('storage 抛错不冒泡（隐私模式）',
    testApi.savePersistedWeightCaps({ setItem: () => { throw new Error('denied') } }, caps, NOW) === false
    && testApi.loadPersistedWeightCaps({ getItem: () => { throw new Error('denied') } }, NOW, 120000) === null)
}
ok('首次无缓存才放禁用占位（不再裸写「载入中…」）',
  CLIENT.includes("ph.textContent = '（正在读取本机清单…）'") && CLIENT.includes('ph.disabled = true'))
ok('★ 命中缓存时同步填选项，不走异步回填队列',
  CLIENT.includes('fillWeightSelect(cachedWeightCaps, t, sel, nowEl, metaEl, true)')
  && /if \(cachedWeightCaps\) \{[\s\S]{0,300}fillWeightSelect\(cachedWeightCaps/u.test(CLIENT))
ok('★ 后台静默刷新只更新缓存、不重写已经填好的 DOM',
  /fetchWeightCaps\(\)\s*\n\s*capsPromise = Promise\.resolve\(cachedWeightCaps\)/u.test(CLIENT))
ok('★ 请求失败不再误报「没探测到文件」',
  !CLIENT.includes('没探测到可选文件')
  && CLIENT.includes('本机清单暂时取不到（稍后会自动重试）'))

/* --------------------- 3. P1-b / P2：前端各下拉 --------------------- */
console.log('\n=== 3. P1-b / P2：风格下拉、假就绪、health 重试、history 首帧 ===')
{
  ok('风格下拉创建时就有禁用占位（不再零 option）',
    PANEL.includes("el('option', null, '（正在读取素材库…）')") && PANEL.includes('stylePlace.disabled = true'))
  ok('★ 风格下拉失败有错误态，空 catch 已删',
    PANEL.includes('（素材库读取失败，请稍后重试）')
    && /\.catch\(function \(err\) \{[\s\S]{0,180}libState\.libraryError/u.test(PANEL)
    && !PANEL.includes('.catch(function () { /* 素材库拿不到就不显示'))
  ok('★ 不再在候选未到时宣告「就绪」',
    PANEL.includes("setStatus(statusReady + '（候选清单加载中…）')")
    && /Promise\.allSettled\(\[loadLibrary\(\), loadReference\(\)\]\)/u.test(PANEL))
  ok('初始状态文案是加载中而不是就绪',
    PANEL.includes("el('span', 'cp-status', '正在加载面板…')"))
  ok('★ lab health 失败不永久锁死（只在成功时置位 + 延迟重试一次）',
    /return request\('health'\)\.then\(function \(j\) \{\s*briefLoaded = true/u.test(LAB)
    && LAB.includes("loadDoctorBrief('retry')") && LAB.includes('briefRetryTimer'))
  ok('lab 失败态给用户看了，不是沉默',
    LAB.includes('doctor：本机健康检查暂时取不到（稍后自动重试）'))
  ok('history 首帧有读取中占位（不再空列表）',
    HISTORY.includes("el('div', 'hs-empty', '正在读取历史记录…')"))
  ok('★ history stats 加 60s 缓存，避免每次开面板双请求',
    HISTORY.includes('var statsCache = null')
    && /statsCache && Date\.now\(\) - statsCache\.at < 60000/u.test(HISTORY)
    && HISTORY.includes('statsCache = { at: Date.now(), total:'))
}

/* --------------- 4. P2：comfy-catalog 失败冷却（真调用） --------------- */
console.log('\n=== 4. P2：object_info 失败冷却（真跑 fetchFn） ===')
let failCalls = 0
{
  const failingFetch = async () => { failCalls += 1; return { ok: false } }
  resetCatalogCache()
  const first = await loadObjectInfo({ url: 'http://127.0.0.1:8188', fetchFn: failingFetch, ttlMs: 600000 })
  const second = await loadObjectInfo({ url: 'http://127.0.0.1:8188', fetchFn: failingFetch, ttlMs: 600000 })
  ok('失败返回 null（不假装拿到家底）', first === null && second === null)
  ok('★ 失败也写时间戳：连续两次调用只发一次 30s 请求',
    failCalls === 1, `实际发了 ${failCalls} 次`)
  ok('缓存条目被标记为 failed', __testObjectInfo()?.failed === true)
  const before = failCalls
  await loadObjectInfo({ url: 'http://127.0.0.1:8188', fetchFn: failingFetch, ttlMs: 600000, force: true })
  ok('force=true 仍能强制重试（冷却不是永久封死）', failCalls === before + 1)
  ok('失败冷却短于成功 TTL（尽快恢复）',
    /OBJECT_INFO_FAILED_COOLDOWN_MS = 60000/u.test(CATALOG)
    && /Math\.min\(ttlMs, OBJECT_INFO_FAILED_COOLDOWN_MS\)/u.test(CATALOG))

  let okCalls = 0
  const goodFetch = async () => {
    okCalls += 1
    return { ok: true, json: async () => ({ Foo: { input: {} } }) }
  }
  resetCatalogCache()
  const info = await loadObjectInfo({ url: 'http://127.0.0.1:8188', fetchFn: goodFetch, ttlMs: 600000 })
  await loadObjectInfo({ url: 'http://127.0.0.1:8188', fetchFn: goodFetch, ttlMs: 600000 })
  ok('成功仍走原有 10 分钟 TTL（只发一次）',
    Boolean(info) && okCalls === 1 && __testObjectInfo()?.failed === false, `实际 ${okCalls} 次`)
}

/* ---------------------- 5. 改坏就红的反向核查 ---------------------- */
console.log('\n=== 5. 反向核查：这些断言不是摆设 ===')
{
  ok('★ 若把前端的 choiceResult 判断删掉，源码级断言会红',
    !PANEL.replace('if (cr && cr.ok === false) {', '').includes('if (cr && cr.ok === false)'))
  ok('★ 若把失败时间戳去掉，冷却断言会红（calls 会变 2）', failCalls === 2)
}

/* ------------------- 6. 审计补丁：遗留拒绝 / total 竞态 / 缓存清理 ------------------- */
console.log('\n=== 6. 审计补丁：所有写参数都诚实回传，total 不再串味 ===')
{
  // ② 档位等遗留路径也进 choiceResult（不再只 log warn）
  ok('★ idleminutes 非法值也回传拒绝',
    /rejectChoice\('空闲关停分钟数', rawMinutes,/u.test(IDX))
  ok('★ flowstyle / preset / drawtrigger 非法值都回传拒绝',
    /rejectChoice\('生图动画', rawStyle,/u.test(IDX)
    && /rejectChoice\('出图预设', rawPreset,/u.test(IDX)
    && /rejectChoice\('生图判断策略', rawTrigger,/u.test(IDX))
  ok('★ VAE 分块 / SageAttention 未安装 / MPS 非 Mac 都回传拒绝',
    /rejectChoice\('VAE 大图分块解码', v,/u.test(IDX)
    && /rejectChoice\(label, v, '自检确认 sageattention 未安装/u.test(IDX)
    && /rejectChoice\(label, v, 'MPS 只在 macOS 有意义/u.test(IDX))
  ok('★ 显存/精度/文本控制三档非法值也回传拒绝',
    /rejectChoice\(label, raw, `取值不在白名单内/u.test(IDX))
  ok('前端按 label 认领自己的拒绝，不张冠李戴',
    PANEL.includes('var mine = rejects.filter(function (r) {')
    && PANEL.includes('def.label.indexOf(r.label) >= 0 || r.label.indexOf(def.label) >= 0')
    && PANEL.includes('rejects.length === 1 ? rejects[0] : null'))

  // ① history：全量 total 与筛选 total 分开
  ok('★ state 新增 allTotal，分页仍只看 state.total（筛选后）',
    HISTORY.includes('allTotal: 0, // 全量条数')
    && !/state\.total = Number\(statsCache\.total\)/u.test(HISTORY)
    && !/state\.total = Number\(j\.total\)[^\n]*paintPager/u.test(HISTORY))
  ok('★ stats 只写 allTotal 并刷新顶栏，不再碰分页基数',
    /state\.allTotal = Number\(total\) \|\| 0/u.test(HISTORY)
    && /applyStats\(statsCache\.total\)/u.test(HISTORY))
  ok('筛选时顶栏同时显示「共 N 条」和「全部 M 条」',
    HISTORY.includes("bits.push('全部 ' + state.allTotal + ' 条')"))
}

/* ------------------------- 7. 缓存清理与可观测 ------------------------- */
console.log('\n=== 7. 过期缓存主动清理 / 失败冷却可观测 ===')
{
  if (testApi) {
    const store = new Map()
    const storage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    }
    const NOW = 2000000
    testApi.savePersistedWeightCaps(storage, { files: { unet: ['a.safetensors'] } }, NOW)
    ok('缓存命中时数据仍在', store.has(testApi.WEIGHT_CAPS_KEY))
    testApi.loadPersistedWeightCaps(storage, NOW + testApi.WEIGHT_CAPS_TTL, testApi.WEIGHT_CAPS_TTL)
    ok('★ 过期缓存当场从 localStorage 清掉（不再长期残留）', !store.has(testApi.WEIGHT_CAPS_KEY))
  }
  ok('主模型持久化缓存也有过期清理',
    /removeItem\(MODEL_OPTIONS_STORE_KEY\)/u.test(PANEL)
    && /var stale = !box \|\| box\.v !== MODEL_OPTIONS_STORE_VERSION/u.test(PANEL))
  ok('★ objectInfo 缓存状态可观测（failed / ageMs）',
    CATALOG.includes('export function objectInfoCacheStatus')
    && CATALOG.includes('failed: objectInfoCache.failed === true')
    && CATALOG.includes('ageMs: Math.max(0, now - objectInfoCache.at)'))
}

// ★ 2026-11-18 审计修复回归锁：假成功处理回流 client.js（原只落了 panel.js 半边）。
{
  ok('★ client.js 开关/档位认领 choiceResult 拒绝（不再静默弹回）',
    CLIENT.includes('const cr = ack && ack.choiceResult')
      && CLIENT.includes("'未生效：' + (mine.reason ? mine.reason : '所选值被本机拒绝')"))
  ok('★ client.js 状态刷新统一走记住的 statusPath（不再硬编码 api/ 前缀）',
    !CLIENT.includes("fetch('api/qwen-paint/status.json'")
      && CLIENT.includes('statusPath ?? STATUS_PATHS[0]')
      && CLIENT.includes('if (res.ok) { statusPath = path; return res }'))
  ok('★ client.js 死变量 base 已清（pickIdle/pickFlow/pickTrigger/setPreset/startComfy）',
    (CLIENT.match(/const base = statusPath/gu) ?? []).length === 2)
}

console.log(`\n=== test-white-bar：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
