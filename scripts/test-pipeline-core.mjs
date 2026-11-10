#!/usr/bin/env node
/**
 * 控制层内核四件回归（v3 §13.4 / §14.3 的代码级修正）：
 *   ① `lib/prompt-cache.js`  —— 两层缓存：本地去重（剔非语义键）vs ComfyUI 逐字节
 *   ② `lib/accel-profiles.js` —— `pick({installed})` 未装返回 null，绝不 throw
 *   ③ `lib/model-map.js`      —— 结构化水位（半开区间），零 eval
 *   ④ `lib/workflow-passes.js` —— 入口 structuredClone + rawAst 快照
 *
 * 每条断言都对着一次真实的错法写（那四处都是"注释说一套、实现另一套"）。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MODEL_VARIANTS, matchVariant, variantById, tierForVram, validateVariants, variantMatches } from '../lib/model-map.js'
import { ACCEL_PROFILES, LONG_TASK_FRAMES, pick, profileById, installedIds, describePick } from '../lib/accel-profiles.js'
import { runPasses, emitWorkflow, bindSlots, diffWorkflows } from '../lib/workflow-passes.js'
import {
  createLocalDedup, semanticFingerprint, stableStringify, sameSubmitBody,
  DEDUP_MAX_ENTRIES, DEDUP_FILE,
} from '../lib/prompt-cache.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

/* ==================== ③ model-map：结构化水位，零 eval ==================== */
console.log('— model-map（13.4 ⑥）')
ok('★ 档位表自检通过（不重叠、覆盖到 0，max 大于 min）', validateVariants().length === 0, validateVariants().join('；'))
ok('★ 半开区间：20 GB 落在 bf16（不是 fp8）', matchVariant(20)?.id === 'bf16', matchVariant(20)?.id)
ok('★ 半开区间：19.9 GB 落在 fp8（不是 bf16）', matchVariant(19.9)?.id === 'fp8_e4m3fn', matchVariant(19.9)?.id)
ok('边界 12 GB → fp8、11.9 GB → int8、8 GB → int8、7.9 GB → gguf',
  matchVariant(12)?.id === 'fp8_e4m3fn' && matchVariant(11.9)?.id === 'int8'
  && matchVariant(8)?.id === 'int8' && matchVariant(7.9)?.id === 'gguf_q5_k_m',
  [12, 11.9, 8, 7.9].map((v) => `${v}:${matchVariant(v)?.id}`).join(' '))
ok('★ 显存未知（NaN / undefined）→ null，绝不猜一个档',
  matchVariant(NaN) === null && matchVariant(undefined) === null)
ok('tierForVram 与档位的 tier 字段一致', tierForVram(24) === 'bf16' && tierForVram(16) === 'fp8' && tierForVram(4) === 'gguf')
ok('variantMatches 对 null/非数安全', variantMatches(null, 16) === false && variantMatches(MODEL_VARIANTS[0], NaN) === false)
ok('variantById 命中/未命中', variantById('fp8_e4m3fn')?.tier === 'fp8' && variantById('nope') === null)
ok('自检能抓出重叠区间', validateVariants([
  { id: 'a', tier: 't', minVramGB: 0, maxVramGB: 20 },
  { id: 'b', tier: 't', minVramGB: 10, maxVramGB: 30 },
]).some((p) => p.includes('重叠')))
ok('自检能抓出 max <= min', validateVariants([{ id: 'x', tier: 't', minVramGB: 20, maxVramGB: 12 }]).length > 0)
ok('★★ model-map.js 里零 eval / 零 new Function',
  !/\beval\s*\(/.test(read('lib/model-map.js')) && !/new\s+Function\s*\(/.test(read('lib/model-map.js')))
ok('★ config.js 里同样零 eval / 零 new Function',
  !/\beval\s*\(/.test(read('lib/config.js')) && !/new\s+Function\s*\(/.test(read('lib/config.js')))

/* ==================== ② accel-profiles：未装 → null ==================== */
console.log('— accel-profiles（13.4 ⑤）')
ok('★ 什么都没装 → null（不是抛错、不是硬塞 easycache）', pick({ frames: 200, vendor: 'nvidia', installed: [] }) === null)
ok('★ 本机实况复刻：>100 帧但只装了 spectrum → spectrum（不再无条件 easycache）',
  pick({ frames: 200, vendor: 'amd', installed: ['spectrum'] }) === 'spectrum')
ok('>100 帧且有 easycache → 优先 easycache', pick({ frames: 200, vendor: 'amd', installed: ['spectrum', 'easycache'] }) === 'easycache')
ok('≤100 帧 → 优先 spectrum（不是 easycache）', pick({ frames: 49, vendor: 'amd', installed: ['spectrum', 'easycache'] }) === 'spectrum')
ok('★ N 卡 + sage 已装 → sage 优先', pick({ frames: 49, vendor: 'nvidia', installed: ['sage', 'spectrum'] }) === 'sage')
ok('★ A 卡装了 sage 也不选（厂商专属，装了也跑不动）',
  pick({ frames: 49, vendor: 'amd', installed: ['sage'] }) === null)
ok('installed 传数组或 Set 都认', pick({ frames: 49, vendor: 'amd', installed: new Set(['spectrum']) }) === 'spectrum')
ok('LONG_TASK_FRAMES 即 100，且边界 100 不算长任务',
  LONG_TASK_FRAMES === 100 && pick({ frames: 100, vendor: 'amd', installed: ['spectrum', 'easycache'] }) === 'spectrum')
ok('describePick(null) 说人话（不吐 undefined）',
  describePick(null).includes('不加速') && !describePick(null).includes('undefined'), describePick(null))
ok('installedIds 从 probe 结果里只取 installed=true 的档',
  (() => {
    const ids = installedIds({ packs: [{ id: 'spectrum', installed: true }, { id: 'easycache', installed: false }] })
    return ids.has('spectrum') && !ids.has('easycache')
  })())
ok('installedIds 吃到垃圾不抛', installedIds(null).size === 0 && installedIds({ packs: 'x' }).size === 0)
ok('三档都在表里且都有 note/label', ACCEL_PROFILES.length === 3
  && ACCEL_PROFILES.every((p) => p.label && p.note && profileById(p.id) === p))

/* ==================== ④ workflow-passes：入口深拷 ==================== */
console.log('— workflow-passes（14.3）')
const wf = () => ({
  8: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, cfg: 1 } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } },
})
{
  const ast = wf()
  const snapshot = JSON.stringify(ast)
  const r = runPasses(ast, [bindSlots({ 8: { seed: 42, steps: 4 } })], {})
  ok('★ pass 只改副本：传入的原 AST 在跑完后逐字节不变', JSON.stringify(ast) === snapshot)
  ok('runPasses 返回的 ast 已经是改后的（seed=42/steps=4）',
    r.ast[8].inputs.seed === 42 && r.ast[8].inputs.steps === 4)
  ok('★★ rawAst 是**入口快照**（seed 仍是 1）—— 回滚/diff 才有依据', r.rawAst[8].inputs.seed === 1)
  ok('changes 里带上 before/after 与 pass 名',
    r.changes.some((c) => c.pass === 'SlotBindPass' && c.before === 1 && c.after === 42),
    JSON.stringify(r.changes.slice(0, 2)))
  ok('rawAst 与原对象互不影响（改原对象不动快照）',
    (() => { const a = wf(); const rr = runPasses(a, [], {}); a[8].inputs.seed = 999; return rr.rawAst[8].inputs.seed === 1 })())
  ok('emitWorkflow 返回深拷贝（改它不影响 rawAst）',
    (() => { const rr = runPasses(wf(), [], {}); const e = emitWorkflow(rr.rawAst); e[8].inputs.seed = 7; return rr.rawAst[8].inputs.seed === 1 })())
  ok('多 pass 依次串起来（第二个 pass 看到的是第一个的结果）',
    (() => {
      const rr = runPasses(wf(), [bindSlots({ 8: { seed: 5 } }), (a) => { a[8].inputs.cfg = a[8].inputs.seed + 1; return { ast: a, changes: [] } }], {})
      return rr.ast[8].inputs.cfg === 6
    })())
  ok('★ strict 模式不许凭空造槽（造出来的槽 ComfyUI 会拒收）',
    (() => {
      try { runPasses(wf(), [bindSlots({ 8: { not_a_slot: 1 } }, { strict: true })], {}); return false } catch { return true }
    })())
  ok('非 strict 造槽不抛（兼容旧调用）',
    (() => { const rr = runPasses(wf(), [bindSlots({ 8: { not_a_slot: 1 } })], {}); return rr.ast[8].inputs.not_a_slot === 1 })())
  ok('pass 返回垃圾会当场报错（不是静默继续）',
    (() => { try { runPasses(wf(), [() => null], {}); return false } catch { return true } })())
  ok('diffWorkflows 能报出改一格', (() => {
    const a = wf()
    const rr = runPasses(a, [bindSlots({ 8: { seed: 42 } })], {})
    const d = diffWorkflows(rr.rawAst, rr.ast)
    return d.length === 1 && d[0].input === 'seed' && d[0].before === 1 && d[0].after === 42
  })())
}

/* ==================== ① prompt-cache：两层分开 ==================== */
console.log('— prompt-cache（13.4 ②）')
ok('stableStringify 键序无关', stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }))
ok('★ 非语义键不参与指纹：只差 client_id → 同指纹',
  semanticFingerprint({ client_id: 'a', 3: { inputs: { seed: 1 } } })
  === semanticFingerprint({ client_id: 'b', 3: { inputs: { seed: 1 } } }))
ok('★ 非语义键不参与指纹：只差 filename_prefix → 同指纹',
  semanticFingerprint({ 9: { inputs: { filename_prefix: 'a' } } })
  === semanticFingerprint({ 9: { inputs: { filename_prefix: 'b' } } }))
ok('★★ seed 必须参与指纹：改 seed → 指纹变（否则"重画"会拿到旧图）',
  semanticFingerprint({ 8: { inputs: { seed: 1 } } }) !== semanticFingerprint({ 8: { inputs: { seed: 2 } } }))
ok('指纹是 16 位 hex', /^[0-9a-f]{16}$/.test(semanticFingerprint({})))
ok('★ sameSubmitBody 是**逐字节**比较（ComfyUI 那层不许归一化）',
  sameSubmitBody({ a: 1, b: 2 }, { a: 1, b: 2 }) === true
  && sameSubmitBody({ a: 1, b: 2 }, { b: 2, a: 1 }) === false)

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-dedup-'))
try {
  const dedup = createLocalDedup(tmp)
  ok('表文件落在 <outputDir>/.comfy-pipeline-dedup.json',
    dedup.path.endsWith(DEDUP_FILE) && dedup.path.startsWith(tmp))
  const f1 = path.join(tmp, 'a.png')
  const f2 = path.join(tmp, 'b.png')
  writeFileSync(f1, 'x'); writeFileSync(f2, 'y')
  ok('空表 lookup → null', dedup.lookup('k1') === null)
  dedup.remember('k1', [f1, f2])
  ok('remember 后 lookup 命中且返回文件数组',
    JSON.stringify(dedup.lookup('k1')) === JSON.stringify([f1, f2]), JSON.stringify(dedup.lookup('k1')))
  unlinkSync(f2)
  ok('★ 命中要求**每个文件都还在**：删一个就当未命中（照常提交）', dedup.lookup('k1') === null)
  dedup.remember('k2', [f1])
  ok('表里还是能读到活着的那条', JSON.stringify(dedup.lookup('k2')) === JSON.stringify([f1]))
  ok('remember 空文件数组 → 不记', dedup.remember('k3', []) === false && dedup.lookup('k3') === null)
  // 上限淘汰
  for (let i = 0; i < DEDUP_MAX_ENTRIES + 10; i += 1) dedup.remember(`bulk${i}`, [f1])
  ok(`★ 表上限 ${DEDUP_MAX_ENTRIES} 条（FIFO 淘汰，不会无限长）`,
    dedup.size() <= DEDUP_MAX_ENTRIES, String(dedup.size()))
  writeFileSync(path.join(tmp, DEDUP_FILE), '{坏 JSON', 'utf8')
  ok('★ 坏 JSON 退回空表、不抛', dedup.size() === 0 && dedup.lookup('k1') === null)
  const ro = createLocalDedup(path.join(tmp, 'no-such\u0000bad', 'x'))
  ok('★ 写盘失败只返回 false，绝不抛（缓存只是省时间）', ro.remember('k', [f1]) === false)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/* ==================== 接线（别只写模块不接） ==================== */
console.log('— 接线')
const idxSrc = read('lib/index.js')
const cfgSrc = read('lib/config.js')
ok('★ index.js 出图链路真的调用了本地去重（createLocalDedup + semanticFingerprint）',
  idxSrc.includes('createLocalDedup(cfg.outputDir)') && idxSrc.includes('semanticFingerprint(workflow)'))
const dedupAt = idxSrc.indexOf('iterDedup.lookup')
const submitAfterDedup = idxSrc.indexOf('promptId = await submitPrompt(cfg, workflow, signal)', dedupAt)
ok('★ 去重查找发生在 submitPrompt **之前**（命中就不提交）',
  dedupAt > 0 && submitAfterDedup > dedupAt, `${dedupAt} / ${submitAfterDedup}`)
ok('★ 落盘后记进去重表', idxSrc.includes('iterDedup.remember(semanticFingerprint(workflow), iterFiles)'))
ok('★ config.js 用了结构化水位（tierForVram），建议档写进 caps',
  cfgSrc.includes("from './model-map.js'") && cfgSrc.includes('caps.suggestedPrecisionTier = tierForVram('))
ok('★ describe.js 把建议档显示出来（不是只塞进 caps 没人读）',
  read('lib/describe.js').includes('caps.suggestedPrecisionTier'))
ok('accel-profiles 的 pick 尚未接出图链路时，至少已被视频链可用（导出完整）',
  typeof pick === 'function' && typeof installedIds === 'function')

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
