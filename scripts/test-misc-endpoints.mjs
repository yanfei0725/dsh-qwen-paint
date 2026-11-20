#!/usr/bin/env node
/**
 * scripts/test-misc-endpoints.mjs —— misc-endpoints 工厂「四端点 handler 外置」行为护栏。
 *
 * 背景（2026-11-20 节点⑧第二刀续作）：schema/controls/library/skills 四个
 * /api/comfy-pipeline/* 端点 handler 体从 lib/index.js 逐字搬到 lib/misc-endpoints.js，
 * reg 行留守 index.js 指向 miscHandlers.*。zcode 搬迁时曾手抄漏掉 controls 的 GET
 * 分支与 POST body 解析（后改 python 逐字搬修正）——本套专门锁住四个 handler 的
 * **真实行为分支**，防止"抄漏了但接线测试还是绿的"再次发生。
 *
 * 纯离线：schema/controls 走真模块只读快照（不联网），library/skills 走临时目录。
 * ok() 风格：(name, cond, extra) —— 与 test-reference-endpoints.mjs 一致。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMiscEndpoints } from '../lib/misc-endpoints.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-misc-endpoints-'))
const cfg = { outputDir: tmp }

const makeDeps = (overrides = {}) => ({
  cfg,
  log: () => {},
  status: { probe: async () => false },
  isLocalRequest: () => true,
  guardWriteRequest: () => true,
  respondJson: (res, body, code) => { res.__resp = { body, code: code ?? 200 } },
  readJsonBody: async () => (overrides.__body ?? {}),
  runRepair: async () => ({}),
  buildWizardReport: async () => ({}),
  readMemoryRecent: async () => [],
  readPreferences: async () => ({}),
  writePreferences: async () => ({}),
  ...overrides,
})

const run = async (handler, method, body) => {
  const res = {}
  const req = { url: '/', method }
  await handler(req, res)
  return res.__resp
}

const H = makeMiscEndpoints(makeDeps())

console.log('— 工厂导出完整（四个新 handler 必须存在）')
ok('工厂返回 schemaHandler/controlsHandler/libraryHandler/skillsHandler',
  ['schemaHandler', 'controlsHandler', 'libraryHandler', 'skillsHandler'].every((k) => typeof H[k] === 'function'))

console.log('— schema GET（buildSchemaSnapshot 真链路 + 非本地 403）')
{
  const r = await run(H.schemaHandler, 'GET')
  ok('schema GET 返回 ok:true 且带 schema 快照', r?.code === 200 && r?.body?.ok === true && !!r?.body?.schema)
  const denied = await run(makeMiscEndpoints(makeDeps({ isLocalRequest: () => false })).schemaHandler, 'GET')
  ok('schema 非本地请求 403', denied?.code === 403 && denied?.body?.ok === false)
}

console.log('— controls GET/POST 双分支（抄漏高发点）')
{
  const g = await run(H.controlsHandler, 'GET')
  ok('controls GET 返回 ok:true + controls/summary/path 三字段',
    g?.code === 200 && g?.body?.ok === true
    && g?.body?.controls !== undefined && g?.body?.summary !== undefined && g?.body?.path !== undefined)
  const p = await run(H.controlsHandler, 'POST')
  ok('controls POST 返回 ok:true + saved/reason/controls/summary 四字段（POST body 解析未丢）',
    p?.code === 200 && p?.body?.ok === true
    && 'saved' in p.body && 'reason' in p.body
    && p.body.controls !== undefined && p.body.summary !== undefined)
  const bad = await run(H.controlsHandler, 'DELETE')
  ok('controls 非 GET/POST 方法 405', bad?.code === 405 && bad?.body?.ok === false)
}

console.log('— library GET/POST 双分支')
{
  const g = await run(H.libraryHandler, 'GET')
  ok('library GET 返回 ok:true + dir/styles/selected/instruction/skills/skillsAvailable',
    g?.code === 200 && g?.body?.ok === true
    && ['dir', 'styles', 'selected', 'instruction', 'skills', 'skillsAvailable'].every((k) => k in g.body))
  const p = await run(H.libraryHandler, 'POST')
  ok('library POST 返回 ok:true + saved/reason/selected/instruction/skills',
    p?.code === 200 && p?.body?.ok === true
    && ['saved', 'reason', 'selected', 'instruction', 'skills'].every((k) => k in p.body))
  const denied = await run(makeMiscEndpoints(makeDeps({ isLocalRequest: () => false })).libraryHandler, 'GET')
  ok('library 非本地请求 403', denied?.code === 403 && denied?.body?.ok === false)
}

console.log('— skills GET（只读清单）')
{
  const g = await run(H.skillsHandler, 'GET')
  ok('skills GET 返回 ok:true + skills 数组',
    g?.code === 200 && g?.body?.ok === true && Array.isArray(g?.body?.skills))
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响断言 */ }

console.log(`\n=== test-misc-endpoints：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓')
