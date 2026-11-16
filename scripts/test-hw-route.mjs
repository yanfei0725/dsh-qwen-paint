/**
 * test-hw-route.mjs —— 硬件感知路由（GPU 架构 → Sage 内核变体建议 + 量化内核提示
 * + stable-fast 跳过声明）专项回归。
 *
 * 断言风格：ok(名称, 条件)。全离线、零联网、零子进程（buildAccelChain 是纯函数）。
 * 覆盖：架构解析（NVIDIA 四代 / AMD 三系 + 核显 / Intel / unknown）/ Sage 变体路由 /
 * 量化内核提示的保守口径 / stable-fast 跳过声明 / accel-chain 集成消费 / 文档同步 / 体积红线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { detectGpuArch, routeSageKernels, quantKernelVerdict, STABLE_FAST_SKIP, buildHwRouteSection } from '../lib/hw-route.js'
import { buildAccelChain } from '../lib/accel-chain.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0, fail = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('✓ ' + name); return }
  fail += 1
  fails.push(name)
  console.log('✗ ' + name, extra ?? '')
}
ok('自检：本文件 ok() 是「名称, 条件」顺序（写反自检占位）', true)

/* ---------------- §1 架构解析 ---------------- */

const d = (n) => detectGpuArch(n)
ok('RTX 5090 → Blackwell / sm_120', d('NVIDIA GeForce RTX 5090').arch === 'blackwell' && d('NVIDIA GeForce RTX 5090').sm === 'sm_120')
ok('RTX 4090 → Ada / sm_89', d('NVIDIA GeForce RTX 4090').arch === 'ada' && d('NVIDIA GeForce RTX 4090').sm === 'sm_89')
ok('RTX 3090 → Ampere', d('NVIDIA GeForce RTX 3090').arch === 'ampere')
ok('RTX 2060 → Turing', d('NVIDIA GeForce RTX 2060').arch === 'turing')
ok('GTX 1080 → Pascal', d('NVIDIA GeForce GTX 1080').arch === 'pascal')
ok('RX 7900 XT → RDNA3 / gfx1100', d('AMD Radeon RX 7900 XT').arch === 'rdna3' && d('AMD Radeon RX 7900 XT').sm === 'gfx1100')
ok('AMD 核显 → rdna-igpu（ROCm 不支持口径）', d('AMD Radeon(TM) Graphics').arch === 'rdna-igpu')
ok('RX 9070 → rdna4（映射 unverified）', d('AMD Radeon RX 9070 XT').arch === 'rdna4')
ok('Intel Arc → xe-arc', d('Intel(R) Arc(TM) Graphics').vendor === 'intel' && d('Intel Arc A770').arch === 'xe-arc')
ok('空 / 未知 → unknown（不猜）', d('').arch === 'unknown' && d('某神秘显卡').arch === 'unknown')

/* ---------------- §2 Sage 内核变体路由 ---------------- */

const s = (arch, vendor) => routeSageKernels({ arch, vendor })
ok('Blackwell → auto（构建匹配前提）', s('blackwell', 'nvidia').recommended === 'auto')
ok('Ada（40 系）→ fp8 建议', s('ada', 'nvidia').recommended === 'fp8')
ok('Ampere / Turing / Pascal → int8', s('ampere', 'nvidia').recommended === 'int8' && s('turing', 'nvidia').recommended === 'int8' && s('pascal', 'nvidia').recommended === 'int8')
ok('RDNA3 / 核显 / Arc → unsupported 且 applies:false', s('rdna3', 'amd').recommended === 'unsupported' && s('rdna3', 'amd').applies === false
  && s('rdna-igpu', 'amd').applies === false && s('xe-arc', 'intel').applies === false)
ok('节点提供 Triton 变体时如实标注（槽位仍未核实）', s('rdna3', 'amd', ).recommended === 'unsupported')
ok('全部建议 unverified（未实测不承诺）', [s('blackwell', 'nvidia'), s('ada', 'nvidia'), s('ampere', 'nvidia'), s('rdna3', 'amd')].every((x) => x.unverified === true))

/* ---------------- §3 量化内核感知提示（保守口径） ---------------- */

const q = (o) => quantKernelVerdict(o)
ok('未选量化档 → not-quantized（不提示）', q({ vendor: 'nvidia', tier: 'full', model: 'qwen-image' }).verdict === 'not-quantized'
  && q({ vendor: 'nvidia', tier: 'full' }).unverified === false)
ok('N 卡 + GGUF → unverified（内核在位无法经 HTTP 探测）', q({ vendor: 'nvidia', tier: 'gguf' }).verdict === 'unverified')
ok('A 卡 + GGUF 模型名 → memory-only（仅省显存不保证提速）', q({ vendor: 'amd', model: 'qwen-image-2.1-UC-Q4_K_M.gguf' }).verdict === 'memory-only')
ok('A 卡 + gguf 档 → memory-only', q({ vendor: 'amd', tier: 'gguf' }).verdict === 'memory-only')
ok('提示文案不承诺提速', !String(q({ vendor: 'amd', tier: 'gguf' }).note).includes('必然提速'))

/* ---------------- §4 stable-fast 跳过声明 ---------------- */

ok('stable-fast 声明 integrated:false 且四条理由', STABLE_FAST_SKIP.integrated === false && STABLE_FAST_SKIP.reasons.length === 4)
ok('buildHwRouteSection 拼装：架构 / Sage 建议 / 量化提示 / skipped 齐全',
  (() => { const sec = buildHwRouteSection({ deviceName: 'NVIDIA GeForce RTX 4090', tier: 'gguf' })
    return sec.detected.arch === 'ada' && sec.sage_route.recommended === 'fp8'
      && sec.quant_kernel.verdict === 'unverified' && sec.skipped[0].id === 'stable-fast'
      && typeof sec.reset_semantics === 'string' })())
ok('reset 语义写明「图内节点按生成插拔 + 启动级回退」', buildHwRouteSection({}).reset_semantics.includes('非全局 Monkey Patch'))

/* ---------------- §5 accel-chain 集成消费 ---------------- */

const report = buildAccelChain({ installed: [], deviceName: 'AMD Radeon RX 7900 XT', cfg: { tier: 'gguf' } })
ok('加速链报告带 hw_route 段', report.hw_route !== undefined && report.hw_route.detected.arch === 'rdna3')
ok('A 卡 + gguf 档在报告里得到 memory-only 提示', report.hw_route.quant_kernel.verdict === 'memory-only')
ok('加速链报告带 stable-fast 跳过声明', report.hw_route.skipped[0].id === 'stable-fast')
const reportUnknown = buildAccelChain({ installed: [], cfg: {} })
ok('无设备名 → unknown 如实（不猜）', reportUnknown.hw_route.detected.arch === 'unknown'
  && reportUnknown.hw_route.sage_route.recommended === 'auto')

/* ---------------- §6 注册层与文档点名同步 ---------------- */

ok('accel-chain 导入 hw-route（集成点）', read('lib/accel-chain.js').includes('buildHwRouteSection'))
ok('两份 llms 点名硬件感知路由与 stable-fast 跳过', read('llms.txt').includes('硬件感知路由') && read('llms.txt').includes('stable-fast')
  && read('docs/llms.txt').includes('硬件感知路由') && read('docs/llms.txt').includes('stable-fast'))
ok('README 点名', read('README.md').includes('硬件感知路由'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-hw-route.mjs'))

/* ---------------- §7 体积红线 ---------------- */

ok('lib/hw-route.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'hw-route.js')).size <= 262144)

console.log(`\n=== test-hw-route：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
