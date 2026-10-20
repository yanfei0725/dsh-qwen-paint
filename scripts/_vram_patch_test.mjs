// 验证：detectGpuProfile 在 skipOnline=true 时，能否经 PyTorch 层拿到 19.98 GB
// 2026-10-09：专门为"findComfyPython 幽灵函数"这个 bug 写的回归测试。
//   它必须能抓出「vramGB 恒为 0」——即驻留参数静默失效。
import { __internal as I } from '../lib/index.js'

const cfg = { ...I.DEFAULTS }
const logs = []
const log = (lv, m) => logs.push(`[${lv}] ${m}`)

const gpu = await I.detectGpuProfile(cfg, log, { skipOnline: true })
console.log('vendor      :', gpu.vendor)
console.log('vramGB      :', gpu.vramGB)
console.log('vramSource  :', gpu.vramSource)
console.log('args        :', JSON.stringify(gpu.args))
console.log('---- logs ----')
for (const l of logs) console.log(l)
console.log('---- 判定 ----')

let pass = true
if (!(gpu.vramGB > 0)) {
  console.log('❌ vramGB = 0 → 驻留参数不会生效（PyTorch 层没跑起来）')
  pass = false
} else if (gpu.vramGB >= 16 && gpu.vramGB < 24) {
  console.log(`✅ vramGB=${gpu.vramGB} 命中 [16,24) 档 → 应加 --highvram --reserve-vram 0.5`)
} else if (gpu.vramGB >= 24) {
  console.log(`✅ vramGB=${gpu.vramGB} 命中 ≥24 档 → 应加 --highvram`)
} else {
  console.log(`⚠ vramGB=${gpu.vramGB} 偏低 → 不加驻留参数`)
}
console.log(pass ? '结果：通过' : '结果：失败')
process.exit(pass ? 0 : 1)
