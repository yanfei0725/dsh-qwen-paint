// 真机端到端：图生图 + QwenTomePatchModel(ratio) → 看是否跑通、耗时、报错。
//
// 用法：node _tome_e2e.mjs <ratio> [tag]
//   例：node _tome_e2e.mjs 0      base
//       node _tome_e2e.mjs 0.5    tome50

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const H = 'http://127.0.0.1:8188'
const ratio = Number(process.argv[2] ?? 0)
const tag = process.argv[3] ?? `r${ratio}`

// ⚠ 相对本文件解析，不写死用户目录（打包的隐私检查会拦下绝对路径）
const REF = fileURLToPath(new URL('./_ref.png', import.meta.url))
const UNET = 'qwen_image_2.1_int8_convrot.safetensors'
const CLIP = 'qwen3vl_8b_w4a8.safetensors'
const VAE = 'qwen_image_2.1_vae_bf16.safetensors'

async function api(p, opt) {
  const r = await fetch(H + p, opt)
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`)
  return r.json()
}

async function upload(file) {
  const fd = new FormData()
  fd.append('image', new Blob([fs.readFileSync(file)]), path.basename(file))
  const r = await fetch(`${H}/upload/image`, { method: 'POST', body: fd })
  const j = await r.json()
  return j.name
}

function wf(imgName, seed) {
  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    4: { class_type: 'LoadImage', inputs: { image: imgName } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0], vae: ['3', 0], 'images.image_1': ['4', 0],
        prompt: 'a red sports car on a wet city street at night, cinematic lighting',
        negative_prompt: '', resolution: 1024,
      },
    },
    9: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['3', 0] } },
    15: ratio > 0 ? {
      class_type: 'QwenTomePatchModel',
      inputs: { model: ['1', 0], ratio, merge_mode: 'mean', debug: true },
    } : undefined,
    10: {
      class_type: 'KSampler',
      inputs: {
        model: [ratio > 0 ? '15' : '1', 0], positive: ['5', 0], negative: ['5', 0],
        latent_image: ['9', 0], seed, steps: 8, cfg: 1.0,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    11: { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    12: { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: `tome_${tag}` } },
  }
  if (g[15] === undefined) delete g[15]
  return g
}

async function run(seed) {
  const img = await upload(REF)
  const t0 = Date.now()
  const q = await api('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf(img, seed), client_id: 'tome-e2e' }),
  })
  if (q.node_errors && Object.keys(q.node_errors).length) {
    throw new Error('node_errors:\n' + JSON.stringify(q.node_errors, null, 2))
  }
  for (;;) {
    await new Promise(r => setTimeout(r, 800))
    const h = await api(`/history/${q.prompt_id}`)
    const rec = h[q.prompt_id]
    if (!rec) continue
    if (rec.status?.status_str === 'error') {
      const err = (rec.status.messages || []).find(m => m[0] === 'execution_error')
      throw new Error('执行失败:\n' + JSON.stringify(err?.[1], null, 2))
    }
    if (rec.status?.completed) {
      const wall = (Date.now() - t0) / 1000
      let fn = null
      for (const o of Object.values(rec.outputs || {})) {
        if (o?.images?.[0]) fn = o.images[0].filename
      }
      return { wall, fn }
    }
  }
}

const main = async () => {
  console.log(`=== ToMe 端到端 ratio=${ratio} tag=${tag} ===`)
  // 清缓存，避免命中结果缓存
  try { await api('/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: false, free_memory: true }) }) } catch {}
  const seeds = [777001, 777002]
  const times = []
  for (const s of seeds) {
    const { wall, fn } = await run(s)
    console.log(`  seed=${s}  耗时 ${wall.toFixed(2)}s  -> ${fn}`)
    times.push(wall)
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  console.log(`  平均 ${avg.toFixed(2)}s`)
  console.log(`RESULT ${tag} ${avg.toFixed(2)}`)
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
