#!/usr/bin/env node
/**
 * quality-wiring 接线回归（零 GPU / 零下载 / 零外部文件）。
 * 验证 qualityfix-* 的 sigma / 后处理 / 分段 CFG 真正落到 workflow 节点上，
 * 以及"非画质档零副作用、缺节点自动降级"的边界。
 */
import {
  qualityChainOverrides, attachQualityPostprocess, attachQualitySigma,
  SCHEDULED_CFG_NODE, SIGMAS_NODE, CUSTOM_SAMPLER_NODE,
} from '../lib/quality-pipeline.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) }
  else { fail += 1; console.log('  ✗ ' + msg) }
}

const highQuality = {
  ok: true, presetId: 'qualityfix-high', sigmaMode: 'optimized',
  segmentCfg: true, post: 'realistic', turbo8Enabled: false,
}
const fastQuality = {
  ok: true, presetId: 'qualityfix-fast', sigmaMode: 'official-turbo',
  segmentCfg: false, post: 'none', turbo8Enabled: true,
}

// ---- 1. 链路开关提升 ----
ok(qualityChainOverrides(highQuality).turbo8Enabled === false, 'high 档强制关 turbo8（走原生链）')
ok(qualityChainOverrides(fastQuality).turbo8Enabled === true, 'fast 档保持 turbo8 开')
ok(Object.keys(qualityChainOverrides(null)).length === 0, '非画质档不改链路')

// ---- 2. 后处理接线 ----
function sampleWf() {
  return {
    8: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 1, sampler_name: 'euler', positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0] } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'x' } },
    5: { class_type: 'TextEncodeQwenImage21', inputs: {} },
  }
}
{
  const wf = sampleWf()
  const r = attachQualityPostprocess(wf, highQuality, { decodeNode: '9', saveNode: '10' })
  ok(r.applied === true, 'high 档后处理已接')
  ok(wf['900']?.class_type === 'AdjustBrightness', '节点900 = AdjustBrightness')
  ok(wf['901']?.class_type === 'AdjustContrast', '节点901 = AdjustContrast')
  ok(wf['902']?.class_type === 'ImageSharpen', '节点902 = ImageSharpen')
  ok(wf['10'].inputs.images[0] === '902', 'SaveImage 改指后处理链尾 902')
  ok(wf['900'].inputs.images[0] === '9', '后处理链接原 decode 9')
}
{
  const wf = sampleWf()
  const r = attachQualityPostprocess(wf, fastQuality, { decodeNode: '9', saveNode: '10' })
  ok(r.applied === false && wf['900'] === undefined, 'fast 档（post=none）零后处理节点')
  ok(wf['10'].inputs.images[0] === '9', 'fast 档 SaveImage 仍指 9')
}
{
  const wf = sampleWf()
  const r = attachQualityPostprocess(wf, null, { decodeNode: '9', saveNode: '10' })
  ok(r.applied === false, '非画质档后处理零副作用')
}

// ---- 3. sigma + 分段 CFG 接线（节点齐全）----
const fullCaps = { nodes: { [SIGMAS_NODE]: true, [CUSTOM_SAMPLER_NODE]: true, [SCHEDULED_CFG_NODE]: true } }
{
  const wf = sampleWf()
  const r = attachQualitySigma(wf, highQuality, fullCaps, {
    samplerId: '8', steps: 20, cfg: 2.8,
  })
  ok(r.applied && r.sigmaApplied, 'high 档 sigma 接管已接（节点齐全）')
  ok(wf['910']?.class_type === 'ManualSigmas', '节点910 = ManualSigmas')
  ok(wf['910'].inputs.sigmas.split(',').length === 21, '优化 sigma 20 步 = 21 点')
  ok(wf['913']?.class_type === SCHEDULED_CFG_NODE, '节点913 = ScheduledCFGGuider（分段 CFG）')
  ok(r.segmentApplied === true, '分段 CFG 已生效')
  ok(wf['913'].inputs.from_cfg === 2.8 && wf['913'].inputs.to_cfg === 1, '分段 CFG from=2.8 → to=1')
  ok(wf['914']?.class_type === 'SamplerCustomAdvanced', '节点914 = SamplerCustomAdvanced')
  ok(wf['9'].inputs.samples[0] === '914', 'VAEDecode 改从 914 取样本')
  ok(wf['8']?.class_type === 'KSampler', '原 KSampler 节点保留（不破坏引用）')
}

// ---- 4. 降级：缺 Inspire-Pack → 固定 CFG ----
const noInspire = { nodes: { [SIGMAS_NODE]: true, [CUSTOM_SAMPLER_NODE]: true } }
{
  const wf = sampleWf()
  const r = attachQualitySigma(wf, highQuality, noInspire, {
    samplerId: '8', steps: 20, cfg: 2.8,
  })
  ok(r.applied && r.sigmaApplied, '缺 Inspire 时 sigma 仍生效')
  ok(r.segmentApplied === false, '缺 Inspire 时分段 CFG 不生效')
  ok(wf['913']?.class_type === 'CFGGuider', '降级为 CFGGuider 固定 CFG')
  ok(wf['913'].inputs.cfg === 2.8, '降级固定 CFG = 2.8')
  ok(/Inspire-Pack/.test(r.reason), '降级原因如实说明需装 Inspire-Pack')
}

// ---- 5. 降级：缺 ManualSigmas → 完全不动采样 ----
const noSigma = { nodes: {} }
{
  const wf = sampleWf()
  const r = attachQualitySigma(wf, highQuality, noSigma, {
    samplerId: '8', steps: 20, cfg: 2.8,
  })
  ok(r.applied === false && r.sigmaApplied === false, '缺 sigma 节点时完全不接管')
  ok(wf['910'] === undefined && wf['914'] === undefined, '不产生任何 sigma 节点')
  ok(wf['8'].class_type === 'KSampler' && wf['9'].inputs.samples[0] === '8', '采样链逐字不变')
}

// ---- 6. fast 档 / 非画质档 sigma 零副作用 ----
{
  const wf = sampleWf()
  const r = attachQualitySigma(wf, fastQuality, fullCaps, { samplerId: '8', steps: 8, cfg: 1 })
  ok(r.applied === false && wf['910'] === undefined, 'fast 档（官方 sigma）不接自定义 sigma 节点')
}
{
  const wf = sampleWf()
  const r = attachQualitySigma(wf, null, fullCaps, { samplerId: '8', steps: 20, cfg: 2.8 })
  ok(r.applied === false, '非画质档 sigma 零副作用')
}

// ---- 7. 注入咬合：改坏 buildWorkflow 的 decode 引用应被测试发现 ----
{
  const wf = sampleWf()
  wf['9'].inputs.samples = ['7', 0] // 故意改成非采样节点
  const r = attachQualitySigma(wf, highQuality, fullCaps, { samplerId: '8', steps: 20, cfg: 2.8 })
  ok(r.applied === true && wf['9'].inputs.samples[0] === '7', 'VAEDecode 非指采样节点时不被误改')
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败（test-quality-wiring.mjs）`)
if (fail > 0) process.exitCode = 1
