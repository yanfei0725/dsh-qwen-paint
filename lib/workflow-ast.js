/**
 * lib/workflow-ast.js —— 报告 v3 §14.3「B 线」：WorkflowAST + 5 个提交前 pass。
 *
 * ## 为什么存在
 * 第 7 节那套「散落的字面量替换」没有快照、没有 diff、提交前不校验 —— 模型一升级、
 * 节点一改名就漂移。这里把它升级成一条**可 diff / 可回滚 / 可对 /object_info 校验**
 * 的提交前管线（G1–G7 声明由源码自动推导，见 scripts/derive-slots.py）。
 *
 * ## 与 lib/workflow-passes.js 的关系
 * runPasses 已有「入口 structuredClone + rawAst 快照 + changes[]」（修订 #10）。
 * 本模块提供**结构化 AST**（nodes: Map）与 5 个 pass，复用那套执行器，不另造一套。
 *
 * ## 硬规矩
 * - emitWorkflow 走「逐字节一致」口径：不归一化、不剔 client_id / filename_prefix，
 *   否则 ComfyUI 端执行缓存键会变（报告 13.4 ② 的教训）。
 * - 所有 pass 纯函数：只改副本，返回 { ast, changes }。
 * - 零外部依赖（本机 acorn/recast 全 MISSING，C 线另见 scripts/ast-split.mjs）。
 */
import { runPasses } from './workflow-passes.js'
import { matchVariant, variantById, MODEL_VARIANTS } from './model-map.js'

/** G1 字面量槽位：节点输入名叫这些时，可由 values 自动绑定（见 derive-slots.py）。 */
export const LITERAL_SLOTS = [
  'text', 'seed', 'width', 'height', 'steps', 'cfg', 'denoise',
  'image', 'lora_name', 'num_frames', 'fps', 'length', 'frame_rate',
]

/**
 * ComfyUI「API 格式」JSON → 结构化 AST。
 * 输入形如 { "1": { class_type, inputs: {...} }, ... }。
 * ⚠ 不是 ComfyUI 的 UI 格式（那个带 nodes/links 数组），别混。
 */
export function parseWorkflow(raw) {
  const nodes = new Map()
  const order = []
  for (const [id, n] of Object.entries(raw ?? {})) {
    if (n === null || typeof n !== 'object' || typeof n.class_type !== 'string') continue
    const key = String(id)
    nodes.set(key, {
      id: key,
      classType: n.class_type,
      inputs: { ...(n.inputs ?? {}) },
      meta: n._meta !== undefined ? n._meta : undefined,
    })
    order.push(key)
  }
  return { nodes, order, meta: {} }
}

/** AST → 可提交 JSON。不归一化、不改键 —— 保住 ComfyUI 端缓存键。 */
export function emitWorkflow(ast) {
  const out = {}
  for (const id of ast?.order ?? []) {
    const n = ast.nodes.get(id)
    if (n === undefined) continue
    out[id] = { class_type: n.classType, inputs: { ...n.inputs } }
    if (n.meta !== undefined) out[id]._meta = n.meta
  }
  return out
}

/**
 * 提交前校验：每个 class_type 都认识、必需输入齐全、无未知输入名。
 * objectInfo 用 ComfyUI /object_info 的形状（离线测试可造一份假的，不联网）。
 */
export function validateAgainstObjectInfo(payload, objectInfo) {
  const errors = []
  for (const [id, n] of Object.entries(payload ?? {})) {
    const spec = objectInfo?.[n.class_type]
    if (spec === undefined) { errors.push(`节点 ${id}：/object_info 里没有 ${n.class_type}`); continue }
    const required = Object.keys(spec?.input?.required ?? {})
    const optional = Object.keys(spec?.input?.optional ?? {})
    const allowed = new Set([...required, ...optional])
    for (const key of required) {
      if (n.inputs?.[key] === undefined) errors.push(`节点 ${id}(${n.class_type})：缺必需输入 ${key}`)
    }
    for (const key of Object.keys(n.inputs ?? {})) {
      if (!allowed.has(key)) errors.push(`节点 ${id}(${n.class_type})：未知输入 ${key}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 逐节点逐输入对比，产出可反向应用的 changes（供 diff / 回滚审计）。 */
export function diffWorkflow(before, after) {
  const changes = []
  for (const id of after?.order ?? []) {
    const a = before?.nodes?.get?.(id)
    const b = after.nodes.get(id)
    if (a === undefined) { changes.push({ node: id, kind: 'added', after: b }); continue }
    for (const key of new Set([...Object.keys(a.inputs), ...Object.keys(b.inputs)])) {
      const av = JSON.stringify(a.inputs[key])
      const bv = JSON.stringify(b.inputs[key])
      if (av !== bv) changes.push({ node: id, input: key, before: a.inputs[key], after: b.inputs[key] })
    }
  }
  return changes
}

// ── 五个提交前 pass（报告 §14.3 / v3 修订 #8 #9 #10）────────────────────

/** ① SlotBindPass：sidecar slots 显式覆盖优先；否则按 G1 字面量名自动绑定。 */
export function SlotBindPass(ast, ctx = {}) {
  const { slots = {}, values = {} } = ctx
  const changes = []
  for (const node of ast.nodes.values()) {
    const explicit = slots[node.id] ?? {}
    for (const [input, key] of Object.entries(explicit)) {
      if (!(key in values)) continue
      const before = node.inputs[input]
      node.inputs[input] = values[key]
      changes.push({ pass: 'SlotBindPass', node: node.id, input, before, after: values[key] })
    }
    for (const input of Object.keys(node.inputs)) {
      if (explicit[input] !== undefined || !LITERAL_SLOTS.includes(input)) continue
      if (!(input in values)) continue
      const before = node.inputs[input]
      node.inputs[input] = values[input]
      changes.push({ pass: 'SlotBindPass', node: node.id, input, before, after: values[input] })
    }
  }
  return { ast, changes }
}

/** ② ModelMapPass：结构化水位（零 eval，修订 #9）+ 映射表改写模型名。 */
export function ModelMapPass(ast, ctx = {}) {
  const { modelMap = {}, vramGB = NaN, variants = MODEL_VARIANTS, available = null } = ctx
  const variant = matchVariant(vramGB, variants)
  const chosen = variantById(variant?.id ?? '')?.tier ?? null
  const changes = []
  for (const node of ast.nodes.values()) {
    for (const [input, val] of Object.entries(node.inputs)) {
      if (typeof val !== 'string' || modelMap[val] === undefined) continue
      const target = typeof modelMap[val] === 'function' ? modelMap[val]({ vramGB, tier: chosen }) : modelMap[val]
      if (available !== null && !available.has(target)) {
        throw new Error(`缺模型 ${target}（由 ${val} 映射而来，档位 ${chosen ?? 'auto'}），请放进 models/ 对应目录`)
      }
      node.inputs[input] = target
      changes.push({ pass: 'ModelMapPass', node: node.id, input, before: val, after: target, tier: chosen })
    }
  }
  return { ast, changes }
}

/** ③ LoraPass：LoRA 未装时不塞不存在的节点（与 comfy-accel 的 SADA 判据同口径）。 */
export function LoraPass(ast, ctx = {}) {
  const { lora = '', installed = null } = ctx
  const changes = []
  if (lora === '') return { ast, changes }
  if (installed !== null && !installed.has(lora)) {
    throw new Error(`LoRA ${lora} 未安装（不向 ComfyUI 塞不存在的权重）`)
  }
  for (const node of ast.nodes.values()) {
    if (!/lora/i.test(node.classType)) continue
    if (!('lora_name' in node.inputs)) continue
    const before = node.inputs.lora_name
    node.inputs.lora_name = lora
    changes.push({ pass: 'LoraPass', node: node.id, input: 'lora_name', before, after: lora })
  }
  return { ast, changes }
}

/**
 * ④ ChunkPass：frames > framesPerChunk 时切成 N 段、8 帧重叠。
 * ⚠ 不在 AST 里复制子图（那会让 emit 出多份 KSampler，ComfyUI 当成 N 个独立任务）。
 * 这里只产出 **chunkPlan**，由执行器按段提交（每段一个 jobId、改 length/seed/start_image），
 * 最后 VHS_VideoCombine 合成 —— 与报告 §3「三段各一个 jobId」/ §10 验收「81 帧切 2 块」一致。
 */
export function ChunkPass(ast, ctx = {}) {
  const frames = Number(ctx.frames)
  const framesPerChunk = Number(ctx.framesPerChunk ?? 49)
  const overlap = Number(ctx.overlap ?? 8)
  if (!Number.isFinite(frames) || frames <= framesPerChunk) return { ast, changes: [] }
  const stride = framesPerChunk - overlap
  if (stride <= 0) throw new Error('framesPerChunk 必须大于 overlap')
  const segments = []
  for (let start = 0; start < frames; start += stride) {
    const end = Math.min(frames, start + framesPerChunk)
    segments.push({ index: segments.length, startFrame: start, frameCount: end - start, seedOffset: segments.length })
    if (end >= frames) break
  }
  const plan = { frames, framesPerChunk, overlap, chunks: segments.length, segments }
  ast.meta = { ...(ast.meta ?? {}), chunkPlan: plan }
  // 首段长度写回 length（执行器逐段提交时按 segments[i].frameCount 覆盖）
  for (const node of ast.nodes.values()) {
    if ('length' in node.inputs) node.inputs.length = segments[0].frameCount
  }
  return { ast, changes: [{ pass: 'ChunkPass', ...plan, segments: undefined }] }
}

/** ⑤ AccelPass：exclusive 硬约束 + pick 返回 null 时**空跑**（修订 #8，不抛错）。 */
export function AccelPass(ast, ctx = {}) {
  const { profile = null, installed = null } = ctx
  if (profile === null) return { ast, changes: [] }
  if (installed !== null && !installed.has(profile)) {
    throw new Error(`加速节点 ${profile} 未安装（pick 应返回 null，此处为双保险）`)
  }
  for (const node of ast.nodes.values()) {
    if (/Spectrum|EasyCache|TeaCache/u.test(node.classType)) {
      throw new Error('检测到已有缓存/跳步节点，禁止叠加（ACCEL_PROFILES.exclusive）')
    }
  }
  return { ast, changes: [{ pass: 'AccelPass', profile }] }
}

export const PASSES = [SlotBindPass, ModelMapPass, LoraPass, ChunkPass, AccelPass]

/**
 * 统一提交前管线（报告 §14.3 末段）。
 * 出错 / cancel：rollback() 返回改前的逐字节等价 JSON；changes 可逐条反向应用。
 */
export function runAstPipeline(raw, objectInfo, ctx = {}) {
  const rawAst = parseWorkflow(raw)
  const { ast, rawAst: snapshot, changes } = runPasses(rawAst, PASSES, ctx)
  const payload = emitWorkflow(ast)
  const validation = validateAgainstObjectInfo(payload, objectInfo)
  if (!validation.ok) {
    throw new Error(`提交前校验失败：${validation.errors.join('；')}`)
  }
  return {
    payload,
    changes,
    validation,
    chunkPlan: ast.meta?.chunkPlan ?? null,
    rollback: () => emitWorkflow(snapshot),
  }
}
