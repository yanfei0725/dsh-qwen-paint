// 量一下：千问 2.1 图生图时，注意力到底占多少时间。
// 目的：用数据决定 ToMe 值不值得继续修兼容层。
//
// 做法：跑两次同一个 prompt，只把 seed 换掉（避开 ComfyUI 结果缓存），
// 从 ComfyUI 的 /history 里读回每个节点的耗时，看 attention 相关节点占比。
//
// 用法：node _attn_cost.mjs <输入图绝对路径>

import fs from 'node:fs'
import path from 'node:path'

const HOST = '127.0.0.1:8188'
const BASE = `http://${HOST}`
const IMG = process.argv[2]

if (!IMG || !fs.existsSync(IMG)) {
  console.error('用法: node _attn_cost.mjs <输入图绝对路径>')
  process.exit(1)
}

function log(...a) { console.log(...a) }

async function api(p, opt) {
  const r = await fetch(BASE + p, opt)
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status} ${await r.text()}`)
  return r.json()
}

// 上传参考图
async function upload(file) {
  const buf = fs.readFileSync(file)
  const fd = new FormData()
  fd.append('image', new Blob([buf]), path.basename(file))
  const r = await fetch(`${BASE}/upload/image`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`upload -> ${r.status}`)
  const j = await r.json()
  return j.name
}

// 找一个真实存在的 checkpoint / unet
async function pickModel() {
  const oi = await api('/object_info/UNETLoader')
  const raw = oi.UNETLoader?.input?.required?.unet_name?.[0]
  const list = Array.isArray(raw) ? raw : []
  const qwen = list.filter(x => /qwen/i.test(x))
  return qwen[0] || list[0]
}

function buildPrompt(cfg) {
  const g = {
    3: { class_type: 'UNETLoader', inputs: { unet_name: cfg.unet, weight_dtype: 'default' } },
    4: { class_type: 'CLIPLoader', inputs: { clip_name: cfg.clip, type: 'qwen_image' } },
    5: { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: cfg.text, clip: ['4', 0] } },
    7: { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } }, // 占位，稍后删除
    8: { class_type: 'LoadImage', inputs: { image: cfg.image } },
  }
  delete g[7]
  g[9] = { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['5', 0] } }
  g[10] = {
    class_type: 'KSampler',
    inputs: {
      model: ['3', 0], positive: ['6', 0], negative: ['6', 0],
      latent_image: ['9', 0], seed: cfg.seed, steps: 8, cfg: 1.0,
      sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  }
  g[11] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['5', 0] } }
  g[12] = { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'attncost' } }
  return g
}

async function runOnce(cfg, tag) {
  const wf = buildPrompt(cfg)
  const t0 = Date.now()
  const q = await api('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'attncost' }),
  })
  if (q.node_errors && Object.keys(q.node_errors).length > 0) {
    throw new Error('node_errors: ' + JSON.stringify(q.node_errors, null, 2))
  }
  const id = q.prompt_id
  log(`[${tag}] prompt_id=${id} 已提交，等待...`)

  // 轮询 history
  for (;;) {
    await new Promise(r => setTimeout(r, 1000))
    const h = await api(`/history/${id}`)
    const rec = h[id]
    if (!rec) continue
    if (rec.status?.status_str === 'error') {
      const msgs = (rec.status.messages || []).filter(m => m[0] === 'execution_error')
      throw new Error('执行失败: ' + JSON.stringify(msgs, null, 2))
    }
    if (rec.status?.completed) {
      const wall = (Date.now() - t0) / 1000
      return { rec, wall }
    }
  }
}

function summarize(rec, wall, tag) {
  const out = rec.outputs || {}
  let total = 0
  const per = []
  for (const [nid, o] of Object.entries(out)) {
    if (typeof o?.time === 'number') { per.push([nid, o.time]); total += o.time }
  }
  // 注意：ComfyUI 没给每个节点单独计时的话，这里为空
  log(`[${tag}] 墙钟 ${wall.toFixed(2)}s`)
  if (per.length) {
    per.sort((a, b) => b[1] - a[1])
    for (const [nid, t] of per) {
      log(`   node ${nid}: ${t.toFixed(3)}s  (${(t / wall * 100).toFixed(1)}%)`)
    }
  } else {
    log(`   （/history 未提供逐节点计时）`)
  }
  // 检查输出尺寸
  for (const o of Object.values(out)) {
    if (o?.images?.[0]) {
      log(`   输出图: ${o.images[0].filename}  subfolder=${o.images[0].subfolder || ''}`)
    }
  }
  return { per, total }
}

const main = async () => {
  const cfgBase = {
    unet: await pickModel(),
    text: 'a red sports car on a wet city street at night, cinematic lighting',
    image: await upload(IMG),
  }
  // 需要从现有工作流里找 clip / vae；这里用插件生成的那份配置更稳
  const cfgFile = path.join(process.env.USERPROFILE || '.', 'Documents', 'dsh-qwen-paint', 'scripts', '_attn_cfg.json')
  let extra = {}
  if (fs.existsSync(cfgFile)) extra = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  const cfg = { ...cfgBase, ...extra }

  if (!cfg.clip || !cfg.vae) {
    log('!! 缺 clip_name / vae_name。请先创建 scripts/_attn_cfg.json：')
    log('   {"clip":"xxx.safetensors","vae":"yyy.safetensors"}')
    // 尝试自动探测
    const oiC = await api('/object_info/CLIPLoader')
    const oiV = await api('/object_info/VAELoader')
    const cList = oiC.CLIPLoader?.input?.required?.clip_name?.[0] || []
    const vList = oiV.VAELoader?.input?.required?.vae_name?.[0] || []
    log('   可用 clip:', JSON.stringify(cList.slice(0, 10)))
    log('   可用 vae :', JSON.stringify(vList.slice(0, 10)))
    if (!cfg.clip && cList.length) cfg.clip = cList.find(x => /qwen/i.test(x)) || cList[0]
    if (!cfg.vae && vList.length) cfg.vae = vList.find(x => /qwen/i.test(x)) || vList[0]
    log(`   自动选用 clip=${cfg.clip}  vae=${cfg.vae}`)
  }

  log('配置:', JSON.stringify(cfg, null, 2))
  log('')
  // 两次不同 seed，避开结果缓存
  const r1 = await runOnce({ ...cfg, seed: 111222333 }, 'run-A')
  summarize(r1.rec, r1.wall, 'run-A')
  log('')
  const r2 = await runOnce({ ...cfg, seed: 444555666 }, 'run-B')
  summarize(r2.rec, r2.wall, 'run-B')
  log('')
  log('=== 结论 ===')
  log(`图生图冷启：A ${r1.wall.toFixed(1)}s / B ${r2.wall.toFixed(1)}s`)
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
