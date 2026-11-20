// 设计说明外置 → docs/quality-fix-presets-design-notes.md；预设→args 纯映射，非画质档零副作用。
import { applyQualityFixPreset } from './quality-fix-presets.js'
import { negativeFor, guardQualityPitfalls, buildStructuredPrompt, qualityChainOverrides } from './quality-pipeline.js'

const QUALITY_PREFIX = 'qualityfix-'
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function isQualityPreset(preset) {
  return String(preset ?? '').startsWith(QUALITY_PREFIX)
}

// 主层只覆盖 steps/cfg/negative；post/sigma/分段CFG 留 quality 由构图层消费。
export function applyQualityPresetToArgs(presetId, params) {
  const src = isObj(params) ? params : {}
  if (!isQualityPreset(presetId)) return { ...src, quality: null }

  const applied = applyQualityFixPreset(presetId, {
    steps: src.steps,
    cfg: src.cfg,
  })
  if (!applied.ok) return { ...src, quality: { ok: false, reason: applied.reason } }

  const s = applied.values
  // 护栏：T8 不得叠后处理/分段CFG/换sigma
  const guard = guardQualityPitfalls({
    turbo8: s.turbo8Enabled === true,
    post: s.post,
    segmentCfg: s.segmentCfg,
    sigmaMode: s.sigmaMode,
    cfg: s.cfg,
  })
  if (guard.length > 0) {
    return { ...src, quality: { ok: false, reason: guard.join('；') } }
  }

  // 负面词：显式优先，否则用预设档
  const neg = typeof src.negative === 'string' && src.negative.trim() !== ''
    ? src.negative
    : negativeFor(s.promptMode)

  // 结构化提示词仅显式要求才补，默认不改用户 prompt。
  const prompt = src.structuredPrompt === true
    ? buildStructuredPrompt(src.prompt, {})
    : src.prompt

  // 链路开关提升到顶层供 resolvePlan 读：high 档 turbo8Enabled=false 强制走原生链。
  const chain = qualityChainOverrides({
    ok: true,
    turbo8Enabled: s.turbo8Enabled,
  })

  return {
    ...src,
    ...chain,
    steps: Number(s.steps),
    cfg: Number(s.cfg),
    negative: neg,
    prompt,
    quality: {
      ok: true,
      presetId: applied.presetId,
      sampler: s.sampler,
      scheduler: s.scheduler,
      sigmaMode: s.sigmaMode,
      segmentCfg: s.segmentCfg,
      vaeTiling: s.vaeTiling,
      post: s.post,
      promptMode: s.promptMode,
      fixLora: s.fixLora,
      fixLoraStrength: s.fixLoraStrength,
    },
  }
}
