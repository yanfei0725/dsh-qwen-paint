/**
 * scripts/smoke.mjs —— C15 真机冒烟（可进 CI，也可以手动在目标机跑）。
 *
 * ★★ 设计前提：**离线必须也是绿的**。
 *   CI 里没有 ComfyUI、没有显卡、没有 ffmpeg。如果冒烟脚本在离线时返回非 0，
 *   那它每天都会红一次，很快就会被人加 `|| true` 糊掉 —— 那还不如没有。
 *   所以离线一律 `SKIP` + 退出码 0，并明确打出"跳过了什么"。
 *
 * ★★ 冒烟**默认不生成任何图片/视频/音频**（项目硬规矩）。
 *   只做只读探测：`/system_stats`、`/object_info` 计数、关键节点是否在。
 *   想真的提交一次最小任务，必须显式加 `--submit` —— 且那属于"验收"，不是 CI 的活。
 *
 * 用法：
 *   node scripts/smoke.mjs                # 自动探测，离线则 SKIP
 *   node scripts/smoke.mjs --url=http://127.0.0.1:8188
 *   node scripts/smoke.mjs --submit       # ⚠ 会真的提交一张 512 图（仅人工验收用）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const hasFlag = (name) => argv.includes(`--${name}`)

const BASE = String(argOf('url', process.env.COMFY_URL ?? 'http://127.0.0.1:8188')).replace(/\/+$/u, '')
const SUBMIT = hasFlag('submit')
const TIMEOUT_MS = 8000

/** 必须存在的节点：缺任何一个，本插件的核心链路都跑不了。 */
const CORE_NODES = ['KSampler', 'CLIPTextEncode', 'VAELoader', 'UNETLoader', 'VAEDecode']

let pass = 0
let skipped = 0
const failures = []

function ok(name, extra) { pass += 1; console.log('  OK   ', name) }
function bad(name, extra) { failures.push(name); console.log('  FAIL ', name, extra ?? '') }
function skip(name, why) { skipped += 1; console.log('  SKIP ', name, why ? `— ${why}` : '') }

async function getJson(p) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}${p}`, { signal: ctl.signal, cache: 'no-store' })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, json: await r.json() }
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '超时' : (e?.message ?? String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log(`\nsmoke: 目标 ${BASE}${SUBMIT ? '（含提交，会真的出图）' : '（只读）'}`)

  const stats = await getJson('/system_stats')
  if (!stats.ok) {
    skip('ComfyUI 在线', `连不上（${stats.error ?? `HTTP ${stats.status}`}）`)
    skip('节点清单可读')
    skip('核心节点齐备')
    skip('队列可读')
    console.log(`\nsmoke: 离线 SKIP ${skipped} 项（这是预期行为，不是失败）`)
    return
  }
  ok('ComfyUI 在线')
  const sys = stats.json?.system ?? {}
  console.log(`        版本 ${sys.comfyui_version ?? '(未报)'}，`
    + `python ${sys.python_version ?? '(未报)'}，设备 ${(stats.json?.devices ?? []).length} 个`)

  const info = await getJson('/object_info')
  if (!info.ok) {
    bad('节点清单可读', info.error ?? `HTTP ${info.status}`)
  } else {
    const names = Object.keys(info.json ?? {})
    ok(`节点清单可读（${names.length} 个节点）`)
    const missing = CORE_NODES.filter((n) => !names.includes(n))
    if (missing.length === 0) ok(`核心节点齐备（${CORE_NODES.length} 个）`)
    else bad('核心节点齐备', `缺 ${missing.join('、')}——这个 ComfyUI 装得不完整`)
  }

  const queue = await getJson('/queue')
  if (!queue.ok) bad('队列可读', queue.error ?? `HTTP ${queue.status}`)
  else {
    const running = Array.isArray(queue.json?.queue_running) ? queue.json.queue_running.length : 0
    const pending = Array.isArray(queue.json?.queue_pending) ? queue.json.queue_pending.length : 0
    ok(`队列可读（运行 ${running} / 排队 ${pending}）`)
  }

  if (!SUBMIT) {
    skip('提交最小任务', '未加 --submit（默认不出图）')
  } else {
    // 提交是最小化的：512×512 / 8 步 / 固定 seed。仍然需要模型齐全，缺就如实报。
    const prompt = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: argOf('unet', 'Qwen-Image-2.1-UC-Q4_K_M.gguf'), weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: argOf('clip', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'), type: 'qwen_image' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: argOf('vae', 'qwen_image_vae.safetensors') } },
      '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'smoke test' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
      '6': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      '7': {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
          seed: 1, steps: 8, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
        },
      },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'qwen-paint/smoke' } },
    }
    try {
      const r = await fetch(`${BASE}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(TIMEOUT_MS * 3),
      })
      const j = await r.json().catch(() => null)
      if (r.ok && j?.prompt_id) ok(`已提交最小任务（prompt_id ${j.prompt_id}）`)
      else bad('提交最小任务', JSON.stringify(j?.error ?? j ?? `HTTP ${r.status}`).slice(0, 200))
    } catch (e) {
      bad('提交最小任务', e?.message ?? String(e))
    }
  }

  console.log(`\nsmoke: ${pass} 项通过${skipped ? `，${skipped} 项跳过` : ''}`
    + `${failures.length ? `，${failures.length} 项失败` : ''}`)
  for (const f of failures) console.log('  ✗', f)
}

main().then(() => {
  if (failures.length) process.exitCode = 1
}).catch((e) => {
  console.error('smoke 脚本自身出错：', e?.message ?? e)
  process.exitCode = 2
})
