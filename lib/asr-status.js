/**
 * lib/asr-status.js —— 本机 ASR（faster-whisper 等语音转写）状态探测（只读）。
 *
 * ## 集成口径（零新路径）
 *   插件**不内置、不代装**任何 ASR 运行时：asr-client.js 只需要一个 OpenAI 兼容的
 *   `/v1/audio/transcriptions` 端点（如本机 faster-whisper server），把 `cfg.asrUrl`
 *   指过去，既有字幕链路（subtitle-plan / /subtitle 端点）直接工作。
 *   本路由把「配没配 / 配的是什么 / 通不通」如实报出来（faster-whisper = MIT，
 *   CPU INT8 即可用、显存 0；GPU 档为 NVIDIA 专属，AMD 卡走 CPU）。
 */
import { guardedFetch } from './net-guard.js'
import { resolveAsrConfig } from './asr-client.js'

/** 只读快照：configured / urlOrigin / keySet / model / probe（origin 可达性，2.5s 超时）。 */
export async function asrStatusSnapshot(cfg = {}) {
  const r = resolveAsrConfig(cfg)
  const raw = String(cfg?.asrUrl ?? '').trim()
  const origin = (() => { try { return new URL(raw).origin } catch { return '' } })()
  const base = {
    configured: Boolean(raw),
    urlOrigin: origin || '',
    urlPath: (() => { try { return new URL(raw).pathname } catch { return '' } })(),
    keySet: Boolean(String(cfg?.asrKey ?? '').trim()),
    model: String(cfg?.asrModel ?? '').trim(),
    reason: r.ok ? '' : String(r.reason ?? ''),
    online: null,
    privacy: '本快照不含 asrKey；只回 origin 与路径，不回完整 URL 查询参数。',
  }
  if (!base.configured) {
    base.reason = base.reason || '没配置 asrUrl。本机 ASR 推荐 faster-whisper（MIT，CPU INT8 显存 0）搭配任一 OpenAI 兼容 server，把地址填进 asrUrl 即接通既有字幕链路。'
    return base
  }
  try {
    const init = { method: 'GET' }
    if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(2500)
    const res = await fetch(origin || raw, init)
    base.online = res.status < 500
    base.probeStatus = res.status
  } catch {
    base.online = false
    base.probeStatus = 0
    if (!base.reason) base.reason = 'origin 探测失败（服务未启动或地址不对）——转写时仍会按 asr-client 口径重试并如实报错'
  }
  return base
}

export const ASR_STATUS_ROUTE_PATH = '/api/qwen-paint/asr/status'

export function asrStatusRouteTable(base = {}) {
  const cfg = base.cfg || {}
  // ★ 2026-11-16 审计 P0：GET 也必须本机围栏（urlOrigin / configured 是配置信息，不外泄）。
  const isLocalRequest = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  return [
    {
      path: ASR_STATUS_ROUTE_PATH, method: 'GET',
      handler: async (req, res) => {
        if (isLocalRequest && !isLocalRequest(req)) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, reason: 'local requests only' }))
          return
        }
        try {
          const snapshot = await asrStatusSnapshot(cfg)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, asr: snapshot }))
        } catch {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, reason: '内部错误（详情见本机日志）' }))
        }
      },
    },
  ]
}
