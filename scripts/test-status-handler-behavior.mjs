#!/usr/bin/env node
/**
 * status-handler 行为层测试（2026-11-20 补覆盖缺口③，勘察报告 #14）。
 *
 * 背景：lib/status-handler.js 现有 27 处**源码字符串锁**（white-bar/gap-fill/…），
 *   改名即失防 —— 本文件用**行为断言**直接 import makeStatusHandler 真跑 handler，
 *   不依赖任何源码字面量，字符串锁改名后防线仍在。
 *
 * 切片（deps 全 stub，只跑 handler 请求分发段）：
 *   ① 跨站拒：非本机请求 → 403 'local requests only'
 *   ② visits.ping 内存膨胀口：值长 ≤128、条数 ≤32 双封顶（★ 2026-11-17 审计补丁的行为级咬合）
 *
 * 纯离线：不联网、不需要 ComfyUI。
 */
import { makeStatusHandler } from '../lib/status-handler.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

/** 最小 deps：只有请求分发段会触到的项是真 mock，其余 stub（解构缺项=undefined，未触发不炸）。 */
const makeDeps = (overrides = {}) => ({
  cfg: {}, log: () => {}, idle: {}, status: { probe: async () => ({}) },
  visits: { api: 0, plain: 0, pings: [], firstAt: null, lastAt: null },
  respondJson: (res, body, code) => { res.__resp = { body, code } },
  isLocalRequest: (req) => req.__local === true,
  guardWriteRequest: () => null,
  readJsonBody: async () => ({}),
  sageReady: () => false, isMac: false, flowStyles: [], drawIntentModes: {},
  writeUiState: () => true, readUiState: () => ({}),
  readControls: () => ({}), videoParamsForSpeed: () => ({}), speedMap: {}, speedTiers: [],
  describeOptimization: () => [], diag: () => {}, defaultOutputDir: () => '',
  launch: {}, launchView: {}, LAUNCH_TIMEOUT_MS: 1000,
  ensureComfyUp: async () => {}, probeCapabilities: async () => ({}),
  launchMarkStarting: () => {}, launchMarkReady: () => {}, launchMarkFailed: () => {}, launchMarkTimeout: () => {},
  readLaunchLog: () => '', fatalLineInLog: () => null, launchFailedDueToSage: () => false,
  persistVideoModelChoice: async () => ({}), persistTtsChoice: async () => ({}),
  weightFilesFromObjectInfo: () => [], loadObjectInfoFor: async () => ({}),
  ...overrides,
})
const handler = (deps) => makeStatusHandler(deps)
const run = async (deps, url, { method = 'GET', local = true } = {}) => {
  const res = {}
  await handler(deps)({ url, method, __local: local }, res)
  return res
}

console.log('— 跨站拒')
{
  const deps = makeDeps()
  const res = await run(deps, '/comfy-status', { local: false })
  ok('★ 非本机请求 → 403 且 reason=local requests only',
    res.__resp?.code === 403 && res.__resp?.body?.reason === 'local requests only',
    JSON.stringify(res.__resp))
  ok('403 时 visits 仍已计数（计数在围栏之前，防跨站探测节奏）',
    deps.visits.plain === 1 && deps.visits.api === 0, JSON.stringify(deps.visits))
}

console.log('— visits.ping 膨胀口')
{
  const deps = makeDeps()
  for (let i = 0; i < 40; i += 1) {
    await run(deps, `/comfy-status?ping=r${i}`)
  }
  ok('★ ping 条数封顶 32（40 个不同 ping 不撑爆数组）',
    deps.visits.pings.length === 32 && deps.visits.pings[0] === 'r0' && deps.visits.pings[31] === 'r31',
    JSON.stringify(deps.visits.pings.slice(0, 3)) + `…len=${deps.visits.pings.length}`)
  const deps2 = makeDeps()
  await run(deps2, `/comfy-status?ping=${'x'.repeat(200)}`)
  ok('★ 单值长度 ≤128（200 字符 ping 不收）', deps2.visits.pings.length === 0,
    JSON.stringify(deps2.visits.pings))
  await run(deps2, '/comfy-status?ping=')
  ok('空 ping 不收', deps2.visits.pings.length === 0)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
