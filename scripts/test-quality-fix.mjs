#!/usr/bin/env node
/**
 * 画质修复预设 + catalog 的纯函数回归（不依赖 GPU、不下载、不读模型文件）。
 * 断言全部用纯 JS 表达，避免沙箱间歇禁止 spawn 导致整条测试瞎掉。
 */
import {
  QUALITY_FIX_PRESETS, FIX_LORA_FILE,
  getQualityFixPreset, applyQualityFixPreset, checkQualityFixPresets,
} from '../lib/quality-fix-presets.js'
import {
  QUALITY_FIX_FILES, listQualityFixFiles, findQualityFixFile,
  selfBringGuide, verifyAgainstAuthoritative,
} from './quality-fix-catalog.mjs'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) }
  else { fail += 1; console.log('  ✗ ' + msg) }
}

// ---- 1. 预设体检 ----
ok(checkQualityFixPresets().length === 0, '预设体检应零错误：' + JSON.stringify(checkQualityFixPresets()))

// ---- 2. 快速档参数 ----
const fast = getQualityFixPreset('qualityfix-fast')
ok(fast !== null, '快速档存在')
ok(fast && fast.set.steps === 8, '快速档 8 步')
ok(fast && fast.set.cfg === 1, '快速档 CFG=1')
ok(fast && Math.abs(fast.set.fixLoraStrength - 0.75) < 1e-9, '快速档 Fix LoRA 强度 0.75')
ok(fast && fast.set.turbo8Enabled === true, '快速档挂 turbo8')
ok(fast && fast.set.fixLora === FIX_LORA_FILE, '快速档 Fix LoRA 文件一致')

// ---- 3. 高质量档参数 ----
const high = getQualityFixPreset('qualityfix-high')
ok(high !== null, '高质量档存在')
ok(high && high.set.steps === 20, '高质量档 20 步')
ok(high && high.set.cfg === 2.8, '高质量档 CFG=2.8（预设A 新方案）')
ok(high && high.set.fixLoraStrength === 1.0, '高质量档 Fix LoRA 强度 1.0')
ok(high && high.set.turbo8Enabled === false, '高质量档原生链（不挂 turbo8）')

// ---- 4. 两档共用同一基础模型与 Fix LoRA ----
ok(fast && high && fast.set.fixLora === high.set.fixLora, '两档共用同一 Fix LoRA 文件')

// ---- 5. 套用预设：只覆盖声明键，保留其余 ----
const applied = applyQualityFixPreset('qualityfix-high', { steps: 99, seed: 42, prompt: 'x' })
ok(applied.ok, '套用高质量档成功')
ok(applied.values.seed === 42 && applied.values.prompt === 'x', '未声明的键原样保留')
ok(applied.values.steps === 20, 'steps 被预设覆盖为 20')
ok(applied.values.cfg === 2.8, 'cfg 被预设覆盖为 2.8')

// ---- 6. 蒸馏链 CFG 硬钳制 ----
const clamped = applyQualityFixPreset('qualityfix-fast', { cfg: 5 })
ok(clamped.values.cfg === 1, '快速档即使传入 cfg=5 也钳回 1')

// ---- 7. 未知预设拒绝 ----
const bad = applyQualityFixPreset('no-such-preset', {})
ok(!bad.ok && /没有这个/.test(bad.reason), '未知预设明确拒绝')

// ---- 8. getQualityFixPreset 返回拷贝，改脏不污染常量 ----
const copy = getQualityFixPreset('qualityfix-high')
copy.set.steps = 999
ok(getQualityFixPreset('qualityfix-high').set.steps === 20, '预设常量不被调用方改脏')

// ---- 9. catalog 权威值 ----
ok(listQualityFixFiles().length === QUALITY_FIX_FILES.length, '清单长度一致')
const main = findQualityFixFile('fix-lora')
ok(main !== null && main.sha256 === 'e4a369158b957aee3a8316d94dbe00c98f7d648ef3d1926ccf7283915b6db60c', '主 Fix LoRA 权威 sha256 正确')
ok(main && main.size === 111612000, '主 Fix LoRA 权威 size 正确')
ok(main && main.usedBy.includes('qualityfix-fast') && main.usedBy.includes('qualityfix-high'), '主 Fix LoRA 登记被两档引用')

// ---- 10. 校验函数正反例 ----
ok(verifyAgainstAuthoritative('fix-lora', { size: 111612000, sha256: main.sha256 }).ok, '权威值一致时校验通过')
ok(!verifyAgainstAuthoritative('fix-lora', { size: 111612000, sha256: 'bad' }).ok, 'sha256 不符时判失败')
ok(!verifyAgainstAuthoritative('fix-lora', { size: 1, sha256: main.sha256 }).ok, 'size 不符时判失败')
ok(!verifyAgainstAuthoritative('nope', { size: 1, sha256: 'x' }).ok, '未知 id 拒绝')
ok(verifyAgainstAuthoritative('fix-lora', { size: 111612000, sha256: main.sha256.toUpperCase() }).ok, 'sha256 大小写不敏感')

// ---- 11. 自备指引不编造 URL ----
const g = selfBringGuide('fix-lora')
ok(g.ok && Array.isArray(g.pages) && g.pages.length > 0, '自备指引给出检索入口')
ok(g.pages.every((u) => u.startsWith('https://')), '检索入口都是 https 页面')
ok(/不编造/.test(g.reason), '自备指引明确声明不编造下载 URL')

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
