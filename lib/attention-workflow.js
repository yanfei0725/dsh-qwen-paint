/**
 * lib/attention-workflow.js —— 把注意力 / 编译加速后端**接进真实工作流**。
 *
 * ★ 用户要求（2026-11-15）：SageAttention / Comfy-WaveSpeed 不做成孤立端点，
 *   要并进 0.33.0 已有的加速链，并且在生成工作流里真的用上。
 *
 * ## 诚实边界（不要在后续改动里抹掉）
 *   · 节点类名**只来自**入参 installed（真实 /object_info 节点表）经 nodePattern
 *     模式发现得到的候选项；绝不硬编码任何第三方节点类名。
 *   · 节点输入槽位未经本机核实 ⇒ 只写 `acceptedInputs` 里宿主已声明、
 *     且 `extraInputs` 里确实给了值的槽位；`model` 引用由调用方在插入时填。
 *     一个槽位都没声明时节点仍可插入，但必须标 `needsSlotMapping: true` +
 *     `unverified: true`，绝不假装参数已核实。
 *   · **默认零节点**：`enabled` 为空时返回 nodes:[]，调用方的模型链逐字节不变。
 *     只有宿主显式指定后端 id、且该后端在节点表里被探测到，才会插入节点。
 *   · 用户资料里的相对倍率一律 unverified，不进代码、不进结论。
 *
 * 纯函数、零 I/O：不联网、不读文件、不派生进程、不改入参。
 */
import { pickAttentionBackends, listAttentionBackends } from './attention-backends.js'

export const ATTENTION_WORKFLOW_VERSION = 1

/** 兼容 Set / Array / {name:true} 三种 /object_info 形状。 */
export function installedNodeNames(installed) {
  const nodes = installed?.nodes ?? installed
  if (nodes instanceof Set) return [...nodes].map(String)
  if (Array.isArray(nodes)) return nodes.map(String)
  if (nodes && typeof nodes === 'object') {
    return Object.keys(nodes).filter((k) => nodes[k] !== false).map(String)
  }
  return []
}

/**
 * 产出可合并进生图 / 视频工作流的节点补丁。
 * @returns {{ok:boolean, nodes:object[], accel_chain:string[], available:object[],
 *   reasons:string[], degraded:boolean, unverified:boolean, needsSlotMapping:boolean}}
 */
export function buildAttentionWorkflowPatch({
  installed = {}, kind = 'image', enabled = '',
  acceptedInputs = [], extraInputs = {}, preferred = [],
} = {}) {
  const names = installedNodeNames(installed)
  const selection = pickAttentionBackends({ installed: names, kind, preferred })
  const want = String(enabled ?? '').trim()
  const accepted = new Set(Array.isArray(acceptedInputs) ? acceptedInputs.map(String).filter(Boolean) : [])
  const extra = extraInputs && typeof extraInputs === 'object' ? extraInputs : {}
  const reasons = [...selection.reasons]
  const nodes = []

  if (want === '') {
    reasons.push('未显式启用：attentionBackend 为空，原生成链逐字节不变')
  } else if (selection.selected.length === 0) {
    reasons.push(want + '：未在 /object_info 中探测到对应节点，不插入工作流')
  } else {
    const chosen = selection.selected.find((b) => b.id === want)
    if (!chosen) {
      reasons.push(want + '：已探测到的后端里没有这一项，不插入工作流')
    } else {
      const classType = chosen.candidates[0]
      if (!classType) {
        reasons.push(want + '：模式发现未给出可用节点类名，不插入工作流')
      } else {
        const inputs = {}
        for (const key of accepted) {
          if (key === 'model') continue
          if (Object.prototype.hasOwnProperty.call(extra, key)) inputs[key] = extra[key]
        }
        nodes.push({
          id: chosen.id,
          class_type: String(classType),
          inputs,
          label: chosen.label,
          unverified: true,
          installHint: chosen.installHint,
        })
        reasons.push(want + '：按探测到的真实节点类名接进模型链末端')
      }
    }
  }

  return {
    ok: true,
    version: ATTENTION_WORKFLOW_VERSION,
    kind,
    enabled: want,
    nodes,
    // 只有真正被启用的那条才进链；探测不到 / 未启用都不算「已生效」。
    accel_chain: nodes.map((n) => n.id),
    selected: selection.selected,
    available: listAttentionBackends({ installed: names, kind }),
    reasons,
    degraded: nodes.length === 0,
    unverified: true,
    needsSlotMapping: nodes.length > 0 && accepted.size === 0,
    note: '节点类名只来自真实 /object_info 模式发现；输入槽位未核实，只写宿主已声明的槽位。'
      + '默认不启用；启用后若节点拒收，请按节点包 /object_info 补齐槽位映射。未实测倍率不写进结论。',
  }
}

/**
 * 把补丁节点插到模型链末端，并把 model 引用指回上一环。
 * 调用方只需要把返回的 modelRef 交给 KSampler —— 不需要 rewire 整个工作流。
 * @param {object} nodes 工作流节点表（会被就地补齐，调用方本来就处在构造期）
 * @param {object} patch buildAttentionWorkflowPatch() 的返回
 * @param {string} modelRef 当前模型链末端节点 id
 * @param {number} startId 新节点起始 id（避开现有 1..33）
 */
export function applyAttentionNodes(nodes, patch, modelRef, startId = 40) {
  const list = patch?.nodes ?? []
  if (!nodes || typeof nodes !== 'object' || list.length === 0) {
    return { nodes, modelRef, applied: [], unchanged: true }
  }
  let prev = String(modelRef)
  const applied = []
  list.forEach((n, i) => {
    const id = String(startId + i)
    nodes[id] = {
      class_type: n.class_type,
      inputs: { ...n.inputs, model: [prev, 0] },
    }
    applied.push({ id, backend: n.id, class_type: n.class_type, unverified: true })
    prev = id
  })
  return { nodes, modelRef: prev, applied, unchanged: false }
}
