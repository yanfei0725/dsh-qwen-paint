// 走插件**真实** buildWorkflow 的图生图端到端验证。
// 目的：确认加了 BlockCache 之后，插件的完整链路真的能出图、且更快。
//
// 用法：node _plug_e2e.mjs [标签]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const H = 'http://127.0.0.1:8188'
const tag = process.argv[2] ?? 'plug'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const I = (await import(new URL('../lib/index.js', import.meta.url).href)).__internal

// ⚠ 相对本文件解析，不写死用户目录（打包的隐私检查会拦下绝对路径）
const REF = fileURLToPath(new URL('./_ref.png', import.meta.url))

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

async function run(img, seed, cfg) {
  // ★ 直接用插件的 buildWorkflow —— 这才是生产路径
  const caps = await I.probeCapabilities(cfg, () => {}, null, { force: false })
  const wf = I.buildWorkflow(cfg, {
    prompt: 'a red sports car on a wet city street at night, cinematic lighting',
    negative: '', width: 1024, height: 1024, steps: 8, seed, reference: img,
  }, caps)

  const eff = wf.__effective
  const t0 = Date.now()
  const q = await api('/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'plug-e2e' }),
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
      return { wall: (Date.now() - t0) / 1000, fn, eff }
    }
  }
}

const main = async () => {
  // ⚠ 必须给真实的 comfyUrl —— 空 cfg 会让探测去请求 "undefined/object_info/..."
  //   全部返回 error，看起来像"节点都没装"（我第一次就栽在这）。
  const cfg = {
    comfyUrl: 'http://127.0.0.1:8188',
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_w4a8.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    turbo8Lora: 'turbo8_lora_step2500.safetensors',
  }
  const caps = await I.probeCapabilities(cfg, () => {}, null, { force: true })
  const plan = I.resolvePlan(cfg, caps)
  console.log('=== 插件链路自检 ===')
  console.log('  caps.level      :', caps.level)
  console.log('  blockCache 节点 :', caps.nodes?.blockCache)
  console.log('  useTurbo:', plan.useTurbo, '| usePrefix:', plan.usePrefix,
              '| useTe:', plan.useTe, '| useSpeedup:', plan.useSpeedup,
              '| useBlockCache:', plan.useBlockCache)
  console.log('')

  const img = await upload(REF)
  const times = []
  for (const s of [991001, 991002]) {
    const { wall, fn, eff } = await run(img, s, cfg)
    console.log(`  seed=${s}  ${wall.toFixed(2)}s  -> ${fn}  生效尺寸=${eff?.width}x${eff?.height}`)
    times.push(wall)
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  console.log(`  平均 ${avg.toFixed(2)}s`)
  console.log(`RESULT ${tag} ${avg.toFixed(2)}`)
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
