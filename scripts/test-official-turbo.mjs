#!/usr/bin/env node
/**
 * official-turbo 门矩阵测试（2026-11-20 补覆盖缺口②，勘察报告 #14）。
 *
 * 背景：lib/official-turbo.js 是官方 Qwen-Image 2.1 Turbo 的**单一判定入口**
 *   （面板/计划/日志三处同源），此前只有 1 条正向间接断言（经 config 路径），
 *   门条件矩阵零单元触及、文件零源码锁。
 *
 * 矩阵：模型存在性 × 节点存在性 × 4 个互斥让位门（enabled=false / 显式覆写 /
 *   4 步档 / native 文本控制）+ 门优先序 + 大小写口径。
 *
 * 纯离线：resolveOfficialTurbo 是零依赖零 I/O 纯函数。
 */
import { resolveOfficialTurbo } from '../lib/official-turbo.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const capsOk = () => ({ models: { officialTurbo: 'qwen_image_turbo.safetensors' }, nodes: { officialSampling: true } })
const cfgOk = () => ({ officialTurboEnabled: true, mainModelOverride: '', fast4Enabled: false, textControl: 'auto' })

console.log('— available 门（模型 × 节点）')
{
  const r = resolveOfficialTurbo(cfgOk(), capsOk())
  ok('★ 全放行 → available + active=true', r.available === true && r.active === true && r.model === 'qwen_image_turbo.safetensors', JSON.stringify(r))
  const r1 = resolveOfficialTurbo(cfgOk(), {})
  ok('模型缺失 → available=false + reason=未发现官方 Turbo 主模型',
    r1.available === false && r1.reason === '未发现官方 Turbo 主模型', r1.reason)
  const r2 = resolveOfficialTurbo(cfgOk(), { models: { officialTurbo: 'x.safetensors' }, nodes: { officialSampling: false } })
  ok('节点缺失 → available=false + reason=缺少 ManualSigmas / SamplerCustomAdvanced',
    r2.available === false && r2.reason === '缺少 ManualSigmas / SamplerCustomAdvanced', r2.reason)
  ok('不可用时 active 必为 false（不激活半开状态）', r1.active === false && r2.active === false)
}

console.log('— 让位门（available 前提下，active 才由这些门决定）')
{
  const r = resolveOfficialTurbo({ ...cfgOk(), officialTurboEnabled: false }, capsOk())
  ok('★ officialTurboEnabled=false → 不激活（用户总开关）',
    r.available === true && r.active === false && r.reason === 'officialTurboEnabled=false', r.reason)
  const r2 = resolveOfficialTurbo({ ...cfgOk(), mainModelOverride: 'my-model.safetensors' }, capsOk())
  ok('★ 显式覆写主模型 → 不激活（尊重用户手选）',
    r2.active === false && r2.reason === '用户显式覆写主模型', r2.reason)
  const r3 = resolveOfficialTurbo({ ...cfgOk(), fast4Enabled: true }, capsOk())
  ok('★ 4 步档优先 → 不激活', r3.active === false && r3.reason === '4 步档优先', r3.reason)
  const r4 = resolveOfficialTurbo({ ...cfgOk(), textControl: 'native' }, capsOk())
  ok('★ native 文本控制档优先 → 不激活', r4.active === false && r4.reason === 'native 文本控制档优先', r4.reason)
}

console.log('— 门优先序与口径')
{
  const r = resolveOfficialTurbo({ ...cfgOk(), mainModelOverride: 'm.safetensors', fast4Enabled: true }, capsOk())
  ok('★ 覆写与 4 步档同设 → 报覆写（门判定顺序：override 先于 fast4）',
    r.reason === '用户显式覆写主模型', r.reason)
  const r2 = resolveOfficialTurbo({ ...cfgOk(), fast4Enabled: true, textControl: 'NATIVE' }, capsOk())
  ok('4 步档与 NATIVE 同设 → 报 4 步档（fast4 先于 native）',
    r2.reason === '4 步档优先', r2.reason)
  const r3 = resolveOfficialTurbo({ ...cfgOk(), textControl: 'Native' }, capsOk())
  ok('textControl 大小写不敏感（Native 也让位）', r3.active === false && r3.reason === 'native 文本控制档优先', r3.reason)
  const r4 = resolveOfficialTurbo({ ...cfgOk(), mainModelOverride: '   ' }, capsOk())
  ok('覆写为纯空白 → 视为未覆写（trim 口径）放行激活', r4.active === true, r4.reason)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
