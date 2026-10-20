/**
 * 三厂商自适应 + 生图链路自适应 —— 自测（**不联网**，纯函数断言）
 *
 * 用法：node scripts/_adapt_test.mjs
 *
 * 覆盖两件事：
 *   ① GPU 厂商/代系识别（A/N/I 卡 + RDNA2/3/4 + Arc A/B 系 + 混装核显独显）
 *   ② buildWorkflow 在探测到不同能力时的链路裁剪（full/turbo/basic、缺件跳过、连通性）
 */

import { __internal as I } from '../lib/index.js'

const cfg = { ...I.DEFAULTS }
let fail = 0

function vendorOf(name) {
  let best = null
  let bestScore = 0
  for (const rule of I.VENDOR_RULES) {
    if (rule.score > bestScore && rule.re.test(name)) { best = rule.id; bestScore = rule.score }
  }
  return best ?? 'unknown'
}

console.log('=== 1. GPU 厂商 / 代系识别 ===')
const cases = [
  ['cuda:0 AMD Radeon RX 7900 XT : native', 'amd_rdna3'],
  ['AMD Radeon RX 7900 XTX', 'amd_rdna3'],
  ['AMD Radeon RX 7800 XT', 'amd_rdna3'],
  ['AMD Radeon RX 9070 XT', 'amd_rdna4'],
  ['Radeon RX 9060 XT', 'amd_rdna4'],
  ['AMD Radeon RX 6800 XT', 'amd_rdna2'],
  ['Radeon RX 6700 XT', 'amd_rdna2'],
  ['NVIDIA GeForce RTX 4090', 'nvidia'],
  ['NVIDIA GeForce RTX 3060', 'nvidia'],
  ['NVIDIA RTX A4000', 'nvidia'],
  ['Intel Arc A770', 'intel_alchemist'],
  ['Intel(R) Arc(TM) A770 Graphics', 'intel_alchemist'],
  ['Intel(R) Arc(TM) B580 Graphics', 'intel_battlemage'],
  ['Intel Arc B570', 'intel_battlemage'],
  // 核显 + 独显混装：打分制必须选中独显
  ['AMD Radeon Graphics | NVIDIA GeForce RTX 4090', 'nvidia'],
  ['Intel UHD Graphics | NVIDIA GeForce RTX 3080', 'nvidia'],
  ['AMD Radeon(TM) Graphics', 'amd'],
  // ★ 2026-10-11：macOS 适配后 Apple Silicon 不再落到 unknown（有专属档案 apple）
  ['Apple M2', 'apple'],
  ['Apple M3 Pro', 'apple'],
  // 混装：Apple 的分数**低于**独显明确型号 ⇒ 必须按真正在算图的那张卡处理
  ['Radeon RX 7900 XTX | Apple M3', 'amd_rdna3'],
  ['', 'unknown'],
]
for (const [name, want] of cases) {
  const got = vendorOf(name)
  const profile = I.GPU_PROFILES[got] ?? I.GPU_PROFILES.unknown
  const ok = got === want
  if (!ok) fail += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${String(name || '(空)').padEnd(48)} → ${got.padEnd(11)} ${JSON.stringify(profile.args)}`)
}

console.log('\n=== 2. 生图链路自适应 ===')
function verifyLinks(workflow) {
  const errs = []
  for (const [id, node] of Object.entries(workflow)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && !workflow[value[0]]) {
        errs.push(`${id}.${key} → 缺失节点 ${value[0]}`)
      }
    }
  }
  return errs
}
function show(tag, workflow) {
  const ks = workflow[8].inputs
  const errs = verifyLinks(workflow)
  const chain = Object.keys(workflow).map(Number).sort((a, b) => a - b)
    .map((i) => `${i}:${workflow[i].class_type}`).join(' → ')
  console.log(`\n  [${tag}]\n    链: ${chain}`)
  console.log(`    steps=${ks.steps} cfg=${ks.cfg} 末端model=${JSON.stringify(ks.model)}`)
  console.log(`    连通性: ${errs.length === 0 ? 'OK' : 'FAIL ' + errs.join('; ')}`)
  if (errs.length > 0) fail += 1
  return workflow
}
const nodes = (over) => ({ prefixCache: true, teSpeed: true, speedup: true, loraOnly: true, ...over })
const models = {
  unet: 'qwen_image_2.1_int8.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  turbo8Lora: 'turbo8_lora_step2500.safetensors',
}
const args = { prompt: 'a cat', width: 1024, height: 1024, steps: 25, seed: 1 }

const wfDefault = show('不传 caps（= 能力齐全，保持默认全栈）', I.buildWorkflow(cfg, args))
const wfFull = show('full 档', I.buildWorkflow(cfg, args, { level: 'full', nodes: nodes(), models }))
const wfBasic = show('basic 档（没装 turbo8 LoRA → 应回退 25 步 / CFG 2.5）', I.buildWorkflow(cfg, args, { level: 'basic', nodes: nodes(), models }))
const wfNoTe = show('full 档但缺 TE-Speed 节点', I.buildWorkflow(cfg, args, { level: 'full', nodes: nodes({ teSpeed: false }), models }))
const wfNoCache = show('full 档但缺前缀缓存节点', I.buildWorkflow(cfg, args, { level: 'full', nodes: nodes({ prefixCache: false }), models }))
const wfImg2Img = show('basic 档 + 图生图', I.buildWorkflow(cfg, { ...args, width: 832, height: 1216, reference: 'ref.png' }, { level: 'basic', nodes: nodes(), models }))

console.log('\n=== 3. 关键断言 ===')
const assert = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }
const typesOf = (wf) => Object.values(wf).map((n) => n.class_type)

assert('默认（无 caps）仍走全栈 8 步 / CFG 1', wfDefault[8].inputs.steps === 8 && wfDefault[8].inputs.cfg === 1)
assert('full 档 = 8 步 / CFG 1', wfFull[8].inputs.steps === 8 && wfFull[8].inputs.cfg === 1)
assert('full 档含 turbo8 LoRA', typesOf(wfFull).includes('LoraLoaderModelOnly'))
assert('basic 档**不含** LoRA（关键：缺 LoRA 时不能接）', !typesOf(wfBasic).includes('LoraLoaderModelOnly'))
assert('basic 档不含 ModelSamplingFlux（它是 turbo8 专用）', !typesOf(wfBasic).includes('ModelSamplingFlux'))
assert('basic 档回退 25 步 / CFG 2.5', wfBasic[8].inputs.steps === 25 && wfBasic[8].inputs.cfg === 2.5)
assert('basic 档仍保留前缀缓存（与 turbo8 无关）', JSON.stringify(wfBasic[8].inputs.model) === '["7",0]')
assert('basic 档不接 TE/Speedup（阈值是按 8 步链路调的）',
  !typesOf(wfBasic).includes('TESpeedQwenImage21') && !typesOf(wfBasic).includes('QwenImage21Speedup'))
assert('缺 TE 节点时自动跳过 13', !typesOf(wfNoTe).includes('TESpeedQwenImage21'))
assert('缺 TE 时 Speedup 直接接上一环', JSON.stringify(wfNoTe[14].inputs.model) === '["7",0]')
assert('缺前缀缓存时自动跳过 7', !typesOf(wfNoCache).includes('QwenImage21Cache'))
assert('缺前缀缓存时 TE 接 model_sampling', JSON.stringify(wfNoCache[13].inputs.model) === '["12",0]')
assert('图生图有 LoadImage 且无 EmptyLatent', Boolean(wfImg2Img[4]) && !wfImg2Img[6])
assert('图生图 latent 取自编码节点第 2 路', JSON.stringify(wfImg2Img[8].inputs.latent_image) === '["5",2]')

// ---- 回归 1：**不传 steps** 时的默认值（曾经的真 bug）--------------------------------
// 老代码里 execute/planWorkflow 会把 steps 回落到 cfg.steps（= 8，turbo8 的工作点），
// 于是 basic 档（没装 LoRA）也会拿到 8 步 → 出糊图，把"回退 25 步"的设计整个抵消。
// 修法：不传就如实传 undefined，由 buildWorkflow 按链路决定默认值。
const noSteps = { prompt: 'a cat', width: 1024, height: 1024, seed: 1 }
const wfBasicNoSteps = I.buildWorkflow(cfg, noSteps, { level: 'basic', nodes: nodes(), models })
const wfFullNoSteps = I.buildWorkflow(cfg, noSteps, { level: 'full', nodes: nodes(), models })
assert('★回归 basic 档**不传 steps** → 25 步（不能是 8）', wfBasicNoSteps[8].inputs.steps === 25)
assert('★回归 basic 档不传 steps → CFG 仍为 2.5', wfBasicNoSteps[8].inputs.cfg === 2.5)
assert('full 档不传 steps → 8 步', wfFullNoSteps[8].inputs.steps === 8)

// planWorkflow 与 execute 是两条并行的折算路径，必须**同样**不回落 cfg.steps，
// 否则会出现"自测绿、实际错"。这里单独钉住它。
const planned = I.planWorkflow(cfg, { prompt: 'x', size: '1:1' }, { level: 'basic', nodes: nodes(), models })
assert('★回归 planWorkflow 不传 steps 时 basic 档也是 25 步', planned[8].inputs.steps === 25)
const plannedFull = I.planWorkflow(cfg, { prompt: 'x', size: '1:1' }, { level: 'full', nodes: nodes(), models })
assert('planWorkflow full 档不传 steps → 8 步', plannedFull[8].inputs.steps === 8)

// ---- 回归 2：探测失败时**不得静默降级** --------------------------------------------
// 探测没测出来（网络抖动/超时/被取消）≠ 节点缺失。此时应按"能力齐全"去试，
// 让 ComfyUI 给出明确错误，而不是把用户悄悄打到慢档。
const wfProbeFailed = I.buildWorkflow(cfg, noSteps, { level: 'full', probeFailed: true, nodes: nodes(), models })
assert('★回归 探测失败时按 full 处理（不静默降级）', wfProbeFailed[8].inputs.steps === 8)

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
