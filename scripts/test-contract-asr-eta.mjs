#!/usr/bin/env node
/**
 * A1 契约对账 + D19 ASR 真通路 + E27 本机秒数自校准 + 三模式差异化计划 —— 离线行为回归。
 *
 * ★ 判据风格声明：本文件统一用 `ok(条件, 名称, extra)`（条件在前）。
 *   覆盖：
 *   ① graph-audit：roundTo/alignTo 两种对齐语义、契约校验拦截、auditGraph 全部 diff.kind、
 *      真契约文件可加载、真 buildWorkflow 产物过契约（含 turbo 步数 alternates）
 *   ② asr-client：resolveAsrConfig（补路径/拒 file:）、toCue/spreadBySentence、
 *      transcribeAudio 全分支（未配置/segments 对齐/仅全文/401/断网/扩展名/超限）
 *   ③ eta-calibrate：分桶边界、样本折取、去首跑中位数、pickEta 三档置信 + 不跨档借用
 *   ④ mode-schema：MODE_PLANS 与 MODES/CONTROLS 的一致性（差异化计划不许指到不存在的卡片）
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import {
  roundTo, alignTo, applyTransform, clampTo, validateContract,
  auditGraph, loadContract, listContracts, sanitizeContractId,
  indexGraph, reachableFrom, danglingLinks,
} from '../lib/graph-audit.js'
import {
  resolveAsrConfig, toCue, spreadBySentence, normalizeAsrResponse,
  transcribeAudio, asrVerifyHint, ASR_AUDIO_EXTS,
} from '../lib/asr-client.js'
import {
  sizeBucketOf, stepBucketOf, sampleKey, kindOfGraph, shapeOfGraph,
  durationOfMessages, extractSamples, median, buildCalibration, pickEta,
} from '../lib/eta-calibrate.js'
import { MODES, CONTROLS, MODE_PLANS, buildSchemaSnapshot } from '../lib/mode-schema.js'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (actual, expected, name) => ok(actual === expected, name, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-cae-'))

/* ================================================== ① graph-audit ==== */
console.log('\n—— graph-audit：对齐语义与契约校验 ——')

// ★ 两种对齐必须不同：r32 就近（830→832、816→832），alignTo 向上（816/32=25.5 → 832）
eq(roundTo(830, 32), 832, 'roundTo 就近：830 → 832')
eq(roundTo(816, 32), 832, 'roundTo 就近：816 → 832（25.5 就近进位）')
eq(alignTo(832, 32), 832, 'alignTo 向上：832 本身就是倍数')
eq(alignTo(817, 32), 832, 'alignTo 向上：817 → 832')
eq(applyTransform(830, 'r32'), 832, 'r32 变换与生图链同语义')
eq(applyTransform(3.7, 'int'), 3, 'int 变换截断')
eq(clampTo(99, 1, 60), 60, 'clampTo 上界')
eq(clampTo('abc', 1, 60), 'abc', 'clampTo 非数原样返回（不硬造 0）')

const badContract = validateContract({ schemaVersion: 999, id: '', kind: '' })
ok(badContract.length >= 3, 'schemaVersion/id/kind 全错时逐项报出', badContract.join('；'))
ok(validateContract({ schemaVersion: 1, id: 'x', kind: 'image', roles: { sampler: { classes: ['KSampler'] } } }).length === 0,
  '最小合法契约零错误')
eq(validateContract({ schemaVersion: 1, id: 'x', kind: 'image', roles: { a: { classes: ['X'] } }, params: { p: { role: 'nope', slot: 'q' } } }).join(''),
  'param p.role 指向未声明的角色 nope', 'param.role 指向不存在的角色被拦')
ok(validateContract({ schemaVersion: 1, id: 'x', kind: 'image', roles: { a: { classes: ['X'] } }, forbid: { _note: '注释', bad: '不是数组' } })
  .some((e) => e.includes('forbid.bad')), 'forbid 值不是数组被拦，且 _ 注释键被跳过')

eq(sanitizeContractId('../../etc/passwd'), 'etcpasswd', '★ 契约 id 路径穿越被消毒')
eq(sanitizeContractId(' image-qwen21 '), 'image-qwen21', '首尾空白剥掉')

/* —— auditGraph 的各 diff.kind（可达性 = 从输出沿 inputs 反向走） —— */
const C = {
  schemaVersion: 1, id: 't', kind: 'image',
  roles: {
    sampler: { classes: ['KSampler'], _note: '主采样器' },
    save: { classes: ['SaveImage'], _note: '输出' },
    loose: { classes: ['LooseLoader'], _note: '被采样器引用的加载器（unreachable 场景用它）' },
  },
  params: {
    steps: { role: 'sampler', slot: 'steps', min: 1, max: 60 },
    prompt: { role: 'save', slot: 'x', check: 'non-empty' },
  },
  forbid: { _why: '注释', refImage: ['ControlNetLoader'] },
}
// ★ 连线必须是消费方向（SaveImage 消费 KSampler），否则可达性会把活节点判成孤岛。
const G = {
  1: { class_type: 'KSampler', inputs: { steps: 25, model: ['5', 0] } },
  5: { class_type: 'LooseLoader', inputs: {} },
  2: { class_type: 'SaveImage', inputs: { x: 'hello', images: ['1', 0] } },
}
{
  const r = auditGraph(G, C, { steps: 25 })
  eq(r.ok, true, '合规图全绿', JSON.stringify(r.diffs))
  eq(r.diffs.length, 0, '零 diff')
  eq(r.roles.sampler.id, '1', '角色解析到节点 id')
  eq(r.roles.save.id, '2', '输出角色解析到 SaveImage')
  eq(r.stats.nodes, 3, '统计节点数')

  const g2 = structuredClone(G); delete g2[5]
  const r2 = auditGraph(g2, C, { steps: 25 })
  ok(r2.diffs.some((d) => d.kind === 'missing-role' && String(d.path).includes('loose')), '缺角色 → missing-role', JSON.stringify(r2.diffs))

  const g3 = structuredClone(G); g3[1].inputs.steps = 12
  const r3 = auditGraph(g3, C, { steps: 25 })
  ok(r3.diffs.some((d) => d.kind === 'param-mismatch' && d.path === '1.steps' && d.expected === 25 && d.actual === 12),
    '★★ 改坏 steps → param-mismatch 并指出具体槽位', JSON.stringify(r3.diffs))

  // 采样器不再引用加载器 → loose 角色解析到了但从输出不可达
  const g4 = structuredClone(G); g4[1].inputs.model = '直接给字符串不走节点'
  const r4 = auditGraph(g4, C, { steps: 25 })
  ok(r4.diffs.some((d) => d.kind === 'unreachable' && String(d.path).includes('loose')), '角色节点从输出不可达 → unreachable', JSON.stringify(r4.diffs))

  const g5 = structuredClone(G); g5[3] = { class_type: 'ControlNetLoader', inputs: {} }
  const r5 = auditGraph(g5, C, { steps: 25 })
  ok(r5.diffs.some((d) => d.kind === 'forbidden-present'), 'forbid 类名出现 → forbidden-present', JSON.stringify(r5.diffs))

  // 条件式合法值：图里有 LoraLoaderModelOnly 时 steps=8 记 note 而不是 diff
  const C2 = structuredClone(C)
  C2.params.steps.alternates = [{ whenClass: 'LoraLoaderModelOnly', value: 8, reason: 'turbo 蒸馏固定 8 步' }]
  const g6 = structuredClone(G); g6[1].inputs.steps = 8; g6[6] = { class_type: 'LoraLoaderModelOnly', inputs: {} }
  const r6 = auditGraph(g6, C2, { steps: 25 })
  eq(r6.ok, true, '★★ turbo 场景的步数 8 记为合规替代（不误报）', JSON.stringify(r6.diffs))
  eq(r6.notes.length, 1, '替代记入 notes')
  ok(String(r6.notes[0].why).includes('8 步'), 'note 带原因')

  // non-empty 语义：args 里**给了**该参数、但图里槽位是空的 → diff；
  // args 里没填的参数不查（调用方没给的东西没法要求图里有）。
  const g7 = structuredClone(G); g7[2].inputs.x = ''
  const r7 = auditGraph(g7, C, { steps: 25, prompt: 'hi' })
  ok(r7.diffs.some((d) => d.kind === 'param-mismatch' && String(d.path).includes('x')), 'args 给了 prompt 但图里槽位为空 → diff', JSON.stringify(r7.diffs))
  const r7b = auditGraph(g7, C, { steps: 25 })
  eq(r7b.diffs.filter((d) => String(d.path).includes('.x')).length, 0, 'args 没给 prompt → 不查该槽（不越权）')

  eq(reachableFrom(G, ['2']).size, 3, '可达性：从 SaveImage 反向 3 节点（2→1→5）')
  eq(danglingLinks(G).length, 0, '合法连线零悬挂')
  eq(danglingLinks(structuredClone(g2)).length, 1, '删掉被引用节点 → 悬挂连线被点名')
  ok(indexGraph(G).byClass.has('KSampler'), '索引带类名倒排')
}

/* —— 真契约文件 + 真 buildWorkflow —— */
function runRealContract() {
  const ids = listContracts()
  ok(ids.includes('image-qwen21') && ids.includes('tts-qwen3') && ids.includes('tts-voiceclone'),
    `三份真契约都在：${ids.join(', ')}`)
  for (const id of ids) {
    const c = loadContract(id)
    eq(validateContract(c).length, 0, `契约 ${id} 自校验零错误`)
  }
  // 真生图链过契约：文生图与 turbo（alternates 生效）两场景
  return import('../lib/config.js').then(({ buildWorkflow }) => {
    const c = loadContract('image-qwen21')
    const plain = buildWorkflow({}, { prompt: 'a fox', width: 830, height: 830, steps: 25, seed: 1 })
    const r1 = auditGraph(plain, c, { prompt: 'a fox', width: 830, height: 830, steps: 25, seed: 1 })
    ok(r1.ok === true, '★★ 真 buildWorkflow（文生图 830²）过契约', JSON.stringify(r1.diffs).slice(0, 200))
    const turbo = buildWorkflow({}, { prompt: 'x', steps: 25, seed: 1, turbo: true })
    const r2 = auditGraph(turbo, c, { prompt: 'x', steps: 25, seed: 1 })
    ok(r2.ok === true, '★ turbo 场景也过契约（8 步走 alternates 而非 diff）', JSON.stringify(r2.diffs).slice(0, 200))
    // 改坏：真图上动一个值 → 契约必须红
    turbo[8].inputs.steps = 12
    const r3 = auditGraph(turbo, c, { prompt: 'x', steps: 25, seed: 1 })
    ok(r3.ok === false && r3.diffs.some((d) => d.path === '8.steps'),
      '★★ 真图改坏一个值 → 契约红并点名 8.steps')
    return runAsr()
  }).catch((e) => { ok(false, 'config.js 导入失败', e.message); return runAsr() })
}

/* ================================================== ② asr-client ==== */
function runAsr() {
  console.log('\n—— asr-client：真通路各分支 ——')

  eq(resolveAsrConfig({}).enabled, false, '未配置 asrUrl → disabled 且带原因')
  const full = resolveAsrConfig({ asrUrl: 'http://127.0.0.1:8000', asrModel: 'whisper-1', asrKey: 'sk-x' })
  eq(full.enabled, true, '配置齐全 → enabled')
  eq(full.url, 'http://127.0.0.1:8000/v1/audio/transcriptions', '路径自动补全')
  eq(resolveAsrConfig({ asrUrl: 'http://h:1/custom/asr' }).url, 'http://h:1/custom/asr', '已带路径不重复补')
  eq(resolveAsrConfig({ asrUrl: 'file:///etc/passwd' }).enabled, false, '★ file: 协议拒绝')
  eq(resolveAsrConfig({ asrUrl: 'http://x/aSd' }).url, 'http://x/aSd', '路径大小写保留')

  eq(toCue({ start: 0, end: 1.5, text: ' 你好 ' }, 0).text, '你好', 'toCue 去首尾空白')
  eq(toCue({ start: 0, end: 1.5, text: ' 你好 ' }, 0).index, 1, 'cue 序号从 1 起')
  const spread = spreadBySentence('第一句。第二句！第三？', 9)
  eq(spread.length, 3, '按句切三段')
  eq(spread[2].to, 9, '末段对齐总时长')

  const norm = normalizeAsrResponse({ text: 'a', segments: [{ start: 0, end: 1, text: 'a' }] })
  eq(norm.aligned, true, '有 segments → aligned')
  const norm2 = normalizeAsrResponse({ text: '第一。第二。' }, { seconds: 6 })
  eq(norm2.aligned, false, '无 segments → 均分并如实标')

  ok(ASR_AUDIO_EXTS.includes('.mp3') && ASR_AUDIO_EXTS.includes('.wav') && !ASR_AUDIO_EXTS.includes('.avi'),
    '扩展名白名单带点前缀：含 .mp3/.wav、不含 .avi')

  const wav = path.join(tmp, 'demo.wav')
  fs.writeFileSync(wav, Buffer.alloc(1024, 7))

  const T = (cfg, fetchFn, extra = {}) => transcribeAudio({ audioPath: wav, cfg, fetchFn, ...extra })

  return T({}).then((r) => {
    eq(r.ok, false, '未配置 → ok:false')
    ok(String(r.reason).includes('asrUrl'), '原因点名 asrUrl')

    const seg = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      text: '你好世界。这是第二句。', language: 'zh',
      segments: [{ start: 0, end: 1.5, text: '你好世界。' }, { start: 1.5, end: 3.2, text: '这是第二句。' }],
    }) })
    return T({ asrUrl: 'http://127.0.0.1:8000' }, seg)
  }).then((r) => {
    eq(r.ok, true, 'verbose_json → ok')
    eq(r.aligned, true, '时间戳与语音对齐')
    eq(r.cues.length, 2, '两条 cue')

    const noSeg = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: '第一句。第二句。第三句。' }) })
    return T({ asrUrl: 'http://127.0.0.1:8000' }, noSeg, { seconds: 9 })
  }).then((r) => {
    eq(r.ok, true, '仅全文 → ok')
    eq(r.aligned, false, '但如实标未对齐')
    ok((r.warnings ?? []).some((w) => String(w).includes('均分') || String(w).includes('对齐')), '警告说明时间戳是估的', JSON.stringify(r.warnings))

    const unauthorized = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'bad key' } }) })
    return T({ asrUrl: 'http://x.test', asrKey: 'k' }, unauthorized)
  }).then((r) => {
    eq(r.ok, false, '401 → ok:false')
    ok(String(r.reason).includes('401'), '原因带状态码', r.reason)

    const refused = async () => { throw new Error('ECONNREFUSED') }
    return T({ asrUrl: 'http://127.0.0.1:9' }, refused)
  }).then((r) => {
    eq(r.ok, false, '断网 → ok:false（绝不假装成功）')

    const avi = path.join(tmp, 'x.avi')
    fs.writeFileSync(avi, 'a')
    return transcribeAudio({ audioPath: avi, cfg: { asrUrl: 'http://127.0.0.1:8000' }, fetchFn: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  }).then((r) => {
    eq(r.ok, false, '不认识的扩展名被拒')
    ok(String(r.reason).includes('扩展名') || String(r.reason).includes('格式'), '原因说清楚是扩展名问题', r.reason)

    return transcribeAudio({ audioPath: wav, cfg: { asrUrl: 'http://127.0.0.1:8000', asrMaxBytes: 100 }, fetchFn: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  }).then((r) => {
    eq(r.ok, false, '超限被拒（本例上限 100B）')
    ok(asrVerifyHint().length > 20, 'verify 提示存在且非空')

    /* ============================================== ③ eta-calibrate ==== */
    console.log('\n—— eta-calibrate：分桶与自校准 ——')

    eq(sizeBucketOf(512, 512), 'tiny', '512² ≈ 0.26MP → tiny（≤0.6）')
    eq(sizeBucketOf(1024, 1024), 'small', '1024² ≈ 1.05MP → small（≤1.2）')
    eq(sizeBucketOf(1536, 1536), 'medium', '1536² ≈ 2.36MP → medium（≤2.5）')
    eq(sizeBucketOf(2048, 2048), 'large', '2048² ≈ 4.2MP → large')
    eq(sizeBucketOf(0, 0), null, '★ 尺寸非法 → null（不硬塞档位）')

    eq(stepBucketOf(8), 's8', '8 步 → s8')
    eq(stepBucketOf(25), 's30', '25 步 → s30 档')
    eq(stepBucketOf(-1), null, '步数非法 → null')

    eq(sampleKey({ kind: 'image', size: null, steps: 's8' }), '', '缺一维不给归档键')
    eq(sampleKey({ kind: 'image', size: 'small', steps: 's8' }), 'image:small:s8', '完整键')

    const g = { 1: { class_type: 'VHS_VideoCombine', inputs: {} }, 2: { class_type: 'SaveImage', inputs: {} } }
    eq(kindOfGraph(g), 'video', '★ 视频保存节点优先于 SaveImage（混合链生图段不串档）')
    eq(kindOfGraph({ 1: { class_type: 'KSampler', inputs: {} } }), '', '没有保存节点 → 空串')
    ok(JSON.stringify(shapeOfGraph({ 7: { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 832, height: 480, length: 49, steps: 4 } } }))
      === JSON.stringify({ width: 832, height: 480, steps: 4, frames: 49 }), '视频形状带 frames')

    eq(durationOfMessages([['execution_start', { timestamp: 0 }]]), null, '缺 success → null')
    eq(durationOfMessages([['execution_start', { timestamp: 0 }], ['execution_success', { timestamp: 50 }]]), null,
      '50ms < MIN_RUN_MS → 当缓存命中丢弃')
    eq(durationOfMessages([['execution_start', { timestamp: 0 }], ['execution_success', { timestamp: 21000 }]]), 21000,
      '正常区间取差值')

    const hist = {}
    const mk = (id, ms, cls, inputs) => {
      hist[id] = { prompt: [1, id, { 1: { class_type: cls, inputs } }], status: { messages: [
        ['execution_start', { timestamp: 0 }], ['execution_success', { timestamp: ms }] ] } }
    }
    for (let i = 0; i < 5; i += 1) mk(`a${i}`, 12000 + i * 300, 'SaveImage', { width: 1024, height: 1024, steps: 8 })
    hist.bad = { prompt: [1, 'bad', {}], status: { messages: [] } }
    const { samples, skipped } = extractSamples(hist)
    eq(samples.length, 5, '五条有效样本')
    eq(skipped.noDuration, 1, '无时间戳记入 skipped')

    const cal = buildCalibration(samples)
    const grp = cal.byKey['image:small:s8']
    eq(grp.samples, 5, '组内 5 条')
    eq(grp.dropped_max, true, '★ ≥3 条去最大值（首跑常含模型加载）')
    eq(grp.used, 4, '实际参算 4 条')
    eq(median([1, 2, 3]), 2, '奇数中位数')
    eq(median([1, 2, 3, 4]), 2.5, '偶数中位数')

    const pick = pickEta(cal, { kind: 'image', width: 1024, height: 1024, steps: 8 })
    eq(pick.detected, true, '同档命中')
    eq(pick.eta_basis, 'measured-local', '基准标「本机实测」')
    ok(pick.confidence === 'medium' || pick.confidence === 'high', `置信度合理（${pick.confidence}）`)
    ok(String(pick.note).includes('剔除'), 'note 说明去掉了首跑')

    const noBorrow = pickEta(cal, { kind: 'image', width: 512, height: 512, steps: 30 })
    eq(noBorrow.est_seconds, null, '★ 别的档位绝不借用（512²+30 步没跑过就是没有）')
    eq(noBorrow.eta_basis, 'unverified', 'basis 回退 unverified')

    const single = buildCalibration([{ key: 'tts:tiny:s8', ms: 4000 }])
    const p1 = pickEta(single, { kind: 'tts', width: 512, height: 512, steps: 4 })
    eq(p1.eta_basis, 'measured-local-single', '单样本如实标「仅一次」')
    eq(p1.confidence, 'low', '置信 low')

    /* ============================================== ④ mode-schema ==== */
    console.log('\n—— mode-schema：三模式差异化计划一致性 ——')

    const modeIds = new Set(MODES.map((m) => m.id))
    ok(Object.keys(MODE_PLANS).every((k) => modeIds.has(k)), '计划只覆盖真实存在的模式')
    eq(Object.keys(MODE_PLANS).length, MODES.length, '每个模式都有计划（不许漏）')

    const knownCards = new Set(['common', 'video-group', 'tts', 'library', 'reference', 'advanced'])
    const advKeys = new Set(CONTROLS.advanced.map((d) => d.key))
    for (const [id, plan] of Object.entries(MODE_PLANS)) {
      ok(typeof plan.tagline === 'string' && plan.tagline.length >= 8, `${id} 有像样的标语`, plan.tagline)
      ok(Object.keys(plan.cards).every((k) => knownCards.has(k)), `${id} 的卡片键都认识`, Object.keys(plan.cards).join(','))
      ok(Array.isArray(plan.advShow) && plan.advShow.every((k) => advKeys.has(k)),
        `${id} 的 advShow 都在 advanced 定义里`, plan.advShow.join(','))
    }
    ok(MODE_PLANS.image.cards['video-group'] === false && MODE_PLANS.image.cards.tts === false,
      '生图模式：视频组与 TTS 卡都不出现')
    ok(MODE_PLANS.hybrid.cards.tts === true && MODE_PLANS.hybrid.advShow.includes('chunkOverlap'),
      '混合模式：TTS 卡出现 + chunkOverlap 回归')
    ok(MODE_PLANS.video.advShow.includes('seed') === true && !MODE_PLANS.video.advShow.includes('tileSize'),
      '视频模式：保留种子、藏掉 VAE 分块')

    const snap = buildSchemaSnapshot()
    eq(snap.version, 2, '快照版本升到 2')
    ok(snap.modePlans === MODE_PLANS, '快照带出 modePlans（同一引用，不复制）')

    finish()
  }).catch((e) => { ok(false, 'ASR/ETA 阶段抛错', e.message); finish() })
}

function finish() {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
  process.exit(fail === 0 ? 0 : 1)
}

runRealContract()
