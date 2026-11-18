/**
 * lib/external-tts-exec.js —— 外接 TTS 执行链（2026-11-19）。
 *
 * ## 背景
 *   EXTERNAL_TTS_SERVICES（tts-lowlatency.js）此前只有清单+探活+请求构造纯函数，
 *   generate_speech 选了 gsv_cpp 也不会真调用——执行链缺这一环。本模块补上：
 *   backend=gsv_cpp 时直调本机服务（127.0.0.1:9880/tts），产物落出图目录。
 *
 * ## 边界（诚实边界，改这里前先看）
 *   · 回环围栏：fetch 走 net-guard 的 guardedFetch（只认 127.0.0.0/8 字面量、禁重定向），
 *     与 comfyUrl / asrUrl 同一套口径，绝不外发；
 *   · gsv 契约（2026-11-19 真机实测）：GPT-SoVITS v5 的 /tts 必填 ref_audio_path +
 *     prompt_text（服务端 400 白纸黑字），参考音频路径必须在服务端 --allow-path 白名单
 *     目录里（否则 403）；缺件在这里给明确原因，绝不静默降级默认音色；
 *   · 产物落出图目录（uniquePath 由调用方生成后传入），文件名约定与内置链一致；
 *   · 探活带 health 标记校验（9880 端口撞车防护，见 tts-lowlatency.js）。
 */
import fsp from 'node:fs/promises'
import { guardedFetch } from './net-guard.js'
import { buildSynthRequest, probeExternalTts } from './tts-lowlatency.js'

/**
 * 经外接服务合成一段语音并落盘。
 *
 * @param {object} args
 * @param {object} args.service EXTERNAL_TTS_SERVICES 的一项
 * @param {string} args.text 要合成的文字（调用方已 trim/校验非空）
 * @param {string} args.filePathBase 目标文件**基础路径**（不含扩展名；调用方 uniquePath
 *   生成、围栏内）。实际落盘 `<filePathBase>.<ext>`，ext 由响应 content-type 决定——
 *   绝不预选 .wav（服务改回 mp3/flac 时文件名不得谎报内容，锁 test-tts-workflow 同款意图）。
 * @param {string} [args.refAudioPath] 参考音频绝对路径（gsv 契约必填；须在服务端
 *   --allow-path 白名单目录内）
 * @param {string} [args.promptText] 参考音频的转写文本（gsv 契约必填）
 * @param {string} [args.language] 界面语言令牌（zh/en/ja/…，映射成 text_lang）
 * @param {Function} [args.fetchFn] 测试注入；缺省用 net-guard 的 guardedFetch
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.timeoutMs] 合成超时（默认 10 分钟，与内置链 waitForAudio 同量级）
 * @returns {Promise<{ok:true, path:string, format:string, bytes:number, tier:string}
 *   | {ok:false, reason:string}>} 失败给明确原因，绝不假装已合成。
 */
export async function speakViaExternalTts({
  service, text, filePathBase, refAudioPath = '', promptText = '', language = 'zh',
  fetchFn, signal, timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (!service || typeof service !== 'object') return { ok: false, reason: '未指定外接 TTS 服务' }
  const doFetch = fetchFn ?? guardedFetch
  // ★ gsv apiStyle 真契约（2026-11-19 服务端 400 实录）：ref_audio_path / prompt_text
  //   均必填，缺件明确拒绝，绝不静默降级默认音色假装合成成功。
  if (service?.apiStyle === 'gsv') {
    if (String(refAudioPath ?? '').trim() === '') {
      return { ok: false, reason: `${service.label}：合成必须提供参考音频（ref_audio_path）——请带参考音频或其音色样本重试` }
    }
    if (String(promptText ?? '').trim() === '') {
      return { ok: false, reason: `${service.label}：合成必须提供参考音频的转写文本（prompt_text）——V3/V4/V5 不支持无参考转写` }
    }
  }
  const probe = await probeExternalTts(service, { fetch: doFetch, signal })
  if (!probe.online) {
    return { ok: false, reason: `外接 ${service.label} 不在线：${probe.reason || '探活失败'}` }
  }
  const req = buildSynthRequest(service, { text, language, refAudioPath, promptText })
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    try { ctrl.abort(new Error(`超过 ${Math.round(timeoutMs / 1000)}s 未返回`)) } catch { /* 已结束 */ }
  }, Math.max(5000, Number(timeoutMs) || 10 * 60 * 1000))
  // ★ 2026-11-19 隐患修复：调用方 signal 必须并入同一个 controller——旧写法
  //   `signal ? undefined : ctrl.signal` 在调用方有 signal 时请求**不绑任何 abort**，
  //   外接服务挂死（进程在、不回包）就永等。内置链 waitForAudio 有 timeout 收口，
  //   外接链不能裸奔。调用方取消 / 超时 / 服务挂死三条路都收敛到 ctrl.abort。
  const onCallerAbort = () => {
    try { ctrl.abort(signal?.reason ?? new Error('调用方取消')) } catch { /* 已结束 */ }
  }
  if (signal) {
    if (signal.aborted) onCallerAbort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  let res
  try {
    res = await doFetch(probe.base + req.path, {
      method: req.method, headers: req.headers, body: req.body,
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
    return { ok: false, reason: '外接合成请求失败：' + String(e?.message ?? e).slice(0, 160) }
  }
  clearTimeout(timer)
  signal?.removeEventListener('abort', onCallerAbort)
  if (!res || !res.ok) {
    let detail = ''
    try { detail = (typeof res?.text === 'function') ? (await res.text()).slice(0, 160) : '' } catch { /* 忽略 */ }
    return { ok: false, reason: `外接合成 HTTP ${res?.status ?? '?'}${detail ? '：' + detail : ''}` }
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) return { ok: false, reason: '外接合成返回空音频' }
  const ctype = String(res.headers?.get?.('content-type') ?? '')
  const ext = /wav/i.test(ctype) ? 'wav'
    : /flac/i.test(ctype) ? 'flac'
      : /mpeg|mp3/i.test(ctype) ? 'mp3'
        : /ogg/i.test(ctype) ? 'ogg' : 'wav'
  // 落盘名用真实 content-type 定扩展名：文件名永远说真话。
  const filePath = String(filePathBase ?? '') + '.' + ext
  try {
    await fsp.writeFile(filePath, bytes)
  } catch (e) {
    return { ok: false, reason: '外接音频落盘失败：' + String(e?.message ?? e).slice(0, 160) }
  }
  return { ok: true, path: filePath, format: ext, bytes: bytes.length, tier: 'external:' + service.id }
}
