/**
 * lib/workflow-passes.js —— 工作流 AST 的 pass 管线（**入口深拷贝，原 AST 不动**）。
 *
 * ## 它修的是什么
 *   报告 v2 的 `runPasses` 写着：
 *     export function runPasses(ast, passes, ctx) {
 *       let cur = ast                     // ← 直接拿原引用
 *       for (const pass of passes) { const r = pass(cur, ctx); cur = r.ast }
 *     }
 *   注释却写「不改原对象，便于 diff 与回滚」。实际上 `SlotBindPass` 里 `n.inputs[k] = v`
 *   改的就是传进来的那个 AST ⇒ **原 AST 已经被改脏**，等 emit 前再想 diff 原始版，
 *   拿到的两边都是改后的，"回滚"无从谈起。
 *   ⇒ 这里 `runPasses` 入口先 `structuredClone`，并**同时**留一份 `rawAst` 快照：
 *     pass 只改副本，`rawAst` 只读，回滚/对比都基于它。
 *
 * ## pass 契约
 *   `pass(ast, ctx) → { ast, changes }`
 *   · 必须返回 `ast`（可以是同一个对象，也可以是新对象）；
 *   · `changes` 是**声明式**的改动清单：`{ node, input, before, after }`，
 *     由 runPasses 统一加上 `pass` 名 —— 这样"谁改了哪一格"永远可追溯。
 *
 * ## 为什么不在 pass 里自己深拷贝
 *   每个 pass 都拷一次 = N 副本、N 倍内存，且"哪个才是原文"更糊涂。
 *   只在**入口**拷一次，语义清楚。
 */

/** 结构校验：pass 返回的东西必须是对象、且带 ast。 */
function assertPassResult(result, passName) {
  if (result === null || typeof result !== 'object') {
    throw new TypeError(`pass「${passName}」没有返回对象（应返回 { ast, changes }）`)
  }
  if (result.ast === null || typeof result.ast !== 'object') {
    throw new TypeError(`pass「${passName}」的返回值缺少 ast（应返回 { ast, changes }）`)
  }
  const changes = result.changes
  if (changes !== undefined && !Array.isArray(changes)) {
    throw new TypeError(`pass「${passName}」的 changes 不是数组`)
  }
}

/**
 * 跑 pass 管线。
 * @param {object} ast  工作流 AST（ComfyUI 的 `{ nodeId: { class_type, inputs } }`）
 * @param {Array<Function>} passes
 * @param {object} [ctx] 透传给每个 pass 的上下文
 * @returns {{ ast: object, rawAst: object, changes: Array }} `rawAst` 是**入口快照**，
 *   与原传入对象互不影响（外面再改原对象也不影响它）。
 */
export function runPasses(ast, passes, ctx) {
  if (ast === null || typeof ast !== 'object') throw new TypeError('runPasses: ast 必须是对象')
  const list = Array.isArray(passes) ? passes : []
  const rawAst = structuredClone(ast)
  let cur = structuredClone(ast)
  const changes = []
  for (const pass of list) {
    if (typeof pass !== 'function') throw new TypeError('runPasses: passes 里有非函数项')
    const name = pass.name || `pass${changes.length + 1}`
    const result = pass(cur, ctx)
    assertPassResult(result, name)
    cur = result.ast
    for (const c of result.changes ?? []) changes.push({ pass: name, ...c })
  }
  return { ast: cur, rawAst, changes }
}

/** 从入口快照重新 emit 一份（回滚/对照用）。深拷贝，避免调用方改到快照本身。 */
export function emitWorkflow(rawAst) {
  if (rawAst === null || typeof rawAst !== 'object') throw new TypeError('emitWorkflow: rawAst 必须是对象')
  return structuredClone(rawAst)
}

/**
 * 槽位绑定 pass 工厂：`bindSlots({ '8': { seed: 42, steps: 8 } })`。
 * 只写**已存在**的输入槽（不凭空造槽 —— 造出来的槽 ComfyUI 会直接拒收）。
 */
export function bindSlots(bindings, options = {}) {
  const map = bindings && typeof bindings === 'object' ? bindings : {}
  const strict = options.strict === true
  const pass = (ast) => {
    const changes = []
    for (const [nodeId, inputs] of Object.entries(map)) {
      const node = ast[nodeId]
      if (!node || typeof node !== 'object') {
        if (strict) throw new Error(`bindSlots: 节点 ${nodeId} 不在图里`)
        continue
      }
      if (node.inputs === null || typeof node.inputs !== 'object') node.inputs = {}
      for (const [input, value] of Object.entries(inputs ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(node.inputs, input) && strict) {
          throw new Error(`bindSlots: 节点 ${nodeId} 没有输入槽 ${input}（不许凭空造槽）`)
        }
        const before = node.inputs[input]
        node.inputs[input] = value
        changes.push({ node: nodeId, input, before, after: value })
      }
    }
    return { ast, changes }
  }
  Object.defineProperty(pass, 'name', { value: 'SlotBindPass' })
  return pass
}

/**
 * 键级差异摘要（只报"哪个节点的哪个槽变了"，不 dump 整张图）。
 * 供日志与"改了什么"的回执用。
 */
export function diffWorkflows(before, after, maxItems = 20) {
  const out = []
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const id of ids) {
    const a = before?.[id]
    const b = after?.[id]
    if (!a || !b) { out.push({ node: id, kind: a ? 'removed' : 'added' }); continue }
    if (a.class_type !== b.class_type) {
      out.push({ node: id, kind: 'class_type', before: a.class_type, after: b.class_type })
    }
    const slots = new Set([...Object.keys(a.inputs ?? {}), ...Object.keys(b.inputs ?? {})])
    for (const slot of slots) {
      const av = a.inputs?.[slot]
      const bv = b.inputs?.[slot]
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        out.push({ node: id, kind: 'input', input: slot, before: av, after: bv })
      }
    }
    if (out.length >= maxItems) break
  }
  return out.slice(0, maxItems)
}
