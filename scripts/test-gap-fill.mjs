/**
 * scripts/test-gap-fill.mjs —— 2026-11-17 补缺批次的回归锁。
 *
 * 覆盖六项（对应 GitHub Issues 草稿的 M1/M2/M3/M4/M5/H3）：
 *   · M3 队列前台端点（/api/qwen-paint/jobs）
 *   · M1 历史 LoRA 落库 + 按 LoRA 筛选 + 单条读取
 *   · M2 参数包导出 / 一键重画端点
 *   · M5 SaveImage 前缀模板（默认行为逐字节不变）
 *   · H3 视频尾帧 endImage（双轨构图对称 + 契约门禁在源码层锁死）
 *   · M4 ControlNet 预处理纯逻辑（候选节点 / 参数夹取 / 构图 / 缓存键 / 账本）
 *
 * 断言签名铁律：ok(label, cond, detail) / eq(actual, expect, label) ——
 * 标签永远在第一个参数，防止 2026-11-16 那种参数颠倒假绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
// Windows 下 ESM 动态导入只认 file:// URL —— 裸盘符路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

let passed = 0
let failed = 0
function ok(label, cond, detail) {
  if (cond) { passed += 1; console.log('  OK  ', label) }
  else { failed += 1; console.log('  FAIL', label, detail === undefined ? '' : `→ ${detail}`) }
}
function eq(actual, expect, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expect)
  ok(`${label}`, a === e, `实际 ${a} / 期望 ${e}`)
}
function section(t) { console.log(`\n=== ${t} ===`) }

/* ---------------------------------------------------------- M3 队列端点 ---- */
section('M3 队列前台端点（lib/job-endpoints.js）')
{
  const { makeJobHandlers, jobRouteTable } = await imp('lib/job-endpoints.js')
  const calls = []
  const queue = {
    list: () => [{ id: 'a', state: 'pending' }],
    stats: () => ({ pending: 1, running: 0, done: 0, failed: 0, canceled: 0, total: 1 }),
    cancel: (id) => { calls.push(['cancel', id]); return { ok: true, id, reason: '', job: { id } } },
    pause: () => { calls.push(['pause']); return { paused: true } },
    resume: () => { calls.push(['resume']); return { paused: false } },
  }
  const out = []
  const respondJson = (_res, body, code) => out.push({ body, code })
  let local = true
  const handlers = makeJobHandlers({
    isLocalRequest: () => local,
    guardWriteRequest: () => true,
    respondJson,
    readJsonBody: async () => ({ action: 'cancel', id: 'job-1' }),
    queue, log: () => {},
  })
  eq(jobRouteTable(handlers), [['/api/qwen-paint/jobs', handlers.jobsHandler]], '路由表只有 jobs 一条')
  await handlers.jobsHandler({ method: 'GET' }, {})
  eq(out.at(-1).body.jobs.length, 1, 'GET 返回队列列表')
  ok('GET 同时带 stats', out.at(-1).body.stats?.pending === 1)
  await handlers.jobsHandler({ method: 'POST' }, {})
  eq(calls.at(-1), ['cancel', 'job-1'], 'POST cancel 调到同一份真队列')
  ok('cancel 结果如实回传（不假装成功）', out.at(-1).body.ok === true && out.at(-1).body.id === 'job-1')
  local = false
  await handlers.jobsHandler({ method: 'GET' }, {})
  eq(out.at(-1).code, 403, '非本机请求 403')
  local = true
  await handlers.jobsHandler({ method: 'PUT' }, {})
  eq(out.at(-1).code, 405, 'PUT 405')
  // 400 分支：readJsonBody 返回非法 action
  const badHandlers = makeJobHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true, respondJson,
    readJsonBody: async () => ({ action: 'nuke' }), queue, log: () => {},
  })
  await badHandlers.jobsHandler({ method: 'POST' }, {})
  eq(out.at(-1).code, 400, '非法 action 400')
  ok('400 文案列全三个合法动作', String(out.at(-1).body.reason).includes('cancel') && String(out.at(-1).body.reason).includes('pause') && String(out.at(-1).body.reason).includes('resume'))
  ok('index.js 接住 registerExtras 返回值并把同一份 queue 交给端点',
    read('lib/index.js').includes('extrasBundle = registerExtras') && read('lib/index.js').includes('queue: extrasBundle.queue'))
}

/* --------------------------------------- M1 历史 LoRA 落库 / 筛选 / get ---- */
section('M1 历史 LoRA 落库 + 按 LoRA 筛选（lib/history-store.js）')
{
  const { createHistoryStore } = await imp('lib/history-store.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-gapfill-'))
  const log = () => {}
  const store = createHistoryStore({ outputDir: tmp, log })
  if (store.available) {
    store.record({ file_path: 'a.png', prompt: '猫', tool_name: 'draw_image', model: 'comfyui', seed: 1,
      width: 64, height: 64, kind: 'image', extra: { loras: [{ name: 'turbo8.safetensors', strength: 1 }] } })
    store.record({ file_path: 'b.png', prompt: '狗', tool_name: 'draw_image', model: 'comfyui', seed: 2,
      width: 64, height: 64, kind: 'image', extra: {} })
    const hit = await store.query({ lora: 'turbo8' })
    eq(hit.items.map((x) => x.file_path), ['a.png'], '按 LoRA 片段筛选只命中真正用它的记录')
    const none = await store.query({ lora: '不存在的lora' })
    eq(none.items.length, 0, '无命中返回空列表（不假装有结果）')
    const all = await store.query({})
    eq(all.items.length, 2, '不带筛选仍是全量')
    const one = store.get(1)
    ok('get(1) 单条读取', one?.file_path === 'a.png')
    ok('get 的 extra.loras 结构带 name+strength', Array.isArray(one?.extra?.loras) && one.extra.loras[0].strength === 1)
    eq(store.get(999), null, 'get 不存在的 id 返回 null')
    eq(store.get(-1), null, 'get 非法 id 返回 null')
  } else {
    console.log('  SKIP 本环境 node:sqlite 不可用，SQLite 路径断言跳过（CI Node22/24 会跑）')
  }
  const SRC = read('lib/history-store.js')
  ok('buildWhere 的 LIKE 带 ESCAPE 且只匹配 "name" 键（防 wildcard 注入 / 防误伤）',
    SRC.includes("extra LIKE ? ESCAPE '\\\\'") && SRC.includes('%"name":"${safe}%'))
  ok('query opts 收 lora 且截到 128 字符', SRC.includes("lora: String(opts.lora ?? '').trim().slice(0, 128)"))
  ok('store 对外暴露 get', SRC.includes('record, query, remove, get, stats, setExtra, close'))
  // ★ Windows：SQLite 句柄没关就 rmSync 会 EBUSY —— 先 close 再清场，清场失败不致命。
  try { store.close() } catch { /* 已关 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 句柄释放有延迟时留给系统清 */ }
}

/* ----------------------------------------------- M2 导出 / 重画端点 ---- */
section('M2 参数包导出 / 一键重画（lib/history-endpoints.js）')
{
  const { makeHistoryHandlers, historyRouteTable } = await imp('lib/history-endpoints.js')
  const item = {
    id: 7, file_path: 'x.png', prompt: '一只猫', tool_name: 'draw_image', model: 'comfyui',
    steps: 8, cfg: null, seed: 42, width: 1024, height: 1024, kind: 'image', created_at: 't',
    extra: { negative: 'blurry', cfg: 1, unet: 'q.safetensors', loras: [{ name: 'l.safetensors', strength: 1 }] },
  }
  const out = []
  const respondJson = (_res, body, code) => out.push({ body, code })
  let redrawCalls = []
  const handlers = makeHistoryHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true, respondJson,
    readJsonBody: async () => ({ id: 7 }),
    store: { get: (id) => (id === 7 ? item : null), query: async () => ({ items: [] }) },
    redraw: async (args) => { redrawCalls.push(args); return { path: 'out.png', seed: args.seed } },
    log: () => {},
  })
  const paths = historyRouteTable(handlers).map(([p]) => p)
  ok('路由表含 export 与 redraw', paths.includes('/api/qwen-paint/history/export') && paths.includes('/api/qwen-paint/history/redraw'))
  await handlers.historyExportHandler({ method: 'GET', url: '/x?id=7' }, {})
  ok('导出 bundle 字段齐全（unet/loras/cfg 来自 extra）',
    out.at(-1).body.bundle?.unet === 'q.safetensors' && out.at(-1).body.bundle?.loras?.length === 1 && out.at(-1).body.bundle?.cfg === 1)
  eq(out.at(-1).body.draw_args, { prompt: '一只猫', negative: 'blurry', width: 1024, height: 1024, steps: 8, seed: 42 },
    'draw_args 字段对齐 draw_image 入参')
  ok('导出 note 明说 reference/controlImage 不入包', String(out.at(-1).body.note).includes('reference'))
  await handlers.historyExportHandler({ method: 'GET', url: '/x?id=999' }, {})
  eq(out.at(-1).code, 404, '导出不存在的记录 404')
  await handlers.historyRedrawHandler({ method: 'POST' }, {})
  ok('重画调用注入的 redraw（同一 runDraw 链路）', redrawCalls.length === 1 && redrawCalls[0].seed === 42)
  ok('重画响应带产物路径', out.at(-1).body.ok === true && out.at(-1).body.path === 'out.png')
  const vidItem = { ...item, id: 8, kind: 'video', tool_name: 'generate_video' }
  const handlers2 = makeHistoryHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true, respondJson,
    readJsonBody: async () => ({ id: 8 }),
    store: { get: () => vidItem }, redraw: async () => ({}), log: () => {},
  })
  await handlers2.historyRedrawHandler({ method: 'POST' }, {})
  eq(out.at(-1).code, 400, '非 draw_image 记录如实拒绝')
  const handlers3 = makeHistoryHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true, respondJson,
    readJsonBody: async () => ({ id: 1 }),
    store: { get: () => item }, redraw: undefined, log: () => {},
  })
  await handlers3.historyRedrawHandler({ method: 'POST' }, {})
  eq(out.at(-1).code, 500, 'redraw 未接线时如实 500（不假装成功）')
  ok('index.js 把 runDraw 注入 redraw 依赖', read('lib/index.js').includes('redraw: (args, exec = {}) => runDraw(args, exec, { cfg, log })'))
}

/* ----------------------------------------------- M5 前缀模板 ---- */
section('M5 SaveImage 前缀模板（lib/config.js）')
{
  const { applyFilePrefixTemplate, imageSavePrefix } = await imp('lib/config.js')
  eq(applyFilePrefixTemplate(''), '', '未配置 = 空串 = 调用方用默认前缀')
  ok('imageSavePrefix 默认保持历史值', imageSavePrefix({}, {}) === 'dsh-qwen-paint')
  ok('{date} 展开为 ISO 日期', /^\d{4}-\d{2}-\d{2}\//.test(applyFilePrefixTemplate('{date}/qwen')))
  ok('{model} 净化空格为下划线', applyFilePrefixTemplate('{model}/v1', { model: 'qwen fp8 2.1' }).includes('qwen_fp8_2.1'))
  eq(applyFilePrefixTemplate('a/../b'), '', '目录穿越拒绝回落默认')
  eq(applyFilePrefixTemplate('/abs'), '', '绝对路径拒绝')
  eq(applyFilePrefixTemplate('C:\\x'), '', '盘符拒绝')
  ok('连续斜杠收敛', !applyFilePrefixTemplate('a//b').includes('//'))
  ok('默认路径下 SaveImage 前缀取自 imageSavePrefix（源码层锁定）',
    read('lib/config.js').includes('filename_prefix: imageSavePrefix(cfg, plan)'))
  ok('放大链走 upscaleSavePrefix 且模板为空时保持原前缀',
    read('lib/index.js').includes('function upscaleSavePrefix(cfg, tag)') && read('lib/index.js').includes("upscaleSavePrefix(cfg, `VOSR2_${cfg.filePrefix}_`)"))
}

/* ----------------------------------------------- H3 视频尾帧 ---- */
section('H3 视频尾帧 endImage（双轨构图对称）')
{
  const vw = await imp('lib/video-workflow.js')
  const caps = { nodes: {} }
  const plain = vw.buildVideoWorkflow(caps, { prompt: '跑动的猫' })
  ok('不给 endImage：构图里没有 end_image 键（默认路径逐字节不变的前提）', plain.workflow[7].inputs.end_image === undefined)
  const withEnd = vw.buildVideoWorkflow(caps, { prompt: '跑动的猫', endImage: 'E.png' })
  eq(withEnd.workflow[7].inputs.end_image, 'E.png', '硬编码路径：end_image 接到节点 7')
  const mEnd = vw.buildVideoWorkflowFromManifest(caps, { prompt: '跑动的猫', endImage: 'E.png' })
  eq(mEnd.workflow[7].inputs.end_image, 'E.png', '清单路径：end_image 同样接到节点 7')
  eq(mEnd.workflow[7].inputs.start_image, withEnd.workflow[7].inputs.start_image, '双轨 start_image 一致')
  eq(mEnd.workflow[7].inputs.end_image, withEnd.workflow[7].inputs.end_image, '双轨 end_image 一致')
  eq(withEnd.plan.endImage, 'E.png', 'plan 如实记录尾帧')
  eq(vw.buildVideoWorkflow(caps, { prompt: 'x' }).plan.endImage, '', '未给时 plan.endImage 为空串')
  ok('manifest 带条件补丁（nonEmpty 才 set）',
    JSON.stringify(JSON.parse(read('workflows/video-wan22.json')).patches.find((p) => p.id === 'i2v-end-image')).includes('nonEmpty'))
  ok('index.js 有 end_image 契约门禁（0.39.0 无此槽 → 如实报错）',
    read('lib/index.js').includes("getNodeSchema(cfg, WAN_I2V_NODE, signal)") && read('lib/index.js').includes('end_image'))
  ok('generate_video 参数表已登记 endImage 且写明 0.39.0 限制', read('lib/index.js').includes('尾帧参考图的本地绝对路径'))
}

/* ----------------------------------------------- M4 ControlNet 预处理 ---- */
section('M4 ControlNet 预处理纯逻辑（lib/cnet-preprocess.js）')
{
  const cp = await imp('lib/cnet-preprocess.js')
  eq(cp.pickPreprocessNode('canny', new Set(['Canny'])).node, 'Canny', 'Canny 核心节点命中')
  ok('缺节点时如实给原因与候选清单',
    cp.pickPreprocessNode('pose', new Set()).ok === false && cp.pickPreprocessNode('pose', new Set()).reason.includes('OpenPosePreprocessor'))
  ok('不存在的类型直接拒绝', cp.pickPreprocessNode('nope', new Set(['Canny'])).ok === false)
  eq(cp.clampPreprocessParams('canny', { low_threshold: 5000 }), { low_threshold: 999, high_threshold: 200 },
    '参数夹取：越界退边界、缺省退默认')
  const wf = cp.buildPreprocessWorkflow({ image: 'up.png', node: 'Canny', params: { low_threshold: 100, high_threshold: 200 }, prefix: 'p' })
  ok('小工作流三节点：LoadImage → 预处理 → SaveImage',
    wf.workflow['1'].class_type === 'LoadImage' && wf.workflow['2'].class_type === 'Canny' && wf.workflow['3'].class_type === 'SaveImage')
  eq(wf.workflow['2'].inputs.image, ['1', 0], '预处理节点吃 LoadImage 输出')
  eq(cp.buildPreprocessWorkflow({ image: '', node: 'Canny', params: {} }).ok, false, '空 image 拒绝')
  eq(cp.buildPreprocessWorkflow({ image: 'a', node: '../evil', params: {} }).ok, false, '非法节点名拒绝')
  const k1 = cp.cacheKeyOf(Buffer.from('abc'), 'canny', { low_threshold: 100 }, crypto)
  const k2 = cp.cacheKeyOf(Buffer.from('abc'), 'canny', { low_threshold: 100 }, crypto)
  const k3 = cp.cacheKeyOf(Buffer.from('abc'), 'canny', { low_threshold: 150 }, crypto)
  const k4 = cp.cacheKeyOf(Buffer.from('abd'), 'canny', { low_threshold: 100 }, crypto)
  ok('缓存键稳定（同输入同键）', k1 === k2)
  ok('缓存键区分参数与内容（改阈值 / 换图 = 新键）', k1 !== k3 && k1 !== k4)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-cnet-'))
  const cache = cp.createPreprocessCache({ outputDir: tmp, fs, path })
  eq(cache.get('nope'), null, '空账本 get 返回 null')
  fs.writeFileSync(path.join(tmp, 'p.png'), 'x')
  cache.put('k1', 'p.png', 'Canny')
  ok('put 后 get 回读（含节点名）', cache.get('k1')?.node === 'Canny')
  fs.rmSync(path.join(tmp, 'p.png'))
  eq(cache.get('k1'), null, '文件被删后账本条目自动失效（不留死路径）')
  fs.rmSync(tmp, { recursive: true, force: true })
  ok('index.js 已注册 cnet-preprocess 且缓存传具名 fs 面',
    read('lib/index.js').includes("reg('/api/qwen-paint/cnet-preprocess', cnetPreprocessHandler)")
      && read('lib/index.js').includes('fs: { readFileSync, writeFileSync, existsSync }'))
  ok('端点目录登记 4 条新路由',
    ['history/export', 'history/redraw', '/jobs', 'cnet-preprocess'].every((s) => read('lib/integration-state.js').includes(s)))
}

/* ----------------------------------------------- H1 多 ControlNet 链式叠加 ---- */
section('H1 多 ControlNet 链式叠加（真调 buildWorkflow）')
{
  const { buildWorkflow } = await imp('lib/config.js')
  const caps = { nodes: { cnetLoader: true, cnetApply: true } }
  const base = { prompt: 'a fox', width: 512, height: 512, steps: 25, seed: 1 }
  const wf = (args) => buildWorkflow({}, { ...base, ...args }, caps)
  const meta = (w) => JSON.parse(JSON.stringify(w[Symbol.for('dshqp.workflowMeta')] ?? {}))
  // 无栈：图里不应出现 30+ 节点（单路路径逐字节不变的运行时保证）
  const noStack = wf({})
  ok('未给 controlStack 时不生成 30/31/32 节点', !noStack[30] && !noStack[31] && !noStack[32])
  // 两路栈
  const two = wf({ controlStack: [
    { image: 'canny.png', name: 'cnet-canny.safetensors', strength: 0.7 },
    { image: 'depth.png', name: 'cnet-depth.safetensors', startPercent: 0.2, endPercent: 0.8 },
  ] })
  ok('第 1 路 = 节点 30/31/32', two[30]?.class_type === 'LoadImage'
    && two[31]?.class_type === 'ControlNetLoader' && two[32]?.class_type === 'ControlNetApplyAdvanced')
  eq(two[30].inputs, { image: 'canny.png' }, '第 1 路控制图接到 LoadImage')
  eq(two[31].inputs, { control_net_name: 'cnet-canny.safetensors' }, '第 1 路权重接到 Loader')
  ok('第 1 路 positive/negative 从文本编码 5 起（无单路时）',
    JSON.stringify(two[32].inputs.positive) === '["5",0]' && JSON.stringify(two[32].inputs.negative) === '["5",1]')
  ok('第 1 路 strength 用本路覆盖 0.7', two[32].inputs.strength === 0.7)
  ok('第 2 路 = 节点 33/34/35', two[33]?.class_type === 'LoadImage'
    && two[34]?.class_type === 'ControlNetLoader' && two[35]?.class_type === 'ControlNetApplyAdvanced')
  ok('★ 第 2 路 positive/negative 接第 1 路 apply 输出（链式而非并联）',
    JSON.stringify(two[35].inputs.positive) === '["32",0]' && JSON.stringify(two[35].inputs.negative) === '["32",1]')
  ok('第 2 路 start/end 区间生效', two[35].inputs.start_percent === 0.2 && two[35].inputs.end_percent === 0.8)
  ok('KSampler 改接链尾 35', JSON.stringify(two[8].inputs.positive) === '["35",0]'
    && JSON.stringify(two[8].inputs.negative) === '["35",1]')
  ok('栈的 inputs 键与单路逐字一致（契约扫描器安全）',
    JSON.stringify(Object.keys(two[35].inputs).sort()) === JSON.stringify(Object.keys(two[32].inputs).sort()))
  // 单路 + 栈并存：栈从 22 起
  const both = buildWorkflow({ controlnetOverride: 'base.safetensors' },
    { ...base, controlImage: 'base.png', controlStack: [{ image: 'extra.png', name: 'x.safetensors' }] }, caps)
  ok('单路 + 栈并存：栈 positive 接 22（单路 apply）', JSON.stringify(both[32].inputs.positive) === '["22",0]')
  ok('并存时 KSampler 接栈尾 32', JSON.stringify(both[8].inputs.positive) === '["32",0]')
  // 缺权重的路如实跳过
  const skip = wf({ controlStack: [{ image: 'a.png', name: '' }, { image: 'b.png', name: 'y.safetensors' }] })
  ok('缺权重的路跳过且不占节点号', !skip[30] && skip[33]?.class_type === 'LoadImage')
  // 上限 4 路
  const five = wf({ controlStack: Array.from({ length: 5 }, (_, i) => ({ image: `i${i}.png`, name: 'n.safetensors' })) })
  ok('超过 4 路只接前 4 路（节点号到 41 为止）', Boolean(five[39]) && !five[42])
  ok('参数表已登记 controlStack（Agent 可调用）',
    read('lib/schema-defaults.js').includes('controlStack: {') && read('lib/schema-defaults.js').includes("required: ['image', 'name']"))
  ok('index.js 上传栈内每张图并把结果传进构图',
    read('lib/index.js').includes('Promise.all(controlStackRaw.map((x) => uploadReference')
      && read('lib/index.js').includes('controlStack,'))
}

/* ----------------------------------------------- H2 参考图独立权重 + mask ---- */
section('H2 参考图每张独立权重 / 衰减 / mask（真调 planReferenceControls）')
{
  const rs = await imp('lib/reference-strategy.js')
  const { applyReferencePlan, planReference, UNIVERSAL_FALLBACK } = rs
  // 一张有 VAE 接线、有 KSampler 的最简工作流（与 test-reference-strategy 的夹具同构）
  const wf = () => ({
    1: { class_type: 'VAELoader', inputs: { vae_name: 'v.pth' } },
    5: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], text: 'x' } },
    3: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 0] } },
    8: { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0], steps: 25 } },
  })
  const nodeSet = new Set(['LatentComposite', 'VAEEncode', 'VAEEncodeForInpaint'])
  const noCtl = rs.planReferenceControls(wf(), { refs: ['a.png'], controls: [] }, nodeSet)
  ok('不给 controls → 零漂移（不落地）', noCtl.applied === false)
  const onlyRange = rs.planReferenceControls(wf(), { refs: ['a.png'], controls: [{ startPercent: 0.2 }] }, nodeSet)
  ok('只给 start/end（本机无门控）→ 零漂移且如实说', onlyRange.applied === false && onlyRange.notes.some((n) => n.includes('零漂移')))
  const two = rs.planReferenceControls(wf(), { refs: ['a.png', 'b.png'], controls: [
    { weight: 0.8 }, { weight: 0.4, mask: 'm.png' },
  ] }, nodeSet)
  ok('两张图分别编码（含 mask 那张走 VAEEncodeForInpaint）',
    two.nodePatches.filter((p) => p.spec.class_type === 'VAEEncode').length === 1
    && two.nodePatches.some((p) => p.spec.class_type === 'VAEEncodeForInpaint'))
  ok('mask 图单独 LoadImage 并接进 VAEEncodeForInpaint.mask',
    two.nodePatches.some((p) => p.spec.inputs?.mask?.[0] === '__cp_h2_mask_1'))
  ok('★ 权重→feather：0.8 的 feather=0.2，0.4 的 feather=0.6',
    two.nodePatches.some((p) => p.spec.class_type === 'LatentComposite' && p.spec.inputs.feather === 0.6))
  ok('第二张 composite 的 samples_to 接第一张结果（链式合并）',
    two.nodePatches.find((p) => p.id === '__cp_h2_composite_1')?.spec.inputs.samples_to?.[0] === '__cp_h2_vae_0')
  ok('KSampler.latent_image 改接链尾', two.rewires.some((r) => r.nodeId === '8' && r.input === 'latent_image'))
  ok('notes 里如实写明 feather 不是 IP-Adapter weight', two.notes.some((n) => n.includes('不是') || n.includes('非 IP-Adapter')))
  const missingNode = rs.planReferenceControls(wf(), { refs: ['a.png'], controls: [{ weight: 0.5 }] }, new Set())
  ok('缺 LatentComposite → 不接且给原因（不臆造节点）', missingNode.applied === false && missingNode.notes.some((n) => n.includes('缺')))
  const before = JSON.stringify(wf())
  const applied = applyReferencePlan(wf(), two)
  ok('applyReferencePlan 返回新对象，不改入参', applied.workflow !== wf() && JSON.stringify(wf()) === before)
  ok('应用后新增节点存在且 KSampler 已改接', Boolean(applied.workflow.__cp_h2_composite_1)
    && JSON.stringify(applied.workflow[8].inputs.latent_image) === '["__cp_h2_composite_1",0]')
  // 与既有兜底叠加的端到端：先 planReference 再 planReferenceControls
  const base = applyReferencePlan(wf(), planReference(UNIVERSAL_FALLBACK, { mode: 'image', refs: ['a.png'], workflow: wf() }))
  const stacked = rs.planReferenceControls(base.workflow, { refs: ['a.png', 'b.png'], controls: [{ weight: 0.7 }, { weight: 0.3 }] }, nodeSet)
  ok('H2 能在既有兜底图上继续叠加（additive）', stacked.applied === true)
  ok('参数表已登记 referenceControls', read('lib/schema-defaults.js').includes('referenceControls: {'))
  ok('index.js 把 args.referenceControls 传进 applyReferenceToWorkflow',
    read('lib/index.js').includes('controls: args?.referenceControls'))
}

/* ----------------------------------------------- H4 视频段级续跑账本 ---- */
section('H4 视频段级续跑（真调 resume-store）')
{
  const { createResumeStore, segmentKey, stableKey, RESUME_TTL_MS } = await imp('lib/resume-store.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-resume-'))
  const mk = (now) => createResumeStore({ outputDir: tmp, fs, path, now: now ?? (() => Date.now()) })
  const job = { prompt: 'a cat running', negative: 'blurry', width: 832, height: 480, fps: 24, startImage: 'first.png' }
  const segs = [
    { index: 0, frameCount: 25, seed: 7 },
    { index: 1, frameCount: 25, seed: 15 },
    { index: 2, frameCount: 17, seed: 23 },
  ]
  ok('段 key 含 index/帧数/seed/prompt/首帧（任一变 = 新段）',
    segmentKey(segs[0], job) !== segmentKey({ ...segs[0], seed: 8 }, job)
    && segmentKey(segs[0], job) !== segmentKey(segs[0], { ...job, startImage: 'other.png' })
    && segmentKey(segs[0], job) !== segmentKey(segs[1], job))
  ok('稳定 key 与键顺序无关', stableKey({ a: 1, b: 2 }) === stableKey({ b: 2, a: 1 }))
  const s = mk()
  const b = s.begin(job, segs)
  ok('首次 begin：fresh=true，每段一个 key', b.fresh === true && b.keys.length === 3)
  const p0 = path.join(tmp, 'seg0.mp4')
  fs.writeFileSync(p0, 'video0')
  ok('段完成记账成功', s.complete(b.id, b.keys[0], { path: p0, frameCount: 25, jobId: 'pid-0' }) === true)
  ok('未登记的 key 拒绝记账', s.complete(b.id, 'bad-key', { path: p0 }) === false)
  eq(s.status(b.id).done, 1, '状态：已完成 1 段')
  const b2 = s.begin(job, segs)
  eq(b2.reusable.map((x) => x.index), [0], '同参数重跑：复用已完成的第 0 段')
  ok('复用段的产物路径是真存在的', b2.reusable[0]?.path === p0 && fs.existsSync(b2.reusable[0].path))
  // 中间段完成、第 0 段没完成 → 不能跳过第 1 段（保持段序）
  const s2 = mk(() => 1000)
  const c = s2.begin(job, segs)
  const p1 = path.join(tmp, 'seg1.mp4')
  fs.writeFileSync(p1, 'video1')
  s2.complete(c.id, c.keys[1], { path: p1, frameCount: 25 })
  eq(s2.begin(job, segs).reusable.length, 0, '★ 中间段完成但第 0 段没完成 → 不从中间续（保持段序）')
  // 产物被删 → 不算可复用
  fs.rmSync(p0)
  eq(s.begin(job, segs).reusable.length, 0, '产物被删 → 整条重跑，不拿死路径糊弄')
  // 过期 → 不复用
  const now = { t: 100000 }
  const s3 = mk(() => now.t)
  const d = s3.begin(job, segs)
  const p2 = path.join(tmp, 'seg2.mp4')
  fs.writeFileSync(p2, 'v')
  s3.complete(d.id, d.keys[0], { path: p2 })
  now.t += RESUME_TTL_MS + 1
  eq(s3.begin(job, segs).reusable.length, 0, '超 2 小时 → 不拿隔夜产物糊弄')
  ok('index.js 每段完成当场记账 + 参数表登记 resumeVideo',
    read('lib/index.js').includes('resumeStore.complete(resumed.id, resumed.keys[si]')
      && read('lib/index.js').includes('resumeVideo:'))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 句柄延迟 */ }
}

/* ----------------------------------------------- L1 WebSocket 渐进预览 ---- */
section('L1 渐进预览（真调 ws-preview 纯逻辑 + 假 WS）')
{
  const wsp = await imp('lib/ws-preview.js')
  // 二进制帧解析：8 字节头（type=1）+ PNG 魔数
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1]), pngHead, Buffer.from('payload')])
  const parsed = wsp.parsePreviewFrame(frame)
  ok('解析 ComfyUI 预览帧（4 字节头 type=1 + PNG）', parsed.ok === true && parsed.mime === 'image/png')
  ok('帧载荷不含 4 字节头', parsed.bytes.subarray(0, 8).equals(pngHead))
  eq(wsp.parsePreviewFrame(Buffer.from([0, 0, 0, 2, 1, 2, 3, 4, 5, 6, 7])).ok, false, '非图片类型帧拒绝')
  eq(wsp.parsePreviewFrame(Buffer.from([0])).ok, false, '过短帧拒绝')
  ok('data-url 形态可直接给 <img>', parsed.ok && parsed.mime && true)
  const store = wsp.createPreviewStore()
  store.setProgress('p1', 3, 20, 'KSampler')
  eq(store.snapshot('p1').progress.percent, 15, '进度百分比来自真 progress（value/max）')
  store.setPreview('p1', parsed.mime, parsed.bytes)
  const snap = store.snapshot('p1')
  ok('预览帧以 data-url 返回（不吐 Buffer）', snap.preview?.dataUrl?.startsWith('data:image/png;base64,'))
  ok('不同 prompt 的快照互不串', store.snapshot('p2').found === false)
  store.clear('p1')
  eq(store.snapshot('p1').found, false, 'clear 后不再读到旧帧')
  const bridgeNo = wsp.createWsPreviewBridge({ WebSocketImpl: null, store })
  ok('无 WebSocket（Node 20）如实 unavailable + reason', bridgeNo.ok === false && bridgeNo.reason.includes('WebSocket'))
  class FakeWS { constructor(url) { this.url = url; globalThis.__fakeWs = this } close() {} }
  const bridge = wsp.createWsPreviewBridge({ WebSocketImpl: FakeWS, store, comfyUrl: 'http://127.0.0.1:8188' })
  ok('有 WebSocket 时连本机 ws://（http→ws）', bridge.ok === true && globalThis.__fakeWs.url.startsWith('ws://127.0.0.1:8188/ws'))
  // JSON 消息翻译
  const r1 = wsp.handleWsJson(store, { type: 'executing', data: { prompt_id: 'p9', node: 'KSampler' } }, '')
  eq(r1.id, 'p9', 'executing 消息确定当前 prompt')
  const r2 = wsp.handleWsJson(store, { type: 'progress', data: { value: 5, max: 10 } }, r1.id)
  ok('progress 无 prompt_id 时用 currentId 兜底并落进度', r2.applied === true && store.snapshot('p9').progress.percent === 50)
  ok('端点与导入已接线',
    read('lib/index.js').includes("reg('/api/qwen-paint/preview'")
    && read('lib/index.js').includes('createWsPreviewBridge'))
}

/* ------------------------------------------------------- L2 外部工作流导入 ---- */
section('L2 外部 ComfyUI 工作流导入（lib/workflow-import.js + endpoints）')
{
  const wi = await imp('lib/workflow-import.js')
  const { makeWorkflowImportHandlers, workflowImportRouteTable } = await imp('lib/workflow-import-endpoints.js')

  // —— 结构校验 ——
  ok('合法 API 格式通过校验', wi.inspectWorkflow({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['2', 0] } },
    '2': { class_type: 'KSampler', inputs: { seed: 42, steps: 4 } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  }).ok === true)
  const uiFmt = wi.inspectWorkflow({ nodes: [{ id: 1 }], links: [] })
  ok('UI 格式（nodes+links）被明确拒绝并提示 Export (API)',
    uiFmt.ok === false && uiFmt.errors[0].includes('API'))
  ok('空工作流被拒', wi.inspectWorkflow({}).ok === false)
  ok('缺 class_type 被拒', wi.inspectWorkflow({ '1': { inputs: {} } }).ok === false)
  ok('悬空节点引用被拒', wi.inspectWorkflow({
    '1': { class_type: 'KSampler', inputs: { latent_image: ['99', 0] } },
  }).ok === false)
  eq(wi.inspectWorkflow({
    '1': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  }).summary.outputs.map((o) => o.classType), ['SaveImage'], '输出节点被识别')

  // —— 节点覆盖 ——
  const smallGraph = {
    '1': { class_type: 'KSampler', inputs: { seed: 1 } },
    '2': { class_type: 'SaveImage', inputs: {} },
  }
  const covMissing = wi.nodeCoverage(smallGraph, { KSampler: {} })
  ok('本机 objectInfo 缺失节点如实列出', covMissing.checked === true && covMissing.missing.includes('SaveImage'))
  const covNoInfo = wi.nodeCoverage(smallGraph, null)
  ok('未提供 objectInfo 时 checked=false 不猜测', covNoInfo.checked === false)

  // —— 可绑定槽位 ——
  const slots = wi.detectBindableSlots({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
    '2': { class_type: 'KSampler', inputs: { seed: 7, steps: 4 } },
    '3': { class_type: 'UNETLoader', inputs: { unet_name: 'm.safetensors' } },
    '4': { class_type: 'Foo', inputs: { latent: ['2', 0] } },
  })
  ok('text/seed 归 param，模型名归 asset', slots.some((s) => s.scope === 'param' && s.key === 'seed')
    && slots.some((s) => s.scope === 'asset' && s.key === 'unet'))
  ok('节点引用不算可绑定槽位', !slots.some((s) => s.input === 'latent'))

  // —— 模板化 ——
  const tpl = wi.buildTemplate({
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '2': { class_type: 'KSampler', inputs: { seed: 42 } },
  }, { id: 'my-flow', label: '我的流程' })
  eq(tpl.graph['1'].inputs.text, '$param.text', '字面量换成 param 占位符')
  eq(tpl.graph['2'].inputs.seed, '$param.seed', 'seed 换成占位符')
  ok('params 声明已生成', tpl.params.text !== undefined && tpl.params.seed.default === 42)
  ok('模板标记为 imported，不进包内清单', tpl.imported === true && tpl.schemaVersion === 1)
  let threw = false
  try { wi.buildTemplate({}, { id: '../escape' }) } catch { threw = true }
  ok('id 路径穿越被拒', threw)

  // —— 注册表 ——
  const reg = wi.createImportRegistry({ maxEntries: 2 })
  reg.put(tpl)
  ok('注册表 put / get / list', reg.size() === 1 && reg.get('my-flow')?.label === '我的流程' && reg.list().length === 1)
  reg.put({ ...tpl, id: 'second' })
  let capHit = false
  try { reg.put({ ...tpl, id: 'third' }) } catch { capHit = true }
  ok('注册表容量上限生效', capHit === true)
  ok('remove 生效', reg.remove('second') === true && reg.size() === 1)

  // —— 端点层（假 deps，不联网） ——
  const captured = []
  const respond = (res, body, code) => captured.push({ body, code })
  const h = makeWorkflowImportHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true,
    respondJson: respond,
    readJsonBody: async () => ({
      id: 'ep-flow', label: 'EP',
      workflow: { '1': { class_type: 'SaveImage', inputs: {} } },
    }),
    registry: wi.createImportRegistry(),
    loadObjectInfo: async () => ({ SaveImage: {} }),
    log: () => {},
  })
  eq(workflowImportRouteTable(h).map((r) => r[0]), ['/api/qwen-paint/workflow-import'], '端点路由表')
  await h.handlersHandler({ method: 'POST', url: '/api/qwen-paint/workflow-import' }, {})
  ok('POST 导入返回 ok + 节点覆盖', captured.at(-1).body.ok === true && captured.at(-1).body.coverage.checked === true)
  await h.handlersHandler({ method: 'GET', url: '/api/qwen-paint/workflow-import?id=ep-flow' }, {})
  ok('GET ?id= 取回模板', captured.at(-1).body.ok === true && captured.at(-1).body.template.id === 'ep-flow')
  const denied = []
  const h2 = makeWorkflowImportHandlers({
    isLocalRequest: () => false, guardWriteRequest: () => true,
    respondJson: (res, body, code) => denied.push({ body, code }),
    readJsonBody: async () => ({}), registry: wi.createImportRegistry(), log: () => {},
  })
  await h2.handlersHandler({ method: 'GET', url: '/api/qwen-paint/workflow-import' }, {})
  ok('非本机请求 403', denied.at(-1).code === 403)

  ok('端点与目录已接线',
    read('lib/index.js').includes('makeWorkflowImportHandlers')
    && read('lib/integration-state.js').includes("'/api/qwen-paint/workflow-import'"))
}

/* ----------------------------------------------- 原生 2K（无需先生成再放大） ---- */
section('原生 2048×2048：尺寸直达 EmptyLatentImage，不靠放大')
{
  const { buildWorkflow, DEFAULTS } = await imp('lib/config.js')
  // ⚠ cfg 必须带 DEFAULTS 的 forceOptimizedSize:false；裸 {} 走的是「自测锁 1024」老语义。
  const native = buildWorkflow({ forceOptimizedSize: false }, {
    prompt: 'a fox', width: 2048, height: 2048, steps: 8, seed: 1,
  }, { nodes: {} })
  ok('2048² 原样进 EmptyLatentImage（32 对齐后仍是 2048）',
    native[6]?.class_type === 'EmptyLatentImage'
    && native[6].inputs.width === 2048 && native[6].inputs.height === 2048)
  ok('裸 {} 仍锁 1024（自测老语义），但产品默认值已放开',
    buildWorkflow({}, { prompt: 'x', width: 2048, height: 2048 }, { nodes: {} })[6].inputs.width === 1024
    && DEFAULTS.forceOptimizedSize === false && DEFAULTS.upscaleAfter === 0)
  ok('taskMaxCanvasEdge 只约束局部重绘裁剪，不限制文生图 2048',
    read('lib/turbo-workflow.js').includes('preresize_max_width: maxEdge')
    && !read('lib/config.js').includes('width > 2048'))
  ok('alpha 不造假：默认参数里没有 alpha 开关，也没有 RGBA latent 节点',
    !Object.hasOwn(DEFAULTS, 'alpha')
    && !read('lib/schema-defaults.js').includes('nativeAlpha')
    && !read('lib/config.js').includes('zz_rgba2rgb'))
}

/* ----------------------------------------------- EasyCache 步级复用（默认关） ---- */
section('EasyCache 步级复用（本机真实节点契约 / 默认零漂移）')
{
  const { buildWorkflow, DEFAULTS } = await imp('lib/config.js')
  const base = { prompt: 'a fox', width: 512, height: 512, steps: 8, seed: 1 }
  const caps = { nodes: { easyCache: true } }
  const run = (cfg, c = caps) => buildWorkflow(cfg, { ...base, ...(cfg.args ?? {}) }, c)
  const off = run({})
  const on = run({ easyCacheEnabled: true })
  ok('★ 默认关：图里没有节点 42，也没有 EasyCache 类',
    off[42] === undefined && !Object.values(off).some((n) => n?.class_type === 'EasyCache'))
  ok('打开 + 探测到节点 → 42 号挂上 EasyCache', on[42]?.class_type === 'EasyCache')
  ok('★ KSampler 的 model 指向 42（真的在链上，不是挂了不用）',
    JSON.stringify(on[8].inputs.model) === '["42",0]')
  eq(on[42].inputs, {
    model: ['1', 0], reuse_threshold: 0.2,
    start_percent: 0.15, end_percent: 0.95, verbose: false,
  }, '★ 输入逐字对齐本机 nodes_easycache.py 的真实签名')
  const tuned = run({
    easyCacheEnabled: true, easyCacheReuseThreshold: 9,
    easyCacheStartPercent: -1, easyCacheEndPercent: 2, easyCacheVerbose: true,
  })
  ok('越界参数被夹取（0..3 / 0..1 / 0..1），verbose 为真',
    tuned[42].inputs.reuse_threshold === 3
    && tuned[42].inputs.start_percent === 0
    && tuned[42].inputs.end_percent === 1
    && tuned[42].inputs.verbose === true)
  ok('★ 没探测到节点时即使配置打开也不发未知节点',
    run({ easyCacheEnabled: true }, { nodes: { easyCache: false } })[42] === undefined)
  ok('开关两态都不留无 class_type 的空节点',
    [off, on].every((w) => !Object.values(w).some((n) => n && n.class_type === undefined)))
  // ★ 节点号冲突防线：20-22/30-41 属 ControlNet，EasyCache 只能占 42。
  const withStack = buildWorkflow({ easyCacheEnabled: true }, {
    ...base,
    controlStack: Array.from({ length: 4 }, (_, i) => ({ image: `i${i}.png`, name: 'n.safetensors' })),
  }, { nodes: { easyCache: true, cnetLoader: true, cnetApply: true } })
  ok('★ 4 路 ControlNet 占满 30..41 时 EasyCache 仍在 42（互不覆盖）',
    withStack[41]?.class_type === 'ControlNetApplyAdvanced'
    && withStack[42]?.class_type === 'EasyCache')
  ok('默认值齐备且默认关', ['easyCacheEnabled', 'easyCacheReuseThreshold', 'easyCacheStartPercent',
    'easyCacheEndPercent', 'easyCacheVerbose'].every((k) => Object.hasOwn(DEFAULTS, k))
    && DEFAULTS.easyCacheEnabled === false)
  ok('能力探测与 caps 都登记了 easyCache',
    read('lib/config.js').includes("getNodeSchema(cfg, 'EasyCache', signal)")
    && read('lib/config.js').includes("easyCache: up('easyCache')"))
  ok('面板开关与配置端点已接线（key=easycache）',
    read('lib/describe.js').includes("key: 'easycache'")
    && read('lib/index.js').includes("['easycache', 'easyCacheEnabled', 'EasyCache 步级复用']"))
  ok('注意力后端接的是 EasyCache 之后的模型链尾',
    read('lib/config.js').includes('model: [nodeAfterEasyCache, 0]'))
}

/* ------------------- 节点号冲突防线第二刀：attention（43）× 4 路 ControlNet（30..41）---- */
section('attention 后端 × 4 路 ControlNet（2026-11-20 虫修复：旧值 40 被 stack 覆盖）')
{
  const { buildWorkflow } = await imp('lib/config.js')
  const base = { prompt: 'a fox', width: 512, height: 512, steps: 8, seed: 1 }
  const caps = { nodes: { QwenImage21SageAttentionT8: true, cnetLoader: true, cnetApply: true } }
  const stack4 = Array.from({ length: 4 }, (_, i) => ({ image: `i${i}.png`, name: 'n.safetensors' }))
  // ★ 2026-11-20 实锤的潜伏虫：attention 曾占 40 号，而 4 路 ControlNet 的第 4 路
  //   loaderId 也是 40（30+i*3+1，i=3）—— stack 块后执行会把它写成 ControlNetLoader，
  //   attention 节点被顶掉、KSampler.model 还指着 40（指向了错误节点）。
  //   两开关默认皆关所以从未在真机爆过；EasyCache 当年特意避开 30..41 选 42，attention 漏避让。
  const w = buildWorkflow({ attentionBackend: 'sage_attention' }, { ...base, controlStack: stack4 }, caps)
  ok('★ 4 路 stack 占满 30..41 时 attention 在 43（不再撞 40）',
    w[40]?.class_type === 'ControlNetLoader' && w[43]?.class_type === 'QwenImage21SageAttentionT8',
    JSON.stringify({ n40: w[40]?.class_type, n43: w[43]?.class_type }))
  ok('★ KSampler 的 model 指向 43（attention 真的在链末端）',
    JSON.stringify(w[8].inputs.model) === '["43",0]', JSON.stringify(w[8].inputs.model))
  ok('全图没有无 class_type 的空节点',
    !Object.values(w).some((n) => n && n.class_type === undefined))
  const wOff = buildWorkflow({}, { ...base, controlStack: stack4 }, caps)
  ok('attention 关闭时 43 不出现（不留幽灵槽位）', wOff[43] === undefined)
  const wNoStack = buildWorkflow({ attentionBackend: 'sage_attention' }, base, caps)
  ok('不带 stack 时 attention 照常在 43 且接 EasyCache 之后的链尾',
    wNoStack[43]?.class_type === 'QwenImage21SageAttentionT8'
    && JSON.stringify(wNoStack[43].inputs.model).startsWith('["'))
}

/* ----------------------------------------------- 分块重绘 tile_inpaint（默认关） ---- */
section('分块重绘：核心节点逐块采样 + 正弦羽化合并（默认零漂移）')
{
  const idx = await imp('lib/index.js')
  const { buildTaskWorkflow, DEFAULTS } = idx.__internal
  const caps = {
    level: 'full', nodes: {
      qwen21: true, editPlus: true, manualSigmas: true, samplerAdvanced: true,
      basicGuider: true, inpaintCrop: true, inpaintStitch: true, colorMatch: true,
      tileSplit: true, tileMerge: true, imageSize: true,
    },
    models: {
      unet: 'u.safetensors', officialTurbo: 't.safetensors', clip: 'c.safetensors',
      vae: 'v.safetensors', consistencyLora: 'l.safetensors',
    },
    gpu: { name: 'AMD Radeon RX 7900 XT', vramGB: 20 }, notes: [],
  }
  const args = { mode: 'inpaint', image: 'src.png', mask: 'm.png', prompt: '改色', seed: 9 }
  const wf = (cfg) => buildTaskWorkflow({ ...DEFAULTS, ...cfg }, args, caps)
  const base = wf({})
  ok('★ 默认关：没有分块节点，原单块链逐字节不变',
    !base[52] && !base[53] && !base[54]
    && JSON.stringify(base[41].inputs.image1) === '["12",1]'
    && JSON.stringify(base[49].inputs.image_target) === '["48",0]')
  const on = wf({ tileInpaintEnabled: true })
  ok('打开 → GetImageSize / Split / Merge 三个核心节点都接上',
    on[52]?.class_type === 'GetImageSize'
    && on[53]?.class_type === 'SplitImageToTileList'
    && on[54]?.class_type === 'ImageMergeTileList')
  ok('文本编码与 VAEEncode 都改吃分块列表',
    JSON.stringify(on[41].inputs.image1) === '["53",0]'
    && JSON.stringify(on[42].inputs.pixels) === '["53",0]')
  eq(on[53].inputs, { image: ['12', 1], tile_width: 1024, tile_height: 1024, overlap: 128 },
    '分块参数取默认值（尺寸 1024 / 重叠 128）')
  ok('合并节点用 GetImageSize 的原裁剪宽高（不是猜的常量）+ 羽化重叠',
    JSON.stringify(on[54].inputs.final_width) === '["52",0]'
    && JSON.stringify(on[54].inputs.final_height) === '["52",1]'
    && on[54].inputs.image_list[0] === '48' && on[54].inputs.overlap === 128)
  ok('★ ColorMatch 与回贴吃合并后的整张裁剪图（不是最后一块）',
    JSON.stringify(on[49].inputs.image_target) === '["54",0]'
    && JSON.stringify(on[50].inputs.inpainted_image) === '["49",0]')
  const tuned = wf({ tileInpaintEnabled: true, tileInpaintSize: 600, tileInpaintOverlap: 999 })
  ok('重叠被夹到 tile 的一半以内，尺寸下限 256',
    tuned[53].inputs.tile_width === 600 && tuned[53].inputs.overlap === 300)
  ok('★ 缺核心节点时即使打开也不发未知节点',
    !buildTaskWorkflow({ ...DEFAULTS, tileInpaintEnabled: true }, args,
      { ...caps, nodes: { ...caps.nodes, tileMerge: false } })[53])
  ok('元信息只在打开时多记 tiled（默认 __plan 零漂移）',
    !Object.hasOwn(base.__plan, 'tiled') && on.__plan.tiled === true
    && on.__plan.tileOverlap === 128)
  const contract = JSON.parse(read('scripts/comfy-node-contract.json'))
  const need = {
    SplitImageToTileList: ['image', 'tile_width', 'tile_height', 'overlap'],
    ImageMergeTileList: ['image_list', 'final_width', 'final_height', 'overlap'],
    GetImageSize: ['image'],
  }
  ok('三个节点名与真实输入字段都在本机 /object_info 契约里',
    Object.entries(need).every(([name, keys]) => {
      const c = contract.nodes?.[name]
      const node = Object.values(on).find((x) => x?.class_type === name)
      return !!c && !!node && keys.every((k) => c.schemaInputs.includes(k) && Object.hasOwn(node.inputs, k))
    }))
  ok('面板开关与默认值已接线',
    DEFAULTS.tileInpaintEnabled === false
    && DEFAULTS.tileInpaintSize === 1024 && DEFAULTS.tileInpaintOverlap === 128
    && read('lib/index.js').includes("['tileinpaint', 'tileInpaintEnabled', '分块重绘']")
    && read('lib/describe.js').includes("key: 'tileinpaint'"))
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
console.log('全部通过 ✓')
