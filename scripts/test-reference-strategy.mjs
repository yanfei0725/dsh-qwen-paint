#!/usr/bin/env node
/**
 * test-reference-strategy.mjs —— 模型无关「角色参考」适配层离线回归。
 *
 * 纯 JS：直接 import lib/reference-strategy.js，不派生子进程、不联网、不读文件、
 * 不生成任何图片/视频。沙箱间歇性禁止 spawn 时本套件仍可独立跑通。
 *
 * 重点锁住的契约：
 *   · 能力协商：节点集归一化 / requires AND / requiresAny OR / 优先级 / 显式 prefer 回落
 *   · 与模型无关的「找法」：latent_image / vae / start_image 按输入槽而非类名找
 *   · /object_info 输入槽校验：没自报就不补槽，绝不臆造节点契约
 *   · 零漂移：没参考图 / 计划未落地时返回**同一对象引用**，连 structuredClone 都不做
 *   · applyReferencePlan 不原地改入参、denoise 只改本来就有该输入的节点
 *
 * 运行：node scripts/test-reference-strategy.mjs
 */
import {
  TIER, REFERENCE_STRATEGIES, UNIVERSAL_FALLBACK,
  normalizeNodeSet, strategyAvailable, availableStrategies, selectStrategy,
  capabilitySnapshot, findNodeByClass, nodeInputSlots, findVaeLink,
  findLatentImageTarget, findStartImageTarget, planReference,
  applyReferencePlan, adaptReference, planCharacterLock, describeStrategy,
} from '../lib/reference-strategy.js'

let pass = 0
let fail = 0
const fails = []

function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}
function eq(actual, expected, label) {
  const c = actual === expected
  if (!c) console.log(`      实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
  ok(c, label)
}
function deep(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) console.log(`      实际=${a} 期望=${b}`)
  ok(a === b, label)
}

/** 最小生图工作流：KSampler + VAELoader + VAEDecode（真实形状，避免"只测自己造的假图"）。 */
const imageWorkflow = () => ({
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
  '5': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], seed: 1, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['2', 0], negative: ['2', 1], latent_image: ['6', 0], denoise: 1.0,
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['3', 0] } },
})

const startImageSlot = { input: { required: {}, optional: { start_image: ['IMAGE'] } } }

console.log('\n[1] 策略表与约束层级')
ok(Object.isFrozen(REFERENCE_STRATEGIES), '策略表冻结，运行时不被偷偷改写')
ok(Object.isFrozen(UNIVERSAL_FALLBACK), '通用兜底冻结')
ok(Object.isFrozen(TIER), 'TIER 冻结')
ok(TIER.identity > TIER.style && TIER.style > TIER.structure && TIER.structure > TIER.universal,
  '约束层级有序：身份锁 > 风格 > 结构 > 通用兜底')
ok(REFERENCE_STRATEGIES.every((s) => typeof s.id === 'string' && Array.isArray(s.modes)
  && Number.isFinite(s.maxRefs) && Number.isFinite(s.priority) && typeof s.native === 'boolean'),
  '每条策略都有 id / modes / maxRefs / priority / native')
eq(new Set(REFERENCE_STRATEGIES.map((s) => s.id)).size, REFERENCE_STRATEGIES.length, '策略 id 无重复')
ok(REFERENCE_STRATEGIES.some((s) => s.modes.includes('image')) && REFERENCE_STRATEGIES.some((s) => s.modes.includes('video')),
  '策略表同时覆盖生图与视频模式')
ok(UNIVERSAL_FALLBACK.requires.length === 0 && UNIVERSAL_FALLBACK.requiresAny.length === 0,
  '通用兜底不要求任何模型专属节点')

console.log('\n[2] normalizeNodeSet —— /object_info 各种形状归一化')
eq(normalizeNodeSet(null).size, 0, 'null → 空集')
eq(normalizeNodeSet(undefined).size, 0, 'undefined → 空集')
eq(normalizeNodeSet(new Set(['A', 'B'])).size, 2, 'Set → 2 个节点')
eq(normalizeNodeSet(['A', 'B', 'A', '', 3]).size, 2, '数组 → 去重 / 丢非字符串 / 丢空串')
eq(normalizeNodeSet(new Map([['A', 1], ['B', 2]])).size, 2, 'Map 取键 → 2 个节点')
eq(normalizeNodeSet({ A: {}, B: {} }).size, 2, '全量 /object_info 对象取键 → 2 个节点')
eq(normalizeNodeSet({ nodes: { A: true, B: 1 } }).size, 2, '{nodes:{...}} 能力标志集 → 2 个节点')
ok(!normalizeNodeSet({ nodes: { A: true } }).has('nodes'), 'nodes 容器本身不被误当节点类名')

console.log('\n[3] strategyAvailable / availableStrategies / selectStrategy 能力协商')
ok(!strategyAvailable({ requires: ['A', 'B'], requiresAny: [] }, new Set(['A'])), 'requires 是 AND，缺一个即不可用')
ok(strategyAvailable({ requires: ['A', 'B'], requiresAny: [] }, new Set(['A', 'B'])), 'requires 全命中 → 可用')
ok(strategyAvailable({ requires: [], requiresAny: ['X', 'Y'] }, new Set(['Y'])), 'requiresAny 是 OR，命中任一即可用')
ok(!strategyAvailable({ requires: [], requiresAny: ['X', 'Y'] }, new Set(['Z'])), 'requiresAny 全不命中 → 不可用')
ok(strategyAvailable({ requires: [], requiresAny: [] }, new Set()), '空约束 → 恒可用（通用兜底的前提）')

const emptyList = availableStrategies(new Set(), 'image')
eq(emptyList.length, 1, '空节点集下只剩 1 条可用策略')
eq(emptyList[0].id, 'universal-latent', '空节点集时唯一可用的是通用兜底')
const richList = availableStrategies(new Set([
  'IPAdapterAdvanced', 'InstantIDApply', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'TextEncodeQwenImage21',
]), 'image')
ok(richList.length > 2, '多节点命中时列出多条策略')
ok(richList.every((s, i) => i === 0 || richList[i - 1].priority >= s.priority), '策略按 priority 降序')
eq(richList.at(-1).id, 'universal-latent', '通用兜底恒在末尾')
eq(richList[0].id, 'qwen-native-multi', '最高优先级策略被排在最前')
ok(availableStrategies(new Set(['IPAdapter']), 'video').every((s) => s.modes.includes('video')),
  'video 模式不混入只支持 image 的策略')

eq(selectStrategy(new Set(), { mode: 'image' }).id, 'universal-latent', '无能力信息 → 通用兜底')
eq(selectStrategy(new Set(['IPAdapter']), { mode: 'image' }).id, 'ipadapter', '命中 IPAdapter 节点 → 选 ipadapter')
eq(selectStrategy(new Set(['IPAdapter']), { mode: 'video' }).id, 'universal-latent', '生图专属节点在视频模式不生效')
eq(selectStrategy(new Set(['IPAdapter']), { mode: 'image', prefer: 'universal-latent' }).id,
  'universal-latent', '显式 prefer 命中可用策略时生效')
eq(selectStrategy(new Set(), { mode: 'image', prefer: 'ipadapter' }).id,
  'universal-latent', '点名策略不可用 → 按优先级回落，不硬报不可用')
eq(selectStrategy(new Set(), { mode: 'image', prefer: 'auto' }).id,
  'universal-latent', 'prefer=auto 等同自动协商')
ok(selectStrategy(new Set(), { mode: 'video' }) !== null, 'selectStrategy 永不为 null')

console.log('\n[4] capabilitySnapshot —— 面板/端点用的能力快照')
const snap = capabilitySnapshot(new Set(['IPAdapter', 'WanAnimateToVideo']), 'image')
eq(snap.nodeCount, 2, 'nodeCount 正确')
eq(snap.mode, 'image', 'mode 回显')
eq(snap.selected, selectStrategy(new Set(['IPAdapter', 'WanAnimateToVideo']), { mode: 'image' }).id,
  'selected 与 selectStrategy 一致')
eq(snap.universal, true, 'universal:true 明确告诉前端"任何后端都能用"')
ok(snap.strategies.every((s) => typeof s.available === 'boolean'), '每条策略都带 available 标志')
ok(snap.strategies.find((s) => s.id === 'universal-latent').available === true, '通用兜底恒 available')
ok(snap.strategies.every((s) => s.modes === undefined || s.modes.includes('image')),
  '快照只列该模式的策略')
eq(typeof JSON.stringify(snap), 'string', '快照是纯数据，可 JSON.stringify')
ok(!('WanAnimateToVideo' in JSON.parse(JSON.stringify(snap))), '快照不泄漏节点集合原文')

console.log('\n[5] nodeInputSlots —— 以 /object_info 自报槽位为准')
const info = {
  Foo: { input: { required: { pixels: ['IMAGE'] }, optional: { start_image: ['IMAGE'] } } },
  Bar: { input: { required: { width: ['INT'] } } },
  Baz: {},
}
const slots = nodeInputSlots(info, 'Foo')
ok(slots instanceof Set, '返回 Set')
ok(slots !== null && slots.has('pixels') && slots.has('start_image'), 'required 与 optional 槽位合并')
ok(nodeInputSlots(info, 'Bar').has('width'), '只有 required 的节点也能读')
ok(!nodeInputSlots(info, 'Bar').has('start_image'), '未声明的槽位不凭空出现')
eq(nodeInputSlots(info, 'Nope'), null, '节点类不存在 → null（调用方须保守）')
eq(nodeInputSlots(info, 'Baz'), null, '没有 input 字段 → null')
eq(nodeInputSlots(null, 'Foo'), null, '无 object_info → null')
eq(nodeInputSlots(new Set(), 'Foo'), null, '稀疏节点集不含槽位契约 → null')
eq(nodeInputSlots(info, ''), null, '空类名 → null')
eq(nodeInputSlots(info, 3), null, '非字符串类名 → null')

console.log('\n[6] 与模型无关的查找：不写死模型节点类名')
eq(findNodeByClass(imageWorkflow(), 'VAEDecode'), '8', 'findNodeByClass 能定位节点')
eq(findNodeByClass({}, 'VAEDecode'), null, '找不到时返回 null')
deep(findVaeLink(imageWorkflow()), ['3', 0], 'VAE 优先复用解码节点现有的 vae 接线')
deep(findVaeLink({ '9': { class_type: 'SomeDecoder', inputs: { vae: ['3', 0] } } }), ['3', 0],
  '无标准解码节点时，按"谁有 vae 输入"找（模型无关）')
deep(findVaeLink({ '3': { class_type: 'VAELoader', inputs: { vae_name: 'x' } } }), ['3', 0],
  '再退一步找独立 VAELoader')
deep(findVaeLink({ '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x' } } }), ['1', 2],
  '再退一步用 checkpoint 第 2 号输出')
eq(findVaeLink({}), null, '没有任何 VAE 线索 → null（不臆造）')
eq(findVaeLink({ '9': { class_type: 'Foo', inputs: { vae: 'not-a-link' } } }), null,
  'vae 不是合法 link 时不当作接线')

eq(findLatentImageTarget(imageWorkflow()), '5', '找到带 latent_image 的采样器')
eq(findLatentImageTarget({ '42': { class_type: 'ForeignSampler', inputs: { latent_image: ['6', 0] } } }), '42',
  '★ 自定义采样器（非 KSampler）也能找到 —— 适配所有模型的关键')
eq(findLatentImageTarget({ '5': { class_type: 'KSampler', inputs: { seed: 1 } } }), null,
  'KSampler 没有 latent_image 输入时也不凭空补')
eq(findLatentImageTarget({}), null, '空工作流 → null')

eq(findStartImageTarget({ '7': { class_type: 'KSampler', inputs: { start_image: '' } } }, null), '7',
  '工作流已有 start_image 槽 → 直接命中，无需 object_info')
// ★ 旧正则 /image2?video|i2v/ 里的 "2?" 只是"可选字符 2"，匹配不到 ImageToVideo，
//   实测整条通用兜底从未生效。这组断言把三种命名全部锁住。
for (const cls of ['Wan22ImageToVideoLatent', 'FooImage2Video', 'CustomI2VNode', 'BarImageToVideoX']) {
  const wf = { '7': { class_type: cls, inputs: {} } }
  eq(findStartImageTarget(wf, { [cls]: startImageSlot }), '7',
    `object_info 自报 start_image 时允许补槽：${cls}`)
}
eq(findStartImageTarget({ '7': { class_type: 'Wan22ImageToVideoLatent', inputs: {} } }, null), null,
  '★ 无 object_info 时绝不凭空补 start_image 槽')
eq(findStartImageTarget({ '7': { class_type: 'KSampler', inputs: {} } }, { KSampler: startImageSlot }), null,
  '类名不是 I2V 类时不补槽（不给采样器凭空加输入）')
eq(findStartImageTarget(
  { '7': { class_type: 'Wan22ImageToVideoLatent', inputs: {} } },
  { Wan22ImageToVideoLatent: { input: { required: {}, optional: {} } } },
), null, 'object_info 未声明 start_image 时不补槽')

console.log('\n[7] planReference —— 声明式注入计划')
const noRef = planReference(UNIVERSAL_FALLBACK, { mode: 'image', refs: [], workflow: imageWorkflow() })
eq(noRef.applied, false, '没有参考图 → 不落地')
ok(noRef.notes.some((n) => n.includes('没有参考图')), '没有参考图时如实说明')
const native = REFERENCE_STRATEGIES.find((s) => s.id === 'qwen-native-multi')
const nativePlan = planReference(native, { mode: 'image', refs: ['a.png'], workflow: imageWorkflow() })
eq(nativePlan.applied, false, '原生编码器策略 → 零漂移，不注入节点')
deep(nativePlan.nodePatches, [], '原生策略不产生节点补丁')

const pImg = planReference(UNIVERSAL_FALLBACK, { mode: 'image', refs: ['ref.png'], workflow: imageWorkflow() })
eq(pImg.applied, true, '生图通用兜底可落地')
eq(pImg.nodePatches.length, 2, '注入 LoadImage + VAEEncode 两个节点')
eq(pImg.nodePatches[0].spec.inputs.image, 'ref.png', 'LoadImage 指向上传后的参考图文件名')
deep(pImg.nodePatches[1].spec.inputs.vae, ['3', 0], 'VAEEncode 复用工作流现有 vae 接线')
deep(pImg.nodePatches[1].spec.inputs.pixels, ['__cp_ref_load', 0], 'VAEEncode.pixels 接 LoadImage')
deep(pImg.rewires[0], { nodeId: '5', input: 'latent_image', from: ['__cp_ref_vae', 0] },
  '采样器 latent_image 改接到 VAEEncode')
eq(pImg.denoise, 0.6, 'denoise 降到 0.6 锁外观')

const noSampler = { '3': { class_type: 'VAELoader', inputs: {} }, '8': { class_type: 'VAEDecode', inputs: { vae: ['3', 0] } } }
const pNoSampler = planReference(UNIVERSAL_FALLBACK, { mode: 'image', refs: ['r.png'], workflow: noSampler })
eq(pNoSampler.applied, false, '找不到采样节点 → 不落地')
eq(pNoSampler.nodePatches.length, 0, '不落地时不注入任何节点')
ok(pNoSampler.notes.some((n) => n.includes('latent_image')), '不落地原因如实写进 notes')
const noVae = { '5': { class_type: 'KSampler', inputs: { latent_image: ['6', 0], denoise: 1 } } }
const pNoVae = planReference(UNIVERSAL_FALLBACK, { mode: 'image', refs: ['r.png'], workflow: noVae })
eq(pNoVae.applied, false, '找不到 VAE 来源 → 不落地')
eq(pNoVae.nodePatches.length, 0, '★ 不提交一个 ComfyUI 必拒的 VAEEncode')
ok(pNoVae.notes.some((n) => n.includes('VAE')), '缺 VAE 的原因如实写进 notes')

const pMany = planReference(UNIVERSAL_FALLBACK, {
  mode: 'image', refs: ['a.png', 'b.png', 'c.png'], workflow: imageWorkflow(),
})
ok(pMany.notes.some((n) => n.includes('超过')), '超过 maxRefs 时不静默截断')
eq(pMany.nodePatches[0].spec.inputs.image, 'a.png', '只用第一张参考图')
ok(!JSON.stringify(pMany).includes('b.png'), '多出的参考图不进工作流')

const wfWithSlot = { '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { start_image: '' } } }
const pVid = planReference(UNIVERSAL_FALLBACK, { mode: 'video', refs: ['r.png'], workflow: wfWithSlot })
eq(pVid.applied, true, '视频：已有 start_image 槽时可落地')
eq(pVid.nodePatches.length, 1, '视频只注入一个 LoadImage')
deep(pVid.rewires[0], { nodeId: '7', input: 'start_image', from: ['__cp_ref_load', 0] },
  '参考图改接起始关键帧')
const wfNoSlot = { '7': { class_type: 'Wan22ImageToVideoLatent', inputs: {} } }
const pVidNo = planReference(UNIVERSAL_FALLBACK, { mode: 'video', refs: ['r.png'], workflow: wfNoSlot })
eq(pVidNo.applied, false, '视频：无槽且无 object_info → 不落地')
eq(pVidNo.nodePatches.length, 0, '★ 不注入一个悬空的 LoadImage')
ok(pVidNo.notes.some((n) => n.includes('start_image')), '不落地原因如实写进 notes')
const pVidOk = planReference(UNIVERSAL_FALLBACK, {
  mode: 'video', refs: ['r.png'], workflow: wfNoSlot,
  objectInfo: { Wan22ImageToVideoLatent: startImageSlot },
})
eq(pVidOk.applied, true, '视频：object_info 自报可选槽时才允许补槽')
const ipadapter = REFERENCE_STRATEGIES.find((s) => s.id === 'ipadapter')
const pAdv = planReference(ipadapter, { mode: 'image', refs: ['r.png'], workflow: imageWorkflow() })
eq(pAdv.applied, true, '协商到专属适配器仍用通用兜底真正落地')
ok(pAdv.notes.some((n) => n.includes('不假装已启用高级注入')), '如实说明未启用高级节点，不虚报能力')

console.log('\n[8] applyReferencePlan —— 不改入参、不臆造节点契约')
const wfImg = imageWorkflow()
const before = JSON.stringify(wfImg)
const applied = applyReferencePlan(wfImg, planReference(UNIVERSAL_FALLBACK, {
  mode: 'image', refs: ['r.png'], workflow: wfImg,
}))
ok(applied.workflow !== wfImg, '返回新对象，不复用入参引用')
eq(JSON.stringify(wfImg), before, '★ 绝不原地改传入的工作流')
eq(applied.applied, true, 'applied 正确')
ok(applied.workflow['__cp_ref_load'] !== undefined, 'LoadImage 节点已注入')
deep(applied.workflow['5'].inputs.latent_image, ['__cp_ref_vae', 0], 'latent_image 已改接')
eq(applied.workflow['5'].inputs.denoise, 0.6, 'denoise 已改')
eq(wfImg['5'].inputs.denoise, 1.0, '原工作流 denoise 保持 1.0')
const notApplied = applyReferencePlan(imageWorkflow(), { applied: false, notes: ['跳过'] })
eq(notApplied.applied, false, 'plan.applied:false 时不注入')
eq(Object.keys(notApplied.workflow).length, 3, '未落地时工作流节点数不变')
ok(notApplied.workflow !== wfImg, '未落地时仍是克隆对象（调用方自己判断要不要丢弃）')

const advWf = {
  '5': { class_type: 'KSampler', inputs: { latent_image: ['6', 0], denoise: 1.0 } },
  '9': { class_type: 'KSamplerAdvanced', inputs: { latent_image: ['6', 0] } },
}
const advApplied = applyReferencePlan(advWf, {
  applied: true, notes: [], nodePatches: [], rewires: [], denoise: 0.6,
})
eq(advApplied.workflow['5'].inputs.denoise, 0.6, '本来有 denoise 的节点被改')
ok(!Object.prototype.hasOwnProperty.call(advApplied.workflow['9'].inputs, 'denoise'),
  '★ KSamplerAdvanced 本来没有 denoise 输入时绝不凭空加（加了 ComfyUI 会拒单）')
const missingTarget = applyReferencePlan({}, {
  applied: true, notes: [], nodePatches: [],
  rewires: [{ nodeId: '404', input: 'x', from: ['1', 0] }],
})
ok(missingTarget.notes.some((n) => n.includes('部分连线目标节点不存在')),
  '连线目标不存在时如实记 notes，不静默报错')

console.log('\n[9] adaptReference —— 零漂移契约（最重要）')
const zWf = imageWorkflow()
const zNoRef = adaptReference({ workflow: zWf, mode: 'image', refs: [], nodeSet: new Set() })
ok(zNoRef.workflow === zWf, '★ 没参考图 → 原样返回同一对象引用')
eq(zNoRef.applied, false, '没参考图 → applied:false')
const zNativeWf = imageWorkflow()
const zNative = adaptReference({
  workflow: zNativeWf, mode: 'image', refs: ['a.png'],
  nodeSet: new Set(['TextEncodeQwenImage21']),
})
ok(zNative.workflow === zNativeWf, '★ 协商到 native 策略 → 同一对象引用，零漂移')
eq(zNative.applied, false, 'native 策略 → applied:false')
const zBadWf = { '7': { class_type: 'Wan22ImageToVideoLatent', inputs: {} } }
const zBad = adaptReference({ workflow: zBadWf, mode: 'video', refs: ['r.png'], nodeSet: new Set() })
ok(zBad.workflow === zBadWf, '★ 计划未落地 → 同一对象引用（不白做 structuredClone）')
eq(zBad.applied, false, '计划未落地 → applied:false')

const metaWf = imageWorkflow()
Object.defineProperty(metaWf, '__plan', { value: { secret: 1 }, enumerable: false, configurable: true })
const zMeta = adaptReference({ workflow: metaWf, mode: 'image', refs: [], nodeSet: new Set() })
ok(zMeta.workflow === metaWf, '带不可枚举元信息时零漂移仍是同一引用')
eq(zMeta.workflow.__plan.secret, 1, '★ __plan 等不可枚举元信息完整保留（structuredClone 会丢）')

const aWf = imageWorkflow()
const aBefore = JSON.stringify(aWf)
const aHit = adaptReference({ workflow: aWf, mode: 'image', refs: ['r.png'], nodeSet: new Set() })
ok(aHit.workflow !== aWf, '真正落地时才返回新对象')
eq(aHit.applied, true, '落地 → applied:true')
ok(aHit.workflow['__cp_ref_load'] !== undefined, '落地后含参考图节点')
eq(JSON.stringify(aWf), aBefore, '★ 落地路径也不改入参')
eq(aHit.strategy.id, 'universal-latent', '空节点集 → 通用兜底')

const aFall = adaptReference({
  workflow: imageWorkflow(), mode: 'image', refs: ['r.png'],
  nodeSet: new Set(), prefer: 'ipadapter',
})
eq(aFall.strategy.id, 'universal-latent', '点名策略不可用 → 回落到通用兜底')
ok(aFall.notes.some((n) => n.includes('回落')), '★ 回落必须写进 notes，不静默假装用了点名策略')

const fullInfo = { Wan22ImageToVideoLatent: startImageSlot }
const aVid = adaptReference({
  workflow: { '7': { class_type: 'Wan22ImageToVideoLatent', inputs: {} } },
  mode: 'video', refs: ['r.png'], nodeSet: fullInfo,
})
eq(aVid.applied, true, '★ 全量 /object_info 同时作能力协商与输入槽契约来源')
deep(aVid.workflow['7'].inputs.start_image, ['__cp_ref_load', 0], '起始关键帧槽位已按契约补上')

console.log('\n[10] planCharacterLock —— 视频分段计划（只产数据，不虚报已平滑）')
const lock = planCharacterLock({ totalFrames: 81, chunkFrames: 25, overlap: 8, seed: 12345 })
eq(lock.totalFrames, 81, '总帧数回显')
eq(lock.chunkFrames, 25, '分段长度回显')
eq(lock.overlap, 8, '重叠回显')
eq(lock.fixedSeed, true, '给了 seed → 全段固定')
ok(lock.segments.every((s) => s.seed === 12345), '每段 seed 一致（不逐段换 seed）')
ok(lock.segments.every((s) => s.startFrame + s.length <= lock.totalFrames), '任何段都不越界')
ok(lock.segments.every((s) => s.length > 0), '没有空段')
ok(lock.segments.every((s) => s.anchorTo === 'global-first-frame'), '默认全段锚定全局首帧')
ok(lock.notes.some((n) => n.includes('未自动接入')), '★ 如实标注未接入 RIFE / 时序平滑，不谎称已平滑')
const dflt = planCharacterLock()
eq(dflt.totalFrames, 49, '默认总帧数 49')
eq(dflt.segments.length, 3, '默认 49/25/8 → 3 段（step=17）')
eq(dflt.segments[2].startFrame, 34, '第 3 段起始帧 34')
eq(dflt.segments[2].length, 15, '第 3 段长度 15（不硬凑 25）')
eq(dflt.fixedSeed, false, '未给 seed → 不谎称固定')
eq(dflt.segments[0].seed, 'per-run-random', '未给 seed 时如实标注每次随机')
const clamped = planCharacterLock({ totalFrames: 20, chunkFrames: 25, overlap: 100 })
eq(clamped.overlap, 24, 'overlap 被 clamp 到 chunk-1，避免 step 为 0 死循环')
eq(clamped.segments.length, 20, 'clamp 后不产生死循环')
const every = planCharacterLock({ totalFrames: 30, chunkFrames: 25, overlap: 8, anchor: 'every-segment' })
ok(every.segments.every((s) => s.anchorTo === 'segment-first-frame'), 'anchor=every-segment 时每段锚定段首帧')

console.log('\n[11] describeStrategy')
ok(describeStrategy(UNIVERSAL_FALLBACK).includes('通用兜底'), '摘要含策略名')
ok(describeStrategy(UNIVERSAL_FALLBACK).includes('最多 1 张'), '摘要含参考图上限')
eq(describeStrategy(null), '未协商', 'null → 未协商')

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
