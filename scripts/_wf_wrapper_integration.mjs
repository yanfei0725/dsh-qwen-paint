/**
 * _wf_wrapper_integration.mjs —— 验证 wrapperPolicy 在 buildWorkflow 里**真的接线**。
 * （selftest.mjs 的桩是 2026-10-09 改 apply 成 IIFE 之前写的，已过时，跑不到 buildWorkflow；
 *  所以这里专门测 buildWorkflow 的节点接线，不依赖 selftest。）
 *
 * 节点约定（见 lib/index.js buildWorkflow）：
 *   13 = TESpeedQwenImage21（TE-Speed）
 *   14 = QwenImage21Speedup（Speedup）
 *   16 = BlockCache T8（withBlockCache 时节点号）
 * 模型链：1(UNET) → [16] → [11 LoRA] → [12 采样位移] → [7 前缀缓存] → [13 TE] → [14 Speedup] → 8(KSampler)
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildWorkflow, DEFAULTS } = mod.__internal

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? '  OK  ' : '  FAIL'} ${label}`)
  if (!condition) { failures += 1; if (detail !== undefined) console.log(`        ↳ ${JSON.stringify(detail)}`) }
}

// fullCaps：能力齐全（探测阶段算好的 level + 各节点都装了）。
// ⚠ resolvePlan 用 `caps.level`（'full'/'turbo'）判断 useTurbo，用 caps.nodes.* 判断各加速节点，
//   缺了这些键会让整条加速链被判定为不可用（塌成 UNET→KSampler 空链）—— 所以必须写全。
const fullCaps = { level: 'full', nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true } }
const noBcCaps = { level: 'full', nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true } }

console.log('\n=== A. 小尺寸 992²（15376 tokens ≤ 16384）→ TE-Speed + Speedup，无 BlockCache ===')
{
  const wf = buildWorkflow({ ...DEFAULTS }, { prompt: '测试', width: 992, height: 992, seed: 1 }, fullCaps)
  check('节点 13（TE-Speed）存在', wf['13']?.class_type === 'TESpeedQwenImage21')
  check('节点 14（Speedup）存在', wf['14']?.class_type === 'QwenImage21Speedup')
  check('节点 16（BlockCache）不存在', wf['16'] === undefined, wf['16'])
  check('KSampler 接 14:0（链末端是 Speedup）', JSON.stringify(wf['8']?.inputs?.model) === JSON.stringify(['14', 0]), wf['8']?.inputs?.model)
  check('整链首尾相连 1→11→12→7→13→14→8', (() => {
    const chain = ['1', '11', '12', '7', '13', '14', '8']
    return chain.slice(1).every((id, i) => JSON.stringify(wf[id]?.inputs?.model) === JSON.stringify([chain[i], 0]))
  })())
}

console.log('\n=== B. 大尺寸 1408²（30976 tokens > 16384）→ BlockCache T8，无 TE/Speedup ===')
{
  const wf = buildWorkflow({ ...DEFAULTS }, { prompt: '测试', width: 1408, height: 1408, seed: 1 }, fullCaps)
  check('节点 16（BlockCache）存在', wf['16']?.class_type === 'QwenImage21BlockCacheT8', wf['16']?.class_type)
  check('节点 13（TE-Speed）不存在', wf['13'] === undefined, wf['13'])
  check('节点 14（Speedup）不存在', wf['14'] === undefined, wf['14'])
  check('KSampler 接 7:0（链末端回到前缀缓存，因 TE/Speedup 都让位）', JSON.stringify(wf['8']?.inputs?.model) === JSON.stringify(['7', 0]), wf['8']?.inputs?.model)
  check('BlockCache 挂在 UNET 之后（节点 16 的 model 来自 1:0）', JSON.stringify(wf['16']?.inputs?.model) === JSON.stringify(['1', 0]), wf['16']?.inputs?.model)
  check('整链首尾相连 1→16→11→12→7→8', (() => {
    const chain = ['1', '16', '11', '12', '7', '8']
    return chain.slice(1).every((id, i) => JSON.stringify(wf[id]?.inputs?.model) === JSON.stringify([chain[i], 0]))
  })())
  check('turbo8 LoRA + 前缀缓存仍保留（可叠加，不是把加速链整个摘掉）',
    wf['11']?.class_type === 'LoraLoaderModelOnly' && wf['12']?.class_type === 'ModelSamplingFlux' && wf['7']?.class_type === 'QwenImage21Cache')
}

console.log('\n=== C. 大尺寸但没装 BlockCache 节点 → 退回 TE+Speedup（互斥硬保证） ===')
{
  const wf = buildWorkflow({ ...DEFAULTS }, { prompt: '测试', width: 1408, height: 1408, seed: 1 }, noBcCaps)
  check('节点 16（BlockCache）不存在（节点没装）', wf['16'] === undefined, wf['16'])
  check('节点 13（TE-Speed）存在（退回）', wf['13']?.class_type === 'TESpeedQwenImage21')
  check('节点 14（Speedup）存在（退回）', wf['14']?.class_type === 'QwenImage21Speedup')
  check('KSampler 接 14:0（退回后末端是 Speedup）', JSON.stringify(wf['8']?.inputs?.model) === JSON.stringify(['14', 0]), wf['8']?.inputs?.model)
}

console.log('\n=== D. policy=te：1408² 也强制走 TE+Speedup（不按尺寸） ===')
{
  const wf = buildWorkflow({ ...DEFAULTS, wrapperPolicy: 'te' }, { prompt: '测试', width: 1408, height: 1408, seed: 1 }, fullCaps)
  check('节点 16 不存在', wf['16'] === undefined, wf['16'])
  check('节点 13 存在', wf['13']?.class_type === 'TESpeedQwenImage21')
  check('节点 14 存在', wf['14']?.class_type === 'QwenImage21Speedup')
}

console.log('\n=== E. policy=bc：992² 也强制走 BlockCache（不按尺寸） ===')
{
  const wf = buildWorkflow({ ...DEFAULTS, wrapperPolicy: 'bc' }, { prompt: '测试', width: 992, height: 992, seed: 1 }, fullCaps)
  check('节点 16 存在', wf['16'] !== undefined, wf['16']?.class_type)
  check('节点 13 不存在', wf['13'] === undefined, wf['13'])
  check('节点 14 不存在', wf['14'] === undefined, wf['14'])
}

console.log('\n=== F. basic 档（无 turbo8）+ 大尺寸 1408² → 只挂 BlockCache，不挂 TE/Speedup ===')
{
  // level='basic' ⇒ resolvePlan 的 useTurbo=false ⇒ TE/Speedup 不可用；
  // 但 BlockCache 是独立模型 wrapper，不依赖 turbo8，大尺寸仍应挂上（且不挂会崩的 TE/Speedup）。
  const basicCaps = { level: 'basic', nodes: { turbo8: false, prefixCache: true, teSpeed: true, speedup: true, blockCache: true } }
  const wf = buildWorkflow({ ...DEFAULTS }, { prompt: '测试', width: 1408, height: 1408, seed: 1 }, basicCaps)
  check('节点 16（BlockCache）存在', wf['16']?.class_type === 'QwenImage21BlockCacheT8', wf['16']?.class_type)
  check('节点 13（TE-Speed）不存在（无 turbo8）', wf['13'] === undefined, wf['13'])
  check('节点 14（Speedup）不存在（无 turbo8）', wf['14'] === undefined, wf['14'])
  check('节点 11（turbo8 LoRA）不存在', wf['11'] === undefined, wf['11'])
  check('链 1→16→(前缀缓存7)→8 首尾相连', (() => {
    const chain = ['1', '16', '7', '8']
    return chain.slice(1).every((id, i) => JSON.stringify(wf[id]?.inputs?.model) === JSON.stringify([chain[i], 0]))
  })(), { n16: wf['16']?.inputs?.model, n7: wf['7']?.inputs?.model, n8: wf['8']?.inputs?.model })
}

console.log('\n=== G. RDNA3 FlashAttention（无损）接在模型链最末端 ===')
{
  // ★ 必须带 gpu.name：FA 门控现在要求"传了 caps 就必须能确认是 RDNA3"。
  const faCaps = { level: 'full', gpu: { name: 'AMD Radeon RX 7900 XT' }, nodes: { turbo8: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true } }
  const wf = buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 }, faCaps)
  check('节点 17（FA）存在', wf['17']?.class_type === 'ApplyRDNA3FlashAttention', wf['17']?.class_type)
  check('FA 接在上一个链末端（992² 时是 Speedup=14）',
    JSON.stringify(wf['17']?.inputs?.model) === JSON.stringify(['14', 0]), wf['17']?.inputs?.model)
  check('KSampler 接 17:0（FA 是最后一个）',
    JSON.stringify(wf['8']?.inputs?.model) === JSON.stringify(['17', 0]), wf['8']?.inputs?.model)

  // 大尺寸 + BlockCache：FA 接在 7（前缀缓存）之后
  const wfBig = buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 1408, height: 1408, seed: 1 }, faCaps)
  check('1408²：FA 接在 7:0（BlockCache 链末端）',
    JSON.stringify(wfBig['17']?.inputs?.model) === JSON.stringify(['7', 0]), wfBig['17']?.inputs?.model)
  check('1408²：KSampler 接 17:0', JSON.stringify(wfBig['8']?.inputs?.model) === JSON.stringify(['17', 0]), wfBig['8']?.inputs?.model)

  // 没装 FA 节点 → 不挂（能力门控）
  const noFa = buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 }, fullCaps)
  check('无 FA 节点 → 节点 17 不存在', noFa['17'] === undefined, noFa['17'])

  // 配置关掉
  const off = buildWorkflow({ ...DEFAULTS, rdna3FlashAttention: false }, { prompt: 'x', width: 992, height: 992, seed: 1 }, faCaps)
  check('rdna3FlashAttention=false → 节点 17 不存在', off['17'] === undefined, off['17'])
}

console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===`)
process.exit(failures === 0 ? 0 : 1)
