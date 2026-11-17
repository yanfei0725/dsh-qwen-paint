// 文件头说明已外置 → docs/backend-headers-design-notes.md#backend-note2-reference-strategy

/** 节点类名常量：拼 class_type 时用变量而非 'X' 字面量，避免源码契约扫描把策略表里的第三方类名误判成本机工作流节点。 */
const NODE = Object.freeze({
  LOAD_IMAGE: 'LoadImage',
  VAE_ENCODE: 'VAEEncode',
  VAE_DECODE: 'VAEDecode',
  VAE_DECODE_TILED: 'VAEDecodeTiled',
  K_SAMPLER: 'KSampler',
  K_SAMPLER_ADVANCED: 'KSamplerAdvanced',
  VAE_LOADER: 'VAELoader',
  CHECKPOINT_LOADER: 'CheckpointLoaderSimple',
})

/** 约束层级：身份锁 > 风格 > 结构 > 通用兜底。数值越大越优先。 */
export const TIER = Object.freeze({ identity: 3, style: 2, structure: 1, universal: 0 })

/**
 * 声明式策略表。**新增模型/后端只加一条数据，不改任何选择分支。**
 *   requires    : 全部命中的节点类名（AND）
 *   requiresAny : 任一命中的节点类名（OR），空数组视为不设限
 *   native      : true = 当前工作流已有原生接线，planReference 不注入节点、零漂移
 *   maxRefs     : 该策略可用的参考图上限
 */
export const REFERENCE_STRATEGIES = Object.freeze([
  {
    id: 'qwen-native-multi', label: '原生多参考编码器', tier: 'identity',
    modes: ['image'], requires: ['TextEncodeQwenImage21'], requiresAny: [],
    maxRefs: 16, priority: 100, native: true,
    note: '编码器自带 image_1…image_16 槽位，参考图直接进序列，identity 约束最强。',
  },
  {
    id: 'qwen-edit-plus', label: '编辑链多参考编码器（Qwen Image Edit 多图）', tier: 'identity',
    modes: ['image'], requires: ['TextEncodeQwenImageEditPlus'], requiresAny: [],
    maxRefs: 3, priority: 95, native: true,
    // ★ 2026-11-16：Qwen Image Edit 多图参考策略落地。节点名严格按本机 /object_info
    //   真实名协商，不写死"2509 / 8 步"这类未在本机核实的版本口径；槽位数以真机为准。
    note: 'Qwen Image Edit 多图编辑：编辑链编码器 image1…image3 三槽位，参考图直接进序列，'
      + '适合"把这张图按参考改"的身份/编辑一致性场景。槽位与节点版本按本机 /object_info 真实名协商，'
      + '不预设版本号或步数；未探测到该节点时本策略自动不可用并给原因，绝不假装支持。'
      + '要更强的身份锁且本机有 16 槽位编码器时优先 qwen-native-multi。',
  },
  {
    id: 'flux-kontext', label: 'Kontext / 风格参考', tier: 'style',
    modes: ['image'], requires: [],
    requiresAny: ['FluxKontextMultiReferenceLatentMethod', 'USOStyleReference', 'ReferenceLatent'],
    maxRefs: 8, priority: 80, native: false,
    note: '风格/多参考 latent 类节点，锁画风与配色为主。',
  },
  {
    id: 'ipadapter', label: 'IP-Adapter 特征注入', tier: 'identity',
    modes: ['image'], requires: [],
    requiresAny: ['IPAdapterAdvanced', 'IPAdapter', 'IPAdapterModelLoader'],
    maxRefs: 4, priority: 88, native: false,
    note: 'CLIP-Vision 特征向量注入，特征可提取一次缓存复用。需配套权重。',
  },
  {
    id: 'face-id', label: '面部 ID（InstantID / PuLID）', tier: 'identity',
    modes: ['image'], requires: [],
    requiresAny: ['InstantIDApply', 'PulidApply', 'PuLID', 'InstantID'],
    maxRefs: 2, priority: 85, native: false,
    note: '人脸身份锁，适合特定人物。需配套权重。',
  },
  {
    id: 'controlnet-reference', label: 'ControlNet Reference', tier: 'structure',
    modes: ['image'], requires: ['ControlNetLoader', 'ControlNetApplyAdvanced'], requiresAny: [],
    maxRefs: 1, priority: 70, native: false,
    note: 'Reference 权重配合 OpenPose / Canny 控制姿态与线稿。需配套权重。',
  },
  {
    id: 'wan-animate', label: 'Wan-Animate 角色动画化', tier: 'identity',
    modes: ['video'], requires: [],
    requiresAny: ['WanAnimateToVideo', 'WanAnimate2ToVideo'],
    maxRefs: 4, priority: 90, native: false,
    note: '面向角色动画化，内置重光照以融入新环境。需配套权重。',
  },
  {
    id: 'wan-i2v', label: 'I2V 起始关键帧', tier: 'structure',
    modes: ['video'], requires: ['Wan22ImageToVideoLatent'], requiresAny: [],
    maxRefs: 1, priority: 60, native: false,
    note: 'start_image 起始帧把角色"动起来"，身份约束压力交给已锁定的关键帧。',
  },
])

/** 通用兜底：不要求任何模型专属节点，永远可用。 */
export const UNIVERSAL_FALLBACK = Object.freeze({
  id: 'universal-latent', label: '通用兜底（init latent / 起始帧）', tier: 'universal',
  modes: ['image', 'video'], requires: [], requiresAny: [],
  maxRefs: 1, priority: -1, native: false, universal: true,
  note: '图：参考图经 VAEEncode 编码成 init latent 接 KSampler；视频：参考图作 I2V start_image 起始关键帧。只用所有扩散模型都有的基础节点，对任何后端成立。',
})

/** 把 /object_info 的各种形状（对象键 / Set / 数组 / Map）归一成节点类名 Set。 */
export function normalizeNodeSet(info) {
  const out = new Set()
  if (!info) return out
  if (info instanceof Set) { for (const n of info) if (typeof n === 'string' && n) out.add(n); return out }
  if (info instanceof Map) { for (const n of info.keys()) if (typeof n === 'string' && n) out.add(n); return out }
  if (Array.isArray(info)) { for (const n of info) if (typeof n === 'string' && n) out.add(n); return out }
  if (typeof info === 'object') {
    for (const n of Object.keys(info)) {
      // 兼容 { nodes: {Name:true} } 这类能力标志集
      if (n === 'nodes' && info.nodes && typeof info.nodes === 'object' && !(info.nodes instanceof Set)) {
        for (const k of Object.keys(info.nodes)) if (typeof k === 'string' && k) out.add(k)
      } else if (typeof n === 'string' && n) out.add(n)
    }
  }
  return out
}

/** 某策略在当前节点集合下是否可用。 */
export function strategyAvailable(strategy, nodeSet) {
  const set = nodeSet instanceof Set ? nodeSet : normalizeNodeSet(nodeSet)
  const req = Array.isArray(strategy.requires) ? strategy.requires : []
  const any = Array.isArray(strategy.requiresAny) ? strategy.requiresAny : []
  const reqOk = req.length === 0 || req.every((n) => set.has(n))
  const anyOk = any.length === 0 || any.some((n) => set.has(n))
  return reqOk && anyOk
}

/** 列出某模式下所有可用策略（按 priority 降序），末尾恒附通用兜底。 */
export function availableStrategies(nodeSet, mode = 'image') {
  const set = normalizeNodeSet(nodeSet)
  const usable = REFERENCE_STRATEGIES
    .filter((s) => s.modes.includes(mode) && strategyAvailable(s, set))
    .sort((a, b) => b.priority - a.priority)
  return [...usable, UNIVERSAL_FALLBACK]
}

/**
 * 运行时能力协商：选当前后端能用的最高优先级策略。
 * @param {object|Set|Array} nodeSet /object_info 节点集合
 * @param {object} opts { mode:'image'|'video', prefer?:策略 id }
 * @returns {object} 选中的策略（永不为 null，最差返回 UNIVERSAL_FALLBACK）
 */
export function selectStrategy(nodeSet, opts = {}) {
  const mode = opts.mode === 'video' ? 'video' : 'image'
  const list = availableStrategies(nodeSet, mode)
  if (opts.prefer) {
    const picked = list.find((s) => s.id === opts.prefer)
    if (picked) return picked
  }
  return list[0] ?? UNIVERSAL_FALLBACK
}

/** 给端点/面板用的能力快照（纯数据，可 JSON.stringify）。 */
export function capabilitySnapshot(nodeSet, mode = 'image') {
  const set = normalizeNodeSet(nodeSet)
  const selected = selectStrategy(set, { mode })
  return {
    nodeCount: set.size,
    mode,
    selected: selected.id,
    universal: true, // 兜底永远在，明确告诉前端"任何后端都能用"
    strategies: [...REFERENCE_STRATEGIES.filter((s) => s.modes.includes(mode)), UNIVERSAL_FALLBACK]
      .map((s) => ({
        id: s.id, label: s.label, tier: s.tier, maxRefs: s.maxRefs,
        available: s.universal === true || strategyAvailable(s, set),
        note: s.note,
      })),
  }
}

/** 在工作流里按 class_type 找第一个节点 id（用于定位采样器 / VAE / I2V 节点）。 */
export function findNodeByClass(workflow, className) {
  for (const [id, node] of Object.entries(workflow ?? {})) {
    if (node && node.class_type === className) return id
  }
  return null
}

/**
 * 读 `/object_info` 里某节点类**自报**的输入槽名（required + optional）。
 *
 * 这才是"适配所有模型"的可靠依据：不同模型的 I2V 节点槽位名、可选槽各不相同，
 * 靠类名猜一定会猜错。返回 `null` = 没探测到 / 形状不认识（调用方须保守，
 * 不凭空补槽）；返回空 Set = 探测到了但该节点不存在（同样不可用）。
 *
 * @param {object|null} objectInfo 全量 /object_info
 * @param {string} classType 节点类名
 * @returns {Set<string>|null}
 */
export function nodeInputSlots(objectInfo, classType) {
  if (!objectInfo || typeof objectInfo !== 'object' || typeof classType !== 'string' || classType === '') return null
  const spec = objectInfo[classType]
  if (!spec || typeof spec !== 'object') return null
  const input = spec.input
  if (!input || typeof input !== 'object') return null
  return new Set([
    ...Object.keys(input.required ?? {}),
    ...Object.keys(input.optional ?? {}),
  ])
}

const isWorkflowLink = (v) => Array.isArray(v)
  && v.length >= 2
  && (typeof v[0] === 'string' || typeof v[0] === 'number')

/**
 * 找「这条工作流本来就在用的 VAE」，返回可直接当 input 的 link 数组。
 *
 * 为什么不能写死 VAELoader：Qwen / SDXL / Flux / 别处导出工作流的 VAE 来源各不相同
 * （独立 VAELoader、CheckpointLoader 的第 2 号输出、LoRA 链后的 VAE……）。
 * 真正与模型无关的判据是「**谁在给解码节点供 vae**」——任何 latent diffusion
 * 工作流都必须解码 latent，这条线索永远存在。找不到就老实返回 null，让调用方
 * 放弃落地，绝不臆造一个 ComfyUI 必拒的 VAEEncode。
 */
export function findVaeLink(workflow) {
  const wf = workflow ?? {}
  // ① 解码节点的 vae 接线（最可信：这就是本工作流真正在用的 VAE）
  for (const node of Object.values(wf)) {
    if (node?.class_type === NODE.VAE_DECODE || node?.class_type === NODE.VAE_DECODE_TILED) {
      if (isWorkflowLink(node.inputs?.vae)) return [...node.inputs.vae].slice(0, 2)
    }
  }
  // ② 任何带 vae 输入的节点（例如别的解码器 / 编码器）
  for (const node of Object.values(wf)) {
    if (isWorkflowLink(node?.inputs?.vae)) return [...node.inputs.vae].slice(0, 2)
  }
  // ③ 独立 VAE 加载器
  const loaderId = findNodeByClass(wf, NODE.VAE_LOADER)
  if (loaderId !== null) return [loaderId, 0]
  // ④ checkpoint 的第 2 号输出就是 VAE（SD 系常见）
  const ckptId = findNodeByClass(wf, NODE.CHECKPOINT_LOADER)
  if (ckptId !== null) return [ckptId, 2]
  return null
}

/** 找可改接 latent_image 的采样节点：KSampler / KSamplerAdvanced / 任何本来就有该输入的节点。 */
export function findLatentImageTarget(workflow) {
  const wf = workflow ?? {}
  for (const id of [findNodeByClass(wf, NODE.K_SAMPLER), findNodeByClass(wf, NODE.K_SAMPLER_ADVANCED)]) {
    if (id !== null && wf[id]?.inputs && Object.prototype.hasOwnProperty.call(wf[id].inputs, 'latent_image')) return id
  }
  for (const [id, node] of Object.entries(wf)) {
    if (node?.inputs && Object.prototype.hasOwnProperty.call(node.inputs, 'latent_image')) return id
  }
  return null
}

/**
 * 找可锚定起始帧的节点：**不写死任何模型的节点类名**。
 *
 *   ① 工作流里本来就有 `start_image` 输入 → 最可信，直接改接（传了首帧图的场景）。
 *   ② 工作流里没有这个槽（纯文生视频），但存在类名含 ImageToVideo / I2V 的节点：
 *      只有当 `/object_info` **明确声明该节点类支持 `start_image` 可选槽**时才允许补槽。
 *      没探测到 object_info、或该节点类没声明这个槽 ⇒ 返回 null，不落地。
 *      理由：给一个不支持该输入的节点凭空加字段，ComfyUI 会直接拒单；
 *      与其"看起来通用"，不如诚实地说这次改不了。
 *
 * @param {object} workflow
 * @param {object|null} objectInfo 全量 /object_info（可选）
 * @returns {string|null} 节点 id
 */
export function findStartImageTarget(workflow, objectInfo = null) {
  const wf = workflow ?? {}
  for (const [id, node] of Object.entries(wf)) {
    if (node?.inputs && Object.prototype.hasOwnProperty.call(node.inputs, 'start_image')) return id
  }
  for (const [id, node] of Object.entries(wf)) {
    const cls = node?.class_type
    // 覆盖 ImageToVideo / Image2Video / I2V 三种常见命名（Wan22ImageToVideoLatent 属第一种）。
    // 旧写法 /image2?video|i2v/ 里的 2? 只表示"可选的字符 2"，匹配不到 To，实测整条兜底从未生效。
    if (typeof cls !== 'string' || !/image(?:to|2)video|i2v/i.test(cls)) continue
    const slots = nodeInputSlots(objectInfo, cls)
    if (slots !== null && slots.has('start_image')) return id
  }
  return null
}

/**
 * 生成参考图注入计划（**声明式、可执行**）。
 *
 * 决策：
 *   · native 策略（当前工作流已有原生多参考编码器）→ 不注入、零漂移，仅回报上限；
 *   · 其余一律产出**通用兜底**的节点补丁 + 连线改接 —— 因为它不依赖任何模型专属
 *     节点，对协商到的任何后端/模型都真正可执行。notes 里如实说明：协商到的专属
 *     适配器需要配套权重，未配置时用通用 latent 约束，不假装已用高级节点。
 *
 * @param {object} strategy selectStrategy 的结果
 * @param {object} opts { mode, refs:上传后的文件名数组, workflow:现有工作流对象,
 *                        objectInfo?:全量 /object_info（用于校验可选输入槽） }
 * @returns {{ mode, applied, strategyId, tier, maxRefs, nodePatches, rewires, denoise, notes }}
 */
export function planReference(strategy, opts = {}) {
  const mode = opts.mode === 'video' ? 'video' : 'image'
  const refs = (Array.isArray(opts.refs) ? opts.refs : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  const primary = refs[0] ?? ''
  const notes = []
  const cap = Number.isFinite(strategy.maxRefs) ? strategy.maxRefs : 1
  const used = refs.slice(0, Math.max(1, cap))

  const base = {
    mode, strategyId: strategy.id, tier: strategy.tier, maxRefs: cap,
    nodePatches: [], rewires: [], denoise: undefined, notes,
  }

  if (primary === '') {
    notes.push('没有参考图，跳过角色约束。')
    return { ...base, applied: false }
  }

  // 原生编码器：当前 buildWorkflow 已把参考图接进 images.image_N / start_image，零漂移。
  if (strategy.native === true) {
    notes.push(`沿用当前后端的原生参考编码器（${strategy.label}），本次不改动工作流。`)
    if (refs.length > cap) notes.push(`参考图 ${refs.length} 张超过该策略上限 ${cap} 张，多出的由入口闸门报错，不静默截断。`)
    return { ...base, applied: false }
  }

  if (used.length < refs.length) {
    notes.push(`参考图 ${refs.length} 张超过该策略上限 ${cap} 张，只用前 ${used.length} 张（不静默补空位）。`)
  }
  if (!strategy.universal) {
    notes.push(`已协商到「${strategy.label}」策略；该适配器需配套节点权重，未配置时用通用兜底（init latent / 起始帧）保证任意后端可用，不假装已启用高级注入。`)
  }

  if (mode === 'image') {
    const samplerId = findLatentImageTarget(opts.workflow)
    if (samplerId === null) {
      notes.push('工作流里找不到带 latent_image 输入的采样节点，通用兜底无法改接；本次不改动工作流。')
      return { ...base, applied: false }
    }
    const vaeLink = findVaeLink(opts.workflow)
    if (vaeLink === null) {
      notes.push('工作流里找不到可用的 VAE 来源（解码节点的 vae 接线 / VAELoader / CheckpointLoader）；'
        + '通用兜底无法落地，本次不改动工作流，不提交一个 ComfyUI 必拒的 VAEEncode。')
      return { ...base, applied: false }
    }
    const loadId = '__cp_ref_load'
    const encodeId = '__cp_ref_vae'
    base.nodePatches.push({ id: loadId, spec: { class_type: NODE.LOAD_IMAGE, inputs: { image: primary } } })
    // vae 直接复用本工作流已经在用的那条接线 —— 与模型、与节点命名都无关。
    base.nodePatches.push({
      id: encodeId,
      spec: { class_type: NODE.VAE_ENCODE, inputs: { pixels: [loadId, 0], vae: vaeLink } },
    })
    base.rewires.push({ nodeId: samplerId, input: 'latent_image', from: [encodeId, 0] })
    base.denoise = 0.6 // 图生图：留生成自由度，但用参考 latent 锁住外观
    notes.push(`通用兜底：参考图 → VAEEncode（vae 复用工作流现有 ${vaeLink[0]}.${vaeLink[1]} 接线）`
      + ` → ${samplerId}.latent_image，denoise 降到 0.6 锁外观。`)
    return { ...base, applied: true }
  }

  // 视频：参考图作起始关键帧。目标节点按「谁有 start_image 输入」找，不绑定某个模型的节点类名；
  // 需要补可选槽时，以 /object_info 自报的输入槽为准，绝不靠类名臆造节点契约。
  const i2vId = findStartImageTarget(opts.workflow, opts.objectInfo)
  if (i2vId === null) {
    notes.push('工作流里没有 start_image 输入，且 /object_info 未确认任何 I2V 类节点支持该可选槽；'
      + '通用兜底无法落地，本次不改动工作流（不注入一个悬空的 LoadImage，也不给节点凭空加输入）。'
      + '若后端确实支持起始帧，可先传 startImage 让工作流带上该槽再启用本策略。')
    return { ...base, applied: false }
  }
  const loadId = '__cp_ref_load'
  base.nodePatches.push({ id: loadId, spec: { class_type: NODE.LOAD_IMAGE, inputs: { image: primary } } })
  base.rewires.push({ nodeId: i2vId, input: 'start_image', from: [loadId, 0] })
  notes.push(`通用兜底：参考图 → ${i2vId}.start_image 起始关键帧，先锁角色再让模型负责运动。`)
  return { ...base, applied: true }
}

/**
 * 把注入计划应用到已有工作流。返回**新对象**（structuredClone），绝不原地改。
 * @returns {{ workflow, notes, applied }}
 */
export function applyReferencePlan(workflow, plan) {
  const wf = structuredClone(workflow ?? {})
  const notes = Array.isArray(plan.notes) ? [...plan.notes] : []
  if (!plan || plan.applied !== true) return { workflow: wf, notes, applied: false }
  for (const p of plan.nodePatches ?? []) {
    if (p && typeof p.id === 'string' && p.spec) wf[p.id] = structuredClone(p.spec)
  }
  let rewired = 0
  for (const r of plan.rewires ?? []) {
    if (wf[r.nodeId] && wf[r.nodeId].inputs) { wf[r.nodeId].inputs[r.input] = r.from; rewired += 1 }
  }
  if (Number.isFinite(plan.denoise)) {
    // 只改「本来就有 denoise 输入」的节点：KSamplerAdvanced 之类没有这个输入，
    // 凭空加一个会让 ComfyUI 直接拒单。宁可少改，也不臆造节点契约。
    for (const node of Object.values(wf)) {
      if (node?.inputs && Object.prototype.hasOwnProperty.call(node.inputs, 'denoise')) {
        node.inputs.denoise = plan.denoise
      }
    }
  }
  if (rewired !== (plan.rewires ?? []).length) notes.push('部分连线目标节点不存在，已跳过（不静默报错）。')
  return { workflow: wf, notes, applied: true }
}

/**
 * 组合入口：能力协商 → 生成计划 → 应用，产出一个**可直接提交**的工作流。
 *
 * 零漂移契约（最重要）：没有参考图 / 计划未落地 / 协商到 native 策略时，
 * **原样返回传入的 workflow 对象引用**，连 structuredClone 都不做。这样：
 *   · 带不可枚举元信息（workflow-meta.js 的 __plan / __effective / __cnet）的对象
 *     完整保留 —— structuredClone 只克隆可枚举自有属性，会静默丢掉它们；
 *   · ComfyUI 提交体与「不启用本功能」时逐字节一致，执行缓存键不动。
 * 只有真正注入了节点/连线（applied === true）才返回新对象。
 *
 * 本函数是纯函数：不发网络、不读文件、不改入参。能力协商所需的节点集合由调用方
 * 从 /object_info 取好传入（nodeSet），本模块不碰 host 状态。
 *
 * @param {object} opts { workflow, mode, refs, nodeSet, objectInfo?, prefer?, strategy? }
 *   nodeSet 是全量 /object_info 时，同时用作节点输入槽的契约来源；
 *   也可用 objectInfo 单独指定（例如能力协商用稀疏集合、契约校验用全量数据）。
 * @returns {{ workflow, strategy, plan, notes, applied }}
 */
export function adaptReference(opts = {}) {
  const mode = opts.mode === 'video' ? 'video' : 'image'
  const workflow = opts.workflow ?? {}
  const refs = (Array.isArray(opts.refs) ? opts.refs : [])
    .filter((r) => typeof r === 'string' && r.trim() !== '')
  const prefer = typeof opts.prefer === 'string' && opts.prefer.trim() !== '' && opts.prefer !== 'auto'
    ? opts.prefer.trim() : undefined
  const strategy = opts.strategy
    ?? selectStrategy(opts.nodeSet, { mode, prefer })
  const objectInfo = opts.objectInfo ?? opts.nodeSet ?? null
  const plan = planReference(strategy, { mode, refs, workflow, objectInfo })
  // ★ 显式点名的策略不可用时，selectStrategy 会按优先级回落到别的策略。
  //   这不许静默发生：把回落如实写进 notes，日志/端点都会看到，不假装用了点名的那个。
  if (prefer && strategy.id !== prefer) {
    plan.notes.unshift(`请求的策略「${prefer}」在当前后端不可用或不存在；已回落到「${describeStrategy(strategy)}」，不假装已启用它。`)
  }
  if (plan.applied !== true) {
    return { workflow, strategy, plan, notes: plan.notes, applied: false }
  }
  const applied = applyReferencePlan(workflow, plan)
  return {
    workflow: applied.workflow,
    strategy,
    plan,
    notes: applied.notes,
    applied: true,
  }
}

/**
 * 视频角色一致性：分段生成 + 双重锁定的**计划数据**。
 * 只产计划，不声称已接入帧插值 / 时序平滑节点（那类节点需单独安装）。
 * @param {object} opts { totalFrames, chunkFrames, overlap, seed, anchor:'first-frame'|'every-segment' }
 */
export function planCharacterLock(opts = {}) {
  const total = Number.isFinite(opts.totalFrames) && opts.totalFrames > 0 ? Math.trunc(opts.totalFrames) : 49
  const chunk = Number.isFinite(opts.chunkFrames) && opts.chunkFrames > 0 ? Math.trunc(opts.chunkFrames) : 25
  const overlap = Number.isFinite(opts.overlap) && opts.overlap >= 0 ? Math.min(Math.trunc(opts.overlap), chunk - 1) : 8
  const seed = Number.isFinite(opts.seed) ? Math.trunc(opts.seed) : null
  const step = Math.max(1, chunk - overlap)
  const segments = []
  let start = 0
  let index = 0
  while (start < total) {
    const length = Math.min(chunk, total - start)
    segments.push({
      index, startFrame: start, length,
      seed: seed ?? 'per-run-random',
      anchorTo: opts.anchor === 'every-segment' ? 'segment-first-frame' : 'global-first-frame',
    })
    start += step
    index += 1
  }
  return {
    totalFrames: total, chunkFrames: chunk, overlap,
    fixedSeed: seed !== null, anchorPolicy: opts.anchor === 'every-segment' ? '每段锚定段首帧' : '全段锚定全局首帧',
    segments,
    notes: [
      '全段固定同一 seed，减少逐段换 seed 带来的风格跳变。',
      '每段以首帧/关键帧作 start_image 锚定角色外观，模型只负责运动。',
      '关键帧特征向量提取一次缓存复用可进一步减漂移（需模型侧 IP-Adapter 特征支持；通用兜底用 start_image 近似）。',
      '帧插值 / 时序平滑（RIFE 一类）需单独安装节点，本计划未自动接入，不谎称已平滑。',
    ],
  }
}

/**
 * ★★ 2026-11-17（H2）每张参考图的独立权重 / 衰减区间 / mask 区域绑定。
 *
 * ## 为什么是独立函数而不是改 planReference
 *   planReference 是已经回归锁死的零漂移核心（native 策略不碰图、通用兜底只接一张）。
 *   H2 只在**显式给 referenceControls 时**追加 patch —— 不给 = 一字节不改，
 *   这既保住老契约，也让新能力可单独回退。
 *
 * ## 用本机真有的节点（不臆造）
 *   · 权重/衰减 → `LatentComposite.feather`（0=硬切、1=全羽化）作为「软权重」近似；
 *     ComfyUI 没有通用的 per-reference scalar weight 节点，feather 是核心节点里
 *     唯一能表达"这张图的影响有多软"的参数 —— 语义写在 notes 里，不冒充 IP-Adapter weight。
 *   · mask → `VAEEncodeForInpaint`（mask + grow_mask_by=0）。**刻意不用 SetLatentNoiseMask**：
 *     0.18 局部重绘架构锁明确禁止整图 mask 往返，H2 不跟它撞车。
 *   · 多张 → 依次 LatentComposite(samples_to=上一张结果, samples_from=本张)，x/y=0。
 *
 * @param {object} workflow 已经过角色参考兜底的工作流
 * @param {object} opts { refs: 上传后的文件名数组, controls: [{weight,startPercent,endPercent,mask}] }
 * @param {object|null} nodeSet 本机 /object_info 节点集合（缺节点就如实不接）
 * @returns {{applied:boolean, nodePatches:Array, rewires:Array, notes:string[], controls:Array}}
 */
export function planReferenceControls(workflow, opts = {}, nodeSet = null) {
  const refs = (Array.isArray(opts.refs) ? opts.refs : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  const controls = Array.isArray(opts.controls) ? opts.controls.slice(0, 8) : []
  const notes = []
  const has = (n) => (nodeSet instanceof Set ? nodeSet.has(n) : Boolean(nodeSet?.[n]))
  const out = { applied: false, nodePatches: [], rewires: [], notes, controls: [] }

  if (refs.length === 0 || controls.length === 0) {
    notes.push('没给 referenceControls，参考图权重/区域绑定不启用（零漂移）。')
    return out
  }
  const needComposite = controls.some((c) => Number.isFinite(c?.weight) || String(c?.mask ?? '').trim() !== '')
  const canComposite = has('LatentComposite')
  const canMask = has('VAEEncodeForInpaint')
  if (!canComposite || (controls.some((c) => String(c?.mask ?? '').trim() !== '') && !canMask)) {
    notes.push(`本机缺 ${!canComposite ? 'LatentComposite' : 'VAEEncodeForInpaint（mask 绑定）'}`
      + '，参考图独立权重/mask 不接（不臆造节点）。')
    return out
  }
  // 没给任何可落地控制时零漂移（例如只给了 start/end 这种本机无门控的提示）
  if (!needComposite) {
    notes.push('referenceControls 里没有可落地的 weight/mask（只有 start/end 提示），不接（零漂移）。')
    return out
  }
  // 找主链上被参考兜底改接的 latent_image 目标（KSampler），以及 VAE 接线。
  const samplerId = findLatentImageTarget(workflow)
  const vaeLink = findVaeLink(workflow)
  if (samplerId === null || vaeLink === null) {
    notes.push('找不到采样节点或 VAE 接线，H2 不接（不提交一个 ComfyUI 必拒的图）。')
    return out
  }
  const used = refs.slice(0, Math.min(refs.length, controls.length))
  let tail = null
  for (let i = 0; i < used.length; i += 1) {
    const c = controls[i] ?? {}
    const loadId = `__cp_h2_load_${i}`
    const encodeId = `__cp_h2_vae_${i}`
    const maskLoadId = `__cp_h2_mask_${i}`
    out.nodePatches.push({ id: loadId, spec: { class_type: 'LoadImage', inputs: { image: used[i] } } })
    // mask 绑定：VAEEncodeForInpaint（mask + grow_mask_by=0），与 0.18 局部重绘架构锁不冲突。
    const maskName = typeof c.mask === 'string' ? c.mask.trim() : ''
    const withMask = maskName !== '' && canMask
    if (withMask) {
      out.nodePatches.push({ id: maskLoadId, spec: { class_type: 'LoadImage', inputs: { image: maskName } } })
    }
    out.nodePatches.push({
      id: encodeId,
      spec: { class_type: withMask ? 'VAEEncodeForInpaint' : 'VAEEncode',
        inputs: withMask
          ? { pixels: [loadId, 0], vae: vaeLink, mask: [maskLoadId, 0], grow_mask_by: 0 }
          : { pixels: [loadId, 0], vae: vaeLink } },
    })
    const latentFrom = [encodeId, 0]
    // 权重 → feather（软权重）；start/end 是采样区间提示，记进 notes 供人核对，
    // 本机没有 per-ref 时序门控节点，不假装有 —— 这是 H2 的诚实边界。
    const weight = Number.isFinite(c.weight) ? Math.min(1, Math.max(0, c.weight)) : 1
    const feather = Number.isFinite(c.feather) ? Math.min(1, Math.max(0, c.feather)) : 1 - weight
    if (tail === null) tail = latentFrom
    else {
      const cid = `__cp_h2_composite_${i}`
      out.nodePatches.push({
        id: cid,
        spec: { class_type: 'LatentComposite',
          inputs: { samples_to: tail, samples_from: latentFrom, x: 0, y: 0, feather } },
      })
      tail = [cid, 0]
      out.controls.push({ index: i, weight, feather, mask: maskName !== '' })
    }
    if (Number.isFinite(c.startPercent) || Number.isFinite(c.endPercent)) {
      notes.push(`参考图 ${i + 1} 的 startPercent/endPercent 已记录（${c.startPercent ?? 0}–${c.endPercent ?? 1}）；`
        + '本机无 per-reference 采样时序门控节点，未据此改采样器（不假装生效）。')
    }
  }
  if (tail !== null) {
    out.rewires.push({ nodeId: samplerId, input: 'latent_image', from: tail })
    out.applied = true
    notes.push(`H2 已接：${used.length} 张参考图分别编码${notes.length > 0 ? '，见上条诚实边界' : ''}`
      + '，权重以 LatentComposite.feather 作软近似（非 IP-Adapter weight）。')
  }
  return out
}

/** 人话摘要（面板/日志用）。 */
export function describeStrategy(strategy) {
  if (!strategy) return '未协商'
  const tierLabel = { identity: '身份锁', style: '风格', structure: '结构', universal: '通用兜底' }[strategy.tier] ?? strategy.tier
  return `${strategy.label}（${tierLabel}，最多 ${strategy.maxRefs} 张）`
}
