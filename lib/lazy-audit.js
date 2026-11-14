/**
 * lib/lazy-audit.js —— D26 懒加载：把"哪些权重是每次必载、哪些能按需"盘清楚。
 *
 * ★★ 先说清楚做不到什么（本机实测，写给未来的自己）：
 *   ComfyUI 的 `ExecutionBlocker` 节点在这个仓库的探测里**不存在**
 *   （`/object_info` 里查不到），所以「运行时按条件跳过某个节点」这条**没有可靠实现**。
 *   任何号称"智能跳过"的写法都会在真机上直接报节点缺失。
 *
 *   因此本模块只做一件真事：**静态盘点**这张图里
 *   ① 主图必载的加载器（每次跑都吃显存与加载时间）
 *   ② 只挂在条件补丁里的加载器（不满足条件时根本不会进图）
 *   并把「哪条分支值得改成条件补丁」的建议交出去。
 *
 * ★ 定位是"看得到的账"，不是"自动优化器"。它不改图、不改配置。
 */

/** 会吃权重的加载器节点。缺一个就会导致"以为省了其实没省"。 */
export const LOADER_NODES = [
  'UNETLoader', 'UnetLoaderGGUF', 'CheckpointLoaderSimple', 'DualCLIPLoader',
  'CLIPLoader', 'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly',
  'ControlNetLoader', 'UpscaleModelLoader', 'QwenImage21Cache',
]

/** 能"按条件跳过"的原生节点。实测不存在时留空数组并如实上报。 */
export const BLOCKER_NODE = 'ExecutionBlocker'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 盘点一张清单图（含条件补丁）里的加载器分布。
 *
 * @param {object} manifest
 * @param {{nodes?: string[]|Set<string>}} [caps] 用于判断有没有 ExecutionBlocker
 * @returns {object}
 */
export function auditLazyNodes(manifest, caps) {
  const graph = isObj(manifest?.graph) ? manifest.graph : null
  if (graph === null) {
    return { ok: false, reason: '没有可盘点的 graph', always: [], conditional: [], advice: [] }
  }

  const always = []
  for (const id of Object.keys(graph)) {
    const cls = String(graph[id]?.class_type ?? '')
    if (!LOADER_NODES.includes(cls)) continue
    always.push({ node: id, class_type: cls, inputs: graph[id]?.inputs ?? {} })
  }

  const conditional = []
  for (const patch of Array.isArray(manifest?.patches) ? manifest.patches : []) {
    const nodes = {}
    for (const bucket of ['add', 'set']) {
      const part = isObj(patch?.[bucket]) ? patch[bucket] : {}
      for (const id of Object.keys(part)) {
        const cls = String(part[id]?.class_type ?? graph[id]?.class_type ?? '')
        if (LOADER_NODES.includes(cls)) nodes[id] = cls
      }
    }
    if (Object.keys(nodes).length === 0) continue
    conditional.push({
      patch: String(patch.id ?? ''),
      when: patch.when ?? null,
      requires_nodes: Array.isArray(patch.requiresNodes) ? patch.requiresNodes : [],
      loaders: Object.keys(nodes).map((id) => ({ node: id, class_type: nodes[id] })),
    })
  }

  // ExecutionBlocker 只有在**明确拿到节点清单且命中**时才算可用；
  // 拿不到清单一律 unknown —— 和 cpu-profile 的三态口径保持一致。
  const raw = caps?.nodes
  let blocker = 'unknown'
  if (raw !== undefined && raw !== null) {
    const list = Array.isArray(raw) ? raw : [...raw]
    blocker = list.includes(BLOCKER_NODE) ? 'available' : 'absent'
  }

  const advice = []
  if (always.length === 0) advice.push('这张图没有独立加载器（可能全部由上游节点提供），无需优化。')
  else advice.push(`主图有 ${always.length} 个加载器，每次执行都要加载：${always.map((x) => x.class_type).join('、')}。`)
  if (conditional.length > 0) {
    advice.push(`另有 ${conditional.length} 组加载器只在条件补丁命中时才进图（${conditional.map((c) => c.patch).join('、')}），`
      + '用不到的功能不会白占显存 —— 这已经是本插件的主力省显存手段。')
  }
  if (blocker === 'absent') {
    advice.push('本机没有 ExecutionBlocker 节点，因此**无法**做到"同一张图里按运行时条件跳过某个节点"；'
      + '要省显存请用「不同分支拆成不同图」的方式（即条件补丁），而不是指望运行时跳过。')
  } else if (blocker === 'unknown') {
    advice.push('没拿到 ComfyUI 节点清单，无法确认是否支持 ExecutionBlocker；请先连上 ComfyUI 再判。')
  }

  return {
    ok: true,
    reason: '',
    manifest_id: String(manifest?.id ?? ''),
    blocker,
    always,
    conditional,
    always_count: always.length,
    conditional_count: conditional.reduce((n, c) => n + c.loaders.length, 0),
    advice,
  }
}
