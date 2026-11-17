// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-cache-backends

/**
 * 术语候选来源。只记录**可核查的出处与定性**，不记录倍率、不据此启用任何后端。
 * `confirmedByUser:false` 是硬状态：哪怕将来探测到同名节点，也不许自动打开。
 */
export const TERM_CANDIDATES = Object.freeze({
  mrfow: Object.freeze({
    candidate: 'MrFlow（Multi-Resolution Flow Matching，多分辨率流匹配）',
    paper: 'arXiv 2607.01642',
    scope: 'Qwen-Image / FLUX.1-dev 等流匹配文生图模型的免训练多分辨率加速',
    confirmedByUser: false,
    missing: [
      '需用户确认 mrfow 指的就是 MrFlow（当前只是字母换位 + 语境吻合）',
      '需 MrFlow 论文实现的 ComfyUI 节点包（本项目没有）',
      '需像素空间 GAN 超分权重（本项目不自动下载任何权重）',
      '需低分辨率采样 → 像素空间超分 → 低强度注噪 → 高分辨率精修的四阶段工作流',
    ],
    note: '社区倍率属其它模型、未经本机实测、不可比；本项目不引用、不承诺。',
  }),
})
export const CACHE_BACKENDS = Object.freeze([
  { id: 'kv_prefix', label: 'Qwen-Image 2.1 前缀 KV 缓存', kinds: ['image'],
    group: 'prefix', node: 'QwenImage21Cache', minSteps: 1,
    available: 'existing', unverified: false,
    notes: '项目已有装配代码（model-chain.js prefixCacheNode）；仍需探测节点是否可用' },
  { id: 'teacache', label: 'TeaCache（时间步嵌入感知缓存）', kinds: ['image', 'video'],
    group: 'timestep', node: 'TeaCache', minSteps: 12,
    available: 'probe', unverified: true,
    notes: '社区方案；需 /object_info 探测到节点才启用，效果未经本机实测' },
  { id: 'fbcache', label: 'FirstBlockCache（首块缓存）', kinds: ['image', 'video'],
    group: 'timestep', node: 'FirstBlockCache', minSteps: 12,
    available: 'probe', unverified: true,
    notes: '与 TeaCache 同组互斥；需探测，效果未经本机实测' },
  { id: 'magcache', label: 'MagCache（幅度感知缓存）', kinds: ['image', 'video'],
    group: 'timestep', node: 'MagCache', minSteps: 12,
    available: 'probe', unverified: true,
    notes: '与 TeaCache 同组互斥；需探测，效果未经本机实测' },
  { id: 'easycache', label: 'EasyCache（项目已有档位占位）', kinds: ['image', 'video'],
    group: 'timestep', node: 'EasyCache', minSteps: 16,
    available: 'probe', unverified: true,
    notes: 'lib/accel-profiles.js 已有档位，节点是否安装仍须探测' },
  { id: 'mrfow', label: 'MrFlow？（用户写作 mrfow；术语未核实，待用户确认）', kinds: ['image', 'video'],
    group: 'unknown', node: null, minSteps: 0,
    available: 'probe', enabled: false, unverified: true,
    notes: '候选术语 MrFlow / 多分辨率流匹配（arXiv 2607.01642），见 TERM_CANDIDATES；需用户确认且需外部节点与超分权重，任何情况下都不自动启用' },
])

const NO_BACKEND_REASON = '没有探测到可用的缓存后端，按原链出图（不加速）'

function isInstalled(backend, installed) {
  if (backend.node && installed.has(backend.node)) return true
  return installed.has(backend.id)
}

/**
 * 从已探测能力里挑后端。
 * @returns {{selected:object[], reasons:string[], degraded:boolean, disabled:string[]}}
 */
export function pickCacheBackends({ installed = [], kind = 'image', steps = 8, preferred = [] } = {}) {
  const have = new Set(Array.isArray(installed) ? installed : [])
  const want = Array.isArray(preferred) ? preferred : []
  const reasons = []
  const n = Number.isFinite(steps) ? steps : 0
  // preferred 允许写后端 id，也允许写 /object_info 里探测到的真实节点名。
  const byAny = new Map()
  for (const b of CACHE_BACKENDS) {
    byAny.set(b.id, b)
    if (b.node) byAny.set(b.node, b)
  }

  // preferred 优先，其次按注册表顺序；同组只取一个，避免互相冲突的跳步策略叠加。
  const ordered = [
    ...want.map((key) => byAny.get(key)).filter(Boolean),
    ...CACHE_BACKENDS,
  ]
  const selected = []
  const usedGroups = new Set()
  const disabled = []

  for (const b of ordered) {
    if (b.enabled === false) {
      if (want.includes(b.id)) reasons.push(b.id + '：术语未核实，暂不启用（需来源）')
      disabled.push(b.id)
      continue
    }
    if (!b.kinds.includes(kind)) continue
    if (n < b.minSteps) {
      reasons.push(b.id + '：步数 ' + n + ' 低于阈值 ' + b.minSteps + '，跳过')
      continue
    }
    if (!isInstalled(b, have)) {
      reasons.push(b.id + '：未探测到节点，降级')
      continue
    }
    if (usedGroups.has(b.group)) {
      reasons.push(b.id + '：与已选后端同组互斥，跳过')
      continue
    }
    usedGroups.add(b.group)
    selected.push({ id: b.id, label: b.label, node: b.node, group: b.group, unverified: b.unverified })
    reasons.push(b.id + '：已探测到，启用')
  }

  return {
    selected,
    reasons,
    degraded: selected.length === 0,
    disabled,
    ...(selected.length === 0 ? { fallbackReason: NO_BACKEND_REASON } : {}),
  }
}

/** 产出可合并进工作流的纯数据补丁；不含任何性能倍率。 */
export function buildCachePatch(selection = {}) {
  const selected = Array.isArray(selection.selected) ? selection.selected : []
  return {
    nodes: selected.map((b) => ({ id: b.id, class_type: b.node, group: b.group })),
    disabled: Array.isArray(selection.disabled) ? [...selection.disabled] : [],
    reasons: Array.isArray(selection.reasons) ? [...selection.reasons] : [],
    degraded: selection.degraded === true,
    // 只记「启用了哪条链」，不记倍率、不记未经实测的耗时数字。
    accel_chain: selected.map((b) => b.id),
  }
}

/**
 * ★ 2026-11-14 全面排查补齐：把「注册表里的能力名」翻译成「要真跑起来还差什么」。
 * 用户要求「引入 TeaCache / mrfow 为视频与生图加速」，但诚实边界是：
 *   · 外部节点包不在本仓库里，项目不能凭空装配一个不存在的节点；
 *   · 因此这里输出**装配计划**（需要哪个节点、是否互斥、项目是否已装配），
 *     而不是假装已经接进工作流；
 *   · `kv_prefix` 是唯一 `assembled:true` 的项（model-chain.js::prefixCacheNode）。
 * 纯函数、零 I/O，输出可直接进加速链报告与实验室 UI。
 */
export function buildAssemblyPlan(selection = {}) {
  const selectedIds = new Set(
    (Array.isArray(selection.selected) ? selection.selected : [])
      .map((b) => (typeof b === 'string' ? b : b?.id))
      .filter(Boolean),
  )
  const groups = {}
  for (const b of CACHE_BACKENDS) {
    const g = b.group || 'other'
    if (!groups[g]) groups[g] = []
    groups[g].push(b.id)
  }
  const steps = CACHE_BACKENDS.map((b) => {
    const isExisting = b.available === 'existing'
    const disabled = b.enabled === false
    return {
      id: b.id,
      label: b.label,
      node: b.node,
      group: b.group,
      selected: selectedIds.has(b.id),
      assembled: isExisting,
      status: disabled ? 'term-unverified' : (isExisting ? 'existing-assembly' : 'needs-external-node'),
      requiresProbe: b.node ? [b.node, b.id] : [b.id],
      minSteps: b.minSteps,
      candidate: TERM_CANDIDATES[b.id] ?? null,
      requirements: isExisting
        ? ['项目已有装配：lib/model-chain.js::prefixCacheNode', '仍需 /object_info 探测到 QwenImage21Cache 节点才会启用']
        : disabled
          ? TERM_CANDIDATES[b.id]
            ? [
              `术语候选：${TERM_CANDIDATES[b.id].candidate}（${TERM_CANDIDATES[b.id].paper}），未经用户确认`,
              ...TERM_CANDIDATES[b.id].missing,
              '任何情况下都不自动启用（探测到同名节点也不启用）',
            ]
            : ['术语未核实：需用户提供来源 / 仓库 / 论文后才能评估，任何情况下都不自动启用']
          : ['需安装对应 ComfyUI 节点包', '需 /object_info 探测到该节点', '节点参数由节点定义决定，本项目不预设'],
      unverified: b.unverified === true,
    }
  })
  return {
    steps,
    mutual_exclusive_groups: groups,
    assembled_by_project: steps.filter((s) => s.assembled).map((s) => s.id),
    needs_external_nodes: steps.filter((s) => s.status === 'needs-external-node').map((s) => s.id),
    disabled_terms: steps.filter((s) => s.status === 'term-unverified').map((s) => s.id),
    note: '装配计划只描述「还差什么」，不等于已经装上；探测不到节点一律不启用，未实测倍率不写进结论。',
  }
}
