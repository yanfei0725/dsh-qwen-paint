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
// B5：TTS 链同样要记账 —— 它会把千问主模型顶掉，下一张生图要重载
import { sessionResidency, RESIDENCY_KEYS } from './model-residency.js'
import { toComfyInputPath } from './comfy-upload.js'

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

/**
 * 语音克隆链（D21，2026-11-14 新增）。
 *
 * ## 为什么**刻意不放进** TTS_FALLBACK_CHAINS
 *   这条链必须有参考音频才能构造。混进自动兜底会在「用户没给参考音频」时被选中，
 *   然后要么构造失败、要么退化成随机音色 —— 两种都是静默骗人。
 *   所以由调用方显式声明要用它，才走这里。
 *
 * ## 真机槽位（ComfyUI 0.39.0，/object_info 1686 节点，2026-11-14 实测）
 *   · `FB_Qwen3TTSVoiceClone`
 *       required = target_text / model_choice / device / precision / language
 *       optional = **ref_audio(AUDIO)** / **ref_text(STRING)** / voice_clone_prompt(VOICE_CLONE_PROMPT) / …
 *     ⇒ 参考音频是**可选输入**，不给也能跑（那就是随机音色），所以槽位存在 ≠ 克隆生效，
 *       必须由我们显式连线。
 *   · `VHS_LoadAudio`：required = audio_file(**STRING**，默认 "input/")，输出 [AUDIO, FLOAT]
 *     ⇒ 选它而不是官方 `LoadAudio`：后者 `audio` 是 COMBO 且本机 options 为空数组，
 *       传任何文件名都可能被判非法；`VHS_LoadAudio` 直接收路径字符串，稳得多。
 *       代价是依赖 VideoHelperSuite —— 而本项目的视频链本来就在用它，不是新增依赖。
 *   · `VoiceClone` / `VoiceClonePrompt` 这两个**裸名字不存在**，真名带 `FB_Qwen3TTS` 前缀。
 */
export const VOICE_CLONE_CHAIN = {
  id: 'qwen3-tts-voiceclone-mp3',
  generate: 'FB_Qwen3TTSVoiceClone',
  loader: 'VHS_LoadAudio',
  save: 'SaveAudioMP3',
  nodes: ['FB_Qwen3TTSVoiceClone', 'VHS_LoadAudio', 'SaveAudioMP3'],
  format: 'mp3',
  label: 'Qwen3-TTS 语音克隆（参考音频复刻音色）→ MP3',
}

/** 探测语音克隆链是否齐备。缺件时给「缺哪个节点、它来自哪个包」，而不是一句"不可用"。 */
export function probeVoiceClone(caps) {
  const nodes = caps?.nodes ?? {}
  const missing = VOICE_CLONE_CHAIN.nodes.filter((n) => !hasNode(nodes, n))
  return {
    available: missing.length === 0,
    chain: VOICE_CLONE_CHAIN,
    missing,
    reason: missing.length === 0
      ? ''
      : `语音克隆需要这些节点：${missing.join('、')}。`
        + '`VHS_LoadAudio` 来自 custom_nodes/ComfyUI-VideoHelperSuite，其余来自 custom_nodes/ComfyUI-Qwen-TTS；'
        + '权重目录 ComfyUI/models/qwen-tts/。缺件不会自动下载，装好后本功能自动放行。',
  }
}

/**
 * 构造语音克隆工作流。
 *
 * @param {object} caps 同 buildTtsWorkflow（用 caps.nodes 判节点齐否）
 * @param {object} opts { text, referenceFile, referenceText?, seed?, prefix?, modelChoice? }
 * @returns {{ workflow: object, payload: object, probe: object, format: string }}
 */
export function buildVoiceCloneWorkflow(caps, {
  text, referenceFile, referenceText = '', seed = 0, prefix = 'comfy-paint/tts', modelChoice = '1.7B',
} = {}) {
  const probe = probeVoiceClone(caps)
  if (!probe.available) throw new Error(probe.reason)
  const body = String(text ?? '').trim()
  if (body === '') throw new Error('语音克隆：text 不能为空')
  const file = String(referenceFile ?? '').trim()
  if (file === '') throw new Error('语音克隆：参考音频文件名不能为空')
  const refText = String(referenceText ?? '').trim()
  const raw = {
    // ★ 真机实测：VHS_LoadAudio.audio_file 要 `input/文件名`，传裸名会被
    //   `custom_validation_failed` 直接拒。这里兜一次底。
    1: { class_type: VOICE_CLONE_CHAIN.loader, inputs: { audio_file: toComfyInputPath(file) } },
    2: {
      class_type: VOICE_CLONE_CHAIN.generate,
      inputs: {
        target_text: body,
        model_choice: modelChoice,
        device: 'auto',
        precision: 'bf16',
        language: 'Auto',
        ref_audio: ['1', 0],
        ref_text: refText,
        // ★ 没给转写时只取说话人嵌入。Qwen3-TTS 里 `x_vector_only=True` 正是这个语义；
        //   留着 False 让模型拿空 ref_text 去对齐，克隆质量会塌，而且是静默的。
        x_vector_only: refText === '',
        seed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
        unload_model_after_generate: true,
      },
    },
    3: {
      class_type: VOICE_CLONE_CHAIN.save,
      inputs: { audio: ['2', 0], filename_prefix: String(prefix), quality: '128k' },
    },
  }
  return {
    workflow: parseWorkflow(raw), payload: raw, probe, format: VOICE_CLONE_CHAIN.format,
    residency: ttsResidency(),
  }
}


/**
 * B5：构建 TTS 图前问一次驻留账本，返回「要不要重载、从谁切过来」。
 * ★ 抽成函数是因为有两种 TTS 图（普通 / 克隆），两边都得记，复制粘贴迟早漏一处。
 * ⚠ 记账失败只返回保守默认值，绝不打断构建。
 */
function ttsResidency() {
  try {
    const plan = sessionResidency.plan(RESIDENCY_KEYS.tts)
    sessionResidency.touch(RESIDENCY_KEYS.tts)
    return {
      key: RESIDENCY_KEYS.tts,
      switch_from: Array.isArray(plan?.unload) ? plan.unload : [],
      reload: plan?.load === true && Array.isArray(plan?.unload) && plan.unload.length > 0,
    }
  } catch {
    return { key: RESIDENCY_KEYS.tts, switch_from: [], reload: false }
  }
}

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
    residency: ttsResidency(),
  }
}
