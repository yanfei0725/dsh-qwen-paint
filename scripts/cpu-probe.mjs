#!/usr/bin/env node
/**
 * scripts/cpu-probe.mjs —— 在**目标机**上实测 CPU 指令集能力（只读，不改任何东西）。
 *
 * ## 为什么需要它
 *   插件运行在 Node 里，而 Node **没有 CPUID**：
 *     · Linux 上还能读 `/proc/cpuinfo` 的 `flags` 行（真·实测）；
 *     · Windows / macOS 上读不到（Git Bash/MYSYS 的 `/proc` 是它自己的虚拟映射，
 *       原生 Node 进程看不见），只能按 CPU 型号**推断**。
 *   型号推断对 E5 / 12 代酷睿这类"同系列不同代、指令集完全不同"的情况很容易错，
 *   所以给一个能拿真值的入口：借 ComfyUI 自带 python 问 PyTorch。
 *
 * ## 用法（**不会**自动装包、不会下载、不会重启）
 *   node scripts/cpu-probe.mjs                      # 自动找 ComfyUI 的 python
 *   node scripts/cpu-probe.mjs --python "X:/.../python.exe"
 *   node scripts/cpu-probe.mjs --bench              # 额外跑一个 BF16 微基准（多数十秒）
 *   node scripts/cpu-probe.mjs --json               # 只输出 JSON（给脚本/端点吃）
 *
 * ## 关于「AVX512 ≠ AVX512_BF16」
 *   `torch.backends.cpu.get_cpu_capability()` 只回到 `AVX512` / `AVX2` / `DEFAULT`
 *   这一级，**不告诉你有没有 BF16 扩展**。所以：
 *     · 不加 `--bench`：只报 capability + 原始编译信息，BF16 一律标"未知"；
 *     · 加 `--bench`：跑 fp32 / bf16 两组同尺寸 matmul 比耗时 ——
 *       有硬件 BF16 时 bf16 通常快 1.5x 以上，没有时会明显更慢（模拟实现）。
 *       这是**实测**，但受机器负载影响，只作参考，不当硬结论。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

const JSON_ONLY = has('--json')
const BENCH = has('--bench')
const DUMP_CONFIG = has('--dump-config')

/** 找 ComfyUI 的 python：显式 > 环境变量 > 当前目录附近常见位置。 */
function findPython() {
  const explicit = val('--python') ?? process.env.DSHQP_PYTHON
  if (explicit) return existsSync(explicit) ? explicit : null
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, 'venv', 'Scripts', 'python.exe'),
    path.join(cwd, '..', 'venv', 'Scripts', 'python.exe'),
    path.join(cwd, '.venv', 'Scripts', 'python.exe'),
    path.join(cwd, 'venv', 'bin', 'python'),
    path.join(cwd, '..', 'venv', 'bin', 'python'),
    // 本机 ROCm 版 ComfyUI 的常见布局（只作候选，不存在就跳过）
    'K:/ComfyUI-rocm/venv/Scripts/python.exe',
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

/**
 * Python 侧脚本：**只读**。注意它必须能容忍老版本 PyTorch
 * （`torch.backends.cpu.get_cpu_capability` 是较新才有的 API）。
 */
const PY = String.raw`
import json, os, sys
out = {"ok": True, "notes": []}
try:
    import torch
except Exception as e:
    print(json.dumps({"ok": False, "reason": "import torch failed: %s" % type(e).__name__}))
    sys.exit(0)

out["torch"] = getattr(torch, "__version__", "unknown")
out["logicalCores"] = os.cpu_count()
out["threads"] = int(torch.get_num_threads())
try:
    out["interopThreads"] = int(torch.get_num_interop_threads())
except Exception:
    out["interopThreads"] = None

cap = None
try:
    cap = torch.backends.cpu.get_cpu_capability()
except Exception:
    out["notes"].append("torch 太老，没有 get_cpu_capability()；看 configDump 里的编译选项")
out["capability"] = cap

try:
    import platform
    out["machine"] = platform.machine()
    out["processor"] = platform.processor()
except Exception:
    pass

# 原始编译信息：里面有 AVX512 / AVX512_BF16 之类的编译开关，供人工核对。
#
# ⚠ 三重踩坑记录（别再试前两种）：
#   ① contextlib.redirect_stdout —— 拦不住，PyTorch 走 C++ 层直接写 fd。
#   ② os.dup2(tmp, 1) —— Linux 上可行，**Windows 上不行**：dup2 只改 OS 级 fd，
#      MSVCRT 的 FILE* 缓冲还指着旧句柄，读回来照样是空字符串。
#   ③ 起子进程 + capture_output —— 子进程的 fd 1 本身就是 pipe，C++ 写进去能抓到。✅
# 代价是多 import 一次 torch（几秒），所以默认**不跑**，只在 --dump-config 时跑。
if len(sys.argv) > 1 and "--dump-config" in sys.argv:
    try:
        import subprocess
        r = subprocess.run(
            [sys.executable, "-c", "import torch; torch.__config__.show()"],
            capture_output=True, text=True, timeout=120,
        )
        out["configDump"] = ((r.stdout or "") + (r.stderr or ""))[:4000]
    except Exception as e:
        out["configDump"] = None
        out["notes"].append("读 torch.__config__ 失败: %s" % type(e).__name__)
else:
    out["configDump"] = None
    out["notes"].append("编译信息未抓取：加 --dump-config 可看 torch.__config__.show() 原文"
                        "（多花几秒；里面能看到 AVX512_BF16 之类的编译开关）")

if "--bench" in sys.argv:
    import time
    n = 1024
    def run(dtype):
        a = torch.randn(n, n, dtype=dtype)
        b = torch.randn(n, n, dtype=dtype)
        # 预热一次，避免把首次分配/编译算进耗时
        torch.mm(a, b)
        t0 = time.perf_counter()
        for _ in range(5):
            torch.mm(a, b)
        return (time.perf_counter() - t0) / 5.0
    try:
        f32 = run(torch.float32)
        b16 = run(torch.bfloat16)
        out["bench"] = {"fp32Sec": round(f32, 6), "bf16Sec": round(b16, 6),
                        "speedup": round(f32 / b16, 3) if b16 > 0 else None}
    except Exception as e:
        out["bench"] = None
        out["notes"].append("BF16 基准失败（该 torch 可能不支持 CPU bf16）: %s" % type(e).__name__)

print(json.dumps(out, ensure_ascii=False))
`

function main() {
  const py = findPython()
  if (!py) {
    const msg = '找不到 ComfyUI 的 python。请用 --python 指定，例如：\n'
      + '  node scripts/cpu-probe.mjs --python "K:/ComfyUI-rocm/venv/Scripts/python.exe"'
    if (JSON_ONLY) console.log(JSON.stringify({ ok: false, reason: 'python not found' }))
    else console.error(msg)
    process.exit(JSON_ONLY ? 0 : 1)
  }

  const pyArgs = ['-c', PY]
  if (BENCH) pyArgs.push('--bench')
  if (DUMP_CONFIG) pyArgs.push('--dump-config')

  const r = spawnSync(py, pyArgs, { encoding: 'utf8', timeout: 180000 })
  if (r.error) {
    if (JSON_ONLY) console.log(JSON.stringify({ ok: false, reason: String(r.error.message ?? r.error) }))
    else console.error(`调用 python 失败：${r.error.message ?? r.error}`)
    process.exit(JSON_ONLY ? 0 : 1)
  }
  const raw = String(r.stdout ?? '').trim()
  if (raw === '') {
    if (JSON_ONLY) console.log(JSON.stringify({ ok: false, reason: 'empty output' }))
    else console.error(`python 没有输出。stderr：\n${String(r.stderr ?? '').slice(0, 800)}`)
    process.exit(JSON_ONLY ? 0 : 1)
  }

  let data = null
  try { data = JSON.parse(raw.split('\n').pop()) } catch { data = null }
  if (!data) {
    if (JSON_ONLY) console.log(JSON.stringify({ ok: false, reason: 'unparsable output', raw: raw.slice(0, 800) }))
    else console.error(`输出不是 JSON：\n${raw.slice(0, 800)}`)
    process.exit(JSON_ONLY ? 0 : 1)
  }

  // ---- 把实测结果翻译成插件认识的三态（**不猜**）----
  const cap = String(data.capability ?? '').toUpperCase()
  const isa = {
    avx2: cap === 'AVX2' || cap === 'AVX512' ? true : (cap === 'DEFAULT' ? false : null),
    avx512f: cap === 'AVX512' ? true : (cap === '' || cap === 'UNKNOWN' ? null : false),
    // capability 不区分 BF16 扩展；只有跑了基准才敢给结论，否则保持 null。
    avx512Bf16: null,
    amxBf16: null,
  }
  if (data.bench && typeof data.bench.speedup === 'number') {
    isa.avx512Bf16 = data.bench.speedup >= 1.5
    data.notes = data.notes ?? []
    data.notes.push(`BF16 结论来自基准：bf16 相对 fp32 加速 ${data.bench.speedup}x`
      + '（阈值 ≥1.5x 判为有硬件 BF16 加速）。')
    if (data.bench.speedup >= 5) {
      // 本机实测到 64x —— 这不是"BF16 快 64 倍"，而是 fp32 那条路没走到最优 BLAS 内核。
      // 数字要如实给，但结论必须收敛到"方向明确"，不能拿去当性能承诺。
      data.notes.push('⚠ 加速比量级偏大（≥5x）说明 fp32 那条路还掺了 BLAS 内核选择差异，'
        + '**不能理解为"BF16 快这么多倍"**；只取方向性结论：本机 BF16 走的是硬件加速路径。')
    }
  } else {
    data.notes = data.notes ?? []
    data.notes.push('BF16 能力**未实测**：capability 只到 AVX2/AVX512 这一级，'
      + '不区分 AVX512_BF16 扩展。要结论请加 --bench，或直接看 configDump 里的编译开关。')
  }

  // configDump 只在"真含有用信息"时才算数。本机 ROCm 版 torch 的 show() 只吐了
  // 一行 `[WARNING] offload-arch failed`，没有任何编译开关 —— 这种要如实说，
  // 不能让用户以为"看过了、没 BF16"。
  const dump = String(data.configDump ?? '')
  const dumpUseful = /AVX|SSE|MKL|OpenMP|mkldnn|oneDNN/iu.test(dump)
  if (dump && !dumpUseful) {
    data.notes = data.notes ?? []
    data.notes.push('torch.__config__.show() 在这台机器上没输出可用的编译信息'
      + '（只有无关的 warning），别据此判断 BF16 —— 请用 --bench 实测。')
  }

  const result = {
    ok: data.ok !== false,
    schema: 'dsh-qwen-paint/cpu-probe@1',
    python: path.basename(py), // 只给文件名，不泄漏本机绝对路径
    ...data,
    isa,
    /** 可以直接粘进插件配置的值（配置项 `cpuFlags`）。 */
    suggestedCpuFlags: Object.entries(isa)
      .filter(([, v]) => v === true)
      .map(([k]) => ({ avx512f: 'avx512f', avx512Bf16: 'avx512_bf16', avxBf16: 'amx_bf16', avx2: 'avx2' }[k] ?? k))
      .join(' '),
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('===== CPU 实测结果（只读探测，未改动任何东西）=====')
  console.log(`PyTorch          : ${result.torch}`)
  console.log(`CPU capability   : ${result.capability ?? '未知（torch 太老）'}`)
  console.log(`逻辑核 / 线程数   : ${result.logicalCores} / ${result.threads}`)
  console.log(`指令集推断       : AVX2=${fmt(isa.avx2)} AVX512=${fmt(isa.avx512f)} BF16=${fmt(isa.avx512Bf16)}`)
  if (result.bench) {
    console.log(`BF16 基准        : fp32 ${result.bench.fp32Sec}s / bf16 ${result.bench.bf16Sec}s `
      + `→ ${result.bench.speedup}x`)
  }
  if (result.suggestedCpuFlags) {
    console.log(`\n可粘贴到配置项 cpuFlags：\n  ${result.suggestedCpuFlags}`)
  }
  for (const n of result.notes ?? []) console.log(`\n· ${n}`)
  if (result.configDump) {
    console.log('\n----- torch.__config__.show()（原始输出，供核对 AVX512_BF16）-----')
    console.log(result.configDump)
  }
}

function fmt(v) {
  return v === true ? '是' : (v === false ? '否' : '未知')
}

main()
