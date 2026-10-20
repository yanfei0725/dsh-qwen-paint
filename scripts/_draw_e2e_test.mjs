/**
 * _draw_e2e_test.mjs —— **端到端真机出图测试**（需要 ComfyUI 在 8188 跑着）。
 *
 * ## 为什么必须做这个
 *   「出的图尺寸不对」是**行为 bug**，静态扫描和 mock 抓不到 ——
 *   必须真的走一遍 `makeDrawTool` 的完整流程：
 *     提交 → 等待 → 取图 → **尺寸校验** → 落盘 → 返回值
 *   才能确认"锁尺寸档下归一后不再误报"。
 *
 * ## 它验什么
 *   1. 请求一个会被归一的尺寸（864x1152 → 1024x1024）
 *   2. 断言**不抛错**（修复前必然抛 "ComfyUI 出的图尺寸不对"）
 *   3. 断言落盘文件名用的是**生效尺寸**（1024x1024）
 *   4. 断言返回值 width/height 是**生效尺寸**，且带 requestedWidth/Height
 *   5. 断言落盘的 PNG 真实尺寸 = 生效尺寸
 *
 * 用法：node scripts/_draw_e2e_test.mjs
 * 未检测到 ComfyUI 时会**明确跳过**（不算失败，但要如实说明）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DSHQP_DIAG = '0'
const ROOT = path.resolve(import.meta.dirname, '..')
const mod = await import('file://' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))
const { DEFAULTS, makeDrawTool } = mod.__internal

const COMFY = 'http://127.0.0.1:8188'

// ---- 0. ComfyUI 在不在 ----
let online = false
try {
  const r = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(3000) })
  online = r.ok
} catch { online = false }

if (!online) {
  console.log(`⚠ ComfyUI (${COMFY}) 不在线 → **跳过端到端出图测试**（不算失败）`)
  console.log('  想跑完整测试：先启动 ComfyUI 再重跑本脚本。')
  process.exit(0)
}
console.log(`✓ ComfyUI 在线（${COMFY}）`)

let pass = 0
let fail = 0
const ok = (n, x) => { pass++; console.log('  OK  ', n, x ?? '') }
const bad = (n, x) => { fail++; console.log('  FAIL', n, x ?? '') }

// ---- 1. 造一个最小可用的 ctx / log ----
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) },
  get: () => undefined,
  effect: () => () => {},
  inject: () => () => {},
  tools: { register: () => {} },
}   // 注意：这里不碰服务属性（Proxy 陷阱），本测试也不需要真 cordis

const log = (level, msg) => { logs.push([level, msg]); if (level === 'error') console.log('   [log:error]', msg) }

const cfg = { ...DEFAULTS, comfyUrl: COMFY, outputDir: path.join(os.tmpdir(), '_qwen_e2e') }

const tool = makeDrawTool(ctx, cfg, log, null, () => {})
if (typeof tool?.execute !== 'function') {
  console.log('✗ makeDrawTool 返回的没有 execute，测试无法继续')
  process.exit(1)
}

console.log('\n=== 端到端出图：选 3:4 比例 1.0MP（应原样出 864x1152）===')
// ★ 真实入参是 `size`（比例）+ `megapixels`，尺寸由 calcSize 换算。
//   3:4 × 1.0MP = 864x1152 —— 这是**界面上选"3:4"就会拿到**的请求值。
//
// ★★★ 2026-10-09 主人决定「完全听调用方」后，`forceOptimizedSize` 默认 false：
//     比例必须**原样生效**（864x1152 就是 864x1152），不再归一成方图。
//     本测试同时验两种模式（见文件末尾的"锁档回归"一节）。
const REQ_SIZE = '3:4'
const REQ_MP = 1.0
const EXPECT_W = 864
const EXPECT_H = 1152

let value = null
let threw = null
const t0 = Date.now()
try {
  value = await tool.execute(
    { prompt: '一只戴草帽的橘猫坐在窗台上，午后阳光', size: REQ_SIZE, megapixels: REQ_MP },
    { agent: undefined, signal: undefined },
  )
} catch (e) {
  threw = e
}
const seconds = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  （耗时 ${seconds}s）`)

// ---- 断言 1：不抛错（修复前这里必抛"尺寸不对"）----
if (threw) {
  bad('未抛错', `抛了：${threw.message?.slice(0, 200)}`)
  const idx = logs.findIndex(([, m]) => /尺寸不对/.test(m))
  if (idx >= 0) console.log('   → 日志定位：', logs[idx][1].slice(0, 200))
} else {
  ok('未抛错（修复前这里必然抛「尺寸不对」）')
}

if (!value) {
  console.log(`\n=== 结果：失败 ${fail} 项（出图未成功，后续断言无法进行）===`)
  console.log('--- 日志尾部 ---')
  for (const [lv, m] of logs.slice(-15)) console.log(`  [${lv}] ${m}`)
  process.exit(1)
}

// ---- 断言 2：返回值 = 请求尺寸（完全听调用方）----
if (value.width === EXPECT_W && value.height === EXPECT_H) {
  ok(`返回值尺寸 = 请求尺寸 ${EXPECT_W}x${EXPECT_H}（比例未被吞掉）`)
} else {
  bad('返回值尺寸被改动', `实际 ${value.width}x${value.height}，期望 ${EXPECT_W}x${EXPECT_H}`)
}

// ---- 断言 3：没被归一时不应出现 requestedWidth（它只在被改动时才有）----
if (value.requestedWidth === undefined) {
  ok('未被归一 → 不冗余带 requestedWidth（返回值干净）')
} else {
  bad('出现了 requestedWidth，说明尺寸被改动了', `${value.requestedWidth}x${value.requestedHeight}`)
}

// ---- 断言 4：文件名用生效尺寸 ----
const base = path.basename(value.path)
if (base.includes(`${EXPECT_W}x${EXPECT_H}`)) ok(`落盘文件名含正确尺寸：${base}`)
else bad('落盘文件名尺寸不对', base)

// ---- 断言 5：真实 PNG 尺寸 = 返回值 ----
try {
  const buf = readFileSync(value.path)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w === EXPECT_W && h === EXPECT_H) ok(`PNG 实际尺寸 = ${EXPECT_W}x${EXPECT_H}（与返回值一致）`)
  else bad('PNG 实际尺寸与返回值不一致', `${w}x${h}`)
} catch (e) {
  bad('读 PNG 失败', e.message)
}

// ---- 断言 6：默认档下**不应**出现"归一"日志（那是锁档才有的）----
if (!logs.some(([, m]) => /尺寸已按优化档归一/.test(m))) {
  ok('默认档未发生尺寸归一（比例原样生效）')
} else {
  bad('默认档下竟然发生了归一 —— 比例被吞掉了')
}

console.log('\n--- 关键日志 ---')
for (const [lv, m] of logs.filter(([, m]) => /归一|提交任务|落盘/.test(m)).slice(0, 8)) {
  console.log(`  [${lv}] ${m}`)
}

/* --------------------------------------------------------------------------
 * ★ 锁档回归（纯函数，不出图）：确认"锁尺寸"这条老路径**没被改坏**。
 *   万一以后有人把 forceOptimizedSize 设回 true，归一必须仍然正确、
 *   且调用方拿到的 effective 依然是归一后的值（否则误报会复发）。
 * ------------------------------------------------------------------------ */
console.log('\n=== 锁档回归（纯函数，不出图）===')
{
  const { buildWorkflow } = mod.__internal
  const caps = { level: 'full', models: {}, useTurbo: false, usePrefix: false, useTe: false, useSpeedup: false }
  const locked = buildWorkflow(
    { forceOptimizedSize: true, resolution: 1024 },
    { prompt: 't', width: EXPECT_W, height: EXPECT_H, steps: 8, seed: 1, reference: '' },
    caps,
  )
  const le = locked.__effective
  if (le && le.width === 1024 && le.height === 1024 && le.locked === true) {
    ok('锁档仍能把 864x1152 归一为 1024x1024，且 locked=true')
  } else {
    bad('锁档归一出错', JSON.stringify(le))
  }
  if (!JSON.stringify(locked).includes('__effective')) ok('锁档下 __effective 也不污染 JSON')
  else bad('锁档下 __effective 泄漏进 JSON')
}

console.log(`\n=== 结果：${fail === 0 ? '通过' : `失败 ${fail} 项`} ===`)
process.exit(fail === 0 ? 0 : 1)
