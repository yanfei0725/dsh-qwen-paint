/**
 * lib/hybrid-runner.js —— 报告 v3 §3/§10：混合模式三段依赖链编排。
 *
 * image → tts → video，段间**显式卸载模型**（20 GB 只放得下一套，报告 §10 G 决策树①）。
 * TTS 段产物是音频文件（本机 SaveAudioMP3 → mp3 / SaveAudio → flac），不是固定 wav。
 * 每段一个 jobId；后段消费前段产物（图作视频首帧、音频作音轨）。
 * 进度权重 20% / 10% / 70%（报告 §9）。
 *
 * 纯编排器：submitStage / unload 由调用方注入，离线可测，不直接碰 ComfyUI。
 * cancel 走 signal；任何一段抛错都**不吞**，明确上抛并带上段名。
 */
import { ChunkPass, parseWorkflow } from './workflow-ast.js'

export const HYBRID_STAGES = [
  { id: 'image', label: '生图', weight: 0.2, deliver: 'png' },
  { id: 'tts', label: '配音', weight: 0.1, deliver: 'audio' },
  { id: 'video', label: '视频', weight: 0.7, deliver: 'mp4' },
]

/** 权重累计边界，供进度条换算（0.2 / 0.3 / 1.0）。 */
export function stageProgress(stageIndex, stageFraction = 0) {
  let base = 0
  // 越界 stageIndex 不能读到 undefined.weight（进度回调可能拿任意下标来问）
  for (let i = 0; i < stageIndex && i < HYBRID_STAGES.length; i += 1) base += HYBRID_STAGES[i].weight
  const stage = HYBRID_STAGES[stageIndex]
  return Math.min(1, base + (stage ? stage.weight : 0) * Math.max(0, Math.min(1, stageFraction)))
}

/** 长片段分块计划（与 workflow-ast.ChunkPass 同一算法，避免两处判据漂移）。 */
export function planChunks({ frames, framesPerChunk = 49, overlap = 8 } = {}) {
  const ast = parseWorkflow({ 1: { class_type: 'Wan22ImageToVideoLatent', inputs: { length: frames } } })
  const { ast: out } = ChunkPass(ast, { frames, framesPerChunk, overlap })
  return out.meta?.chunkPlan ?? null
}

/**
 * 跑完三段。
 * @param opts.stages      默认 HYBRID_STAGES，可注入自定义段（测试用）
 * @param opts.submitStage (stage, ctx) => Promise<result>，ctx 带前段产物与 chunkPlan
 * @param opts.unload      (stageId) => Promise<void>，段间卸模型，失败只记不抛（不影响下一段）
 * @param opts.onProgress  (percent, note) => void
 * @param opts.signal      AbortSignal
 */
export async function runHybrid(opts = {}) {
  const stages = opts.stages ?? HYBRID_STAGES
  const submitStage = opts.submitStage
  const unload = opts.unload ?? (async () => {})
  const onProgress = opts.onProgress ?? (() => {})
  if (typeof submitStage !== 'function') throw new Error('混合模式缺少 submitStage')

  const outputs = {}
  const chunkPlan = planChunks(opts)
  const results = []
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i]
    if (opts.signal?.aborted) throw new Error('混合模式已取消')
    onProgress(stageProgress(i, 0), `开始${stage.label}段`)
    let value
    try {
      value = await submitStage(stage, { outputs, chunkPlan, stageIndex: i, signal: opts.signal })
    } catch (error) {
      throw new Error(`混合模式 ${stage.label}段失败：${error?.message ?? error}`)
    }
    outputs[stage.id] = value
    results.push({ stage: stage.id, value })
    onProgress(stageProgress(i, 1), `${stage.label}段完成`)
    // ★ 段间显式卸载：20 GB 装不下两套模型（报告 §10）。最后一段不必卸。
    if (i < stages.length - 1) {
      try { await unload(stage.id) } catch (error) {
        onProgress(stageProgress(i, 1), `${stage.label}段后卸载未生效（继续）：${error?.message ?? error}`)
      }
    }
  }
  return { ok: true, outputs, results, chunkPlan }
}
