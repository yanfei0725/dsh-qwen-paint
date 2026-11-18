/**
 * lib/tts-backends.js —— 可选 TTS 后端注册表（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   在原有 Qwen3-TTS 之外，让用户 / Agent 能选择：
 *     · GPT-SoVITS v5「原版」= dev 分支版本；
 *     · GPT-SoVITS v5「蒸馏版」= 由 dev 蒸馏而来的 turbo 版本；
 *     · IndexTTS2（B 站开源）。
 *
 * ## ★ 诚实边界（本文件最重要）
 *   这些模型的 ComfyUI 节点**类名、输入槽位、权重文件名**都未经本机
 *   /object_info 核实，网上能查到的只有节点包仓库与版本信息。
 *   ⇒ 绝不把任何类名写死成「已安装可用」，也绝不把仓库名当节点名。
 *   做法：每个后端给一个**模式**（正则），从宿主真实节点表里发现候选；
 *   发现不到就明确 degraded + 安装提示，不猜、不静默改跑别的后端。
 *   网上流传的 RTF / 显存 / 加速倍率数字一律标 unverified，不写进结论。
 *
 * ## 与既有链的关系
 *   lib/tts-workflow.js 的 TTS_FALLBACK_CHAINS 是 Qwen3-TTS 的三条真机链，
 *   被 test-tts-workflow.mjs 锁定长度与节点名，**本模块不动它**。
 *   新后端走 buildBackendWorkflow()，由调用方显式选择才启用。
 */
export const TTS_BACKEND_VERSION = 1

/** 后端注册表。nodePattern 只用于「从真实节点表里发现」，不是声明某节点一定存在。 */
export const TTS_BACKENDS = Object.freeze([
  {
    id: 'qwen3_tts',
    label: 'Qwen3-TTS（插件现有链）',
    variant: 'builtin',
    origin: '本机实测 /object_info（ComfyUI-Qwen-TTS）',
    nodePattern: /^FB_Qwen3TTS/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    requiresReferenceAudio: false,
    existing: true,
    unverified: false,
    installHint: '插件内置链，无需额外节点包。',
    notes: '默认后端；未选择或选择不可用时保持原有行为。',
  },
  {
    id: 'gpt_sovits_v5_dev',
    label: 'GPT-SoVITS v5 原版（dev）',
    variant: 'dev',
    origin: 'RVC-Boss/GPT-SoVITS（v5 权重）；ComfyUI 节点包 AIFSH/ComfyUI-GPT_SoVITS（2024-08 停更，v2/v4 时代，不支持 v5）、Sunfish56/GPT_SoVITS_ComfyUI（已删库，2026-11-19 实测 404）',
    nodePattern: /SoVITS|GPT_SoVITS|GSV/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    requiresReferenceAudio: true,
    existing: false,
    unverified: true,
    installHint: 'v5 暂无可用 ComfyUI 节点包（别装 v2 时代旧包冒充）；推荐走外接 GSV.CPP 服务（tts/backends 端点的 external_services 有引导）。插件不自动下载。',
    notes: '原版 dev。节点类名 / 输入槽位未经本机核实，靠模式发现真实节点。',
  },
  {
    id: 'gpt_sovits_v5_turbo',
    label: 'GPT-SoVITS v5 蒸馏版（turbo）',
    variant: 'turbo',
    origin: 'RVC-Boss/GPT-SoVITS v5 turbo（由 dev 蒸馏而来）',
    nodePattern: /SoVITS|GPT_SoVITS|GSV/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    requiresReferenceAudio: true,
    existing: false,
    unverified: true,
    installHint: '与上者共用节点包，模型变体选 turbo；插件不自动下载。',
    notes: '蒸馏版 turbo。变体名只作为元数据传给节点，不承诺速度或质量。',
  },
  {
    id: 'indextts2',
    label: 'IndexTTS2（B 站开源）',
    variant: 'index-tts2',
    origin: 'index-tts/index-tts；ComfyUI 节点包 chenpipi0807/ComfyUI-Index-TTS、billwuhao/ComfyUI_IndexTTS',
    nodePattern: /IndexTTS|Index_TTS|Index.?TTS2/u,
    savePattern: /^SaveAudio(?:MP3)?$/u,
    requiresReferenceAudio: true,
    existing: false,
    unverified: true,
    installHint: '需自行安装 IndexTTS2 节点包与权重；插件不自动下载。',
    notes: '节点类名 / 输入槽位未经本机核实，靠模式发现真实节点。',
  },
])

export const DEFAULT_TTS_BACKEND = 'qwen3_tts'

/** 把 /object_info 的节点表（对象 / Set / 数组）统一成字符串数组。 */
export function nodeNamesOf(caps) {
  const nodes = caps?.nodes ?? caps
  if (nodes instanceof Set) return [...nodes].map(String)
  if (Array.isArray(nodes)) return nodes.map(String)
  if (nodes && typeof nodes === 'object') {
    return Object.keys(nodes).filter((k) => nodes[k] !== false).map(String)
  }
  return []
}

/**
 * 模式发现：从**真实**节点表里找该后端的生成 / 保存节点候选。
 * 返回候选数组（可能为空），绝不虚构类名。
 */
export function discoverBackendNodes(installed, backend) {
  const names = nodeNamesOf(installed)
  const b = typeof backend === 'string'
    ? TTS_BACKENDS.find((x) => x.id === backend)
    : backend
  if (!b) return { generate: [], save: [], nodeCount: names.length }
  const generate = names.filter((n) => b.nodePattern.test(n))
  const save = names.filter((n) => b.savePattern.test(n))
  return { generate, save, nodeCount: names.length }
}

/** 选择后端。requested 为空 / 未知名时给明确 reason，绝不静默当成默认成功。 */
export function pickTtsBackend({ requested, installed = {}, hasReferenceAudio = false } = {}) {
  const id = String(requested ?? '').trim() || DEFAULT_TTS_BACKEND
  const backend = TTS_BACKENDS.find((x) => x.id === id)
  if (!backend) {
    return {
      ok: false, selected: null, degraded: true,
      reasons: ['未知 TTS 后端：' + id, '可选：' + TTS_BACKENDS.map((x) => x.id).join(' / ')],
    }
  }
  if (backend.existing) {
    return { ok: true, selected: backend, degraded: false, reasons: [] }
  }
  const found = discoverBackendNodes(installed, backend)
  const reasons = []
  if (found.generate.length === 0) {
    reasons.push('未在 /object_info 中发现该后端的生成节点（节点类名未经核实，需本机探测）')
  }
  if (found.save.length === 0) reasons.push('未发现音频保存节点')
  if (backend.requiresReferenceAudio && !hasReferenceAudio) {
    reasons.push('该后端需要参考音频做音色复刻，请先提供音频样本')
  }
  return {
    ok: reasons.length === 0,
    selected: backend,
    degraded: reasons.length > 0,
    reasons,
    nodes: found,
    installHint: backend.installHint,
  }
}

/** 给 UI / Agent 的清单：每个后端都带真实探测状态，不假装可用。 */
export function listTtsBackends({ installed = {} } = {}) {
  return TTS_BACKENDS.map((b) => {
    const found = b.existing ? { generate: [], save: [] } : discoverBackendNodes(installed, b)
    const ready = b.existing || (found.generate.length > 0 && found.save.length > 0)
    return {
      id: b.id,
      label: b.label,
      variant: b.variant,
      origin: b.origin,
      existing: b.existing,
      unverified: b.unverified,
      requiresReferenceAudio: b.requiresReferenceAudio,
      available: ready,
      generateCandidates: found.generate.slice(0, 8),
      installHint: b.installHint,
      reason: ready ? '' : '未检测到对应 ComfyUI 节点；' + b.installHint,
    }
  })
}

/** 纯数据补丁：变体名等元数据，绝不塞未经核实的参数进工作流。 */
export function ttsBackendToWorkflowPatch(selection) {
  const b = selection?.selected
  if (!b) return { backend: '', variant: '', unverified: true, notes: [] }
  return {
    backend: b.id,
    variant: b.variant,
    unverified: b.unverified,
    notes: b.unverified
      ? ['节点输入槽位未经本机核实：只写入节点确实声明的输入，其余仅回显']
      : [],
  }
}
