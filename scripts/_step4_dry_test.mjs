/**
 * _step4_dry_test.mjs —— 离线验证「4 步 + 优化栈」能否拼出正确工作流图。
 *
 * 不联网、不出图，只调 buildWorkflow 检查节点图：
 *   ① KSampler 步数是否真为 4（forceTurbo8Steps=false 生效）
 *   ② CFG 是否仍为 1.0（蒸馏工作点）
 *   ③ LoRA 节点是否接了、文件名是否为新换的
 *   ④ 优化节点是否仍接在模型链上（小尺寸 → TE-Speed + Speedup；大尺寸 → BlockCache）
 *   ⑤ 前缀 KV 缓存节点是否在
 *
 * 用法：node scripts/_step4_dry_test.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
// ⚠ 必须先 import index.js（生产路径：package.json main = lib/index.js）。
//   反过来先 import config.js 会撞循环 import 的 TDZ（见本文件末尾备注）。
const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildWorkflow, DEFAULTS } = idx.__internal

const LORA4 = 'qwen_image_lightning_4step.safetensors'
let pass = 0, fail = 0
const ok = (n, c, extra) => { c ? (pass++, console.log('  OK  ', n)) : (fail++, console.log('  FAIL', n, extra ?? '')) }

function run(label, size) {
  console.log(`\n=== ${label}（${size}×${size}）===`)
  const cfg = { ...DEFAULTS, forceTurbo8Steps: false, turbo8Steps: 4, turbo8Lora: LORA4 }
  const res = buildWorkflow(cfg, {
    prompt: '一只猫', negative: '', width: size, height: size, seed: 1, count: 1,
  }, undefined)   // caps 不传 = 当作能力齐全（默认全栈）
  const wf = res?.workflow ?? res
  const nodes = Object.values(wf).filter((n) => n && typeof n === 'object' && n.class_type)
  const types = nodes.map((n) => n.class_type)
  const sampler = nodes.find((n) => n.class_type === 'KSampler')

  ok('KSampler 存在', !!sampler)
  ok(`KSampler.steps === 4（实测 ${sampler?.inputs?.steps}）`, sampler?.inputs?.steps === 4, JSON.stringify(sampler?.inputs?.steps))
  ok(`KSampler.cfg === 1.0（实测 ${sampler?.inputs?.cfg}）`, sampler?.inputs?.cfg === 1.0)

  const lora = nodes.find((n) => n.class_type === 'LoraLoaderModelOnly')
  ok('LoRA 节点在链上', !!lora)
  ok(`LoRA 文件名 = 换上的 4 步权重（实测 ${lora?.inputs?.lora_name}）`, lora?.inputs?.lora_name === LORA4)

  ok('前缀 KV 缓存节点在（QwenImage21Cache）', types.some((t) => /Cache/i.test(t)))
  const wrapper = types.filter((t) => /TESpeed|Speedup|BlockCache/i.test(t))
  console.log('    优化 wrapper 节点：', wrapper.length ? wrapper.join(', ') : '（无）')
  ok('至少接了一个优化 wrapper', wrapper.length >= 1)
  // 互斥关系：{TE-Speed + Speedup} 与 {BlockCache} 两组争抢同一个 DIFFUSION_MODEL wrapper，
  // 不能共存；TE 与 Speedup 本身是**串联**的（14 Speedup → 13 TE → 7 前缀缓存）。
  const hasBc = wrapper.some((t) => /BlockCache/i.test(t))
  const hasTeSp = wrapper.some((t) => /TESpeed|Speedup/i.test(t))
  ok('BlockCache 不与 TE/Speedup 共存', !(hasBc && hasTeSp), wrapper.join(','))

  console.log('    全部节点类型：', [...new Set(types)].join(', '))
}

run('小尺寸（TE+Speedup 档）', 1024)
run('大尺寸（BlockCache 档）', 1408)

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}） ===`)
process.exit(fail === 0 ? 0 : 1)
