/**
 * _gpu_vendor_test.mjs —— 三厂商（NVIDIA / Intel / AMD）**专门优化**的稳定性与兼容性回归。
 *
 * 守两件事：
 *   ① **判定正确**：显卡名 → 厂商/代数（打分规则，独显优先于核显）；
 *   ② **方案对症**：每家拿到的启动参数 / 加速包**各不相同**，且**不互相串味**
 *      （例如 N 卡绝不能拿到 AMD 的 quad；A 卡不能去装 N 卡的 SageAttention）。
 *   ③ 新加的厂商专用节点（RDNA3 FA）**只在匹配的卡上挂**，避免在别家卡上"挂上就崩"。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { vendorIdOf, GPU_PROFILES, ACCEL_PACKS, packAppliesToOs, buildWorkflow, DEFAULTS } = mod.__internal

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

console.log('=== ① 显卡名 → 厂商/代数（打分判定） ===')
const cases = [
  ['NVIDIA GeForce RTX 4090', 'nvidia'],
  ['NVIDIA GeForce RTX 3060', 'nvidia'],
  ['NVIDIA A100-SXM4-80GB', 'nvidia'],
  ['Intel(R) Arc(TM) B580 Graphics', 'intel_battlemage'],
  ['Intel(R) Arc(TM) A770 Graphics', 'intel_alchemist'],
  ['Intel(R) UHD Graphics 630', 'intel'],
  ['AMD Radeon RX 7900 XT', 'amd_rdna3'],
  ['AMD Radeon RX 9070 XT', 'amd_rdna4'],
  ['AMD Radeon RX 6800 XT', 'amd_rdna2'],
  ['Apple M2 Max', 'unknown'],
  ['', 'unknown'],
  // ★ 混合机型：独显优先于核显（"AMD 核显 | NVIDIA 独显"必须判 nvidia）
  ['AMD Radeon Graphics | NVIDIA GeForce RTX 4090', 'nvidia'],
  ['Intel(R) UHD Graphics | AMD Radeon RX 7800 XT', 'amd_rdna3'],
]
for (const [name, want] of cases) {
  ok(`${JSON.stringify(name)} → ${want}`, vendorIdOf(name) === want)
}

console.log('\n=== ② 每家拿到的**注意力启动参数**各不相同（不串味） ===')
ok('NVIDIA → pytorch-cross-attention（SDPA 本身走 flash 内核）',
  GPU_PROFILES.nvidia.args.join(' ') === '--use-pytorch-cross-attention')
ok('NVIDIA **不**拿 AMD 的 quad', !GPU_PROFILES.nvidia.args.includes('--use-quad-cross-attention'))
ok('Intel(Battlemage) → pytorch-cross-attention', GPU_PROFILES.intel_battlemage.args.join(' ') === '--use-pytorch-cross-attention')
ok('Intel(Alchemist) → pytorch-cross-attention', GPU_PROFILES.intel_alchemist.args.join(' ') === '--use-pytorch-cross-attention')
ok('Intel 泛化 → pytorch-cross-attention', GPU_PROFILES.intel.args.join(' ') === '--use-pytorch-cross-attention')
ok('Intel **不**拿 quad', !GPU_PROFILES.intel.args.includes('--use-quad-cross-attention'))
ok('AMD RDNA3 → quad（本机既定方案，实测 +15%）',
  GPU_PROFILES.amd_rdna3.args.join(' ') === '--use-quad-cross-attention')
ok('AMD RDNA4 → pytorch-cross-attention（换 CK 内核）',
  GPU_PROFILES.amd_rdna4.args.join(' ') === '--use-pytorch-cross-attention')
ok('AMD RDNA2 → pytorch-cross-attention（保守）',
  GPU_PROFILES.amd_rdna2.args.join(' ') === '--use-pytorch-cross-attention')
ok('unknown → 一个参数都不加（保证能起来）', GPU_PROFILES.unknown.args.length === 0)

console.log('\n=== ③ 每家拿到的**专用加速包**各不相同 ===')
ok('NVIDIA 的包含 triton-windows + sageattention + nunchaku',
  ['triton-windows', 'sageattention', 'nunchaku'].every((p) => GPU_PROFILES.nvidia.packs.includes(p)))
ok('Intel(Battlemage) 的包含 ipex', GPU_PROFILES.intel_battlemage.packs.includes('ipex'))
ok('Intel(Alchemist) 的包含 ipex', GPU_PROFILES.intel_alchemist.packs.includes('ipex'))
ok('Intel 泛化的包含 ipex', GPU_PROFILES.intel.packs.includes('ipex'))
ok('★ AMD 一支**刻意留空**（不引第三方内核）',
  GPU_PROFILES.amd_rdna3.packs.length === 0 && GPU_PROFILES.amd_rdna4.packs.length === 0
  && GPU_PROFILES.amd_rdna2.packs.length === 0)
ok('★ 没有把 N 卡的包错配给 Intel（ipex 的 vendor=intel）', ACCEL_PACKS.ipex.vendor === 'intel')
ok('★ 没有把 Intel 的包错配给 NVIDIA（sageattention 的 vendor=nvidia）', ACCEL_PACKS.sageattention.vendor === 'nvidia')

console.log('\n=== ④ 加速包按操作系统过滤（装错会顶掉正确的那个） ===')
ok('triton-windows 只给 Windows', packAppliesToOs(ACCEL_PACKS['triton-windows']) === (process.platform === 'win32'))
ok('triton（官方）不给 Windows（避免顶掉 triton-windows）',
  packAppliesToOs(ACCEL_PACKS.triton) === (process.platform === 'linux' || process.platform === 'darwin'))
ok('sageattention 全平台可用（win/linux）',
  ACCEL_PACKS.sageattention.os.includes('win32') && ACCEL_PACKS.sageattention.os.includes('linux'))
ok('ipex 带 --extra-index-url（否则 pip 找不到：实测真 bug）',
  String(ACCEL_PACKS.ipex.requires).length > 0)

console.log('\n=== ⑤ RDNA3 FA 节点只在匹配的卡上挂（别家卡挂上会崩） ===')
const faNode = (wf) => wf['17']?.class_type === 'ApplyRDNA3FlashAttention'
const withGpu = (name, extra = {}) => buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 },
  { level: 'full', gpu: { name }, nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true }, ...extra })

ok('AMD RDNA3（7900 XT）→ 挂 FA', faNode(withGpu('AMD Radeon RX 7900 XT')))
ok('★ NVIDIA → **不**挂 FA（挂了 patch() 会抛错）', !faNode(withGpu('NVIDIA GeForce RTX 4090')))
ok('★ Intel Arc → 不挂 FA', !faNode(withGpu('Intel(R) Arc(TM) B580 Graphics')))
ok('★ AMD RDNA4（9070）→ 不挂 FA（FA 只认 gfx1100）', !faNode(withGpu('AMD Radeon RX 9070 XT')))
ok('★ AMD RDNA2（6800）→ 不挂 FA', !faNode(withGpu('AMD Radeon RX 6800 XT')))
ok('★ 传了 caps 但拿不到 GPU 名字 → **不挂**（未知架构不放行，避免 patch() 抛错）',
  !faNode(withGpu(undefined)))
ok('★ caps **完全没传**（自测 / planWorkflow）→ 视为能力齐全，挂 FA',
  faNode(buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 })))
ok('★ 节点没装（nodes 无 rdna3fa）→ 不挂', !faNode(buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 },
  { level: 'full', gpu: { name: 'AMD Radeon RX 7900 XT' }, nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true } })))
ok('★ 配置关掉（rdna3FlashAttention=false）→ 不挂',
  !faNode(buildWorkflow({ ...DEFAULTS, rdna3FlashAttention: false }, { prompt: 'x', width: 992, height: 992, seed: 1 },
    { level: 'full', gpu: { name: 'AMD Radeon RX 7900 XT' }, nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true } })))

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
