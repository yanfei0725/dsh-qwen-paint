// 设计说明外置 → docs/quality-pipeline-design-notes.md / quality-wiring-design-notes.md
import { OFFICIAL_TURBO_SIGMAS_8 } from './turbo-workflow.js'

export const SCHEDULED_CFG_NODE = 'ScheduledCFGGuider //Inspire' // 缺则降级固定 CFG
export const SIGMAS_NODE = 'ManualSigmas'
export const CUSTOM_SAMPLER_NODE = 'SamplerCustomAdvanced'

// 原版 2.1 优化 sigma（20步基准表，末值 0；绝不用于 T8 蒸馏）。
export const OPTIMIZED_SIGMAS_20 = [
  '1.0', '0.989', '0.976', '0.961', '0.943', '0.921', '0.894', '0.862',
  '0.823', '0.776', '0.720', '0.654', '0.576', '0.487', '0.386', '0.276',
  '0.171', '0.088', '0.033', '0.008', '0',
].join(', ')

export function sigmaFor(mode, { steps = 20, turbo8 = false } = {}) {
  if (turbo8 || mode === 'official-turbo') return OFFICIAL_TURBO_SIGMAS_8
  if (mode === 'optimized') {
    if (Math.trunc(Number(steps) || 20) === 20) return OPTIMIZED_SIGMAS_20
    const src = OPTIMIZED_SIGMAS_20.split(',').map((s) => Number(s.trim()))
    return resampleSigmas(src, steps).join(', ')
  }
  return ''
}

export function resampleSigmas(src, steps) {
  const n = Math.max(1, Math.trunc(Number(steps) || 1)) + 1
  if (src.length === n) return [...src]
  const out = []
  for (let i = 0; i < n; i += 1) {
    const pos = (i / (n - 1)) * (src.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(src.length - 1, lo + 1)
    const f = pos - lo
    out.push(src[lo] * (1 - f) + src[hi] * f)
  }
  out[n - 1] = 0
  return out.map((x) => Number(Math.max(0, Math.min(1, x)).toFixed(6)))
}

// 分段 CFG：前段高 CFG、后半段降到 1；长度 = steps。T8（base≤1）恒返回全 1。
export function segmentCfg(baseCfg, steps, enabled) {
  const n = Math.max(1, Math.trunc(Number(steps) || 1))
  const top0 = Number(baseCfg) || 1
  if (!enabled || top0 <= 1) return new Array(n).fill(top0 <= 1 ? 1 : top0)
  const top = Math.max(1.01, top0)
  const out = []
  for (let i = 0; i < n; i += 1) {
    const t = i / Math.max(1, n - 1)
    const k = t <= 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45)
    out.push(Number((1 + (top - 1) * k).toFixed(3)))
  }
  return out
}

// 后处理链：解码→抬暗→弱对比→USM；字段按 object_info 契约；人像不锐化，none 零节点。
export function buildPostprocessNodes(imageRef, mode, idBase = 900) {
  const chain = []
  let ref = imageRef
  const add = (id, type, inputs) => { chain.push({ id, class_type: type, inputs }); ref = [String(id), 0] }
  if (mode === 'realistic' || mode === 'portrait') {
    const isPortrait = mode === 'portrait'
    add(idBase, 'AdjustBrightness', { images: ref, factor: isPortrait ? 1.03 : 1.05 })
    add(idBase + 1, 'AdjustContrast', { images: ref, factor: isPortrait ? 1.06 : 1.10 })
    if (!isPortrait) add(idBase + 2, 'ImageSharpen', { image: ref, sharpen_radius: 2, sigma: 1.0, alpha: 0.35 })
  }
  return { nodes: chain, tail: ref, changed: chain.length > 0 }
}

// 结构化提示词：主体 + 光照/材质/镜头/色彩 5 维补词（Qwen 对光照词敏感）。
export function buildStructuredPrompt(subject, { lighting = true, material = true, lens = true, color = true } = {}) {
  const s = String(subject ?? '').trim()
  if (s === '') return ''
  const parts = [s]
  if (lighting) parts.push('soft rim light, subsurface scattering')
  if (material) parts.push('physically based rendering, fine surface detail')
  if (lens) parts.push('cinematic composition, shallow depth of field')
  if (color) parts.push('natural color grading')
  return parts.join(', ')
}

// 两套负面词：T8 精简（太长拖累蒸馏），高质量完整。
export const NEGATIVE_PRESETS = {
  preview: 'blurry, low quality, watermark',
  quality: 'blurry, low resolution, watermark, deformed, disfigured, oversaturated, washed out, gray, muddy',
}
export function negativeFor(mode) { return NEGATIVE_PRESETS[mode] ?? NEGATIVE_PRESETS.preview }

// 避开坑护栏：超分不得默认开、T8 不得叠后处理/分段CFG/换sigma/改CFG。
export function guardQualityPitfalls({ turbo8 = false, post = 'none', segmentCfg: seg = false,
  sigmaMode = 'official-turbo', cfg = 1, upscaleDefault = false } = {}) {
  const errors = []
  if (upscaleDefault) errors.push('RealESRGAN/超分不得默认开启：它是放大不是原生画质提升，会捏造细节破坏构图与文字；只能用户手动触发')
  if (turbo8 && post !== 'none') errors.push(`T8 预览档不得叠加后处理（收到 post=${post}）：蒸馏信息上限低，后处理易失真`)
  if (turbo8 && seg) errors.push('T8 不得用分段 CFG：蒸馏时 CFG=1，改了崩构图文字')
  if (turbo8 && sigmaMode !== 'official-turbo') errors.push('T8 不得换 sigma：绑定官方 Turbo sigma，换了翻车')
  if (turbo8 && Number(cfg) !== 1) errors.push('T8 的 CFG 必须为 1')
  return errors
}

export function checkNodeNames(availableNodeNames) {
  const need = ['AdjustBrightness', 'AdjustContrast', 'ImageSharpen']
  const have = new Set(Array.isArray(availableNodeNames) ? availableNodeNames : [])
  return need.filter((n) => !have.has(n)).map((n) => `缺少真实节点：${n}`)
}

/* ===== 2026-11-21 接线层：把上面的配方真正落到 workflow 节点（原 quality-wiring.js 合并进来） ===== */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasNode = (caps, name) => !!(caps?.nodes && (caps.nodes[name] === true || caps.nodes[name] === name))

// high 档须关 turbo/turbo8，否则走蒸馏链吞掉 20步/CFG2.8。
export function qualityChainOverrides(quality) {
  if (!isObj(quality) || quality.ok !== true) return {}
  const out = {}
  if (quality.turbo8Enabled === false) out.turbo8Enabled = false
  if (quality.turbo8Enabled === true) out.turbo8Enabled = true
  return out
}

// 接后处理：decode 与 save 之间插真实节点，save.images 改指链尾。
export function attachQualityPostprocess(workflow, quality, { decodeNode, saveNode }) {
  const noop = { applied: false, reason: '', tail: String(decodeNode) }
  if (!isObj(quality) || quality.ok !== true) return noop
  const mode = String(quality.post ?? 'none')
  if (mode === 'none') return noop
  if (!isObj(workflow?.[String(decodeNode)]) || !isObj(workflow?.[String(saveNode)])) {
    return { ...noop, reason: `后处理跳过：decode=${decodeNode}/save=${saveNode} 节点不存在` }
  }
  const built = buildPostprocessNodes([String(decodeNode), 0], mode, 900)
  if (!built.changed) return noop
  for (const n of built.nodes) workflow[String(n.id)] = { class_type: n.class_type, inputs: n.inputs }
  workflow[String(saveNode)].inputs.images = built.tail
  return { applied: true, reason: `后处理=${mode} 已接（${built.nodes.map((n) => n.class_type).join('→')}）`, tail: built.tail }
}

// 原生链 sigma/分段 CFG：KSampler → ManualSigmas+SamplerCustomAdvanced；缺 Inspire 降级固定 CFG。就地改。
export function attachQualitySigma(workflow, quality, caps, ctx) {
  const result = { applied: false, reason: '', sigmaApplied: false, segmentApplied: false, samplerNode: String(ctx?.samplerId ?? '8') }
  if (!isObj(quality) || quality.ok !== true) return result
  const wantSigma = quality.sigmaMode === 'optimized'
  const wantSegment = quality.segmentCfg === true
  if (!wantSigma && !wantSegment) return result
  const sid = String(ctx?.samplerId ?? '8')
  const ksampler = workflow?.[sid]
  if (!isObj(ksampler) || ksampler.class_type !== 'KSampler') {
    result.reason = 'sigma 接管跳过：采样节点不是 KSampler（可能已走 turbo 链）'
    return result
  }
  const canSigma = hasNode(caps, SIGMAS_NODE) && hasNode(caps, CUSTOM_SAMPLER_NODE)
  if (!canSigma) {
    result.reason = 'sigma 接管跳过：本机缺 ManualSigmas/SamplerCustomAdvanced，维持默认采样'
    return result
  }
  const steps = ctx.steps
  const baseCfg = ctx.cfg
  const sigmaStr = sigmaFor(quality.sigmaMode, { steps, turbo8: false })
  const canSegment = wantSegment && hasNode(caps, SCHEDULED_CFG_NODE)
  workflow['910'] = { class_type: 'ManualSigmas', inputs: { sigmas: sigmaStr } }
  workflow['911'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: ksampler.inputs.sampler_name || 'euler' } }
  workflow['912'] = { class_type: 'RandomNoise', inputs: { noise_seed: ksampler.inputs.seed ?? 0 } }
  if (canSegment) {
    const cfgTable = segmentCfg(baseCfg, steps, true)
    workflow['913'] = {
      class_type: SCHEDULED_CFG_NODE,
      inputs: {
        model: ksampler.inputs.model, positive: ksampler.inputs.positive, negative: ksampler.inputs.negative,
        sigmas: ['910', 0], from_cfg: cfgTable[0], to_cfg: cfgTable[cfgTable.length - 1], schedule: 'linear',
      },
    }
    result.segmentApplied = true
  } else {
    workflow['913'] = {
      class_type: 'CFGGuider',
      inputs: { model: ksampler.inputs.model, positive: ksampler.inputs.positive, negative: ksampler.inputs.negative, cfg: baseCfg },
    }
    result.reason = '分段 CFG 降级为固定 CFG：本机未装 Inspire-Pack（ScheduledCFGGuider 不可用）'
  }
  workflow['914'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['912', 0], guider: ['913', 0], sampler: ['911', 0], sigmas: ['910', 0],
      latent_image: ksampler.inputs.latent_image,
    },
  }
  // VAEDecode 采样引用 '8'→'914'。
  for (const id of ['9']) {
    if (isObj(workflow?.[id]) && Array.isArray(workflow[id].inputs?.samples) && workflow[id].inputs.samples[0] === sid) {
      workflow[id].inputs.samples = ['914', 0]
    }
  }
  result.applied = true
  result.sigmaApplied = true
  result.samplerNode = '914'
  return result
}
