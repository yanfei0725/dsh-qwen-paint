/**
 * scripts/test-batch-guard.mjs —— 第三批：批量扫描 / 部分成功 / 队列感知 / 错误可操作化。
 *
 * 覆盖 C11、C12、C14、C17。
 *
 * ⚠ batch 工具用**注入的假 runOne**，一张图都不会生成 —— 这正是 runOne 走依赖注入的原因。
 * ⚠ ok() 签名是 (cond, name, extra)，helper 内建防假绿自检。
 */
import {
  BATCH_DEFAULT, BATCH_MAX, BATCH_TOOL_NAME, buildSweep, makeBatchTool,
} from '../lib/batch-tool.js'
import {
  QUEUE_BUSY_THRESHOLD, VRAM_TIGHT_RATIO, probeQueueGate, warnQueueGate,
} from '../lib/queue-gate.js'
import { DIAG_CODES, briefDiagnosis, diagnoseError, extractNodeName } from '../lib/diagnose-error.js'

let pass = 0
const failures = []
const ok = (cond, name, extra) => {
  if (typeof name !== 'string' || name.trim() === '' || name === 'true' || name === 'false') {
    throw new Error(`ok() 参数顺序可能写反（name=${JSON.stringify(name)}）`)
  }
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const logs = []
const log = (level, msg) => logs.push({ level, msg })
const GB = 1024 ** 3

// ── 1. C11 参数组合展开 ─────────────────────────────────────────────────────
console.log('\n=== 1. C11 参数组合展开 ===')
{
  const a = buildSweep({ seeds: [1, 2, 3], sizes: ['1024x1024'] })
  ok(a.ok, '种子 + 尺寸 → ok')
  eq(a.combos.length, 3, '3 个种子 × 1 个尺寸 = 3 组')
  eq(a.combos[0].seed, 1, '种子按顺序展开')
  eq(a.combos[0].width, 1024, '尺寸带出宽度')

  const b = buildSweep({ seeds: [7], sizes: ['1024x1024', '832x1216'] })
  eq(b.combos.length, 2, '1 个种子 × 2 个尺寸 = 2 组（笛卡尔积）')
  eq(`${b.combos[1].width}x${b.combos[1].height}`, '832x1216', '第二组是竖版')

  const c = buildSweep({ count: 5 })
  eq(c.combos.length, 5, '不传 seeds/sizes 时按 count 生成')
  ok(c.combos.every((x) => x.seed === null), '★ count 模式下 seed 是 null（由出图链自己随机），不是编一个固定值')
  eq(buildSweep({}).combos.length, BATCH_DEFAULT, `count 默认 ${BATCH_DEFAULT}`)

  eq(buildSweep({ count: 0 }).ok, false, 'count=0 被拒')
  eq(buildSweep({ count: BATCH_MAX + 1 }).ok, false, `count 超 ${BATCH_MAX} 被拒`)
  ok(buildSweep({ count: 99 }).reason.includes(String(BATCH_MAX)), '拒绝时说清上限是多少')

  const over = buildSweep({ seeds: [1, 2, 3, 4, 5], sizes: ['1024x1024', '832x1216', '512x512', '768x768'] })
  eq(over.ok, false, '★ 组合数超上限被拒（不静默截断成 16 张就开跑）')
  ok(over.reason.includes('20'), '拒绝时算出真实组合数 20')

  const badSize = buildSweep({ seeds: [1], sizes: ['abc', '10x', '1024x1024'] })
  eq(badSize.combos.length, 1, '★ 非法尺寸被跳过，只剩合法的那个')
  eq(badSize.combos[0].width, 1024, '留下的是合法尺寸')

  const objSize = buildSweep({ seeds: [1], sizes: [{ width: 640, height: 480 }] })
  eq(objSize.combos[0].width, 640, '也接受 {width,height} 形式')

  const dupSeed = buildSweep({ seeds: [5, 5, 5] })
  eq(dupSeed.combos.length, 1, '★ 重复种子去重（不浪费算力跑三张一样的）')
  const badSeed = buildSweep({ seeds: [1.5, 'x', 3] })
  eq(badSeed.combos.length, 1, '★ 非整数种子被剔除，只留 3')
  eq(badSeed.combos[0].seed, 3, '留下的是合法种子')
}

// ── 2. C12 批量部分成功 ─────────────────────────────────────────────────────
console.log('\n=== 2. C12 批量部分成功 ===')
{
  eq(BATCH_TOOL_NAME, 'batch_draw', '工具名固定')

  // 全成功
  const calls = []
  const t1 = makeBatchTool({
    cfg: { comfyUrl: 'http://127.0.0.1:8188' }, log,
    runOne: async (a) => { calls.push(a); return { path: `/out/s${a.seed}.png`, files: [`/out/s${a.seed}.png`] } },
    fetchFn: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) }),
  })
  const r1 = await t1.execute({ prompt: '一只猫', seeds: [1, 2, 3] })
  ok(r1.ok, '全成功 → ok:true')
  eq(r1.total, 3, 'total=3')
  eq(r1.ok_count, 3, 'ok_count=3')
  eq(r1.fail_count, 0, 'fail_count=0')
  eq(r1.items[0].path, '/out/s1.png', '每项带产物路径')
  eq(calls.map((c) => c.seed).join(','), '1,2,3', '★ 每个种子都真的传给了出图函数')
  ok(calls.every((c) => c.prompt === '一只猫'), 'prompt 整批共用')
  ok(calls.every((c) => c.count === undefined && c.seeds === undefined), '★ seeds/count 这类批量专属参数不透传给单张出图')

  // 中间失败：这是 C12 的核心断言
  const t2 = makeBatchTool({
    cfg: { comfyUrl: 'http://127.0.0.1:8188' }, log,
    runOne: async (a) => {
      if (a.seed === 2) throw new Error('CUDA out of memory: tried to allocate 2.00 GiB')
      return { path: `/out/s${a.seed}.png` }
    },
    fetchFn: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) }),
  })
  const r2 = await t2.execute({ prompt: '一只猫', seeds: [1, 2, 3] })
  eq(r2.total, 3, '★ 中间失败后仍然跑完 3 个（没有整批回滚）')
  eq(r2.ok_count, 2, '成功 2 个')
  eq(r2.fail_count, 1, '失败 1 个')
  eq(r2.ok, false, '有失败时 ok:false（但结果仍然完整）')
  eq(r2.items[1].ok, false, '失败的正是第 2 项')
  ok(r2.items[1].error.includes('out of memory'), '失败项带原始错误摘要')
  eq(r2.items[2].ok, true, '★★ 失败之后的那张照常成功（没被拖垮）')
  ok(r2.items[0].path !== '' && r2.items[2].path !== '', '★ 成功项照常交付产物路径')
  eq(r2.total, r2.ok_count + r2.fail_count, '★★ total === ok + fail（账目自洽）')

  // C17 真的接进了失败项
  eq(r2.items[1].diagnosis.code, 'oom', '★★ 失败项带结构化诊断（识别出 OOM）')
  ok(r2.items[1].diagnosis.fixes.length > 0, '诊断里有可执行的修法')
  ok(r2.items[1].diagnosis.fixes[0].action.includes('显存'), '第一条修法指向显存档位')
  eq(r2.items[1].diagnosis.fixes.length, 2, '批量里只挂前 2 条修法（不撑爆结果）')

  // 全失败也要交出完整账
  const t3 = makeBatchTool({
    cfg: { comfyUrl: 'http://x' }, log,
    runOne: async () => { throw new Error('Cannot execute because node VHS_VideoCombine does not exist') },
    fetchFn: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) }),
  })
  const r3 = await t3.execute({ prompt: 'x', seeds: [1, 2] })
  eq(r3.ok_count, 0, '全失败 → 成功 0')
  eq(r3.fail_count, 2, '全失败 → 失败 2')
  eq(r3.items.length, 2, '★ 全失败也逐项列出（能看出每张为什么失败）')
  eq(r3.items[0].diagnosis.code, 'missing_node', '识别成缺节点')
  eq(r3.items[0].diagnosis.node, 'VHS_VideoCombine', '★ 从错误原文抠出节点名')

  // 复位：失败后要等队列清空
  let queueHits = 0
  const t4 = makeBatchTool({
    cfg: { comfyUrl: 'http://x' }, log, sleep: () => Promise.resolve(),
    runOne: async (a) => { if (a.seed === 1) throw new Error('boom'); return { path: 'p.png' } },
    fetchFn: () => { queueHits += 1; return Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) }) },
  })
  await t4.execute({ prompt: 'x', seeds: [1, 2] })
  ok(queueHits >= 1, '★ 失败后真的去查了一次队列（轻量复位）')

  // 没有失败时不该多打请求
  queueHits = 0
  const t5 = makeBatchTool({
    cfg: { comfyUrl: 'http://x' }, log,
    runOne: async () => ({ path: 'p.png' }),
    fetchFn: () => { queueHits += 1; return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) },
  })
  await t5.execute({ prompt: 'x', seeds: [1, 2, 3] })
  eq(queueHits, 0, '★★ 全成功时零额外请求（复位只在失败后触发）')

  // 入参校验
  const noPrompt = await t5.execute({})
  eq(noPrompt.ok, false, 'prompt 为空 → ok:false')
  const badCount = await t5.execute({ prompt: 'x', count: 99 })
  eq(badCount.ok, false, 'count 超限 → ok:false')
  ok(badCount.note.includes(String(BATCH_MAX)), '拒绝时说明上限')
  const noRunner = await makeBatchTool({ cfg: {}, log }).execute({ prompt: 'x' })
  ok(!noRunner.ok && noRunner.note.includes('内部错误'), '★ 缺注入函数时明确说是插件 bug，不让用户看天书')
  eq(noRunner.total, 0, '缺依赖时账目仍是 0 不是 undefined')
}

// ── 3. C14 队列感知 ─────────────────────────────────────────────────────────
console.log('\n=== 3. C14 队列感知 ===')
{
  eq(VRAM_TIGHT_RATIO, 0.85, '显存紧张阈值 85%')
  eq(QUEUE_BUSY_THRESHOLD, 1, '队列忙的阈值')

  const mk = (queue, stats) => (url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url.endsWith('/queue') ? queue : stats),
  })

  const idle = await probeQueueGate({
    cfg: { comfyUrl: 'http://x' }, fetchFn: mk({ queue_running: [], queue_pending: [] },
      { devices: [{ vram_total: 20 * GB, vram_free: 19 * GB }] }),
  })
  ok(idle.ok && idle.level === 'idle', '★ 队列空 + 显存充足 → idle')
  eq(idle.hint, '', '★ idle 时不给提示（不刷屏）')
  eq(idle.vramFreeGB, 19, '带出空闲显存')
  eq(idle.vramUsedRatio, 0.05, '算出显存占用比例 5%')

  const busy = await probeQueueGate({
    cfg: { comfyUrl: 'http://x' }, fetchFn: mk({ queue_running: [1], queue_pending: [2, 3] },
      { devices: [{ vram_total: 20 * GB, vram_free: 18 * GB }] }),
  })
  eq(busy.level, 'busy', '★ 队列有 3 个任务 → busy')
  eq(busy.running, 1, 'running=1')
  eq(busy.pending, 2, 'pending=2')
  ok(busy.hint.includes('3 个任务'), '提示里带真实队列长度')
  ok(busy.hint.includes('排在它们后面'), '★ 说明"会排队"，而不是"不许提交"')

  const tight = await probeQueueGate({
    cfg: { comfyUrl: 'http://x' }, fetchFn: mk({ queue_running: [], queue_pending: [] },
      { devices: [{ vram_total: 20 * GB, vram_free: 1 * GB }] }),
  })
  eq(tight.level, 'tight', '★ 显存占用 95% → tight')
  ok(tight.hint.includes('OOM'), '提示里点名 OOM 风险')

  const both = await probeQueueGate({
    cfg: { comfyUrl: 'http://x' }, fetchFn: mk({ queue_running: [1, 2], queue_pending: [3] },
      { devices: [{ vram_total: 20 * GB, vram_free: 0.5 * GB }] }),
  })
  eq(both.level, 'tight', '★★ 同时紧张时优先报 tight（排队只是慢，OOM 是直接失败）')

  const noDev = await probeQueueGate({
    cfg: { comfyUrl: 'http://x' }, fetchFn: mk({ queue_running: [], queue_pending: [] }, { devices: [] }),
  })
  eq(noDev.level, 'idle', '★ 拿不到显存信息时不误报紧张')
  eq(noDev.vramUsedRatio, null, '拿不到就是 null，不编一个 0')

  const dead = await probeQueueGate({ cfg: { comfyUrl: 'http://x' }, fetchFn: () => Promise.reject(new Error('x')) })
  ok(!dead.ok && dead.level === 'unknown', '★ 探测失败 → unknown，不抛错')
  eq(dead.hint, '', '探测失败时不给误导性建议')

  const noCfg = await probeQueueGate({ cfg: {}, fetchFn: () => Promise.resolve({ ok: true }) })
  ok(!noCfg.ok && noCfg.reason.includes('缺少'), '缺配置时说明原因')

  // warnQueueGate 只在 busy/tight 时说话
  logs.length = 0
  await warnQueueGate({ comfyUrl: 'http://x' }, log, undefined, {
    fetchFn: mk({ queue_running: [], queue_pending: [] }, { devices: [{ vram_total: 10 * GB, vram_free: 9 * GB }] }),
  })
  eq(logs.length, 0, '★ 一切正常时不写日志（不刷屏）')
  logs.length = 0
  await warnQueueGate({ comfyUrl: 'http://x' }, log, undefined, {
    fetchFn: mk({ queue_running: [1, 2], queue_pending: [] }, { devices: [{ vram_total: 10 * GB, vram_free: 9 * GB }] }),
  })
  ok(logs.some((l) => l.level === 'warn' && l.msg.includes('提交前提示')), '★ 忙的时候写一条 warn')
}

// ── 4. C17 错误可操作化 ─────────────────────────────────────────────────────
console.log('\n=== 4. C17 错误可操作化 ===')
{
  ok(DIAG_CODES.length >= 6, `诊断类别至少 6 个（实际 ${DIAG_CODES.length}）`)

  const oom = diagnoseError(new Error('torch.OutOfMemoryError: HIP out of memory. Tried to allocate 512.00 MiB'))
  eq(oom.code, 'oom', '★ 识别 OOM')
  ok(oom.matched, 'matched:true 表示命中了规则表')
  ok(oom.fixes.length >= 3, '给多条修法')
  ok(oom.fixes.some((f) => f.action.includes('--lowvram')), '修法里点名 --lowvram')
  ok(oom.fixes.some((f) => f.gain.includes('从 OOM 变成可跑')), '★ 给的是条件式收益，不是编出来的百分比')
  ok(!/\d+\.\d+%/.test(oom.fixes.map((f) => f.gain).join('')), '★★ 收益里没有假精确的百分比')

  const node = diagnoseError('Cannot execute because node VHS_VideoCombine does not exist.')
  eq(node.code, 'missing_node', '★ 识别缺节点')
  eq(node.node, 'VHS_VideoCombine', '★★ 抠出节点名')
  ok(node.fixes[0].action.includes('插件包'), '修法指向装插件包')

  const val = diagnoseError('Prompt outputs failed validation: Return type mismatch between linked nodes')
  eq(val.code, 'validation', '★ 识别参数校验失败')
  ok(val.detail.includes('原始报错'), '★ 保留原文摘要（诊断不吞证据）')
  ok(val.fixes.some((f) => f.action.includes('input/')), '★★ 修法里带上本项目实测过的 input/ 前缀经验')

  const model = diagnoseError('Value not in list: unet_name: \'qwen-image.gguf\' not in []')
  eq(model.code, 'missing_model', '★ 识别模型不在候选列表')

  const offline = diagnoseError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8188'))
  eq(offline.code, 'offline', '★ 识别连不上服务')

  const file = diagnoseError(new Error('ENOENT: no such file or directory, open \'K:/x/a.png\''))
  eq(file.code, 'missing_file', '★ 识别文件不存在')
  eq(file.retryable, false, '★★ 文件不存在标记为不可重试（重试多少次都还是不存在）')

  const cancel = diagnoseError('execution_interrupted')
  eq(cancel.code, 'interrupted', '识别中断')
  ok(cancel.fixes[0].action.includes('取消'), '第一条修法先排除"自己点的取消"')

  const unknown = diagnoseError('some weird thing happened')
  eq(unknown.code, 'unknown', '未命中 → unknown')
  eq(unknown.matched, false, 'unknown 时 matched:false')
  ok(unknown.detail.includes('some weird'), '未知错误也把原文带上（否则无从排查）')

  eq(diagnoseError(null).code, 'unknown', 'null 输入不抛')
  eq(diagnoseError({}).code, 'unknown', '空对象不抛')
  ok(diagnoseError(123).raw === '123', '数字输入也不炸')

  // 节点名提取
  eq(extractNodeName('Cannot execute because node Foo does not exist'), 'Foo', '从标准句式提取')
  eq(extractNodeName('{"class_type": "Bar", "inputs": {}}'), 'Bar', '★ 从 node_errors JSON 里提取')
  eq(extractNodeName('nothing here'), '', '抓不到就返回空串（不猜）')

  // 一行摘要
  const brief = briefDiagnosis(new Error('CUDA out of memory'))
  ok(brief.length <= 200, '一行摘要不超过 200 字')
  ok(brief.includes('显存'), '摘要点明是显存问题')
  ok(brief.includes('首要处理'), '★ 摘要里直接给第一步行動')
}

// ── 5. 类别覆盖自检 ─────────────────────────────────────────────────────────
console.log('\n=== 5. 类别覆盖自检 ===')
{
  const seen = new Set()
  const samples = [
    'ECONNREFUSED', 'node Foo does not exist', 'HIP out of memory',
    'Value not in list', 'failed validation', 'ENOENT: no such file',
    'execution_interrupted', '???',
  ]
  for (const s of samples) seen.add(diagnoseError(s).code)
  for (const c of DIAG_CODES) ok(seen.has(c), `类别 ${c} 有对应的识别样例`)
}

console.log(`\ntest-batch-guard: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
