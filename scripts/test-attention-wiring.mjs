#!/usr/bin/env node
/**
 * test-attention-wiring.mjs —— SageAttention / Comfy-WaveSpeed 「真接线」护栏（全离线）。
 *
 * 背景（2026-11-15 用户点名）：这两个后端以前只挂在孤立端点 + 实验室卡一个次级按钮里，
 *   主链路不消费、界面看不见，而且 caps.nodes 是内部能力名（qwen21/prefixCache），
 *   根本不是 /object_info 节点类名 ⇒ 模式发现永远探测不到，永远 degraded。
 *
 * 本测试把「接进加速链 / 接进工作流 / 卡片常驻显示 / 真实节点表探测」变成机器可判的护栏，
 *   并内建「改坏变红」反向核查。全程纯函数 + 只读文件：零联网、零出图、零子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAttentionWorkflowPatch, applyAttentionNodes, installedNodeNames,
  ATTENTION_WORKFLOW_VERSION,
} from '../lib/attention-workflow.js'
import { buildAccelChain, accelChainRouteTable } from '../lib/accel-chain.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (typeof name !== 'string') throw new Error('ok(名称, 条件)：第一个参数必须是名称')
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

const NODES = ['UNETLoader', 'KSampler', 'SageAttentionPatch', 'WaveSpeedFirstBlockCache', 'VAEDecode']

console.log('=== 1. 纯函数：默认零节点、类名只来自真实节点表 ===')
{
  ok('版本号为 1', ATTENTION_WORKFLOW_VERSION === 1)
  ok('三种 installed 形状都能列举',
    installedNodeNames(['A']).length === 1
    && installedNodeNames(new Set(['A'])).length === 1
    && installedNodeNames({ A: true, B: false }).join() === 'A')
  const off = buildAttentionWorkflowPatch({ installed: NODES, kind: 'image' })
  ok('★ 未显式启用时零节点（生成链逐字节不变）', off.nodes.length === 0 && off.accel_chain.length === 0)
  ok('★ 未启用也列出两条后端清单，不整段消失', off.available.length === 2)
  ok('未启用如实降级并给理由', off.degraded === true && off.reasons.length > 0)
  ok('倍率不进结论', off.unverified === true && !JSON.stringify(off).includes('2.1'))
  const on = buildAttentionWorkflowPatch({ installed: NODES, kind: 'image', enabled: 'sage_attention' })
  ok('★ 启用且探测到节点才插入', on.nodes.length === 1)
  ok('★ 类名来自 /object_info 候选，不是硬编码', on.nodes[0].class_type === 'SageAttentionPatch')
  // ★★ 2026-11-16 行为变更（有真机证据，不是放宽）：
  //   原先"槽位一个都没声明 ⇒ needsSlotMapping:true 且不塞参数"。真机装完
  //   Comfy-WaveSpeed 后发现这个策略会造出**静默无效**的节点（见下条），
  //   所以改成：宿主声明优先；没声明就回退到注册表里**经 /object_info 核实过**
  //   的槽位，并标 slotsVerified:true。needsSlotMapping 只在连核实过的槽位都没有时才为真。
  ok('★ 槽位已核实：不标 needsSlotMapping，且只写后端声明的槽位（model 由插入时填）',
    on.needsSlotMapping === false && on.slotsVerified === true
      && Object.keys(on.nodes[0].inputs).length === 0,
    JSON.stringify({ nsm: on.needsSlotMapping, sv: on.slotsVerified, inp: on.nodes[0].inputs }))
  // ★★ 真机陷阱：ApplyFBCacheOnModel 的 residual_diff_threshold 默认 0.0，而节点自己的
  //   tooltip 明写「Setting this to 0 disables the FBCache effect」⇒ 只写 model 会插进一个
  //   静默无效的节点（用户以为开了加速，其实什么都没变）。必须给 >0 的保守值。
  const wsDefault = buildAttentionWorkflowPatch({ installed: NODES, kind: 'image', enabled: 'wavespeed' })
  ok('★ WaveSpeed 启用时 residual_diff_threshold 必须 > 0（默认 0 等于关闭缓存）',
    Number(wsDefault.nodes[0]?.inputs?.residual_diff_threshold) > 0,
    JSON.stringify(wsDefault.nodes[0]?.inputs))
  // ★ 真机节点名是 ApplyFBCacheOnModel —— 既不含 FirstBlockCache 也不含 WaveSpeed，
  //   旧模式命中 0 个 ⇒ 装了也报"未安装"。夹具必须覆盖这个真名。
  const realName = buildAttentionWorkflowPatch({
    installed: ['ApplyFBCacheOnModel', 'KSampler'], kind: 'image', enabled: 'wavespeed',
  })
  ok('★ 认得出真机节点名 ApplyFBCacheOnModel（旧模式在这里命中 0 个）',
    realName.nodes[0]?.class_type === 'ApplyFBCacheOnModel', realName.nodes[0]?.class_type)
  // ★ 反向：两条后端都必须自带「已核实槽位 + 证据」，否则 needsSlotMapping 的
  //   静默降级路径会悄悄复活（这是本轮真机核实留下的契约）。
  const listed = off.available
  ok('★ 每条后端都声明 slotsVerified 与真机证据（防"未核实"路径静默复活）',
    listed.every((b) => b.slotsVerified === true && String(b.slotsEvidence).length > 20),
    JSON.stringify(listed.map((b) => [b.id, b.slotsVerified])))
  const withSlots = buildAttentionWorkflowPatch({
    installed: NODES, kind: 'image', enabled: 'wavespeed',
    acceptedInputs: ['model', 'cache_mode'], extraInputs: { cache_mode: 'fbcache', injected: 1 },
  })
  ok('★ 只写已声明且确实给值的槽位',
    withSlots.nodes[0].inputs.cache_mode === 'fbcache' && !('injected' in withSlots.nodes[0].inputs))
  const missing = buildAttentionWorkflowPatch({ installed: ['KSampler'], enabled: 'sage_attention' })
  ok('★ 探测不到就不插入工作流（不假装已启用）', missing.nodes.length === 0 && missing.degraded === true)
  const badId = buildAttentionWorkflowPatch({ installed: NODES, enabled: 'not_a_backend' })
  ok('未知后端 id 被拒', badId.nodes.length === 0)
}

console.log('\n=== 2. 节点真的插进模型链末端 ===')
{
  const nodes = { 1: { class_type: 'UNETLoader', inputs: {} } }
  const patch = buildAttentionWorkflowPatch({ installed: NODES, enabled: 'sage_attention' })
  const r = applyAttentionNodes(nodes, patch, '1')
  ok('★ 新节点 class_type 是探测到的真实类名', r.nodes['40'].class_type === 'SageAttentionPatch')
  ok('★ model 引用指回上一环', r.nodes['40'].inputs.model[0] === '1')
  ok('★ modelRef 推进到新节点（KSampler 直接吃它）', r.modelRef === '40' && r.applied.length === 1)
  const untouched = applyAttentionNodes({ 1: {} }, buildAttentionWorkflowPatch({ installed: NODES }), '1')
  ok('未启用时 unchanged:true、节点表不变',
    untouched.unchanged === true && untouched.modelRef === '1' && !('40' in untouched.nodes))
}

console.log('\n=== 3. 并进已有加速链（不再只有 image / tts 两段）===')
{
  const base = buildAccelChain({})
  ok('★ 加速链新增 attention 段', Array.isArray(base.accel_chain.attention))
  ok('默认 attention 为空，all 仍等于 image + tts',
    base.accel_chain.attention.length === 0
    && JSON.stringify(base.accel_chain.all) === JSON.stringify([...base.accel_chain.image, ...base.accel_chain.tts]))
  ok('★ attention_backends 直接可被卡片消费', base.attention_backends.available.length === 2)
  const on = buildAccelChain({ installed: NODES, attentionEnabled: 'sage_attention' })
  ok('★ 启用后真的进 accel_chain.all', on.accel_chain.all.includes('sage_attention'))
  ok('★ 启用后 attention 段非空', on.accel_chain.attention.includes('sage_attention'))
  ok('工作流补丁带真实类名', on.attention_backends.workflow_nodes[0].class_type === 'SageAttentionPatch')
  ok('reasons 带上注意力段理由', on.reasons.some((r) => r.includes('模型链')))
}

console.log('\n=== 4. ★ 端点接真实 /object_info（修掉「永远未探测到」）===')
{
  const fakeProbe = async () => ({ ok: true, nodes: NODES, reason: '' })
  const routes = accelChainRouteTable({
    respondJson: (res, body, code) => { res.body = body; res.code = code },
    isLocalRequest: (req) => req.local === true,
    cfg: {}, log: () => {}, objectInfoProbe: fakeProbe,
  })
  const res = { url: '/api/qwen-paint/accel/chain', local: true }
  await routes[0].handler(res, res)
  ok('★ 本机 GET 200', res.code === 200)
  ok('★ 端点自动探测 /object_info（UI 不需要传 installed）', res.body.probe.source === 'object_info')
  ok('★ 真实节点表让 SageAttention 变成已探测',
    res.body.attention_backends.available.some((b) => b.id === 'sage_attention' && b.available === true))
  ok('★ WaveSpeed 也变成已探测',
    res.body.attention_backends.available.some((b) => b.id === 'wavespeed' && b.available === true))
  const explicit = { url: '/api/qwen-paint/accel/chain?installed=tts_gguf', local: true }
  await routes[0].handler(explicit, explicit)
  ok('显式 query 优先，不覆盖用户传参', explicit.body.probe.source === 'query')
  const failed = accelChainRouteTable({
    respondJson: (r, b, c) => { r.body = b; r.code = c },
    isLocalRequest: () => true, cfg: {}, log: () => {},
    objectInfoProbe: async () => ({ ok: false, nodes: [], reason: '本机 /object_info 未就绪' }),
  })
  const fr = { url: '/api/qwen-paint/accel/chain' }
  await failed[0].handler(fr, fr)
  ok('★ 探测失败如实标 unavailable + 降级，不假装成功',
    fr.body.probe.source === 'unavailable' && fr.body.attention_backends.degraded === true)
}

console.log('\n=== 5. 两条真实工作流构造路径都接上了 ===')
{
  const config = read('lib/config.js')
  const turbo = read('lib/turbo-workflow.js')
  ok('★ config.js import 了 attention-workflow',
    config.includes("import { buildAttentionWorkflowPatch } from './attention-workflow.js'"))
  ok('★ config.js 真的调用并把节点 40 接进模型链末端',
    config.includes('const attentionPlan = buildAttentionWorkflowPatch(')
    && config.includes('40: withAttention') && config.includes("[7, 11, 12, 13, 14, 16, 17, 18, 19, 42, 40]"))
  ok('★ modelRef 在启用时指向 40', config.includes("withAttention ? '40'"))
  ok('★ turbo-workflow.js 也接上了',
    turbo.includes('buildAttentionWorkflowPatch') && turbo.includes('applyAttentionNodes'))
  ok('★ 默认关：两条路径都读 cfg.attentionBackend（未配置即零节点）',
    config.includes('enabled: cfg.attentionBackend') && turbo.includes('enabled: cfg.attentionBackend'))
}

console.log('\n=== 6. check_acceleration 报告 + UI 卡片 + 端点目录 ===')
{
  const comfy = read('lib/comfy-accel.js')
  ok('★ check_acceleration 报告透出 attentionBackends',
    comfy.includes('attentionBackends:') && comfy.includes('buildAttentionWorkflowPatch'))
  const lab = read('assets/lab.js')
  ok('★ 卡片常驻状态行（不是只藏在按钮后面）',
    lab.includes('var accelLine') && lab.includes('function paintAccelLine')
    && lab.includes('refreshAccelLine()') && lab.includes('attention_backends'))
  ok('★ 卡片显示真实探测来源', lab.includes("j.probe && j.probe.source === 'object_info'"))
  ok('★ 卡片有启用 / 恢复默认三个按钮',
    lab.includes("setAttention('sage_attention')") && lab.includes("setAttention('wavespeed')")
    && lab.includes("setAttention('')"))
  const registry = read('lib/tool-registry.js')
  ok('★ 注册层注入 objectInfoProbe（只走本机回环）',
    registry.includes('objectInfoProbe') && registry.includes('guardedFetch')
    && registry.includes('/object_info'))
  const desc = read('lib/integration-state.js')
  ok('★ 端点目录写明已并入加速链 + GET/POST',
    desc.includes("'/api/qwen-paint/accel/backends', method: 'GET, POST'")
    && desc.includes('已并入加速链'))
  const ces = read('lib/creative-extras.js')
  ok('★ 详情端点也补真实探测', ces.includes('deps.objectInfoProbe') && ces.includes('probe: probeInfo'))
}

console.log('\n=== 7. ★ 真机误报复盘：通用编译节点 / 超分节点不算 WaveSpeed ===')
{
  // 2026-11-15 真机 /object_info（1686 节点）实测：裸 CompileModel 会误匹配
  // TorchCompileModel*，裸 WaveSpeed 会误匹配 WavespeedImageUpscaleNode。
  const noise = ['TorchCompileModel', 'TorchCompileModelQwenImage', 'TorchCompileModelFluxAdvanced',
    'WavespeedImageUpscaleNode', 'WavespeedFlashVSRNode', 'KSampler',
    'PathchSageAttentionKJ', 'QwenImage21SageAttentionT8']
  const ws = buildAttentionWorkflowPatch({ installed: noise, enabled: 'wavespeed' })
  ok('★ 通用 TorchCompileModel 不被当成 Comfy-WaveSpeed', ws.nodes.length === 0)
  ok('★ Wavespeed 超分节点不被当成 First Block Cache',
    ws.available.find((b) => b.id === 'wavespeed').available === false)
  const sage = buildAttentionWorkflowPatch({ installed: noise, enabled: 'sage_attention' })
  ok('★ SageAttention 优先选 Qwen 专用节点，而不是字母序靠前的通用 patch',
    sage.nodes.length === 1 && sage.nodes[0].class_type === 'QwenImage21SageAttentionT8',
    sage.nodes[0] && sage.nodes[0].class_type)
  const fbc = buildAttentionWorkflowPatch({ installed: ['FirstBlockCache'], enabled: 'wavespeed' })
  ok('真 FirstBlockCache 节点仍能被识别',
    fbc.nodes.length === 1 && fbc.nodes[0].class_type === 'FirstBlockCache')
}

console.log('\n=== 8. ★ 反向核查：改坏必须变红（内存改串，不落盘） ===')
{
  const checks = [
    ['lib/config.js', '40: withAttention'],
    ['lib/turbo-workflow.js', 'applyAttentionNodes'],
    ['lib/comfy-accel.js', 'attentionBackends:'],
    ['assets/lab.js', 'function paintAccelLine'],
    ['lib/tool-registry.js', 'objectInfoProbe'],
  ]
  for (const [file, literal] of checks) {
    const src = read(file)
    ok('★ ' + file + ' 删掉 ' + literal + ' 后接线断言不成立',
      src.includes(literal) && !src.replaceAll(literal, '/* removed */').includes(literal))
  }
}

console.log(`\n=== test-attention-wiring：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
