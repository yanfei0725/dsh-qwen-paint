#!/usr/bin/env node
/**
 * v3 §15.4 第 2 步（控制项落地层）回归：`lib/pipeline-controls.js`。
 *
 * 这套只验**纯函数 + 文件读写**，不联网、不出图、不需要 ComfyUI。
 *
 * 覆盖的判据（每条都对应一个真实踩坑面）：
 *   ① 画幅刻度表与 `lib/config.js` 的 `ASPECTS` **同源**（两处各写一份迟早跑偏）
 *   ② 外来 JSON 一律 clamp + 按 step 对齐，未知键丢弃（面板 POST 是唯一入口）
 *   ③ `seed = -1` 必须原样活着（写错下界会变成"每次出同一张图"）
 *   ④ 速度% **只动尺寸/参考图张数**，绝不动蒸馏步数（不掉质量硬约束）
 *   ⑤ 落盘往返 + 坏文件退回默认值（IO 失败不许把出图拖下水）
 *   ⑥ 优先级：显式 args > 面板 seed
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'

import { ASPECTS, calcSize } from '../lib/config.js'
import { CONTROLS, SPEED_TIERS, quantizeSpeedPercent } from '../lib/mode-schema.js'
import {
  ASPECT_TICKS, CONTROL_FILE, DEFAULT_CONTROLS, SPEED_EDGE,
  sanitizeControls, controlsPath, readControls, writeControls,
  speedEdge, speedTomp, speedMaxRefs, controlsToPref, describeControls, resolveSeed,
} from '../lib/pipeline-controls.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// ---- ① 画幅刻度与 config.js 的 ASPECTS 同源 ----
const cfgKeys = Object.keys(ASPECTS)
ok('★ ASPECT_TICKS 与 config.js ASPECTS 键集合完全一致',
  cfgKeys.length === ASPECT_TICKS.length && cfgKeys.every((k) => ASPECT_TICKS.includes(k)),
  `ticks=${ASPECT_TICKS.join(',')} cfg=${cfgKeys.join(',')}`)
const tickDef = CONTROLS.common.find((c) => c.key === 'aspect')
ok('★ mode-schema 的 aspect.ticks 与 ASPECT_TICKS 逐字一致',
  JSON.stringify(tickDef?.ticks) === JSON.stringify(ASPECT_TICKS),
  `${JSON.stringify(tickDef?.ticks)}`)
ok('aspect 滑块的 max 恰为 ticks.length - 1',
  tickDef?.max === ASPECT_TICKS.length - 1 && tickDef?.min === 0, String(tickDef?.max))
ok('每个刻度都能被 calcSize 算出正尺寸',
  ASPECT_TICKS.every((k) => {
    const [w, h] = calcSize(k, 1.0)
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
  }))

// ---- ② 外来输入 clamp / 对齐 / 丢未知键 ----
ok('speedPercent 63 → 对齐到 65（step 5，从 min 25 起算）',
  sanitizeControls({ speedPercent: 63 }).speedPercent === 65,
  String(sanitizeControls({ speedPercent: 63 }).speedPercent))
ok('speedPercent 超上界 → 100、超下界 → 25',
  sanitizeControls({ speedPercent: 999 }).speedPercent === 100
  && sanitizeControls({ speedPercent: -5 }).speedPercent === 25)
ok('aspect 超界 → 夹到 6 / 0',
  sanitizeControls({ aspect: 99 }).aspect === 6 && sanitizeControls({ aspect: -3 }).aspect === 0)
ok('denoise 0.1..1 step0.05 对齐且无浮点毛刺（0.823 → 0.8）',
  sanitizeControls({ denoise: 0.823 }).denoise === 0.8,
  String(sanitizeControls({ denoise: 0.823 }).denoise))
ok('未知键一律丢弃（不许透传到 cfg）',
  !Object.prototype.hasOwnProperty.call(sanitizeControls({ evil: 'x', __proto__hack: 1 }), 'evil'))
ok('mode 只认 MODES 里的 id：video 留、nonsense 退回 image',
  sanitizeControls({ mode: 'video' }).mode === 'video' && sanitizeControls({ mode: 'nonsense' }).mode === 'image')
ok('非数（NaN/字符串/undefined）退回默认值不抛',
  sanitizeControls({ fps: NaN, steps: 'abc', cfg: undefined }).fps === DEFAULT_CONTROLS.fps)

// ---- ③ seed=-1 必须原样活着 ----
ok('★★ seed = -1（每次随机）不被 clamp 成 0',
  sanitizeControls({ seed: -1 }).seed === -1, String(sanitizeControls({ seed: -1 }).seed))
ok('seed = -1 时 resolveSeed 返回 null（交给随机）', resolveSeed({ seed: -1 }, undefined) === null)
ok('seed = 12345 时 resolveSeed 返回 12345', resolveSeed({ seed: 12345 }, undefined) === 12345)
ok('★ 显式 args.seed 压过面板 seed', resolveSeed({ seed: 1 }, 999) === 999)
ok('DEFAULT_CONTROLS 与 CONTROLS 各档 default 同值',
  Object.entries(DEFAULT_CONTROLS).every(([k, v]) => {
    if (k === 'mode') return true
    const def = [...Object.values(CONTROLS)].flat().find((d) => d.key === k)
    return def ? def.default === v : false
  }))

// ---- ④ 速度% 只动尺寸 / 参考图 ----
ok('SPEED_EDGE 四档与 SPEED_TIERS 对齐',
  SPEED_TIERS.every((t) => SPEED_EDGE[t] > 0))
ok('★ 速度 100% → 1.0MP、25% → (640/1024)²',
  speedTomp(100) === 1 && speedTomp(25) === Number(((640 / 1024) ** 2).toFixed(4)),
  `${speedTomp(100)} / ${speedTomp(25)}`)
ok('中间档先吸附再取边长（63 → 65 → 75 档 896）',
  speedEdge(63) === SPEED_EDGE[75], String(speedEdge(63)))
ok('该档参考图预算随速度下降（信息字段，非硬闸）：100→16、75→8、50→4、25→1',
  speedMaxRefs(100) === 16 && speedMaxRefs(75) === 8 && speedMaxRefs(50) === 4 && speedMaxRefs(25) === 1)
const pref = controlsToPref({ aspect: 5, speedPercent: 50, steps: 12, count: 2 })
ok('controlsToPref 产出 resolveDrawParams 认识的形状（size/megapixels/steps/count）',
  pref.size === ASPECT_TICKS[5] && pref.megapixels === speedTomp(50) && pref.steps === 12 && pref.count === 2,
  JSON.stringify(pref))
ok('★★ controlsToPref **不产出** seed（seed 由 runDraw 单独走 resolveSeed）',
  !Object.prototype.hasOwnProperty.call(pref, 'seed'))
ok('★★ 面板没被拨过时 controlsToPref 返回空对象（不压掉记忆偏好 / cfg.preset）',
  Object.keys(controlsToPref(DEFAULT_CONTROLS)).length === 0,
  JSON.stringify(controlsToPref(DEFAULT_CONTROLS)))
ok('★ 只输出用户真动过的键：只把 steps 改成 12 时，载荷里只有 steps',
  Object.keys(controlsToPref({ ...DEFAULT_CONTROLS, steps: 12 })).join(',') === 'steps',
  JSON.stringify(controlsToPref({ ...DEFAULT_CONTROLS, steps: 12 })))
ok('controlsToPref 不含任何"假生效"字段（键域限定在 size/megapixels/steps/count）',
  Object.keys(pref).every((k) => ['size', 'megapixels', 'steps', 'count'].includes(k)))

// ---- ⑤ 落盘往返 + 坏文件 ----
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-controls-'))
try {
  ok('未写过时 readControls 返回默认值', readControls(tmp).speedPercent === 100)
  const w1 = writeControls(tmp, { speedPercent: 50, mode: 'video', aspect: 3 })
  ok('writeControls 报告 saved=true', w1.saved === true, w1.reason)
  ok('文件落在 <outputDir>/.comfy-pipeline-controls.json',
    existsSync(path.join(tmp, CONTROL_FILE)) && controlsPath(tmp).endsWith(CONTROL_FILE))
  const back = readControls(tmp)
  ok('往返一致（speedPercent/mode/aspect）',
    back.speedPercent === 50 && back.mode === 'video' && back.aspect === 3,
    JSON.stringify(back))
  ok('返回体里的 controls 就是落盘后的完整值', w1.controls.speedPercent === 50 && w1.controls.mode === 'video')
  const w2 = writeControls(tmp, { steps: 12 })
  ok('★ 二次写入是**合并**不是覆盖（speedPercent 仍是 50）',
    w2.controls.speedPercent === 50 && w2.controls.steps === 12, JSON.stringify(w2.controls))
  writeFileSync(path.join(tmp, CONTROL_FILE), '{ 这不是 JSON', 'utf8')
  ok('★ 坏 JSON 退回默认值、不抛', readControls(tmp).speedPercent === 100)
  writeFileSync(path.join(tmp, CONTROL_FILE), '{"speedPercent": 1e9, "junk": true}', 'utf8')
  const cleaned = readControls(tmp)
  ok('★ 手工改坏的值读回来也被 clamp（1e9 → 100）', cleaned.speedPercent === 100, String(cleaned.speedPercent))
  ok('落盘内容是 UTF-8 JSON、带换行结尾',
    readFileSync(path.join(tmp, CONTROL_FILE), 'utf8').trim().startsWith('{'))
  // 目录不可写 → saved=false 但不抛（用一个不存在且无法创建的父路径模拟）
  const ro = writeControls(path.join(tmp, 'no-such-deep\u0000bad'), { speedPercent: 75 })
  ok('★ 写盘失败只回 saved=false，绝不抛（不影响出图）',
    ro.saved === false && ro.controls.speedPercent === 75, ro.reason)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---- ⑥ 人话摘要 ----
const desc = describeControls({ aspect: 5, speedPercent: 100 })
ok('摘要含模式/比例/速度/吸附档/参考图预算',
  desc.includes('生图模式') && desc.includes('16:9') && desc.includes('100%')
  && desc.includes('吸附') && desc.includes('该档参考图预算'), desc)
ok('★ 视频模式摘要说帧数/帧率/高度，不再写图链的「长边/参考图预算」', (() => {
  const d = describeControls({ mode: 'video', speedPercent: 50 })
  return d.includes('25 帧') && d.includes('12 fps') && !d.includes('参考图预算')
})())
ok('★ 生图模式摘要仍写长边与参考图预算（行为不变）',
  describeControls(DEFAULT_CONTROLS).includes('参考图预算'))
ok('摘要把速度标为"吸附档"，不谎称精确档位', /吸附 \d+ 档/.test(desc), desc)
ok('quantizeSpeedPercent 与 speedEdge 口径一致（每个 tier 的 edge 不同）',
  new Set(SPEED_TIERS.map((t) => speedEdge(t))).size === SPEED_TIERS.length)

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
