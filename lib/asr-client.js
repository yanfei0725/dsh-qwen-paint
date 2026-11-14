/**
 * lib/asr-client.js —— D19 语音转写的**可用通路**（不是"做不到"的托词）。
 *
 * ★★ 背景（2026-11-14 实测）：本机 ComfyUI 0.39.0 的 1,686 个节点里
 *   **零个**语音转写节点（whisper / asr / transcri / subtitle / caption 全 0 命中）。
 *   所以转写不可能在 ComfyUI 图里跑。但"本机没有"≠"做不到"：
 *   绝大多数人手上已经有 OpenAI 兼容的 `/v1/audio/transcriptions` 端点
 *   （faster-whisper-server、whisper.cpp server、各种本地推理服务都是这个协议）。
 *
 *   本模块就接这个协议：**配了就能用，没配就如实说清楚怎么配**。
 *   三条绝不逾越的红线：
 *     ① 不自动下载模型、不自动起服务；
 *     ② 没配 `cfg.asrUrl` 时**不假装成功**，返回 ok:false + 安装清单 + verify 命令；
 *     ③ 服务端只回全文（不支持 verbose_json）时，标 `aligned:false`，
 *        绝不把"按字数均分"的时间戳说成"跟语音对齐了"。
 */

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** OpenAI 官方上限 25 MB。本地服务通常更宽，但默认按这个卡，可用 cfg.asrMaxBytes 放开。 */
export const ASR_DEFAULT_MAX_BYTES = 25 * 1024 * 1024

/** 默认端点路径。用户只填 `http://127.0.0.1:8000` 时自动补全。 */
export const ASR_DEFAULT_PATH = '/v1/audio/transcriptions'

/** 支持的音频扩展名。不是白名单歧视，是提前拦住"拿视频文件去转写"这种必炸的输入。 */
export const ASR_AUDIO_EXTS = [
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.webm', '.aac', '.mp4', '.mkv',
]

/**
 * 解析配置。**只读**，不探测、不发请求。
 * @returns {{ enabled:boolean, url:string, model:string, language:string, hasKey:boolean,
 *             maxBytes:number, timeoutMs:number, reason:string }}
 */
export function resolveAsrConfig(cfg = {}) {
  const raw = String(cfg?.asrUrl ?? '').trim()
  const maxBytes = Number.isFinite(cfg?.asrMaxBytes) && cfg.asrMaxBytes > 0
    ? Math.trunc(cfg.asrMaxBytes)
    : ASR_DEFAULT_MAX_BYTES
  const timeoutMs = Number.isFinite(cfg?.asrTimeoutMs) && cfg.asrTimeoutMs > 0
    ? Math.trunc(cfg.asrTimeoutMs)
    : 180_000
  if (raw === '') {
    return {
      enabled: false, url: '', model: '', language: '', hasKey: false,
      maxBytes, timeoutMs,
      reason: '没配置 asrUrl。语音转写需要一个 OpenAI 兼容的 /v1/audio/transcriptions 端点。',
    }
  }
  // 只接受 http(s)：`file://` 之类会让 fetch 抛个看不懂的错。
  let u
  try {
    u = new URL(raw)
  } catch {
    return {
      enabled: false, url: '', model: '', language: '', hasKey: false,
      maxBytes, timeoutMs,
      reason: `asrUrl 不是合法 URL：${raw}`,
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      enabled: false, url: '', model: '', language: '', hasKey: false,
      maxBytes, timeoutMs,
      reason: `asrUrl 只支持 http/https，实际是 ${u.protocol}`,
    }
  }
  // 用户填到域名/IP 为止时补默认路径；填了完整路径就原样用。
  const hasPath = u.pathname !== '' && u.pathname !== '/'
  const url = hasPath ? u.toString() : `${u.origin}${ASR_DEFAULT_PATH}`
  return {
    enabled: true,
    url,
    model: String(cfg?.asrModel ?? '').trim() || 'whisper-1',
    language: String(cfg?.asrLanguage ?? '').trim(),
    hasKey: String(cfg?.asrKey ?? '').trim() !== '',
    maxBytes,
    timeoutMs,
    reason: '',
  }
}

/** 秒（浮点）→ cue 的 from/to 数值，保留三位小数，并保证 to > from。 */
export function toCue({ start, end, text }, index) {
  const t = String(text ?? '').replace(/\r?\n/gu, ' ').trim()
  if (t === '') return null
  const from = Number.isFinite(Number(start)) ? Math.max(0, Number(start)) : 0
  let to = Number.isFinite(Number(end)) ? Math.max(0, Number(end)) : from
  // 服务端偶尔给出 end == start（零时长片段），补 0.2s，否则播放器不显示。
  if (to <= from) to = from + 0.2
  return {
    index: index + 1,
    from: Number(from.toFixed(3)),
    to: Number(to.toFixed(3)),
    text: t,
  }
}

/**
 * 把服务端返回体折成 cues。
 *
 * 三种响应格式都要吃得下，因为它们各自代表一种真实服务：
 *   · verbose_json —— OpenAI 官方 / faster-whisper-server：有 segments，**真对齐**
 *   · json         —— 简化实现：只有全文，只能均分（**标 aligned:false**）
 *   · text         —— whisper.cpp server 的默认输出：纯文本
 */
export function normalizeAsrResponse(body, { format = 'json', seconds = 0 } = {}) {
  const warnings = []
  if (body === null || body === undefined) {
    return { ok: false, cues: [], text: '', aligned: false, language: '', warnings, reason: '服务端返回空响应' }
  }
  // 纯文本
  if (typeof body === 'string') {
    const text = body.trim()
    if (text === '') return { ok: false, cues: [], text: '', aligned: false, language: '', warnings, reason: '转写结果为空' }
    const cues = spreadBySentence(text, seconds)
    warnings.push('服务端只返回了纯文本（没有时间戳），时间轴是按句均分的 —— 未与语音对齐。')
    return { ok: true, cues, text, aligned: false, language: '', warnings, reason: '' }
  }
  const text = String(body.text ?? '').trim()
  const language = String(body.language ?? '').trim()
  const segs = Array.isArray(body.segments) ? body.segments : []
  if (segs.length > 0) {
    const cues = segs.map((s, i) => toCue(s, i)).filter((c) => c !== null)
    if (cues.length > 0) {
      return { ok: true, cues, text, aligned: true, language, warnings, reason: '' }
    }
    warnings.push('服务端给了 segments 但全是空文本，退回按句均分。')
  } else if (text !== '') {
    warnings.push(format === 'verbose_json'
      ? '请求了 verbose_json 但服务端没给 segments，时间轴只能按句均分 —— 未与语音对齐。'
      : '服务端没给 segments，时间轴只能按句均分 —— 未与语音对齐。')
  }
  if (text === '') {
    return { ok: false, cues: [], text: '', aligned: false, language, warnings, reason: '转写结果为空' }
  }
  return { ok: true, cues: spreadBySentence(text, seconds), text, aligned: false, language, warnings, reason: '' }
}

/** 按句切分并均分到 `seconds`（没有时间戳时的兜底，**必须**配 aligned:false 使用）。 */
export function spreadBySentence(text, seconds = 0) {
  const lines = String(text ?? '')
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (lines.length === 0) return []
  const total = Number.isFinite(Number(seconds)) && Number(seconds) > 0
    ? Number(seconds)
    // 没给总时长时按每秒 4 字估（中文旁白常见语速），只是为了让时间轴单调递增。
    : Math.max(1, String(text).length / 4)
  const per = total / lines.length
  return lines.map((t, i) => ({
    index: i + 1,
    from: Number((i * per).toFixed(3)),
    to: Number(((i + 1) * per).toFixed(3)),
    text: t,
  }))
}

/** 媒体类型。服务端大多不看这个字段，但少数实现会按它决定解码器。 */
function mimeOf(ext) {
  const map = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
    '.webm': 'audio/webm', '.aac': 'audio/aac', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 真的去转写。
 *
 * @param {object} opts
 * @param {string} opts.audioPath 本地音频路径
 * @param {object} opts.cfg       插件配置（读 asrUrl / asrKey / asrModel / asrLanguage）
 * @param {Function} [opts.fetchFn] 注入用（测试里给假 fetch，绝不真联网）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.seconds] 仅用于"服务端不给时间戳"时的均分兜底
 */
export async function transcribeAudio({
  audioPath, cfg = {}, fetchFn, signal, seconds = 0,
} = {}) {
  const conf = resolveAsrConfig(cfg)
  if (!conf.enabled) {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '',
      provider: 'none', reason: conf.reason, warnings: [], config: conf,
    }
  }
  const file = String(audioPath ?? '').trim()
  if (file === '') {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '',
      provider: 'none', reason: '没给音频文件路径', warnings: [], config: conf,
    }
  }
  const ext = path.extname(file).toLowerCase()
  if (!ASR_AUDIO_EXTS.includes(ext)) {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
      reason: `不支持的音频扩展名 ${ext || '(无)'}；支持：${ASR_AUDIO_EXTS.join(' ')}`,
      warnings: [], config: conf,
    }
  }
  let buf
  try {
    const st = statSync(file)
    if (!st.isFile()) throw new Error('不是普通文件')
    if (st.size === 0) throw new Error('文件是空的')
    if (st.size > conf.maxBytes) {
      return {
        ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
        reason: `音频 ${st.size} 字节超过上限 ${conf.maxBytes}（可调 cfg.asrMaxBytes）；`
          + '建议先切段或转成 mp3 再传。',
        warnings: [], config: conf,
      }
    }
    buf = readFileSync(file)
  } catch (error) {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
      reason: `读不到音频文件：${error?.message ?? error}`, warnings: [], config: conf,
    }
  }

  const doFetch = fetchFn ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
      reason: '当前运行环境没有 fetch（Node < 18）；请升级 Node 或注入 fetchFn',
      warnings: [], config: conf,
    }
  }
  if (typeof globalThis.FormData !== 'function' || typeof globalThis.Blob !== 'function') {
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
      reason: '当前运行环境没有 FormData/Blob（Node < 18）；无法构造 multipart 上传',
      warnings: [], config: conf,
    }
  }

  const form = new globalThis.FormData()
  const name = path.basename(file)
  form.append('file', new globalThis.Blob([buf], { type: mimeOf(ext) }), name)
  form.append('model', conf.model)
  // ★ 一定要 verbose_json：只有这样服务端才回 segments，才有真时间戳。
  form.append('response_format', 'verbose_json')
  if (conf.language !== '') form.append('language', conf.language)

  const headers = {}
  if (conf.hasKey) headers.authorization = `Bearer ${String(cfg?.asrKey ?? '').trim()}`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), conf.timeoutMs)
  const onAbort = () => ac.abort()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) { clearTimeout(timer); return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: 'none',
      reason: '已取消', warnings: [], config: conf,
    } }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  let res
  try {
    res = await doFetch(conf.url, { method: 'POST', headers, body: form, signal: ac.signal })
  } catch (error) {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    const aborted = ac.signal.aborted
    return {
      ok: false, cues: [], text: '', aligned: false, language: '',
      provider: conf.url,
      reason: aborted
        ? `转写超时（${conf.timeoutMs}ms）或已取消；大文件请调大 cfg.asrTimeoutMs`
        : `连不上转写服务 ${conf.url}：${error?.message ?? error}`,
      warnings: [], config: conf,
    }
  }

  let body = null
  let raw = ''
  try {
    raw = await res.text()
    try { body = JSON.parse(raw) } catch { body = raw }
  } catch (error) {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: conf.url,
      reason: `读响应失败：${error?.message ?? error}`, warnings: [], config: conf,
    }
  }
  clearTimeout(timer)
  if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)

  if (res.ok !== true) {
    const detail = typeof body === 'object' && body !== null
      ? String(body.error?.message ?? body.message ?? body.detail ?? '')
      : String(body).slice(0, 300)
    return {
      ok: false, cues: [], text: '', aligned: false, language: '', provider: conf.url,
      reason: `转写服务返回 ${res.status}${detail === '' ? '' : `：${detail}`}`
        + (res.status === 401 || res.status === 403 ? '（检查 cfg.asrKey）' : ''),
      warnings: [], status: res.status, config: conf,
    }
  }

  const norm = normalizeAsrResponse(body, { format: 'verbose_json', seconds })
  return {
    ...norm,
    provider: conf.url,
    status: res.status,
    warnings: norm.warnings,
    config: conf,
  }
}

/** 配不上时该跑什么来确认 —— 直接把命令交出去，别让人再搜一遍。 */
export function asrVerifyHint() {
  return [
    '① 起一个本地服务（任选其一）：',
    '   faster-whisper-server: pip install faster-whisper-server && faster-whisper-server --port 8000',
    '   whisper.cpp server   : ./server -m models/ggml-base.bin --port 8080',
    '② 确认端点活着：curl -s http://127.0.0.1:8000/v1/models',
    '③ 配到插件里：asrUrl=http://127.0.0.1:8000（会自动补 /v1/audio/transcriptions）',
    '   curl -s -F file=@demo.wav -F model=whisper-1 -F response_format=verbose_json '
      + 'http://127.0.0.1:8000/v1/audio/transcriptions',
    '④ 回来再跑：GET /api/qwen-paint/subtitle?source=asr&audio=<本地音频路径>&seconds=<时长>',
  ].join('\n')
}
