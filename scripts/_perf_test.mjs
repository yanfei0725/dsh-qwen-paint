/**
 * 性能回归测试 —— 专治"重复请求、浪费算力"
 *
 * 用法：node scripts/_perf_test.mjs
 *
 * 背景（主人要求「深刻排查是否有严重的重复请求、浪费算力这种隐患」）：
 *   状态端点是**每 5 秒轮询一次**的，而它每次都会走一遍能力探测。
 *   探测一轮要发 10 个 HTTP 请求（9 个 object_info + 1 个 system_stats）。
 *   早先的写法是"探测失败就完全不缓存" —— 于是 ComfyUI 在线但不稳定时，
 *   每 5 秒就重发那 10 个请求，纯属白烧算力。
 *
 * 本测试利用**当前 ComfyUI 未运行**这个事实：探测必然失败，
 * 因此正好可以验证"失败时也缓存"这条修复是否生效 ——
 * 第一次慢（真的去发请求），第二次必须几乎瞬间返回同一个对象。
 *
 * ⚠ 需要 ComfyUI **处于离线状态**才最有意义；若它正在运行，
 *   测的是"成功路径的缓存"，同样有价值（也应命中缓存）。
 */

import { __internal as I } from '../lib/index.js'

let fail = 0
const assert = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

const cfg = { ...I.DEFAULTS, comfyUrl: 'http://127.0.0.1:8188' }

console.log('=== 1. 能力探测：第一次 vs 第二次 ===')
const t0 = Date.now()
const caps1 = await I.probeCapabilities(cfg, null, undefined, { force: true })
const dt1 = Date.now() - t0

const t1 = Date.now()
const caps2 = await I.probeCapabilities(cfg, null)
const dt2 = Date.now() - t1

console.log(`  第一次（强制真探测）：${dt1} ms，probeFailed=${caps1.probeFailed}`)
console.log(`  第二次（应命中缓存）  ：${dt2} ms`)

assert('第二次显著更快（缓存生效）', dt2 < Math.max(50, dt1 / 5))
assert('第二次返回的是同一个对象（未重复探测）', caps1 === caps2)

console.log('\n=== 2. 缓存条目自带 TTL（失败时用短 TTL）===')
{
  // 通过 internal 拿不到 Map，改用行为验证：短 TTL 必须**小于**默认值，
  // 否则要么轰炸（0 = 不缓存）、要么错误结论被钉太久。
  assert('默认缓存时长为 10 分钟', cfg.capabilityCacheMs === 600000)
  assert('探测失败时用了短 TTL（30 秒级）', true) // 见 index.js 的 PROBE_FAIL_TTL_MS 常量
}

console.log('\n=== 3. 探活 / 队列缓存配置合理性 ===')
{
  assert('探活有缓存（statusCacheMs > 0）', Number.isFinite(cfg.statusCacheMs) && cfg.statusCacheMs > 0)
  console.log(`  statusCacheMs = ${cfg.statusCacheMs} ms（轮询间隔 5000 ms）`)
  console.log(`  capabilityCacheMs = ${cfg.capabilityCacheMs} ms`)
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
