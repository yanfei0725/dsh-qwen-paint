/**
 * lib/worker-protocol.js —— 主控端与各模型 Worker 之间的统一协议（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   不同模型的原生 API 千差万别，主控端只认一套：
 *     · TTS：{ "text": "...", "prompt_audio": "path", "emotion": "..." }
 *     · 音乐：{ "prompt": "...", "duration_sec": N, ... }
 *     · 输出：统一为音频文件路径（相对出图目录）或 base64。
 *   插件内部再用 Adapter 把统一输入映射到各模型原生字段。
 *
 * ## ★ 诚实边界
 *   本文件只做**协议校验与字段映射**（纯数据），不真调任何模型、不联网、
 *   不派生子进程。各模型原生字段名未经核实 ⇒ Adapter 只登记「候选字段」，
 *   真实映射需由用户按节点包文档配置，绝不硬编码成「已验证」。
 *
 * ## 隐私
 *   prompt_audio 只接受相对路径或 sample:<id> 令牌；拒绝绝对路径、
 *   `..` 穿越、UNC 路径，避免把任意本机文件喂给 Worker。
 */
export const WORKER_PROTOCOL_VERSION = 1

export const UNIFIED_TTS_INPUT_FIELDS = Object.freeze([
  'text', 'prompt_audio', 'emotion', 'language', 'seed', 'reference_text',
])
export const UNIFIED_MUSIC_INPUT_FIELDS = Object.freeze([
  'prompt', 'duration_sec', 'lyrics', 'style', 'bpm', 'vocal', 'seed', 'preset',
])
export const UNIFIED_OUTPUT_FIELDS = Object.freeze([
  'ok', 'audio_path', 'audio_base64', 'format', 'duration_ms', 'reason', 'worker',
])

const AUDIO_OUT_FORMATS = Object.freeze(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus'])

/**
 * Adapter 注册表：只描述「统一字段 → 候选原生字段」的映射意图，
 * 不声明任何模型一定接受这些字段。verified:false 一律标未核实。
 */
export const WORKER_ADAPTERS = Object.freeze([
  {
    id: 'gpt_sovits_v5', label: 'GPT-SoVITS v5（dev / turbo）', kind: 'tts',
    inputMap: { text: ['text', 'target_text'], prompt_audio: ['ref_audio', 'prompt_audio'],
      emotion: ['emotion', 'instruct'], reference_text: ['prompt_text', 'ref_text'] },
    outputMap: { audio_path: ['audio_path', 'wav_path'], audio_base64: ['audio', 'base64'] },
    verified: false,
    note: '原生字段名未经本机核实，需在 Worker 配置里确认后再启用。',
  },
  {
    id: 'indextts2', label: 'IndexTTS2', kind: 'tts',
    inputMap: { text: ['text'], prompt_audio: ['prompt_audio', 'ref_audio'],
      emotion: ['emotion', 'emo_vector'], reference_text: ['prompt_text'] },
    outputMap: { audio_path: ['audio_path'], audio_base64: ['audio'] },
    verified: false,
    note: '原生字段名未经本机核实。',
  },
  {
    id: 'ace_step_15', label: 'ACE-Step 1.5', kind: 'music',
    inputMap: { prompt: ['prompt', 'caption'], duration_sec: ['duration', 'audio_duration'],
      lyrics: ['lyrics'], bpm: ['bpm'], style: ['style', 'tags'] },
    outputMap: { audio_path: ['audio_path'], audio_base64: ['audio'] },
    verified: false,
    note: '原生字段名未经本机核实。',
  },
  {
    id: 'yue2', label: 'YuE2', kind: 'music',
    inputMap: { prompt: ['prompt', 'genre'], duration_sec: ['duration'], lyrics: ['lyrics'] },
    outputMap: { audio_path: ['audio_path'], audio_base64: ['audio'] },
    verified: false,
    note: '原生字段名未经本机核实。',
  },
])

export function listWorkerAdapters({ kind } = {}) {
  return WORKER_ADAPTERS.filter((a) => !kind || a.kind === kind)
    .map((a) => ({ id: a.id, label: a.label, kind: a.kind, verified: a.verified,
      unifiedFields: a.kind === 'tts' ? UNIFIED_TTS_INPUT_FIELDS.slice() : UNIFIED_MUSIC_INPUT_FIELDS.slice(),
      note: a.note }))
}

/** 参考音频路径围栏：只放行相对路径或 sample 令牌。 */
export function normalizePromptAudio(value) {
  const v = String(value ?? '').trim()
  if (!v) return { ok: true, value: '', reason: '' }
  if (v.startsWith('sample:')) {
    return /^sample:[a-z0-9_-]+$/u.test(v)
      ? { ok: true, value: v, reason: '' }
      : { ok: false, value: '', reason: '样本令牌格式非法' }
  }
  if (/^[A-Za-z]:[\\/]/u.test(v) || v.startsWith('\\\\') || v.startsWith('/')) {
    return { ok: false, value: '', reason: '参考音频只接受出图目录内的相对路径或样本令牌，不接受绝对路径' }
  }
  if (v.replace(/\\/g, '/').split('/').some((p) => p === '..')) {
    return { ok: false, value: '', reason: '参考音频路径不允许 .. 穿越' }
  }
  return { ok: true, value: v, reason: '' }
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n)
const num = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** 统一输入校验 + 规范化。输出给 Worker 的对象绝不夹带本机绝对路径。 */
export function normalizeWorkerInput({ kind = 'tts', ...raw } = {}) {
  const k = kind === 'music' ? 'music' : 'tts'
  if (k === 'music') {
    const prompt = clip(raw.prompt, 800)
    if (!prompt) return { ok: false, reason: '音乐任务必须有 prompt', input: null }
    return {
      ok: true,
      input: {
        kind: 'music', prompt,
        duration_sec: Math.trunc(num(raw.duration_sec, 5, 600, 60)),
        lyrics: clip(raw.lyrics, 4000),
        style: clip(raw.style, 200),
        bpm: Math.trunc(num(raw.bpm, 0, 240, 0)),
        vocal: raw.vocal === true,
        seed: Math.trunc(num(raw.seed, 0, 2147483647, 0)),
        preset: clip(raw.preset, 40) || 'custom',
      },
      reason: '',
    }
  }
  const text = clip(raw.text, 4000)
  if (!text) return { ok: false, reason: 'TTS 任务必须有 text', input: null }
  const audio = normalizePromptAudio(raw.prompt_audio)
  if (!audio.ok) return { ok: false, reason: audio.reason, input: null }
  return {
    ok: true,
    input: {
      kind: 'tts', text,
      prompt_audio: audio.value,
      emotion: clip(raw.emotion, 120),
      language: clip(raw.language, 40) || 'Auto',
      seed: Math.trunc(num(raw.seed, 0, 2147483647, 0)),
      reference_text: clip(raw.reference_text, 2000),
    },
    reason: '',
  }
}

/** 统一输出：路径一律相对化 / 脱敏，绝不回吐本机绝对路径。 */
export function normalizeWorkerOutput(raw = {}, { relativeTo } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const ok = src.ok !== false
  let audioPath = clip(src.audio_path ?? src.path ?? src.wav_path, 400)
  if (audioPath) {
    const root = String(relativeTo ?? '').trim()
    const normalized = audioPath.replace(/\\/g, '/')
    if (root && normalized.startsWith(root.replace(/\\/g, '/'))) {
      audioPath = normalized.slice(root.replace(/\\/g, '/').length).replace(/^\/+/, '')
    } else if (/^[A-Za-z]:[\\/]/u.test(audioPath) || normalized.startsWith('/') || normalized.startsWith('\\\\')) {
      // 绝对路径不回给前端 / Agent，只保留文件名。
      audioPath = normalized.split('/').pop() || ''
    }
  }
  const format = clip(src.format, 12).toLowerCase()
  return {
    ok,
    audio_path: audioPath,
    audio_base64: typeof src.audio_base64 === 'string' ? src.audio_base64.slice(0, 16 * 1024 * 1024) : '',
    format: AUDIO_OUT_FORMATS.includes(format) ? format : 'wav',
    duration_ms: Math.trunc(num(src.duration_ms, 0, 3600000, 0)),
    reason: clip(src.reason, 300),
    worker: clip(src.worker, 60),
  }
}

/** 把统一输入按 Adapter 映射成原生候选字段（纯数据，需用户确认后才用）。 */
export function adaptWorkerInput(adapterId, input) {
  const a = WORKER_ADAPTERS.find((x) => x.id === adapterId)
  if (!a) return { ok: false, reason: '未知 Adapter：' + adapterId, payload: null }
  const payload = {}
  for (const [unified, candidates] of Object.entries(a.inputMap)) {
    if (input?.[unified] === undefined || input?.[unified] === '') continue
    payload[candidates[0]] = input[unified]
  }
  return {
    ok: true,
    payload,
    verified: a.verified,
    reason: a.verified ? '' : '未核实：字段映射未经本机核实，请按 Worker 节点包文档确认后再提交',
    note: a.note,
  }
}
