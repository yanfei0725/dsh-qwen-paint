/**
 * ★★★ 关键验证：QwenToMe 兼容层在**真机**上到底通不通。
 *
 * 上一轮已确认的事实（读源码 + 实跑）：
 *   · ComfyUI 内建的 `TomePatchModel` 在千问 2.1 上**必崩**：
 *       TypeError: tomesd_m() got an unexpected keyword argument 'pe'
 *   · 原因是接口契约不同（关键字 `pe` + 返回 dict vs 位置参数 + 返回 tuple）
 *   · 这是**代码层面的不兼容，不是显卡问题** —— N 卡同样会崩
 *
 * 本脚本要回答的问题：
 *   ① 自研的 `QwenTomePatchModel` 能不能把那条 TypeError 修掉（**能跑通**）?
 *   ② 图生图场景下（有参考图 + 有 prompt）提速多少？画质损失多少？
 *   ③ 对照组：内建节点是否仍然崩（用来证明"确实修了什么"，而不是碰巧）
 *
 * ⚠ 测量方法学（上一轮踩过的坑，这里必须避开）：
 *   ComfyUI 对**完全相同的 prompt** 会直接返回缓存结果 —— 那样量到的是
 *   HTTP 往返（0.7s），不是生成耗时。所以每次跑都用**不同的 seed**，
 *   并显式清一次缓存，保证每次都真算。
 *
 * 用法：node scripts/_tome_shim_test.mjs
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:8188'
// ⚠ 相对本文件解析，不写死用户目录（打包的隐私检查会拦下绝对路径）
const OUT = fileURLToPath(new URL('../_tome_probe', import.meta.url))
const CLIENT_ID = 'tome-shim-test'

const UNET = 'qwen_image_2.1_int8_convrot.safetensors'
const CLIP = 'qwen3vl_8b_w4a8.safetensors'
const VAE = 'qwen_image_2.1_vae_bf16.safetensors'
const TURBO_LORA = 'turbo8_lora_step2500.safetensors'

const W = 864
const H = 1152
const STEPS = 8
const CFG = 1.0

const REF_NAME = process.argv[2] ?? 'ref_pink.png'
const PROMPT = process.argv[3]
  ?? '一位粉色长发的少女站在樱花树下，侧身回望，白色连衣裙，春日午后柔光，背景虚化，细腻皮肤质感，高清插画'

// ---------------------------------------------------------------- HTTP 工具
async function j(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs ?? 300000) })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return r.json()
}

/** 清空 ComfyUI 的结果缓存，保证每次都是真算。 */
async function clearCache() {
  try { await fetch(`${BASE}/free`, { method: 'POST', body: JSON.stringify({ unload_models: false, free_memory: false }), headers: { 'Content-Type': 'application/json' } }) } catch {}
}

// ------------------------------------------------------- 图片解码 / 指标
/** 极简 PNG 解码：只处理 8bit RGB/RGBA，够判 PSNR 用。 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`)
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : (() => { throw new Error(`不支持 colorType ${colorType}`) })()
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride); rp += stride
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = (prev && x >= ch) ? prev[x - ch] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, ch, data: out }
}

function psnr(a, b) {
  let mse = 0, n = 0
  const len = Math.min(a.data.length, b.data.length)
  for (let i = 0; i < len; i += a.ch) {
    for (let k = 0; k < 3; k++) {
      const d = a.data[i + k] - b.data[i + k]
      mse += d * d; n++
    }
  }
  mse /= n
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

function mad(a, b) {
  let s = 0, n = 0
  const len = Math.min(a.data.length, b.data.length)
  for (let i = 0; i < len; i += a.ch) {
    for (let k = 0; k < 3; k++) { s += Math.abs(a.data[i + k] - b.data[i + k]); n++ }
  }
  return s / n
}

/** 拉普拉斯方差：越大越锐利。用来判"有没有变糊"。 */
function sharpness(img) {
  const { width: w, height: h, ch, data } = img
  let sum = 0, sum2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * ch
      const lap = 4 * data[i] - data[i - ch] - data[i + ch] - data[i - w * ch] - data[i + w * ch]
      sum += lap; sum2 += lap * lap; n++
    }
  }
  const mean = sum / n
  return sum2 / n - mean * mean
}

// ------------------------------------------------------------------ 工作流
/**
 * 与插件**等价**的图生图链路（参考图模式），可选插入 ToMe 节点。
 *   tomeNode: null → 不加；'shim' → QwenTomePatchModel；'builtin' → TomePatchModel
 */
function buildWorkflow({ tomeNode, ratio, seed, prompt, mergeMode = 'mean' }) {
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: CLIP, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    11: {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: TURBO_LORA, strength_model: 1.0 },
    },
    12: {
      class_type: 'ModelSamplingFlux',
      inputs: { model: ['11', 0], max_shift: 0.6935, base_shift: 0.5, width: W, height: H },
    },
    4: { class_type: 'LoadImage', inputs: { image: REF_NAME } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        prompt,
        negative_prompt: '',
        vae: ['3', 0],
        resolution: Math.round(Math.sqrt(W * H)),
        'images.image_1': ['4', 0],
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'tome_shim' } },
  }

  let modelRef = '12'
  if (tomeNode) {
    const cls = tomeNode === 'shim' ? 'QwenTomePatchModel' : 'TomePatchModel'
    // ⚠ `merge_mode` 是 QwenTomePatchModel 的**必填**输入。
    //   上一版这里没给，ComfyUI 直接以 `required_input_missing` 拒收 ——
    //   于是"兼容层"压根没被执行到，看起来却像"兼容层没修好"（典型的假失败）。
    //   内建 TomePatchModel 没有这个输入，所以只在 shim 分支加。
    const inputs = { model: [modelRef, 0], ratio }
    if (tomeNode === 'shim') inputs.merge_mode = mergeMode
    wf[20] = { class_type: cls, inputs }
    modelRef = '20'
  }
  wf[8] = {
    class_type: 'KSampler',
    inputs: {
      model: [modelRef, 0],
      seed,
      steps: STEPS,
      cfg: CFG,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['5', 0],
      negative: ['5', 1],
      latent_image: ['5', 2],
      denoise: 1.0,
    },
  }
  return wf
}

/** 提交并等结果，返回 { ms, images, error }。 */
async function runOnce(label, wf) {
  await clearCache()
  const t0 = Date.now()
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: CLIENT_ID }),
  })
  const body = await res.json()
  // ⚠ ComfyUI 成功时也会返回 `node_errors: {}` —— **空对象在 JS 里是 truthy**，
  //   上一版写成 `if (body.node_errors)` 于是把每次正常提交都误判成失败（实测踩到）。
  //   必须判「有键」而不是判「对象存在」。
  const hasNodeErrors = body.node_errors && Object.keys(body.node_errors).length > 0
  if (!res.ok || body.error || hasNodeErrors) {
    const detail = JSON.stringify(body.node_errors ?? body.error ?? body).slice(0, 900)
    return { ms: Date.now() - t0, images: [], error: detail }
  }
  const pid = body.prompt_id
  // 轮询历史
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const hist = await j(`${BASE}/history/${pid}`)
    const entry = hist?.[pid]
    if (!entry) continue
    const status = entry.status?.status_str
    if (status === 'error') {
      // ★ 运行时异常藏在 status.messages 里，形如：
      //   [["execution_error", {node_id, node_type, exception_message, exception_type, traceback}]]
      //   上一版只挑 "是字符串的元素" 去拼，结果把真正有用的 dict 全丢了、只剩 `{}`。
      const parts = []
      for (const m of entry.status?.messages ?? []) {
        if (!Array.isArray(m)) continue
        const [kind, payload] = m
        if (kind === 'execution_error' && payload && typeof payload === 'object') {
          parts.push(`${payload.exception_type}: ${payload.exception_message}`)
          if (payload.node_type) parts.push(`@节点 ${payload.node_type}(${payload.node_id})`)
          if (payload.traceback) parts.push(String(payload.traceback).split('\n').slice(-6).join('\n'))
        } else if (typeof payload === 'string') {
          parts.push(payload)
        } else if (payload && typeof payload === 'object') {
          parts.push(JSON.stringify(payload).slice(0, 400))
        }
      }
      return { ms: Date.now() - t0, images: [], error: (parts.join(' | ') || '执行出错').slice(0, 1200) }
    }
    const imgs = []
    for (const out of Object.values(entry.outputs ?? {})) {
      for (const im of out.images ?? []) imgs.push(im)
    }
    if (imgs.length) return { ms: Date.now() - t0, images: imgs, error: null }
  }
  return { ms: Date.now() - t0, images: [], error: '等待超时' }
}

async function fetchImage(im) {
  const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? '', type: im.type ?? 'output' })
  const r = await fetch(`${BASE}/view?${q}`)
  if (!r.ok) throw new Error(`取图失败 ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// -------------------------------------------------------------------- 主流程
;(async () => {
  await fsp.mkdir(OUT, { recursive: true })

  console.log('='.repeat(68))
  console.log('QwenToMe 兼容层 —— 真机验证')
  console.log(`  参考图=${REF_NAME}  尺寸=${W}x${H}  steps=${STEPS}  cfg=${CFG}`)
  console.log('='.repeat(68))

  // ---- 0. 对照组：内建 TomePatchModel 必须仍然失败（证明我们确实修了什么）----
  console.log('\n【0】对照组：ComfyUI 内建 TomePatchModel（预期：崩）')
  const builtin = await runOnce('builtin', buildWorkflow({
    tomeNode: 'builtin', ratio: 0.3, seed: 11111, prompt: PROMPT,
  }))
  if (builtin.error) {
    const pe = /pe/.test(builtin.error)
    console.log(`  ✓ 如期失败（${builtin.error.slice(0, 160)}）`)
    console.log(`  ${pe ? '✓ 错误里确实提到 pe —— 与上轮读源码的结论一致' : '⚠ 错误里没提到 pe，需要复核'}`)
  } else {
    console.log(`  ✗ 内建节点竟然成功了（${builtin.ms}ms）—— 与预期不符，需重新调查`)
  }

  // ---- 1. 基准：不加 ToMe ----
  console.log('\n【1】基准：图生图 + prompt，不加 ToMe')
  const base = await runOnce('base', buildWorkflow({ tomeNode: null, ratio: 0, seed: 22222, prompt: PROMPT }))
  if (base.error) { console.error('  基准失败:', base.error); process.exit(1) }
  const basePng = decodePng(await fetchImage(base.images[0]))
  await fsp.writeFile(path.join(OUT, 'shim_base.png'), await fetchImage(base.images[0]))
  console.log(`  耗时 ${(base.ms / 1000).toFixed(3)}s  尺寸 ${basePng.width}x${basePng.height}  清晰度 ${sharpness(basePng).toFixed(1)}`)

  // ---- 2. 兼容层：ratio 0（必须与基准几乎位级相同）----
  console.log('\n【2】兼容层 ratio=0（直通 —— 应当与基准几乎完全一致）')
  const r0 = await runOnce('shim0', buildWorkflow({ tomeNode: 'shim', ratio: 0, seed: 22222, prompt: PROMPT }))
  if (r0.error) {
    console.log(`  ✗ 失败（这就是兼容层没修好的证据）：${r0.error.slice(0, 300)}`)
  } else {
    const p0 = decodePng(await fetchImage(r0.images[0]))
    await fsp.writeFile(path.join(OUT, 'shim_r0.png'), await fetchImage(r0.images[0]))
    const ps = psnr(basePng, p0), md = mad(basePng, p0)
    console.log(`  耗时 ${(r0.ms / 1000).toFixed(3)}s  PSNR ${ps.toFixed(2)}dB  MAD ${md.toFixed(4)}`)
    console.log(`  ${md === 0 ? '✓ 位级完全一致 —— 直通无副作用，兼容层装载正确' : (ps > 60 ? '✓ 肉眼无差别（PSNR 很高）' : '⚠ 与基准有明显差异，直通不该如此')}`)
  }

  // ---- 3. 兼容层：多个 ratio（同 seed，只看画质代价）----
  console.log('\n【3】兼容层各 ratio 的画质代价（同 seed=22222，与基准比）')
  const ratios = [0.1, 0.2, 0.3, 0.5]
  const rows = []
  for (const ratio of ratios) {
    const r = await runOnce(`shim${ratio}`, buildWorkflow({ tomeNode: 'shim', ratio, seed: 22222, prompt: PROMPT }))
    if (r.error) {
      console.log(`  ratio=${ratio}  ✗ ${r.error.slice(0, 240)}`)
      rows.push({ ratio, ok: false, err: r.error })
      continue
    }
    const png = decodePng(await fetchImage(r.images[0]))
    await fsp.writeFile(path.join(OUT, `shim_r${ratio}.png`), await fetchImage(r.images[0]))
    const ps = psnr(basePng, png), md = mad(basePng, png)
    const sh = sharpness(png)
    console.log(`  ratio=${ratio}  ✓ ${(r.ms / 1000).toFixed(3)}s  PSNR ${ps.toFixed(2)}dB  MAD ${md.toFixed(3)}  清晰度 ${sh.toFixed(1)}`)
    rows.push({ ratio, ok: true, ms: r.ms, psnr: ps, mad: md, sharpness: sh })
  }

  // ---- 4. 诚实计时：同配置不同 seed 各跑两次 ----
  console.log('\n【4】计时复核（不同 seed，避开 ComfyUI 结果缓存）')
  const timeBase = [], timeTome = []
  for (let i = 0; i < 2; i++) {
    const s = 30000 + i * 777
    const b = await runOnce('t-base', buildWorkflow({ tomeNode: null, ratio: 0, seed: s, prompt: PROMPT }))
    if (!b.error) timeBase.push(b.ms)
    const t = await runOnce('t-tome', buildWorkflow({ tomeNode: 'shim', ratio: 0.3, seed: s, prompt: PROMPT }))
    if (!t.error) timeTome.push(t.ms)
    console.log(`  第${i + 1}轮  seed=${s}  基准 ${b.error ? '失败' : (b.ms / 1000).toFixed(3) + 's'}  ToMe0.3 ${t.error ? '失败' : (t.ms / 1000).toFixed(3) + 's'}`)
  }
  if (timeBase.length && timeTome.length) {
    const mb = timeBase.reduce((a, b) => a + b, 0) / timeBase.length
    const mt = timeTome.reduce((a, b) => a + b, 0) / timeTome.length
    const delta = (mb - mt) / mb * 100
    console.log(`  均值：基准 ${(mb / 1000).toFixed(3)}s  ToMe ${(mt / 1000).toFixed(3)}s`)
    console.log(`  ⇒ ${delta >= 0 ? '提速' : '反而更慢'} ${Math.abs(delta).toFixed(1)}%`)
    console.log(`  ${Math.abs(delta) < 5 ? '⚠ 差异在噪声范围内（<5%），不能算有效提速' : ''}`)
  }

  await fsp.writeFile(path.join(OUT, '_shim_summary.json'), JSON.stringify({
    at: new Date().toISOString(), ref: REF_NAME, w: W, h: H, steps: STEPS,
    builtinError: builtin.error, baseline: { ms: base.ms }, rows, timing: { base: timeBase, tome: timeTome },
  }, null, 2))
  console.log('\n结果已写入', OUT)
})().catch((e) => { console.error('脚本异常:', e); process.exit(1) })
