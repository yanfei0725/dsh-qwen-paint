/**
 * _step4_dry_test.mjs —— 离线验证「4 步档 + 优化栈」能否拼出正确工作流图。
 *
 * 不联网、不出图，只调 buildWorkflow 检查节点图。测**两条路径**：
 *
 *   A. 手动路径（老）：forceTurbo8Steps=false + turbo8Steps=4 + 换 turbo8Lora
 *   B. 产品路径（新）：`fast4Enabled` 开关 —— 步数/位移/LoRA 三者应**一起**切换
 *
 * 每轮都查：
 *   ① KSampler 步数与 CFG 是否符合该档位
 *   ② LoRA 节点接了、文件名对不对
 *   ③ 采样位移是否与该 LoRA 配套（turbo8=ln2 / 4 步=ln3）★ 拿错位移会明显掉画质
 *   ④ 优化节点是否仍接在模型链上（小尺寸 → TE+Speedup；大尺寸 → BlockCache）
 *   ⑤ 前缀 KV 缓存节点是否在
 *
 * 用法：node scripts/_step4_dry_test.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
// ⚠ 必须先 import index.js（生产路径：package.json main = lib/index.js）。
//   反过来先 import config.js 会撞循环 import 的 TDZ（__internal 已改成惰性求值，
//   所以现在两种顺序都行了 —— 这条注释留着是为了说明为什么当初会崩）。
const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildWorkflow, DEFAULTS } = idx.__internal

const LORA4 = 'Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors'
const LORA8 = 'turbo8_lora_step2500.safetensors'
const LN2 = 0.6935
// ⚠ 用配置里的**字面值**（1.0986）而不是 Math.log(3)=1.0986122…：
//   配置里就是四舍五入到 4 位小数的 ln3，两者差 1.2e-5，容差按 1e-3 判。
const LN3 = 1.0986
const SHIFT_TOL = 1e-3

let pass = 0, fail = 0
const ok = (n, c, extra) => { c ? (pass++, console.log('  OK  ', n)) : (fail++, console.log('  FAIL', n, extra ?? '')) }

function build(cfg, size, caps) {
  const res = buildWorkflow(cfg, {
    prompt: '一只猫', negative: '', width: size, height: size, seed: 1, count: 1,
  }, caps)
  const wf = res?.workflow ?? res
  const nodes = Object.values(wf).filter((n) => n && typeof n === 'object' && n.class_type)
  return { nodes, types: nodes.map((n) => n.class_type) }
}

/** 共用断言：优化栈必须完整、wrapper 互斥。 */
function assertOptimizations(types) {
  ok('前缀 KV 缓存节点在（QwenImage21Cache）', types.some((t) => /Cache/i.test(t)))
  const wrapper = types.filter((t) => /TESpeed|Speedup|BlockCache/i.test(t))
  console.log('    优化 wrapper 节点：', wrapper.length ? wrapper.join(', ') : '（无）')
  ok('至少接了一个优化 wrapper', wrapper.length >= 1)
  // 互斥关系：{TE-Speed + Speedup} 与 {BlockCache} 两组争抢同一个 DIFFUSION_MODEL wrapper，
  // 不能共存；TE 与 Speedup 本身是**串联**的（14 Speedup → 13 TE → 7 前缀缓存）。
  const hasBc = wrapper.some((t) => /BlockCache/i.test(t))
  const hasTeSp = wrapper.some((t) => /TESpeed|Speedup/i.test(t))
  ok('BlockCache 不与 TE/Speedup 共存', !(hasBc && hasTeSp), wrapper.join(','))
  ok('RDNA3 FA 在（能力齐全时）', types.some((t) => /FlashAttention/i.test(t)))
}

/** caps：模拟"机器上两个 LoRA 都在"。
 *  ⚠ GPU 名必须给**真的 RDNA3**（7900 XTX）—— `useRdna3Fa` 的判定是
 *    "传了 caps 就必须能确认是 RDNA3"（`vendorIdOf(gpu.name) === 'amd_rdna3'`），
 *    给个假名字 FA 本来就不会挂（那是正确行为，不是 bug）。 */
const capsBoth = {
  level: 'full',
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true },
  models: { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors', turbo8Lora: LORA8, fast4Lora: LORA4 },
  gpu: { name: 'AMD Radeon RX 7900 XTX', vramGB: 24 },
  notes: [],
}

/* ---------------------------------------------- A. 手动路径（老行为）---- */
function runManual(label, size) {
  console.log(`\n=== A. 手动路径 · ${label}（${size}×${size}）===`)
  const cfg = { ...DEFAULTS, forceTurbo8Steps: false, turbo8Steps: 4, turbo8Lora: LORA4 }
  const { nodes, types } = build(cfg, size, undefined)   // caps 不传 = 当作能力齐全
  const sampler = nodes.find((n) => n.class_type === 'KSampler')
  const lora = nodes.find((n) => n.class_type === 'LoraLoaderModelOnly')
  ok(`KSampler.steps === 4（实测 ${sampler?.inputs?.steps}）`, sampler?.inputs?.steps === 4)
  ok(`KSampler.cfg === 1.0（实测 ${sampler?.inputs?.cfg}）`, sampler?.inputs?.cfg === 1.0)
  ok(`LoRA = 换上的 4 步权重（实测 ${lora?.inputs?.lora_name}）`, lora?.inputs?.lora_name === LORA4)
  assertOptimizations(types)
}

/* ------------------------------------ B. 产品路径：fast4Enabled 开关 ---- */
function runSwitch(label, size, { enabled, caps = capsBoth, expect }) {
  console.log(`\n=== B. 极速档开关 · ${label}（${size}×${size}）===`)
  const cfg = { ...DEFAULTS, fast4Enabled: enabled }
  const { nodes, types } = build(cfg, size, caps)
  const sampler = nodes.find((n) => n.class_type === 'KSampler')
  const lora = nodes.find((n) => n.class_type === 'LoraLoaderModelOnly')
  const msf = nodes.find((n) => n.class_type === 'ModelSamplingFlux')
  console.log(`    steps=${sampler?.inputs?.steps}  cfg=${sampler?.inputs?.cfg}`
    + `  lora=${lora?.inputs?.lora_name}  shift=${msf?.inputs?.max_shift}/${msf?.inputs?.base_shift}`)

  ok(`步数 = ${expect.steps}（实测 ${sampler?.inputs?.steps}）`, sampler?.inputs?.steps === expect.steps)
  ok(`CFG = 1.0（实测 ${sampler?.inputs?.cfg}）`, sampler?.inputs?.cfg === 1.0)
  ok(`LoRA = ${expect.lora}`, lora?.inputs?.lora_name === expect.lora)
  ok(`采样位移与 LoRA 配套（max_shift≈${expect.shift}，实测 ${msf?.inputs?.max_shift}）`,
    Math.abs(Number(msf?.inputs?.max_shift) - expect.shift) < SHIFT_TOL,
    `实测 ${msf?.inputs?.max_shift}`)
  ok(`base_shift 同步（实测 ${msf?.inputs?.base_shift}）`,
    Math.abs(Number(msf?.inputs?.base_shift) - expect.baseShift) < SHIFT_TOL)
  assertOptimizations(types)
}

runManual('小尺寸（TE+Speedup 档）', 1024)
runManual('大尺寸（BlockCache 档）', 1408)

// 开 → 4 步 / Lightning LoRA / 位移 ln3
runSwitch('开 · 小尺寸', 1024, { enabled: true, expect: { steps: 4, lora: LORA4, shift: LN3, baseShift: LN3 } })
runSwitch('开 · 大尺寸', 1408, { enabled: true, expect: { steps: 4, lora: LORA4, shift: LN3, baseShift: LN3 } })
// 关 → 8 步 / turbo8 / 位移 ln2
runSwitch('关 · 小尺寸', 1024, { enabled: false, expect: { steps: 8, lora: LORA8, shift: LN2, baseShift: 0.5 } })

// ★ 护栏：机器上没有 4 步 LoRA 时，**即使开关是开的也必须退回 8 步** ——
//   否则出图会被 ComfyUI 以 `value not in list` 拒收。
console.log('\n=== B. 护栏 · 开关开但机器上没有 4 步 LoRA ===')
{
  const capsNoLora = { ...capsBoth, models: { ...capsBoth.models, fast4Lora: null } }
  const cfg = { ...DEFAULTS, fast4Enabled: true }
  const { nodes } = build(cfg, 1024, capsNoLora)
  const sampler = nodes.find((n) => n.class_type === 'KSampler')
  const lora = nodes.find((n) => n.class_type === 'LoraLoaderModelOnly')
  console.log(`    steps=${sampler?.inputs?.steps}  lora=${lora?.inputs?.lora_name}`)
  ok('没有 4 步 LoRA 时自动退回 8 步', sampler?.inputs?.steps === 8, `实测 ${sampler?.inputs?.steps}`)
  ok('且 LoRA 退回 turbo8', lora?.inputs?.lora_name === LORA8, `实测 ${lora?.inputs?.lora_name}`)
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}） ===`)
process.exit(fail === 0 ? 0 : 1)
