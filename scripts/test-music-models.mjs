#!/usr/bin/env node
/**
 * music-models 选型直测（2026-11-20 补勘察报告 #14 零触及清单：pickMusicModel /
 * discoverMusicNodes 零断言）。
 *
 * 切片（纯函数零 mock）：默认回落 / 未知 id 拒选 / 节点探测 degrade 矩阵 /
 *   nodePattern+savePattern 双匹配 / 多模型清单行。
 *
 * 纯离线。
 */
import { pickMusicModel, listMusicModels, MUSIC_MODELS, DEFAULT_MUSIC_MODEL } from '../lib/music-models.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const INSTALLED_OK = { 'AceMusicGenerate': {}, 'SaveAudio': {}, 'UNETLoader': {} }

console.log('— pickMusicModel')
{
  const r = pickMusicModel({})
  ok('★ requested 空 → 回落 DEFAULT_MUSIC_MODEL（' + DEFAULT_MUSIC_MODEL + '）',
    r.selected?.id === DEFAULT_MUSIC_MODEL, JSON.stringify(r.selected))
  const r2 = pickMusicModel({ requested: 'ace_step_15' })
  ok('★ installed 空 → degraded:true + 两条 reason（生成节点/保存节点都缺）',
    r2.ok === false && r2.degraded === true && r2.reasons.some((s) => s.includes('生成节点'))
    && r2.reasons.some((s) => s.includes('保存节点')), JSON.stringify(r2.reasons))
  const r3 = pickMusicModel({ requested: 'ace_step_15', installed: INSTALLED_OK })
  ok('★ 节点齐 → ok:true + generate/save 双匹配（nodePattern=Ace 系 / savePattern=SaveAudio）',
    r3.ok === true && r3.degraded === false
    && r3.nodes.generate.includes('AceMusicGenerate') && r3.nodes.save.includes('SaveAudio'),
    JSON.stringify(r3.nodes))
  const r4 = pickMusicModel({ requested: 'no_such_model' })
  ok("★ 未知 id → ok:false + reasons 给出可选清单（'可选：'开头拼接全部 id）",
    r4.ok === false && r4.selected === null && r4.reasons[1]?.startsWith('可选：')
    && MUSIC_MODELS.every((m) => r4.reasons[1].includes(m.id)), JSON.stringify(r4.reasons))
  ok('save 节点缺只 degrade 不拒选（generate 齐时）',
    (() => { const r = pickMusicModel({ requested: 'yue2', installed: { 'YuEGenerate': {} } })
      return r.ok === false && r.degraded === true && r.reasons.length === 1
        && r.reasons[0].includes('保存节点') })())
}

console.log('— listMusicModels')
{
  const all = listMusicModels({})
  ok('清单含全部模型且未装时 available=false + reason 给安装指引',
    all.length === MUSIC_MODELS.length && all.every((m) => m.available === false)
    && all.every((m) => String(m.reason).includes('未检测到')))
  const ready = listMusicModels({ installed: INSTALLED_OK })
  ok("★ 装了 Ace 节点后该行 available=true（generateCandidates 有类名）、其余仍 false（逐模型独立探测）",
    ready.find((m) => m.id === 'ace_step_15')?.available === true
    && ready.find((m) => m.id === 'ace_step_15')?.generateCandidates.includes('AceMusicGenerate')
    && ready.find((m) => m.id === 'yue2')?.available === false)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
