/** model-options —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#ttsll2-space-model-options */
import { unetOptionsFrom } from './comfy-catalog.js'
import { readUiState, writeUiState } from './config.js'
import { DEFAULT_TTS_BACKEND, TTS_BACKENDS, listTtsBackends, nodeNamesOf } from './tts-backends.js'
import { getAudioSampleStore } from './audio-sample.js'

/**
 * 三模式「主模型」选中态映射（纯函数，供端点与回归共用）。
 *
 * ★ 2026-11-16 报障根因：旧端点只给 `image` / `video` 两键，面板 hybrid 模式
 *   用 `selected[state.mode]` 取 `selected.hybrid` → 恒 undefined → 选择回显永远为空。
 *   混合链三段各自消费不同模型，选中态必须按段给出，不能靠模式名硬索引。
 *     · image / hybrid 的生图段 → cfg.mainModelOverride（与 mainmodel 写值同一处）
 *     · video（及 hybrid 的视频段）→ uiState.unetVideo
 *     · TTS 段 → uiState.ttsBackend / uiState.ttsVoiceSample（缺省回落默认后端 / 无音色）
 *
 *   返回结构刻意用「段名」而非「模式名」，面板不再把模式当键。
 */
export function modelChoicesFrom(cfg = {}, ui = {}) {
  const main = String(cfg.mainModelOverride ?? '')
  return {
    image: String(ui.unet ?? main ?? ''),
    video: String(ui.unetVideo ?? ''),
    // hybrid 不单列模型：它的生图段读 image 的键，视频段读 video 的键。
    // 保留这个键只是让面板「按模式取」的旧写法不再恒空（向后兼容）。
    hybrid: main,
    tts_backend: String(ui.ttsBackend ?? DEFAULT_TTS_BACKEND),
    tts_voice_sample: String(ui.ttsVoiceSample ?? ''),
  }
}

/** 后端白名单（id 集合，纯函数）：界面选值必须落在这里，未知后端拒绝。 */
export function isKnownTtsBackend(id) {
  const v = String(id ?? '')
  if (v === '') return true                       // 空 = 回默认，允许
  return TTS_BACKENDS.some((b) => b.id === v)
}

/**
 * 把界面选择的 TTS 后端 / 音色样本落盘（动态白名单 + 空串清除）。
 * @returns {{ok:boolean, reason:string, backend:string, voice:string}}
 */
export function persistTtsChoice({ backend, voiceSample, log }) {
  const ui = readUiState()
  const next = { ...ui }
  const b = String(backend ?? '')
  if (!isKnownTtsBackend(b)) {
    log?.('warn', `界面想选未知 TTS 后端「${b}」→ 已拒绝（可选：${TTS_BACKENDS.map((x) => x.id).join(' / ')}）`)
    return { ok: false, reason: '未知 TTS 后端', backend: String(ui.ttsBackend ?? DEFAULT_TTS_BACKEND), voice: String(ui.ttsVoiceSample ?? '') }
  }
  const v = String(voiceSample ?? '')
  // 音色 token 形如 sample:<id>；空串 = 清除；其它形态（路径 / ..）一律拒绝，防手拼 URL 塞任意路径。
  if (v !== '' && !/^sample:[A-Za-z0-9_-]+$/u.test(v)) {
    log?.('warn', '界面想选的音色样本令牌不合法 → 已拒绝')
    return { ok: false, reason: '音色样本令牌不合法', backend: String(ui.ttsBackend ?? DEFAULT_TTS_BACKEND), voice: String(ui.ttsVoiceSample ?? '') }
  }
  if (b !== '') next.ttsBackend = b
  else delete next.ttsBackend
  if (v !== '') next.ttsVoiceSample = v
  else delete next.ttsVoiceSample
  writeUiState(next, log ?? (() => {}))
  log?.('info', `界面 TTS 选择已落盘：后端=${b || '(默认)'} 音色=${v || '(默认)'}`)
  return { ok: true, reason: '', backend: b, voice: v }
}

/**
 * 构造 GET /api/comfy-pipeline/model-options 处理器。依赖注入沿用 host 同一套
 * 信任判定 / 探测 / 错误收口，不出现第二份口径。
 *
 * @param {object} deps
 * @param {(req: object) => boolean} deps.isLocalRequest 本机请求判定
 * @param {(res: object, body: object, status?: number) => void} deps.respondJson
 * @param {(error: unknown) => object} deps.failBody 错误收口（http-errors.js）
 * @param {object} deps.cfg 插件配置
 * @param {(cfg: object, signal?: any) => Promise<object|null>} deps.loadObjectInfoFor
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function makeModelOptionsHandler(deps) {
  const { isLocalRequest, respondJson, failBody, cfg, loadObjectInfoFor } = deps
  return async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'GET') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return }
    try {
      const objectInfo = await loadObjectInfoFor(cfg, undefined)
      if (objectInfo === null || typeof objectInfo !== 'object') {
        // 诚实分支（与 modesHandler 的探测失败分支同款）：探测失败 ≠ 没装模型。
        respondJson(res, {
          ok: true,
          online: false,
          unet: [],
          reason: 'ComfyUI /object_info 探测失败（后端忙 / 未启动 / 超时）——'
            + '候选清单暂不可用，这不代表没装模型；请稍后重开面板重试。',
        }, 200)
        return
      }
      const ui = readUiState()
      respondJson(res, {
        ok: true,
        online: true,
        unet: unetOptionsFrom(objectInfo),
        // ★ 2026-11-16 报障修复：按「段」给选中态，hybrid 不再恒空。
        selected: modelChoicesFrom(cfg, ui),
        // TTS 段候选：后端清单走本次 /object_info 的真实节点表（含 available/unverified），
        //   音色走样本库单例。两者都是可选增强：拿不到就回空 + 原因，不编造。
        tts_backends: listTtsBackends({ installed: nodeNamesOf(objectInfo) }),
        tts_voices: getAudioSampleStore(cfg.outputDir).list().map((s) => ({
          token: s.cloneToken, name: s.name, format: s.format, note: s.note,
        })),
        tts_note: '',
      }, 200)
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }
}

/**
 * 视频主模型界面选择（POST /api/qwen-paint/status.json 的 `unetvideo` 键）：
 * 动态白名单校验 + 落盘 uiState.unetVideo。空串 = 清除（回到已验默认）。
 *
 * @returns {boolean} 是否已采纳（拒绝时只记 warn，绝不静默放行）
 */
export function persistVideoModelChoice({ val, wf, log }) {
  const v = String(val ?? '')
  const allowed = [wf?.unet, wf?.unetGguf].filter((l) => Array.isArray(l)).flat()
  if (v === '') {
    writeUiState({ ...readUiState(), unetVideo: '' }, log)
    log('info', '界面清除了「视频主模型」选择（回到已验默认 Hummingbird-XT-5B）')
    return true
  }
  if (wf === null || allowed.length === 0 || !allowed.includes(v)) {
    log('warn', `界面想选「视频主模型」=「${v}」，但它不在 ComfyUI 的模型清单里 → 已拒绝`)
    return false
  }
  writeUiState({ ...readUiState(), unetVideo: v }, log)
  log('info', `界面把「视频主模型」选成了 ${v}（下次生成视频生效；架构不符会被 ComfyUI 明确拒收）`)
  return true
}
