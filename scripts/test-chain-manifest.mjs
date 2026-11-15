/**
 * scripts/test-chain-manifest.mjs —— 2026-11-15：三条链的统一声明式清单目录回归。
 *
 * 待办「生图/TTS 链未清单化」的真实状态：契约清单和指纹早就有，但 /workflows
 * 只列运行时 manifest，看起来像没做。本轮用 lib/chain-manifest.js 把三处合成
 * 一张可查询、可体检的总账，并让预设绑定去掉 pending。**运行时仍不接管**：
 * 生图/TTS 分支多、节点要在线探测，做成 JSON 提交会变 JS/JSON 双轨半迁移。
 *
 * 守四条：
 *   ① 每条声明的契约 / 清单元数据 / 指纹夹具都真实存在；
 *   ② runtime 链恰好一条（不许假装生图链也按 JSON 提交）；
 *   ③ 指纹夹具 id 与 JSON 文件逐字相等（允许重复、强制同步）；
 *   ④ 新模块有生产 import（只有测试引用不算接线）。
 *
 * ⚠ 本文件统一用 ok(cond, label) 顺序；helper 内建写反自检。
 *
 * 运行：node scripts/test-chain-manifest.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHAIN_DECLARATIONS, CHAIN_MANIFEST_VERSION, FINGERPRINT_FIXTURES,
  listChainDeclarations, verifyChainDeclarations, summarizeChains,
} from '../lib/chain-manifest.js'
import { listContracts, loadContract } from '../lib/graph-audit.js'
import { listManifests, loadManifest } from '../lib/workflow-manifest.js'
import { PRESET_BINDINGS, checkPresetBindings } from '../lib/workflow-presets.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const fails = []

/** ⚠ 参数顺序：cond 在前，label 在后。写反（ok(true, true)）必须当场抛。 */
function ok(cond, label) {
  if (typeof label !== 'string') throw new Error('ok() 参数顺序写反：必须是 (cond, label)')
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

console.log('=== 1. 链总账本身 ===')
ok(CHAIN_MANIFEST_VERSION === 1, '链总账 schema 版本为 1')
ok(CHAIN_DECLARATIONS.length === 4, `总账登记 4 条链（实际 ${CHAIN_DECLARATIONS.length}）`)
ok(['image', 'video', 'tts'].every((k) => CHAIN_DECLARATIONS.some((d) => d.kind === k)),
  '★ 生图 / 视频 / TTS 三种链都在总账里')
ok(CHAIN_DECLARATIONS.every((d) => d.id && d.build && d.verify && d.note),
  '每条链都写明「谁构图 / 怎么核对 / 为什么这样做」')
ok(listChainDeclarations().every((d) => Array.isArray(d.fingerprints)),
  'listChainDeclarations 返回可序列化副本')
ok(Object.isFrozen(CHAIN_DECLARATIONS) && Object.isFrozen(FINGERPRINT_FIXTURES),
  '总账与夹具清单是冻结常量（不许运行时偷改）')

console.log('=== 2. 声明的来源真实存在（不靠想象） ===')
const contracts = listContracts()
const manifests = listManifests()
ok(contracts.length === 3, `契约文件 3 份（实际 ${contracts.length}）`)
ok(manifests.includes('video-wan22'), '运行时清单 video-wan22 存在')
const errs = verifyChainDeclarations()
ok(errs.length === 0, `★ 默认体检零错误（实际：${errs.join(' / ') || '无'}）`)
for (const d of CHAIN_DECLARATIONS) {
  if (!d.contract) continue
  const c = loadContract(d.contract)
  ok(Object.keys(c.roles || {}).length > 0, `契约 ${d.contract} 真的能读且定义了角色`)
}
ok(loadManifest('video-wan22').authoritative === 'runtime',
  '★ video-wan22 清单自己标 authoritative=runtime（与总账一致）')

console.log('=== 3. runtime 唯一性 + 故意改坏会红 ===')
const sum = summarizeChains()
ok(sum.runtime_chains.length === 1 && sum.runtime_chains[0] === 'video-wan22',
  '★ runtime 链恰好 1 条且是 video-wan22（不假装生图链按 JSON 提交）')
ok(sum.by_authority.contract === 3 && sum.by_authority.runtime === 1,
  '★ 三条契约链 + 一条运行时链的口径明确')
ok(CHAIN_DECLARATIONS.filter((d) => d.authoritative === 'contract')
  .every((d) => d.build && !d.manifest), '★ contract 链不挂 manifest（没有第二条提交路径）')
ok(verifyChainDeclarations({ contracts: [], manifests }).length > 0,
  '★ 契约缺件时体检会红（反向核查：不是无条件放行）')
ok(verifyChainDeclarations({ contracts, manifests: [] }).length > 0,
  '★ 运行时清单缺件时体检会红')
ok(verifyChainDeclarations({ contracts, manifests, fingerprints: [] }).length > 0,
  '★ 指纹夹具缺件时体检会红')

console.log('=== 4. 指纹夹具逐字同步 ===')
const fp = JSON.parse(read('scripts/workflow-fingerprints.json'))
const actual = Object.keys(fp.fixtures || {}).sort()
ok([...FINGERPRINT_FIXTURES].sort().join(',') === actual.join(','),
  '★ 总账里的夹具 id 与 workflow-fingerprints.json 逐字相等（防漂移）')
ok(fp._why.includes('契约清单化') && fp._why.includes('双轨半迁移'),
  '★ 指纹文件的 _why 已同步新口径（不再写「暂不做清单化」）')
ok(read('scripts/test-runtime-guards.mjs').includes('已按契约清单化'),
  '★ --update 重建指纹时的 _why 字面量也同步了')

console.log('=== 5. 预设绑定去 pending + 端点接线 ===')
ok(PRESET_BINDINGS.every((p) => p.pending !== true), '★ 预设表里已无 pending 项')
ok(PRESET_BINDINGS.filter((p) => p.authoritative === 'contract').length === 2,
  '★ 两条生图预设标 authoritative=contract')
ok(checkPresetBindings(manifests, contracts).length === 0,
  '★ 传契约 id 后预设绑定真校验且零错误')
ok(checkPresetBindings(manifests, []).length > 0,
  '★ 契约缺失时预设绑定会红（真校验，不是摆设）')
const cfg = read('lib/config-endpoints.js')
ok(cfg.includes("from './chain-manifest.js'"), '★ config-endpoints.js 真实 import 链总账（生产接线）')
ok(['listChainDeclarations()', 'verifyChainDeclarations(', 'summarizeChains()',
  'checkPresetBindings(ids, listContracts())'].every((s) => cfg.includes(s)),
  '★ /workflows 端点真的吐出 chains / chain_errors / chain_summary')
ok(cfg.includes("preset_unverified: PRESET_BINDINGS.filter((p) => p.pending === true)"),
  '★ preset_unverified 保留兼容字段，但已恒为空')
ok(read('lib/tool-registry.js').includes("from './chain-manifest.js'") === false,
  '链总账由端点直接消费，不需要再塞进工具注册层')
ok(!read('docs/llms.txt').includes('生图链未清单化'),
  '公开文档里没有「未清单化」的过期说法')

console.log(`=== test-chain-manifest：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1) }
