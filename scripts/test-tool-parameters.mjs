#!/usr/bin/env node
/**
 * 工具 parameters 投影回归（2026-11-21，工具契约事故）。
 *
 * 事故：query_history / doctor / run_dag 的 tool definition 缺 parameters，
 * 宿主枚举工具表时 projectToolSchema 做 `const { parameters } = definition`，
 * `snapshotJsonValue(undefined)` 抛错 ⇒ **整轮 run 失败**（不是单个工具不能用）。
 * 本机用宿主同款投影逻辑遍历全部外置工具，缺字段/非无损 JSON 一律判红。
 * 纯本地零联网零 spawn —— createExtras 全是假依赖，不碰 ComfyUI。
 */
import { createExtras } from '../lib/tool-registry.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

/** 宿主同款投影：parameters 必须存在且能无损 JSON 快照。 */
function projectLikeHost(definition) {
  const { name, description, parameters } = definition
  if (parameters === undefined) throw new Error(`tool "${name}" parameters must be lossless JSON (undefined)`)
  const detached = JSON.parse(JSON.stringify(parameters))
  if (detached === undefined) throw new Error(`tool "${name}" projection returned undefined`)
  return { name, description, parameters: detached }
}

const extras = createExtras({ outputDir: '.tmp-tool-parameters', log: () => {} })
const tools = Array.isArray(extras.tools) ? extras.tools : []

ok('createExtras 产出工具表非空', tools.length > 0, String(tools.length))
const bad = []
for (const t of tools) {
  try { projectLikeHost(t) } catch (e) { bad.push(`${t?.name || '(无名)'}: ${e.message}`) }
}
ok(`★ 全部 ${tools.length} 个工具 parameters 可无损投影（宿主同款校验）`, bad.length === 0, bad.join(' | '))

// 三个曾缺字段的工具逐个点名，防回归。
for (const name of ['query_history', 'doctor', 'run_dag']) {
  const t = tools.find((x) => x?.name === name)
  ok(`${name} 已补 parameters 对象`, !!t && t.parameters?.type === 'object'
    && t.parameters.properties && typeof t.parameters.properties === 'object')
}
const qh = tools.find((x) => x?.name === 'query_history')
ok('query_history 覆盖 issue 建议的关键过滤字段', qh
  && ['date_from', 'date_to', 'width', 'height', 'min_width', 'max_width', 'kind',
    'accel_chain', 'degraded', 'cold', 'keyword', 'include_deleted', 'limit', 'offset']
    .every((k) => k in qh.parameters.properties))
ok('query_history kind 有 enum', Array.isArray(qh?.parameters?.properties?.kind?.enum)
  && qh.parameters.properties.kind.enum.includes('image'))

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
