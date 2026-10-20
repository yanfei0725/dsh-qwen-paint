/**
 * ToMe 真机实测（AMD RX 7900 XT / ROCm 7.2.1 / ComfyUI 0.39.0）
 *
 * 目的：**用实测回答三个问题**，不靠读源码猜。
 *   ① ToMe 在这台 A 卡上到底能不能跑通？
 *   ② ratio 取多少才既有提速又不毁图？（0 / 0.1 / 0.2 / 0.3 / 0.5 全测）
 *   ③ 对**带文字**的图影响有多大？（这是 ToMe 最该被怀疑的地方）
 *
 * 做法：直接打 ComfyUI 的 /prompt API，构造"基准 vs 加 ToMe"两条链，
 *   同 seed 出图，比耗时 + 比像素差异（PSNR）。
 *
 * ⚠ 本脚本**只读不改**插件代码，纯实验。
 */
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:8188'
// ⚠ 相对本文件解析，不写死用户目录（打包的隐私检查会拦下绝对路径）
const SAVE_DIR = fileURLToPath(new URL('../_tome_probe', import.meta.url))

/** 本机实测确认过的工作点（与插件默认一致）。 */
const WIDTH = 1024
const HEIGHT = 1024
const SEED = 20261009
const STEPS = 8
const CFG = 1.0
const UNET = 'qwen_image_2.1_int8_convrot.safetensors'
const CLIP = 'qwen3vl_8b_w4a8.safetensors'
const VAE = 'qwen_image_2.1_vae_bf16.safetensors'
const TURBO_LORA = 'turbo8_lora_step2500.safetensors'

/** 造一个"与插件等价"的最简工作流；`tomeRatio === null` 表示不加 ToMe。 */
function build(tomeRatio, prompt) {
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    11: { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['2', 0], lora_name: TURBO_LORA, strength_model: 1, strength_clip: 1 } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'qwen_image' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['11', 1] } },
    6: { class_type: 'EmptyLatentImage', inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: [/* 由下面接管 */ '11', 0],
        positive: ['5', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed: SEED, steps: STEPS, cfg: CFG,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'tome_probe' } },
  }
  if (tomeRatio !== null) {
    wf[20] = { class_type: 'TomePatchModel', inputs: { model: ['11', 0], ratio: tomeRatio } }
    wf[8].inputs.model = ['20', 0]
  }
  return wf
}

async function queue(wf) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf }),
  })
  const body = await res.json()
  if (!res.ok || body.error) {
    throw new Error(`提交失败：${JSON.stringify(body.error ?? body).slice(0, 500)}`)
  }
  return body.prompt_id
}

/** 等任务结束并取回图片字节。 */
async function waitFor(promptId, timeoutMs = 180000) {
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('超时')
    const res = await fetch(`${BASE}/history/${promptId}`)
    const hist = await res.json()
    const entry = hist[promptId]
    if (entry && entry.status && entry.status.completed) {
      // 收集输出
      for (const nodeOut of Object.values(entry.outputs ?? {})) {
        for (const img of nodeOut.images ?? []) {
          const url = `${BASE}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${img.type ?? 'output'}`
          const bin = await fetch(url)
          const bytes = Buffer.from(await bin.arrayBuffer())
          return { bytes, filename: img.filename, seconds: (Date.now() - started) / 1000 }
        }
      }
      throw new Error('任务完成但没有输出图片')
    }
    if (entry && entry.status && entry.status.status_str === 'error') {
      const msgs = (entry.status.messages ?? []).map((m) => JSON.stringify(m)).join('\n')
      throw new Error(`执行报错：${msgs.slice(0, 800)}`)
    }
    await new Promise((r) => setTimeout(r, 700))
  }
}

/** 从 PNG 字节里读宽高（IHDR）。 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 解码 PNG 到 RGB 像素（仅支持 8bit / 非隔行 / colorType 2 或 6——ComfyUI 输出满足）。 */
async function decodePng(buf) {
  // 用 ComfyUI 前端同款思路太复杂；这里借用 Node 的 zlib 手工解
  const zlib = await import('node:zlib')
  let p = 8
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.slice(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG 格式 bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  // 反滤波
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    const cur = out.slice(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c)
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
        v = (v + pr) & 0xff
      }
      cur[x] = v
    }
  }
  return { width, height, channels, data: out }
}

/** PSNR（只用亮度，够判断"是否明显不同"）。 */
function psnr(a, b) {
  const n = Math.min(a.data.length, b.data.length)
  let mse = 0; let cnt = 0
  for (let i = 0; i < n; i += a.channels) {
    const va = a.data[i]; const vb = b.data[i]
    const d = va - vb
    mse += d * d; cnt++
  }
  mse /= cnt
  if (mse === 0) return 99
  return 10 * Math.log10((255 * 255) / mse)
}

/** 清晰度（拉普拉斯方差近似，用亮度差代替 —— 只为横向比较）。 */
function sharpness(img) {
  const { width, height, channels, data } = img
  let sum = 0; let sum2 = 0; let cnt = 0
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = (y * width + x) * channels
      const lum = (c) => data[i + c * channels]
      const center = lum(0)
      const lap = Math.abs(4 * center - lum(-1) - lum(1) - 0)
      sum += lap; sum2 += lap * lap; cnt++
    }
  }
  const mean = sum / cnt
  return Math.sqrt(Math.max(0, sum2 / cnt - mean * mean))
}

/* ══════════════════════════ 跑 ══════════════════════════ */

const PROMPT_PLAIN = '一只戴草帽的橘猫坐在窗台上，午后阳光，写实摄影'
// 带文字场景 —— ToMe 最该被怀疑的地方：token 合错了文字会糊/变形
const PROMPT_TEXT = '一张复古招牌，上面清晰写着 "OPEN" 五个字母，红底白字，正面拍摄，锐利'

const results = []

async function run(label, ratio, prompt) {
  const wf = build(ratio, prompt)
  const t0 = Date.now()
  const id = await queue(wf)
  const { bytes, seconds } = await waitFor(id)
  const size = pngSize(bytes)
  const img = await decodePng(bytes)
  const total = (Date.now() - t0) / 1000
  const out = { label, ratio, seconds: total, waitSeconds: seconds, size, img, bytes }
  writeFileSync(`${SAVE_DIR}/${label}.png`, bytes)
  console.log(`  ${label.padEnd(18)} ratio=${String(ratio).padEnd(4)} ${total.toFixed(2)}s  ${size.width}x${size.height}`)
  return out
}

async function main() {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(SAVE_DIR, { recursive: true })

  console.log('=== ① 无文字场景：找既有提速又不毁图的 ratio ===')
  console.log('  （每档跑一次，首跑含冷启预热 —— 用重复跑排除）')
  const base = await run('plain_base', null, PROMPT_PLAIN)
  // 再跑一次基准，取更快的那个作为"模型已热"的基准（冷启会污染对比）
  const baseHot = await run('plain_base_hot', null, PROMPT_PLAIN)
  const baseBest = baseHot.seconds < base.seconds ? baseHot : base
  console.log(`  ⇒ 基准取 ${baseBest.label}（${baseBest.seconds.toFixed(2)}s，已热）`)
  results.push(baseBest)

  for (const r of [0.1, 0.2, 0.3, 0.5]) {
    try {
      const out = await run(`plain_r${String(r).replace('.', '')}`, r, PROMPT_PLAIN)
      const p = psnr(baseBest.img, out.img)
      const shBase = sharpness(baseBest.img)
      const shOut = sharpness(out.img)
      out.psnr = p; out.speedup = baseBest.seconds / out.seconds
      out.sharpDelta = (shOut - shBase) / shBase * 100
      console.log(`      → PSNR ${p.toFixed(1)} dB | 提速 ${out.speedup.toFixed(2)}× | 清晰度变化 ${out.sharpDelta >= 0 ? '+' : ''}${out.sharpDelta.toFixed(1)}%`)
      results.push(out)
    } catch (e) {
      console.log(`      → ★ 失败：${e.message.slice(0, 200)}`)
    }
  }

  console.log('\n=== ② 带文字场景（ToMe 最该被怀疑的地方）===')
  const tBase = await run('text_base', null, PROMPT_TEXT)
  for (const r of [0.1, 0.2, 0.3]) {
    try {
      const out = await run(`text_r${String(r).replace('.', '')}`, r, PROMPT_TEXT)
      const p = psnr(tBase.img, out.img)
      out.psnr = p; out.speedup = tBase.seconds / out.seconds
      console.log(`      → PSNR ${p.toFixed(1)} dB | 提速 ${out.speedup.toFixed(2)}×`)
      results.push(out)
    } catch (e) {
      console.log(`      → ★ 失败：${e.message.slice(0, 200)}`)
    }
  }

  console.log('\n=== 汇总 ===')
  console.log('标签               ratio   耗时(s)   提速      PSNR(dB)')
  for (const r of results) {
    console.log(
      `${r.label.padEnd(18)} ${String(r.ratio ?? '基准').padEnd(7)} ${r.seconds.toFixed(2).padStart(7)}   `
      + `${(r.speedup ? r.speedup.toFixed(2) + '×' : '—').padStart(6)}   ${r.psnr !== undefined ? r.psnr.toFixed(1) : '—'}`,
    )
  }
  writeFileSync(`${SAVE_DIR}/_summary.json`, JSON.stringify(
    results.map((r) => ({ label: r.label, ratio: r.ratio, seconds: r.seconds, psnr: r.psnr, speedup: r.speedup, sharpDelta: r.sharpDelta })),
    null, 2))
  console.log(`\n图片已存到 ${SAVE_DIR}`)
}

main().catch((e) => { console.error('实测失败：', e.message); process.exit(1) })
