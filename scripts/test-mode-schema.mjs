#!/usr/bin/env node
/**
 * v3 §15.4 第 1 步 + 第 3 步回归：
 *   - ETA 方向（speed 越小越快）与 16→4 档量化
 *   - GET /api/comfy-pipeline/schema JSON 桥接（前端零 import、端点同源）
 * 纯干跑：不联网、不出图、不需要 ComfyUI 运行。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  MODES, CONTROLS, SPEED_MAP, SPEED_TIERS,
  quantizeSpeedPercent, estimateEtaMs, buildSchemaSnapshot,
} from '../lib/mode-schema.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- 1. 16 档 slider 全落到 4 档 ----
ok('SPEED_TIERS 恰为 [25,50,75,100]',
  JSON.stringify(SPEED_TIERS) === JSON.stringify([25, 50, 75, 100]))
const sliderValues = Array.from({ length: 16 }, (_, i) => 25 + i * 5)
ok('slider 恰生成 25..100 共 16 档',
  sliderValues.length === 16 && sliderValues[0] === 25 && sliderValues[15] === 100)
ok('16 档量化结果全部 ∈ SPEED_TIERS',
  sliderValues.every((v) => SPEED_TIERS.includes(quantizeSpeedPercent(v))),
  sliderValues.map((v) => `${v}→${quantizeSpeedPercent(v)}`).join(' '))
ok('端点值 25→25 / 100→100',
  quantizeSpeedPercent(25) === 25 && quantizeSpeedPercent(100) === 100)
ok('就近吸附 35→25 / 40→50 / 60→50 / 65→75 / 85→75 / 90→100',
  quantizeSpeedPercent(35) === 25 && quantizeSpeedPercent(40) === 50
  && quantizeSpeedPercent(60) === 50 && quantizeSpeedPercent(65) === 75
  && quantizeSpeedPercent(85) === 75 && quantizeSpeedPercent(90) === 100)
ok('非数/超界也不抛且落四档之一',
  [NaN, -1, 0, 120, undefined].every((v) => SPEED_TIERS.includes(quantizeSpeedPercent(v))))

// ---- 2. ETA 方向：正比于 speed，speed 越小越快 ----
const base = 100000
const etaAt = (speed) => estimateEtaMs({ baseMs: base, speed, frames: 49, height: 720 })
ok('ETA(speed=100) 等于 baseMs', etaAt(100) === base, String(etaAt(100)))
ok('ETA(speed=25) 约为 baseMs/4', etaAt(25) === Math.round(base * 0.25), String(etaAt(25)))
ok('ETA 随 speed 单调递增（25<50<75<100）',
  SPEED_TIERS.every((t, i) => i === 0 || etaAt(SPEED_TIERS[i - 1]) < etaAt(t)),
  SPEED_TIERS.map((t) => `${t}:${etaAt(t)}`).join(' '))
ok('ETA 与 frames 成正比',
  estimateEtaMs({ baseMs: base, speed: 100, frames: 98, height: 720 }) === 2 * base)
ok('ETA 与 (h/720)² 成正比',
  estimateEtaMs({ baseMs: base, speed: 100, frames: 49, height: 1440 }) === 4 * base)
ok('baseMs 缺失/非法返回 0 不抛',
  estimateEtaMs({}) === 0 && estimateEtaMs({ baseMs: -1 }) === 0)

// ---- 3. schema 快照与桥接 ----
const snap = buildSchemaSnapshot()
ok('snapshot 可 JSON 序列化', typeof JSON.stringify(snap) === 'string')
ok('snapshot.speedTiers 与导出 SPEED_TIERS 一致',
  JSON.stringify(snap.speedTiers) === JSON.stringify(SPEED_TIERS))
ok('snapshot.modes 含 image/video/hybrid',
  ['image', 'video', 'hybrid'].every((id) => snap.modes.some((m) => m.id === id)))
ok('snapshot.speedMap 四档齐全（image/video）',
  ['image', 'video'].every((k) => SPEED_TIERS.every((t) => snap.speedMap[k][t] !== undefined)))
ok('MODES 恰 3 个模式', MODES.length === 3)
ok('CONTROLS.common.speedPercent 为 25..100 step5（16 档）',
  (() => { const c = CONTROLS.common.find((x) => x.key === 'speedPercent'); return !!c && c.min === 25 && c.max === 100 && c.step === 5 })())
ok('SPEED_MAP.image/video 四档键齐',
  ['image', 'video'].every((k) => SPEED_TIERS.every((t) => SPEED_MAP[k][t] !== undefined)))
ok('ETA 一律标「估算」且公式含 speed/100',
  snap.eta.label === '估算' && snap.eta.formula.includes('speed/100'))

// ---- 4. 桥接落点：host 注册端点、前端 fetch、零静态 import ----
const indexSrc = read('lib/index.js')
const clientSrc = read('lib/client.js')
const HOST_PATH = '/api/comfy-pipeline/schema'
const CLIENT_PATH = 'api/comfy-pipeline/schema'
ok('index.js 注册 GET /api/comfy-pipeline/schema',
  indexSrc.includes(`reg('${HOST_PATH}'`) && indexSrc.includes('buildSchemaSnapshot'))
ok('client.js 用 fetch 读同源 schema 并挂 window.ComfyPipelineSchema',
  clientSrc.includes(`fetch('${CLIENT_PATH}'`) && clientSrc.includes('window.ComfyPipelineSchema'))
ok('client.js 零静态 import/export（非 ESM 单入口硬约束）',
  !/^[ \t]*import\s/m.test(clientSrc) && !/^[ \t]*export\s/m.test(clientSrc))
ok('mode-schema.js 只在 host 侧被 import，client.js 不 import/require 它',
  !/import[^;\n]*mode-schema/.test(clientSrc) && !/require\([^)]*mode-schema/.test(clientSrc))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
