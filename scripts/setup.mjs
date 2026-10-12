/**
 * dsh-qwen-paint — 一键部署（ComfyUI + 千问 Qwen-Image 2.1 模型）
 * ============================================================================
 * 干三件事，缺什么补什么（已就绪的一律跳过，可重复执行）：
 *   ① 找到 / 装好 ComfyUI
 *   ② 把三个千问模型下到正确目录，并做 **SHA256 校验**
 *   ③ 调 install.mjs 把插件挂进 DSH profile
 *
 * ★★ 下载渠道（按主人的铁律一：只走有正规资质的渠道）
 *   模型 = **ModelScope 官方直连**（modelscope.cn，阿里官方平台）。
 *   上传者是 **Comfy Org 官方组织自己的仓库** `Comfy-Org/Qwen-Image-2.1`
 *   （Organization.GithubAddress = https://comfy.org/），不是第三方转存。
 *   期望哈希取自该仓库文件列表 API 的 `sha256` 字段 —— 这正是规则里写明的合法来源。
 *   ComfyUI 本体 = GitHub 官方 release（comfyanonymous/ComfyUI）。
 *   ⚠ ComfyUI 官方 release **不公布哈希**，所以本脚本**默认不去自动下它**，
 *     只在你显式加 `--download-comfy` 时才下，并且会再问一次（铁律三：来源可查 + 知情同意）。
 *
 * 用法：
 *   node scripts/setup.mjs                 检测 + 补齐（缺模型就下模型）
 *   node scripts/setup.mjs --check         只检测，绝不下载（先看看差什么）
 *   node scripts/setup.mjs --verify        已存在的模型也重算一遍 SHA256（慢，但最稳）
 *   node scripts/setup.mjs --comfy D:\ComfyUI   指定 ComfyUI 目录
 *   node scripts/setup.mjs --download-comfy     顺带下载 ComfyUI 官方便携包
 *   node scripts/setup.mjs --tier full|lite     直接指定主模型档位（★ 2026-10-11）
 *       · 不指定时：**交互式终端会弹一句问你**（显存多选 1，显存少选 2）；
 *         非交互环境则默认 full（与之前完全一致）。
 *       · full = int8 主模型（画质最好）；lite = GGUF Q4_K_M（约 4.2 GB，给 8GB 小卡）。
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const CHECK_ONLY = has('--check')
/** --check 只比大小（秒回）；--verify 才真的重算 SHA256（13 GB 要等一会儿）。 */
const FORCE_VERIFY = has('--verify')
const WANT_COMFY = has('--download-comfy')
/**
 * ★ 2026-10-11：**平台标志** —— macOS 走的是完全不同的一条路
 *   （ComfyUI 官方对 Apple Silicon 只提供"手动安装"，没有便携包，也没有 Mac 专属启动参数）。
 *   ⚠ 不能沿用 Linux 那条：`systemctl` / `lspci` / `rocm-smi` 在 macOS 上都没有。
 */
const IS_MAC = process.platform === 'darwin'

/* ------------------------------------------------ 模型清单（官方值，别手改） ---- */

/**
 * ⚠ 这些 `size` 与 `sha256` 全部**从 ModelScope 官方文件列表 API 抄下来的**，必须成对使用。
 *   要更新版本时，重新取一次 API：
 *     https://www.modelscope.cn/api/v1/models/<owner>/<repo>/repo/files?Revision=master&Root=
 *   主模型 + CLIP/VAE 全部来自 `Comfy-Org/Qwen-Image-2.1`。
 *
 * ⚠⚠ 2026-10-12：**曾经有过"轻量档（GGUF Q4_K_M）"，已整个撤掉。**
 *   原因：自动下的 `unsloth/Qwen-Image-2.1-GGUF` 的 `qwen-image-2.1-Q4_K_M.gguf`
 *   是 **stable-diffusion.cpp 格式**的 GGUF（元数据无 `general.architecture`、
 *   张量名 `model.diffusion_model.*`），ComfyUI-GGUF 的 `UnetLoaderGGUF` 加载不了。
 *   三条证据：仓库页只写 sd.cpp、ComfyUI-GGUF 官方只发布 FLUX 的 GGUF、
 *   且用户真下了 4.2GB 那个文件验过 GGUF 头。
 *   ⇒ 插件**不再自动下载/推荐任何 GGUF**。
 *   若你**自己**有 ComfyUI 能用的 GGUF，把 `cordis.patch.yml` 的 `unet`
 *   指到那个 `.gguf` 文件名即可（插件会自动改用 `UnetLoaderGGUF`）。
 */
const UNET_FULL = {
  dir: 'diffusion_models',
  name: 'qwen_image_2.1_int8_convrot.safetensors',
  size: 7256783064,
  sha256: 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d',
  note: 'UNet（出图主模型 · int8）',
}
/**
 * GGUF 档主模型（小显存档，★ 2026-10-12 用户要求保留轻量档并接上可用文件）。
 *
 * ## 为什么是 abenzerps 而不是 unsloth
 *   原先引的 `unsloth/Qwen-Image-2.1-GGUF` 是 **stable-diffusion.cpp 格式**的 GGUF
 *   （Range 请求下前 8KB 实测：`metadata_kv_count=0` 元数据为空、张量名
 *   `model.diffusion_model.*`）⇒ ComfyUI-GGUF 的 UnetLoaderGGUF 加载不了。
 *
 * ## 这个仓库凭什么可用
 *   `gatuwo/Qwen-Image-2.1-GGUF-Multi-Queue-Workflows` 在 **RTX 4060 Laptop 8GB**
 *   上实测跑通 ComfyUI 工作流（用的就是 `UnetLoaderGGUF` 节点 + 本文件）。
 *
 * ## ⚠ 两个必须如实说明的点
 *   ① 仓库名带 **Uncensored（无审查）** —— 经核实在 ComfyUI-GGUF 下能用的
 *      Qwen-Image GGUF 目前只有这一类；介意的话请在装完后自行替换 models/unet 里的文件。
 *   ② 该文件的 `general.architecture = 'qwen_image21'`，而 ComfyUI-GGUF 的
 *      `IMG_ARCH_LIST` 里是 `qwen_image`（严格匹配）—— 二者**理论上不匹配**，
 *      与"实测跑通"矛盾，**尚未定论**。所以插件**不预置它**，只在用户显式选轻量档时才下。
 *
 * 权威校验值（HF API 的 lfs.oid，与服务器 Content-Length 一致，**不是估算**）：
 *   size = 4604558112；sha256 = e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41
 */
const UNET_LITE = {
  dir: 'unet',
  name: 'qwen-image-2.1-UC-Q4_K_M.gguf',
  size: 4604558112,
  sha256: 'e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41',
  note: 'UNet（出图主模型 · GGUF Q4_K_M，小显存档 · abenzerps Uncensored 系）',
}
const CLIP_MODEL = {
  dir: 'text_encoders',
  name: 'qwen3vl_8b_w4a8.safetensors',
  size: 6312105364,
  sha256: '7754425e55e7bea2bfde4dde59a4cc236cb44e5ee9c215ea66ef8d47012824eb',
  note: 'CLIP / 文本编码器（type=qwen_image）',
}
const VAE_MODEL = {
  dir: 'vae',
  name: 'qwen_image_2.1_vae_bf16.safetensors',
  size: 675509688,
  sha256: 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9',
  note: 'VAE',
}

/**
 * ★ 用户要求**保留轻量档**。两个档位，`full` 是默认（与之前完全一致）。
 *
 * ⚠⚠ 2026-10-12：**lite 档不再自动下载主模型** —— 原先引的
 * `unsloth/Qwen-Image-2.1-GGUF` 是 **stable-diffusion.cpp 格式**的 GGUF，
 * ComfyUI-GGUF 的 `UnetLoaderGGUF` 加载不了（详见文件顶部说明）。
 * 而上游目前**没有**发布 ComfyUI 可直接吃的 Qwen-Image GGUF。
 *
 * ⇒ 所以 lite 档改成**自备 GGUF**：装完 CLIP/VAE 后，把可用的 `.gguf`
 *   放进 `models/unet`，插件会自动挑最优的那个来用。
 */
const TIERS = {
  full: {
    id: 'full',
    label: '完整档（int8 主模型，画质最好）',
    unet: UNET_FULL,
    hint: '显存 ≥ 8 GB 选它 —— 这就是之前一直在用的那个模型。',
  },
  lite: {
    id: 'lite',
    label: '轻量档（GGUF Q4_K_M，约 4.3 GB）',
    unet: UNET_LITE,
    hint: '小显存（8 GB 及以下，如 RTX 5060）选它；需另装 ComfyUI-GGUF 节点（见装完提示）。',
  },
}
const DEFAULT_TIER = 'full'
/** 某一档要下的文件（lite 档不下主模型，只下 CLIP/VAE）。 */
const modelsFor = (tier) => {
  const t = TIERS[tier] ?? TIERS[DEFAULT_TIER]
  return t.unet === null ? [CLIP_MODEL, VAE_MODEL] : [t.unet, CLIP_MODEL, VAE_MODEL]
}

const REPO = 'Comfy-Org/Qwen-Image-2.1'
/** ModelScope 官方下载前缀（resolve/<revision>/<仓库内路径>）。 */
const REPO_BASE = `https://modelscope.cn/models/${REPO}/resolve/master/`
const REPO_PAGE = `https://modelscope.cn/models/${REPO}`
/**
 * GGUF 档的仓库与下载源。
 * ⚠ **不用 ModelScope** —— 实测 `abenzerps/*` 仓库在 ModelScope 上 resolve 该文件返回 404；
 *    用 hf-mirror.com（HF 国内镜像）实测 200，且支持 Range/断点续传。
 */
const GGUF_REPO = 'abenzerps/Qwen-Image-2.1-Uncensored-GGUF'
const GGUF_REPO_BASE = `https://hf-mirror.com/${GGUF_REPO}/resolve/main/`
const GGUF_REPO_PAGE = `https://huggingface.co/${GGUF_REPO}`
/** 某个模型该从哪个仓库/源下 —— GGUF 走 GGUF 源，其余走 ModelScope。 */
const repoBaseOf = (model) => (/\.gguf$/iu.test(model.name) ? GGUF_REPO_BASE : REPO_BASE)

const COMFY_RELEASE = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z'
const COMFY_REPO = 'https://github.com/comfyanonymous/ComfyUI'

/* ------------------------------------------------------------------ 小工具 ---- */

const gb = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

/**
 * 把一个 `key: 'value'` 写进 cordis.patch.yml 的 `config:` 段（幂等）。
 *
 * ⚠ 只动**插件自己那一块**（定位 6 空格缩进的 `config:` 行），绝不重排整个 YAML；
 *    结构对不上就返回 false，**绝不硬改** —— 宁可让用户手动设一行，也不能把配置写坏。
 */
function writeConfigKey(file, key, value) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const line = `        ${key}: '${value}'`
    const existing = new RegExp('^ {8}' + key + ': .*$', 'mu')
    if (existing.test(text)) {
      fs.writeFileSync(file, text.replace(existing, line), 'utf8')
      return true
    }
    const anchor = /^( {6}config:[ \t]*)$/mu
    if (!anchor.test(text)) return false
    fs.writeFileSync(file, text.replace(anchor, '$1\n' + line), 'utf8')
    return true
  } catch {
    return false
  }
}

function which(exe) {
  const res = spawnSync('where.exe', [exe], { encoding: 'utf8' })
  return res.status === 0 ? String(res.stdout).split(/\r?\n/u)[0].trim() : null
}

/* ══════════════════════════════ 显卡检测（0.1.1 新增）══════════════════════════
 *
 * 为什么必须分两条路：
 *   · ComfyUI 的 Windows 便携包是 **CUDA 版**，A 卡用户装上根本跑不起来 ✗
 *   · A 卡在 Windows 上要走 **ROCm**（AMD 官方 ROCm 7.2.1 起原生支持 Windows，不用 WSL）✓
 *   · 两条路**模型完全一样**（都用 Comfy-Org 官方那套 int8，哈希也一模一样）✓
 *     —— 这点很关键：换显卡不用换模型，插件本身也不用改 ✓
 *
 * ⚠⚠ 诚实声明：**A 卡那条路本脚本作者无法实测**（开发机是 N 卡，也不会在主人机器上装）。
 *    所以 A 卡的命令**全部照 AMD 官方博客来**，一个字没自己编：
 *    https://rocm.blogs.amd.com/artificial-intelligence/comfyui-windows/README.html
 *    下载源只用 **AMD 官方软件仓库 repo.radeon.com**（不是任何第三方加速站）✓
 */

/** AMD 官方 Windows ROCm wheels（AMD 官方 CDN）。 */
const ROCM_WHEELS = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/'
const ROCM_TORCH = '2.9.1+rocm7.2.1'
const ROCM_TORCHVISION = '0.24.1+rocm7.2.1'
const ROCM_TORCHAUDIO = '2.9.1+rocm7.2.1'

/** `--force-amd`：本机是 N 卡，靠它把 A 卡分支整条走一遍做验证。 */
/** `--amd` / `--nvidia`：显卡认不出来时由用户指定走哪条路（也用于本机测试）。 */
const FORCE_AMD = has('--amd') || has('--force-amd')
const FORCE_NVIDIA = has('--nvidia')
/** `--yes`：跳过"A 卡这套操作比较重"的二次确认（给别人做一键安装时用）。 */
const ASSUME_YES = has('--yes')

/**
 * 显卡型号 → ROCm 的 gfx 代号。
 *
 * ⚠⚠ 本表**照 AMD 官方的 Windows 支持列表逐条核对过**，第 3 列就是官方的态度：
 *   https://rocm.docs.amd.com/projects/install-on-windows/en/latest/reference/system-requirements.html
 *
 *   · 'ok' = 官方明确支持（Runtime ✅ / HIP SDK ✅）
 *   · 'no' = 官方**明确不支持**（❌）→ 列出来是为了**拦住用户**，不是引导他安装
 *
 * ⚠ 之前的版本是照某个网友项目的 README 抄的，里面把 RX 6000 全系、RX 5500 这些
 *   **官方明确不支持**的老卡也列成了可用 —— 照着装只会白下 3 GB 然后跑不起来 ✗
 *   （教训：**数据也得核官方**，不能因为"看着像客观事实"就照抄二手来源。）
 *
 * ⚠ 只用于**猜**：猜不出就让用户照上面的官方列表自己挑 —— 猜错比猜不出更糟。
 */
const GFX_TABLE = [
  // ── 官方支持 ──
  [/RX\s*9070|AI\s*PRO\s*R9700|R9600D/iu, 'gfx1201', 'ok'],
  [/RX\s*9060/iu, 'gfx1200', 'ok'],
  [/Ryzen\s*AI\s*Max/iu, 'gfx1151', 'ok'], // ← 之前漏了这张，而 AMD 官方博客实测用的正是它
  [/Ryzen\s*AI\s*(9\s*)?[34]00/iu, 'gfx1150', 'ok'],
  [/RX\s*79[05]0|PRO\s*W79[05]0|W7800/iu, 'gfx1100', 'ok'],
  [/RX\s*78[05]0|RX\s*77[05]0|PRO\s*V710|W7700/iu, 'gfx1101', 'ok'],
  [/RX\s*76[05]0/iu, 'gfx1102', 'ok'],
  // ── 官方明确不支持（老卡）──
  [/RX\s*69[05]0|RX\s*68[05]0|PRO\s*W6800|V620/iu, 'gfx1030', 'no'],
  [/RX\s*67[05]0/iu, 'gfx1031', 'no'],
  [/RX\s*66[05]0|PRO\s*W6600/iu, 'gfx1032', 'no'],
  [/RX\s*5500|PRO\s*W5500/iu, 'gfx1012', 'no'],
]

/** 从显卡名判定厂商。 */
function classifyVendor(joined) {
  // ★ 2026-10-11：Apple Silicon（MPS）。型号形如 "Apple M1/M2/M3/M4 [Pro|Max|Ultra]"。
  if (/apple\s+m\d|\bM\d\s*(Pro|Max|Ultra)\b|Apple.*GPU/iu.test(joined)) return 'apple'
  if (/NVIDIA|GeForce|RTX\s*\d|GTX\s*\d|Quadro/iu.test(joined)) return 'nvidia'
  if (/AMD|Radeon|RX\s*\d|Vega/iu.test(joined)) return 'amd'
  if (/Intel/iu.test(joined)) return 'intel'
  return 'unknown'
}

/**
 * ★★★ 2026-10-11 新增：**macOS 的显卡探测**。
 *
 * ⚠ macOS **没有** WMI / 注册表 / dxdiag —— 下面 detectGpu 里那六条 Windows 路径
 *   在 Mac 上**一条都用不了**（这正是之前 macOS 上"查不到显卡"的原因）。
 *   这里用两条 macOS 原生命令：
 *     · `system_profiler SPDisplaysDataType` → 输出里的 `Chipset Model: Apple M3 Pro`
 *     · `sysctl -n machdep.cpu.brand_string` → Apple Silicon 上直接给出 `Apple M3 Pro`
 *     两条互为兜底（system_profiler 偶发很慢 / 被限制时还有 sysctl）。
 */
function gpuNamesFromMac() {
  const names = []
  const sp = spawnSync('system_profiler', ['SPDisplaysDataType'], { encoding: 'utf8' })
  if (sp.status === 0 && sp.stdout) {
    for (const line of String(sp.stdout).split(/\r?\n/u)) {
      const m = line.match(/^\s*Chipset Model:\s*(.+)$/iu)
      if (m) names.push(m[1].trim())
    }
  }
  const cpu = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' })
  if (cpu.status === 0 && cpu.stdout) {
    const t = String(cpu.stdout).trim()
    if (t !== '') names.push(t)
  }
  return [...new Set(names)]
}

/**
 * 查本机显卡。
 *
 * ★★ 2026-10-08 修（朋友那台 A 卡机器实测暴露出来的）：
 *   原来**只有一条**查询路径（`powershell.exe` + `Get-CimInstance`），而且
 *   **失败时被静默吞掉**（我没检查 `res.error`）—— 拉不起 PowerShell、或者那台机器
 *   WMI/CIM 有问题，都会变成轻飘飘一句"查不到显卡信息"，**原因一个字都不说** ✗。
 *
 *   后果很严重：A 卡机器被判成 unknown → 兜底走了 NVIDIA 路线 →
 *   用户被送去下 CUDA 便携包，**装完根本跑不起来** ✗✗
 *   （这正是主人一开始就要避免的情况：「用户只能安装适合自己的后端」。）
 *
 *   ✓ 现在：**四条路依次试**，每条失败的**具体原因**都记下来带回给用户看。
 *
 * @returns {{names: string[], vendor: 'nvidia'|'amd'|'intel'|'unknown',
 *            via: string|null, errors: string[]}}
 */
/* ---------- 显卡名的几条来源（含两条「完全不碰 WMI」的） ---------- */

/** 显示适配器的注册表类键（微软固定 GUID）。 */
const DISPLAY_CLASS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

/**
 * 来源 A：读注册表（**完全不经过 WMI**）。
 *
 * ⚠ 为什么必须有这条（朋友那台 A 卡机器实测）：
 *   `Get-CimInstance` 报 HRESULT `0x80041003`（= WBEM_E_ACCESS_DENIED），
 *   连 `wmic` 都是 Access denied。而 **CIM / WMI / wmic / PowerShell7 全属 WMI 家族** ——
 *   四条兜底一起阵亡 ✗ 于是又是 unknown，又走回 NVIDIA 那条错路。
 *   注册表这条路不碰 WMI，能绕过那类封锁 ✓（`reg.exe` 是系统自带）
 */
function gpuNamesFromRegistry() {
  const res = spawnSync('reg.exe', ['query', DISPLAY_CLASS_KEY, '/s', '/v', 'DriverDesc'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (res.error) throw new Error(res.error.code ?? res.error.message)
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const names = []
  for (const line of text.split(/\r?\n/u)) {
    const m = /DriverDesc\s+REG_SZ\s+(.+)$/iu.exec(line.trim())
    if (m && m[1].trim() !== '') names.push(m[1].trim())
  }
  if (names.length > 0) return names
  if (res.status !== 0) {
    const first = String(text).trim().split(/\r?\n/u)[0] ?? ''
    throw new Error(`reg 退出码 ${res.status}${first === '' ? '' : ` —— ${first.slice(0, 120)}`}`)
  }
  throw new Error('注册表里没找到 DriverDesc')
}

/**
 * 来源 B：dxdiag 输出到文件再解析（**既不碰 WMI、也不碰注册表**，最后的保险）。
 * ⚠ 慢（几秒到十几秒），所以永远排在最后。
 * ⚠ `dxdiag /t` 写出的是 **UTF-16LE**，必须按 utf16le 读，否则全是乱码。
 */
function gpuNamesFromDxdiag() {
  const out = path.join(os.tmpdir(), `dshqp-dxdiag-${process.pid}.txt`)
  try {
    const res = spawnSync('dxdiag.exe', ['/t', out], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    if (res.error) throw new Error(res.error.code ?? res.error.message)
    if (!fs.existsSync(out)) throw new Error('dxdiag 没写出文件（可能被拦，或系统里没有）')
    const text = fs.readFileSync(out, 'utf16le')
    const names = []
    for (const line of text.split(/\r?\n/u)) {
      // 中英文系统的字段名不一样，都收
      const m = /^\s*(?:Card name|显示卡名称|显示适配器名称)\s*[:：]\s*(.+)$/iu.exec(line)
      if (m && m[1].trim() !== '') names.push(m[1].trim())
    }
    if (names.length === 0) throw new Error('dxdiag 输出里没找到显卡名')
    return names
  } finally {
    try { fs.unlinkSync(out) } catch { /* 删不掉也不碍事，它在 temp 里 */ }
  }
}

/** WMI 家族：跑一条 PowerShell / wmic 查询，拿显卡名。 */
function wmiNames(exe, argv) {
  const res = spawnSync(exe, argv, { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (res.error) throw new Error(res.error.code ?? res.error.message)
  if (res.status !== 0) {
    const msg = String(res.stderr ?? '').trim().split(/\r?\n/u)[0] ?? ''
    throw new Error(`退出码 ${res.status}${msg === '' ? '' : ` —— ${msg.slice(0, 140)}`}`)
  }
  return String(res.stdout ?? '')
    .split(/\r?\n/u).map((s) => s.trim())
    .filter((s) => s !== '' && !/^name$/iu.test(s)) // wmic 会带一行表头
}

function detectGpu() {
  const PS = (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd]
  // ★ 2026-10-11：**macOS 只走它自己那一条** —— 下面六条全是 Windows 专有
  //   （注册表 / CIM / WMI / wmic / dxdiag），在 macOS 上一条都跑不了。
  const providers = IS_MAC ? [['macOS system_profiler / sysctl', gpuNamesFromMac]] : [
    // ★ 先试不碰 WMI 的那条 —— 在 WMI 被锁的机器上只有它能活
    ['注册表（不经过 WMI）', gpuNamesFromRegistry],
    ['PowerShell + CIM', () => wmiNames('powershell.exe',
      PS('Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'))],
    ['PowerShell + WMI（老式）', () => wmiNames('powershell.exe',
      PS('Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name'))],
    ['PowerShell 7', () => wmiNames('pwsh.exe',
      PS('Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'))],
    ['wmic（已废弃，但很多机器还有）', () => wmiNames('wmic.exe',
      ['path', 'win32_VideoController', 'get', 'name'])],
    // ★ 最后的保险：连注册表都被拦时，dxdiag 是独立通道
    ['dxdiag（不经过 WMI，也绕开注册表）', gpuNamesFromDxdiag],
  ]
  const errors = []
  for (const [label, fn] of providers) {
    try {
      const names = fn()
      if (names.length > 0) {
        return { names, vendor: classifyVendor(names.join(' | ')), via: label, errors }
      }
      errors.push(`${label}：跑通了，但一个显卡名都没返回`)
    } catch (error) {
      errors.push(`${label}：${error?.message ?? error}`)
    }
  }
  return { names: [], vendor: 'unknown', via: null, errors }
}

/**
 * 从显卡名猜 gfx 代号。
 * @returns {{code: string, support: 'ok'|'no'}|null} 猜不出返回 null
 */
function gfxOf(names) {
  for (const name of names) {
    for (const [re, code, support] of GFX_TABLE) {
      if (re.test(name)) return { code, support }
    }
  }
  return null
}


/** 流式算 SHA256（大文件不能一次读进内存）。 */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 目录像不像一个 ComfyUI 安装（便携版或源码版都认）。 */
function looksLikeComfy(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  return (
    fs.existsSync(path.join(dir, 'ComfyUI', 'main.py')) ||
    fs.existsSync(path.join(dir, 'main.py'))
  )
}

/** 模型实际该放的位置（兼容便携版 models\ 与 extra_model_paths 的写法）。 */
function modelsRootOf(comfyDir) {
  const inner = path.join(comfyDir, 'ComfyUI', 'models')
  return fs.existsSync(inner) ? inner : path.join(comfyDir, 'models')
}

/* ------------------------------------------------------------ 找 ComfyUI ---- */

function findComfyDir() {
  const explicit = valueOf('--comfy') ?? process.env.DSHQP_COMFY_DIR
  const candidates = [
    explicit,
    process.env.COMFYUI_DIR,
    'D:\\ComfyUI',
    'C:\\ComfyUI',
    path.join(os.homedir(), 'ComfyUI'),
    path.join(os.homedir(), 'Documents', 'ComfyUI'),
    // ★ 2026-10-11 修：原来写的是 `process.env.USERPROFILE ?? ''` ——
    //   macOS / Linux 上 USERPROFILE **不存在** ⇒ 拼出的是**相对路径** `Desktop/ComfyUI`
    //   （相对当前工作目录，几乎必然落空，属于"看着像候选、其实永远不会命中"）。
    //   改用 `os.homedir()`：Windows 上它 == USERPROFILE（行为不变），
    //   而 macOS / Linux 上会变成**真实候选** `~/Desktop/ComfyUI`。
    path.join(os.homedir(), 'Desktop', 'ComfyUI'),
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const dir of candidates) {
    if (looksLikeComfy(dir)) return { dir: path.resolve(dir), from: dir === explicit ? '参数指定' : '自动找到' }
  }
  return { dir: null, from: null }
}

/* -------------------------------------------------------------- 下载模型 ---- */

/**
 * 用 curl 下载（Windows 10+ 自带）：`-L` 跟随重定向、`-C -` 断点续传、
 * `--retry` 自动重试。进度不由 curl 打印，而是**每 3 秒读一次文件大小**报一行 ——
 * 这样日志干净，也符合"长任务每 3 秒报一次进度"的规矩。
 */
function downloadWithCurl(url, dest) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const partial = `${dest}.part`
    const child = spawn('curl.exe', [
      '-L', '--fail', '--retry', '5', '--retry-delay', '3',
      '-C', '-', '-o', partial, '--no-progress-meter', url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let lastBytes = 0
    let lastTick = 0
    const started = Date.now()
    const timer = setInterval(() => {
      const bytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0
      const now = Date.now()
      const speed = now - lastTick > 0 ? (bytes - lastBytes) / ((now - lastTick) / 1000) : 0
      lastBytes = bytes
      lastTick = now
      const elapsed = Math.round((now - started) / 1000)
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')
      console.log(`    [${mm}:${ss}] ${mb(bytes)}  速度 ${speed > 0 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : '—'}`)
    }, 3000)

    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })

    child.on('close', (code) => {
      clearInterval(timer)
      if (code === 0 && fs.existsSync(partial)) {
        // 落定：改名成正式文件（校验不过时会再删掉）
        fs.rmSync(dest, { force: true })
        fs.renameSync(partial, dest)
        resolve({ ok: true })
        return
      }
      // ⚠ curl -C - 对**已经完整**的文件会返回非零（rc=33）—— 这时 .part 其实已经是完整文件，
      //   交给后面的"大小 + 哈希"去判断，不在这里武断失败。
      resolve({ ok: false, code, stderr: stderr.trim(), kept: fs.existsSync(partial) })
    })
  })
}

/* ══════════════════════════════ A 卡（AMD）那条路 ══════════════════════════════ */

/** 跑一条命令、把输出直接透传给用户；失败返回 false。 */
function run(label, exe, argv, cwd) {
  console.log(`\n    $ ${label}`)
  const res = spawnSync(exe, argv, { stdio: 'inherit', cwd, shell: false })
  if (res.status !== 0) {
    console.error(`    ✗ 失败（退出码 ${res.status}）—— 修好再重跑本脚本即可，前面的步骤会跳过`)
    return false
  }
  console.log('    ✓ 完成')
  return true
}

/**
 * A 卡一键部署。**每一条命令都来自 AMD 官方博客**
 * （https://rocm.blogs.amd.com/artificial-intelligence/comfyui-windows/README.html），
 * 下载源只有 AMD 官方仓库 `repo.radeon.com` + ComfyUI 官方 GitHub + Comfy-Org 官方模型。
 *
 * ⚠ 这套操作很重：ROCm 版 PyTorch 约 3 GB、模型 13 GB；而且是装在**别人的机器**上，
 *   所以默认要确认一次，`--check` 则只打印计划、绝不执行。
 *
 * @returns {Promise<{dir: string}|null>} 装好的 ComfyUI 目录；用户放弃返回 null
 */
async function amdSetup(targetRoot, gfx, checkOnly) {
  console.log('\n① A 卡（AMD Radeon）路线 …')

  // ── 先说三条硬风险（比步骤重要，放最前面）──
  console.log('  ⚠⚠ 动手前必须先知道这三条：')
  console.log('     1. **可能静默出错** —— 在 gfx1100 这类卡上，它跑得飞快、日志也不报错，')
  console.log('        出来的却可能是噪点 / 全黑 / 颜色错。装完**一定要人工看图**，')
  console.log('        不能只看"跑完了"。这是 A 卡最坑的地方，没有之一。')
  console.log('     2. **别升到 ROCm 10.0 那套 wheels** —— 它报 HIP 7.15，实测会破坏权重；')
  console.log(`        本脚本锁死在 ${ROCM_TORCH}（HIP 7.2）。`)
  console.log('     3. 模型是 **Qwen Research License**：仅限研究 / 评估，**禁止商用**。')

  // ★★ 官方明确不支持的卡：**当场拦住** —— 别让用户白下 3 GB 才发现跑不起来
  if (gfx !== null && gfx.support === 'no') {
    console.log(`\n  ✗ 停手：你这张卡（${gfx.code}）**AMD 官方明确不支持** Windows 上的 ROCm。`)
    console.log('    AMD 官方列表里它标的是 ❌（Runtime ❌、HIP SDK ❌），硬装大概率跑不起来。')
    console.log('    可选的路：')
    console.log('      · 换一张官方支持的卡（RX 7000 / 9000 系，或 Ryzen AI Max 系列）')
    return null
  }

  // ── Python 3.12（AMD 的 Windows wheels 只有 cp312，3.13 装不上）──
  const py = spawnSync('py', ['-3.12', '--version'], { encoding: 'utf8' })
  const pyOk = py.status === 0
  const pyText = String(py.stdout ?? py.stderr ?? '').trim()

  console.log('\n  ── 计划 ──')
  console.log(`    Python 3.12：${pyOk ? `✓ ${pyText}` : '✗ 没找到（AMD 的 wheels 只支持 3.12，3.13 装不上）'}`)
  if (!pyOk) {
    console.log('      请先装：winget install --id=Python.Python.3.12 -e')
    console.log('      （装完重跑本脚本。这一步脚本**不替你做** —— 装运行时要动系统，交给你决定）')
  }
  if (gfx === null) {
    console.log('    gfx 代号  ：⚠ 认不出来 —— 请照 AMD 官方支持列表自己挑一个：')
    console.log('      https://rocm.docs.amd.com/projects/install-on-windows/en/latest/reference/system-requirements.html')
  } else {
    console.log(`    gfx 代号  ：${gfx.code}（AMD 官方${gfx.support === 'ok' ? '**支持**' : '**明确不支持**'}）`)
  }
  console.log(`    安装目录  ：${targetRoot}`)
  console.log(`    下载源    ：${ROCM_WHEELS}`)
  console.log('                （AMD 官方软件仓库；ComfyUI 用官方 GitHub，模型用 Comfy-Org 官方仓库）')
  console.log('    ── 步骤 ──')
  console.log(`      1. py -3.12 -m venv ${path.join(targetRoot, 'venv')}`)
  console.log(`      2. pip install -f ${ROCM_WHEELS} "torch==${ROCM_TORCH}"`)
  console.log(`         "torchvision==${ROCM_TORCHVISION}" "torchaudio==${ROCM_TORCHAUDIO}" numpy pillow`)
  console.log('      3. 验证 torch 认到 A 卡（torch.cuda.is_available() 必须 True）')
  console.log('      4. git clone ComfyUI 官方源码')
  console.log('      5. ★ 用 constraints 锁住 torch 再装依赖')
  console.log('         —— 这步最容易翻车：ComfyUI 的 requirements.txt 会把 ROCm 版 torch')
  console.log('            **偷偷换成 CUDA 版**，换完就再也认不到 A 卡了 ✗')
  console.log(`      6. 启动：python main.py --disable-dynamic-vram --use-pytorch-cross-attention`)

  if (checkOnly) {
    console.log('\n  （--check）只打印，没有执行任何一步。去掉 --check 才会真装。')
    return null
  }
  if (!pyOk) {
    console.log('\n  ⚠ Python 3.12 没就绪，先装上再重跑本脚本。')
    return null
  }

  // ── 二次确认：这套操作很重，而且是在别人的机器上 ──
  if (!ASSUME_YES) {
    if (!process.stdin.isTTY) {
      console.log('\n  （非交互环境，没得到确认 → 不执行。确认请加 --yes）')
      return null
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('\n  要在这台机器上装 A 卡那套吗？（会下载约 3 GB，还要建 venv）(y/N) ')
    rl.close()
    if (!ans.trim().toLowerCase().startsWith('y')) {
      console.log('  已取消。想只看看计划就加 --check。')
      return null
    }
  }

  const venv = path.join(targetRoot, 'venv')
  const comfyDir = path.join(targetRoot, 'ComfyUI')
  const pyExe = path.join(venv, 'Scripts', 'python.exe')
  fs.mkdirSync(targetRoot, { recursive: true })

  // 1) venv
  if (!fs.existsSync(pyExe)) {
    if (!run(`py -3.12 -m venv ${venv}`, 'py', ['-3.12', '-m', 'venv', venv])) return null
  } else {
    console.log(`\n    · venv 已存在，跳过：${venv}`)
  }
  if (!run('python -m pip install --upgrade pip wheel', pyExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'])) return null

  // 2) ROCm 版 PyTorch（AMD 官方源）
  if (!run(
    `pip install -f ${ROCM_WHEELS} torch==${ROCM_TORCH} …`,
    pyExe,
    ['-m', 'pip', 'install', '-f', ROCM_WHEELS,
      `torch==${ROCM_TORCH}`, `torchvision==${ROCM_TORCHVISION}`, `torchaudio==${ROCM_TORCHAUDIO}`,
      'numpy', 'pillow'],
  )) return null

  // 3) 验证认卡
  console.log('\n    验证 torch 能不能认到 A 卡 …')
  const probe = spawnSync(pyExe, ['-c',
    'import torch;print(torch.__version__);print(torch.cuda.is_available());'
    + 'print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")'],
  { encoding: 'utf8' })
  const probeText = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
  console.log(probeText.split(/\r?\n/u).map((l) => `      ${l}`).join('\n'))
  if (!/True/u.test(probeText)) {
    console.error('\n    ✗ torch.cuda.is_available() 不是 True —— A 卡没被认到。')
    console.error('      先查显卡驱动（AMD 官方要求 Adrenalin 较新版本），再重跑。')
    return null
  }
  console.log('    ✓ 认到卡了')

  // 4) ComfyUI 官方源码
  if (!fs.existsSync(path.join(comfyDir, 'main.py'))) {
    if (!run(`git clone ${COMFY_REPO}`, 'git', ['clone', '--depth', '1', COMFY_REPO, comfyDir])) return null
  } else {
    console.log(`\n    · ComfyUI 源码已存在，跳过：${comfyDir}`)
  }

  // 5) ★ constraints 锁 torch —— 这一步不做，前面全白干
  const reqPath = path.join(comfyDir, 'requirements.txt')
  if (fs.existsSync(reqPath)) {
    const reqText = fs.readFileSync(reqPath, 'utf8')
    const kept = reqText.split(/\r?\n/u)
      .filter((line) => !/^\s*(torch|torchvision|torchaudio)\b/u.test(line))
      .join('\n')
    const pinPath = path.join(targetRoot, 'torch-pin.txt')
    const reqNoTorch = path.join(targetRoot, 'requirements-no-torch.txt')
    fs.writeFileSync(pinPath,
      `torch==${ROCM_TORCH}\ntorchvision==${ROCM_TORCHVISION}\ntorchaudio==${ROCM_TORCHAUDIO}\n`, 'utf8')
    fs.writeFileSync(reqNoTorch, kept, 'utf8')
    console.log(`\n    ★ 已把 requirements.txt 里的 torch 三行摘掉（${path.basename(reqNoTorch)}），`)
    console.log(`      并用 constraints（${path.basename(pinPath)}）钉死 ROCm 版 —— 否则会被换成 CUDA 版 ✗`)
    if (!run('pip install -r requirements-no-torch.txt -c torch-pin.txt',
      pyExe, ['-m', 'pip', 'install', '-c', pinPath, '-r', reqNoTorch])) return null
  }

  console.log('\n  ✓ A 卡这套装完了')
  console.log(`    以后启动：${pyExe} ${path.join(comfyDir, 'main.py')} --disable-dynamic-vram --use-pytorch-cross-attention`)
  console.log('    ⚠ 启动参数别省：--disable-dynamic-vram 在 A 卡上是必须的（DynamicVRAM 有已知问题）')
  console.log('    ⚠ 出第一张图后**务必人工看一眼**是不是正常图（A 卡会静默出错）')
  return { dir: comfyDir }
}

/* ------------------------------------------------------------------ 主流程 ---- */

console.log('dsh-qwen-paint · 一键部署')
console.log('='.repeat(64))

/* ⓪ 显卡检测 —— 决定走哪条路（0.1.1 新增） */
console.log('\n⓪ 看显卡 …')
const gpu = FORCE_AMD
  ? { names: ['（--amd：手动指定走 AMD 路线）'], vendor: 'amd', via: '--amd', errors: [] }
  : FORCE_NVIDIA
    ? { names: ['（--nvidia：手动指定走 NVIDIA 路线）'], vendor: 'nvidia', via: '--nvidia', errors: [] }
    : detectGpu()

if (gpu.names.length === 0) {
  // ★★ 2026-10-08 修（朋友那台 A 卡机器暴露）：这里原来会"兜底按 NVIDIA 试" ——
  //   对 A 卡用户是灾难：他会被送去下 CUDA 便携包，装完根本跑不起来 ✗
  //   ✓ 现在**绝不替他猜**：把每条查询路径的失败原因摆出来，让他自己指定。
  console.log('  ✗ 查不到显卡信息。下面几条查询路径都试过了：')
  for (const line of gpu.errors) console.log(`      · ${line}`)
  console.log('')
  console.log('  ⚠ 不替你猜走哪条路 —— 猜错要白下好几个 GB：')
  console.log('      · N 卡（或不确定） ：node scripts/setup.mjs --nvidia')
  console.log('      · AMD Radeon       ：node scripts/setup.mjs --amd')
  console.log('      · 已经有 ComfyUI   ：node scripts/setup.mjs --comfy <目录>')
  if (IS_MAC) {
    console.log('    （macOS 自查：`system_profiler SPDisplaysDataType` 看「Chipset Model」）')
  } else {
    console.log('    （想知道自己是什么卡：按 Win+R 输入 dxdiag，看「显示」那一页）')
  }
  console.log('')
  console.log('  ⚠ 如果上面清一色是「拒绝访问 / Access denied」：那是**权限或沙箱**把 WMI 和注册表一起锁了。')
  console.log('    请**在普通 cmd 窗口里自己跑**下面这条（别在受限的沙箱 / 工具环境里跑）：')
  console.log('      打开解压出来的文件夹 → 在地址栏输入 cmd 回车 → 再粘贴命令')
  process.exit(1)
}
for (const name of gpu.names) console.log(`  · ${name}`)
if (gpu.via !== null && gpu.via !== undefined && !gpu.via.startsWith('--')) {
  console.log(`  （查到的途径：${gpu.via}）`)
}

const VENDOR_LABEL = {
  nvidia: 'NVIDIA → 走 ComfyUI 官方便携包（CUDA）',
  amd: 'AMD → 走 ROCm 路线（下面单独说明）',
  apple: 'Apple Silicon → 官方**手动安装**（pytorch nightly + python main.py）',
  intel: 'Intel 核显 → 基本跑不动，建议换台机器',
  unknown: '⚠ 认出了显卡名字，但认不出是哪家',
}
console.log(`  判定：${VENDOR_LABEL[gpu.vendor]}`)

if (gpu.vendor === 'unknown') {
  console.log('\n  ✗ 厂商认不出来，我不敢替你选（选错要白下几个 GB）。')
  console.log('    确认之后加个参数重跑：--nvidia 或 --amd')
  process.exit(1)
}

/* ① ComfyUI */
let comfyDir = null
if (gpu.vendor === 'apple') {
  // ★★★ 2026-10-11 新增：**macOS（Apple Silicon）** 这条路。
  //   为什么不能沿用别的分支：ComfyUI 官方对 Apple Silicon **只给"手动安装"**
  //   （装 pytorch nightly + 按 Manual Installation 装依赖 + `python main.py`），
  //   **没有 macOS 便携包**，也**没有 Mac 专属启动参数** —— 所以插件不替用户装 ComfyUI。
  console.log('\n① 找 ComfyUI …')
  const found = findComfyDir()
  comfyDir = found.dir
  if (comfyDir !== null) {
    console.log(`  ✓ ${comfyDir}（${found.from}）`)
  } else {
    console.log('  ✗ 没找到已装的 ComfyUI。')
    console.log('')
    console.log('  macOS 请按 **ComfyUI 官方「Apple Mac silicon」** 的步骤装：')
    console.log('    1) 装 **pytorch nightly**（Apple 的 Metal 加速指南）：')
    console.log('       https://developer.apple.com/metal/pytorch/')
    console.log('    2) 按 ComfyUI 官方「Manual Installation」装依赖')
    console.log('    3) 启动：`python main.py` —— **官方没有 Mac 专属启动参数**，直接跑即可')
    console.log('')
    console.log('  ⚠ 插件**不替你自动装 ComfyUI**（官方没有 macOS 便携包）。')
    console.log('     装好之后用 `--comfy <你的 ComfyUI 目录>` 重跑本脚本，')
    console.log('     就能继续「下模型 + 挂插件」这两步。')
    process.exit(0)
  }
}
if (gpu.vendor === 'amd') {
  // A 卡：先试 ROCm 路线；没走通（或用户取消 / --check）就退回"本机已有的 ComfyUI"
  const amdRoot = valueOf('--comfy') ?? path.join(os.homedir(), 'ComfyUI-rocm')
  const amdResult = await amdSetup(amdRoot, gfxOf(gpu.names), CHECK_ONLY)
  if (amdResult !== null) {
    comfyDir = amdResult.dir
  } else {
    const fallback = findComfyDir()
    if (fallback.dir !== null) {
      comfyDir = fallback.dir
      console.log(`\n  · 退回用本机已有的 ComfyUI：${comfyDir}`)
      console.log('    ⚠ 但如果它是 NVIDIA 便携包，A 卡是跑不动的 —— 出图会直接失败。')
    }
  }
}
if (comfyDir === null && gpu.vendor !== 'amd' && gpu.vendor !== 'apple') {
  // ↓↓↓ 这一段是 NVIDIA 那条路，与 0.1.0 完全一致，一个字没动 ↓↓↓
  console.log('\n① 找 ComfyUI …')
  const found = findComfyDir()
  comfyDir = found.dir
  if (comfyDir !== null) {
  console.log(`  ✓ ${comfyDir}（${found.from}）`)
} else {
  console.log('  ✗ 没找到已装的 ComfyUI')
  console.log(`    ComfyUI 官方便携包：${COMFY_RELEASE}`)
  console.log(`    官方仓库：${COMFY_REPO}`)
  console.log('    ⚠ 官方 release **不公布哈希**，所以本脚本默认不替你下它。')
  console.log('      想让它下，加 --download-comfy 重新跑（它会再和你确认一次）。')
  if (!WANT_COMFY) {
    console.log('\n  跳过模型部署（没有 ComfyUI 就不知道往哪放）。')
    console.log('  装好 ComfyUI 后重跑本脚本即可，或者用 --comfy <目录> 指定位置。')
    process.exit(0)
  }
  const sevenZip = which('7z.exe') ?? which('7za.exe')
  console.log(`\n  7-Zip：${sevenZip ?? '✗ 没找到 —— 官方便携包是 .7z，没它解不开'}`)
  // ⚠ 铁律三：官方不公布哈希的东西，要**取得当次同意**才动 —— 所以这里真的问一句。
  //   用 readline 而不是 powershell Read-Host：后者读的是控制台，管道输入喂不进去（踩过）。
  let yes = false
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('    ComfyUI 官方 release 不公布哈希，无法做哈希校验。仍要下载吗？(y/N) ')
    rl.close()
    yes = answer.trim().toLowerCase().startsWith('y')
  } else {
    console.log('    （非交互环境，没得到确认 → 不下载）')
  }
  if (!yes) {
    console.log('  已取消。请自行装好 ComfyUI 后重跑本脚本，或用 --comfy <目录> 指定已有安装。')
    process.exit(0)
  }
  const target = valueOf('--comfy') ?? 'D:\\ComfyUI'
  const archive = path.join(os.tmpdir(), 'ComfyUI_windows_portable_nvidia.7z')
  console.log(`  下载到 ${archive} …`)
  const got = await downloadWithCurl(COMFY_RELEASE, archive)
  if (!got.ok) {
    console.error(`  ✗ 下载失败（GitHub 在国内常常连不上）。`)
    console.error('    按规矩：官方连不上又没有正规镜像时，请开 VPN 再跑，或手动装 ComfyUI。')
    process.exit(1)
  }
  if (sevenZip === null) {
    console.error(`  ✗ 已下到 ${archive}，但没装 7-Zip 解不开。请装 7-Zip 后手动解压到 ${target}。`)
    process.exit(1)
  }
  console.log(`  解压到 ${target} …`)
  const un = spawnSync(sevenZip, ['x', archive, `-o${target}`, '-y'], { encoding: 'utf8' })
  if (un.status !== 0) {
    console.error(`  ✗ 解压失败：\n${un.stderr ?? ''}`)
    process.exit(1)
  }
  // 便携包解出来是 ComfyUI_windows_portable\ 一层，往下找一层真正的根
  const inner = path.join(target, 'ComfyUI_windows_portable')
  comfyDir = looksLikeComfy(inner) ? inner : target
  console.log(`  ✓ 解压完成：${comfyDir}`)
  }
} // ← 关掉"NVIDIA 那条路"的外层 if（0.1.1 新增的那层）
if (comfyDir === null) {
  console.log('\n  ✗ 没有可用的 ComfyUI。按上面的提示处理完，再重跑本脚本。')
  process.exit(1)
}

/* ② 三个模型 */
const modelsRoot = modelsRootOf(comfyDir)

// ★★★ 模型档位选择（用户要求保留轻量档）。
//   · `--tier full|lite` 显式指定 → 用它
//   · 交互式终端（且不是 --check）→ 问一句，**直接回车 = 完整档**
//   · 非交互且没指定          → 默认 full
const TIER_ARG = valueOf('--tier')
if (TIER_ARG !== null && !TIERS[TIER_ARG]) {
  console.error(`✗ --tier 只能是 ${Object.keys(TIERS).join(' / ')}，收到的是「${TIER_ARG}」`)
  process.exit(1)
}
let tier = DEFAULT_TIER
if (TIER_ARG !== null) {
  tier = TIER_ARG
} else if (process.stdin.isTTY && !CHECK_ONLY) {
  console.log('\n  主模型有两个档位，请选一个（**直接回车 = 1**）：')
  for (const [i, k] of ['full', 'lite'].entries()) {
    console.log(`    ${i + 1}) ${TIERS[k].label}`)
    console.log(`       ${TIERS[k].hint}`)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('  请选择 [1/2]（回车 = 1）：')
  rl.close()
  tier = String(answer).trim().toLowerCase() === '2' || String(answer).trim() === 'lite'
    ? 'lite' : 'full'
}
const MODELS = modelsFor(tier)

console.log(`\n② 检查千问 Qwen-Image 2.1 模型（放到 ${modelsRoot}）…`)
console.log(`  档位：${TIERS[tier].label}`)
if (TIERS[tier].unet === null) {
  console.log('  ⚠ 轻量档的 GGUF 主模型**不自动下载**（上游那份是 sd.cpp 格式，用不了）。')
  console.log('    请自备一个 ComfyUI 可用的 .gguf，放进上面目录的 unet 子目录；')
  console.log('    插件会自动挑最优的一个来用。')
}

let needDownload = 0
let allOk = true
const needGguf = /\.gguf$/iu.test(MODELS[0].name)
for (const model of MODELS) {
  const dest = path.join(modelsRoot, model.dir, model.name)
  const exists = fs.existsSync(dest)
  const size = exists ? fs.statSync(dest).size : 0
  const sizeOk = exists && size === model.size

  if (sizeOk && !FORCE_VERIFY) {
    console.log(`  ✓ ${model.name}（${gb(model.size)}，大小一致）`)
    continue
  }
  if (sizeOk && FORCE_VERIFY) {
    process.stdout.write(`  … ${model.name} 重算 SHA256（${gb(model.size)}，要等一会儿）`)
    const digest = await sha256Of(dest)
    if (digest === model.sha256) {
      console.log('\r  ✓ ' + `${model.name}（SHA256 一致）`.padEnd(60))
      continue
    }
    console.log('\r  ✗ ' + `${model.name} SHA256 不一致，删除后重下`.padEnd(60))
    fs.rmSync(dest, { force: true })
  } else if (exists) {
    console.log(`  ! ${model.name} 大小不对（实际 ${mb(size)}，应为 ${mb(model.size)}）→ 需要重下`)
  } else {
    console.log(`  · ${model.name} 缺失（${gb(model.size)}）—— ${model.note}`)
  }
  needDownload += 1
  allOk = false
}

/* --check：到此为止 —— 只报告，**绝不下载、绝不改任何东西**。
   ⚠⚠ 这一段**必须放在下载循环之前**。
   早期版本把它写在循环之后，结果 `--check` 只会在"下完之后"才判断 ——
   等于根本没拦：`--check` 照样会开下，实测误建过 2.4 GB 半成品。
   修法：把早退提到 `if (needDownload === 0)` 之前，循环只在"真的要下"时才进。 */
if (CHECK_ONLY) {
  console.log(needDownload === 0
    ? '  ✓ 三个模型都已就绪'
    : `  · 还差 ${needDownload} 个模型，共约 ${gb(MODELS.reduce((s, m) => s + m.size, 0))}`)
  console.log(allOk
    ? '\n（--check）全部就绪，没有做任何改动。'
    : `\n（--check）还差 ${needDownload} 个模型，共约 ${gb(MODELS.reduce((s, m) => s + m.size, 0))}，没有下载。`)
  console.log(`  去掉 --check 重跑就会自动下载。来源：`
    + `${needGguf ? GGUF_REPO_PAGE : REPO_PAGE}（主模型）`
    + ' + https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1（CLIP / VAE）')
  process.exit(allOk ? 0 : 1)
}

if (needDownload === 0) {
  console.log('  ✓ 三个模型都已就绪')
} else {
  console.log(`\n  需要下载 ${needDownload} 个文件（CLIP/VAE 来自 ModelScope 的 ${REPO}`
    + `${needGguf ? `；主模型来自 ${GGUF_REPO}` : ''}）`)
  for (const model of MODELS) {
    const dest = path.join(modelsRoot, model.dir, model.name)
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (size === model.size) continue
    const url = `${repoBaseOf(model)}${model.dir}/${model.name}`
    console.log(`\n  ↓ ${model.name}（${gb(model.size)}）`)
    const got = await downloadWithCurl(url, dest)
    const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0
    if (!got.ok && finalSize !== model.size) {
      console.error(`  ✗ 下载失败（curl 退出码 ${got.code}）：${got.stderr?.slice(0, 300) ?? ''}`)
      console.error('    可重复跑本脚本，curl 会断点续传。')
      allOk = false
      continue
    }
    if (finalSize !== model.size) {
      console.error(`  ✗ 大小不对：${mb(finalSize)}，应为 ${mb(model.size)}`)
      console.error('    ⚠ 按铁律二：校验不过的文件一律删除，不得使用。')
      fs.rmSync(dest, { force: true })
      allOk = false
      continue
    }
    process.stdout.write(`    大小对上了，算 SHA256 …`)
    const digest = await sha256Of(dest)
    if (digest !== model.sha256) {
      console.log('\r  ✗ SHA256 不匹配，已删除该文件（铁律二）'.padEnd(64))
      console.log(`    期望 ${model.sha256}`)
      console.log(`    实际 ${digest}`)
      fs.rmSync(dest, { force: true })
      allOk = false
      continue
    }
    console.log(`\r  ✓ ${model.name} 校验通过（SHA256 与 ${REPO} 一致）`.padEnd(64))
  }
}


/* ②b 轻量档必需 ComfyUI-GGUF —— 否则**出图会被 ComfyUI 直接拒收**。
   原先这句只出现在"选档时的选项文字"里，选完就再也看不到 —— 用户很容易漏掉，
   然后出图失败还以为是插件坏了。（插件面板上也会再提醒一次，但这里给出可照做的命令。） */
if (tier === 'lite' && !CHECK_ONLY) {
  console.log('')
  console.log('  ⚠ **还差一步**：轻量档用 .gguf 主模型，需要 **ComfyUI-GGUF** 自定义节点才能加载。')
  console.log('     把它克隆到 ComfyUI 的 custom_nodes 下，然后重启 ComfyUI：')
  console.log('       git clone https://github.com/city96/ComfyUI-GGUF "<你的ComfyUI>/custom_nodes/ComfyUI-GGUF"')
  console.log('     **没装的话出图会被 ComfyUI 直接拒收**（插件会在优化面板上提醒你）。')
  console.log(`  ⚠ 该 GGUF 来自 ${GGUF_REPO}（Uncensored 系，是实测能配 ComfyUI-GGUF 的一类）。`)
}

/* ②c 输出目录（★ 2026-10-12 用户要求：允许自己选，别强塞 C 盘用户目录） -------------
 *
 * 规则：
 *   · `--output-dir <路径>` 指定（非交互 / 无人值守用这个）
 *   · 交互式终端 → 问一句，**直接回车 = 默认**（桌面「千问1生图」）
 *   · `--check` 只报告，什么都不写、也不问
 * 校验：目录不存在就试着建；建不成就地拒绝；建成了还要**真的写一个临时文件**
 *      （"目录在"不等于"能写"，Windows 上见过 ACL 拒写）。
 */
const OUTPUT_DIR_ARG = valueOf('--output-dir')
if (!CHECK_ONLY && allOk && comfyDir !== null) {
  const base = process.env.XDG_DESKTOP_DIR || path.join(os.homedir(), 'Desktop')
  const norm = (p) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p))

  const tryDir = (dir) => {
    try {
      if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
        return { ok: false, why: '这个路径已存在，而且是个文件' }
      }
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.dshqp-write-test-${process.pid}.tmp`)
      fs.writeFileSync(probe, 'ok', 'utf8')
      fs.rmSync(probe, { force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, why: String(e?.message ?? e).split('\n')[0] }
    }
  }

  let chosen = null
  if (OUTPUT_DIR_ARG !== null) {
    const r = tryDir(norm(OUTPUT_DIR_ARG))
    if (!r.ok) {
      console.error(`\n  ✗ --output-dir「${OUTPUT_DIR_ARG}」不可用：${r.why}`)
      process.exit(1)
    }
    chosen = OUTPUT_DIR_ARG
    console.log(`\n  输出目录：${norm(chosen)}`)
  } else if (process.stdin.isTTY) {
    console.log('\n②c 出图保存到哪个目录？（**直接回车 = 默认**）')
    console.log(`    默认：${path.join(base, '千问1生图')}`)
    console.log('    可以写绝对路径，如 D:////我的图////千问')
    console.log('    也可以只写文件夹名（放到默认位置下，换机器也不会失灵）')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    let answer = ''
    for (;;) {
      answer = (await rl.question('  目录（回车 = 默认）：')).trim()
      if (answer === '') break
      const r = tryDir(norm(answer))
      if (r.ok) break
      console.error(`     ✗ 不可用：${r.why}　（重新输入，或直接回车用默认）`)
    }
    rl.close()
    if (answer !== '') chosen = answer
    console.log(`  输出目录：${chosen === null ? path.join(base, '千问1生图') : norm(chosen)}`)
  }

  // 选了非默认路径才写配置（默认值本来就在代码里，不必硬写一行）
  if (chosen !== null) {
    const wrote = writeConfigKey(path.join(ROOT, 'cordis.patch.yml'), 'outputDir', norm(chosen))
    if (wrote) {
      console.log(`    已写进 cordis.patch.yml：outputDir = '${norm(chosen)}'`)
    } else {
      console.log('    ⚠ 没能自动写入 cordis.patch.yml（结构可能被改过）—— 请手动加一行：')
      console.log(`        outputDir: '${norm(chosen)}'`)
    }
  }
}

/* ③ 插件本体 */
console.log('\n③ 把插件挂进 DSH profile …')
if (!allOk) {
  console.log('  ⚠ 模型还没齐，先不装插件（模型是我们自己的问题，装上也画不出图）。')
  console.log('  处理完上面的问题再重跑本脚本。')
  process.exit(1)
}
const installer = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install.mjs')], {
  stdio: 'inherit', cwd: ROOT,
})
if (installer.status !== 0) {
  console.error('  ✗ 插件安装失败，见上面的输出。')
  process.exit(1)
}

console.log('\n' + '='.repeat(64))
console.log('✓ 部署完成')
console.log(`  ComfyUI ：${comfyDir}`)
console.log(`  模型目录 ：${modelsRoot}`)
console.log('  下一步：**彻底退出 DSH 再重新打开**，然后说一句「画一只橘猫」。')
