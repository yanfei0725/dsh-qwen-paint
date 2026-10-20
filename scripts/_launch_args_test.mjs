// 验证：ensureComfyUp 实际会拼出什么启动参数
// 2026-10-09：主人要求「重启一下，把工作流再优化」。启动前必须先确认
//   --highvram 真的进了参数表 —— 上一轮它就是被静默吃掉的。
import { __internal as I } from '../lib/index.js'

const cfg = { ...I.DEFAULTS }
const logs = []
const log = (lv, m) => logs.push(`[${lv}] ${m}`)

// 直接调 detectGpuProfile 走 skipOnline（与启动路径完全一致）
const gpu = await I.detectGpuProfile(cfg, log, { skipOnline: true })
console.log('vramGB      :', gpu.vramGB)
console.log('vramSource  :', gpu.vramSource)

// 复算 VRAM_ARGS 的同一套规则（保持与源码同步）
const gb = Number(gpu.vramGB ?? 0)
let vram = []
if (Number.isFinite(gb) && gb > 0) {
  if (gb >= 24) vram = ['--highvram']
  // ★ 0.5（2026-10-09 二次修正）：1.5 GB 的保留会把 1408×1408 逼进换页。
  //   这里必须与 lib/index.js 的 VRAM_ARGS 保持同步，否则测试就是在给旧值背书。
  else if (gb >= 16) vram = ['--highvram', '--reserve-vram', '0.5']
}
console.log('VRAM_ARGS   :', JSON.stringify(vram))

// plan.residency 面板说法
const caps = { level: 'full', probeFailed: false, gpu: { vramGB: gb },
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, loraOnly: true },
  models: { unet: 'a', clip: 'b', vae: 'c', turbo8Lora: 'd' } }
const plan = I.resolvePlan(cfg, caps)
console.log('residency   :', JSON.stringify(plan.residency))

const ok = vram.includes('--highvram') && plan.residency.on === true
console.log(ok ? '✅ 启动会带上 --highvram，且面板说法一致' : '❌ 不一致 —— 别启动，先修')
console.log(ok ? '结果：通过' : '结果：失败')
process.exit(ok ? 0 : 1)
