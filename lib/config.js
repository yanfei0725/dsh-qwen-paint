// 设计说明已外置 → docs/config-design-notes.md#config-note-001（原 L1-10）
import { promises as fsp, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { HIPFIRE_DEFAULTS } from './hipfire-img.js'
// ★ 2026-10-15：网络边界守卫 + 子进程环境过滤（DSH STORE 合规整改，见 net-guard.js）。
// ★ 2026-10-16：补上 guardedFetch —— 让所有出站请求走**同一个**出口（校验 + 禁重定向）。
import { filteredEnv, guardedFetch } from './net-guard.js'
import { describeOptimization, genericOptimizations } from './describe.js'
import { attachWorkflowMeta } from './workflow-meta.js'
// ★ 2026-11-15：SageAttention / Comfy-WaveSpeed 接进真实生图工作流（默认关、类名靠真实探测）。
import { buildAttentionWorkflowPatch } from './attention-workflow.js'
import { resolveOfficialTurbo } from './official-turbo.js'
import { MAX_REFERENCE_IMAGES, assertReferenceCount } from './reference-inputs.js'
import { tierForVram } from './model-map.js'
// ★ 2026-11-13：用户可选的核显型号档案（纯数据，不联网不探测）。
import { igpuPlanFor } from './igpu-profiles.js'
// B5：会话级模型驻留账本（纯内存储，不联网；构建图时记一笔）
import { sessionResidency, RESIDENCY_KEYS } from './model-residency.js'
import { DEFAULTS, DRAW_INTENT_MODES, NO_SELF_DRAW_RULE, buildDrawIntentPrompt, INLINE_IMAGE_PROMPT, PARAMETERS, OUTPUT_SCHEMA, defaultOutputBase, defaultOutputDir, TURBO8_STEPS, DEFAULT_TURBO8_LORA, BASE_STEPS, BASE_CFG } from './schema-defaults.js'
import {
  loraNode, fluxShiftNode, prefixCacheNode, teSpeedNode, speedupNode, blockCacheNode, rdna3FaNode, easyCacheNode,
} from './model-chain.js'
import {
  createTurboWorkflowBuilders,
  OFFICIAL_TURBO_STEPS,
  OFFICIAL_EDIT_STEPS,
  OFFICIAL_TURBO_SIGMAS_8,
  OFFICIAL_EDIT_SIGMAS_9,
} from './turbo-workflow.js'
// ★ 2026-10-19 消除循环依赖：原先这里反向 import 了 index.js 的
//   ensureComfyUp / getNodeSchema / nodeFileList / diag / execFileAsync / name
//   （能跑只因它们只在函数体内用；顶层一用就 TDZ）。现改为单向 index.js → config.js。

/** `execFile` 的 Promise 版（原在 index.js，只为本文件服务）。 */
export const execFileAsync = promisify(execFile)

/** 由 index.js 在 apply() 时注入「确保 ComfyUI 在线」。未注入则退化为不主动拉起。 */
let ensureComfyUpHook = null

export function setEnsureComfyUpHook(fn) {
  ensureComfyUpHook = typeof fn === 'function' ? fn : null
}

/** 查单个节点类型的 schema（ComfyUI `/object_info/{type}`），三态：ok / missing / error。 */
export async function getNodeSchema(cfg, type, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/object_info/${type}`, { timeoutMs: 15000, signal })
    if (!res.ok) return { state: 'error', node: null }
    const json = await res.json()
    const node = json?.[type] ?? null
    return node === null ? { state: 'missing', node: null } : { state: 'ok', node }
  } catch {
    return { state: 'error', node: null }
  }
}

/** 从节点 schema 里取某个输入项的候选文件名列表（ComfyUI 的 OPTIONS 约定）。 */
export function nodeFileList(schema, field) {
  const spec = schema?.input?.required?.[field] ?? schema?.input?.optional?.[field]
  return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : []
}




// 设计说明已外置 → docs/config-design-notes.md#config-note-002（原 L79-102）
function resolveOutputDir(rawDir, log) {
  const fallback = defaultOutputDir()
  const raw = String(rawDir ?? '').trim()
  if (raw === '') return { dir: fallback, source: '默认桌面目录' }

  // 相对路径 → 拼到默认基目录下（换机器仍可用）
  const target = path.isAbsolute(raw) ? path.normalize(raw) : path.join(defaultOutputBase(), raw)
  let existed = false
  try {
    existed = existsSync(target)
    if (existed && !statSync(target).isDirectory()) {
      return { dir: fallback, source: '默认桌面目录（原配置不可用）', problem: `${target} 已存在且是个文件` }
    }
    mkdirSync(target, { recursive: true })
  } catch (error) {
    const why = String(error?.message ?? error).split('\n')[0]
    log?.('warn', `outputDir「${raw}」不可用（${existed ? '无法创建/写入' : '无法创建'}：${why}）`
      + ` → 本次退回默认目录 ${fallback}`)
    return { dir: fallback, source: '默认桌面目录（原配置不可用）', problem: why }
  }
  // ② 真正试写一次（目录存在 ≠ 有写权限）
  const probe = path.join(target, `.dshqp-write-test-${process.pid}.tmp`)
  try {
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
  } catch (error) {
    const why = String(error?.message ?? error).split('\n')[0]
    log?.('warn', `outputDir「${raw}」没有写权限（${why}）→ 本次退回默认目录 ${fallback}`)
    return { dir: fallback, source: '默认桌面目录（原配置不可用）', problem: why }
  }
  return { dir: target, source: path.isAbsolute(raw) ? '配置的绝对路径' : '相对路径（解析到默认位置下）' }
}


/* ------------------------------------------------ 生图动画方案（界面可自选） ---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-003（原 L139-145）
const FLOW_STYLES = [
  'meteor',
  'macaron', 'candy', 'rouge', 'bamboo', 'aurora', 'deepsea', 'sunset', 'forest',
  'champagne', 'lavender', 'mint', 'lava', 'galaxy', 'ink', 'indigo',
]

/** 界面偏好落盘路径：$DSH_HOME 优先（跟着 DSH 的 home 走），其次按用户目录推算。 */
function uiStatePath() {
  const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return path.join(home, 'qwen-paint-ui.json')
}

/** 读界面偏好。文件不存在 / 内容坏了都返回空对象 —— 绝不影响出图。 */
function readUiState() {
  try {
    const parsed = JSON.parse(readFileSync(uiStatePath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

/** 写界面偏好（同步写：文件很小、只在用户点选时发生，避免异步写的竞态）。 */
function writeUiState(state, log) {
  try {
    writeFileSync(uiStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch (error) {
    log('warn', `界面偏好写盘失败（只影响"下次启动还记不记得"）：${error?.message ?? error}`)
    return false
  }
}

/** 画幅比例（照抄 app.py 的 ASPECTS）。 */
const ASPECTS = {
  '1:1': [1, 1],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '16:9': [16, 9],
  '9:16': [9, 16],
}

/* ------------------------------------------------------------------ 小工具 ---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-004（原 L192-204）
const LOG_FLOOR = { debug: 0, info: 1, warn: 2, error: 3 }

function makeLog(ctx, progressMode) {
  const mode = String(progressMode ?? 'brief').toLowerCase()
  const floor = mode === 'quiet' ? LOG_FLOOR.warn : mode === 'detailed' ? LOG_FLOOR.debug : LOG_FLOOR.info
  return (level, message) => {
    try {
      if ((LOG_FLOOR[level] ?? LOG_FLOOR.info) < floor) return
      const logger = ctx.logger ?? ctx.root?.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[qwen-paint] ${message}`)
      else if (level === 'error' || level === 'warn') console.error(`[qwen-paint] ${message}`)
    } catch {
      /* 日志失败绝不影响出图 */
    }
  }
}

/** 对齐到 32 的倍数（照抄 app.py 的 r32）。 */
function r32(value) {
  return Math.max(32, Math.round(value / 32) * 32)
}

/** 按画幅比例 + 百万像素算尺寸（照抄 app.py 的 calc_size）。 */
function calcSize(aspect, megapixels) {
  const [aw, ah] = ASPECTS[aspect] ?? [1, 1]
  const ratio = aw / ah
  const total = Number(megapixels) * 1e6
  const width = Math.sqrt(total * ratio)
  return [r32(width), r32(width / ratio)]
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-005（原 L236-244）
function presetAspect(preset) {
  if (preset === 'portrait' || preset === 'anime') return '3:4'
  if (preset === 'wallpaper') return '16:9'
  return null
}

/** 把提示词变成安全的文件名主体（照抄 app.py 的 safe_name 精神）。 */
function safeStem(prompt, maxChars) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return '无题'
  // ★ 2026-10-10 修 bug：调用方传的是 `maxChars`（落盘时是 22），但英文分支原先**写死 34** ——
  //   于是纯英文 prompt 会生成比中文长一截的文件名，参数形同虚设、风格还不统一。
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 34
  if (/^[\x20-\x7e]+$/u.test(cleaned)) {
    // 纯英文按词截断，别切半个单词
    let out = ''
    for (const word of cleaned.split(' ')) {
      if (out.length + word.length + 1 > limit) break
      out = `${out} ${word}`.trim()
    }
    return out || cleaned.slice(0, limit)
  }
  return cleaned.slice(0, limit)
}

/** 找一个不冲突的落盘路径。 */
async function uniquePath(dir, filename) {
  const first = path.join(dir, filename)
  try {
    await fsp.access(first)
  } catch {
    return first
  }
  const ext = path.extname(filename)
  const stem = path.basename(filename, ext)
  for (let i = 2; i < 999; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

/** 从 comfyUrl 取端口号（取不到就退回 8188）。 */
function portOf(url) {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 8188
  }
}

/* -------------------------------------------------------------- 错误规范化 ---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-006（原 L307-333）
function toError(value) {
  if (value instanceof Error) return value
  // 字符串 / 数字 / 布尔：直接当消息
  if (typeof value === 'string') return new Error(value === '' ? '未知错误（空字符串）' : value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return new Error(String(value))
  }
  if (value === null || value === undefined) return new Error('未知错误（无详情）')
  // 普通对象：优先掏它身上像"消息"的字段，再退到 JSON
  if (typeof value === 'object') {
    for (const key of ['message', 'msg', 'reason', 'error', 'detail', 'description']) {
      const inner = value[key]
      if (typeof inner === 'string' && inner !== '') {
        const wrapped = new Error(inner)
        wrapped.cause = value
        return wrapped
      }
    }
    let json = ''
    try {
      json = JSON.stringify(value)
    } catch {
      json = ''
    }
    const wrapped = new Error(json && json !== '{}' ? json.slice(0, 500) : `未知错误（${Object.prototype.toString.call(value)}）`)
    wrapped.cause = value
    return wrapped
  }
  return new Error(String(value))
}

/**
 * 把"取消原因"翻译成人话。
 *
 * ⚠ **不要**直接把 `signal.reason` 丢给 `controller.abort()`：
 *   它可能是任何东西，实测传普通对象就会让用户看到 `[object Object]`。
 *   这里统一转成一句可读的中文 Error —— 顺便把"是谁取消的"也说清楚。
 */
function cancelReason(signal) {
  const raw = signal?.reason
  if (raw instanceof Error && raw.message !== '') return raw
  // 宿主没给 reason（或给的不是 Error）时，不能把空对象透出去
  const text = (() => {
    if (typeof raw === 'string' && raw !== '') return raw
    if (raw && typeof raw === 'object') {
      for (const key of ['message', 'msg', 'reason', 'detail']) {
        const inner = raw[key]
        if (typeof inner === 'string' && inner !== '') return inner
      }
    }
    return ''
  })()
  return new Error(text === '' ? '任务已取消（宿主中止了这次调用）' : `任务已取消：${text}`)
}

// ===== moved from index.js: fetchWithTimeout (was lines 155-207) =====
async function fetchWithTimeout(url, { method = 'GET', body, timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs} 毫秒）：${url}`)), timeoutMs)
  // ★ 2026-10-09：**绝不**原样转发 signal.reason —— 它是普通对象时会让上层看到
  //   `[object Object]`（真事故，详见 toError / cancelReason 的注释）。
  const onAbort = () => controller.abort(cancelReason(signal))
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
// 设计说明已外置 → docs/config-design-notes.md#config-note-007（原 L401-405）
    return await guardedFetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
// 设计说明已外置 → docs/config-design-notes.md#config-note-008（原 L411-416）
      proxy: undefined,
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-009（原 L425-446）


// ===== moved from index.js: IS_WINDOWS (was lines 208-208) =====
const IS_WINDOWS = process.platform === 'win32'

// ===== moved from index.js: IS_MAC (was lines 210-212) =====
const IS_MAC = process.platform === 'darwin'

/** Windows：WMI 列出所有显示适配器名称。 */

// ===== moved from index.js: GPU_PROBE_WIN (was lines 213-229) =====
const GPU_PROBE_WIN = '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | '
  + 'Select-Object -ExpandProperty Name) -join " | "'

// 设计说明已外置 → docs/config-design-notes.md#config-note-010（原 L461-474）

// ===== moved from index.js: GPU_VRAM_PROBE_PY (was lines 230-245) =====
const GPU_VRAM_PROBE_PY = 'import torch;'
  + 'p=torch.cuda.get_device_properties(0);'
  + 'print(int(p.total_memory))'

// 设计说明已外置 → docs/config-design-notes.md#config-note-011（原 L481-492）

// ===== moved from index.js: GPU_VRAM_PROBE_PY_MAC (was lines 246-248) =====
const GPU_VRAM_PROBE_PY_MAC = 'import torch;'
  + 'print(int(getattr(torch.mps, \'recommended_max_memory\', lambda: 0)()))'


// ===== moved from index.js: GPU_VRAM_PROBE_WIN (was lines 249-259) =====
const GPU_VRAM_PROBE_WIN = '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | '
  + 'Where-Object { $_.Name -notmatch "Basic|Remote|Meta|Mirror" } | '
  + 'Sort-Object AdapterRAM -Descending | Select-Object -First 1 '
  + '-ExpandProperty AdapterRAM)'

/**
 * Linux：**多级回落**取显卡信息。
 *   nvidia-smi（N 卡型号最准）→ rocm-smi（A 卡型号）→ lspci（通用，但可能没装）
 *   → `/sys/class/drm/<card>/device/vendor`（最后兜底：只有 PCI vendor id，够判断厂商）
 * 全部 `2>/dev/null`：工具没装是常态，不该产生噪音。
 */

// ===== moved from index.js: GPU_PROBE_LINUX (was lines 260-276) =====
const GPU_PROBE_LINUX = 'nvidia-smi -L 2>/dev/null; '
  + 'rocm-smi --showproductname 2>/dev/null; '
  + 'lspci 2>/dev/null | grep -iE "vga|3d controller|display"; '
  + 'cat /sys/class/drm/card*/device/vendor 2>/dev/null'

// 设计说明已外置 → docs/config-design-notes.md#config-note-012（原 L518-529）

// ===== moved from index.js: GPU_PROBE_MAC (was lines 277-280) =====
const GPU_PROBE_MAC = 'system_profiler SPDisplaysDataType 2>/dev/null; '
  + 'sysctl -n machdep.cpu.brand_string 2>/dev/null'

/** PCI vendor id → 厂商名（Linux 兜底路径只能拿到这个）。 */

// ===== moved from index.js: PCI_VENDOR (was lines 281-283) =====
const PCI_VENDOR = { '0x1002': 'AMD Radeon', '0x10de': 'NVIDIA', '0x8086': 'Intel' }

/** 把多行探测输出规范化成一行，并把裸 vendor id 翻成厂商名。 */

// ===== moved from index.js: normalizeGpuText (was lines 284-296) =====
function normalizeGpuText(raw) {
  return String(raw ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => PCI_VENDOR[line.toLowerCase()] ?? line)
    .join(' | ')
}

/**
 * ComfyUI 路径扫描 —— Windows 版。
 * 找"python + main.py 齐活"的目录组合，输出 `python|main.py|root` 一行。
 */

// ===== moved from index.js: COMFY_SEARCH_WIN (was lines 297-335) =====
const COMFY_SEARCH_WIN = [
  '$cands = @()',
  '$cands += "$env:USERPROFILE\\ComfyUI", "$env:USERPROFILE\\Documents\\ComfyUI", "$env:USERPROFILE\\Desktop\\ComfyUI", "$env:USERPROFILE\\Downloads\\ComfyUI"',
// 设计说明已外置 → docs/config-design-notes.md#config-note-013（原 L561-566）
  'foreach ($l in [char[]](65..90)) {',
  '  $drive = "${l}:"',
  '  if (Test-Path -LiteralPath "$drive\\") { $cands += "$drive\\ComfyUI", "$drive\\ComfyUI_windows_portable" }',
  '}',
  'foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {',
  // 只扫本地盘（形如 `X:\`）：网络盘/映射盘上 Get-ChildItem 可能长时间无响应，会把探测拖到超时
  "  if ($d.Root -notmatch '^[A-Za-z]:\\\\$') { continue }",
  '  Get-ChildItem -LiteralPath $d.Root -Directory -ErrorAction SilentlyContinue |',
  "    Where-Object { $_.Name -match 'comfy' } | ForEach-Object { $cands += $_.FullName }",
  '}',
  'foreach ($root in ($cands | Select-Object -Unique)) {',
  '  if (-not (Test-Path -LiteralPath $root)) { continue }',
  '  $py = @("$root\\python_embeded\\python.exe", "$root\\venv\\Scripts\\python.exe", "$root\\.venv\\Scripts\\python.exe") |',
  '    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1',
  '  $mp = @("$root\\ComfyUI\\main.py", "$root\\main.py") |',
  '    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1',
  '  if ($py -and $mp) { Write-Output ($py + "|" + $mp + "|" + $root); break }',
  '}',
].join('\n')

// 设计说明已外置 → docs/config-design-notes.md#config-note-014（原 L587-596）

// ===== moved from index.js: COMFY_SEARCH_NIX (was lines 336-368) =====
const COMFY_SEARCH_NIX = [
  'for root in \\',
  '  "$HOME/ComfyUI" "$HOME/comfy/ComfyUI" "$HOME/ComfyUI-rocm/ComfyUI" "$HOME/ai/ComfyUI" \\',
  '  /opt/ComfyUI /usr/local/ComfyUI /opt/comfyui /srv/ComfyUI \\',
  '  $(find /mnt /media /opt /srv "$HOME" -maxdepth 3 -type d -iname "*comfy*" 2>/dev/null); do',
  '  [ -d "$root" ] || continue',
  '  py=""',
  '  for p in "$root/venv/bin/python" "$root/.venv/bin/python" "$root/venv/bin/python3" "$root/bin/python"; do',
  '    if [ -x "$p" ]; then py="$p"; break; fi',
  '  done',
  '  [ -n "$py" ] || continue',
  '  mp=""',
  '  for m in "$root/main.py" "$root/ComfyUI/main.py"; do',
  '    if [ -f "$m" ]; then mp="$m"; break; fi',
  '  done',
  '  [ -n "$mp" ] || continue',
  '  printf "%s|%s|%s\\n" "$py" "$mp" "$root"',
  '  break',
  'done',
].join('\n')

// 设计说明已外置 → docs/config-design-notes.md#config-note-015（原 L620-631）

// ===== moved from index.js: runShell (was lines 369-385) =====
async function runShell(script, timeoutMs = 20000) {
  // ★ 2026-10-15（DSH STORE 合规整改）：探测类子进程一律用**过滤后的**环境变量，
  //   不直接继承宿主 —— 剔除代理与凭据类变量（见 net-guard.filteredEnv）。
  const env = filteredEnv()
  if (IS_WINDOWS) {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env },
    )
    return String(stdout ?? '').trim()
  }
  const { stdout } = await execFileAsync('sh', ['-c', script], {
    timeout: timeoutMs,
    encoding: 'utf8',
    env,
  })
  return String(stdout ?? '').trim()
}

/** Python 探针：数组 argv 直接交给 OS，py 路径 / 代码里的引号不再经过命令外壳解析。 */
async function runPython(py, code, timeoutMs = 30000) {
  const { stdout } = await execFileAsync(py, ['-c', code], {
    timeout: timeoutMs, windowsHide: IS_WINDOWS, encoding: 'utf8', env: filteredEnv(),
  })
  return String(stdout ?? '').trim()
}

/** 路径探测结果缓存（ComfyUI 装在哪不会中途变；扫盘有成本，别每次调用都重来）。 */

// ===== moved from index.js: PATHS_CACHE (was lines 386-387) =====
let PATHS_CACHE = null


// ===== moved from index.js: discoverComfyPaths (was lines 388-447) =====
async function discoverComfyPaths(cfg, log) {
  if (cfg.comfyPython && cfg.comfyMainPy) {
    return {
      py: cfg.comfyPython,
      mainPy: cfg.comfyMainPy,
      workdir: cfg.comfyWorkdir ?? path.dirname(cfg.comfyMainPy),
      from: '配置',
    }
  }
  // ★ 缓存 10 分钟：本函数要扫各盘根目录（几百毫秒~数秒），
  //   而 `ensureComfyUp`（每次自启）与 `probeAcceleration`（每次检查）都会调它。
  if (PATHS_CACHE && Date.now() - PATHS_CACHE.at < 600000) return PATHS_CACHE.paths

  try {
    const out = await runShell(IS_WINDOWS ? COMFY_SEARCH_WIN : COMFY_SEARCH_NIX, 30000)
    const line = String(out).split(/\r?\n/u).map((s) => s.trim()).find((s) => s.includes('|'))
    if (line) {
      const [py, mainPy, root] = line.split('|')
      if (py && mainPy) {
// 设计说明已外置 → docs/config-design-notes.md#config-note-016（原 L680-685）
        const found = { py, mainPy, workdir: path.dirname(mainPy), from: '自动探测' }
        void root
        PATHS_CACHE = { at: Date.now(), paths: found }
        return found
      }
    }
  } catch (error) {
    log?.('warn', `自动探测 ComfyUI 路径失败：${error?.message ?? error}`)
  }
  return null
}

/* ------------------------------------------------- GPU 厂商自适应 + 专用加速 ---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-017（原 L700-720）

// ===== moved from index.js: GPU_PROFILES (was lines 448-597) =====
const GPU_PROFILES = {
  /**
   * ★ RDNA3（RX 7000 系列）—— **用户的既定方案，刻意保持不变**。
   *   A 卡这条线上不再引入任何额外内核：turbo8 八步链 + 前缀缓存 + 跳步缓存 + quad，
   *   本机全链路已验证（8.2s/张），够用且稳。
   */
  amd_rdna3: {
    id: 'amd_rdna3',
    label: 'AMD Radeon RX 7000 系列（RDNA3 / gfx11xx）',
    // 实测（RX 7900 XT / gfx1100 / ROCm 7.2.1）：10.739s → 9.328s（+15.1%），
    // 满叠栈再 +17.3%；`--use-pytorch-cross-attention` 则是 −0.3%（无效，本来就是默认路径）。
    args: ['--use-quad-cross-attention'],
    tuning: 'quad 交叉注意力（既定方案，实测 +15%）',
    packs: [],
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-018（原 L738-746）
  amd_rdna4: {
    id: 'amd_rdna4',
    label: 'AMD Radeon RX 9000 系列（RDNA4 / gfx120x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch CK SDPA flash attention（RDNA4 专用内核）',
    packs: [],
    note: 'RDNA4 的 CK SDPA 需要较新的 PyTorch；旧版在 gfx1200/1201 上会断言失败'
      + '（pytorch#188113 → 修复 #188114 / #193585）。若启动即崩，可把 comfyAttentionBackend 设为 default。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-019（原 L756-764）
  amd_rdna2: {
    id: 'amd_rdna2',
    label: 'AMD Radeon RX 6000 系列（RDNA2 / gfx103x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（RDNA2 无 AOTriton / CK 融合内核，走保守路径）',
    packs: [],
    note: 'RDNA2 不在 ROCm AOTriton 覆盖范围内（仅 RDNA3/3.5/4），故不套用 quad；'
      + '若有异常可把 comfyAttentionBackend 设为 default。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-020（原 L774-792）
  amd_rdna1: {
    id: 'amd_rdna1',
    label: 'AMD Radeon RX 5000 系列（RDNA1 / gfx101x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（RDNA1 无 AOTriton / CK 融合内核，走保守路径）',
    packs: [],
    note: 'RDNA1（gfx1010 / gfx1012）**不在 ROCm 官方支持矩阵内**：'
      + 'PyTorch 官方 ROCm 轮子未编译 gfx101x，通常需要 HSA_OVERRIDE_GFX_VERSION '
      + '（或自行按 gfx101x 编译 PyTorch）才能让 PyTorch 认卡。'
      + 'AOTriton / CK 融合注意力只覆盖 RDNA3/3.5/4 ⇒ 本代不套用 quad / ck。',
  },
  /** 认得出是 AMD、但认不出具体代数（信息不足时的保守落点）。 */
  amd: {
    id: 'amd',
    label: 'AMD Radeon（未识别具体架构）',
    args: ['--use-quad-cross-attention'],
    tuning: 'quad 交叉注意力（保守沿用既定方案）',
    packs: [],
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA（CUDA）',
    // CUDA 下 PyTorch SDPA 默认已用 flash / mem-efficient 内核，quad 无收益；
    // 这里显式写 pytorch 只是"明确用官方路径"，真正的加速靠 SageAttention 这类外部内核。
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch 原生 SDPA（flash / mem-efficient 内核）',
    // ★ 2026-10-09：补上社区公认的 N 卡方案（保守起见都能装、但**默认不自动装**）。
    //   triton-windows 是前置组件 → sageattention 是主力 → nunchaku 属进阶（要转模型）。
    packs: ['triton-windows', 'sageattention', 'nunchaku'],
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-021（原 L823-830）
  intel_battlemage: {
    id: 'intel_battlemage',
    label: 'Intel Arc B 系列（Battlemage / Xe2 — B580 / B570）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端 + IPEX（Xe2 需要更新版 torch-xpu / IPEX）',
    packs: ['ipex'],
    note: 'Battlemage 较新：若 torch 未编译 XPU（`torch.xpu.is_available()` 为假），'
      + '需先按 ComfyUI 官方 XPU 说明安装 torch-xpu，再装 IPEX。',
  },
  intel_alchemist: {
    id: 'intel_alchemist',
    label: 'Intel Arc A 系列（Alchemist / Xe HPG — A770 / A750 / A580）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端 + IPEX',
    packs: ['ipex'],
    note: 'Alchemist 是 XPU 支持最成熟的一代：装好 torch-xpu + IPEX 即可。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-022（原 L848-893）
  apple: {
    id: 'apple',
    label: 'Apple Silicon（MPS / 统一内存）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（MPS 上的 Metal 融合内核）+ MPS 算子回退兜底',
    packs: [],
    // ★ 2026-10-12：档案级默认环境变量 —— 由启动流程注入给 ComfyUI 进程。
    env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    note: '需要 macOS 版 PyTorch（自带 MPS 后端）。'
      + 'ComfyUI 在 MPS 上**不会自动**启用 PyTorch SDPA（源码里 ENABLE_PYTORCH_ATTENTION '
      + '没有任何 MPS 分支），默认落到次二次实现 ⇒ 插件补上 --use-pytorch-cross-attention，'
      + '切到 Metal 融合内核；并注入 PYTORCH_ENABLE_MPS_FALLBACK=1 兜住 MPS 未实现的算子。'
      + '统一内存没有独立显存 ⇒ 不加 --highvram 之类的驻留参数。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-023（原 L908-917）
  mac_amd: {
    id: 'mac_amd',
    label: 'Intel Mac + AMD 独显（MPS / Metal）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（走 Metal，不走 ROCm）',
    packs: [],
    env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    note: 'macOS 上的 AMD 显卡**不走 ROCm**（Apple 只提供 Metal/MPS），'
      + '所以不套用 A 卡的 CK / quad 内核参数。需要 macOS ≥ 12.3 与 PyTorch ≥ 2.x。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-024（原 L928-940）
  mac_mps: {
    id: 'mac_mps',
    label: 'macOS（MPS / Metal — 芯片型号未识别）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（走 Metal；型号未识别，按 Mac 同款处理）',
    packs: [],
    env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    note: '只探测到 MPS 可用，没拿到具体芯片型号'
      + '（ComfyUI 在 Mac 上只报 "mps"；system_profiler 也没给结果）。'
      + '按 Mac 通用路径处理：走 Metal/MPS + PyTorch SDPA，不挂任何 CUDA / ROCm / XPU 参数。',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-025（原 L952-963）
  intel_mac: {
    id: 'intel_mac',
    label: 'Intel Mac（macOS — 无 CUDA / ROCm / XPU）',
    args: [],
    tuning: '不指定厂商内核参数（macOS 上只有 MPS 或 CPU 两条路）',
    packs: [],
    env: { PYTORCH_ENABLE_MPS_FALLBACK: '1' },
    note: 'Intel Mac 没有 CUDA / ROCm / XPU 任何一条厂商计算栈 —— '
      + '**不要套用 Windows/Linux 上 Intel Arc 的 XPU + IPEX 方案**（macOS 上不存在 XPU 后端）。'
      + '带 AMD 独显的机型会识别为「Intel Mac + AMD 独显」并走 MPS；'
      + '只有 Intel 核显的机型通常只能跑 CPU（很慢）。'
      + '若确认要显式跑 CPU，可把 comfyArgs 设为 ["--cpu"]。',
  },
  intel: {
    id: 'intel',
    label: 'Intel（XPU，未识别具体型号）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch XPU 后端（插件不额外指定内核）',
    packs: ['ipex'],
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-026（原 L984-995）
  intel_igpu: {
    id: 'intel_igpu',
    label: 'Intel 核显 / 共享显存（UHD / Iris Xe 等）',
    args: ['--lowvram'],
    tuning: '共享显存模式：--lowvram（权重按需换入系统内存）',
    packs: [],
    sharedMemory: true,
    note: 'Intel 核显没有独立显存，靠系统内存当显存。8 GB 整机内存偏紧，建议 ≥16 GB；'
      + '首次出图会慢（要把权重换入内存），同分辨率后续会快一些。'
      + '插件默认 --lowvram，不挂任何厂商加速包。',
  },
  unknown: {
    id: 'unknown',
    label: '未知 / 其他',
    args: [],
    tuning: '不指定任何注意力参数（保证能启动）',
    packs: [],
  },
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-027（原 L1016-1029）

// ===== moved from index.js: AMD_KERNEL_FLAG (was lines 598-607) =====
const AMD_KERNEL_FLAG = {
  // ★ 2026-10-12 补：RDNA1（RX 5000）同样没有 AOTriton / CK 覆盖，给 quad 作为**可选**替代
  amd_rdna1: '--use-quad-cross-attention',
  amd_rdna2: '--use-quad-cross-attention',
  amd_rdna3: '--use-ck-attention',
  amd_rdna4: '--use-ck-attention',
}

/**
 * 厂商判定规则（**得分高者胜**）。
 * 明确型号优先于泛化厂商名，独显优先于核显 —— 见上面"为什么要打分"。
 */

// ===== moved from index.js: VENDOR_RULES (was lines 608-634) =====
const VENDOR_RULES = [
  { id: 'nvidia', re: /nvidia|geforce|rtx\s?\d|quadro|tesla|a100|h100|l40/i, score: 100 },
  // ★ AMD 按**代数**细分：RX 9000=RDNA4（换 CK 内核）、7000=RDNA3（既定方案）、6000=RDNA2（保守）
  { id: 'amd_rdna4', re: /radeon\s+(rx\s?)?9\d{3}|gfx120\d/i, score: 98 },
  { id: 'amd_rdna3', re: /radeon\s+(rx\s?)?7\d{3}|gfx11\d{2}/i, score: 95 },
  { id: 'amd_rdna2', re: /radeon\s+(rx\s?)?6\d{3}|gfx103\d/i, score: 93 },
// 设计说明已外置 → docs/config-design-notes.md#config-note-028（原 L1052-1058）
  { id: 'amd_rdna1', re: /radeon\s+(rx\s?)?5\d{3}|gfx101\d/i, score: 91 },
  // ★ Intel Arc 按代系细分（B580 = Battlemage / Xe2，A770 = Alchemist / Xe HPG）。
  //   注意显卡名常写成 "Intel(R) Arc(TM) B580 Graphics"，所以不能用 `arc\s?b580` 这种
  //   紧邻匹配，放宽成 `arc.*b\d{3}`；同时保留裸型号 `b580` 兜底。
  { id: 'intel_battlemage', re: /battlemage|xe2|\bb5[0-9]0\b|arc.*b\d{3}/i, score: 92 },
  { id: 'intel_alchemist', re: /alchemist|xe\s?hpg|\ba7[0-9]0\b|arc.*a\d{3}/i, score: 91 },
  { id: 'intel', re: /intel.*arc|arc\s?\w|battlemage|alchemist/i, score: 88 },
  // ★★★ 2026-10-11 新增：**Apple Silicon**（MPS）。型号形如 "Apple M1/M2/M3/M4 [Pro|Max|Ultra]"。
  //   ⚠ 分数要**低于** NVIDIA/AMD 的明确型号规则：装了 eGPU / 或 Intel Mac 上同时报出
  //     独显时，应优先按那张真正在算图的独显处理，而不是把整机当 Apple 核显。
  { id: 'apple', re: /apple\s+m[1-9]|\bm[1-9]\s*(pro|max|ultra)\b|apple.*(gpu|metal)/i, score: 86 },
  { id: 'amd', re: /amd|radeon|ati\b|advanced micro devices/i, score: 60 }, // 含核显
// 设计说明已外置 → docs/config-design-notes.md#config-note-029（原 L1071-1076）
  { id: 'intel_igpu', re: /iris\s*(xe|plus)?\s*(graphics)?|uhd\s*graphics|xe\s*graphics|intel.*integrated|intel.*(uhd|iris)/i, score: 70 },
  { id: 'intel', re: /intel|iris|uhd graphics|xe graphics/i, score: 50 },
]

// 设计说明已外置 → docs/config-design-notes.md#config-note-030（原 L1081-1087）

// 设计说明已外置 → docs/config-design-notes.md#config-note-031（原 L1089-1107）
function macFamilyOf(text) {
  const s = String(text ?? '')
  // Apple Silicon：system_profiler 给 "Chipset Model: Apple M3 Pro"，
  // sysctl 兜底给 "Apple M3 Pro"。`m\d` 覆盖 M1–M9（含尚未发布的代次）。
  if (/apple\s+m\d/i.test(s) || /\bm\d\s*(pro|max|ultra)\b/i.test(s)) return 'apple'
  // 非 Apple Silicon 的 Mac：能不能用 Metal，取决于**有没有 AMD 独显**
  // （Apple 自 2016 起用 AMD 独显；只有 Intel 核显的机型实际上只能跑 CPU）。
  if (/radeon|amd|ati\b|advanced micro devices/i.test(s)) return 'mac_amd'
  if (/intel|iris|uhd graphics|xe graphics/i.test(s)) return 'intel_mac'
// 设计说明已外置 → docs/config-design-notes.md#config-note-032（原 L1117-1124）
  if (/\bmps\b|\bmetal\b/i.test(s)) return 'mac_mps'
  return 'unknown'
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-033（原 L1129-1138）
const MAC_PROFILE_IDS = new Set(['apple', 'mac_amd', 'mac_mps', 'intel_mac'])

function vendorIdOf(text, platform = process.platform) {
  const s = String(text ?? '')
  let best = 'unknown'
  let bestScore = 0
  for (const rule of VENDOR_RULES) {
    if (rule.score > bestScore && rule.re.test(s)) { best = rule.id; bestScore = rule.score }
  }
  // ★ macOS：厂商专用的**计算栈**都不存在，统一收进 Mac 三档（见 macFamilyOf）。
  if (platform === 'darwin') return macFamilyOf(s)
  return best
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-034（原 L1153-1165）
function appleChipOf(text) {
  const s = String(text ?? '')
  const m = /apple\s+(m\d(?:\s+(?:pro|max|ultra))?)/i.exec(s)
    ?? /\b(m\d\s*(?:pro|max|ultra))\b/i.exec(s)
  return m ? m[1].replace(/\s+/gu, ' ').trim() : ''
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-035（原 L1173-1181）

// ===== moved from index.js: GPU_CACHE (was lines 654-667) =====
let GPU_CACHE = null

// 设计说明已外置 → docs/config-design-notes.md#config-note-036（原 L1186-1197）

// ===== moved from index.js: SAGE_READY (was lines 668-677) =====
let SAGE_READY = null

// 设计说明已外置 → docs/config-design-notes.md#config-note-037（原 L1202-1209）

// ===== moved from index.js: nvidiaGenOf (was lines 678-687) =====
function nvidiaGenOf(name) {
  const s = String(name ?? '')
  // ⚠ `(?!\s*ada)` 是必须的：**"RTX 5000 Ada" 是 Ada 架构的专业卡**，不是 Blackwell。
  //   没有这个负向断言时它会被判成 blackwell（实测过），从而给出错误的 sm_120 提示。
  //   注意 "RTX 4000 Ada" 因为 `\bada\b` 能命中，本来就不会误判 —— 5000 是唯一的坑。
  if (/rtx\s?50\d{2}(?!\s*ada)|blackwell/iu.test(s)) return 'blackwell'
  if (/rtx\s?40\d{2}|\bada\b|rtx\s?l40/iu.test(s)) return 'ada'
  return 'other'
}


// ===== moved from index.js: detectGpuProfile (was lines 688-842) =====
async function detectGpuProfile(cfg, log, { force = false, skipOnline = false } = {}) {
  const ttl = 3600000
  if (!force && GPU_CACHE && Date.now() - GPU_CACHE.at < ttl) return GPU_CACHE.profile

  let detected = ''
  let source = ''

  // ★ `skipOnline`：调用方**已经知道 ComfyUI 没在跑**时（典型场景：正要启动它），
  //   就别再去敲 `/system_stats` 白等一次 6 秒超时 —— 那是纯粹的启动延迟。
  if (!skipOnline) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 6000 })
      if (res.ok) {
        const json = await res.json()
        detected = (json?.devices ?? []).map((d) => String(d?.name ?? '')).filter(Boolean).join(' | ')
        if (detected !== '') source = 'ComfyUI'
      }
    } catch {
      /* ComfyUI 没在跑属正常，继续走 WMI */
    }
  }

  if (detected === '') {
    try {
      // ★ 2026-10-11：**三路分派**（原先只有 Windows / Linux 两路 —— macOS 会落到
      //   Linux 那条，而 nvidia-smi / rocm-smi / lspci 在 macOS 上**全都不存在**，
      //   结果就是"探测永远为空 → 一律 unknown"，这就是 macOS 之前没被适配的实际表现）。
      const probeCmd = IS_WINDOWS ? GPU_PROBE_WIN : (IS_MAC ? GPU_PROBE_MAC : GPU_PROBE_LINUX)
      detected = normalizeGpuText(await runShell(probeCmd, 20000))
      if (detected !== '') {
        source = IS_WINDOWS ? 'WMI' : (IS_MAC ? 'system_profiler / sysctl' : '系统命令')
      }
    } catch (error) {
      log?.('warn', `GPU 探测失败：${error?.message ?? error}`)
    }
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-038（原 L1261-1270）
  if (IS_MAC && detected !== '' && macFamilyOf(detected) === 'mac_mps') {
    try {
      const richer = normalizeGpuText(await runShell(GPU_PROBE_MAC, 20000))
      if (richer !== '' && macFamilyOf(richer) !== 'mac_mps' && macFamilyOf(richer) !== 'unknown') {
        detected = `${detected} | ${richer}`
        source = `${source} + system_profiler / sysctl`
        log?.('info', 'macOS：ComfyUI 只报了 "mps"（不含芯片型号），'
          + `已补用平台探测识别为「${richer}」`)
      }
    } catch (error) {
      // 探不到不算失败 —— 会落到 mac_mps 档，照样能走对 Metal/MPS 路径。
      log?.('info', `macOS 平台探测未成功（不影响 Mac 路径）：${error?.message ?? error}`)
    }
  }

  // ★ 2026-10-10：判定抽成 vendorIdOf（与 resolvePlan 的节点门控同源）。
  const best = vendorIdOf(detected)

  const profile = { ...(GPU_PROFILES[best] ?? GPU_PROFILES.unknown), detected, source }

// 设计说明已外置 → docs/config-design-notes.md#config-note-039（原 L1291-1296）
  if (!skipOnline) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 6000 })
      if (res.ok) {
        const json = await res.json()
        const bytes = Number(json?.devices?.[0]?.vram_total ?? 0)
        if (Number.isFinite(bytes) && bytes > 0) {
          profile.vramGB = Math.round((bytes / 1024 ** 3) * 10) / 10
          profile.vramSource = 'ComfyUI /system_stats'
        }
      }
    } catch {
      /* ComfyUI 没在跑 —— 落到下面的 PyTorch 兜底 */
    }
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-040（原 L1313-1322）
  if (!profile.vramGB) {
    const found = await discoverComfyPaths(cfg, log)
    const py = found?.py
    if (py) {
      try {
// 设计说明已外置 → docs/config-design-notes.md#config-note-041（原 L1328-1338）
        const shq = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
        // ★ macOS：没有 CUDA，改用 PyTorch 的 MPS 建议工作集（见常量处的说明）
        const pyProbe = IS_MAC ? GPU_VRAM_PROBE_PY_MAC : GPU_VRAM_PROBE_PY
        // ★ 2026-11-19：Windows 不再拼 `& "py" -c "..."`——py 路径或探针代码含引号时
        //   会被命令行二次解析；直接 argv 执行，环境变量仍走 filteredEnv()。
        const out = IS_WINDOWS
          ? await runPython(py, pyProbe, 30000)
          : String(await runShell(`${shq(py)} -c ${shq(pyProbe)}`, 30000))
// 设计说明已外置 → docs/config-design-notes.md#config-note-042（原 L1346-1352）
        const digits = out.split(/\r?\n/u).map((s) => s.trim()).filter((s) => /^\d+$/u.test(s)).pop()
        const raw = Number(digits)
        const gb = raw / 1024 ** 3
        // 只收"看起来合理"的值（≥ 1 GB）；不合理就留 0，让驻留逻辑不介入。
        if (Number.isFinite(gb) && gb >= 1) {
          profile.vramGB = Math.round(gb * 10) / 10
          profile.vramSource = 'PyTorch total_memory'
        } else {
          log?.('info', `显存探测：PyTorch 输出无法解析（${JSON.stringify(out.slice(0, 120))}）`)
        }
      } catch (error) {
        log?.('warn', `显存探测：PyTorch 调用失败：${String(error?.message ?? error).split('\n')[0]}`)
      }
    } else {
      log?.('info', '显存探测：没找到 ComfyUI 的 python，跳过 PyTorch 探测')
    }
  }

  if (!profile.vramGB && IS_WINDOWS) {
    try {
      const raw = Number(String(await runShell(GPU_VRAM_PROBE_WIN, 15000)).trim())
      const gb = raw / 1024 ** 3
      // ★ 只信任"看起来合理"的值：见 GPU_VRAM_PROBE_WIN 处的实测注释。
      //   4 GB 附近是 32 位字段的截断特征值，不能当真实显存用（会误判成"小显存"）。
      const looksTruncated = gb > 3.9 && gb < 4.2
      if (Number.isFinite(gb) && gb >= 1 && !looksTruncated) {
        profile.vramGB = Math.round(gb * 10) / 10
        profile.vramSource = 'WMI AdapterRAM'
      }
    } catch {
      /* 探测不到就算了 —— 留 0 更安全 */
    }
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-043（原 L1387-1390）
  try {
    const totalRAMGB = Number(os.totalmem()) / 1024 ** 3
    if (Number.isFinite(totalRAMGB) && totalRAMGB >= 1) {
      profile.systemRAMGB = Math.round(totalRAMGB * 10) / 10
    }
  } catch {
    /* 读不到就留空 —— 比瞎猜一个数安全 */
  }

  GPU_CACHE = { at: Date.now(), profile }
  if (log) {
    log('info', `GPU 判定：${profile.label}｜探测到「${detected || '未知'}」（来源：${source || '无'}）`)
    log('info', `该厂商专用调优：${profile.tuning}`)
    if (profile.vramGB) log('info', `显存总量：${profile.vramGB} GB（来源：${profile.vramSource}）`)
    if (profile.systemRAMGB) log('info', `整机内存：${profile.systemRAMGB} GB`)
  }
  return profile
}

/**
 * 厂商专属加速包白名单。
 *
 * ⚠ 只放**来源明确、作者可查**的包；每一项都标了 `verified`：
 *   `verified: true`  = 在作者本机实测过
 *   `verified: false` = 方案真实存在、但**未在当前硬件上实测**（换硬件请自行确认）
 * 绝不自动安装白名单之外的东西。
 */

// ===== moved from index.js: ACCEL_PACKS (was lines 843-954) =====
const ACCEL_PACKS = {
// 设计说明已外置 → docs/config-design-notes.md#config-note-044（原 L1421-1425）
  sageattention: {
    id: 'sageattention',
    name: 'SageAttention',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/thu-ml/SageAttention',
    package: 'sageattention',
    pythonModule: 'sageattention',
    os: ['win32', 'linux'],
    requires: 'NVIDIA + Triton',
    why: 'INT8 量化注意力内核。近两年扩散模型圈子里最主流的 N 卡注意力加速方案，'
      + '对 DiT 类模型（含 Qwen-Image）普遍有可观增益。',
    verified: false,
  },
  /**
   * ★ 2026-10-09 新增（按需求方要求补充 N 卡方案，保守起见只收社区公认、来源明确的）。
   *   注意定位：它是**前置组件**而不是加速本身 —— SageAttention 等一堆
   *   Triton 内核在 Windows 上都需要它。装了 Triton 的机器上会直接判定为已就位。
   */
  'triton-windows': {
    id: 'triton-windows',
    name: 'Triton for Windows',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/woct0rdho/triton-windows',
    package: 'triton-windows',
    pythonModule: 'triton',
    // ★ 只给 Windows：Linux 上 Triton 有官方 wheel（走下面的 `triton` 条目），
    //   装 triton-windows 反而会顶掉官方构建。
    os: ['win32'],
    requires: 'Windows + 对应版本的 PyTorch',
    why: 'Windows 上的 Triton 构建。官方 Triton 长期没有 Windows 轮子，而 SageAttention '
      + '等一批加速内核都依赖它 —— 是这些方案能装上的前置条件。',
    verified: false,
  },
  /**
   * ★ Linux 侧与 `triton-windows` **平行**的条目 —— 这就是"两套方案"的落点：
   *   同一个能力（Triton），Windows 上必须装第三方构建，Linux 上装官方包即可。
   *   多数 Linux 机器上它会直接探测为"已装"（通常随 PyTorch 一同带入）。
   */
  triton: {
    id: 'triton',
    name: 'Triton（官方构建）',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/triton-lang/triton',
    package: 'triton',
    pythonModule: 'triton',
    os: ['linux', 'darwin'],
    requires: 'Linux + 对应版本 PyTorch（通常已随 torch 安装）',
    why: 'Linux 上 Triton 的官方发行版，SageAttention 等加速内核的前置依赖。',
    verified: false,
  },
  /**
   * ★ 2026-10-09 新增：SVDQuant 4-bit 量化推理，DiT 模型上的社区热门方案。
   *
   * ⚠ **属进阶项**，不是"装上就变快"：需要先把模型转成它自己的 4-bit 格式，
   *   且对 PyTorch / CUDA 版本较敏感。放在白名单里供有需要的人按需安装，
   *   **不作为默认推荐**。
   */
  nunchaku: {
    id: 'nunchaku',
    name: 'Nunchaku（SVDQuant 4-bit）',
    vendor: 'nvidia',
    kind: 'pip',
    repo: 'https://github.com/nunchaku-tech/nunchaku',
    package: 'nunchaku',
    pythonModule: 'nunchaku',
    os: ['win32', 'linux'],
    requires: 'NVIDIA（较新架构）+ 匹配的 PyTorch/CUDA + 已转换的 4-bit 模型',
    why: 'SVDQuant 4-bit 量化推理，显著降低显存占用并提速。⚠ 需先把模型转换成其专用格式，'
      + '属进阶方案，未在本机验证。',
    verified: false,
  },
  ipex: {
    id: 'ipex',
    name: 'Intel Extension for PyTorch (IPEX)',
    vendor: 'intel',
    kind: 'pip',
    repo: 'https://github.com/intel/intel-extension-for-pytorch',
    package: 'intel-extension-for-pytorch',
    pythonModule: 'intel_extension_for_pytorch',
    os: ['win32', 'linux'],
// 设计说明已外置 → docs/config-design-notes.md#config-note-045（原 L1509-1515）
    requires: 'Intel Arc / XPU + 对应版本 PyTorch（包版本带 +xpu 后缀）',
    why: 'XPU 后端支持与算子优化。⚠ 版本号必须与已装 PyTorch 对齐，否则装不上。',
    verified: false,
  },
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-046（原 L1522-1531）

// ===== moved from index.js: PIP_MIRRORS (was lines 982-988) =====
const PIP_MIRRORS = [
  { label: '清华 TUNA', index: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { label: '阿里云', index: 'https://mirrors.aliyun.com/pypi/simple/' },
  { label: '腾讯云', index: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
]

/** 生成一个 pip 包的多套下载方案：官方源 → 三个国内镜像 → GitHub 源码直装。 */

// ===== moved from index.js: pipSources (was lines 989-1000) =====
function pipSources(pkg, { extraIndex, git } = {}) {
  // 标签里点明"含扩展索引"，否则像 IPEX 这种主包只在 Intel 索引上的会看不出来
  const suffix = extraIndex ? '（含 Intel 扩展索引）' : ''
  const sources = [{ label: `PyPI 官方源${suffix}`, pip: pkg, extraIndex }]
  for (const mirror of PIP_MIRRORS) {
    sources.push({ label: `镜像：${mirror.label}${suffix}`, pip: pkg, extraIndex, index: mirror.index })
  }
  if (git) sources.push({ label: 'GitHub 源码直装', pipGit: git })
  return sources
}

/** 各加速包的下载方案表（与 ACCEL_PACKS 一一对应）。 */

// ===== moved from index.js: ACCEL_SOURCES (was lines 1001-1031) =====
const ACCEL_SOURCES = {
  sageattention: pipSources('sageattention', {
    git: 'git+https://github.com/thu-ml/SageAttention.git',
  }),
  triton: pipSources('triton', {
    git: 'git+https://github.com/triton-lang/triton.git',
  }),
  'triton-windows': pipSources('triton-windows', {
    git: 'git+https://github.com/woct0rdho/triton-windows.git',
  }),
  nunchaku: pipSources('nunchaku', {
    git: 'git+https://github.com/nunchaku-tech/nunchaku.git',
  }),
  // ★ IPEX 特殊：它在 Intel 自己的索引上，PyPI 和国内镜像都没有。
  //   所以"官方索引"那一套是主方案，镜像套只是**顺带指定一个更快的 PyPI 镜像**
  //   给它的依赖用（依赖大多在 PyPI 上）。
  ipex: pipSources('intel-extension-for-pytorch', {
    extraIndex: 'https://pytorch-extension.intel.com/release-whl/stable/xpu/us/',
    git: 'git+https://github.com/intel/intel-extension-for-pytorch.git',
  }),
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-047（原 L1579-1587）

// ===== moved from index.js: genericOptimizations (was lines 1131-1175) =====
function shouldProbe(args) {
  // 有参考图（单图 `reference` 或多图 `references` 任一非空）就跳过一次探活：
  // 图能上传说明后端必然在跑，那 8 秒的"连不上"超时是白等的。
  const hasSingle = typeof args?.reference === 'string' && args.reference.trim() !== ''
  const hasMulti = Array.isArray(args?.references) && args.references.some((r) => typeof r === 'string' && r.trim() !== '')
  return !(hasSingle || hasMulti)
}

/**
 * ★★ 2026-10-08 新增：把 draw_image 的参数折算成「本次要提交的工作流」。
 *
 * 纯函数（不联网、不开 ComfyUI），自测靠它断言工作流长什么样。
 * ⚠ 这里**必须**与 execute 里的折算保持一致 —— 两处不一致就会"测试绿、实际错"。
 */

// 设计说明已外置 → docs/config-design-notes.md#config-note-048（原 L1605-1613）
function planAspectOf(args, cfg) {
  const explicitSize = typeof args?.size === 'string' && ASPECTS[args.size]
  if (explicitSize) return args.size
  const preset = typeof args?.preset === 'string' && args.preset !== ''
    ? args.preset
    : (cfg && typeof cfg.preset === 'string' && cfg.preset !== '' && cfg.preset !== 'default' ? cfg.preset : null)
  return presetAspect(preset) || '1:1'
}

function planWorkflow(cfg, args, caps) {
  const aspect = planAspectOf(args, cfg)
  const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0 ? args.megapixels : 1.0
  // ★ 同上：**不回落到 cfg.steps**（理由见 execute 里的注释），没传就是 undefined。
  const steps = Number.isFinite(args?.steps) ? Math.trunc(args.steps) : undefined
  const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : 0
  // ★ 提速 M4：与 execute 保持一致（默认 1）。
  const count = Number.isFinite(args?.count) ? Math.max(1, Math.min(4, Math.trunc(args.count))) : 1
  const [width, height] = calcSize(aspect, megapixels)
  const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
  // ★ 2026-11-09（issue #1）：不再截断到 3 张 —— 节点侧有 image_1…image_16。
  const references = (Array.isArray(args?.references) ? args.references : [])
    .filter((r) => typeof r === 'string' && r.trim() !== '')
  return buildWorkflow(cfg, {
    prompt: String(args?.prompt ?? ''),
    negative: args?.negative,
    width,
    height,
    steps,
    seed,
    reference: refPath,
    references,
    count,
  }, caps)
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-049（原 L1649-1714）

// ===== moved from index.js: trimPrompt (was lines 2522-2552) =====
function trimPrompt(text, cfg) {
  let s = String(text ?? '')
  if (cfg.promptTrimEnabled === false) return s
  s = s.replace(/\s+/gu, ' ').trim()
  s = s.replace(/([,，.。;；:：!！?？])(?:\s*\1)+/gu, '$1')
  s = s.replace(/[\s,，.。;；:：]+$/gu, '')
  const cap = Number(cfg.maxPromptChars)
  if (Number.isFinite(cap) && cap > 0 && s.length > cap) s = s.slice(0, cap)
  return s
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-050（原 L1728-1747）

// ===== moved from index.js: pickWrapperSet (was lines 2553-2593) =====
function pickWrapperSet(cfg, plan, width, height, caps) {
  const tokens = Math.max(1, Math.round(Number(width || 0) / 8)) * Math.max(1, Math.round(Number(height || 0) / 8))
  const policy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'

  // ★ 节点可用性一律**直接看 caps**（能力探测结果），不看 plan.useTe / useSpeedup ——
  //   那两个是"互斥之后"的结果：一旦 BlockCache 开着它们就恒为 false，
  //   拿它们当"节点在不在"会得出"TE 不可用"的错误结论，小尺寸就永远退回空链了。
  //   caps 不传 = 老行为（当作能力齐全）。
  const has = (key) => caps === undefined || caps === null || caps?.nodes?.[key] === true
  const bcAvailable = has('blockCache') && cfg.blockCacheEnabled !== false
  const distilled = plan.useTurbo === true || plan.useOfficialTurbo === true
  const teAvailable = has('teSpeed') && cfg.teSpeedEnabled !== false && distilled
  const speedupAvailable = has('speedup') && cfg.speedupEnabled !== false && distilled

  let wantBc
  let reason
  if (policy === 'bc') {
    wantBc = true
    reason = '固定走 BlockCache T8（wrapperPolicy=bc）'
  } else if (policy === 'te') {
    wantBc = false
    reason = '固定走 TE-Speed + Speedup（wrapperPolicy=te）'
  } else {
    const threshold = Number.isFinite(cfg.wrapperAutoTokensThreshold) && cfg.wrapperAutoTokensThreshold > 0
      ? cfg.wrapperAutoTokensThreshold : 16384
    wantBc = tokens > threshold
    reason = wantBc
      ? `大尺寸（${tokens} tokens > ${threshold}）→ BlockCache T8：TE-Speed 在这个尺寸实测 0% 加速，BlockCache 实测 +22.7%`
      : `小尺寸（${tokens} tokens ≤ ${threshold}）→ TE-Speed + Speedup：模型能常驻，实测 +25.4%`
  }

  // ★ 互斥硬保证：想上 BC 但 BC 不可用 → 退回 TE+Speedup（而不是两个都上）
  if (wantBc && !bcAvailable) {
    return { te: teAvailable, speedup: speedupAvailable, blockCache: false, tokens,
      reason: `想用 BlockCache T8 但不可用（节点没装或被 blockCacheEnabled=false 关掉）→ 退回 TE-Speed + Speedup` }
  }
  if (wantBc) {
    return { te: false, speedup: false, blockCache: true, tokens, reason }
  }
  return { te: teAvailable, speedup: speedupAvailable, blockCache: false, tokens, reason }
}


const {
  buildOfficialTurboWorkflow,
  buildTaskWorkflow,
  buildDistilledModelChain,
} = createTurboWorkflowBuilders({ resolvePlan, pickWrapperSet, trimPrompt })

// 设计说明已外置 → docs/config-design-notes.md#config-note-051（原 L1799-1810）
export function applyFilePrefixTemplate(template, { model = '' } = {}) {
  const t = String(template ?? '').trim()
  if (t === '') return ''
  const date = new Date().toISOString().slice(0, 10)
  const safeModel = String(model).replace(/[^\w.-]+/gu, '_').replace(/^[-.]+|[-.]+$/gu, '').slice(0, 64)
  let out = t.replaceAll('{date}', date).replaceAll('{model}', safeModel || 'model')
  if (out.includes('..') || /^[A-Za-z]:/u.test(out) || /[\\/]/u.test(out[0]) || out.includes('\\')) return ''
  out = out.replace(/[^\w\-/. ]+/gu, '_').replace(/\/{2,}/gu, '/')
  return out.trim()
}

/** 主链 SaveImage 前缀：模板未配置时保持历史默认 'dsh-qwen-paint'。 */
export function imageSavePrefix(cfg, plan) {
  const base = applyFilePrefixTemplate(cfg?.filePrefixTemplate, { model: plan?.models?.unet ?? '' })
  return base !== '' ? base : 'dsh-qwen-paint'
}

function buildWorkflow(cfg, { prompt, negative, width, height, steps, seed, reference, references, count, controlImage, controlStack, cfgOverride }, caps) {
  // 0.18：`references` 是新入口；`reference` 保留为单图兼容写法。
  const refList = (Array.isArray(references) ? references : [])
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => r.trim())
  // 超过 16 张要在组装之前就炸 —— 否则会生成 image_17… 这类节点根本没有的槽位，
  // ComfyUI 只会回"节点输入校验失败"，用户根本看不出是张数超了。
  assertReferenceCount(refList)
  if (refList.length === 0 && typeof reference === 'string' && reference.trim() !== '') {
    refList.push(reference.trim())
  }
  const withRef = refList.length > 0
  const primaryReference = refList[0] ?? ''
  // ★ 2026-10-10（提速 M4）：一次出几张。**默认 1**（守住"每次只生一张"的既定要求），
  //   只有调用方显式传 count 2-4 时才批量。批量只在**文生图**生效（EmptyLatentImage.batch_size）——
  //   图生图的 latent 来自参考图，批量需要另加 RepeatLatentBatch，本次不做，按 1 张处理。
  const batchCount = Number.isFinite(count) ? Math.max(1, Math.min(4, Math.trunc(count))) : 1
  // ★ 2026-10-09（通用化）：按**探测到的真实能力**折算本次链路。
  //   caps 不传 = 当作能力齐全 → 保持"默认全栈"的老行为（自测直接调本函数即此情形）。
  const plan = resolvePlan(cfg, caps)

// 设计说明已外置 → docs/config-design-notes.md#config-note-052（原 L1849-1852）
  const lockSize = cfg.forceOptimizedSize !== false
  const OPT_SIZE = Number.isFinite(cfg.optimizedSize) && cfg.optimizedSize >= 32
    ? r32(cfg.optimizedSize)
    : (Number.isFinite(cfg.resolution) && cfg.resolution >= 32 ? r32(cfg.resolution) : 1024)
  const effWidth = (!withRef && lockSize)
    ? OPT_SIZE
    : (Number.isFinite(width) && width > 0 ? r32(width) : OPT_SIZE)
  const effHeight = (!withRef && lockSize)
    ? OPT_SIZE
    : (Number.isFinite(height) && height > 0 ? r32(height) : OPT_SIZE)

  // 0.18：官方 Turbo 的精确 sigma 走独立图；ControlNet 仍留在旧图（官方图未接 ControlNet）。
  const cnetRequested = typeof controlImage === 'string' && controlImage.trim() !== ''
  if (plan.useOfficialTurbo && !cnetRequested) {
    return buildOfficialTurboWorkflow(cfg, plan, {
      prompt,
      negative,
      width: effWidth,
      height: effHeight,
      seed,
      count: batchCount,
      references: refList,
    }, caps)
  }

  // ★ 2026-10-09：模型文件名与链路开关**全部来自 plan**（探测结果），不再写死。
  const turboLora = plan.models.turbo8Lora
  const withTurbo = plan.useTurbo
  const withPrefix = plan.usePrefix

// 设计说明已外置 → docs/config-design-notes.md#config-note-053（原 L1883-1893）
  const wrapperPick = pickWrapperSet(cfg, plan, effWidth, effHeight, caps)
  const withTe = wrapperPick.te
  const withSpeedup = wrapperPick.speedup
// 设计说明已外置 → docs/config-design-notes.md#config-note-054（原 L1897-1923）
  const withBlockCache = wrapperPick.blockCache === true
  const nodeAfterUnet0 = '1'
  const nodeAfterBlockCache = withBlockCache ? '16' : nodeAfterUnet0

  // 模型链末端逐级推进 —— 每一环都是"可选依赖"，探测不到就跳过：
  //   1(UNET) → [16 BlockCache] → [11 LoRA] → [12 采样位移] → [7 前缀缓存] → [13 TE] → [14 Speedup] → KSampler
  const nodeAfterUnet = nodeAfterBlockCache
  const nodeAfterTurbo = withTurbo ? '12' : nodeAfterUnet
  const nodeAfterCache = withPrefix ? '7' : nodeAfterTurbo
  const nodeAfterTe = withTe ? '13' : nodeAfterCache
  const nodeAfterSpeedup = withSpeedup ? '14' : nodeAfterTe
  // ★★★ 2026-10-10：RDNA3 FlashAttention（无损）放**模型链最末端** ——
  //   它 patch 的是 model_options 里的 attention override，必须让 KSampler
  //   最终拿到的那个 model 带上它；放最后最稳（前面的 wrapper 不会再覆盖它）。
  const withRdna3Fa = plan.useRdna3Fa === true
  const nodeAfterFa = withRdna3Fa ? '17' : nodeAfterSpeedup
// 设计说明已外置 → docs/config-design-notes.md#config-note-055（原 L1940-1945）
  const withSpectrum = plan.useSpectrum === true
  const nodeAfterSpectrum = withSpectrum ? '18' : nodeAfterFa
  // ★★★ 2026-10-12 新增（用户要求）：**SADA 跳步采样** —— 与 Spectrum 同源但走新分布。
  //   位置：模型链最末端（Spectrum 之后、KSampler 之前）。
  //   探测 + 默认关 由 resolvePlan 完成；这里只读 `plan.useSada`。
  const withSada = plan.useSada === true
  const nodeAfterSada = withSada ? '19' : nodeAfterSpectrum
  // ★ 2026-11-17：EasyCache（ComfyUI 核心内置实验节点，步级复用）——默认关。
  //   `resolvePlan` 已做可用性闸（探测到节点 + easyCacheEnabled=true）；这里只读 plan.useEasyCache。
  //   插在 SADA 之后、attention 之前；节点号 20-22/30-41 被 ControlNet 占用，故用 42。
  const withEasyCache = plan.useEasyCache === true
  const nodeAfterEasyCache = withEasyCache ? '42' : nodeAfterSada
  // ★ 2026-11-15：注意力 / 编译加速后端（SageAttention / Comfy-WaveSpeed）接进模型链末端。
  //   默认关：cfg.attentionBackend 为空 ⇒ nodes:[] ⇒ withAttention=false ⇒
  //   modelRef 与改动前逐字节相同，既有生成路径零变化。
  //   类名只来自真实 /object_info 模式发现；槽位未核实只写宿主已声明的，标 unverified。
  const attentionPlan = buildAttentionWorkflowPatch({
    installed: caps?.nodes ?? {},
    kind: 'image',
    enabled: cfg.attentionBackend,
    acceptedInputs: cfg.attentionAcceptedInputs,
    extraInputs: cfg.attentionInputs,
  })
  const withAttention = attentionPlan.nodes.length > 0
  const modelRef = withAttention ? '43' : nodeAfterEasyCache

  // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码**（防 OOM）。
  //   判据 = resolvePlan 的**可用性闸**（节点在 + 档位/显存）**且**这里的**尺寸闸**。
  //   为什么尺寸闸只能放这里：只有这里才知道**生效尺寸**
  //   （`forceOptimizedSize` 可能把尺寸锁成 OPT_SIZE，effWidth/effHeight 才是真值）。
  const vaePixels = Math.max(1, effWidth) * Math.max(1, effHeight)
  const useTiledDecode = plan.useVaeTiling === true
    && (plan.vaeTilingMode === 'on' || vaePixels > 1024 * 1024)

  const workflow = {
    1: unetLoaderNode(plan.models.unet),
    2: { class_type: 'CLIPLoader', inputs: { clip_name: plan.models.clip, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: plan.models.vae } },
    5: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        // ★ prompt 精简（无损清理 + 可选硬截断），依据见 trimPrompt 的注释
        prompt: trimPrompt(prompt, cfg),
        negative_prompt: negative ?? '',
        resolution: withRef ? Math.round(Math.sqrt(effWidth * effHeight)) : OPT_SIZE,
      },
    },

    // ---- 加速链（★ 2026-10-09：每一环都由**探测结果**决定接不接）--------------
    //   关闭时置 undefined，最后统一 delete —— 绝不能留一个"无 class_type 的空节点"
    //   （ComfyUI 会当成节点校验失败，整单拒收，而不是忽略）。
    11: withTurbo ? loraNode(nodeAfterUnet, turboLora, cfg.turbo8Strength) : undefined,
    12: withTurbo ? fluxShiftNode(plan, '11', effWidth, effHeight) : undefined,
    7: withPrefix ? prefixCacheNode(cfg, nodeAfterTurbo) : undefined,
    13: withTe ? teSpeedNode(cfg, nodeAfterCache) : undefined,

    9: useTiledDecode
      ? {
        // ★ 2026-10-12：**分块解码**（ComfyUI 自带节点，零新增依赖）——
        //   防的是"Qwen VAE 内部跑 fp32、大图整图解码显存峰值失控"（见 DEFAULTS.vaeTiling）。
        //   tile/overlap 都可由配置覆盖；temporal_* 对 2D 图无意义，保留官方默认值。
        class_type: 'VAEDecodeTiled',
        inputs: {
          samples: ['8', 0],
          vae: ['3', 0],
          tile_size: Number.isFinite(cfg.vaeTileSize) ? Math.trunc(cfg.vaeTileSize) : 512,
          overlap: Number.isFinite(cfg.vaeTileOverlap) ? Math.trunc(cfg.vaeTileOverlap) : 64,
          temporal_size: 64,
          temporal_overlap: 8,
        },
      }
      : { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: imageSavePrefix(cfg, plan) } },

// 设计说明已外置 → docs/config-design-notes.md#config-note-056（原 L2021-2026）
    14: withSpeedup ? speedupNode(cfg, nodeAfterTe) : undefined,
    // BlockCache / FA 都是插件节点：没装时整单会被拒收，由 withX 开关控制。
    16: withBlockCache ? blockCacheNode(cfg, nodeAfterUnet0) : undefined,
    17: withRdna3Fa ? rdna3FaNode(nodeAfterSpeedup) : undefined,

// 设计说明已外置 → docs/config-design-notes.md#config-note-057（原 L2032-2039）
    18: withSpectrum
      ? {
        class_type: SPECTRUM_NODE,
        inputs: {
          model: [nodeAfterFa, 0],
          warmup_steps: Number.isFinite(cfg.spectrumWarmupSteps) ? Math.trunc(cfg.spectrumWarmupSteps) : 5,
          tail_actual_steps: Number.isFinite(cfg.spectrumTailActualSteps) ? Math.trunc(cfg.spectrumTailActualSteps) : 2,
          history_points: Number.isFinite(cfg.spectrumHistoryPoints) ? Math.trunc(cfg.spectrumHistoryPoints) : 5,
          chebyshev_degree: Number.isFinite(cfg.spectrumChebyshevDegree) ? Math.trunc(cfg.spectrumChebyshevDegree) : 3,
          max_consecutive_forecasts: Number.isFinite(cfg.spectrumMaxConsecutiveForecasts) ? Math.trunc(cfg.spectrumMaxConsecutiveForecasts) : 1,
          ridge_lambda: Number.isFinite(cfg.spectrumRidgeLambda) ? cfg.spectrumRidgeLambda : 1e-4,
          cache_device: cfg.spectrumCacheDevice ?? 'main_device',
          // 有 ControlNet / control 残差时强制走真实前向 —— 节点默认 true，照抄（更稳）
          force_actual_on_control: true,
          debug: cfg.spectrumDebug === true,
        },
      }
      : undefined,

// 设计说明已外置 → docs/config-design-notes.md#config-note-058（原 L2059-2065）
    19: withSada
      ? {
        class_type: cfg.sadaNodeClass || SADA_NODE_DEFAULT,
        inputs: {
          model: [nodeAfterSpectrum, 0],
          // 与 Spectrum 同源约定：给 SADA 一个"步数预算"让它在范围内跳步
          steps: Number.isFinite(cfg.sadaMaxSteps) && cfg.sadaMaxSteps > 0
            ? Math.trunc(cfg.sadaMaxSteps)
            : (plan.steps ?? 8),
          threshold: Number.isFinite(cfg.sadaThreshold) ? cfg.sadaThreshold : 0.15,
          patch_sampler: cfg.sadaPatchSampler !== false,
        },
      }
      : undefined,

    // 2026-11-17：EasyCache（本机核心实验节点，步级复用）；默认关 → 整段 delete。
    42: withEasyCache ? easyCacheNode(cfg, nodeAfterSada) : undefined,

    // 设计说明已外置 → docs/config-design-notes.md#config-note-044（attention 槽位 43 的防撞号缘由）
    43: withAttention
      ? {
        class_type: attentionPlan.nodes[0].class_type,
        inputs: {
          ...attentionPlan.nodes[0].inputs,
          model: [nodeAfterEasyCache, 0],
        },
      }
      : undefined,
  }

  // `7` / `11` / `12` / `13` / `14` / `16` / `17` / `18` / `19` / `42` / `43` 在关闭时都是 undefined ——
  // 统一删掉，否则 ComfyUI 会把它当成一个"没有 class_type 的节点"直接报校验错（而不是忽略它）。
  for (const id of [7, 11, 12, 13, 14, 16, 17, 18, 19, 42, 43]) {
    if (workflow[id] === undefined) delete workflow[id]
  }

  if (withRef) {
// 设计说明已外置 → docs/config-design-notes.md#config-note-059（原 L2105-2109）
    workflow[4] = { class_type: 'LoadImage', inputs: { image: primaryReference } }
    refList.forEach((file, i) => {
      if (i > 0) workflow[30 + i - 1] = { class_type: 'LoadImage', inputs: { image: file } }
    })
    workflow[5].inputs.vae = ['3', 0]
    refList.forEach((_file, i) => {
      workflow[5].inputs[`images.image_${i + 1}`] = [String(i === 0 ? 4 : 30 + i - 1), 0]
    })
  } else {
    // ★ 提速 M4：batch_size = batchCount（默认 1）。一次提交出 N 张只装卸一次模型。
    workflow[6] = { class_type: 'EmptyLatentImage', inputs: { width: effWidth, height: effHeight, batch_size: batchCount } }
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-060（原 L2123-2132）
  const explicitSteps = Number.isFinite(steps) ? Math.trunc(steps) : undefined
  const effSteps = plan.useFast4
    // ★ 2026-10-12：极速档（4 步）—— 步数由**档位**定，不受 turbo8 的 8 步锁影响。
    //   否则"锁 8 步"会把 4 步档又拉回 8 步，开关看起来生效、实际没生效。
    ? plan.steps
    : (withTurbo
      ? (cfg.forceTurbo8Steps !== false
        ? TURBO8_STEPS
        : (explicitSteps
          ?? (Number.isFinite(cfg.turbo8Steps) && cfg.turbo8Steps > 0 ? Math.trunc(cfg.turbo8Steps) : TURBO8_STEPS)))
      : (explicitSteps ?? plan.steps))

  // ★ CFG：有 turbo8 时必须 1.0（八步蒸馏 LoRA 在 >1 的 CFG 下会过曝/崩边，
  //   也是 TE-Speed 作者 2026-10-07 那版专门去修的问题）；
  //   没有 turbo8（原生链）时用千问原生工作点 2.5。
  //   ★ 0.19.2：面板/工具拨了 cfg 时，在非蒸馏链上才覆盖（蒸馏链强制回 1，无视覆盖）。
  const effCfg = withTurbo
    ? 1.0
    : (Number.isFinite(cfgOverride) ? cfgOverride : plan.cfgScale)

  workflow[8] = {
    class_type: 'KSampler',
    inputs: {
      // ★ 模型链末端：14(Speedup) → 13(TE) → 7(前缀缓存)，按开关逐级回落
      model: [modelRef, 0],
      seed,
      steps: Math.max(1, Math.min(60, effSteps)),
      cfg: effCfg,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['5', 0],
      negative: ['5', 1],
      latent_image: withRef ? ['5', 2] : ['6', 0],
      denoise: 1.0,
    },
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-061（原 L2170-2189）
  const cnetNodesOk = caps === undefined || caps === null
    ? true // caps 缺省（自测 / planWorkflow）→ 不拦，保持既有"能力齐全"语义
    : (caps?.nodes?.cnetLoader === true && caps?.nodes?.cnetApply === true)
  const cnetName = String(plan.models?.controlnet ?? '')
  const cnetImage = typeof controlImage === 'string' ? controlImage.trim() : ''
  const withCnet = cnetName !== '' && cnetImage !== '' && cnetNodesOk
  let cnetReason = ''
  if (withCnet) {
    workflow[20] = { class_type: 'LoadImage', inputs: { image: cnetImage } }
    workflow[21] = { class_type: 'ControlNetLoader', inputs: { control_net_name: cnetName } }
    workflow[22] = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: ['5', 0],
        negative: ['5', 1],
        control_net: ['21', 0],
        image: ['20', 0],
        strength: Number.isFinite(cfg.controlnetStrength) ? cfg.controlnetStrength : 0.8,
        start_percent: Number.isFinite(cfg.controlnetStartPercent) ? cfg.controlnetStartPercent : 0.0,
        end_percent: Number.isFinite(cfg.controlnetEndPercent) ? cfg.controlnetEndPercent : 1.0,
      },
    }
    workflow[8].inputs.positive = ['22', 0]
    workflow[8].inputs.negative = ['22', 1]
  } else if (cnetName !== '' || cnetImage !== '') {
    // 想用但没接上 —— 记原因（供工具返回值如实说明，不静默）
    if (!cnetNodesOk) cnetReason = '缺 ControlNetLoader / ControlNetApplyAdvanced 节点'
    else if (cnetName === '') cnetReason = '没选 ControlNet 权重'
    else cnetReason = '没提供控制图'
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-062（原 L2221-2231）
  const stackInput = Array.isArray(controlStack) ? controlStack : []
  const stackNotes = []
  if (stackInput.length > 4) {
    stackNotes.push('controlStack 最多 4 路，本次给了 ' + stackInput.length + ' 路，超出部分不接')
  }
  let chainTail = withCnet ? '22' : '' // 单路已接 → 从它继续串；未接 → 从 5（文本编码）起
  let stackApplied = 0
  if (stackInput.length > 0 && cnetNodesOk) {
    for (let i = 0; i < Math.min(4, stackInput.length); i += 1) {
      const item = stackInput[i] ?? {}
      const imageName = typeof item.image === 'string' ? item.image.trim() : ''
      const weightName = typeof item.name === 'string' ? item.name.trim() : ''
      if (imageName === '' || weightName === '') {
        stackNotes.push(`第 ${i + 2} 路未接：${imageName === '' ? '没有控制图' : '没有选择权重'}`)
        continue
      }
      const loadId = 30 + i * 3
      const loaderId = loadId + 1
      const applyId = loadId + 2
      const prev = chainTail === '' ? ['5', 0] : [chainTail, 0]
      const prevNeg = chainTail === '' ? ['5', 1] : [chainTail, 1]
      workflow[loadId] = { class_type: 'LoadImage', inputs: { image: imageName } }
      workflow[loaderId] = { class_type: 'ControlNetLoader', inputs: { control_net_name: weightName } }
      workflow[applyId] = {
        class_type: 'ControlNetApplyAdvanced',
        inputs: {
          positive: prev,
          negative: prevNeg,
          control_net: [String(loaderId), 0],
          image: [String(loadId), 0],
          strength: Number.isFinite(item.strength) ? item.strength
            : (Number.isFinite(cfg.controlnetStrength) ? cfg.controlnetStrength : 0.8),
          start_percent: Number.isFinite(item.startPercent) ? item.startPercent
            : (Number.isFinite(cfg.controlnetStartPercent) ? cfg.controlnetStartPercent : 0.0),
          end_percent: Number.isFinite(item.endPercent) ? item.endPercent
            : (Number.isFinite(cfg.controlnetEndPercent) ? cfg.controlnetEndPercent : 1.0),
        },
      }
      chainTail = String(applyId)
      stackApplied += 1
    }
    if (chainTail !== '') {
      workflow[8].inputs.positive = [chainTail, 0]
      workflow[8].inputs.negative = [chainTail, 1]
    }
  } else if (stackInput.length > 0 && !cnetNodesOk) {
    stackNotes.push('多 ControlNet 未接：缺 ControlNetLoader / ControlNetApplyAdvanced 节点')
  }

  // ★★ B5：构建生图图 = 马上要用生图主模型。这里先**问一句账本**再记账，
  //   把「上一轮驻留的是谁、这轮要不要换」挂到元信息上，供上层决定是否提示用户。
  //   ⚠ 纯记账：失败绝不影响建图（catch 吞掉，不往外抛）。
  let residency = { hit: false, load: true, unload: [], reason: '' }
  try {
    residency = sessionResidency.plan(RESIDENCY_KEYS.image)
    sessionResidency.touch(RESIDENCY_KEYS.image)
  } catch { /* 记账是附加信息，不是前置条件 */ }

  // 元信息统一走 workflow-meta.js：不可枚举，不会混进 ComfyUI 载荷。
  return attachWorkflowMeta(workflow, {
    // B5：上一轮若驻留的是别的模型（视频/超分），这次首张会重载主模型
    __residency: {
      key: RESIDENCY_KEYS.image,
      switch_from: Array.isArray(residency?.unload) ? residency.unload : [],
      reload: residency?.load === true && Array.isArray(residency?.unload) && residency.unload.length > 0,
    },
    __effective: { width: effWidth, height: effHeight, locked: !withRef && lockSize },
    __plan: {
      profile: plan.samplingProfile,
      steps: effSteps,
      cfg: effCfg,
      references: refList.length,
    },
    __cnet: {
      applied: withCnet, name: cnetName, reason: cnetReason,
      // ★ 2026-11-17（H1）：多路叠加的如实元信息 —— 接了几路、哪几路没接及原因。
      //   stackApplied 不含单路；链里总路数 = (withCnet ? 1 : 0) + stackApplied。
      stackApplied, stackTotal: stackInput.length, stackNotes,
    },
  })
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-063（原 L2314-2324）

// ===== moved from index.js: probeReadiness (was lines 2957-2971) =====
async function probeReadiness(cfg, signal) {
  const unknown = { online: false, busy: false, running: 0, pending: 0 }
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 4000, signal })
    // 401/403 之类也算"通了"——有东西在听这个端口就够了
    if (!res.ok) return { ...unknown, online: true }
    const data = await res.json()
    const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0
    const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
    return { online: true, busy: running + pending > 0, running, pending }
  } catch {
    return unknown
  }
}


// ===== moved from index.js: MODEL_NODES (was lines 3150-3158) =====
const MODEL_NODES = [
  { type: 'UNETLoader', field: 'unet_name', label: 'UNET / 千问主模型' },
  { type: 'CLIPLoader', field: 'clip_name', label: 'CLIP / 文本编码器' },
  { type: 'VAELoader', field: 'vae_name', label: 'VAE' },
  { type: 'LoraLoader', field: 'lora_name', label: 'LoRA' },
  { type: 'CheckpointLoader', field: 'ckpt_name', label: 'Checkpoint' },
  { type: 'CheckpointLoaderSimple', field: 'ckpt_name', label: 'Checkpoint(简单)' },
]


// ===== moved from index.js: listComfyModels (was lines 3159-3183) =====
async function listComfyModels(cfg, log, signal) {
  const models = {}
  for (const { type, field, label } of MODEL_NODES) {
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/object_info/${type}`, { timeoutMs: 15000, signal })
      if (!res.ok) { models[label] = null; continue }
      const j = await res.json()
      const node = j?.[type]
      const spec = node?.input?.required?.[field] ?? node?.input?.optional?.[field]
      const options = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : []
      models[label] = options
      log?.('info', `列出模型 ${label}：${options.length} 个`)
    } catch (error) {
      models[label] = null
      log?.('warn', `列出模型 ${label} 失败：${error?.message ?? error}`)
    }
  }
  return models
}

/* ------------------------------------------------- 辅助模型探测（放大 / 局部重绘）---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-064（原 L2377-2397）
const AUX_CACHE = new Map()

async function auxCapabilities(cfg, log, signal, { force = false } = {}) {
  const url = cfg.comfyUrl
  const hit = AUX_CACHE.get(url)
  if (!force && hit && Date.now() - hit.at < 60000) return hit.data
  const probe = async (type) => getNodeSchema(cfg, type, signal)
  // ★ 2026-10-19：inpaint 改为探测零下载潜空间重绘所需的自带节点（不再探 ControlNet）。
  const [vosr, realesr, vaeEnc, noiseMask, maskLoad, growM, featherM] = await Promise.all([
    probe('VOSR2ModelLoader'),
    probe('UpscaleModelLoader'),
    probe('VAEEncode'),
    probe('SetLatentNoiseMask'),
    probe('LoadImageMask'),
    probe('GrowMask'),
    probe('FeatherMask'),
  ])
  const data = {
    vosr2: {
      node: vosr.state === 'ok',
      models: vosr.state === 'ok' ? nodeFileList(vosr.node, 'model') : [],
    },
    realesrgan: {
      node: realesr.state === 'ok',
      models: realesr.state === 'ok' ? nodeFileList(realesr.node, 'model_name') : [],
    },
    inpaint: {
      // 前三个是潜空间重绘的必需节点（ComfyUI 自带）；后两个是可选增强，缺了退回硬边蒙版。
      encodeNode: vaeEnc.state === 'ok',
      noiseMaskNode: noiseMask.state === 'ok',
      maskLoadNode: maskLoad.state === 'ok',
      growNode: growM.state === 'ok',
      featherNode: featherM.state === 'ok',
    },
  }
  AUX_CACHE.set(url, { at: Date.now(), data })
  return data
}

/** 清除主能力探测缓存（一键修复用，避免"节点已装但缓存陈旧"导致反复降级）。 */
function clearCapabilityCache() {
  CAP_CACHE.clear()
}

/**
 * ★★ 2026-10-09 新增工具：列出本机 ComfyUI 可用模型。
 * 用来"查看可用的模型"——宿主自己的 LLM 模型下拉若卡住，这条直接查 ComfyUI 本体，
 * 给出磁盘上实际存在的模型文件名清单（UNET/CLIP/VAE/LoRA/Checkpoint）。
 */

// ===== moved from index.js: makeListModelsTool (was lines 3184-3218) =====
function makeListModelsTool(cfg, log) {
  return {
    name: 'list_available_models',
    description:
      '列出本机 ComfyUI 当前可用的模型文件（UNET / CLIP / VAE / LoRA / Checkpoint 各类），' +
      '返回每类磁盘上实际存在的模型文件名清单。用来确认生图后端到底加载了哪些模型、文件叫什么，' +
      '或排查"某个模型找不到"的问题。纯本地、不出网、不需要任何 API Key。' +
      '当有人问"有哪些模型 / 查看可用的模型 / 模型列表"时用它。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    timeoutMs: 30000,
// 设计说明已外置 → docs/config-design-notes.md#config-note-065（原 L2459-2462）
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        description: '本机 ComfyUI 各类模型（UNET / CLIP / VAE / LoRA / Checkpoint）的可用文件名清单。',
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ComfyUI（${value?.url ?? ''}）可用模型：${JSON.stringify(value?.summary ?? {})}`,
      }],
    },
    async execute(_args, exec) {
      const signal = exec?.signal
      await (ensureComfyUpHook === null ? Promise.resolve() : ensureComfyUpHook(cfg, log, signal)) // 顺带确认后端在（不在就拉起）
      const models = await listComfyModels(cfg, log, signal)
      // 统计每类数量，方便一眼看懂
      const summary = {}
      for (const [label, list] of Object.entries(models)) {
        summary[label] = Array.isArray(list) ? `${list.length} 个` : '（节点不存在 / 查询失败）'
      }
      return { url: cfg.comfyUrl, online: true, summary, models }
    },
  }
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-066（原 L2488-2505）

// ===== moved from index.js: MODEL_HINTS (was lines 3294-3357) =====
const MODEL_HINTS = {
  unet: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*int8/iu, 100],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*fp8/iu, 95],
    [/qwen[_\-.]?image[_\-.]?2[._]?1/iu, 90],
    [/qwen.*image/iu, 70],
  ],
  /** 官方 Turbo 主模型：必须明确带 turbo，绝不把普通底模误判进来。 */
  officialTurbo: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*turbo.*int8/iu, 130],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*turbo/iu, 125],
    [/qwen.*image.*turbo/iu, 110],
  ],
// 设计说明已外置 → docs/config-design-notes.md#config-note-067（原 L2521-2529）
  unetGguf: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q4_k_m/iu, 100],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q4_0/iu, 96],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q5_k_m/iu, 92],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q6_k/iu, 88],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*q8_0/iu, 84],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*\.gguf/iu, 80],
    [/qwen.*image.*\.gguf/iu, 60],
  ],
  clip: [
    [/qwen3[_\-.]?vl.*8b.*w4a8/iu, 100],
    [/qwen3[_\-.]?vl.*8b/iu, 95],
    [/qwen3[_\-.]?vl/iu, 85],
    [/qwen/i, 60],
  ],
  vae: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*vae/iu, 100],
    [/qwen.*image.*vae/iu, 90],
    [/qwen.*vae/iu, 80],
    [/vae/iu, 40],
  ],
  lora: [
    [/turbo8.*qwen/iu, 100],
    [/qwen.*turbo8/iu, 100],
    [/turbo8/iu, 92],
  ],
  /**
   * ★ 2026-10-12：**4 步蒸馏 LoRA** 的匹配规则（极速档用）。
   *
   * ⚠ 与 `lora` **分开是有意的**：用户机器上通常两个 LoRA 都在
   *   （8 步 turbo8 + 4 步 Lightning），必须能**分别认出**，不能互相覆盖。
   *   所以两条规则各自独立打分，`probeCapabilities` 各挑各的。
   */
  fast4: [
    [/lightning.*4steps?/iu, 100],
    [/4steps?.*lightning/iu, 100],
    [/qwen.*lightning/iu, 95],
    [/lightning/iu, 90],
    [/4steps?/iu, 85],
  ],
  consistency: [
    [/qwen.*2[._]?1.*一致性.*无偏移/iu, 130],
    [/一致性.*无偏移/iu, 125],
    [/consisten.*(no.?shift|offset)/iu, 120],
    [/consisten/iu, 110],
  ],
  removal: [
    [/qwen.*2[._]?1.*万物移除/iu, 130],
    [/万物移除/iu, 125],
    [/qwen.*remove.*gh/iu, 120],
    [/remove.*gh/iu, 110],
  ],
  outpaint: [
    [/qwen.*2[._]?1.*扩图.*gh/iu, 130],
    [/扩图.*gh/iu, 125],
    [/qwen.*outpaint/iu, 120],
    [/outpaint/iu, 110],
  ],
}

/* ------------------------------------------------- 模型档位（小显存适配）---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-068（原 L2592-2609）

// ===== moved from index.js: UNET_LOADER_NATIVE (was lines 3358-3359) =====
const UNET_LOADER_NATIVE = 'UNETLoader'
/** ComfyUI-GGUF（city96）的节点类名 —— 输入**只有** `unet_name`，没有 weight_dtype。 */

// ===== moved from index.js: UNET_LOADER_GGUF (was lines 3360-3381) =====
const UNET_LOADER_GGUF = 'UnetLoaderGGUF'

// 设计说明已外置 → docs/config-design-notes.md#config-note-069（原 L2618-2635）
const SPECTRUM_NODE = 'QwenSpectrumModelPatcher'

// 设计说明已外置 → docs/config-design-notes.md#config-note-070（原 L2638-2655）
const SADA_NODE_DEFAULT = 'SADASampler'

// 设计说明已外置 → docs/config-design-notes.md#config-note-071（原 L2658-2677）
// ★ 删档位理由（防后人再犯，全文见上锚点）：unsloth 的 qwen-image-2.1-Q4_K_M.gguf 是
//   stable-diffusion.cpp 格式（GGUF 头元数据无 general.architecture、张量名
//   model.diffusion_model.*），ComfyUI-GGUF 的 UnetLoaderGGUF 加载不了
//   ⇒ lite 档保留但不再自动下载，改用户自备 GGUF 放 models/unet。
// ===== moved from index.js: MODEL_TIERS (was lines 3382-3407) =====
const MODEL_TIERS = {
  full: {
    id: 'full',
    label: '完整档（int8 safetensors）',
    loader: UNET_LOADER_NATIVE,
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
  },
  lite: {
    id: 'lite',
    label: '轻量档（GGUF Q4_K_M）',
    loader: UNET_LOADER_GGUF,
    // ★ 2026-10-12：换成 abenzerps 那个**实测能配 ComfyUI-GGUF** 的文件
    //   （原来的 unsloth 那 份是 sd.cpp 格式，加载不了）。
    //   ⚠ 详见 scripts/setup.mjs 里 UNET_LITE 上的两条"必须如实说明"。
    unet: 'qwen-image-2.1-UC-Q4_K_M.gguf',
  },
// 设计说明已外置 → docs/config-design-notes.md#config-note-072（原 L2696-2700）
  bf16: {
    id: 'bf16',
    label: '全精度档（BF16，专业卡 24G+）',
    loader: UNET_LOADER_NATIVE,
  },
  fp8: {
    id: 'fp8',
    label: 'FP8 档（12G+）',
    loader: UNET_LOADER_NATIVE,
  },
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-073（原 L2713-2729）
function pickUnetForTier(files, tier) {
  const list = Array.isArray(files) ? files.map((f) => String(f)) : []
  if (list.length === 0) return null
  const t = String(tier ?? 'auto').toLowerCase()
  // ⚠ 提示词打分（MODEL_HINTS）可能对"非标准命名"返回 null —— 那时**回落取第一个匹配文件**，
  //   否则会出现"文件明明在、档位却说挑不到"的假缺口。
  const best = (arr, hints) => pickBestModel(arr, hints) ?? arr[0]
  if (t === 'gguf') {
    const g = list.filter((f) => /\.gguf$/iu.test(f))
    return g.length ? { unet: best(g, MODEL_HINTS.unetGguf), loader: UNET_LOADER_GGUF, tier: 'gguf' } : null
  }
  if (t === 'int8') {
    const m = list.filter((f) => /int8/iu.test(f))
    return m.length ? { unet: best(m, MODEL_HINTS.unet), loader: UNET_LOADER_NATIVE, tier: 'int8' } : null
  }
  if (t === 'fp8') {
    const m = list.filter((f) => /fp8/iu.test(f))
    return m.length ? { unet: best(m, MODEL_HINTS.unet), loader: UNET_LOADER_NATIVE, tier: 'fp8' } : null
  }
  if (t === 'bf16') {
    const m = list.filter((f) => /bf16|bfloat16/iu.test(f))
    if (m.length) return { unet: best(m, MODEL_HINTS.unet), loader: UNET_LOADER_NATIVE, tier: 'bf16' }
    // 没有显式 bf16 标记 → 找"完全无量化标记"的原生文件（非 gguf / 非 int8 / 非 fp8 / 非 qN_K）
    const plain = list.filter((f) => !/\.gguf$/iu.test(f) && !/int8|fp8|q[2-8]_[0-9k]/iu.test(f))
    return plain.length ? { unet: best(plain, MODEL_HINTS.unet), loader: UNET_LOADER_NATIVE, tier: 'bf16' } : null
  }
  return null
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-074（原 L2759-2777）
function resolveVramArgs({ mode, vramGB, isMac, sharedMemory = false }) {
  const m = String(mode ?? 'auto').toLowerCase()
  if (isMac === true) {
    return { args: [], note: 'macOS 走 MPS / 统一内存 → 这组离散显存参数不参与（选了档位也不生效）' }
  }
  switch (m) {
    case 'resident':
      return { args: ['--highvram'], note: '全驻留：--highvram（模型全留显存，最快；装不下会 OOM）' }
    case 'standard':
      return { args: [], note: '标准：不加驻留参数，交给 ComfyUI 自己调度' }
    case 'save':
      return { args: ['--lowvram'], note: '省显存：--lowvram（部分权重换到内存，会慢一些）' }
    case 'ram':
      return { args: ['--novram'], note: '权重放内存：--novram（权重常驻内存、按需换入，最省显存、最慢）' }
    case 'cpu':
      return { args: ['--cpu'], note: '纯 CPU：--cpu（很慢，最后手段）' }
    default:
      break
  }
  const gb = Number(vramGB ?? 0)
  // ★★★ 2026-11-12：共享显存（核显）/ 极小显存 → 强制 --lowvram。
  //   否则 ComfyUI 在核显上容易把权重全压进本就紧张的系统内存，或直接 OOM。
  //   （显式档位 resident/standard/save/ram/cpu 仍优先于这条自动规则。）
  if (sharedMemory || (Number.isFinite(gb) && gb > 0 && gb < 4)) {
    return { args: ['--lowvram'], note: '共享显存 / 显存 < 4 GB → --lowvram（权重按需换入内存）' }
  }
  if (!Number.isFinite(gb) || gb <= 0) return { args: [], note: '拿不到显存信息 → 不加驻留参数' }
  if (gb >= 24) return { args: ['--highvram'], note: `${gb} GB ≥ 24 GB → --highvram（模型全驻留）` }
  if (gb >= 16) {
    return {
      args: ['--highvram', '--reserve-vram', '0.5'],
      note: `${gb} GB ∈ [16,24) → --highvram + 保留 0.5 GB 给系统`,
    }
  }
  return {
    args: [],
    note: `${gb} GB < 16 GB → 不加驻留参数（强行 highvram 会 OOM，反而不如让 ComfyUI 自己调度）`,
  }
}

/** 显存/内存档位的**合法取值**（端点白名单 + 面板下拉共用同一份，杜绝"面板有、端点不认"）。 */
const VRAM_MODES = ['auto', 'resident', 'standard', 'save', 'ram', 'cpu']
/** 精度档的合法取值。 */
const PRECISION_TIERS = ['auto', 'bf16', 'fp8', 'int8', 'gguf']
/** 文本控制档的合法取值。 */
const TEXT_CONTROL_MODES = ['auto', 'turbo', 'native']

// 设计说明已外置 → docs/config-design-notes.md#config-note-075（原 L2825-2845）
export function assessLowEndReadiness(profile = {}) {
  const vramGB = Number(profile.vramGB ?? 0)
  const sharedMemory = Boolean(profile.sharedMemory)
  const systemRAMGB = Number(profile.systemRAMGB ?? 0)
  // 精度档：共享显存强制最轻档；独显按显存量给建议档（仅建议，不静默换模型）。
  let tier = tierForVram(vramGB) ?? 'gguf'
  if (sharedMemory && tier !== 'gguf') tier = 'gguf'
  // 验收门槛（默认目标值，unverified —— 真机实测后替换）：
  //   独显：≥16GB 舒适(60s) / ≥8GB 达标但偏慢(120s) / <8GB 仅能出图(300s)
  //   共享：整机 ≥16GB 达标(180s) / 否则仅能出图(360s)
  let speedTargetSec = null
  let meetsAcceptableBar = false
  if (sharedMemory) {
    meetsAcceptableBar = systemRAMGB >= 16
    speedTargetSec = systemRAMGB >= 16 ? 180 : 360
  } else if (vramGB >= 16) {
    meetsAcceptableBar = true
    speedTargetSec = 60
  } else if (vramGB >= 8) {
    meetsAcceptableBar = true
    speedTargetSec = 120
  } else if (vramGB > 0) {
    meetsAcceptableBar = false
    speedTargetSec = 300
  }
// 设计说明已外置 → docs/config-design-notes.md#config-note-076（原 L2871-2874）
  // ★ 2026-11-13：用户显式选了核显型号时**只附加建议**，绝不改动上面的门槛判定。
  //   （型号参考秒数是别的模型的社区数据，只透出 igpuProfile，不碰原有字段；全文见锚点。）
  const igpuProfile = igpuPlanFor(profile?.igpuProfileId ?? profile?.igpuProfile ?? '')
  return {
    tier,
    sharedMemory,
    vramGB,
    systemRAMGB,
    meetsAcceptableBar,
    speedTargetSec,
    unverified: true,
    igpuProfile,
    caveat: 'speedTargetSec / meetsAcceptableBar 为默认目标值，未经真机实测校准（unverified）；'
      + '实际速度随分辨率 / 步数 / 并发变化，须真机跑一张图后替换。'
      + (igpuProfile
        ? ` 已选核显型号「${igpuProfile.name}」；该型号参考秒数来自社区/用户清单、测的是其它模型，`
          + '不可与本插件的 speedTargetSec 直接比较（comparable:false）。'
        : ''),
  }
}

/**
 * 按模型文件名后缀决定用哪个加载器节点。
 *
 * ⚠ 两个节点的输入**不一样**，混用会被 ComfyUI 直接拒收：
 *   · `UNETLoader`     —— 原生节点，要 `unet_name` + `weight_dtype`
 *   · `UnetLoaderGGUF` —— 第三方节点，**只有 `unet_name`**
 *     （多传 `weight_dtype` 会报 unexpected input）
 */

// ===== moved from index.js: unetLoaderFor (was lines 3408-3412) =====
function unetLoaderFor(unetName) {
  return /\.gguf$/iu.test(String(unetName ?? '')) ? UNET_LOADER_GGUF : UNET_LOADER_NATIVE
}

/** 组装主模型加载节点 —— 两个加载器的输入形状不同，集中在这里，别再各写一份。 */

// ===== moved from index.js: unetLoaderNode (was lines 3413-3426) =====
function unetLoaderNode(unetName) {
  return unetLoaderFor(unetName) === UNET_LOADER_GGUF
    ? { class_type: UNET_LOADER_GGUF, inputs: { unet_name: unetName } }
    : { class_type: UNET_LOADER_NATIVE, inputs: { unet_name: unetName, weight_dtype: 'default' } }
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-077（原 L2917-2924）

// ===== moved from index.js: tierLabelOf (was lines 3427-3450) =====
function tierLabelOf(caps, cfg) {
  const official = resolveOfficialTurbo(cfg, caps)
  // ★ 2026-11-16：面板「主模型」下拉的选择（镜像在 uiState.unet，写路径已过动态白名单
  //   校验）**前置** —— 报告行必须反映用户选了什么，否则又是「面板说一套、实际跑另一套」。
  const name = String(official.active
    ? official.model
    : (readUiState()?.unet || caps?.models?.unet || cfg?.unet || ''))
  const loader = caps?.unetLoader ?? unetLoaderFor(name)
  const isGguf = loader === UNET_LOADER_GGUF
  const missing = isGguf && caps?.nodes && caps.nodes.ggufUnet === false
    ? '（⚠ 缺 UnetLoaderGGUF 节点，需先装 ComfyUI-GGUF）'
    : ''
  const tier = isGguf ? MODEL_TIERS.lite : MODEL_TIERS.full
  return `${tier.label}：${name}${missing}`
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-078（原 L2943-2955）

// ===== moved from index.js: importantNotesOf (was lines 3451-3455) =====
function importantNotesOf(caps) {
  return (caps?.notes ?? []).filter((n) => String(n).startsWith('⚠'))
}

/** 从候选文件名里按 hint 打分挑最优；挑不出返回 null。 */

// ===== moved from index.js: pickBestModel (was lines 3456-3486) =====
function pickBestModel(list, hints) {
  if (!Array.isArray(list) || list.length === 0) return null
  let best = null
  let bestScore = -1
  for (const name of list) {
    if (typeof name !== 'string') continue
    for (const [re, score] of hints) {
      if (score > bestScore && re.test(name)) {
        best = name
        bestScore = score
      }
    }
  }
  return best
}

// 设计说明已外置 → docs/config-design-notes.md#config-note-079（原 L2981-2995）

// ===== moved from index.js: CAP_CACHE (was lines 3506-3514) =====
const CAP_CACHE = new Map()

/**
 * ★ 2026-10-09：「探测失败」时用的**短缓存时长**。
 *
 * 为什么不干脆不缓存：状态端点是**每 5 秒轮询一次**的，探测一次要发 10 个请求。
 * 失败不缓存 = ComfyUI 一不稳定就变成每 5 秒 10 个请求的持续轰炸。
 * 30 秒是个折中：既不会白烧算力，又能较快恢复出真实结论。
 */

// ===== moved from index.js: PROBE_FAIL_TTL_MS (was lines 3515-3522) =====
const PROBE_FAIL_TTL_MS = 30000

/**
 * 探测本机 ComfyUI 的能力：有哪些节点、有哪些模型、GPU 是什么。
 *
 * 所有查询**并发**发出（本机实测每项 ~24ms），任一失败都不影响其余项。
 * 全部失败 = 返回一个"什么都探测不到"的对象，由 `resolvePlan` 当 `full` 处理。
 */

// ===== moved from index.js: probeCapabilities (was lines 3523-3682) =====
async function probeCapabilities(cfg, log, signal, { force = false } = {}) {
  const baseTtl = Number.isFinite(cfg.capabilityCacheMs) ? cfg.capabilityCacheMs : 600000
  const hit = CAP_CACHE.get(cfg.comfyUrl)
  // ★ 用**条目自带**的 ttl（失败时是短 TTL），不再统一用一个常量
  if (!force && hit && Date.now() - hit.at < hit.ttl) return hit.caps

  // ★ 三态探测：每项是 {state, node}，见 getNodeSchema 的说明。
  // ★★★ 2026-10-12 新增两项（来自用户反馈）：
  //   · `vaeTiled`  = ComfyUI **自带**的 `VAEDecodeTiled`（大图解码防 OOM，零新增依赖）
  //   · `spectrum`  = 第三方 `QwenSpectrumModelPatcher`（跳过部分 Qwen transformer 前向）
  const NODE_KEYS = [
    'qwen21', 'prefixCache', 'teSpeed', 'speedup', 'blockCache', 'rdna3fa',
    'loraOnly', 'unet', 'ggufUnet', 'clip', 'vae', 'lora', 'vaeTiled',
    'spectrum', 'sada', 'easyCache', 'cnetLoader', 'cnetApply',
    // 0.18：官方 Turbo 采样 + 多图编辑 + 裁剪回贴
    'editPlus', 'manualSigmas', 'samplerAdvanced', 'basicGuider', 'inpaintCrop', 'inpaintStitch', 'colorMatch',
    'tileSplit', 'tileMerge', 'imageSize',
  ]
  const raw = await Promise.all([
    getNodeSchema(cfg, 'TextEncodeQwenImage21', signal),
    getNodeSchema(cfg, 'QwenImage21Cache', signal),
    getNodeSchema(cfg, 'TESpeedQwenImage21', signal),
    getNodeSchema(cfg, 'QwenImage21Speedup', signal),
    getNodeSchema(cfg, 'QwenImage21BlockCacheT8', signal),
    // ★ 2026-10-10：RDNA3 FlashAttention（无损加速；只认 gfx1100，节点自带回退）
    getNodeSchema(cfg, 'ApplyRDNA3FlashAttention', signal),
    getNodeSchema(cfg, 'LoraLoaderModelOnly', signal),
    getNodeSchema(cfg, 'UNETLoader', signal),
    // ★ 2026-10-11：GGUF 加载器（ComfyUI-GGUF 提供）—— 小显存档要用它，**没装就不能切档**
    getNodeSchema(cfg, UNET_LOADER_GGUF, signal),
    getNodeSchema(cfg, 'CLIPLoader', signal),
    getNodeSchema(cfg, 'VAELoader', signal),
    getNodeSchema(cfg, 'LoraLoader', signal),
    // ★ 2026-10-12：VAE 分块解码（ComfyUI 自带）与 Spectrum 跳步节点（第三方）
    getNodeSchema(cfg, 'VAEDecodeTiled', signal),
    // ★ 2026-10-12：Spectrum 跳步节点（第三方；没装时整单会被拒收，必须靠开关控制）
    getNodeSchema(cfg, SPECTRUM_NODE, signal),
    // ★ 2026-10-12：SADA 跳步采样（ICML 2025 论文，第三方；同样没装时整单会被拒收）
    getNodeSchema(cfg, SADA_NODE_DEFAULT, signal),
    // ★ 2026-11-17：EasyCache（ComfyUI 核心内置实验节点，步级复用；默认关）
    getNodeSchema(cfg, 'EasyCache', signal),
// 设计说明已外置 → docs/config-design-notes.md#config-note-080（原 L3060-3063）
    getNodeSchema(cfg, 'ControlNetLoader', signal),
    getNodeSchema(cfg, 'ControlNetApplyAdvanced', signal),
    // 0.18：官方 Turbo 8/9 步采样、多图编辑编码、裁剪回贴
    getNodeSchema(cfg, 'TextEncodeQwenImageEditPlus', signal),
    getNodeSchema(cfg, 'ManualSigmas', signal),
    getNodeSchema(cfg, 'SamplerCustomAdvanced', signal),
    getNodeSchema(cfg, 'BasicGuider', signal),
    getNodeSchema(cfg, 'InpaintCropImproved', signal),
    getNodeSchema(cfg, 'InpaintStitchImproved', signal),
    getNodeSchema(cfg, 'ColorMatch', signal),
    // 2026-11-17：分块重绘（核心节点；老版本 ComfyUI 可能没有）
    getNodeSchema(cfg, 'SplitImageToTileList', signal),
    getNodeSchema(cfg, 'ImageMergeTileList', signal),
    getNodeSchema(cfg, 'GetImageSize', signal),
  ]).catch(() => [])

  const probe = Object.fromEntries(
    NODE_KEYS.map((key, index) => [key, raw[index] ?? { state: 'error', node: null }]),
  )
  const errored = NODE_KEYS.filter((key) => probe[key].state === 'error').length
  /** 一半以上查询失败 ⇒ 整体结论不可信（不是"缺件"，是"没测出来"）。 */
  const probeFailed = errored >= Math.ceil(NODE_KEYS.length / 2)
  /** 只有**确认存在**才算有；`error` 绝不等同于 `missing`。 */
  const up = (key) => probe[key].state === 'ok'

  // GPU 信息单独取（探测不到也不影响链路判定）
  let stats = null
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 8000, signal })
    if (res.ok) stats = await res.json()
  } catch {
    stats = null
  }

  const caps = {
    at: Date.now(),
    probeFailed,
    cached: false,
    nodes: {
      qwen21: up('qwen21'),
      prefixCache: up('prefixCache'),
      teSpeed: up('teSpeed'),
      speedup: up('speedup'),
      blockCache: up('blockCache'),
      rdna3fa: up('rdna3fa'),
      loraOnly: up('loraOnly'),
      // ★ 2026-10-11：ComfyUI-GGUF 的 UnetLoaderGGUF —— 小显存档（GGUF）的前提
      ggufUnet: up('ggufUnet'),
      // ★★★ 2026-10-14（C3/C4）：ControlNet 加载器 / 施加节点
      cnetLoader: up('cnetLoader'),
      cnetApply: up('cnetApply'),
      // ★ 2026-10-12：VAE 分块解码（ComfyUI 自带）与 Spectrum 跳步节点（第三方）
      vaeTiled: up('vaeTiled'),
      spectrum: up('spectrum'),
      // ★ 2026-10-12：SADA 跳步采样（ICML 2025 论文，第三方节点；与 Spectrum 同源但走新分布）
      sada: up('sada'),
      // 2026-11-17：EasyCache（核心实验节点，步级复用；默认关）
      easyCache: up('easyCache'),
      // 0.18：官方 Turbo 采样 + 多图编辑 + 裁剪回贴
      editPlus: up('editPlus'),
      manualSigmas: up('manualSigmas'),
      samplerAdvanced: up('samplerAdvanced'),
      basicGuider: up('basicGuider'),
      inpaintCrop: up('inpaintCrop'),
      inpaintStitch: up('inpaintStitch'),
      colorMatch: up('colorMatch'),
      // 2026-11-17：分块重绘三件套（Split → 采样 → Merge，默认关）
      tileSplit: up('tileSplit'),
      tileMerge: up('tileMerge'),
      imageSize: up('imageSize'),
      officialSampling: up('manualSigmas') && up('samplerAdvanced'),
    },
    models: {
      unet: pickBestModel(nodeFileList(probe.unet.node, 'unet_name'), MODEL_HINTS.unet),
      // 0.18：官方 Turbo 主模型单独挑；匹配不到就是 null，绝不误认普通底模。
      officialTurbo: pickBestModel(nodeFileList(probe.unet.node, 'unet_name'), MODEL_HINTS.officialTurbo),
      // ★ 2026-10-11：GGUF 档的候选。**与原生列表是两套**（UnetLoaderGGUF 只列 .gguf），
      //   所以必须单独探、单独挑，不能拿原生那份顶替。
      unetGguf: pickBestModel(nodeFileList(probe.ggufUnet.node, 'unet_name'), MODEL_HINTS.unetGguf),
      clip: pickBestModel(nodeFileList(probe.clip.node, 'clip_name'), MODEL_HINTS.clip),
      vae: pickBestModel(nodeFileList(probe.vae.node, 'vae_name'), MODEL_HINTS.vae),
      turbo8Lora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.lora),
      // ★ 2026-10-12：4 步蒸馏 LoRA（极速档用）。与 turbo8Lora **同一份候选列表、不同规则**，
      //   所以两个 LoRA 都在的机器上能各挑各的，互不覆盖。
      fast4Lora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.fast4),
      // 0.18 任务 LoRA：自动探测；缺失时任务仍可跑，只是如实不用。
      consistencyLora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.consistency),
      removalLora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.removal),
      outpaintLora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.outpaint),
    },
    // ★★★ 2026-10-14（C3「专业卡版」）：**原始文件清单** —— 供面板"权重可调"下拉使用。
    //   ⚠ 与上面的 `models`（只存"最佳那一个"）分开：下拉要的是**全部可选**，
    //     而 `models` 是"当前选中的那个"。混在一起会让下拉只有一个选项。
    files: {
      unet: nodeFileList(probe.unet.node, 'unet_name'),
      unetGguf: nodeFileList(probe.ggufUnet.node, 'unet_name'),
      lora: nodeFileList(probe.lora.node, 'lora_name'),
      controlnet: probe.cnetLoader && probe.cnetLoader.state === 'ok'
        ? nodeFileList(probe.cnetLoader.node, 'control_net_name')
        : [],
    },
    // ★★★ 2026-10-14（C3）：当前**权重覆写**值（供面板下拉初始化）。
    //   ⚠ 放在 caps（`/api/qwen-paint/capabilities`）而不是 status 体里 ——
    //     status 体有"不含模型名"的既有底线，见 describe.js 里 weights 的说明。
    overrides: {
      unet: String(cfg.mainModelOverride ?? ''),
      lora: String(cfg.loraOverride ?? ''),
      controlnet: String(cfg.controlnetOverride ?? ''),
    },
    gpu: stats
      ? {
        name: String(stats?.devices?.[0]?.name ?? ''),
        vramGB: Math.round((Number(stats?.devices?.[0]?.vram_total ?? 0) / 1024 ** 3) * 10) / 10,
      }
      : null,
    level: 'basic',
    notes: [],
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-081（原 L3183-3190）
  const cfgUnet = String(cfg.unet ?? '')
  if (/\.gguf$/iu.test(cfgUnet)) {
    caps.unetLoader = UNET_LOADER_GGUF
    caps.models.unet = caps.models.unetGguf ?? cfgUnet
    if (!caps.nodes.ggufUnet) {
      caps.notes.push('⚠ 配置的是 GGUF 主模型，但 ComfyUI 里**没有 UnetLoaderGGUF 节点** —— '
        + '请先把 ComfyUI-GGUF（city96/ComfyUI-GGUF）装进 custom_nodes 再重启 ComfyUI，'
        + '否则这个工作流会被直接拒收')
    }
  } else if (caps.models.unet === null && caps.models.unetGguf !== null) {
    caps.unetLoader = UNET_LOADER_GGUF
    caps.models.unet = caps.models.unetGguf
    caps.notes.push(`主模型（${cfgUnet}）没在 ComfyUI 里找到，但发现了 GGUF 版本`
      + `（${caps.models.unetGguf}）→ 自动改用 UnetLoaderGGUF 加载`)
  } else {
    caps.unetLoader = UNET_LOADER_NATIVE
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-082（原 L3209-3212）
  const tierWant = String(cfg.precisionTier ?? 'auto').toLowerCase()
  if (tierWant !== 'auto') {
    const nativeFiles = nodeFileList(probe.unet.node, 'unet_name')
    const ggufFiles = nodeFileList(probe.ggufUnet.node, 'unet_name')
    const pick = pickUnetForTier(tierWant === 'gguf' ? ggufFiles : nativeFiles, tierWant)
    if (pick && pick.unet) {
      caps.models.unet = pick.unet
      caps.unetLoader = pick.loader
      caps.precisionTierApplied = pick.tier
      caps.notes.push(`按精度档「${tierWant}」选中主模型：${pick.unet}`)
    } else {
      caps.precisionTierApplied = null
      caps.notes.push(`⚠ 你选了精度档「${tierWant}」，但 ComfyUI 里**没有匹配的模型文件** `
        + '→ 已回落到当前可用档（**不假装已用上**）。想用这一档请先把对应权重放进 models/unet。')
    }
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-083（原 L3230-3233）
  {
    const vramForTier = Number(probe?.gpu?.vramGB || cfg.vramGB || 0)
    caps.suggestedPrecisionTier = tierForVram(vramForTier > 0 ? vramForTier : NaN)
    caps.suggestedPrecisionVramGB = vramForTier > 0 ? vramForTier : null
  }

  // ---- 档位判定 ------------------------------------------------------------
  const hasCore = caps.models.unet !== null && caps.models.clip !== null && caps.models.vae !== null
  const canTurbo = caps.nodes.loraOnly && caps.models.turbo8Lora !== null
  if (probeFailed) {
    // ★ 探测本身不可信时**不降级**：按"能力齐全"去试。
    //   理由：把"没测出来"当成"没有"，会把用户静默打到慢档且毫无提示；
    //   而按 full 去试，万一真缺件，ComfyUI 会当场给出明确的 node type not found，
    //   用户看得懂、能重试。**明确报错优于静默变慢。**
    caps.level = 'full'
    caps.notes.push(`⚠ 能力探测有 ${errored}/${NODE_KEYS.length} 项未成功，本次按"能力齐全"处理，且不缓存结果`)
  } else if (!hasCore) {
    caps.level = 'unsupported'
    caps.notes.push('没在 ComfyUI 里匹配到完整的千问模型（UNET/CLIP/VAE），将沿用配置里的文件名')
  } else if (canTurbo) {
    caps.level = (caps.nodes.teSpeed || caps.nodes.speedup) ? 'full' : 'turbo'
  } else {
    caps.level = 'basic'
    caps.notes.push('未发现 turbo8 LoRA → 回退到 25 步 / CFG 2.5 的原生链路（慢但一定能出图）')
  }
  if (!probeFailed) {
    if (canTurbo && !caps.nodes.teSpeed) caps.notes.push('未安装 TE-Speed 节点 → 跳过该环节')
    if (canTurbo && !caps.nodes.speedup) caps.notes.push('未安装 QwenImage21Speedup 节点 → 跳过该环节')
    if (!caps.nodes.prefixCache) caps.notes.push('ComfyUI 无 QwenImage21Cache 节点 → 跳过前缀缓存')
    if (!caps.nodes.qwen21) caps.notes.push('⚠ 未发现 TextEncodeQwenImage21 节点：ComfyUI 版本可能过旧，需要 Qwen-Image 2.1 支持')
  }

  // ---- 模型名回落：探测不到就用配置里的（用户可能手填了自定义名）----
  caps.models.unet = caps.models.unet ?? cfg.unet
  caps.models.clip = caps.models.clip ?? cfg.clip
  caps.models.vae = caps.models.vae ?? cfg.vae
  caps.models.turbo8Lora = caps.models.turbo8Lora ?? (cfg.turbo8Lora || DEFAULT_TURBO8_LORA)
  // ★ 2026-10-12：4 步 LoRA **没有内置默认**（那是可选的第三方权重，不该由插件替用户假定）。
  //   探测不到 + 没手填 ⇒ 保持 null ⇒ 极速档在界面上显示"不可用"并禁止打开。
  caps.models.fast4Lora = caps.models.fast4Lora ?? (cfg.fast4Lora || null)
  // 0.18：任务 LoRA 同理 —— 没有内置默认，探测不到 + 没手填就保持 null。
  caps.models.consistencyLora = caps.models.consistencyLora ?? (String(cfg.consistencyLora ?? '').trim() || null)
  caps.models.removalLora = caps.models.removalLora ?? (String(cfg.removalLora ?? '').trim() || null)
  caps.models.outpaintLora = caps.models.outpaintLora ?? (String(cfg.outpaintLora ?? '').trim() || null)
  if (!probeFailed && caps.models.officialTurbo !== null && caps.nodes.officialSampling) {
    caps.notes.push(`已发现官方 Qwen-Image 2.1 Turbo 主模型：${caps.models.officialTurbo}`
      + '（文生图 8 步 / 编辑类 9 步，不再挂 turbo8 LoRA）')
  }

// 设计说明已外置 → docs/config-design-notes.md#config-note-084（原 L3283-3288）
  if (!signal?.aborted) {
    CAP_CACHE.set(cfg.comfyUrl, {
      at: Date.now(),
      ttl: probeFailed ? PROBE_FAIL_TTL_MS : baseTtl,
      caps,
    })
    caps.cached = true
  }

  if (log) {
    log('info', `能力探测：档位=${caps.level}${caps.cached ? '' : '（不缓存）'} `
      + `节点[qwen21=${caps.nodes.qwen21} 前缀缓存=${caps.nodes.prefixCache} TE=${caps.nodes.teSpeed} Speedup=${caps.nodes.speedup}]`)
    log('info', `模型匹配：unet=${caps.models.unet} clip=${caps.models.clip} vae=${caps.models.vae} lora=${caps.models.turbo8Lora}`)
    for (const note of caps.notes) log('info', `能力提示：${note}`)
  }
  return caps
}

/** 探测结果的空对象（`buildWorkflow` 不传 caps 时用它，等价于"能力齐全"）。 */

// ===== moved from index.js: FULL_CAPS (was lines 3683-3700) =====
const FULL_CAPS = Object.freeze({
  // ★ 2026-10-10 修 bug：补 `rdna3fa` —— 原先漏了它，导致凡是不传 caps 的路径
  //   （`planWorkflow` / 自测）都拿不到 FA，与"caps 缺省 = 能力齐全"的约定不符。
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true, ggufUnet: true, easyCache: true },
  // ⚠ 这里**刻意不放 `unetLoader`** —— 让它按模型名后缀现推（见 resolvePlan）。
  //   写死成 'UNETLoader' 会把 `.gguf` 的情形盖住（caps 缺省时错误地走原生加载器）。
  models: {},
  gpu: null,
  level: 'full',
  notes: [],
})

/**
 * 把「配置 + 探测结果」折算成这次实际要用的链路。
 *
 * ⚠ `caps` 为 undefined（自测直接调 buildWorkflow 的情况）＝ 当作能力齐全，
 *   保持"默认全栈"的老行为，避免所有既有断言失效。
 */

// ===== moved from index.js: resolvePlan (was lines 3701-3849) =====
function resolvePlan(cfg, caps) {
  const c = caps ?? FULL_CAPS
// 设计说明已外置 → docs/config-design-notes.md#config-note-085（原 L3332-3339）
  const turboAvailable = c.level === 'full' || c.level === 'turbo'
// 设计说明已外置 → docs/config-design-notes.md#config-note-086（原 L3341-3346）
  const textCtl = String(cfg.textControl ?? 'auto').toLowerCase()
  const forceNative = textCtl === 'native'
  // 官方 Turbo 的所有条件集中在 official-turbo.js，面板与计划消费同一结果。
  const officialTurbo = resolveOfficialTurbo(cfg, c)
  const useOfficialTurbo = officialTurbo.active
  const useTurbo = !useOfficialTurbo && turboAvailable && cfg.turbo8Enabled !== false && !forceNative
// 设计说明已外置 → docs/config-design-notes.md#config-note-087（原 L3353-3359）
  const useFast4 = useTurbo
    && cfg.fast4Enabled === true
    && c.models?.fast4Lora !== null && c.models?.fast4Lora !== undefined
// 设计说明已外置 → docs/config-design-notes.md#config-note-088（原 L3363-3366）
  const useTe = (useTurbo || useOfficialTurbo) && c.nodes?.teSpeed === true && cfg.teSpeedEnabled !== false
  const useSpeedup = (useTurbo || useOfficialTurbo) && c.nodes?.speedup === true && cfg.speedupEnabled !== false
  const usePrefix = c.nodes?.prefixCache === true && cfg.qwenCacheEnabled !== false

// 设计说明已外置 → docs/config-design-notes.md#config-note-089（原 L3371-3396）
  const useBlockCache = c.nodes?.blockCache === true && cfg.blockCacheEnabled !== false
// 设计说明已外置 → docs/config-design-notes.md#config-note-090（原 L3398-3406）
  const faCapsOmitted = caps === undefined || caps === null
  const faGpuName = c.gpu?.name
  const faGpuOk = faCapsOmitted ? true : (!!faGpuName && vendorIdOf(faGpuName) === 'amd_rdna3')
  const useRdna3Fa = c.nodes?.rdna3fa === true && cfg.rdna3FlashAttention !== false && faGpuOk
  // ★ TE-Speed / Speedup 让位：BlockCache 赢了就不挂它们（否则整链崩）。
  const useTeFinal = useTe && !useBlockCache
  const useSpeedupFinal = useSpeedup && !useBlockCache

// 设计说明已外置 → docs/config-design-notes.md#config-note-091（原 L3415-3424）
  const vramGB = Number(c.gpu?.vramGB || c.residency?.vramGB || cfg.vramGB || 0)
  const userArgs = Array.isArray(cfg.comfyArgs)
  // ★★★ 2026-10-14（C1）：改为**调用同一个纯函数** resolveVramArgs —— 不再在这里复述规则。
  //   之前两处各写一份判据，靠注释约定"必须同源"；现在从根上只剩一份，改不动歪。
  const residency = (() => {
    const mode = cfg.vramMode ?? 'auto'
    const sharedMemory = Boolean(c.gpu?.sharedMemory || cfg.sharedMemory || false)
    const r = resolveVramArgs({ mode, vramGB, isMac: IS_MAC, sharedMemory })
    const argsTxt = r.args.length > 0 ? r.args.join(' ') : '(不加)'
    if (userArgs) {
      return {
        on: false,
        applicable: true,
        vramGB,
        mode,
        note: `你用 comfyArgs 接管了启动参数 → 插件不再自动加显存参数（当前档位 ${mode} 不生效）`,
      }
    }
    const applicable = r.args.length > 0
    return {
      on: applicable,
      applicable,
      vramGB,
      mode,
      note: `${r.note}｜启动参数：${argsTxt}`,
    }
  })()
// 设计说明已外置 → docs/config-design-notes.md#config-note-092（原 L3452-3457）
  const vaeTiledAvailable = c.nodes?.vaeTiled === true
  const vaeTilingMode = cfg.vaeTiling === 'on' || cfg.vaeTiling === 'off' ? cfg.vaeTiling : 'auto'
  /** 'auto' 的**显存闸**：< 16 GB 才可能触发（另一半是尺寸闸，在 buildWorkflow）。 */
  const vaeTilingVramOk = Number.isFinite(vramGB) && vramGB > 0 && vramGB < 16
  const useVaeTiling = vaeTiledAvailable
    && (vaeTilingMode === 'on' || (vaeTilingMode === 'auto' && vaeTilingVramOk))
// 设计说明已外置 → docs/config-design-notes.md#config-note-093（原 L3464-3470）
  const explicitTurboLora = (typeof cfg.turbo8Lora === 'string'
    && cfg.turbo8Lora.trim() !== ''
    && cfg.turbo8Lora !== DEFAULT_TURBO8_LORA)
    ? cfg.turbo8Lora
    : null
  /** 0.18：任务 LoRA 取「显式配置 > 自动探测 > 空」。空 = 不接，避免 value not in list。 */
  const taskLora = (configured, detected) => {
    const explicit = typeof configured === 'string' ? configured.trim() : ''
    if (explicit !== '') return explicit
    return typeof detected === 'string' && detected !== '' ? detected : ''
  }

  /** Spectrum 跳步：**默认关**（理由见 DEFAULTS.spectrumEnabled）；节点必须在，否则整单会被拒收。 */
  const useSpectrum = c.nodes?.spectrum === true && cfg.spectrumEnabled === true
  /** SADA 跳步采样：**默认关**（理由见 DEFAULTS.sadaEnabled）；节点必须在 + class_type 可配。 */
  const useSada = c.nodes?.sada === true && cfg.sadaEnabled === true
  /** EasyCache 步级复用：**默认关**；节点必须在，否则整单会被拒收。 */
  const useEasyCache = c.nodes?.easyCache === true && cfg.easyCacheEnabled === true

// 设计说明已外置 → docs/config-design-notes.md#config-note-094（原 L3490-3494）
  const fileList = c.files
  const overrideState = (val, lists) => {
    const want = typeof val === 'string' ? val : ''
    if (want === '') return { want: '', ok: false, set: false }
    const any = lists.filter((l) => Array.isArray(l) && l.length > 0)
    if (any.length === 0) return { want, ok: true, set: true, unchecked: true }
    return { want, ok: any.some((l) => l.includes(want)), set: true }
  }
  const weightOverride = {
    unet: overrideState(cfg.mainModelOverride, [fileList?.unet, fileList?.unetGguf]),
    lora: overrideState(cfg.loraOverride, [fileList?.lora]),
    controlnet: overrideState(cfg.controlnetOverride, [fileList?.controlnet]),
  }
  const mainModelOverrideOk = weightOverride.unet.ok
  const loraOverrideOk = weightOverride.lora.ok
  const controlnetOverrideOk = weightOverride.controlnet.ok
  const officialSteps = Number.isFinite(cfg.officialTurboSteps) && cfg.officialTurboSteps > 0
    ? Math.trunc(cfg.officialTurboSteps) : OFFICIAL_TURBO_STEPS
  const officialEditSteps = Number.isFinite(cfg.officialEditSteps) && cfg.officialEditSteps > 0
    ? Math.trunc(cfg.officialEditSteps) : OFFICIAL_EDIT_STEPS

  return {
    useTurbo,
    useOfficialTurbo,
    officialTurboReason: officialTurbo.reason,
    samplingProfile: useOfficialTurbo ? 'official-turbo' : (useFast4 ? 'fast4' : (useTurbo ? 'turbo8' : 'native')),
    officialSteps,
    officialEditSteps,
    officialSigmas: typeof cfg.officialTurboSigmas === 'string' && cfg.officialTurboSigmas.trim() !== ''
      ? cfg.officialTurboSigmas.trim() : OFFICIAL_TURBO_SIGMAS_8,
    officialEditSigmas: typeof cfg.officialEditSigmas === 'string' && cfg.officialEditSigmas.trim() !== ''
      ? cfg.officialEditSigmas.trim() : OFFICIAL_EDIT_SIGMAS_9,
    // ★ 2026-10-14（C5）：文本控制档 —— 面板与自测都读它
    textControl: forceNative ? 'native' : ((useTurbo || useOfficialTurbo) ? 'turbo' : 'native'),
    // ★ 2026-10-12：极速档（4 步）是否生效 —— 界面文案 / 自测都读这个
    useFast4,
    // ★ 2026-10-12：VAE 分块解码 / Spectrum 跳步（详见各自 DEFAULTS 的注释）
    useVaeTiling,
    vaeTilingMode,
    vaeTiledAvailable,
    useSpectrum,
    useSada,
    useEasyCache,
    useTe: useTeFinal,
    useSpeedup: useSpeedupFinal,
    usePrefix,
    useBlockCache,
    useRdna3Fa,
    residency,
    steps: useOfficialTurbo
      ? officialSteps
      : (useFast4
        ? (Number.isFinite(cfg.fast4Steps) && cfg.fast4Steps > 0 ? Math.trunc(cfg.fast4Steps) : 4)
        : (useTurbo
          ? TURBO8_STEPS
          : (Number.isFinite(cfg.baseSteps) && cfg.baseSteps > 0 ? Math.trunc(cfg.baseSteps) : BASE_STEPS))),
    cfgScale: (useTurbo || useOfficialTurbo) ? 1.0 : (Number.isFinite(cfg.baseCfg) ? cfg.baseCfg : BASE_CFG),
    // ★ 2026-10-12：采样位移随档位走。**必须与 LoRA 配套** —— 4 步 Lightning 按 shift=3
    //   蒸馏（ln3≈1.0986），turbo8 按 shift=2（ln2≈0.6935）；拿错位移会明显掉画质
    //   （实测同 seed 对比：拿 turbo8 位移跑 Lightning → 糊、五官走形）。
    maxShift: useFast4
      ? (Number.isFinite(cfg.fast4MaxShift) ? cfg.fast4MaxShift : 1.0986)
      : (Number.isFinite(cfg.turbo8MaxShift) ? cfg.turbo8MaxShift : 0.6935),
    baseShift: useFast4
      ? (Number.isFinite(cfg.fast4BaseShift) ? cfg.fast4BaseShift : 1.0986)
      : (Number.isFinite(cfg.turbo8BaseShift) ? cfg.turbo8BaseShift : 0.5),
    models: {
      // ★★★ 2026-10-14（C3「专业卡版」）：**权重可调** —— 用户显式选的主模型优先。
      //   ⚠ 只在它**确实在探测到的清单里**时才认（防"文件被删了但配置还指着它"⇒ 整单被拒收）。
      //     清单拿不到（caps 缺省 / 探测失败）时不拦 —— 保持既有"按配置试"的语义。
      unet: useOfficialTurbo
        ? c.models.officialTurbo
        : ((mainModelOverrideOk ? cfg.mainModelOverride : '') || c.models?.unet || cfg.unet),
      clip: c.models?.clip || cfg.clip,
      vae: c.models?.vae || cfg.vae,
      // 0.18：任务 LoRA（空串 = 本机没装，任务链会跳过并在返回值里如实说明）
      consistencyLora: taskLora(cfg.consistencyLora, c.models?.consistencyLora),
      removalLora: taskLora(cfg.removalLora, c.models?.removalLora),
      outpaintLora: taskLora(cfg.outpaintLora, c.models?.outpaintLora),
// 设计说明已外置 → docs/config-design-notes.md#config-note-095（原 L3574-3582）
      turbo8Lora: (loraOverrideOk ? cfg.loraOverride : '')
        || (useFast4
          ? c.models.fast4Lora
          : (explicitTurboLora ?? (c.models?.turbo8Lora || DEFAULT_TURBO8_LORA))),
      // ★ 2026-10-14（C3）：ControlNet 权重（C4 用它；没选/没装节点时为空串 → 不接）
      //   ⚠ 必须放在 `models` **里面** —— buildWorkflow 读的是 `plan.models.controlnet`。
      controlnet: controlnetOverrideOk ? cfg.controlnetOverride : '',
    },
    // ★ 2026-10-14（C3）：权重覆写的采纳状态（供面板如实显示"选了但没被采纳"）
    weightOverride,
    // ★ 2026-10-11：主模型加载器 —— 由探测阶段定好（见 probeCapabilities 的"模型档位"段）。
    //   caps 缺省（FULL_CAPS / 不传）时按文件名后缀现推一次，语义与旧版一致。
    unetLoader: c.unetLoader ?? unetLoaderFor(c.models?.unet || cfg.unet),
  }
}


// 设计说明已外置 → docs/config-design-notes.md#config-note-096（原 L3600-3615）

// ===== moved from index.js: DIAG_FILE (was lines 4962-4975) =====
const DIAG_FILE = (() => {
  try {
// 设计说明已外置 → docs/config-design-notes.md#config-note-097（原 L3620-3624）
    return path.join(defaultOutputDir(), 'qwen-paint-diag.log')
  } catch {
    return ''
  }
})()

/** 诊断开关：默认开（排查期）；设 `DSHQP_DIAG=0` 可关掉。 */

// ===== moved from index.js: DIAG_ON (was lines 4976-4978) =====
const DIAG_ON = process.env.DSHQP_DIAG !== '0'

/* ------------------------------------------- safetensors 架构探测（★ 2026-10-16）---- */

// 设计说明已外置 → docs/config-design-notes.md#config-note-098（原 L3638-3661）
async function readSafetensorsConvInChannels(filePath) {
  let fh = null
  try {
    fh = await fsp.open(filePath, 'r')
    const lenBuf = Buffer.alloc(8)
    await fh.read(lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    // 合理性检查：header 不可能是 0，也不该大到离谱（防把非 safetensors 文件当权重读）
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 64 * 1024 * 1024) return null
    const headBuf = Buffer.alloc(headerLen)
    await fh.read(headBuf, 0, headerLen, 8)
    const header = JSON.parse(headBuf.toString('utf8'))
    const inCh = new Set()
    for (const [name, meta] of Object.entries(header)) {
      if (name === '__metadata__') continue
      const shape = meta?.shape
      // 4D = 卷积权重，约定形状 [out_channels, in_channels, kh, kw]
      if (Array.isArray(shape) && shape.length === 4 && shape.every((v) => Number.isInteger(v))) {
        inCh.add(shape[1])
      }
    }
    return inCh.size > 0 ? inCh : null
  } catch {
    return null
  } finally {
    try { if (fh) await fh.close() } catch { /* 关不掉也无所谓 */ }
  }
}

/**
 * 依据上面探测到的通道集合，给出**是否疑似 Qwen-Image 1.0 权重**的判断。
 *
 * ⚠ 只在**明确只见到 16、没见到 64** 时才返回 `true`；其余（含读不出）一律 `false`。
 *   这是刻意的保守设计：误报会把人引向错误方向。
 *
 * @param {Set<number>|null} inCh
 * @returns {boolean}
 */
function looksLikeQwenImage10ControlNet(inCh) {
  if (!(inCh instanceof Set)) return false
  return inCh.has(16) && !inCh.has(64)
}

/** 同步追加一行诊断（任何异常都吞掉，绝不影响插件）。 */

export {
  // ★ 2026-10-16：ControlNet 架构探测（真实用户反馈 —— InstantX 权重是 1.0 的）
  readSafetensorsConvInChannels,
  looksLikeQwenImage10ControlNet,
  GPU_PROFILES,
  VENDOR_RULES,
  PCI_VENDOR,
  ACCEL_PACKS,
  ACCEL_SOURCES,
  PIP_MIRRORS,
  MODEL_HINTS,
  FULL_CAPS,
  MODEL_TIERS,
  // ★ 2026-10-14（C1/C2 专业卡版）：档位解析与合法取值（启动参数与面板报告**同源**）
  resolveVramArgs,
  VRAM_MODES,
  PRECISION_TIERS,
  TEXT_CONTROL_MODES,
  pickUnetForTier,
  INLINE_IMAGE_PROMPT,
  DRAW_INTENT_MODES,
  MODEL_NODES,
  UNET_LOADER_GGUF,
  UNET_LOADER_NATIVE,
  NO_SELF_DRAW_RULE,
  OUTPUT_SCHEMA,
  PARAMETERS,
  GPU_CACHE,
  CAP_CACHE,
  PROBE_FAIL_TTL_MS,
  SAGE_READY,
  AMD_KERNEL_FLAG,
  PATHS_CACHE,
  DIAG_FILE,
  DIAG_ON,
  describeOptimization,
  genericOptimizations,
  nvidiaGenOf,
  vendorIdOf,
  GPU_PROBE_WIN,
  GPU_PROBE_LINUX,
  GPU_PROBE_MAC,
  GPU_VRAM_PROBE_WIN,
  GPU_VRAM_PROBE_PY,
  GPU_VRAM_PROBE_PY_MAC,
  COMFY_SEARCH_WIN,
  COMFY_SEARCH_NIX,
  normalizeGpuText,
  detectGpuProfile,
  discoverComfyPaths,
  importantNotesOf,
  buildDrawIntentPrompt,
  tierLabelOf,
  unetLoaderFor,
  unetLoaderNode,
  pickBestModel,
  listComfyModels,
  makeListModelsTool,
  shouldProbe,
  pickWrapperSet,
  planWorkflow,
  buildWorkflow,
  buildTaskWorkflow,
  buildOfficialTurboWorkflow,
  buildDistilledModelChain,
  resolvePlan,
  resolveOfficialTurbo,
  OFFICIAL_TURBO_STEPS,
  OFFICIAL_EDIT_STEPS,
  OFFICIAL_TURBO_SIGMAS_8,
  OFFICIAL_EDIT_SIGMAS_9,
  probeCapabilities,
  probeReadiness,
  fetchWithTimeout,
  runShell,
  IS_WINDOWS,
  IS_MAC,
  pipSources,
  trimPrompt,
  TURBO8_STEPS,
  DEFAULT_TURBO8_LORA,
  BASE_STEPS,
  BASE_CFG,
  uniquePath,

  defaultOutputBase, defaultOutputDir, resolveOutputDir,
  DEFAULTS, FLOW_STYLES, ASPECTS,
  uiStatePath, readUiState, writeUiState,
  makeLog, r32, calcSize, safeStem, portOf, toError, cancelReason,

  presetAspect, auxCapabilities, clearCapabilityCache,
  SADA_NODE_DEFAULT,
  // ★ 2026-10-13：describe.js 需要（它 import 这几个去渲染面板）
  SPECTRUM_NODE, MAC_PROFILE_IDS, appleChipOf,
}
