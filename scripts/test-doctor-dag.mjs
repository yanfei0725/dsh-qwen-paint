#!/usr/bin/env node
/**
 * test-doctor-dag.mjs —— 运行期自诊断 + 自适应 DAG 编排回归（全离线）。
 * 锁住：未注入探针绝不假装通过 / 简略与详情两层 / 异常不回吐 error.message /
 *       拓扑排序与环检测 / 悬空依赖 / ensure_comfy 前置 / 取消 / 失败降级 /
 *       dry_run 默认只出计划 / 工具被裁剪后字段仍完整。
 */
import {
  DOCTOR_CHECKS, buildDoctorReport, collectDoctorResults, makeDoctorTool, doctorRouteTable,
} from '../lib/doctor.js'
import {
  STAGE_KINDS, validateDag, topoSort, planDag, runPlan, makeDagPlanner, makeDagTool,
} from '../lib/dag-planner.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, extra ?? '') }
}

console.log('=== 1. doctor 聚合与诚实边界 ===')
{
  ok('检查项 8 条', DOCTOR_CHECKS.length === 8)
  ok('含连通性 / 完整性 / 加速 / 注意力 / 目录 / ffmpeg / TTS / 历史',
    ['comfy_online', 'model_integrity', 'accel_packs', 'attention_backend',
      'output_dir_writable', 'ffmpeg', 'tts_backend', 'history_db']
      .every((id) => DOCTOR_CHECKS.some((c) => c.id === id)))
  const empty = buildDoctorReport([])
  ok('★ 零探针时 8 项全是待检查', empty.pending === 8 && empty.passed === 0)
  ok('★ 零探针时绝不假装通过（ok=false）', empty.ok === false)
  ok('summary 是一行人类可读', /^\d+ 项通过 \/ \d+ 项待检查 \/ \d+ 项异常$/u.test(empty.summary))
  ok('details 长度等于检查项', empty.details.length === 8)

  const mixed = buildDoctorReport([
    { id: 'comfy_online', ok: true, detail: '在线' },
    { id: 'ffmpeg', ok: false, detail: '缺件' },
    { id: 'model_integrity', status: 'undetected', detail: '未检测' },
  ])
  ok('混合结果计数正确', mixed.passed === 1 && mixed.failed === 1 && mixed.pending === 6)
  ok('有异常时 ok=false 且给 reason', mixed.ok === false && mixed.reason.length > 0)
  const allPass = buildDoctorReport(DOCTOR_CHECKS.map((c) => ({ id: c.id, ok: true })))
  ok('全通过时 ok=true', allPass.ok === true && allPass.passed === 8)
}

console.log('=== 2. doctor 探针真跑与工具两层输出 ===')
{
  const logs = []
  const probes = {
    comfyOnline: async () => ({ ok: true, detail: '127.0.0.1 在线' }),
    ffmpeg: async () => { throw new Error('ENOENT \x43:/Users/TestUser/secret/ffmpeg.exe') },
  }
  const rows = await collectDoctorResults(probes, (l, m) => logs.push(m))
  ok('注入的项真跑', rows.find((r) => r.id === 'comfy_online').status === 'pass')
  ok('未注入的项仍是 undetected', rows.filter((r) => r.status === 'undetected').length === 6)
  ok('★ 探针抛错标 fail 且写本机日志',
    rows.find((r) => r.id === 'ffmpeg').status === 'fail' && logs.length === 1)
  ok('★ 抛错详情不含 error.message 里的路径',
    !rows.find((r) => r.id === 'ffmpeg').detail.includes('TestUser')
    && !rows.find((r) => r.id === 'ffmpeg').detail.includes('ENOENT'))

  const tool = makeDoctorTool({ probes, log: () => {} })
  ok('工具名 / 超时正确', tool.name === 'doctor' && tool.timeoutMs > 0)
  ok('description 讲了默认简略', tool.description.includes('摘要') && tool.description.includes('detail'))
  const brief = await tool.execute({})
  ok('★ 默认只回 summary、details 为空', brief.details.length === 0 && brief.summary.length > 0)
  const detail = await tool.execute({ detail: true })
  ok('★ 点开才展开 8 项详情', detail.details.length === 8)
  ok('返回值字段全在 schema 声明内',
    Object.keys(brief).every((k) => k in tool.output.schema.properties))
  const slim = await withDeclaredOutput(tool).execute({ detail: true })
  ok('★ 裁剪后仍完整', slim.details.length === 8 && typeof slim.summary === 'string')

  const routes = doctorRouteTable({
    probes, respondJson: (res, body, code) => { res.body = body; res.code = code },
    isLocalRequest: (req) => req.local !== false, log: () => {},
  })
  ok('端点 1 条且路径正确', routes.length === 1 && routes[0].path === '/api/qwen-paint/doctor')
  const res = { body: null, code: null }
  await routes[0].handler({ local: true, query: {} }, res)
  ok('★ 端点默认简略（details 空）', res.code === 200 && res.body.details.length === 0)
  await routes[0].handler({ local: true, query: { detail: '1' } }, res)
  ok('★ ?detail=1 才展开详情', res.body.details.length === 8)
  await routes[0].handler({ local: false, query: {} }, res)
  ok('★ 非本机请求 403', res.code === 403)
}

const chain = [
  { id: 'a', kind: 'load_model', dependsOn: [] },
  { id: 'b', kind: 'sample', dependsOn: ['a'] },
  { id: 'c', kind: 'decode', dependsOn: ['b'] },
]
console.log('=== 3. DAG 校验与拓扑 ===')
{
  ok('阶段类型齐全', STAGE_KINDS.includes('ensure_comfy') && STAGE_KINDS.includes('mux'))
  ok('合法链校验通过', validateDag(chain).ok === true)
  ok('拓扑序 a,b,c', topoSort(chain).order.join(',') === 'a,b,c' && !topoSort(chain).cycle)
  ok('★ 环能被检出', topoSort([
    { id: 'a', kind: 'sample', dependsOn: ['b'] },
    { id: 'b', kind: 'decode', dependsOn: ['a'] },
  ]).cycle === true)
  ok('★ 悬空依赖被拒', validateDag([{ id: 'a', kind: 'sample', dependsOn: ['ghost'] }]).ok === false)
  ok('★ 重复 id 被拒', validateDag([{ id: 'a', kind: 'sample' }, { id: 'a', kind: 'decode' }]).ok === false)
  ok('★ 未知 kind 被拒', validateDag([{ id: 'a', kind: 'nope' }]).ok === false)
}

console.log('=== 4. 自适应计划与执行 ===')
{
  const p = planDag({ goal: '画一张图并配音做成视频', available: { tts: true, video: true, mux: true },
    constraints: { upscale: true }, comfyOnline: false })
  ok('★ 后端未就绪时插入 ensure_comfy 前置节点',
    p.nodes[0].kind === 'ensure_comfy' && p.nodes[0].dependsOn.length === 0)
  ok('计划含图 / TTS / 视频 / 合流',
    ['sample', 'tts', 'video', 'mux'].every((k) => p.nodes.some((n) => n.kind === k)))
  ok('能力齐全时 degraded=false', p.degraded === false)
  const miss = planDag({ goal: '做成视频并配音', available: { tts: false, video: false } })
  ok('★ 缺能力时降级并写明理由', miss.degraded === true && miss.reasons.length >= 2)
  ok('降级理由不含倍率数字', !miss.reasons.join('').match(/\d+(\.\d+)?\s*(倍|%|ms)/u))
  ok('计划无悬空依赖', validateDag(p.nodes).ok === true)

  const seen = []
  const run = await runPlan(p.nodes, async (n) => { seen.push(n.id); return n.id }, {})
  ok('★ 按拓扑序执行', run.ok === true && seen.length === p.nodes.length && seen[0] === 'ensure_comfy')
  ok('results 每个节点一条', run.results.length === p.nodes.length)

  const aborted = await runPlan(p.nodes, async () => 'x', { signal: { aborted: true } })
  ok('★ 取消时立即停止且不给假成功', aborted.ok === false && aborted.results.length === 0)

  const failed = await runPlan(chain, async (n) => {
    if (n.id === 'b') throw Object.assign(new Error('ENOENT \x43:/Users/TestUser/x'), { retryable: false })
    return n.id
  })
  ok('★ 不可重试失败会中止', failed.ok === false && failed.degraded === true)
  ok('★ 失败原因不回吐 error.message 里的路径',
    !JSON.stringify(failed).includes('TestUser') && !JSON.stringify(failed).includes('ENOENT'))
  const soft = await runPlan(chain, async (n) => {
    if (n.id === 'b') throw Object.assign(new Error('soft'), { retryable: true })
    return n.id
  })
  ok('★ 可重试失败标降级但继续走完', soft.degraded === true && soft.results.length === 3)
  ok('无执行器时明确拒绝执行', (await runPlan(chain, null)).ok === false)
  const planner = makeDagPlanner({ now: () => 42 })
  ok('makeDagPlanner 五个入口齐全', ['plan', 'validate', 'topo', 'run', 'stamp']
    .every((k) => typeof planner[k] === 'function') && planner.stamp() === 42)
}

console.log('=== 5. run_dag 工具 ===')
{
  const tool = makeDagTool({})
  ok('名字 / 超时', tool.name === 'run_dag' && tool.timeoutMs > 0)
  ok('description 明说 dry_run 默认', tool.description.includes('dry_run'))
  const dry = await tool.execute({ goal: '画一张图', available: {} })
  ok('★ 默认只出计划、不执行（results 空）', dry.ok === true && dry.results.length === 0)
  ok('计划与拓扑序都在', dry.plan.nodes.length > 0 && dry.order.length > 0)
  ok('返回值字段全在 schema 声明内',
    Object.keys(dry).every((k) => k in tool.output.schema.properties))
  const slim = await withDeclaredOutput(tool).execute({ goal: '画一张图' })
  ok('★ 裁剪后仍非空', slim.ok === true && slim.plan.nodes.length > 0)
  const real = makeDagTool({ executor: async (n) => n.id })
  const wet = await real.execute({ goal: '画一张图', dry_run: false, available: {} })
  ok('dry_run=false 且有执行器才真跑', wet.results.length > 0)
  const noExec = await tool.execute({ goal: '画一张图', dry_run: false })
  ok('★ 没执行器时只回计划并说明原因', noExec.ok === false && noExec.reason.includes('执行器'))
}

console.log(`=== test-doctor-dag：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
