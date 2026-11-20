// 设计说明已外置 → docs/tool-parameters-design-notes.md#dag-planner-note-001（原 L1-11）
export const STAGE_KINDS = Object.freeze([
  'ensure_comfy', 'load_model', 'text_encode', 'sample', 'decode',
  'upscale', 'inpaint', 'tts', 'video', 'mux', 'save', 'post',
])

export function validateDag(nodes = []) {
  const errors = []
  const ids = new Set()
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || n.id === '') { errors.push('节点缺 id'); continue }
    if (ids.has(n.id)) errors.push('重复 id: ' + n.id)
    else ids.add(n.id)
    if (!STAGE_KINDS.includes(n.kind)) errors.push('未知 kind: ' + String(n.kind))
  }
  for (const n of nodes) {
    for (const d of (Array.isArray(n?.dependsOn) ? n.dependsOn : [])) {
      if (!ids.has(d)) errors.push('悬空依赖: ' + String(d))
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Kahn 拓扑排序 + 环检测。 */
export function topoSort(nodes = []) {
  const map = new Map(nodes.map((n) => [n.id, n]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const out = new Map(nodes.map((n) => [n.id, []]))
  for (const n of nodes) {
    for (const d of (Array.isArray(n.dependsOn) ? n.dependsOn : [])) {
      if (!map.has(d)) continue
      out.get(d).push(n.id)
      indeg.set(n.id, (indeg.get(n.id) || 0) + 1)
    }
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const nxt of (out.get(id) || [])) {
      const left = (indeg.get(nxt) || 0) - 1
      indeg.set(nxt, left)
      if (left === 0) queue.push(nxt)
    }
  }
  return { order, cycle: order.length !== nodes.length }
}

/**
 * 按目标 + 实际可用能力生成计划。缺失能力自动降级并在 reasons 里写清。
 * @returns {{nodes:object[], reasons:string[], degraded:boolean}}
 */
export function planDag({ goal = '', available = {}, constraints = {}, comfyOnline = null } = {}) {
  const g = String(goal).toLowerCase()
  const wantsVideo = /video|视频|动画|片段|动图/u.test(g)
  const wantsTts = /tts|语音|配音|朗读|speech|音频/u.test(g)
  const wantsImage = !wantsVideo || /图|image|画|poster|封面/u.test(g)
  const reasons = []
  const nodes = []
  let degraded = false
  const add = (id, kind, dependsOn = [], extra = {}) => {
    nodes.push({ id, kind, dependsOn, ...extra })
    return id
  }
  let tail = null
  if (comfyOnline === false) {
    tail = add('ensure_comfy', 'ensure_comfy')
    reasons.push('ComfyUI 未就绪：计划里插入 ensure_comfy 前置节点（本模块不启动进程）')
  }
  const link = (id, kind, extra = {}) => {
    const deps = tail ? [tail] : []
    tail = add(id, kind, deps, extra)
    return tail
  }

  if (wantsImage) {
    link('load_model', 'load_model')
    link('text_encode', 'text_encode')
    link('sample', 'sample', { steps: constraints.steps ?? null })
    link('decode', 'decode')
    if (constraints.upscale === true) link('upscale', 'upscale')
    if (constraints.inpaint === true) link('inpaint', 'inpaint')
  }

  if (wantsTts) {
    if (available.tts === true) link('tts', 'tts')
    else { degraded = true; reasons.push('未探测到 TTS 能力：跳过语音节点') }
  }
  if (wantsVideo) {
    if (available.video === true) link('video', 'video')
    else { degraded = true; reasons.push('未探测到视频能力：跳过视频节点') }
    if (wantsTts && available.tts === true && available.mux === true) link('mux', 'mux')
  }
  if (constraints.save !== false) link('save', 'save')

  if (nodes.length === 0) {
    degraded = true
    reasons.push('目标没有匹配到任何可执行阶段')
  }
  return { nodes, reasons, degraded }
}

/**
 * 按拓扑序执行；失败按节点 retryable 决定是否继续并标降级；支持 signal 取消。
 * 异常细节绝不回吐（可能带本机路径），只写固定文案。
 */
export async function runPlan(nodes, executor, { signal, onNode } = {}) {
  const { order, cycle } = topoSort(nodes)
  if (cycle) {
    return { ok: false, order: [], results: [], degraded: true, reason: '计划里有环，拒绝执行' }
  }
  if (typeof executor !== 'function') {
    return { ok: false, order, results: [], degraded: true, reason: '没有注入执行器，只出计划不执行' }
  }
  const map = new Map(nodes.map((n) => [n.id, n]))
  const results = []
  let degraded = false
  for (const id of order) {
    if (signal?.aborted === true) {
      return { ok: false, order, results, degraded: true, reason: '任务已取消' }
    }
    const node = map.get(id)
    try {
      const value = await executor(node, { signal })
      const row = { id, kind: node.kind, ok: true, value: value ?? null, reason: '' }
      results.push(row)
      onNode?.(row)
    } catch (error) {
      const retryable = error?.retryable !== false
      degraded = true
      const row = { id, kind: node.kind, ok: false, value: null,
        retryable, reason: '节点执行失败（详见本机日志）' }
      results.push(row)
      onNode?.(row)
      if (!retryable) {
        return { ok: false, order, results, degraded: true, reason: '关键节点失败且不可重试' }
      }
    }
  }
  return { ok: !degraded, order, results, degraded,
    reason: degraded ? '部分节点降级，结果不完整' : '' }
}

export function makeDagPlanner({ now, probe, log } = {}) {
  return {
    plan: (args = {}) => planDag(args),
    validate: (nodes) => validateDag(nodes),
    topo: (nodes) => topoSort(nodes),
    run: (nodes, executor, opts) => runPlan(nodes, executor, opts),
    stamp: () => (typeof now === 'function' ? now() : Date.now()),
    probe: typeof probe === 'function' ? probe : null,
    log: typeof log === 'function' ? log : null,
  }
}

/** 给 Agent 用的工具：默认 dry_run=true（只出计划，绝不出图）。 */
export function makeDagTool(deps = {}) {
  const planner = deps.planner || makeDagPlanner(deps)
  return {
    name: 'run_dag',
    description: '把一句创作目标拆成本机可执行的 DAG 计划（依赖图 / 拓扑序 / 降级理由），'
      + '默认 dry_run=true 只出计划不出图，适合在真正出图前先确认链路是否齐全。'
      + '参数：goal（目标描述）、available（已探测能力，如 {tts:true,video:true,mux:false}）、'
      + 'constraints（steps/upscale/inpaint/save）、dry_run。'
      + '当 comfyOnline=false 时计划会自动插入 ensure_comfy 前置节点。'
      + '返回 plan/order/results/summary，reasons 里写清哪些能力缺失被降级。'
      + '纯本地；缺能力绝不假装可用。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        goal: { type: 'string' }, available: { type: 'object' }, constraints: { type: 'object' },
        dry_run: { type: 'boolean' }, comfyOnline: { type: 'boolean' },
      },
    },
    timeoutMs: 30 * 1000,
    output: { schema: { type: 'object', properties: {
      ok: { type: 'boolean' }, plan: { type: 'object' }, order: { type: 'array' },
      results: { type: 'array' }, summary: { type: 'string' }, reason: { type: 'string' },
    } } },
    async execute(args = {}) {
      const dryRun = args.dry_run !== false
      const plan = planner.plan({ ...args, comfyOnline: args.comfyOnline ?? null })
      const valid = planner.validate(plan.nodes)
      if (!valid.ok) {
        return { ok: false, plan, order: [], results: [],
          summary: '计划校验失败：' + valid.errors.length + ' 项', reason: '计划校验失败' }
      }
      const { order, cycle } = planner.topo(plan.nodes)
      if (cycle) {
        return { ok: false, plan, order: [], results: [],
          summary: '计划里有环，无法执行', reason: '计划里有环' }
      }
      const empty = { ok: true, order, results: [],
        summary: '计划 ' + order.length + ' 个节点'
          + (plan.degraded ? '（有降级，见 plan.reasons）' : '（能力齐全）'), reason: '' }
      if (dryRun) return { ...empty, plan }
      if (typeof deps.executor !== 'function') {
        return { ...empty, ok: false, plan, summary: '未注入执行器，只返回计划',
          reason: '没有注入执行器，只出计划不执行' }
      }
      const run = await planner.run(plan.nodes, deps.executor, { signal: args.signal })
      return { ok: run.ok, plan, order: run.order, results: run.results,
        summary: run.ok ? '计划执行完成' : '计划执行降级或失败', reason: run.reason }
    },
  }
}
