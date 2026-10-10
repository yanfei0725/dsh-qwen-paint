// 实测候选加速节点：BlockCache / SageAttention / Spectrum
// 全部走**图生图**（editing）场景，这是主人关心的场景。
//
// 用法：node _alts_e2e.mjs <变体> [tag]
//   变体: base | blockcache | sage | spectrum

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const H = 'http://127.0.0.1:8188'
const variant = process.argv[2] ?? 'base'
const tag = process.argv[3] ?? variant

// ⚠ 相对本文件解析，不写死用户目录（打包的隐私检查会拦下绝对路径）
const REF = fileURLToPath(new URL('./_ref.png', import.meta.url))
const UNET = 'qwen_image_2.1_int8_convrot.safetensors'
const CLIP = 'qwen3vl_8b_w4a8.safetensors'
const VAE = 'qwen_image_2.1_vae_bf16.safetensors'
const PROMPT = 'a red sports car on a wet city street at night, cinematic lighting'

async function api(p, opt) {
  const r = await fetch(H + p, opt)
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}

async function upload(file) {
  const fd = new FormData()
  fd.append('image', new Blob([fs.readFileSync(file)]), path.basename(file))
  const j = await (await fetch(`${H}/upload/image`, { method: 'POST', body: fd })).json()
  return j.name
}

// 模型链：UNET → [变体节点] → KSampler
function chainNodes() {
  const nodes = {}
  let tail = '1'
  const add = (id, class_type, inputs) => {
    nodes[id] = { class_type, inputs: { model: [tail, 0], ...inputs } }
    tail = id
  }
  if (variant === 'blockcache') {
    // 保守档：threshold 0.03（官方对 editing 的推荐起点）
    add('20', 'QwenImage21BlockCacheT8', {
      residual_diff_threshold: 0.03,
      start_percent: 0.1,
      end_percent: 0.9,
      max_consecutive_hits: 2,
      cache_device: 'cpu',
      metric_stride: 8,
      max_cache_mb: 1024,
      threshold_mode: 'two_stage',
      split_ratio: 0.35,
      late_threshold: 0.15,
    })
  } else if (variant === 'sage') {
    add('21', 'QwenImage21SageAttentionT8', { backend_mode: 'sage' })
  } else if (variant === 'spectrum') {
    add('22', 'QwenImage21SpectrumT8', {
      history: 4, degree: 2, ridge: 0.01, guard_threshold: 0.08,
      start_percent: 0.1, end_percent: 0.9, max_consecutive_hits: 1,
      cache_device: 'cpu', max_cache_mb: 1024,
      threshold_mode: 'two_stage', split_ratio: 0.35, late_threshold: 0.25,
    })
  }
  return { nodes, tail }
}

function wf(imgName, seed) {
  const { nodes, tail } = chainNodes()
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    4: { class_type: 'LoadImage', inputs: { image: imgName } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0], vae: ['3', 0], 'images.image_1': ['4', 0],
        prompt: PROMPT, negative_prompt: '', resolution: 1024,
      },
    },
    ...nodes,
    9: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['3', 0] } },
    10: {
      class_type: 'KSampler',
      inputs: {
        model: [tail, 0], positive: ['5', 0], negative: ['5', 0],
        latent_image: ['9', 0], seed, steps: 8, cfg: 1.0,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    11: { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    12: { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: `alt_${tag}` } },
  }
}

async function run(img, seed) {
  const t0 = Date.now()
  const q = await api('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf(img, seed), client_id: 'alts' }),
  })
  if (q.node_errors && Object.keys(q.node_errors).length) {
    throw new Error('node_errors:\n' + JSON.stringify(q.node_errors, null, 2))
  }
  for (;;) {
    await new Promise(r => setTimeout(r, 700))
    const h = await api(`/history/${q.prompt_id}`)
    const rec = h[q.prompt_id]
    if (!rec) continue
    if (rec.status?.status_str === 'error') {
      const err = (rec.status.messages || []).find(m => m[0] === 'execution_error')
      throw new Error('执行失败:\n' + JSON.stringify(err?.[1], null, 2))
    }
    if (rec.status?.completed) {
      let fn = null
      for (const o of Object.values(rec.outputs || {})) if (o?.images?.[0]) fn = o.images[0].filename
      return { wall: (Date.now() - t0) / 1000, fn }
    }
  }
}

const main = async () => {
  console.log(`=== 变体 ${variant} (tag=${tag}) ===`)
  const img = await upload(REF)
  const times = []
  // 两个不同 seed，避开结果缓存
  for (const s of [881001, 881002]) {
    const { wall, fn } = await run(img, s)
    console.log(`  seed=${s}  ${wall.toFixed(2)}s  -> ${fn}`)
    times.push(wall)
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  console.log(`  平均 ${avg.toFixed(2)}s`)
  console.log(`RESULT ${tag} ${avg.toFixed(2)}`)
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
