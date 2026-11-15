#!/usr/bin/env node
/**
 * test-accel-chain.mjs —— 「加速链」联动回归 + 孤儿模块扫描。
 *
 * ★ 2026-11-14 用户亲订：单个功能完成 ≠ 最终完成，必须检查它是否与整个插件联动。
 *   本轮发现 5 个新模块只有测试 import、生产零引用（孤儿），其中 tts-accel 让用户在
 *   check_acceleration 里根本看不到 TTS 加速。这里把「接线」变成机器可判的护栏：
 *     · 15 个新模块每个都必须有生产 import（只有测试引用不算）；
 *     · 加速链必须在端点 / check_acceleration 报告 / 实验室 UI 三处都被消费；
 *     · TTS 加速必须真实出现在 accel_chain 里（探测到就选中，没探测到就如实降级并列清单）。
 *
 * ok() 风格：统一 **ok(名称, 条件)**（与 test-fab-clamp / test-audit-0321 同款）；
 * helper 内建写反自检 —— 第一个参数不是字符串直接抛，杜绝 ok(cond, name) 假绿。
 * 全程只读文件 + 纯函数实跑：零联网、零出图、零子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAccelChain, accelChainRouteTable, ACCEL_CHAIN_VERSION } from '../lib/accel-chain.js'
import { createExtras } from '../lib/tool-registry.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (typeof name !== 'string') throw new Error('ok(名称, 条件)：第一个参数必须是名称')
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

console.log('=== 1. 加速链全景：TTS 段必须在场 ===')
{
  const r = buildAccelChain({})
  ok('accel_chain 有 image / tts / all 三段',
    ['image', 'tts', 'all'].every((k) => Array.isArray(r.accel_chain[k])), JSON.stringify(Object.keys(r.accel_chain)))
  ok('★ TTS 加速段在 accel_chain 里（用户点名的问题）', 'tts' in r.accel_chain)
  ok('未探测到后端时如实降级，不假装可用',
    r.tts_accel.degraded === true && r.accel_chain.tts.length === 0 && r.tts_accel.fallbackReason.length > 0)
  ok('★ 降级时仍列出 TTS 后端清单（不能整段消失）',
    r.tts_accel.available.length === 5 && r.tts_accel.available.every((b) => b.unverified === true))
  ok('all = image + tts 逐项拼接',
    JSON.stringify(r.accel_chain.all) === JSON.stringify([...r.accel_chain.image, ...r.accel_chain.tts]))
  ok('未实测的倍率不写进结论（unverified 标记在场）', r.unverified === true)
  ok('版本号是 1', ACCEL_CHAIN_VERSION === 1 && r.version === 1)
}

console.log('\n=== 2. 真探测时 TTS 加速真的进链 ===')
{
  const r = buildAccelChain({
    installed: ['tts_gguf', 'vocoder_fp16', 'FirstBlockCache'], gpuVendor: 'AMD', steps: 20,
  })
  ok('★ TTS 选中 gguf + vocoder_fp16',
    JSON.stringify(r.accel_chain.tts) === JSON.stringify(['gguf', 'vocoder_fp16']), JSON.stringify(r.accel_chain.tts))
  ok('缓存后端 fbcache 也进 image 段', r.accel_chain.image.includes('fbcache'))
  ok('all 段包含两段之和', r.accel_chain.all.length === r.accel_chain.image.length + r.accel_chain.tts.length)
  ok('TTS patch 带上声码器 dtype', r.tts_accel.patch.vocoder_mel_dtype === 'float16')
  const nv = buildAccelChain({ installed: ['tts_cuda_graph', 'tts_triton'], gpuVendor: 'NVIDIA', vramMb: 16384, textLength: 500 })
  ok('N 卡可叠加成 hybrid', nv.tts_accel.hybrid === true)
  ok('CUDA Graph 有 max_seq_len 建议', Number.isFinite(nv.tts_accel.maxSeqLenHint))
}

console.log('\n=== 3. 5 个原孤儿模块都真实参与（不是只 import 不用） ===')
{
  const r = buildAccelChain({ cfg: { wrapperPolicy: 'nope', vramMode: 'nope' }, vramMb: 8 })
  ok('cache-backends 产出可用后端清单', r.cache_backends.available.length === 6)
  ok('vram-budget 产出真实预算建议', r.vram_budget.ok === true && r.vram_budget.limited === true)
  ok('config-consistency 检出配置矛盾', r.config_consistency.conflicts.length >= 2)
  ok('config-consistency 给出 wrapper 裁决', typeof r.config_consistency.wrapper.wrapper === 'string')
  ok('★ structured-log 真的记了一条加速链事件', r.structured_log.events === 1)
  ok('structured-log 按链分组可查', typeof r.structured_log.by_chain === 'object')
}

console.log('\n=== 4. 端点接线：注册 / 目录 / 本机围栏 ===')
{
  const routes = accelChainRouteTable({
    respondJson: (res, body, code) => { res.body = body; res.code = code },
    isLocalRequest: (req) => req.local === true,
    cfg: {}, log: () => {},
  })
  ok('端点表恰好一条且路径正确', routes.length === 1 && routes[0].path === '/api/qwen-paint/accel/chain')
  const res = { url: '/api/qwen-paint/accel/chain?installed=tts_gguf&gpu=AMD', local: true }
  await routes[0].handler(res, res)
  ok('本机 GET 返回 200 且含 TTS 段', res.code === 200 && res.body.accel_chain.tts.includes('gguf'))
  const denied = { url: '/api/qwen-paint/accel/chain', local: false }
  await routes[0].handler(denied, denied)
  ok('非本机请求被 403 拒绝', denied.code === 403)
  const extras = createExtras({ log: () => {} })
  ok('★ createExtras 真的注册了 accel/chain 端点',
    extras.routes.some((r) => r.path === '/api/qwen-paint/accel/chain'))
  ok('★ 端点目录登记了 accel/chain',
    INTEGRATION_ROUTES.some((r) => r.path === '/api/qwen-paint/accel/chain'),
    INTEGRATION_ROUTES.filter((r) => r.path.includes('accel')).map((r) => r.path).join(','))
}

console.log('\n=== 5. 三处消费：端点 / check_acceleration 报告 / 实验室 UI ===')
{
  const accelChainSrc = read('lib/accel-chain.js')
  ok('汇总模块 import 了 5 个原孤儿',
    ['cache-backends.js', 'tts-accel.js', 'vram-budget.js', 'config-consistency.js', 'structured-log.js']
      .every((f) => accelChainSrc.includes(f)))
  const comfyAccel = read('lib/comfy-accel.js')
  ok('★ check_acceleration 报告透出 ttsAccel 字段',
    comfyAccel.includes("import { TTS_ACCEL_BACKENDS, pickTtsAccel, ttsAccelToWorkflowPatch } from './tts-accel.js'")
    && comfyAccel.includes('ttsAccel:') && comfyAccel.includes('accel_chain: ttsAccelToWorkflowPatch(sel).accel_chain'))
  ok('check_acceleration 的 output.schema 允许附加字段（新字段不被判非法）',
    read('lib/index.js').includes('additionalProperties: true'))
  const lab = read('assets/lab.js')
  ok('★ 内嵌功能区有「加速链」入口并真的请求端点',
    lab.includes('accel/chain') && lab.includes('查看加速链'))
  ok('★★ 2026-11-15：实验室独立浮层已删，功能内嵌进 cp-panel 插槽',
    lab.includes('function mountInto(host)') && lab.includes('function findSlot()')
    && lab.includes('getPanelNode') && lab.includes('els.sections')
    && !lab.includes("el('div', 'dshqp-lab-mask')")
    && !lab.includes("el('button', 'dshqp-lab-fab'")
    && !lab.includes('els.host = findHost() || document.body'))
  ok('★ 点按有 document capture 兜底（防「点不动」）',
    lab.includes('installTapFallback') && lab.includes(', true)') && lab.includes('tapRegistry'))
  ok('★ panel.js 首次加载与 rebuild 时都把功能区重挂进插槽',
    read('assets/panel.js').includes('lab.mountInto(nodes.labSlot)')
    && read('assets/panel.js').includes('lab.mountInto(labSlot)'))
  ok('★ lab.css 已无 fixed 浮层，宽度跟随面板（不再自己算 left/top）',
    !read('assets/lab.css').includes('position: fixed')
    && read('assets/lab.css').includes('.dshqp-lab-slot')
    && !read('assets/lab.css').includes('inset: 0;'))
}

console.log('\n=== 6. ★ 孤儿扫描：新模块每个都必须有生产引用 ===')
{
  const NEW_MODULES = [
    'agent-guide', 'cache-backends', 'config-consistency', 'dag-planner', 'doctor',
    'gif-endpoints', 'gif-tool', 'history-admin', 'iterate-tool', 'job-queue',
    'job-tool', 'structured-log', 'tool-registry', 'tts-accel', 'vram-budget',
    'accel-chain',
    // ★ 2026-11-15 媒体格式转换批次：4 个新模块必须真实参与生产链路，
    //   不能只被测试 import。注册层 / 端点 / 工具 / 生成钩子四处都要接上。
    'media-formats', 'media-exec', 'media-convert-tool', 'media-convert-endpoints',
    'media-postconvert',
  ]
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const prodImporters = (m) => libFiles.filter((f) => f !== m + '.js' && read('lib/' + f).includes(m + '.js'))
  for (const m of NEW_MODULES) {
    const imp = prodImporters(m)
    ok('★ ' + m + ' 有生产引用（非孤儿）', imp.length > 0, imp.join(',') || 'NONE')
  }
  ok('assets/lab.js 由 panel.js 懒加载登记', read('assets/panel.js').includes('qwen-paint/lab.js'))
  ok('tool-registry 由 index.js 接线', read('lib/index.js').includes("from './tool-registry.js'"))
}

console.log(`\n=== test-accel-chain：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
