#!/usr/bin/env node
/**
 * quality-pipeline 纯函数回归（零 GPU / 零下载 / 零外部文件）。
 * 断言全部纯 JS，避免沙箱禁止 spawn 导致整条瞎掉。
 */
import {
  OPTIMIZED_SIGMAS_20, sigmaFor, resampleSigmas, segmentCfg,
  buildPostprocessNodes, buildStructuredPrompt, NEGATIVE_PRESETS, negativeFor,
  guardQualityPitfalls, checkNodeNames,
} from '../lib/quality-pipeline.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) }
  else { fail += 1; console.log('  ✗ ' + msg) }
}

// ---- 1. sigma ----
const sig20 = OPTIMIZED_SIGMAS_20.split(',').map((s) => Number(s.trim()))
ok(sig20.length === 21, '优化表 20 步 = 21 个 sigma 点')
ok(sig20[0] === 1 && sig20[sig20.length - 1] === 0, 'sigma 表首尾为 1 → 0')
ok(sig20.every((x, i) => i === 0 || x <= sig20[i - 1]), 'sigma 单调不增')
ok(sigmaFor('official-turbo', { turbo8: true }) !== '', 'T8 恒返回官方 sigma')
ok(sigmaFor('optimized', { steps: 20 }) === OPTIMIZED_SIGMAS_20, 'optimized/20 步返回原表')
const s10 = resampleSigmas(sig20, 10)
ok(s10.length === 11 && s10[10] === 0, '重采样 10 步 = 11 点且末值 0')
ok(s10.every((x, i) => i === 0 || x <= s10[i - 1]), '重采样后仍单调')

// ---- 2. 分段 CFG ----
const flat = segmentCfg(2.8, 20, false)
ok(flat.length === 20 && flat.every((x) => x === 2.8), '关闭分段 CFG → 全程 2.8')
const seg = segmentCfg(2.8, 20, true)
ok(seg.length === 20, '分段 CFG 长度 = steps')
ok(seg[0] === 2.8 && seg[seg.length - 1] === 1, '分段 CFG 起点=2.8 终点=1')
ok(seg.every((x, i) => i === 0 || x <= seg[i - 1]), '分段 CFG 单调不增')
ok(segmentCfg(1, 8, true).every((x) => x === 1), 'CFG=1 时分段无意义（恒 1）')

// ---- 3. 后处理节点 ----
const none = buildPostprocessNodes(['9', 0], 'none')
ok(none.nodes.length === 0 && !none.changed, 'none 档零节点（T8 预览）')
const real = buildPostprocessNodes(['9', 0], 'realistic')
ok(real.nodes.length === 3, '写实档 3 节点（亮度/对比/锐化）')
ok(real.nodes[0].class_type === 'AdjustBrightness' && 'images' in real.nodes[0].inputs, 'AdjustBrightness 用 images 字段')
ok(real.nodes[1].class_type === 'AdjustContrast' && real.nodes[1].inputs.factor > 1, 'AdjustContrast factor>1 弱对比')
ok(real.nodes[2].class_type === 'ImageSharpen' && 'image' in real.nodes[2].inputs, 'ImageSharpen 用 image 字段')
ok(real.nodes[2].inputs.alpha === 0.35, 'USM 弱强度 alpha=0.35')
const port = buildPostprocessNodes(['9', 0], 'portrait')
ok(port.nodes.length === 2, '人像档 2 节点（无锐化，防毛边）')
ok(port.nodes[0].inputs.factor < real.nodes[0].inputs.factor, '人像抬暗更轻（防噪点）')
// 串联正确性：后一节点的输入引用前一节点
ok(real.nodes[1].inputs.images[0] === String(real.nodes[0].id), '对比节点接在亮度节点之后')
ok(real.nodes[2].inputs.image[0] === String(real.nodes[1].id), '锐化节点接在对比节点之后')

// ---- 4. 提示词 ----
ok(buildStructuredPrompt('a fox') === '' || buildStructuredPrompt('a fox').includes('a fox'), '结构化提示词含主体')
const sp = buildStructuredPrompt('a fox')
ok(sp.includes('rim light') && sp.includes('physically based') && sp.includes('cinematic'), '含光照/材质/镜头词')
ok(buildStructuredPrompt('  ') === '', '空主体返回空串')
ok(!buildStructuredPrompt('a fox', { lighting: false }).includes('rim light'), '可关闭光照词')
ok(NEGATIVE_PRESETS.preview.length < NEGATIVE_PRESETS.quality.length, 'T8 负面词更短')
ok(negativeFor('quality').includes('deformed'), '高质量负面含畸形')
ok(negativeFor('unknown') === NEGATIVE_PRESETS.preview, '未知档回落精简负面')

// ---- 5. 护栏 ----
ok(guardQualityPitfalls({}).length === 0, '默认安全')
ok(guardQualityPitfalls({ upscaleDefault: true }).length > 0, '拒绝超分默认开')
ok(guardQualityPitfalls({ turbo8: true, post: 'realistic' }).length > 0, '拒绝 T8 叠后处理')
ok(guardQualityPitfalls({ turbo8: true, segmentCfg: true }).length > 0, '拒绝 T8 分段 CFG')
ok(guardQualityPitfalls({ turbo8: true, sigmaMode: 'optimized' }).length > 0, '拒绝 T8 换 sigma')
ok(guardQualityPitfalls({ turbo8: true, cfg: 3 }).length > 0, '拒绝 T8 改 CFG')
ok(guardQualityPitfalls({ post: 'realistic', segmentCfg: true, sigmaMode: 'optimized', cfg: 2.8 }).length === 0,
  '原版2.1 用后处理/分段/优化sigma/CFG2.8 合法')

// ---- 6. 节点真实性 ----
ok(checkNodeNames(['AdjustBrightness', 'AdjustContrast', 'ImageSharpen']).length === 0, '三节点齐全时零错误')
ok(checkNodeNames(['AdjustBrightness']).length === 2, '缺节点如实报出')
ok(checkNodeNames([]).length === 3, '全缺时报三项')

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
