/**
 * lib/tts-workflow.js —— 混合模式的 TTS 段契约与兜底链（报告 v3 §3/§10）。
 *
 * ## 本机实况（2026-11-10 真机复核，推翻上一轮误判）
 *   · 节点：/object_info 共 1684 个，含 `custom_nodes.ComfyUI-Qwen-TTS` 的
 *     **9 个 FB_Qwen3TTS\* 节点**（CustomVoice / VoiceDesign / DialogueInference /
 *     VoiceClone / VoiceClonePrompt / LoadSpeaker / RoleBank / SaveVoice / Train）；
 *     音频保存节点 `SaveAudio`(flac) / `SaveAudioMP3`(mp3) / `SaveAudioOpus` / `SaveAudioAdvanced`。
 *   · 权重：ComfyUI 安装目录下 `models/qwen-tts/` 中
 *     `Qwen3-TTS-12Hz-1.7B-CustomVoice/`、`Qwen3-TTS-Tokenizer-12Hz/`、`voices/` 已下载。
 *
 * ## 上一轮为什么把「有」判成「没有」（两条都记在这，别再犯）
 *   ① 兜底链写的节点名是猜的：`FB_Qwen3TTS` / `FB_Qwen3TTSGGUF` / `MiniMaxH3TTS`
 *      —— /object_info 里**一个都不存在**，真实名带后缀。
 *   ② 判据要求 `models/` 的加载器下拉里有 `qwen3-tts` 文件名 —— 但该节点包权重由
 *      `download_models.py` 的 `snapshot_download` 落到 `models/qwen-tts/`，
 *      **不进任何节点的下拉候选**。于是节点齐、权重齐，仍恒返回 available=false。
 *   ⇒ 现在只按**真实节点类名**探测；权重可用性交给 ComfyUI 执行时判定（装了节点包 +
 *     权重目录 = 放行），不再拿文件名列表当闸门。
 *
 * ## 保存格式
 *   `SaveAudio` 是 FLAC（deprecated），`SaveAudioMP3` 是 MP3。本模块主链出 mp3；
 *   落盘一律按 ComfyUI 返回的 `filename` 真实扩展名，**不写死 .wav**。
 */
import { parseWorkflow } from './workflow-ast.js'

/**
 * 声明式兜底链：顺序即优先级。
 * `generate` = 生成节点类名；`save` = 保存节点类名；`build` = 构造分支。
 * ⚠ 只列**能构造出工作流**的链；VoiceClone 等需要参考音频的链不列，避免「探测放行、构造失败」。
 * ⚠ ElevenLabs / FishAudio / HeyGen 是云 API 节点（要 API key），不列进本地离线兜底。
 */
export const TTS_FALLBACK_CHAINS = [
  {
    id: 'qwen3-tts-custom-mp3',
    generate: 'FB_Qwen3TTSCustomVoice',
    save: 'SaveAudioMP3',
    nodes: ['FB_Qwen3TTSCustomVoice', 'SaveAudioMP3'],
    build: 'customVoice',
    format: 'mp3',
    label: 'Qwen3-TTS 自定义音色 → MP3',
  },
  {
    id: 'qwen3-tts-custom-flac',
    generate: 'FB_Qwen3TTSCustomVoice',
    save: 'SaveAudio',
    nodes: ['FB_Qwen3TTSCustomVoice', 'SaveAudio'],
    build: 'customVoiceFlac',
    format: 'flac',
    label: 'Qwen3-TTS 自定义音色 → FLAC',
  },
  {
    id: 'qwen3-tts-design',
    generate: 'FB_Qwen3TTSVoiceDesign',
    save: 'SaveAudioMP3',
    nodes: ['FB_Qwen3TTSVoiceDesign', 'SaveAudioMP3'],
    build: 'voiceDesign',
    format: 'mp3',
    label: 'Qwen3-TTS 音色设计 → MP3',
  },
]

/** 权重由节点包自行管理，不在 object_info 的下拉候选里 —— 报告里说清楚，别再当闸门。 */
export const TTS_WEIGHT_NOTE = '权重目录 ComfyUI/models/qwen-tts/（由 custom_nodes/ComfyUI-Qwen-TTS/download_models.py 下载）；'
  + '节点包按需加载，不出现在 /object_info 的模型下拉中。'

/** TTS 段缺件时，把「该放什么、放哪」说清楚，而不是吐一句"不可用"。 */
export function ttsMissingReport(probe) {
  const dirs = 'custom_nodes/ComfyUI-Qwen-TTS/（节点包）与 models/qwen-tts/（权重）'
  const wanted = TTS_FALLBACK_CHAINS.map((c) => `${c.label}：${c.nodes.join(' + ')}`).join('；')
  const seen = Array.isArray(probe?.nodeNames) ? probe.nodeNames.slice(0, 12).join(', ') : ''
  return `混合模式需要 TTS 段，但本机 /object_info 里没探到可用的 TTS 节点。${dirs}。`
    + `候选链：${wanted}。${TTS_WEIGHT_NOTE}`
    + ` 当前探测：节点数=${Number(probe?.nodeCount ?? 0)}${seen ? `，样例=${seen}` : ''}。`
    + ' 生图与视频两段可独立使用；装好 TTS 节点与权重后本段自动放行，无需改动编排。'
}

/**
 * 节点名归一化：兼容三种来源
 *   · `catalogForTts(objectInfo)` → `{ [类名]: true }`（生产路径）
 *   · Set / 数组（测试与手工探测）
 *   · `probeCapabilities(cfg)` 的 caps.nodes → 只有 loraOnly/teSpeed 这类布尔标志，
 *     **不含类名**；此时明确提示改用 catalogForTts，不静默判成"没装"。
 */
function hasNode(nodes, name) {
  if (nodes instanceof Set) return nodes.has(name)
  if (Array.isArray(nodes)) return nodes.includes(name)
  if (nodes && typeof nodes === 'object') return nodes[name] === true
  return false
}

export function probeTts(caps) {
  const nodes = caps?.nodes ?? {}
  const nodeNames = nodes instanceof Set ? [...nodes]
    : Array.isArray(nodes) ? nodes.slice()
      : (nodes && typeof nodes === 'object' ? Object.keys(nodes) : [])
  const modelNames = [
    ...(Array.isArray(caps?.models?.tts) ? caps.models.tts : []),
    ...(Array.isArray(caps?.models?.checkpoints) ? caps.models.checkpoints : []),
  ].map((x) => String(x))
  for (const chain of TTS_FALLBACK_CHAINS) {
    if (chain.nodes.every((n) => hasNode(nodes, n))) {
      return {
        available: true,
        tier: chain.id,
        label: chain.label,
        format: chain.format,
        chain,
        nodeCount: nodeNames.length,
        nodeNames,
        models: modelNames,
        weightNote: TTS_WEIGHT_NOTE,
      }
    }
  }
  const looksLikeCapabilityFlags = nodeNames.length > 0 && nodeNames.every((n) => /^(qwen21|prefixCache|teSpeed|speedup|blockCache|rdna3fa|loraOnly|ggufUnet|officialSampling|sada)$/.test(n))
  return {
    available: false,
    tier: null,
    label: '',
    nodeCount: nodeNames.length,
    nodeNames,
    models: modelNames,
    reason: ttsMissingReport({ nodeCount: nodeNames.length, nodeNames })
      + (looksLikeCapabilityFlags
        ? ' ⚠ 传入的是 probeCapabilities 的能力标志集，不是 /object_info 节点表；请改用 catalogForTts(await loadObjectInfoFor(cfg))。'
        : ''),
  }
}

/** 生成节点的标准输入（真机 /object_info 的 required 项，全部给合法枚举值）。 */
function generatorInputs(chain, { text, instruct, seed }) {
  const common = {
    model_choice: '1.7B',
    device: 'auto',
    precision: 'bf16',
    language: 'Auto',
    seed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
    unload_model_after_generate: true,
  }
  if (chain.build === 'voiceDesign') {
    return { text: String(text), instruct: String(instruct ?? '自然、清晰的旁白'), ...common }
  }
  return {
    text: String(text),
    speaker: 'Serena',
    ...common,
  }
}

/** 保存节点的输入（SaveAudioMP3 多一个 quality 枚举）。 */
function saveInputs(chain, prefix) {
  return chain.save === 'SaveAudioMP3'
    ? { audio: ['1', 0], filename_prefix: String(prefix), quality: '128k' }
    : { audio: ['1', 0], filename_prefix: String(prefix) }
}

/**
 * 构造 TTS 工作流。缺后端时抛带清单的明确错误（报告 §10「任何一层不吞异常」）。
 * 有后端时：Qwen3-TTS 生成节点 → 音频保存节点。
 */
export function buildTtsWorkflow(caps, {
  text, instruct, durationSec = 3, seed = 0, prefix = 'comfy-pipeline/tts',
} = {}) {
  const probe = probeTts(caps)
  if (!probe.available) throw new Error(probe.reason)
  const body = String(text ?? '').trim()
  if (body === '') throw new Error('TTS 段：text 不能为空')
  const chain = probe.chain
  const raw = {
    1: { class_type: chain.generate, inputs: generatorInputs(chain, { text: body, instruct, seed }) },
    2: { class_type: chain.save, inputs: saveInputs(chain, prefix) },
  }
  return {
    workflow: parseWorkflow(raw),
    payload: raw,
    probe,
    format: chain.format,
    durationSec,
  }
}
