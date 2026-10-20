/**
 * ★ 2026-10-09 二次修正：互斥 wrapper 按尺寸自动选 —— 回归测试。
 *
 * 核心主张（全部来自这台机器上的实测，不是估）：
 *   · 小尺寸（latent ≤ 16384 tokens，如 992²/1024²）→ TE-Speed + Speedup 实测 +25.4%
 *   · 大尺寸（latent >  16384 tokens，如 1408²=30976）→ BlockCache T8 实测 +22.7%
 *   · 三者争抢同一组 DIFFUSION_MODEL wrapper，必须**互斥**（同挂会 ValueError 整单失败）
 *
 * ⚠ 互斥的语义：是「(TE-Speed + Speedup) 这一组」与「BlockCache」互斥；
 *   **TE-Speed 和 Speedup 本身可以同时开**（这正是"TE+Speedup 组合"）。
 *   所以正确的硬断言是：blockCache 为 true 时 te/speedup 必须都 false。
 *
 * ⚠ 第 5 个参数 caps 必须传（buildWorkflow 里就是传的）—— 不传会让 has() 恒真，
 *   这个坑我自己踩过一回，下面每个调用都显式带 caps。
 *
 * 用法：node scripts/_wrapper_policy_test.mjs
 */
import { __internal as I } from '../lib/index.js'

let fail = 0
const assert = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }
// ★ 互斥硬断言（正确语义）：blockCache=true ⇒ te/speedup 都 false；blockCache=false 不限制
const mutexOk = (r) => (r.blockCache ? (!r.te && !r.speedup) : true)

// 完整 caps（三个节点都装了）
const fullCaps = { nodes: { teSpeed: true, speedup: true, blockCache: true } }
const noBcCaps = { nodes: { teSpeed: true, speedup: true } } // 没装 BlockCache 节点

// plan 里始终带 turbo8；caps 单独作为第 5 参数
const plan = (over = {}) => ({ useTurbo: true, useTe: true, useSpeedup: true, useBlockCache: true, ...over })
// 一份"节点齐全、所有开关都开"的 cfg（auto 模式）
const autoCfg = (over = {}) => ({
  wrapperPolicy: 'auto', wrapperAutoTokensThreshold: 16384,
  blockCacheEnabled: true, teSpeedEnabled: true, speedupEnabled: true, ...over,
})

const pick = (cfg, c, w, h, overridePlan = {}) => I.pickWrapperSet(cfg, plan(overridePlan), w, h, c)

console.log('=== 1. auto 模式：小尺寸走 TE+Speedup ===')
{
  const r = pick(autoCfg(), fullCaps, 992, 992)
  assert('992² 判定为小尺寸（tokens=15376 ≤ 16384）', r.tokens === 15376)
  assert('992² → te=true', r.te === true)
  assert('992² → speedup=true', r.speedup === true)
  assert('992² → blockCache=false', r.blockCache === false)
  assert('★ 互斥（blockCache=false 合法）', mutexOk(r))
}

console.log('\n=== 2. auto 模式：1024² 边界（=16384 仍算小尺寸） ===')
{
  const r = pick(autoCfg(), fullCaps, 1024, 1024)
  assert('1024² tokens=16384 = 阈值', r.tokens === 16384)
  assert('1024² → 走 TE+Speedup（≤ 阈值）', r.te && r.speedup && !r.blockCache)
  assert('★ 互斥', mutexOk(r))
}

console.log('\n=== 3. auto 模式：1408² 走 BlockCache T8 ===')
{
  const r = pick(autoCfg(), fullCaps, 1408, 1408)
  assert('1408² 判定为大尺寸（tokens=30976 > 16384）', r.tokens === 30976)
  assert('1408² → blockCache=true', r.blockCache === true)
  assert('1408² → te=false（让位）', r.te === false)
  assert('1408² → speedup=false（让位）', r.speedup === false)
  assert('★ 互斥（blockCache=true 时 te/speedup 必 false）', mutexOk(r))
  assert('reason 点名了 TE 0% 这个实测事实', r.reason.includes('0%'))
}

console.log('\n=== 4. policy=te：任意尺寸都走 TE+Speedup ===')
{
  const r = pick(autoCfg({ wrapperPolicy: 'te' }), fullCaps, 1408, 1408)
  assert('te 模式 1408² → te=true', r.te === true)
  assert('te 模式 1408² → speedup=true', r.speedup === true)
  assert('te 模式 1408² → blockCache=false', r.blockCache === false)
  assert('★ 互斥', mutexOk(r))
}

console.log('\n=== 5. policy=bc：任意尺寸都走 BlockCache ===')
{
  const r = pick(autoCfg({ wrapperPolicy: 'bc' }), fullCaps, 992, 992)
  assert('bc 模式 992² → blockCache=true', r.blockCache === true)
  assert('bc 模式 992² → te=false', r.te === false)
  assert('bc 模式 992² → speedup=false', r.speedup === false)
  assert('★ 互斥', mutexOk(r))
}

console.log('\n=== 6. 互斥硬保证：BlockCache 节点没了 → 不强行上，退回 TE+Speedup ===')
{
  const r1 = pick(autoCfg(), noBcCaps, 1408, 1408)
  assert('大尺寸但没 BlockCache 节点 → 退回 te+speedup', r1.te && r1.speedup && !r1.blockCache)
  assert('★ 互斥', mutexOk(r1))
}

console.log('\n=== 7. 互斥硬保证：blockCacheEnabled=false → 退回 TE+Speedup ===')
{
  const r2 = pick(autoCfg({ blockCacheEnabled: false }), fullCaps, 1408, 1408)
  assert('blockCacheEnabled=false → 退回 te+speedup', r2.te && r2.speedup && !r2.blockCache)
  assert('★ 互斥', mutexOk(r2))
}

console.log('\n=== 8. 极端：caps 不传（老行为）= 能力齐全 ===')
{
  // ★ 这里特意验证"不传 caps"会退化成"齐全"（has 的 `caps===undefined` 分支）
  const r = I.pickWrapperSet(autoCfg(), plan(), 1408, 1408)
  assert('caps 缺失时按"齐全"处理，大尺寸走 BlockCache', r.blockCache === true && r.te === false)
  assert('★ 互斥', mutexOk(r))
}

console.log('\n=== 9. 默认配置不容错（DEFAULTS） ===')
{
  const d = I.DEFAULTS
  assert('DEFAULTS.wrapperPolicy === auto', d.wrapperPolicy === 'auto')
  assert('DEFAULTS.wrapperAutoTokensThreshold === 16384', d.wrapperAutoTokensThreshold === 16384)
  assert('DEFAULTS.blockCacheEnabled === true（auto 要让大尺寸能上 BC）', d.blockCacheEnabled === true)
}

console.log('\n=== 10. 尺寸边界扫描：token 刚好过阈值的那一档必须切到 BC ===')
{
  // token 公式 = round(W/8)*round(H/8)。阈值 16384 是边界（=1024²）。
  // 要越阈需 round(w/8)=129，即 w∈[1028,1035]（1028/8=128.5 四舍五入=129）。
  // 取 1032²：round(1032/8)=129，129×129=16641 > 16384 → 必须切到 BC。
  const r = pick(autoCfg(), fullCaps, 1032, 1032)
  assert('1032²（16641 tokens）> 16384 → BlockCache', r.blockCache === true && r.te === false && r.speedup === false)
  assert('★ 互斥', mutexOk(r))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
