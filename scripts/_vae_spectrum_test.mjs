/**
 * _vae_spectrum_test.mjs —— 两项**用户反馈落地**的回归（2026-10-12）。
 *
 * ① **VAE 大图分块解码**（防 OOM）：把工作流里的 `VAEDecode` 换成 ComfyUI **自带**的
 *    `VAEDecodeTiled`（零新增依赖）。判据是"档位 + 显存 + 尺寸"三道闸，
 *    且**节点不在时必须回退**（绝不发一个 ComfyUI 不认识的节点 —— 那会整单被拒收）。
 * ② **Spectrum 跳步加速**（跳过冗余 Qwen 前向）：接上本机**已装但从未被插件使用**的
 *    `QwenSpectrumModelPatcher`，接在模型链**最末端**（FA 之后、KSampler 之前），
 *    **默认关**（作者自述不保证兼容、不替你评估画质，且默认参数在 8 步链上收益存疑）。
 *
 * 全部**离线**：只查节点图，不起进程、不出图。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildWorkflow, describeOptimization, DEFAULTS } = mod.__internal

let fail = 0
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ← ${extra}` : ''}`)
  if (!cond) fail += 1
}

/** 造一份 caps；`nodes` 可覆盖，用来模拟"节点装了 / 没装"。 */
const capsOf = ({ vramGB = 20, name = 'AMD Radeon RX 7900 XT', nodes = {} } = {}) => ({
  level: 'full',
  probeFailed: false,
  gpu: { name, vramGB },
  nodes: {
    qwen21: true, prefixCache: true, teSpeed: true, speedup: true,
    blockCache: true, rdna3fa: true, loraOnly: true,
    vaeTiled: true, spectrum: true,
    ...nodes,
  },
  models: {
    unet: 'u.safetensors', clip: 'c.safetensors', vae: 'v.safetensors',
    turbo8Lora: 'turbo8_lora_step2500.safetensors',
  },
  notes: [],
})

/** 跑一次 buildWorkflow，把关心的几个点摘出来。 */
const run = (cfg, { w = 1024, h = 1024, caps = capsOf() } = {}) => {
  const r = buildWorkflow(cfg, { prompt: 't', width: w, height: h, seed: 1, count: 1 }, caps)
  const wf = r?.workflow ?? r
  const nodes = Object.values(wf).filter((n) => n?.class_type)
  const pick = (t) => nodes.find((n) => n.class_type === t)
  const tiled = pick('VAEDecodeTiled')
  return {
    /** 解码节点：优先看分块版，否则看普通版 */
    decode: tiled ? 'VAEDecodeTiled' : (pick('VAEDecode') ? 'VAEDecode' : '(无)'),
    tileSize: tiled?.inputs?.tile_size,
    overlap: tiled?.inputs?.overlap,
    spectrum: !!pick('QwenSpectrumModelPatcher'),
    spectrumWarmup: pick('QwenSpectrumModelPatcher')?.inputs?.warmup_steps,
    /** 采样器拿到的模型必须来自链末端 */
    modelRef: pick('KSampler')?.inputs?.model?.[0],
    /** 绝不能出现"没有 class_type 的空节点" */
    hasEmptyNode: Object.values(wf).some((n) => n && n.class_type === undefined),
  }
}

console.log('=== ① VAE 大图分块解码：三道闸（档位 / 显存 / 尺寸）===')
const base = { ...DEFAULTS }
ok('默认（20GB + 1024² · auto）→ **不**分块（本机不需要）',
  run(base, { w: 1024, h: 1024 }).decode === 'VAEDecode')
ok('显式 on（20GB + 1408²）→ 分块，且用了配置的 tile/overlap',
  (() => {
    const r = run({ ...base, vaeTiling: 'on' }, { w: 1408, h: 1408 })
    return r.decode === 'VAEDecodeTiled' && r.tileSize === 512 && r.overlap === 64
  })())
ok('8GB（5060）+ 1408² · auto → **自动分块**（显存紧 + 大图）',
  run(base, { w: 1408, h: 1408, caps: capsOf({ vramGB: 8, name: 'NVIDIA GeForce RTX 5060' }) }).decode
    === 'VAEDecodeTiled')
ok('8GB + 1024² · auto → **不**分块（尺寸不够，省那点开销）',
  run(base, { w: 1024, h: 1024, caps: capsOf({ vramGB: 8, name: 'NVIDIA GeForce RTX 5060' }) }).decode
    === 'VAEDecode')
ok('显式 off → 即使又大又紧也不分块',
  run({ ...base, vaeTiling: 'off' }, { w: 2048, h: 2048, caps: capsOf({ vramGB: 8 }) }).decode
    === 'VAEDecode')
ok('★ 节点没装（老 ComfyUI）→ **回退**到 VAEDecode，且**不发**不存在的节点',
  (() => {
    const r = run({ ...base, vaeTiling: 'on' }, { w: 2048, h: 2048, caps: capsOf({ nodes: { vaeTiled: false } }) })
    return r.decode === 'VAEDecode' && r.hasEmptyNode === false
  })())

console.log('\n=== ② Spectrum 跳步：默认关 + 接在链末端 ===')
ok('默认（spectrumEnabled 未开）→ 图里**没有** Spectrum 节点',
  run(base).spectrum === false)
ok('打开 → 节点在链上，且 **KSampler 的 model 指向它**（不是前面的节点）',
  (() => {
    const r = run({ ...base, spectrumEnabled: true })
    return r.spectrum === true && r.modelRef === '18'
  })())
ok('打开 → warmup_steps 用配置值（可针对 8 步链调小）',
  run({ ...base, spectrumEnabled: true, spectrumWarmupSteps: 2 }).spectrumWarmup === 2)
ok('★ 节点没装 + 却打开了开关 → **不发**不存在的节点（整单不会被拒收）',
  (() => {
    const r = run({ ...base, spectrumEnabled: true }, { caps: capsOf({ nodes: { spectrum: false } }) })
    return r.spectrum === false && r.hasEmptyNode === false
  })())
ok('★ 关闭时也不留空节点（18 号被 delete 掉）',
  run(base).hasEmptyNode === false)

console.log('\n=== ③ 面板与端点 ===')
{
  const caps = capsOf()
  const r = describeOptimization({ ...DEFAULTS }, caps)
  const find = (k) => r.detail.find((d) => d.name.includes(k))
  const vae = find('VAE 大图分块解码')
  const sp = find('Spectrum 跳步')
  ok('面板有「VAE 大图分块解码」项且带可点开关',
    !!vae && vae.toggle?.key === 'vaetiling' && vae.toggle.canToggle === true)
  ok('面板有「Spectrum 跳步加速」项，且标记为**可选**（默认关、不拉低 level）',
    !!sp && sp.optional === true && sp.toggle?.key === 'spectrum')
  ok('★ 20GB 机器上它**不会**把 level 拖成"部分启用"（判据不会触发 → 算可选项）',
    r.level === 'full' && r.ok === true, JSON.stringify({ level: r.level, reasons: r.reasons }))
  const r8 = describeOptimization({ ...DEFAULTS }, capsOf({ vramGB: 8, nodes: { vaeTiled: false } }))
  ok('★ 8GB 机器 + 节点缺失 → 如实**计入**缺口（不是假装没事）',
    r8.detail.find((d) => d.name.includes('VAE 大图分块'))?.state === 'available')
  ok('Spectrum 的 whyOff 写明了"默认关的三条理由"（不替用户拍板）',
    String(sp?.whyOff ?? '').includes('不保证通用兼容')
    && String(sp?.whyOff ?? '').includes('8 步'))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
