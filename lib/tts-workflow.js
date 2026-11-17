// 文件头说明已外置 → docs/backend-headers-design-notes.md#backend-note-tts-workflow（原 L1-24）
import { parseWorkflow } from './workflow-ast.js'
// ★ 2026-11-15 本地批次（未发布）：可选 TTS 后端（GPT-SoVITS v5 dev/turbo、IndexTTS2）。
//   节点类名未经本机核实 ⇒ 只从真实节点表模式发现，绝不写死；见 lib/tts-backends.js。
import { pickTtsBackend } from './tts-backends.js'
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
  attention = '',
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
        // ★ 注意力后端：只在显式合法值时写入，默认不写⇒节点 auto（零漂移）。
        ...(TTS_ATTENTION_CHOICES.includes(attention) ? { attention } : {}),
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

/** Qwen3-TTS 节点 /object_info 实测合法的注意力枚举；空值=不写、保持默认 auto 零漂移。 */
export const TTS_ATTENTION_CHOICES = Object.freeze(['auto', 'sage_attn', 'flash_attn', 'sdpa', 'eager'])

/** 生成节点的标准输入（真机 /object_info 的 required 项，全部给合法枚举值）。 */
function generatorInputs(chain, { text, instruct, seed, attention }) {
  const common = {
    model_choice: '1.7B',
    device: 'auto',
    precision: 'bf16',
    language: 'Auto',
    seed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
    unload_model_after_generate: true,
  }
  // ★ 注意力后端：只有显式给了合法枚举才写入；默认不写 ⇒ 节点用自身 auto，行为零变化。
  //   本机真机 /object_info：FB_Qwen3TTS* 的 attention = auto/sage_attn/flash_attn/sdpa/eager。
  if (TTS_ATTENTION_CHOICES.includes(attention)) common.attention = attention
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
 * ★ 2026-11-14 全面排查补齐：把 tts-accel.js 的配置补丁接进 TTS 链。
 *
 * 诚实边界（很重要）：ComfyUI 的 TTS 生成节点有哪些输入槽位，是运行时
 * /object_info 决定的；本项目**不预设**任何第三方节点一定接受
 * max_seq_len / vocoder_mel_dtype / streaming。把它们硬塞进节点只会让
 * 真机提交直接被 custom_validation_failed 拒掉。
 * ⇒ 只有调用方显式给出 acceptedInputs（来自真实探测）时才写入；
 *   否则一律只回显到元数据、标 applied:false，绝不污染工作流。
 * 纯函数、零 I/O；不引用任何未经实测的倍率 / RTF / 毫秒数。
 */
export function applyTtsAccelToInputs(inputs, patch = {}, acceptedInputs = []) {
  const accepted = new Set(Array.isArray(acceptedInputs) ? acceptedInputs : [])
  const cfg = (patch && typeof patch.config === 'object' && patch.config !== null) ? patch.config : {}
  const out = { ...(inputs && typeof inputs === 'object' ? inputs : {}) }
  const applied = []
  const skipped = []
  const mapping = Object.freeze({
    max_seq_len: 'max_seq_len',
    vocoder_mel_dtype: 'vocoder_mel_dtype',
    streaming: 'streaming',
  })
  for (const key of Object.keys(mapping)) {
    if (cfg[key] === undefined) continue
    const slot = mapping[key]
    if (accepted.has(slot)) { out[slot] = cfg[key]; applied.push(slot) }
    else skipped.push(slot)
  }
  return {
    inputs: out,
    applied,
    skipped,
    note: skipped.length > 0
      ? '节点未声明这些输入槽位：参数只回显、不写入（需对应节点包支持）；未实测倍率不写进结论'
      : '参数已按探测到的槽位写入',
  }
}

/**
 * 构造 TTS 工作流。缺后端时抛带清单的明确错误（报告 §10「任何一层不吞异常」）。
 * 有后端时：Qwen3-TTS 生成节点 → 音频保存节点。
 * accelPatch 来自 ttsAccelToWorkflowPatch()；acceptedInputs 来自 /object_info 探测。
 */
/**
 * ★ 2026-11-15：用户显式选择**非默认** TTS 后端时的工作流构图。
 *
 * ## 诚实边界
 *   GPT-SoVITS v5 / IndexTTS2 的节点类名、输入槽位、权重名都未经本机核实。
 *   ⇒ 生成 / 保存节点一律来自 pickTtsBackend() 对真实 /object_info 的模式发现；
 *     输入只写 acceptedInputs 里确实存在的槽位（没探测到就只给 text），
 *     并在 note 里说明「若被节点拒绝，请按节点包文档补齐槽位映射」。
 *   ⇒ 探测不到节点直接抛明确清单，**绝不静默回退到 Qwen3-TTS**
 *     （用户选了 A 却偷偷跑 B 是最坏的那种骗人）。
 *   ⇒ 不改 TTS_FALLBACK_CHAINS，默认路径完全不变。
 */
export function buildBackendWorkflow(caps, {
  backend, text, referenceFile = '', referenceText = '', seed = 0,
  prefix = 'comfy-pipeline/tts', acceptedInputs = [],
} = {}) {
  const pick = pickTtsBackend({
    requested: backend,
    installed: { nodes: caps?.nodes ?? {} },
    hasReferenceAudio: Boolean(String(referenceFile ?? '').trim()),
  })
  if (!pick.ok) throw new Error(pick.reasons.join('；'))
  const generate = pick.nodes.generate[0]
  const save = pick.nodes.save[0]
  const accepted = new Set(Array.isArray(acceptedInputs) ? acceptedInputs : [])
  const wanted = {
    text: String(text ?? '').trim(),
    ref_audio: String(referenceFile ?? '').trim(),
    prompt_audio: String(referenceFile ?? '').trim(),
    ref_text: String(referenceText ?? ''),
    emotion: '',
    seed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
  }
  const inputs = {}
  const skipped = []
  for (const [key, value] of Object.entries(wanted)) {
    if (value === '' || value === undefined) continue
    if (accepted.has(key)) inputs[key] = value
    else skipped.push(key)
  }
  // 一个槽位都没探测到时只给最通用的 text，并明确标注未核实。
  if (accepted.size === 0) inputs.text = String(text ?? '').trim()
  const raw = {
    1: { class_type: generate, inputs },
    2: { class_type: save, inputs: { audio: ['1', 0], filename_prefix: String(prefix) } },
  }
  return {
    workflow: parseWorkflow(raw),
    payload: raw,
    probe: {
      available: true,
      tier: pick.selected.id,
      label: pick.selected.label,
      chain: { id: pick.selected.id, generate, save },
      unverified: true,
      note: '第三方节点输入槽位未经本机核实：只写已声明槽位，其余参数仅回显。'
        + '若真机提交被拒，请按节点包文档提供 acceptedInputs 映射。',
      skipped,
    },
    format: 'mp3',
    residency: ttsResidency(),
    accel: { patch: {}, applied: [], skipped, note: '自定义后端不套用 Qwen3-TTS 加速补丁', unverified: true },
  }
}

export function buildTtsWorkflow(caps, {
  text, instruct, durationSec = 3, seed = 0, prefix = 'comfy-pipeline/tts',
  accelPatch = null, acceptedInputs = [], attention = '',
} = {}) {
  const probe = probeTts(caps)
  if (!probe.available) throw new Error(probe.reason)
  const body = String(text ?? '').trim()
  if (body === '') throw new Error('TTS 段：text 不能为空')
  const chain = probe.chain
  const baseInputs = generatorInputs(chain, { text: body, instruct, seed, attention })
  const accel = accelPatch
    ? applyTtsAccelToInputs(baseInputs, accelPatch, acceptedInputs)
    : { inputs: baseInputs, applied: [], skipped: [], note: '未提供 TTS 加速补丁' }
  const raw = {
    1: { class_type: chain.generate, inputs: accel.inputs },
    2: { class_type: chain.save, inputs: saveInputs(chain, prefix) },
  }
  return {
    workflow: parseWorkflow(raw),
    payload: raw,
    probe,
    format: chain.format,
    durationSec,
    residency: ttsResidency(),
    accel: {
      patch: (accelPatch && typeof accelPatch.config === 'object' && accelPatch.config !== null)
        ? { ...accelPatch.config } : {},
      applied: accel.applied,
      skipped: accel.skipped,
      note: accel.note,
      unverified: true,
    },
  }
}
