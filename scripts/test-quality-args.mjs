#!/usr/bin/env node
/** quality-args 纯函数回归：预设→出图参数映射，零 I/O。 */
import { isQualityPreset, applyQualityPresetToArgs } from '../lib/quality-args.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) }
  else { fail += 1; console.log('  ✗ ' + msg) }
}

ok(isQualityPreset('qualityfix-fast') && isQualityPreset('qualityfix-high'), '画质预设 id 识别')
ok(!isQualityPreset('portrait') && !isQualityPreset('default'), '普通预设不误判')
ok(!isQualityPreset(null) && !isQualityPreset(''), '空值安全')

// 非画质预设：逐字返回
const plain = applyQualityPresetToArgs('portrait', { steps: 8, cfg: 1, negative: 'x' })
ok(plain.steps === 8 && plain.cfg === 1 && plain.negative === 'x', '非画质预设参数不变')
ok(plain.quality === null, '非画质预设无 quality 字段')

// 高质量档覆盖 steps/cfg/negative
const high = applyQualityPresetToArgs('qualityfix-high', { steps: 99, cfg: 9, negative: '', prompt: 'a fox' })
ok(high.quality.ok === true, '高质量档应用成功')
ok(high.steps === 20 && high.cfg === 2.8, '高质量档覆盖 steps=20/cfg=2.8')
ok(high.negative.includes('deformed'), '高质量档自动补负面词')
ok(high.prompt === 'a fox', '默认不改用户 prompt（无副作用）')
ok(high.quality.post === 'realistic' && high.quality.sigmaMode === 'optimized', 'quality 元数据带出后处理/sigma 档')

// 显式 negative 优先
const explicitNeg = applyQualityPresetToArgs('qualityfix-high', { negative: 'my own neg' })
ok(explicitNeg.negative === 'my own neg', '用户显式负面词不被预设覆盖')

// 快速档：CFG 锁 1、负面精简、不叠后处理
const fast = applyQualityPresetToArgs('qualityfix-fast', { cfg: 5 })
ok(fast.cfg === 1, '快速档 CFG 强制锁 1')
ok(fast.quality.post === 'none', '快速档后处理 none')
ok(fast.quality.sampler === 'euler', '快速档采样器 euler')
ok(fast.negative === 'blurry, low quality, watermark', '快速档负面词精简版')

// 结构化提示词：显式开启才补词
const spOn = applyQualityPresetToArgs('qualityfix-high', { prompt: 'a fox', structuredPrompt: true })
ok(spOn.prompt.includes('rim light'), '显式开启结构化提示词才补光照词')

// 未知画质预设
const bad = applyQualityPresetToArgs('qualityfix-nope', { steps: 8 })
ok(bad.quality.ok === false && /没有这个/.test(bad.quality.reason), '未知画质预设如实报错')
ok(bad.steps === 8, '失败时原参数不变')

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
