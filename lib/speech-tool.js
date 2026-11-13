/**
 * lib/speech-tool.js —— 独立语音工具 + 混合模式共用的 TTS 段（B3 剩余项）。
 *
 * ## 为什么抽出来
 *   以前 TTS 只能绑死在 `generate_hybrid` 的「图 → 音 → 视频」三段里，
 *   只想配个音也得跑完三段。现在：
 *     · `generate_speech` 是独立工具（复用同一套声明式兜底链与保存节点）；
 *     · `generate_hybrid` 的 TTS 段改为调用**同一个** `runSpeechStage`，消除两份实现。
 *
 * ## 设计
 *   · 所有 I/O（探活 / 提交 / 取字节 / 落盘辅助）由 `deps` 注入：
 *     纯编排层，离线可注入假依赖做行为级断言，不联网、不 spawn。
 *   · 能力探测只看 /object_info 的**真实节点类名**（见 tts-workflow.js 的事故复盘）；
 *     缺件抛 `ttsMissingReport` 清单，绝不假装能出音频、绝不自动下载权重。
 *   · 落盘扩展名取 ComfyUI 返回的真实 `filename`，不写死 .wav。
 *   · 不为验证生成任何媒体：测试注入假 deps，零真实 fetch / 零真实 ComfyUI。
 */
import fsp from 'node:fs/promises'
import { probeTts, buildTtsWorkflow } from './tts-workflow.js'
import { makeDeclaredOutputSchema } from './tool-contracts.js'
import { describeSpeechTool } from './tool-descriptions.js'

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
export function makeSpeechRunner(deps) {
  const {
    cfg, log, ensureComfyUp, loadObjectInfoFor, catalogForTts,
    submitPrompt, fetchOutputBytes, fetchWithTimeout, cancelReason,
    safeStem, uniquePath,
  } = deps

  /** SaveAudio* 产物在 `outputs[*].audio`（不复用 waitForResult 的 images 通道）。 */
  async function waitForAudio(promptId, { signal, timeoutMs }) {
    const started = Date.now()
    for (;;) {
      if (signal?.aborted) throw cancelReason(signal)
      if (Date.now() - started > timeoutMs) throw new Error('等 TTS 出音频超时')
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

  return async function runSpeechStage({
    text, instruct, seed = 0, prefix = 'qwen-paint/tts', stem = 'speech',
    signal, caps,
  } = {}) {
    const t0 = Date.now()
    await ensureComfyUp(cfg, log, signal)
    // 复用调用方已经取过的 /object_info（混合模式三段共用一份，避免重复拉取）
    const ttsCaps = caps ?? catalogForTts(await loadObjectInfoFor(cfg, signal))
    const probe = probeTts(ttsCaps)
    if (!probe.available) throw new Error(probe.reason)
    log?.('info', `语音后端：${probe.label}（${probe.tier}）`)

    const body = String(text ?? '').trim()
    if (body === '') throw new Error('TTS 段：text 不能为空')
    const built = buildTtsWorkflow(ttsCaps, {
      text: body, instruct, durationSec: 3, seed, prefix,
    })
    const pid = await submitPrompt(cfg, built.payload, signal)
    const audio = await waitForAudio(pid, { signal, timeoutMs: 10 * 60 * 1000 })
    const first = audio[0]
    const bytes = await fetchOutputBytes(cfg, first, signal)
    await fsp.mkdir(cfg.outputDir, { recursive: true })
    const ext = /\.([a-z0-9]{2,5})$/iu.exec(String(first?.filename ?? ''))?.[1]?.toLowerCase() ?? 'mp3'
    const target = await uniquePath(cfg.outputDir, `${safeStem(stem, 22)}_${cfg.filePrefix}_tts.${ext}`)
    await fsp.writeFile(target, bytes)
    // ⚠ 不叫 seconds 之外的名字会踩 selftest 的串行循环锚点；这里保持 seconds 语义一致
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
    log?.('info', `语音段落盘 ${target}（${bytes.length} 字节，耗时 ${seconds}s）`)
    return { path: target, files: [target], format: ext, tier: probe.tier, seconds }
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
        })
      } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
      }
    },
  }
}
