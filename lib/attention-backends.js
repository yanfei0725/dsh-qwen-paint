/**
 * lib/attention-backends.js —— 通用注意力 / 编译加速后端（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   · SageAttention：8-bit 注意力方案；
 *   · Comfy-WaveSpeed：First Block Cache（动态缓存）+ torch.compile 编译优化。
 *   两者都做成**可插拔后端**：只从宿主真实 /object_info 节点表里模式发现，
 *   探测不到就明确降级 + 安装提示，绝不硬编码为「已安装可用」。
 *
 * ## ★ 诚实边界
 *   用户资料里提到的相对速度倍率（对比 FlashAttention2 / xFormers 等）
 *   以及社区文章里的加速数字，**全部标 unverified**：未经本机实测，
 *   不写进代码注释、不写进任何返回结论、不作为选型理由里的实测数据。
 *   节点类名、启动参数、量化精度也未经本机核实 ⇒ 不写死任何类名或命令行参数。
 */
export const ATTENTION_BACKEND_VERSION = 1

export const ATTENTION_BACKENDS = Object.freeze([
  {
    id: 'sage_attention',
    label: 'SageAttention（8-bit 注意力）',
    kinds: ['image', 'video'],
    nodePattern: /SageAttention|SageAttn|sage_attn|ApplySage/iu,
    // ★ 真机 /object_info 里同时有通用 patch（PathchSageAttentionKJ）与 Qwen 专用节点。
    //   按字母序取首个会把不适配的通用 patch 插进 Qwen 链 ⇒ 专用节点必须排前面。
    priorityPattern: /QwenImage.*SageAttention|SageAttention.*QwenImage/iu,
    probeKey: 'sageAttention',
    unverified: true,
    installHint: '需自行安装 SageAttention 及匹配的 torch / triton 版本；插件不 pip install、不自动下载。',
    notes: '用户资料称其为 8-bit 注意力方案；相对 FlashAttention2 / xFormers 的倍率数字未实测，不采信为结论。'
      + '模式发现优先取 Qwen-Image 专用节点，避免误用其它模型的通用 patch。',
  },
  {
    id: 'wavespeed',
    label: 'Comfy-WaveSpeed（First Block Cache + torch.compile）',
    kinds: ['image', 'video'],
    // ★ 真机复核修正：裸 CompileModel 会误匹配 TorchCompileModel*（通用编译节点），
    //   裸 WaveSpeed 会误匹配 WavespeedImageUpscaleNode（超分节点）。两者都不是
    //   Comfy-WaveSpeed 的 First Block Cache ⇒ 收紧成必须带 Cache/Compile/Apply 的组合。
    nodePattern: /FirstBlockCache|First_Block_Cache|WaveSpeed.*(?:Cache|Compile|Apply)|ApplyWaveSpeed|ComfyWaveSpeed|Comfy-WaveSpeed/iu,
    priorityPattern: /FirstBlockCache|First_Block_Cache/iu,
    probeKey: 'waveSpeed',
    unverified: true,
    installHint: '需自行安装 Comfy-WaveSpeed 节点包与其依赖；插件不 pip install、不自动下载。',
    notes: '公开资料提到 First Block Cache 动态缓存与增强 torch.compile；加速倍率未实测，不采信为结论。'
      + '通用 TorchCompileModel 与 Wavespeed 超分节点不算本后端，避免误报已安装。',
  },
])

function namesOf(installed) {
  const nodes = installed?.nodes ?? installed
  if (nodes instanceof Set) return [...nodes].map(String)
  if (Array.isArray(nodes)) return nodes.map(String)
  if (nodes && typeof nodes === 'object') return Object.keys(nodes).filter((k) => nodes[k] !== false).map(String)
  return []
}

/** 模式发现：只从真实节点表取候选，绝不虚构类名。 */
export function discoverAttentionNodes(installed, backend) {
  const names = namesOf(installed)
  const b = typeof backend === 'string' ? ATTENTION_BACKENDS.find((x) => x.id === backend) : backend
  if (!b) return { candidates: [], nodeCount: names.length }
  const found = names.filter((n) => b.nodePattern.test(n))
  // ★ 专用节点优先：工作流只取 candidates[0]，不能让通用 patch 排在对口节点前面。
  const candidates = b.priorityPattern instanceof RegExp
    ? [...found.filter((n) => b.priorityPattern.test(n)), ...found.filter((n) => !b.priorityPattern.test(n))]
    : found
  return { candidates, nodeCount: names.length }
}

/** 选择：只放探测到的；preferred 优先；无可用则 degraded + 固定理由（不含倍率）。 */
export function pickAttentionBackends({ installed = {}, preferred = [], kind = 'image' } = {}) {
  const want = Array.isArray(preferred) ? preferred.map(String) : [String(preferred ?? '')]
  const byId = new Map(ATTENTION_BACKENDS.map((b) => [b.id, b]))
  const ordered = [
    ...want.map((id) => byId.get(id)).filter(Boolean),
    ...ATTENTION_BACKENDS,
  ]
  const seen = new Set()
  const selected = []
  const reasons = []
  for (const b of ordered) {
    if (seen.has(b.id)) continue
    seen.add(b.id)
    if (!b.kinds.includes(kind)) continue
    const found = discoverAttentionNodes(installed, b)
    if (found.candidates.length === 0) {
      reasons.push(b.label + '：未在 /object_info 中发现对应节点（节点类名未核实）')
      continue
    }
    selected.push({ id: b.id, label: b.label, probeKey: b.probeKey,
      unverified: b.unverified, candidates: found.candidates.slice(0, 8),
      installHint: b.installHint })
  }
  return {
    selected,
    reasons,
    degraded: selected.length === 0,
    unverified: true,
    note: '未实测的性能倍率不写进结论；只记录实际启用了哪条后端。',
  }
}

export function listAttentionBackends({ installed = {}, kind = 'image' } = {}) {
  return ATTENTION_BACKENDS.map((b) => {
    const found = discoverAttentionNodes(installed, b)
    return {
      id: b.id, label: b.label, kinds: b.kinds.slice(), probeKey: b.probeKey,
      unverified: b.unverified, notes: b.notes, installHint: b.installHint,
      available: b.kinds.includes(kind) && found.candidates.length > 0,
      candidates: found.candidates.slice(0, 8),
      reason: found.candidates.length > 0 ? '' : '未检测到对应节点；' + b.installHint,
    }
  })
}

/** 纯数据补丁：只回显探测到的后端 id，绝不塞未核实的参数进工作流。 */
export function buildAttentionPatch(selection) {
  return {
    backends: (selection?.selected ?? []).map((b) => b.id),
    reasons: selection?.reasons ?? [],
    degraded: selection?.degraded ?? true,
    unverified: true,
    note: '节点输入槽位未核实：参数只回显，不写入工作流；需按节点包文档确认后再启用。',
  }
}
