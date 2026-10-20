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
const { vendorIdOf, GPU_PROFILES, ACCEL_PACKS, packAppliesToOs, buildWorkflow, DEFAULTS, describeOptimization } = mod.__internal

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
  // ★★★ 2026-10-12 新增：**RDNA1（RX 5000 系列）** —— 此前没有规则，
  //   会落到泛化的 `amd`（"未识别具体架构" + 被套上 quad）。
  ['AMD Radeon RX 5700 XT', 'amd_rdna1'],
  ['AMD Radeon RX 5600 XT', 'amd_rdna1'],
  ['AMD Radeon RX 5500 XT', 'amd_rdna1'],
  // 2026-10-11：macOS 适配后 Apple Silicon 有专属档案了（此前是 unknown）
  ['Apple M2 Max', 'apple'],
  // ★★★ 2026-10-12：M1–M5 **全代次**都要认得出（`m\d` 覆盖 M1–M9，新代次无需改代码）
  ['Apple M1', 'apple'],
  ['Apple M1 Max', 'apple'],
  ['Apple M3 Pro', 'apple'],
  ['Apple M4', 'apple'],
  ['Apple M5', 'apple'],
  ['Apple M9 Ultra', 'apple'],
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
// ★★★ 2026-10-12：RDNA1 与 RDNA2 同属"没有厂商级融合注意力内核"的一代
ok('★ AMD RDNA1（RX 5000）→ pytorch-cross-attention（无 AOTriton / CK 覆盖，保守）',
  GPU_PROFILES.amd_rdna1.args.join(' ') === '--use-pytorch-cross-attention')
ok('★ AMD RDNA1 的档案里写明了 HSA_OVERRIDE_GFX_VERSION（不在 ROCm 官方支持矩阵内）',
  String(GPU_PROFILES.amd_rdna1.note).includes('HSA_OVERRIDE_GFX_VERSION'))
ok('★ AMD RDNA1 **不**拿 quad（那是"可选内核"，不是默认路径）',
  !GPU_PROFILES.amd_rdna1.args.includes('--use-quad-cross-attention'))
// ★★★ 2026-10-12：Mac 四档 —— 都走 Metal/MPS，args 必须一致且只挂通用 SDPA
ok('★ Mac 四档的 args 完全一致（macOS 上只有 Metal/MPS 一条路，与具体芯片无关）',
  ['apple', 'mac_amd', 'mac_mps', 'intel_mac'].every((id) =>
    id === 'intel_mac'
      ? GPU_PROFILES[id].args.length === 0
      : GPU_PROFILES[id].args.join(' ') === '--use-pytorch-cross-attention'))
ok('★ Intel Mac **一个参数都不加**（macOS 上没有 XPU，装 IPEX 是白折腾）',
  GPU_PROFILES.intel_mac.args.length === 0 && GPU_PROFILES.intel_mac.packs.length === 0)
ok('★ 三个"有 MPS"的 Mac 档都带 PYTORCH_ENABLE_MPS_FALLBACK',
  ['apple', 'mac_amd', 'mac_mps'].every((id) =>
    GPU_PROFILES[id].env?.PYTORCH_ENABLE_MPS_FALLBACK === '1'))
ok('★ Mac 四档都**不引第三方加速包**', ['apple', 'mac_amd', 'mac_mps', 'intel_mac'].every((id) => GPU_PROFILES[id].packs.length === 0))

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

console.log('\n=== ⑥ macOS 平台闸：同一张卡在 Mac 上走 Metal，**不走** ROCm / CUDA / XPU ===')
// 依据：macOS 上 Apple 只提供 Metal / MPS —— 没有 ROCm、没有 CUDA、也没有 XPU 后端。
// 不收这道口，就会出现"Mac 上的 A 卡被建议挂 --use-ck-attention"、
// "Intel Mac 被建议装 XPU + IPEX" 这类**照着做必然失败**的建议。
// ⚠ 本机是 Windows ⇒ 用可注入的 platform 参数直接回归 darwin 分支（不必等真机）。
ok('★ Apple M1–M5 全部 → apple',
  ['Apple M1', 'Apple M2 Pro', 'Apple M3 Max', 'Apple M4', 'Apple M5'].every((n) => vendorIdOf(n, 'darwin') === 'apple'))
ok('★ 未来代次（M9）无需改代码也识别', vendorIdOf('Apple M9 Ultra', 'darwin') === 'apple')
ok('★ Intel Mac + AMD 独显 → mac_amd（走 Metal，**不套** ROCm 的 quad / ck）',
  vendorIdOf('AMD Radeon Pro 5500M | Intel UHD Graphics 630', 'darwin') === 'mac_amd')
ok('★ Intel Mac 核显 → intel_mac（**不是** intel，避免被建议装 XPU + IPEX）',
  vendorIdOf('Intel Iris Plus Graphics', 'darwin') === 'intel_mac')
ok('★ ComfyUI 在 Mac 上只报 "mps" → mac_mps（型号未识别，但仍走对 Mac 路径）',
  vendorIdOf('mps', 'darwin') === 'mac_mps')
ok('★ 什么都探不到 → unknown（不猜）', vendorIdOf('', 'darwin') === 'unknown')
ok('★ 同一张 RX 7900 XT：Windows 走 ROCm 档 / macOS 走 Metal 档',
  vendorIdOf('AMD Radeon RX 7900 XT', 'win32') === 'amd_rdna3'
  && vendorIdOf('AMD Radeon RX 7900 XT', 'darwin') === 'mac_amd')
ok('★ 同一张 Intel Arc A770：Windows 走 XPU 档 / macOS 走 intel_mac',
  vendorIdOf('Intel(R) Arc(TM) A770 Graphics', 'win32') === 'intel_alchemist'
  && vendorIdOf('Intel(R) Arc(TM) A770 Graphics', 'darwin') === 'intel_mac')
ok('★ 平台闸**只在 darwin 生效**（Linux 判定必须一字不变）',
  vendorIdOf('AMD Radeon RX 7900 XT', 'linux') === 'amd_rdna3'
  && vendorIdOf('Apple M4', 'win32') === 'apple')

console.log('\n=== ⑦ 面板：Mac 专属项 + RDNA1 提示（都用可注入 platform 回归） ===')
const panelCaps = (name, vramGB = 16) => ({
  level: 'full', probeFailed: false,
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true },
  models: { unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
  gpu: { name, vramGB }, notes: [],
})
const mac = describeOptimization({ ...DEFAULTS }, panelCaps('Apple M4 Pro'), 'darwin')
const macNames = mac.detail.map((d) => d.name)
ok('★ Mac 上出现「macOS 平台路径」项（说明走了哪条路）', macNames.some((n) => n.includes('macOS 平台路径')))
ok('★ Mac 上出现「MPS 算子回退兜底」项', macNames.some((n) => n.includes('MPS 算子回退兜底')))
ok('★ Mac 上出现「MPS 取消显存水位上限」**可选档**',
  mac.detail.some((d) => d.name.includes('MPS 取消显存水位上限') && d.optional === true))
ok('★ 两个 Mac 开关都带**可点** toggle',
  ['applempsfallback', 'applempsunlimited'].every((k) =>
    mac.detail.some((d) => d.toggle?.key === k && d.toggle.canToggle === true)))
ok('★ Mac 上**不把**「显存驻留」列成"不可启用"（MPS 上它根本不参与）',
  !macNames.some((n) => n.includes('显存驻留')))
ok('★ 但也不静默消失：如实写明"为什么没有这一项"',
  mac.filtered.some((n) => n.includes('显存驻留')))
ok('★ 配置齐全的 Mac → level=full（不因平台差异误报"部分启用"）',
  mac.level === 'full' && mac.ok === true, mac.summary)
ok('★ Mac 上 RDNA3 FA 被隐藏（gfx1100 专用，Mac 上不存在该节点）',
  mac.filtered.some((n) => n.includes('RDNA3 FlashAttention')))
// Mac 专属项只在 Mac 出现 —— N 卡上不许冒出来
const nv = describeOptimization({ ...DEFAULTS }, panelCaps('NVIDIA GeForce RTX 4090', 24), 'win32')
ok('★ 非 Mac 上**不出现**任何 Mac 专属项',
  !nv.detail.some((d) => /MPS|平台路径/.test(d.name)) && !nv.filtered.some((n) => n.includes('显存驻留')))
ok('★ 非 Mac 上「显存驻留」照常列出（没有被平台分支误伤）',
  nv.detail.some((d) => d.name.includes('显存驻留')))
// RDNA1 面板
const r1 = describeOptimization({ ...DEFAULTS }, panelCaps('AMD Radeon RX 5700 XT', 8), 'win32')
ok('★ RDNA1 的可选内核给 quad（该代没有 AOTriton / CK 覆盖）',
  r1.detail.some((d) => d.name.includes('A 卡专属内核（可选）：--use-quad-cross-attention')))
ok('★ RDNA1 上**不出现** RDNA3 的 FA 项（gfx1100 专用，别家卡挂上会崩）',
  !r1.detail.some((d) => d.name.includes('RDNA3 FlashAttention'))
  && r1.filtered.some((n) => n.includes('RDNA3 FlashAttention')))
ok('★ RDNA1 仍带 A 卡的两项可选档（与 RDNA2/3/4 同等待遇）',
  r1.detail.some((d) => d.toggle?.key === 'amdkernel') && r1.detail.some((d) => d.toggle?.key === 'asyncOffload'))

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
