// 设计说明已外置 → docs/tts-early-audio-design-notes.md#hdr-note-speech-tool
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { probeTts, buildTtsWorkflow, buildVoiceCloneWorkflow, buildBackendWorkflow } from './tts-workflow.js'
// ★ 2026-11-15：拖入的音频样本用 sample:<id> 令牌传进来，在这里解析成本机路径。
//   单例样本库与端点共享，零 index.js 改动；样本是零样本参考克隆，不训练权重。
import { resolveSampleToken, getAudioSampleStore } from './audio-sample.js'
import { toComfyInputPath } from './comfy-upload.js'
import { makeDeclaredOutputSchema } from './tool-contracts.js'
import { describeSpeechTool } from './tool-descriptions.js'
// ★ 2026-11-17：低延迟分块（默认关）——规划与拼接 argv 是纯函数，执行器由 deps 注入
// ★ 2026-11-19：外接 TTS 执行链（backend=gsv_cpp 直调本机服务，见 lib/external-tts-exec.js）
import { planTwoStageTts, buildAudioConcatArgv, EXTERNAL_TTS_SERVICES } from './tts-lowlatency.js'
import { speakViaExternalTts } from './external-tts-exec.js'
import { createMediaExec } from './media-exec.js'

export const SPEECH_OUTPUT_SCHEMA = makeDeclaredOutputSchema(
  {
    path: { type: 'string', description: '成品音频的绝对路径。' },
    files: { type: 'array', items: { type: 'string' } },
    format: { type: 'string', description: 'mp3 / flac，按 ComfyUI 返回的真实扩展名。' },
    tier: { type: 'string', description: '实际命中的兜底链 id。' },
    seconds: { type: 'number', description: '生成墙钟耗时（秒）。' },
  },
  ['path', 'files', 'format', 'tier', 'seconds'],
  '语音合成结果：保存路径、格式、命中链与耗时。',
)

/**
 * @param {object} deps 全部为本机 I/O，便于注入
 * @returns {(opts:object)=>Promise<{path,files,format,tier,seconds}>} 语音段执行器
 */
const TTS_CACHE_DIR = '.dshqp-tts-cache'

/**
 * 旁白内容指纹：文本 + 后端/音色 + 参考音频身份 + 采样参数。
 * 参考音频用「路径+大小+mtime」而非内容哈希——读整段音频只为算指纹不划算；改动文件即换 key。
 */
export async function narrationCacheKey(p = {}) {
  try {
    const ref = String(p.referenceAudio ?? '').trim()
    let refId = ref
    if (ref !== '') {
      try { const st = await fsp.stat(ref); refId = ref + '|' + st.size + '|' + Math.round(st.mtimeMs) } catch { /* 读不到就只用路径 */ }
    }
    const payload = JSON.stringify([String(p.backend ?? ''), String(p.text ?? '').trim(),
      String(p.instruct ?? '').trim(), Number(p.seed) || 0,
      String(p.voiceSample ?? '').trim(), String(p.referenceText ?? '').trim(), refId,
      p.lowLatencyChunks === true ? 'chunks' : 'whole'])
    return createHash('sha256').update(payload).digest('hex').slice(0, 24)
  } catch { return '' }
}

/** 命中要求「元数据可读 + 产物存在 + 字节数与登记一致」，任一不满足按未命中（绝不返回坏文件）。 */
export async function readNarrationCache({ key, outputDir } = {}) {
  if (!key || !outputDir) return null
  try {
    const dir = path.join(String(outputDir), TTS_CACHE_DIR)
    const meta = JSON.parse(await fsp.readFile(path.join(dir, String(key) + '.json'), 'utf8'))
    const file = path.join(dir, String(key) + '.' + String(meta.ext))
    const st = await fsp.stat(file)
    if (!(st.size > 0) || st.size !== Number(meta.bytes)) return null
    return { path: file, files: [file], format: String(meta.ext), tier: String(meta.tier ?? ''), seconds: 0, cached: true }
  } catch { return null }
}

/** 缓存写失败一律吞掉并返回 false：缓存是增强，绝不因为它让一次真实合成失败。 */
export async function writeNarrationCache({ key, out, outputDir } = {}) {
  if (!key || !out?.path || !outputDir || !out.format) return false
  try {
    const dir = path.join(String(outputDir), TTS_CACHE_DIR)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, String(key) + '.' + String(out.format))
    await fsp.copyFile(out.path, file)
    const st = await fsp.stat(file)
    await fsp.writeFile(path.join(dir, String(key) + '.json'),
      JSON.stringify({ key, ext: out.format, bytes: st.size, tier: out.tier ?? '', at: new Date().toISOString() }))
    return true
  } catch { return false }
}

/** TTS 段统一入口：内容缓存（增强）+ 真实合成。混合模式三段与独立工具共用一份实现。 */
export function makeSpeechRunner(deps) {
  const {
    cfg, log, ensureComfyUp, loadObjectInfoFor, catalogForTts,
    submitPrompt, fetchOutputBytes, fetchWithTimeout, cancelReason,
    safeStem, uniquePath, onFirstChunk,
  } = deps

  /** SaveAudio* 产物在 `outputs[*].audio`（不复用 waitForResult 的 images 通道）。 */
  async function waitForAudio(promptId, { signal, timeoutMs }) {
    // ★ 2026-11-18 审计：等待期限用单调钟（NTP 回拨会让墙上时钟期限"永不超时"）。
    const started = performance.now()
    for (;;) {
      if (signal?.aborted) throw cancelReason(signal)
      if (performance.now() - started > timeoutMs) throw new Error('等 TTS 出音频超时')
      await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1200))
      let history
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 30000, signal })
        if (!res.ok) continue
        history = await res.json()
      } catch { continue }
      const rec = history?.[promptId]
      if (rec === undefined || rec === null) continue
      for (const nodeOut of Object.values(rec.outputs ?? {})) {
        if (Array.isArray(nodeOut?.audio) && nodeOut.audio.length > 0) return nodeOut.audio
      }
      if (rec.status?.status_str === 'error') {
        throw new Error(`TTS 段执行失败：${JSON.stringify(rec.status?.messages ?? []).slice(0, 300)}`)
      }
    }
  }

  /**
   * 把本地参考音频送进 ComfyUI 的 input 目录，返回它在 ComfyUI 侧的相对路径。
   *
   * ★ 端点复用 `/upload/image`（2026-11-14 实测，ComfyUI 0.39.0）：
   *   传 wav 返回 `{"name":"…wav","subfolder":"","type":"input"}` + HTTP 200。
   *   音频和图片走同一个上传端点，**字段名仍叫 `image`** —— 这是 ComfyUI 的端点约定，
   *   不是笔误。别自作聪明换成 `audio`，那会直接 400。
   * ★ 文件名加时间戳前缀：不同目录的同名参考音频不会互相覆盖（与图片侧 issue #1 同一个坑）。
   */
  async function uploadRefAudio(filePath, signal) {
    let bytes
    try {
      bytes = await fsp.readFile(filePath)
    } catch (error) {
      throw new Error(`读不到参考音频：${filePath}（${error?.message ?? error}）`)
    }
    const name = `dshqp-ref-audio-${Date.now().toString(36)}-${path.basename(filePath)}`
    const form = new FormData()
    form.append('image', new Blob([bytes]), name)
    form.append('overwrite', 'true')
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/upload/image`, {
      method: 'POST', body: form, signal, timeoutMs: 120000,
    })
    if (!res?.ok) throw new Error(`参考音频上传失败：HTTP ${res?.status}`)
    const data = await res.json()
    if (!data?.name) throw new Error(`参考音频上传返回异常：${JSON.stringify(data).slice(0, 200)}`)
    // ★ 与 comfy-upload.js 同口径：VHS_LoadAudio 要 `input/文件名`，裸名会被真机拒。
    return toComfyInputPath(data.subfolder ? `${data.subfolder}/${data.name}` : data.name)
  }

  return async function runSpeechStage({
    text, instruct, seed = 0, prefix = 'qwen-paint/tts', stem = 'speech',
    signal, caps, referenceAudio, referenceText = '', backend = '', voiceSample = '', attention = '',
    lowLatencyChunks = false,
  } = {}) {
    const t0 = Date.now()
    const mediaExec = createMediaExec({ log, run: deps.mediaRun, enabled: deps.mediaExecEnabled !== false })
    // ⑦ 旁白内容缓存：同文本+音色+参数命中且产物完好 ⇒ 直接复用，连探活都省掉。
    //    deps.narrationCache === false 可整体关掉（验证真实上传/提交链路的场景要用）。
    const useCache = deps.narrationCache !== false
    const cacheKey = useCache ? await narrationCacheKey({ text, instruct, seed, backend, voiceSample, referenceAudio, referenceText, lowLatencyChunks }) : ''
    const hit = await readNarrationCache({ key: cacheKey, outputDir: cfg.outputDir })
    if (hit) { log?.('info', '旁白缓存命中，复用 ' + hit.path); return hit }
    const backendId = String(backend ?? '').trim()
    // ★ 2026-11-19 外接 TTS 执行链：backend 是外接服务 id（gsv_cpp 等）时直调本机服务
    //   （回环 guardedFetch、产物落出图目录），不拉 ComfyUI 也不建工作流——探活离线给
    //   明确原因，绝不静默回退内置链。本分支刻意放在 ensureComfyUp 之前：外接服务跟
    //   ComfyUI 的死活无关，不该被它的冷启动拖着跑。
    const externalService = EXTERNAL_TTS_SERVICES.find((s) => s.id === backendId)
    if (externalService) {
      const textPart = String(text ?? '').trim()
      if (textPart === '') throw new Error('TTS 段：text 不能为空')
      // ★ 诚实边界（2026-11-19 增量审计）：instruct 是 Qwen3 VoiceDesign 专用（音色文字
      //   描述），外接链靠参考音频克隆、没有音色设计概念——静默忽略会让用户以为生效了，
      //   明确拒绝并给替代路径。
      if (String(instruct ?? '').trim() !== '') {
        throw new Error(`外接 ${externalService.label}：不支持 instruct 音色设计（那是内置 VoiceDesign 链的能力）`
          + '——外接链用参考音频克隆音色，请去掉 instruct 改带 reference_audio+reference_text。')
      }
      // 分块只是「早出首音」优化不是能力承诺：外接链整段一次提交（服务端 cut5 自行分句），
      // 意图被忽略时必须留痕，绝不静默。
      if (lowLatencyChunks === true) {
        log?.('warn', `外接 ${externalService.label}：lowLatencyChunks 不受支持，已忽略（整段一次提交，服务端 cut5 自行分句）`)
      }
      // 参考音频解析与内置链同一套：显式路径 / 音色样本令牌（sample:<id> → 出图目录内真实路径）。
      // 样本登记时可选带 transcript——面板音色下拉走外接链时 prompt_text 从这里来。
      let extRef = typeof referenceAudio === 'string' ? referenceAudio.trim() : ''
      let extTranscript = ''
      if (extRef === '' && String(voiceSample ?? '').trim() !== '') {
        const resolved = resolveSampleToken(voiceSample, getAudioSampleStore(cfg.outputDir))
        if (!resolved.ok) throw new Error(resolved.reason)
        extRef = resolved.path
        extTranscript = String(resolved.transcript ?? '').trim()
      }
      // 转写优先取显式 reference_text，其次样本登记的 transcript——都不给则走 v5 契约的明确拒绝。
      const extPrompt = String(referenceText ?? '').trim() || extTranscript
      // ★ GPT-SoVITS v5 真契约（2026-11-19 服务端 400 实录）：ref_audio_path / prompt_text
      //   均必填；缺件明确报错，绝不静默降级默认音色假装克隆。
      if (extRef === '' || extPrompt === '') {
        throw new Error(`外接 ${externalService.label}：合成必须提供参考音频和它的转写文本`
          + '（服务端字段 ref_audio_path / prompt_text，缺一会被 400 拒收；'
          + '参考音频还须落在服务端 --allow-path 白名单目录内）——请带参考音频+转写重试，或换内置链。')
      }
      await fsp.mkdir(cfg.outputDir, { recursive: true })
      // 基路径不带扩展名：真实扩展名由响应 content-type 决定（落盘函数负责追加），
      // 与统一链「不写死 .wav」同一纪律。
      const targetBase = await uniquePath(cfg.outputDir, `${safeStem(stem, 22)}_${cfg.filePrefix}_tts`)
      const r = await speakViaExternalTts({
        service: externalService, text: textPart, filePathBase: targetBase,
        refAudioPath: extRef, promptText: extPrompt,
        fetchFn: deps.externalFetch, signal, timeoutMs: 10 * 60 * 1000,
      })
      if (!r.ok) throw new Error(r.reason)
      const extSeconds = Number(((Date.now() - t0) / 1000).toFixed(1))
      log?.('info', `外接语音段落盘 ${r.path}（${r.bytes} 字节，耗时 ${extSeconds}s）`)
      const extOut = { path: r.path, files: [r.path], format: r.format, tier: r.tier, seconds: extSeconds }
      // 缓存失败不抛：它是增强，不能让一次真实合成因为缓存盘不可写而失败。
      if (useCache) await writeNarrationCache({ key: cacheKey, out: extOut, outputDir: cfg.outputDir })
      return extOut
    }
    await ensureComfyUp(cfg, log, signal)
    // 复用调用方已经取过的 /object_info（混合模式三段共用一份，避免重复拉取）
    const ttsCaps = caps ?? catalogForTts(await loadObjectInfoFor(cfg, signal))
    const probe = probeTts(ttsCaps)
    let refAudioPath = typeof referenceAudio === 'string' ? referenceAudio.trim() : ''
    // 拖入的音频样本：sample:<id> → 出图目录内的真实路径（不回给前端）。
    if (refAudioPath === '' && String(voiceSample ?? '').trim() !== '') {
      const resolved = resolveSampleToken(voiceSample, getAudioSampleStore(cfg.outputDir))
      if (!resolved.ok) throw new Error(resolved.reason)
      refAudioPath = resolved.path
    }
    // ★ 走克隆链时**必须**先上传拿 ComfyUI 侧的文件名；本地绝对路径进工作流等于凭空多出一条
    //   「ComfyUI 能不能看见我这个盘符」的隐含要求，Windows 下必炸。
    // ★ 有参考音频时改用克隆链自己的探测（它要的节点集不同），但**不能跳过前置的
    //   ensureComfyUp / object_info**，否则缺件时报错会变成 HTTP 层的一串噪音。
    const customBackend = backendId !== '' && backendId !== 'qwen3_tts'
    if (customBackend) {
      log?.('info', `显式指定 TTS 后端：${backendId}（节点需本机探测放行）`)
    } else if (refAudioPath !== '') {
      log?.('info', '检测到参考音频，走语音克隆链（复刻音色）')
    } else {
      if (!probe.available) throw new Error(probe.reason)
      log?.('info', `语音后端：${probe.label}（${probe.tier}）`)
    }

    const body = String(text ?? '').trim()
    if (body === '') throw new Error('TTS 段：text 不能为空')
    // 参考音频只上传一次（分块时不能每块重传）。
    let uploaded = ''
    if (refAudioPath !== '') {
      uploaded = await uploadRefAudio(refAudioPath, signal)
      log?.('info', `参考音频已上传：${uploaded}`)
    }
    /** 构建+提交+取字节一段；返回 {bytes, filename, ext, tier}。不落盘。 */
    const synthOne = async (textPart, partSeed) => {
      let built
      if (customBackend) {
        // 非默认后端：真实节点表探测；探测不到抛明确清单，绝不静默回退 Qwen3-TTS。
        built = buildBackendWorkflow(ttsCaps, {
          backend: backendId, text: textPart, referenceFile: uploaded,
          referenceText, seed: partSeed, prefix,
        })
      } else if (uploaded === '') {
        built = buildTtsWorkflow(ttsCaps, { text: textPart, instruct, durationSec: 3, seed: partSeed, prefix, attention })
      } else {
        built = buildVoiceCloneWorkflow(ttsCaps, {
          text: textPart, referenceFile: uploaded, referenceText, seed: partSeed, prefix, attention,
        })
      }
      const pid = await submitPrompt(cfg, built.payload, signal)
      const audio = await waitForAudio(pid, { signal, timeoutMs: 10 * 60 * 1000 })
      const first = audio[0]
      const bytes = await fetchOutputBytes(cfg, first, signal)
      const ext = /\.([a-z0-9]{2,5})$/iu.exec(String(first?.filename ?? ''))?.[1]?.toLowerCase() ?? 'mp3'
      const tier = built.probe?.tier ?? built.probe?.chain?.id ?? probe.tier
      return { bytes, filename: String(first?.filename ?? ''), ext, tier }
    }

    await fsp.mkdir(cfg.outputDir, { recursive: true })
    let bytes
    let ext
    let tier
    let chunkInfo = null
    const wantChunks = lowLatencyChunks === true && !customBackend
    if (wantChunks) {
      // ★ 两段式早出声（默认关）：首段短切先落盘并推事件给悬浮面板播，剩余整段一次提交。
      //   诚实边界：先落盘再播、非节点级流式；整段时长不变，首段先听；块间语气可能不连贯。
      const plan = planTwoStageTts(body)
      if (!plan.ok || plan.chunks.length < 2) throw new Error(plan.reason || '分块后不足两段，无法拼接')
      const media = await mediaExec.probe()
      if (!media.available) throw new Error('低延迟分块需要 ffmpeg 拼接音频，但未探测到：' + media.reason)
      const parts = []
      for (let i = 0; i < plan.chunks.length; i += 1) {
        const one = await synthOne(plan.chunks[i], seed + i)
        const partPath = await uniquePath(cfg.outputDir, `${safeStem(stem, 18)}_p${i}_${cfg.filePrefix}_tts.${one.ext}`)
        await fsp.writeFile(partPath, one.bytes)
        parts.push({ path: partPath, bytes: one.bytes.length })
        tier = one.tier
        ext = one.ext
        // 首段落盘即推事件（最长早出一个整段的合成时间）；失败不影响主流程。
        if (i === 0 && typeof onFirstChunk === 'function') {
          try { onFirstChunk(partPath, { bytes: one.bytes.length, of: 1, total: plan.chunks.length }) }
          catch (error) { log?.('warn', `首段音频事件推送失败（不影响合成）：${error?.message ?? error}`) }
        }
      }
      // concat 清单：逐字节写，ffmpeg -safe 0 允许绝对路径。
      const concat = buildAudioConcatArgv({ files: parts.map((x) => x.path),
        listFile: path.join(cfg.outputDir, `${safeStem(stem, 18)}_concat.txt`),
        out: path.join(cfg.outputDir, `${safeStem(stem, 22)}_${cfg.filePrefix}_tts.m4a`), ffmpeg: media.ffmpeg })
      if (!concat.ok) throw new Error(concat.reason)
      await fsp.writeFile(concat.argv[concat.argv.indexOf('-i') + 1], concat.listContent, 'utf8')
      const target = concat.argv[concat.argv.length - 1]
      const runResult = await mediaExec.runCommand(concat.argv.slice(1))
      if (!runResult.ok) throw new Error('分块音频拼接失败：' + runResult.reason)
      ext = 'm4a'
      // ★ 2026-11-18 审计：只需要字节数，整读几十 MB 的 m4a 纯浪费（改 stat）。
      bytes = null
      const concatStat = await fsp.stat(target)
      chunkInfo = { count: plan.chunks.length, parts: parts.map((x) => x.bytes), note: concat.note,
        path: target, bytes: concatStat.size }
    } else {
      const one = await synthOne(body, seed)
      bytes = one.bytes; ext = one.ext; tier = one.tier
    }
    const target = chunkInfo ? chunkInfo.path
      : await uniquePath(cfg.outputDir, `${safeStem(stem, 22)}_${cfg.filePrefix}_tts.${ext}`)
    if (!chunkInfo) await fsp.writeFile(target, bytes)
    // ⚠ 不叫 seconds 之外的名字会踩 selftest 的串行循环锚点；这里保持 seconds 语义一致
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
    log?.('info', `语音段落盘 ${target}（${bytes.length} 字节，耗时 ${seconds}s）`)
    const out = { path: target, files: [target], format: ext, tier, seconds }
    if (chunkInfo) out.chunks = { count: chunkInfo.count, parts: chunkInfo.parts, note: chunkInfo.note }
    // 缓存失败不抛：它是增强，不能让一次真实合成因为缓存盘不可写而失败。
    if (useCache) await writeNarrationCache({ key: cacheKey, out, outputDir: cfg.outputDir })
    return out
  }
}

/** 独立 TTS 工具。缺件时 execute 抛明确清单，工具本身始终注册。 */
export function makeSpeechTool(deps) {
  const run = makeSpeechRunner(deps)
  return {
    name: 'generate_speech',
    description: describeSpeechTool(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要合成的文字（必填）。' },
        instruct: { type: 'string', description: '音色/风格提示；仅命中 VoiceDesign 兜底链时生效，CustomVoice 链忽略。' },
        seed: { type: 'integer', description: '随机种子；不填为 0。' },
        reference_audio: {
          type: 'string',
          description: '参考音频的本地绝对路径（建议 3–30 秒干净人声，wav/mp3/flac/ogg/m4a）。'
            + '给了就走语音克隆、复刻该音色；不填用默认音色。文件会自动上传到 ComfyUI 的 input 目录。',
        },
        reference_text: {
          type: 'string',
          description: '参考音频对应的文字转写（可选）。留空时只提取说话人嵌入（x_vector_only），不需要转写也能克隆。',
        },
        backend: {
          type: 'string',
          description: '可选 TTS 后端：qwen3_tts（默认，插件内置链）| gpt_sovits_v5_dev（GPT-SoVITS v5 原版）'
            + ' | gpt_sovits_v5_turbo（蒸馏版）| indextts2。第三方节点需自行安装；'
            + '未在本机 /object_info 探测到对应节点时会抛明确清单，绝不静默回退到 Qwen3-TTS。'
            + '| gsv_cpp（★ 外接 GSV.CPP，本机 9880 服务在线时直调，不依赖 ComfyUI；'
            + 'GPT-SoVITS v5 契约：必须同时给参考音频 reference_audio 与其转写 reference_text，'
            + '缺一会 400；参考音频须在服务端 --allow-path 白名单目录内）。先用 list_tts_backends 看哪个可用。',
        },
        voice_sample: {
          type: 'string',
          description: '拖入的音频样本令牌（形如 sample:vs-xxx，由 /api/qwen-paint/audio/samples 登记后返回）。'
            + '与 reference_audio 二选一；这是零样本参考音色克隆，不训练、不微调、不产出权重文件。',
        },
        attention: {
          type: 'string',
          enum: ['auto', 'sage_attn', 'flash_attn', 'sdpa', 'eager'],
          description: 'Qwen3-TTS 注意力后端（真机 /object_info 合法值）。auto=节点默认、不改行为；'
            + 'sage_attn/flash_attn 多为 N 卡优化，sdpa/eager 通用。默认 auto；本插件未实测哪个更快，'
            + '换值前请自行 A/B 对比音质与耗时。',
        },
        lowLatencyChunks: {
          type: 'boolean',
          description: '低延迟分块（默认 false）：按语义把文本切段逐块合成再拼接，让每块更早取到；'
            + '不是流式播放。注意块间语气可能不连贯、整段总耗时可能增加、需本机有 ffmpeg。'
            + '默认整段一次性合成，行为零变化。',
        },
      },
      required: ['text'],
    },
    timeoutMs: Math.max(Number(deps.cfg?.timeoutMs ?? 0) || 0, 30 * 60 * 1000),
    output: {
      schema: SPEECH_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `已生成语音：${value?.path ?? ''}（${value?.format ?? ''}，用时 ${value?.seconds ?? 0}s）`,
      }],
      presentationMeta: (_args, value) => ({
        path: value?.path,
        files: Array.isArray(value?.files) ? value.files : [],
      }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const text = String(args?.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空')
      try {
        return await run({
          text,
          instruct: typeof args?.instruct === 'string' ? args.instruct : undefined,
          seed: Number.isFinite(args?.seed) ? Math.trunc(args.seed) : 0,
          prefix: 'qwen-paint/tts',
          stem: text,
          signal: exec?.signal,
          referenceAudio: typeof args?.reference_audio === 'string' ? args.reference_audio : '',
          referenceText: typeof args?.reference_text === 'string' ? args.reference_text : '',
          backend: typeof args?.backend === 'string' ? args.backend : '',
          voiceSample: typeof args?.voice_sample === 'string' ? args.voice_sample : '',
          attention: typeof args?.attention === 'string' ? args.attention : '',
          lowLatencyChunks: args?.lowLatencyChunks === true,
        })
      } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
      }
    },
  }
}
