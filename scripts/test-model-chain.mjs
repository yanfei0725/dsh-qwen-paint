#!/usr/bin/env node
/**
 * model-chain 工厂运行时断言（2026-11-20 补勘察报告 #16 缺口）：
 *   lib/model-chain.js 8 个节点工厂此前零运行时触及（test-cpu-profile 只 import prefixCacheNode），
 *   快速相位完全依赖源码锁——rdna3FaNode 的 class_type 写错一个词 ComfyUI 整单拒收。
 *
 * 切片（rdna3FaNode 纯函数 4 断言 + buildWorkflow 半集成 2 断言，零 mock 零联网）：
 *   断言清单与注入红映射来自勘察报告 #16（agent 直测方案）。
 *
 * 纯离线。
 */
import {
  rdna3FaNode, loraNode, fluxShiftNode, prefixCacheNode,
  teSpeedNode, speedupNode, blockCacheNode, easyCacheNode,
} from '../lib/model-chain.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('— rdna3FaNode 工厂（纯函数）')
{
  const n = rdna3FaNode('14')
  ok("★ class_type 逐字 = ApplyRDNA3FlashAttention（写错一词 ComfyUI 整单拒收）",
    n.class_type === 'ApplyRDNA3FlashAttention', JSON.stringify(n))
  ok("★ inputs.model 深度 = ['14', 0]（连接契约：KSampler 经 modelRef 链吃它）",
    JSON.stringify(n.inputs.model) === '["14",0]', JSON.stringify(n.inputs))
  ok("★ inputs 只有 model 一个键（对比 easyCacheNode 的 4 槽——本节点无其它参数）",
    Object.keys(n.inputs).length === 1 && 'model' in n.inputs, JSON.stringify(n.inputs))
  ok("★ modelRef 透传不写死（dc4a38b 后槽位可变，工厂不得写死上游号）",
    rdna3FaNode('43').inputs.model[0] === '43')
}

console.log('— buildWorkflow 半集成（vendor 门 × 槽位 17）')
{
  const { buildWorkflow } = await import('../lib/config.js')
  // 签名 = buildWorkflow(cfg, opts, caps) —— caps 是第三参；caps 缺省时 faCapsOmitted=true
  // 会跳过 vendor 门（无 caps 就不拦），所以 caps 必须显式传第三参。
  const opts = { prompt: 'x', frames: 25, height: 480 }
  const capsAmd = { nodes: { rdna3fa: true }, gpu: { name: 'AMD Radeon RX 7900 XT' } }
  const wf = buildWorkflow({}, opts, capsAmd)
  ok("★ AMD RDNA3 + rdna3fa 节点 → 槽 17 = ApplyRDNA3FlashAttention（快速相位首次有运行时防线）",
    wf['17']?.class_type === 'ApplyRDNA3FlashAttention', JSON.stringify(wf['17']))
  const capsNv = { nodes: { rdna3fa: true }, gpu: { name: 'NVIDIA GeForce RTX 4090' } }
  const wfNv = buildWorkflow({}, opts, capsNv)
  ok("★ NVIDIA 同条件 → 槽 17 不出现（faGpuOk vendor 门，不留幽灵节点）",
    wfNv['17'] === undefined, JSON.stringify(wfNv['17'] ?? null))
}

console.log('— 其余工厂直测（2026-11-20 扩展：class_type 逐字 + 默认值/白名单回落）')
{
  ok('loraNode：strength 非 finite 回落 1.0 + model 连接形态',
    (() => { const n = loraNode('9', 'x.safetensors', NaN)
      return n.class_type === 'LoraLoaderModelOnly' && n.inputs.strength_model === 1.0
        && JSON.stringify(n.inputs.model) === '["9",0]' })())
  ok('loraNode：finite strength 透传', loraNode('9', 'x', 0.8).inputs.strength_model === 0.8)
  ok('fluxShiftNode：width/height Math.round + 非数回落 1024',
    fluxShiftNode({ maxShift: 1.15, baseShift: 0.5 }, '5', 831.6, NaN).inputs.height === 1024
    && fluxShiftNode({ maxShift: 1, baseShift: 0.5 }, '5', 831.4, 480).inputs.width === 831)
  ok('★ prefixCacheNode：白名单外回落（dtype=bf16→int8 / device=SSD→auto；先 toLowerCase 再判，GPU=合法 gpu 值）',
    prefixCacheNode({ qwenCacheDtype: 'bf16' }, '5').inputs.dtype === 'int8'
    && prefixCacheNode({ qwenCacheDevice: 'SSD' }, '5').inputs.device === 'auto'
    && prefixCacheNode({ qwenCacheDevice: 'GPU' }, '5').inputs.device === 'gpu')
  ok('★ teSpeedNode：默认六件套（attention/step_cache/threshold 0.06/percent 0..1）',
    (() => { const n = teSpeedNode({}, '7')
      return n.class_type === 'TESpeedQwenImage21' && n.inputs.attention === 'kitchen_int8'
        && n.inputs.step_cache === 'te_predictor' && n.inputs.reuse_threshold === 0.06
        && n.inputs.start_percent === 0.0 && n.inputs.end_percent === 1.0 && n.inputs.verbose === false })())
  ok('speedupNode：默认阈值 0.30/target 0.05/maxConsecutiveSkips 3',
    (() => { const n = speedupNode({}, '7')
      return n.class_type === 'QwenImage21Speedup' && n.inputs.cache_threshold === 0.30
        && n.inputs.target_error === 0.05 && n.inputs.max_consecutive_skips === 3 })())
  ok('★ blockCacheNode：默认 device=cpu（cache 落 CPU 省显存）+ threshold 0.03/maxHits 2',
    (() => { const n = blockCacheNode({}, '7')
      return n.class_type === 'QwenImage21BlockCacheT8' && n.inputs.cache_device === 'cpu'
        && n.inputs.residual_diff_threshold === 0.03 && n.inputs.max_consecutive_hits === 2 })())
  ok('★ easyCacheNode：clampF 夹紧（越界值收到 0..3/0..1 区间而非原样透传）',
    (() => { const n = easyCacheNode({ easyCacheReuseThreshold: 99, easyCacheStartPercent: -1 }, '7')
      return n.class_type === 'EasyCache' && n.inputs.reuse_threshold === 3 && n.inputs.start_percent === 0 })()
    && easyCacheNode({}, '7').inputs.reuse_threshold === 0.2)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
