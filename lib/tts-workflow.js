/**
 * lib/tts-workflow.js —— 报告 v3 §3/§10：混合模式的 TTS 段契约与兜底链。
 *
 * ## 本机现实（2026-11-10 复核）
 * ComfyUI /object_info 里没有 FB_Qwen3TTS* / SaveAudio 这一族 TTS 节点，
 * models/ 里也没装 qwen3-tts 权重。所以**混合模式不能假装能出 wav**。
 * 按报告 §10 决策树：「TTS 主模型缺 → qwen3-tts-gguf 0.6B → 再缺 → 报错列文件与目录」。
 *
 * 本模块把这条决策树做成**可探测、可报错、可插拔**的契约：以后用户把 TTS 节点/模型
 * 装进来，同一份探测逻辑会自动放行，不需要改混合模式的编排代码。
 */
import { parseWorkflow } from './workflow-ast.js'

/** 声明式兜底链：顺序即优先级，每级都要写日志，不静默降级。 */
export const TTS_FALLBACK_CHAINS = [
  { id: 'qwen3-tts', nodes: ['FB_Qwen3TTS', 'SaveAudio'], models: ['qwen3-tts'], label: 'Qwen3-TTS 主模型' },
  { id: 'qwen3-tts-gguf', nodes: ['FB_Qwen3TTSGGUF', 'SaveAudio'], models: ['qwen3-tts-gguf-0.6B'], label: 'qwen3-tts-gguf 0.6B' },
  { id: 'minimax-h3', nodes: ['MiniMaxH3TTS', 'SaveAudio'], models: ['MiniMax-H3'], label: 'MiniMax H3 兜底' },
]

/** TTS 段缺件时，把「该放什么、放哪」说清楚，而不是吐一句"不可用"。 */
export function ttsMissingReport(probe) {
  const dirs = 'ComfyUI/models/text_encoders/ 与 ComfyUI/models/checkpoints/（TTS 权重）；custom_nodes/（TTS 节点包）'
  const wanted = TTS_FALLBACK_CHAINS.map((c) => `${c.label}：节点 ${c.nodes.join('/')}、模型 ${c.models.join('/')}`).join('；')
  return `混合模式需要 TTS 段，但本机没探到可用后端。${dirs}。候选链：${wanted}。`
    + ` 当前探测：nodes=${JSON.stringify(probe?.nodes ?? {})}、models=${JSON.stringify(probe?.models ?? {})}。`
    + ' 生图与视频两段可独立使用；装好 TTS 后本段自动放行，无需改动编排。'
}

/**
 * 探测 TTS 能力。caps.nodes / caps.models 是 ComfyUI 探测结果（缺字段按"没有"处理）。
 * ⚠ 与 resolvePlan 的「探测失败不降级」不同：这里是**明确缺件**，报清楚即可。
 */
export function probeTts(caps) {
  const nodes = caps?.nodes ?? {}
  const models = caps?.models ?? {}
  const modelNames = [
    ...(Array.isArray(models.tts) ? models.tts : []),
    ...(Array.isArray(models.checkpoints) ? models.checkpoints : []),
  ].map((x) => String(x))
  for (const chain of TTS_FALLBACK_CHAINS) {
    const nodesOk = chain.nodes.every((n) => nodes[n] === true)
    const modelsOk = chain.models.some((m) => modelNames.some((f) => f.toLowerCase().includes(m.toLowerCase())))
    if (nodesOk && modelsOk) return { available: true, tier: chain.id, label: chain.label, chain, nodes, models: modelNames }
  }
  return { available: false, tier: null, label: '', nodes, models: modelNames, reason: ttsMissingReport({ nodes, models: modelNames }) }
}

/**
 * 构造 TTS 工作流。缺后端时抛带清单的明确错误（报告 §10「任何一层不吞异常」）。
 * 有后端时用 API 格式：文本编码 → TTS 采样 → SaveAudio。
 */
export function buildTtsWorkflow(caps, { text, durationSec = 3, seed = 0, prefix = 'comfy-pipeline/tts' } = {}) {
  const probe = probeTts(caps)
  if (!probe.available) throw new Error(probe.reason)
  const body = String(text ?? '').trim()
  if (body === '') throw new Error('TTS 段：text 不能为空')
  const raw = {
    1: { class_type: 'FB_Qwen3TTS', inputs: { text: body, duration: Number(durationSec), seed: Number(seed) } },
    2: { class_type: 'SaveAudio', inputs: { audio: ['1', 0], filename_prefix: String(prefix) } },
  }
  return { workflow: parseWorkflow(raw), payload: raw, probe, durationSec }
}
