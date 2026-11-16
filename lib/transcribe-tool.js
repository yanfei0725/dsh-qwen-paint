/**
 * lib/transcribe-tool.js —— 音频转文字（ASR）的 Agent 工具与本机端点。
 *
 * ## 为什么单独一个文件
 *   底层转写能力早就在 lib/asr-client.js（transcribeAudio，OpenAI 兼容
 *   /v1/audio/transcriptions），但只藏在 GET /subtitle?source=asr 里 —— Agent 拿不到、
 *   面板也没有独立入口。本文件把它升成一等工具，index.js 零增长
 *   （经 lib/tool-registry.js 单点注册，先例 media-fx.js / asr-status.js）。
 *
 * ## 诚实边界（不吹）
 *   · 插件**不内置、不代装**任何 ASR 运行时：需要用户自己配一个 OpenAI 兼容端点
 *     （faster-whisper 等，模型除外不在包内）。没配 / 连不上就如实返回缺件清单，
 *     不假装能转、不返回空文字冒充成功。
 *   · 输入路径围栏沿用 asr-client::resolveAudioPath（必须在出图目录内），
 *     目录外一律拒；key 只回「配没配」，绝不回显。
 *   · 转写服务端报错只回固定文案 + asr-client 已净化的 reason，不回吐凭据。
 */

import { transcribeAudio, resolveAsrConfig, asrVerifyHint, ASR_AUDIO_EXTS } from './asr-client.js'

export const TRANSCRIBE_TOOL_NAME = 'transcribe_audio'
export const TRANSCRIBE_ROUTE_PATH = '/api/qwen-paint/audio/transcribe'

/** 工具的纯数据描述（供回归锁字面量，不依赖实例）。 */
export const TRANSCRIBE_OUTPUT_FIELDS = Object.freeze([
  'ok', 'text', 'cues', 'cue_count', 'language', 'aligned', 'provider', 'format', 'reason', 'verify',
])

function shape(r, format) {
  return {
    ok: r.ok === true,
    text: String(r.text ?? ''),
    cues: Array.isArray(r.cues) ? r.cues : [],
    cue_count: Array.isArray(r.cues) ? r.cues.length : 0,
    language: String(r.language ?? ''),
    aligned: r.aligned === true,
    provider: String(r.provider ?? 'none'),
    format,
    reason: String(r.reason ?? ''),
    verify: r.ok === true ? '' : asrVerifyHint(),
  }
}

/** 把 asr-client 的原始结果收口成工具输出白名单（不泄漏 config.key / 本机路径）。 */
export function normalizeTranscribeResult(r, format = 'json') {
  return shape(r ?? {}, format.toLowerCase() === 'srt' || format.toLowerCase() === 'vtt'
    ? format.toLowerCase() : 'json')
}

export function makeTranscribeTool(deps = {}) {
  const cfg = deps.cfg ?? {}
  return {
    name: TRANSCRIBE_TOOL_NAME,
    description: '音频转文字（ASR）：把出图目录内的音频（' + ASR_AUDIO_EXTS.join(' / ')
      + '）经用户自配的 OpenAI 兼容 /v1/audio/transcriptions 端点转成文字与带时间戳字幕。'
      + '需要用户先在 asrUrl 配好服务（如 faster-whisper server）——插件不内置、不代装 ASR 运行时；'
      + '没配或连不上会返回明确缺件清单和自检步骤，不返回空文字冒充成功。'
      + '音频必须在出图目录内，API key 绝不回显。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        audio: { type: 'string', description: '出图目录内的音频文件路径（或文件名）' },
        seconds: { type: 'number', description: '音频时长（秒），用于无服务端时间戳时的均分兜底；可选' },
        format: { type: 'string', description: '输出格式：json（默认，带 cues 时间戳）/ srt / vtt' },
      },
      required: ['audio'],
    },
    timeoutMs: 5 * 60 * 1000,
    output: { schema: {
      type: 'object',
      properties: Object.fromEntries(TRANSCRIBE_OUTPUT_FIELDS.map((k) => [k,
        k === 'cues' ? { type: 'array' } : k === 'cue_count' ? { type: 'number' }
          : k === 'aligned' || k === 'ok' ? { type: 'boolean' } : { type: 'string' }])),
      additionalProperties: false,
    } },
    async execute(args = {}) {
      const audio = String(args?.audio ?? '').trim()
      if (audio === '') return shape({ ok: false, reason: '没给音频路径（audio）' }, 'json')
      const fmt = String(args?.format ?? 'json').toLowerCase()
      try {
        const r = await transcribeAudio({
          audioPath: audio, cfg, fetchFn: deps.fetchFn,
          seconds: Number.isFinite(args?.seconds) ? args.seconds : 0,
        })
        return normalizeTranscribeResult(r, fmt)
      } catch (error) {
        deps.log?.('warn', `音频转文字工具异常：${error?.message ?? error}`)
        return shape({ ok: false, reason: '转写失败（详见插件日志）；未生成文字' }, fmt)
      }
    },
  }
}

/** 能力探测：配没配 / 端点形态 / 支持格式 / 自检步骤，只读不联网。 */
export function transcribeCapability(cfg = {}) {
  const conf = resolveAsrConfig(cfg)
  return {
    configured: conf.enabled === true,
    url: conf.url ?? '',
    model: conf.model ?? '',
    has_key: conf.hasKey === true,
    formats: [...ASR_AUDIO_EXTS],
    note: conf.enabled === true
      ? 'ASR 端点已配置；转写时会真连该服务，失败如实报错。'
      : conf.reason,
    verify: conf.enabled === true ? '' : asrVerifyHint(),
  }
}

export function transcribeRouteTable(base = {}) {
  const cfg = base.cfg ?? {}
  const isLocal = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  const respond = typeof base.respondJson === 'function' ? base.respondJson
    : (res, body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) }
  const readBody = typeof base.readJsonBody === 'function' ? base.readJsonBody : async () => ({})
  return [
    {
      path: '/api/qwen-paint/audio/transcribe/capabilities', method: 'GET',
      handler: async (req, res) => {
        if (isLocal && !isLocal(req)) { respond(res, { ok: false, reason: 'local requests only' }, 403); return }
        respond(res, { ok: true, ...transcribeCapability(cfg) })
      },
    },
    {
      path: TRANSCRIBE_ROUTE_PATH, method: 'POST',
      handler: async (req, res) => {
        if (isLocal && !isLocal(req)) { respond(res, { ok: false, reason: 'local requests only' }, 403); return }
        if (String(req?.method ?? '').toUpperCase() !== 'POST') { respond(res, { ok: false, reason: 'POST only' }, 405); return }
        let body
        try { body = await readBody(req) } catch { respond(res, { ok: false, reason: '请求体不是合法 JSON' }, 400); return }
        const out = await makeTranscribeTool({ ...base, cfg }).execute(body ?? {})
        respond(res, out)
      },
    },
  ]
}
