#!/usr/bin/env node
/**
 * test-capability-audit.mjs —— 2026-11-14「全面排查清单要求是否真实现」的联动护栏。
 *
 * 背景：用户要求「修完之后全面排查我清单里所有要求的功能到底有没有实现」，
 * 并亲订「单个功能完成 ≠ 最终完成，必须检查是否与整个插件联动」。
 * 上一批次已经有 16 个模块孤儿扫描；本轮补齐时又新增了 2 个模块 + 3 个端点，
 * 所以这里把「新能力是否真的接进注册层 / 端点目录 / UI / 回归」一次性锁死。
 *
 * 覆盖：
 *   · 显存预算 MB→GB 档位错配（真 bug）修复后的行为
 *   · 结构化日志真的落盘、脱敏、可统计；GET/POST 端点围栏
 *   · 每个子任务独立显存上限的读取与设置
 *   · TeaCache 装配计划 / mrfow 术语禁用 / kv_prefix 项目已装配
 *   · TTS 加速补丁「只有探测到槽位才写入」的零污染边界
 *   · doctor 探针契约与简略 / 详情观感
 *   · Agent 端点目录不再为空
 *   · 新模块孤儿扫描 + 三处消费（注册 / 目录 / UI）
 *
 * 全离线：零联网、零出图、零子进程；临时文件只用系统临时目录，用完即删。
 * ok() 风格：本文件统一用 (name, cond)，与 test-accel-chain.mjs 一致。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createExtras } from '../lib/tool-registry.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'
import { buildAgentGuide } from '../lib/agent-guide.js'
import { createEventLog, eventLogRouteTable, EVENT_LOG_FILE } from '../lib/event-log.js'
import { createBudgetStore, runtimeRouteTable } from '../lib/runtime-endpoints.js'
import { buildAssemblyPlan } from '../lib/cache-backends.js'
import { buildAccelChain } from '../lib/accel-chain.js'
import { applyTtsAccelToInputs } from '../lib/tts-workflow.js'
import { buildProbeContract, makeDoctorTool } from '../lib/doctor.js'
import { resolveVramBudget, VRAM_BUDGET_CHOICES } from '../lib/vram-budget.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

const NEW_PATHS = [
  '/api/qwen-paint/events',
  '/api/qwen-paint/vram-budget',
  '/api/qwen-paint/config/conflicts',
]

const fakeDeps = (extra = {}) => ({
  respondJson: (res, body, status) => { res.body = body; res.code = status },
  isLocalRequest: (req) => req.local === true,
  readJsonBody: async () => ({}),
  log: () => {},
  cfg: {},
  tools: [],
  outputDir: '',
  ...extra,
})

async function runHandler(handler, req) {
  const res = {}
  await handler(req, res)
  return res
}

console.log('=== 1. 注册层 / 端点目录 / Agent 指引（三处联动） ===')
{
  const extras = createExtras(fakeDeps())
  const paths = extras.routes.map((r) => r.path)
  ok('createExtras 注册了 3 个新端点',
    NEW_PATHS.every((p) => paths.includes(p)), paths.filter((p) => p.startsWith('/api/qwen-paint/events')).join(','))
  ok('新端点路径互不重复', new Set(paths).size === paths.length)
  const dir = new Set(INTEGRATION_ROUTES.map((r) => r.path))
  ok('★ 3 个新端点都在对外目录里', NEW_PATHS.every((p) => dir.has(p)))
  ok('extras 暴露 eventLog / budgetStore 供宿主复用',
    Boolean(extras.eventLog) && Boolean(extras.budgetStore))

  const guide = buildAgentGuide({ tools: ['doctor', 'run_dag'], routes: INTEGRATION_ROUTES })
  ok('★ Agent 端点目录不再为空（旧代码 routes=[] 恒为空）',
    Array.isArray(guide.endpoints) && guide.endpoints.length === INTEGRATION_ROUTES.length,
    String(guide.endpoints.length))
  ok('tool-registry 把真实端点目录传给 agent-guide',
    read('lib/tool-registry.js').includes('routes: deps.routes || INTEGRATION_ROUTES'))
  // 不只查源码字面量：真调一次 /agent-guide 端点，确认 Agent 实际拿到的目录非空。
  const guideRoute = extras.routes.find((r) => r.path === '/api/qwen-paint/agent-guide')
  const guideRes = await runHandler(guideRoute.handler, { local: true, method: 'GET', url: '/' })
  ok('★ /agent-guide 端点实际返回的端点目录非空（断开 tool-registry 就会红）',
    guideRes.code === 200 && guideRes.body.endpoints.length === INTEGRATION_ROUTES.length,
    String(guideRes.body && guideRes.body.endpoints && guideRes.body.endpoints.length))
  ok('lab.js 有三个新入口', ['vram-budget', 'events', 'config/conflicts']
    .every((p) => read('assets/lab.js').includes("request('" + p + "')")))
  ok('★ lab.js request 链单次解析（cnet 双 .json() 事故回归锁，2026-11-18）',
    !read('assets/lab.js').includes('.then(function (r) { return r.json() })'))
}

console.log('=== 2. 显存预算：MB→GB 档位错配修复（真 bug） ===')
{
  ok('档位表是 0/2/4/8/12/16/24 + 无上限', VRAM_BUDGET_CHOICES.length === 8
    && VRAM_BUDGET_CHOICES.filter((c) => c.gb === null).length === 1)
  const a = buildAccelChain({ vramMb: 8192, kind: 'image' })
  ok('★ vramMb=8192 时 vram_budget.ok=true（旧代码必 false）',
    a.vram_budget.ok === true, JSON.stringify(a.vram_budget))
  ok('★ 8192 MB 收敛到 8 GB 档位', a.vram_budget.gb === 8, String(a.vram_budget.gb))
  ok('加速链回显检测到的显存 MB', a.vram_detected_mb === 8192)
  const b = buildAccelChain({ vramMb: 1024, kind: 'image' })
  ok('★ 1024 MB 收敛到 0 GB（纯 CPU），不是 ok:false',
    b.vram_budget.ok === true && b.vram_budget.gb === 0, JSON.stringify(b.vram_budget))
  const c = buildAccelChain({ vramMb: null, kind: 'video' })
  ok('没传显存时仍用 kind 默认档位', c.vram_budget.ok === true && c.vram_budget.gb === 16)
  ok('resolveVramBudget 拒绝非档位数值', resolveVramBudget({ requested: 8192 }).ok === false)

  const store = createBudgetStore()
  ok('每个 kind 独立存上限', store.set('image', 4).image === 4 && store.set('tts', 2).tts === 2
    && store.get('image') === 4 && store.get('tts') === 2)
  const routes = runtimeRouteTable(fakeDeps({ budgetStore: store }))
  const budgetRoute = routes.find((r) => r.path === '/api/qwen-paint/vram-budget')
  const g = await runHandler(budgetRoute.handler, { local: true, method: 'GET', url: '/?kind=image' })
  ok('GET 显存预算返回 8 档与 6 个 kind',
    g.code === 200 && g.body.choices.length === 8 && g.body.kinds.length === 6)
  ok('GET 显存预算本机围栏 403',
    (await runHandler(budgetRoute.handler, { local: false, method: 'GET', url: '/' })).code === 403)
  const postRoute = runtimeRouteTable(fakeDeps({
    budgetStore: store,
    readJsonBody: async () => ({ kind: 'tts', gb: 12 }),
  }))
  const p = await runHandler(postRoute.find((r) => r.path === '/api/qwen-paint/vram-budget').handler,
    { local: true, method: 'POST', url: '/' })
  ok('★ POST 能按子任务设置上限', p.code === 200 && p.body.ok === true && p.body.gb === 12
    && p.body.overrides.tts === 12, JSON.stringify(p.body))
  const bad = runtimeRouteTable(fakeDeps({
    budgetStore: store,
    readJsonBody: async () => ({ kind: 'image', gb: 7 }),
  }))
  const badRes = await runHandler(bad.find((r) => r.path === '/api/qwen-paint/vram-budget').handler,
    { local: true, method: 'POST', url: '/' })
  ok('非法档位被拒且给理由', badRes.code === 400 && badRes.body.ok === false)
  const conflictRoute = routes.find((r) => r.path === '/api/qwen-paint/config/conflicts')
  const cc = await runHandler(conflictRoute.handler, { local: true, method: 'GET', url: '/' })
  ok('配置矛盾端点是只读报告', cc.code === 200 && cc.body.readonly === true
    && Array.isArray(cc.body.conflicts))
}

console.log('=== 3. 结构化日志：真的落盘、脱敏、可统计 ===')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-events-'))
  try {
    const store = createEventLog({ outputDir: tmp })
    ok('带出图目录时启用', store.enabled === true)
    const r = store.append({
      tool: 'draw_image', kind: 'image', width: 1024, height: 720, steps: 8,
      prompt: '绝对不能落进日志的提示词全文', accel_chain: ['kv_prefix'],
      degrade_reasons: ['teacache：未探测到节点，降级'],
      timings: { queue_ms: 10, load_ms: 20, sample_ms: 30, decode_ms: 40, total_ms: 100 },
      ok: true,
    })
    ok('append 成功', r.ok === true)
    const file = path.join(tmp, EVENT_LOG_FILE)
    ok('★ JSON Lines 文件真的落盘', fs.existsSync(file))
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const row = JSON.parse(lines[0])
    ok('单行是合法 JSON 且含尺寸 / 加速链 / 降级 / 耗时分解',
      row.width === 1024 && row.height === 720 && row.accel_chain[0] === 'kv_prefix'
      && row.degrade_reasons.length === 1 && row.timings.sample_ms === 30 && row.timings.total_ms === 100)
    ok('★ prompt 只留 hash，不落全文',
      !fs.readFileSync(file, 'utf8').includes('绝对不能落进日志的提示词全文') && row.prompt_hash.length === 12)
    ok('统计摘要有行数 / 均值 / 按链分组',
      store.summarize().rows === 1 && store.summarize().by_chain.kv_prefix === 1)
    ok('recent 只回解析成功的行', store.recent(10).length === 1)
    const disabled = createEventLog({})
    ok('没出图目录时明确不启用', disabled.enabled === false
      && disabled.append({}).ok === false)

    const routes = eventLogRouteTable(fakeDeps({ eventLog: store }))
    const evRoute = routes.find((r) => r.path === '/api/qwen-paint/events')
    const g = await runHandler(evRoute.handler, { local: true, method: 'GET', url: '/' })
    ok('GET 事件端点返回统计与最近事件', g.code === 200 && g.body.summary.rows >= 1
      && Array.isArray(g.body.recent))
    ok('GET 事件端点本机围栏 403',
      (await runHandler(evRoute.handler, { local: false, method: 'GET', url: '/' })).code === 403)
    const postRoutes = eventLogRouteTable(fakeDeps({
      eventLog: store,
      readJsonBody: async () => ({ tool: 'draw_image', kind: 'image', timings: { sample_ms: 5 } }),
    }))
    const p = await runHandler(postRoutes[0].handler, { local: true, method: 'POST', url: '/' })
    ok('★ POST 能上报一次生成事件', p.code === 200 && p.body.logged === true
      && store.summarize().rows === 2)
    ok('加速链端点会写一条结构化事件',
      read('lib/accel-chain.js').includes("event: 'accel_chain_snapshot'"))
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
}

console.log('=== 4. TeaCache / mrfow / KV 前缀缓存：装配计划说清「还差什么」 ===')
{
  const plan = buildAssemblyPlan({})
  ok('kv_prefix 是项目已装配项', plan.assembled_by_project.includes('kv_prefix'))
  ok('★ TeaCache 标为「需外部节点」，不假装已装配',
    plan.needs_external_nodes.includes('teacache')
    && plan.steps.find((s) => s.id === 'teacache').status === 'needs-external-node')
  ok('★ mrfow 术语未核实，永不自动启用',
    plan.disabled_terms.includes('mrfow')
    && plan.steps.find((s) => s.id === 'mrfow').status === 'term-unverified')
  ok('timestep 组互斥约束在计划里', Array.isArray(plan.mutual_exclusive_groups.timestep)
    && plan.mutual_exclusive_groups.timestep.length >= 4)
  ok('装配计划明确不等于已装上', plan.note.includes('不等于已经装上'))
  const chain = buildAccelChain({})
  ok('★ 加速链报告透出装配计划', Boolean(chain.assembly)
    && chain.assembly.assembled_by_project.includes('kv_prefix'))
  ok('注册表源码不含用户资料里的倍率',
    !/2\.67|5\.6 倍|7\.1 倍|248ms|31ms/u.test(read('lib/cache-backends.js') + read('lib/tts-accel.js')))
}

console.log('=== 5. TTS 加速补丁：只有探测到槽位才写入（零污染） ===')
{
  const patch = { config: { max_seq_len: 1024, vocoder_mel_dtype: 'float16', streaming: true } }
  const blind = applyTtsAccelToInputs({ text: 'hi' }, patch, [])
  ok('★ 未探测到槽位时参数只回显、不写进节点',
    blind.applied.length === 0 && blind.skipped.length === 3 && !('max_seq_len' in blind.inputs))
  ok('原 inputs 不被改动', blind.inputs.text === 'hi')
  const probed = applyTtsAccelToInputs({ text: 'hi' }, patch, ['max_seq_len', 'vocoder_mel_dtype'])
  ok('探测到槽位才写入', probed.applied.length === 2 && probed.inputs.max_seq_len === 1024
    && probed.inputs.vocoder_mel_dtype === 'float16' && probed.skipped.includes('streaming'))
  ok('buildTtsWorkflow 默认不带 patch 时行为不变',
    read('lib/tts-workflow.js').includes('accelPatch = null'))
  ok('TTS 工作流返回 accel 元数据',
    read('lib/tts-workflow.js').includes('unverified: true'))
}

console.log('=== 6. doctor 探针契约与简略 / 详情观感 ===')
{
  const contract = buildProbeContract({ outputDir: () => ({}) })
  ok('契约列出 8 项', contract.length === 8)
  ok('已注入项标 injected', contract.find((c) => c.id === 'output_dir_writable').injected === true)
  ok('未注入项标 missing，不假装检测',
    contract.filter((c) => c.status === 'missing').length === 7)
  const tool = makeDoctorTool({ probes: { outputDir: async () => ({ ok: true }) }, log: () => {} })
  const brief = await tool.execute({})
  const detail = await tool.execute({ detail: true })
  ok('★ 默认只回一行简略结论', brief.details.length === 0 && brief.probe_contract.length === 0
    && typeof brief.summary === 'string')
  ok('★ 点开才展开逐项详情 + 探针契约',
    detail.details.length === 8 && detail.probe_contract.length === 8)
  ok('output.schema 声明了 probe_contract（否则 Agent 收到空对象）',
    'probe_contract' in tool.output.schema.properties)
  ok('doctor 端点也透出探针契约',
    read('lib/doctor.js').includes('probe_contract: detail ? buildProbeContract'))
}

console.log('=== 7. 孤儿扫描：新模块必须有生产消费（用户亲订纪律） ===')
{
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const prodImporters = (m) => libFiles.filter((f) => f !== m + '.js' && read('lib/' + f).includes(m + '.js'))
  const NEW_MODULES = [
    'event-log', 'runtime-endpoints', 'accel-chain', 'cache-backends', 'tts-accel',
    'vram-budget', 'config-consistency', 'structured-log', 'tool-registry', 'doctor',
    'dag-planner', 'job-queue', 'history-admin', 'iterate-tool', 'gif-tool', 'agent-guide',
    // ★ 2026-11-15 媒体格式转换批次：同样必须逐个有生产 import。
    'media-formats', 'media-exec', 'media-convert-tool', 'media-convert-endpoints',
    'media-postconvert',
  ]
  for (const m of NEW_MODULES) {
    ok('★ ' + m + '.js 有生产 import（只有测试引用不算）', prodImporters(m).length > 0,
      prodImporters(m).join(','))
  }
  ok('lab.js 消费 3 个新端点', NEW_PATHS.every((p) =>
    read('assets/lab.js').includes("request('" + p.replace('/api/qwen-paint/', '') + "')")))
  const privateHits = ['\x43:/Users/\x41dministrator', '\x4B:/ai/', 'gho_', 'github_pat_']
  ok('新增两模块不含本机路径 / 凭据',
    !privateHits.some((x) => read('lib/event-log.js').includes(x) || read('lib/runtime-endpoints.js').includes(x)))
}

console.log('=== test-capability-audit：' + pass + ' 项通过，' + fail + ' 项失败 ===')
process.exit(fail === 0 ? 0 : 1)
