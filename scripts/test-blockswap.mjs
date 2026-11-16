/**
 * test-blockswap.mjs —— 极限低显存 Block 交换层（发现/报告/指引）专项回归。
 *
 * 断言风格：ok(名称, 条件)。全离线、零联网、零子进程。
 * 覆盖：目录事实（MIT / repo / 机制口径）/ 发现（模式匹配 + 未装如实）/ accel-chain
 * 集成消费（低显存提示 / 不代装口径）/ 工作流补丁诚实边界（needsSlotMapping）/
 * 注册层与文档点名同步 / 体积红线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BLOCKSWAP_BACKENDS, BLOCKSWAP_ENGINE_IDS, discoverBlockSwap, buildBlockSwapSection } from '../lib/blockswap.js'
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

/* ---------------- §1 目录事实 ---------------- */

ok('有且只有一个 block 交换后端（uniblockswap）', BLOCKSWAP_BACKENDS.length === 1
  && BLOCKSWAP_ENGINE_IDS.join(',') === 'uniblockswap')
ok('许可 MIT、repo 指向 smthemex', resolve0().license === 'MIT' && resolve0().repo === 'smthemex/ComfyUI_UniBlockSwap')
function resolve0() { return BLOCKSWAP_BACKENDS[0] }
ok('机制口径完整（-1 / 0 / >0 / ≥总块数 四态）', resolve0().mechanics.includes('-1') && resolve0().mechanics.includes('0 = 关闭')
  && resolve0().mechanics.includes('>0') && resolve0().mechanics.includes('等同 0'))
ok('安装指引是 git clone 且写明插件不代装', resolve0().installHint.includes('git clone')
  && resolve0().installHint.includes('不代装'))
ok('ComfyUI ≥0.35 dynamic 注意事项在案', resolve0().note.includes('dynamic'))
ok('klein9B 口径标 unverified', resolve0().note.includes('unverified'))

/* ---------------- §2 发现：模式匹配 + 未装如实 ---------------- */

ok('节点表含 UniBlockSwap → 发现', discoverBlockSwap({ installed: ['UniBlockSwapLoader', 'KSampler'] }).available === true)
ok('未装 → available:false + 如实理由', discoverBlockSwap({ installed: ['KSampler'] }).available === false
  && String(discoverBlockSwap({ installed: ['KSampler'] }).reason).includes('不代装'))
ok('发现命中返回节点类名', (() => { const r = discoverBlockSwap({ installed: ['UniBlockSwapLoader'] })
  return r.found[0].nodeNames.includes('UniBlockSwapLoader') })())

/* ---------------- §3 accel-chain 集成消费 ---------------- */

const report = buildAccelChain({ installed: [], cfg: {} })
ok('加速链报告带 blockswap 段', report.blockswap !== undefined)
ok('未装 → 报告 available:false 且理由在', report.blockswap.available === false
  && String(report.blockswap.reason).includes('不代装'))
ok('报告带安装指引（git clone）', JSON.stringify(report.blockswap.backends).includes('git clone'))
ok('工作流补丁诚实边界声明在案', String(report.blockswap.workflow_patching).includes('needsSlotMapping'))
const reportLow = buildAccelChain({ installed: [], vramMb: 6144, cfg: {} })
ok('低显存（6GB 档）给出可安装提示', String(reportLow.blockswap.lowvram_note).includes('显式安装'))
const reportHi = buildAccelChain({ installed: ['UniBlockSwapLoader'], vramMb: 20480, cfg: {} })
ok('已装节点 → 报告 available:true', reportHi.blockswap.available === true)
ok('高显存不给低显存提示', String(reportHi.blockswap.lowvram_note) === '')

/* ---------------- §4 注册层与文档点名同步 ---------------- */

ok('accel-chain 导入 blockswap（集成点）', read('lib/accel-chain.js').includes('buildBlockSwapSection')
  && read('lib/accel-chain.js').includes("from './blockswap.js'"))
ok('两份 llms 点名 UniBlockSwap 与不代装口径', read('llms.txt').includes('UniBlockSwap')
  && read('llms.txt').includes('不代装') && read('docs/llms.txt').includes('UniBlockSwap'))
ok('README 点名', read('README.md').includes('UniBlockSwap'))
ok('本套件已登记 SUITES', read('scripts/test-all.mjs').includes('test-blockswap.mjs'))

/* ---------------- §5 体积红线 ---------------- */

ok('lib/blockswap.js 未超 DSH Store 单文件上限', fs.statSync(path.join(ROOT, 'lib', 'blockswap.js')).size <= 262144)

console.log(`\n=== test-blockswap：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
