#!/usr/bin/env node
/**
 * attention-backends 直测（2026-11-20 缺口⑥，账本缺口⑥设计段：discoverAttentionNodes
 *   零触及 + pickAttentionBackends 零断言；表结构摘记在 opt-relay-state.md）。
 *
 * 切片（纯函数零 mock）：nodePattern 过滤 / ★priorityPattern 专用节点优先排序 /
 *   preferred 顺序与去重 / kinds 过滤 / degrade reasons / 诚实条款 note 固定文案。
 *
 * 纯离线。
 */
import { discoverAttentionNodes, pickAttentionBackends, listAttentionBackends, ATTENTION_BACKENDS } from '../lib/attention-backends.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const INSTALLED = {
  'SageAttentionPatch': {}, 'QwenImage21SageAttentionT8': {}, 'FirstBlockCache': {}, 'UNETLoader': {},
}

console.log('— discoverAttentionNodes')
{
  const r = discoverAttentionNodes(INSTALLED, 'no_such_backend')
  ok('未知 backend → candidates 空 + nodeCount 照实', r.candidates.length === 0 && r.nodeCount === 4, JSON.stringify(r))
  const s = discoverAttentionNodes(INSTALLED, 'sage_attention')
  ok("nodePattern 过滤：Sage 系两个候选（Patch + QwenImage21T8），FirstBlockCache 不混入",
    s.candidates.includes('SageAttentionPatch') && s.candidates.includes('QwenImage21SageAttentionT8')
    && !s.candidates.includes('FirstBlockCache'), JSON.stringify(s.candidates))
  ok('★ priorityPattern 专用优先：QwenImage21SageAttentionT8 排在通用 SageAttentionPatch 前（工作流只取 candidates[0]）',
    s.candidates[0] === 'QwenImage21SageAttentionT8', JSON.stringify(s.candidates))
  const w = discoverAttentionNodes(INSTALLED, 'wavespeed')
  ok('wavespeed 单候选 FirstBlockCache', w.candidates.length === 1 && w.candidates[0] === 'FirstBlockCache', JSON.stringify(w.candidates))
}

console.log('— pickAttentionBackends')
{
  const none = pickAttentionBackends({ installed: {} })
  ok('★ installed 空 → degraded:true + 每后端一条 reasons（类名未核实口径）',
    none.degraded === true && none.selected.length === 0
    && none.reasons.length === ATTENTION_BACKENDS.length
    && none.reasons.every((s) => s.includes('未在 /object_info 中发现')), JSON.stringify(none.reasons))
  const sel = pickAttentionBackends({ installed: INSTALLED, preferred: [] })
  ok("★ 节点齐 → 双后端入选（sage + wavespeed）+ acceptedInputs/defaultInputs 兜底字段存在",
    sel.selected.length === 2
    && sel.selected.every((s) => Array.isArray(s.acceptedInputs) && typeof s.defaultInputs === 'object'),
    JSON.stringify(sel.selected.map((s) => s.id)))
  ok('★ preferred 优先：preferred=[wavespeed] → wavespeed 排 selected[0]',
    pickAttentionBackends({ installed: INSTALLED, preferred: ['wavespeed'] }).selected[0].id === 'wavespeed')
  const dedup = pickAttentionBackends({ installed: INSTALLED, preferred: ['sage_attention', 'sage_attention'] })
  ok("preferred 重复 id 去重（seen 集合）不双选", dedup.selected.filter((s) => s.id === 'sage_attention').length === 1)
  const tts = pickAttentionBackends({ installed: INSTALLED, kind: 'tts' })
  ok('★ kinds 过滤：tts 请求全跳过（两后端都 image/video）→ degraded',
    tts.degraded === true && tts.selected.length === 0)
  ok('★ 诚实条款：note 提到倍率但不含任何数字倍率形态（未实测不写结论）',
    (() => { const n = pickAttentionBackends({ installed: INSTALLED }).note
      return n.includes('倍率') && !/\d+(\.\d+)?\s*[×x倍]/u.test(n) && n.includes('未实测') })())
}

console.log('— listAttentionBackends')
{
  const all = listAttentionBackends({ installed: INSTALLED })
  ok('清单逐后端 available 形态 + installHint 透传',
    all.length === ATTENTION_BACKENDS.length && all.every((b) => typeof b.installHint === 'string'))
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
