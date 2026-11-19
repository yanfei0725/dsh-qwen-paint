/**
 * lib/comfy-launch.js —— ComfyUI 的**启动与看护**子系统（2026-10-19 从 index.js 拆出）。
 * 为什么拆：index.js 逼近 DSH Store 单文件上限（262,144 B），而这一块约 56 KB 且自洽
 * （只依赖 config.js / comfy-accel.js / node 内置 / diag.js）。**整块搬、逻辑未改**。
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  AMD_KERNEL_FLAG,
  DEFAULTS,
  IS_MAC,
  IS_WINDOWS,
  SAGE_READY,
  cancelReason,
  detectGpuProfile,
  discoverComfyPaths,
  fetchWithTimeout,
  nvidiaGenOf,
  probeCapabilities,
  resolveVramArgs,
  runShell,
} from './config.js'
// comfyDirsFrom 在 2026-10-17 已拆到 comfy-accel.js（它只依赖 path）
import { comfyDirsFrom } from './comfy-accel.js'
import {
  cpuAccelPlan,
  getCpuProfile,
  mergeLaunchArgs,
  normalizeCpuAccelMode,
} from './cpu-profile.js'
import { diag } from './diag.js'
import { warnQueueGate } from './queue-gate.js'

/* ------------------------------------------------- 启动失败诊断（★ 2026-10-09）---- */

/**
 * ★★★ 启动状态与失败诊断 —— 这一块专治「点了启动，界面永远卡在"启动中"」。
 *
 * ## 根因（不是一个 bug，是三个叠在一起）
 *   ① `stdio: 'ignore'` → ComfyUI 的一切输出（包括"参数不认识"这种致命错误）**全被丢弃**；
 *   ② **没有监听 `exit`** → 进程秒退时插件毫无察觉，还在傻等它就绪；
 *   ③ **`starting` 状态没有任何过期机制** → 于是永远停在"启动中"，用户只能干等到天荒地老。
 *
 * ## 为什么这是"所有平台 + 所有显卡"的通用问题（不是偶发）
 *   · ComfyUI 一旦遇到**不认识的参数**就立刻 `exit 2` —— 实测：把
 *     `--use-quad-cross-attention` 误写成 `--use-cross-attention`，进程当场退出；
 *   · 而 attention 参数在**不同厂商、不同 ComfyUI 版本上支持的并不一致**
 *     （quad / pytorch / 有些老版本干脆不认），所以"参数被拒"是**必然会发生**的情况。
 *   · Windows 与 Linux 都走同一条 spawn 路径，所以修一处即可两边受益。
 *
 * ## 所以这里要做到四件事
 *   ① 保留 stderr → 拿得到错误原文；
 *   ② 监听 exit / error → 进程一退就知道；
 *   ③ 超时封顶 → 超过 LAUNCH_TIMEOUT_MS 还没就绪就判失败（不再无限"启动中"）；
 *   ④ 认得出"参数被拒"这种错 → 自动去掉该参数重试一次（这才是真正通用的修法）。
 */
// ★★★ 2026-10-17：**把启动超时从原来的短值调大到 120 秒**（唯一准绳见下方常量）。
//   真机实测（AMD ROCm / RX 7900 XT）冷启动 ComfyUI 经常 60~90 秒
//   （加载 20GB 显存 + 一堆自定义节点），旧的短超时必然误判 timeout：
//   进程明明还活着、日志里也没有报错，界面却先报"启动超时"，用户只能干等或重试。
//   注意：这条只影响"多久判定没就绪"，**不影响**"进程秒退/参数被拒"那两条快路径
//   （那两条在 watchLaunchedProcess 里一看到就当场判 failed，不等超时）。
export const LAUNCH_TIMEOUT_MS = 120000

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-001（原 L66-93）
export const launch = {
  /** idle | starting | ready | failed | timeout */
  phase: 'idle',
  /** 本次 starting 的开始时刻（ms）。phase 非 starting 时为 0。 */
  startedAt: 0,
  /** 失败/超时的原因（给界面显示）。 */
  error: '',
  /** 启动日志文件路径（拿错误原文用）。 */
  logPath: '',
  /** ★ 2026-10-13（任务 #62②）：本次启动**是否真的挂了** `--use-sage-attention`。
   *   只有 true 时，启动失败才归咎于 SageAttention 并自动禁用（崩溃自动回退）。 */
  sageAttempted: false,
}

/** 把状态重置为"在线"。**这是唯一的"成功"入口**，任何人探到通都该调它。 */
export function launchMarkReady() {
  launch.phase = 'ready'
  launch.startedAt = 0
  launch.error = ''
}

/** 把状态置为"启动中"。 */
export function launchMarkStarting(logPath) {
  launch.phase = 'starting'
  launch.startedAt = Date.now()
  launch.startedMono = performance.now()   // ★ 超时判断用单调钟（2026-11-18 审计）
  launch.error = ''
  launch.logPath = logPath ?? launch.logPath
}

/** 置为失败（带原因）。 */
export function launchMarkFailed(reason) {
  launch.phase = 'failed'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
}

/** 置为超时（无报错、纯等不到）。与 failed 分开，因为对用户含义不同。 */
export function launchMarkTimeout(reason) {
  launch.phase = 'timeout'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-002（原 L138-151）
export function launchFailedDueToSage(tail) {
  const t = String(tail ?? '').toLowerCase()
  if (/unrecognized arguments/i.test(t) && /sage[-_]?attention/i.test(t)) return true
  if (/no module named ['"]?sageattention/i.test(t)) return true
  if (/(sage[-_]?attn|sageattention).{0,80}(not compiled|sm_120|build|error)/i.test(t)) return true
  if (/sage[-_]?attention/i.test(t) && /(importerror|modulenotfounderror|traceback)/i.test(t)) return true
  return false
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-003（原 L161-166）
export function recoverFromSageCrash(cfg, log) {
  if (cfg?.nvidiaSageAttention === false) return false
  cfg.nvidiaSageAttention = false
  log?.('warn',
    '⚠ SageAttention 疑似导致 ComfyUI 启动失败（启动日志指向 sage-attention）。'
    + '已在本会话内自动关闭 nvidiaSageAttention，避免反复崩溃 —— 下次启动将不再带 --use-sage-attention。'
    + '若要恢复：先确认装了与当前显卡匹配的 sageattention'
    + '（Blackwell / sm_120 需支持该架构的构建），再把 nvidiaSageAttention 设回 true。')
  return true
}

/**
 * ★ 纯函数：把 `launch` 状态折算成**给前端的三个布尔量**。
 *
 * 之所以单独抽出来：这样"界面到底显示什么"只取决于这一个函数，
 * 可以**直接单元测试**，不必启动整个插件去猜。
 *
 * @param online 探活结果
 * @returns {{starting:boolean, failed:boolean, timedOut:boolean, error:string}}
 */
export function launchView(online) {
  if (online) {
    // ★ 规则②：在线就是在线 —— 任何残留的失败/启动态一律作废
    return { starting: false, failed: false, timedOut: false, error: '' }
  }
  const starting = launch.phase === 'starting'
    && performance.now() - (launch.startedMono ?? 0) < LAUNCH_TIMEOUT_MS
  return {
    starting,
    failed: launch.phase === 'failed' || launch.phase === 'timeout',
    timedOut: launch.phase === 'timeout',
    error: launch.phase === 'failed' || launch.phase === 'timeout' ? launch.error : '',
  }
}

/**
 * stderr / 错误文本是否属于「参数不被支持」。
 * 各版本的措辞不一样，所以把常见的几种都覆盖上 —— argparse 是 Python 标准库，
 * 所以 `unrecognized arguments` 覆盖了绝大多数情况。
 */
export function looksLikeBadArgs(text) {
  return /unrecognized arguments|unknown argument|invalid choice|no such option|error: argument/i
    .test(String(text ?? ''))
}

/** 从 stderr 尾部挑出一行最有用的错误（优先带 error/Error 的），供展示。 */
export function summarizeLaunchError(stderrTail, exitNote) {
  const lines = String(stderrTail ?? '')
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const key = lines.filter((s) => /error|Error|Traceback|ModuleNotFound|cannot|failed/i.test(s))
  const picked = (key.length > 0 ? key : lines).slice(-3).join(' / ')
  return exitNote + (picked === '' ? '' : `：${picked}`)
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-004（原 L223-251）
export function buildPosixLaunchCommand({ py, args, pidFile, logPath, launchEnv = [], useSetsid = false }) {
  const q = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
  const inner = [py, ...args].map(q).join(' ')
  const envExport = launchEnv.map(([k, v]) => `export ${k}=${q(v)};`).join(' ')
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-005（原 L256-270）
  const innerScript = `echo $$ > ${q(pidFile)}; ${envExport}${envExport ? ' ' : ''}exec ${inner}`
  const wrapped = `sh -c ${q(innerScript)}`
  // ★ 2026-11-20 行为测试抓到的真缺陷：nohup 分支 cmd 尾自带的 ` &` 会让 full 拼接后
  //   变成 `nohup ... & >log 2>&1 < /dev/null &` —— 第一个 & 先后台化（stdout/stderr
  //   落 nohup.out），后面的重定向作用于空命令，readLaunchLog 读 logPath 恒空。
  //   setsid 分支本就不带 &，& 统一由 full 收尾。cmd 无独立消费点（grep 实锤），零触碰。
  const cmd = useSetsid ? `setsid --fork sh -c ${q(wrapped)}` : `nohup sh -c ${q(wrapped)}`
  return { wrapped, cmd, full: `${cmd} >${q(logPath)} 2>&1 < /dev/null &` }
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-006（原 L277-291）
export async function resolveChildPid(parentPid, log) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return 0
  try {
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-007（原 L295-299）
    const script = IS_WINDOWS
      ? "(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue "
        + "| Where-Object { $_.CommandLine -match 'main\\.py' -and $_.Name -match 'python' } "
        + '| Select-Object -First 1 -ExpandProperty ProcessId)'
      : "ps -eo pid=,args= 2>/dev/null | awk '/main\\.py/ && !/awk/ {print $1; exit}'"
    const out = await runShell(script, 10000)
    const pid = Number.parseInt(String(out).trim().split(/\s+/u).pop() ?? '', 10)
    if (Number.isSafeInteger(pid) && pid > 0) {
      log?.('info', `已定位 ComfyUI 进程 pid=${pid}（壳进程 ${parentPid}）`)
      diag('spawn', `真实 pid=${pid}（壳 pid=${parentPid}）`)
      return pid
    }
    // 兜底：直接子进程（有些环境下命令行匹配不到，但父子关系在）
    const childScript = IS_WINDOWS
      ? `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" -ErrorAction SilentlyContinue `
        + '| Select-Object -First 1 -ExpandProperty ProcessId)'
      : `ps -eo pid=,ppid= 2>/dev/null | awk -v p=${parentPid} '$2==p {print $1; exit}'`
    const childOut = await runShell(childScript, 10000)
    const childPid2 = Number.parseInt(String(childOut).trim().split(/\s+/u).pop() ?? '', 10)
    if (Number.isSafeInteger(childPid2) && childPid2 > 0) {
      log?.('info', `已定位 ComfyUI 子进程 pid=${childPid2}（父 ${parentPid}）`)
      diag('spawn', `子进程 pid=${childPid2}（父 ${parentPid}）`)
      return childPid2
    }
    // ⚠ 拿不到也不要紧：watchLaunchedProcess 会退化为"只靠探活+日志"，
    //   那才是权威事实来源。**绝不能因为拿不到 pid 就判失败**。
    log?.('warn', `未能定位 ComfyUI 的 pid，改为只靠探活判断（不影响启动）`)
    diag('spawn', `定位 pid 失败（壳 ${parentPid}），退化为探活判断`)
    return 0
  } catch (error) {
    log?.('warn', `解析子进程 pid 失败：${error?.message ?? error}`)
    return 0
  }
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-008（原 L335-349）
function resolveCpuAccelForLaunch(cfg, log) {
  const mode = normalizeCpuAccelMode(cfg.cpuAccel)
  if (mode === 'off') {
    // 默认路径：一个参数、一个环境变量都不加（零漂移），也不打日志噪音。
    return {
      mode, effectiveMode: mode, args: [], env: [], threads: 0,
      workflowOverrides: {}, notes: [], skipped: [],
    }
  }
  const profile = getCpuProfile({ flags: cfg.cpuFlags, physicalCores: cfg.cpuPhysicalCores })
  const plan = cpuAccelPlan(profile, {
    mode,
    threads: cfg.cpuThreads,
    oomFallback: cfg.cpuOomFallback === true,
    bf16: cfg.cpuBf16,
    cacheOnCpu: cfg.cpuCacheOnCpu === true,
  })
  log('info', `CPU 加速档：${plan.mode}`
    + `${plan.effectiveMode !== plan.mode ? `（硬件限制，实际降级为 ${plan.effectiveMode}）` : ''}`
    + ` ｜ ${profile.model || '型号未知'}`
    + ` ｜ 物理核 ${profile.physicalCores || '未知'}（${profile.physicalCoresSource}）`
    + ` ｜ 指令集证据 ${profile.isaEvidence}`)
  for (const n of plan.notes) log('info', `  · ${n}`)
  for (const s of plan.skipped) log('info', `  · 跳过 ${s.item}：${s.reason}`)
  return plan
}

export async function startComfyHidden(cfg, log) {
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-009（原 L378-383）
  const found = await discoverComfyPaths(cfg, log)
  if (!found) {
    throw new Error(
      '找不到 ComfyUI 的安装位置（常见路径下都没发现 python + main.py 的组合）。\n'
      + '请在 cordis.patch.yml 的 config 里手动补上这三项后重试：\n'
      + "  comfyPython: 'X:\\...\\python.exe'\n"
      + "  comfyMainPy: 'X:\\...\\ComfyUI\\main.py'\n"
      + "  comfyWorkdir: 'X:\\...'",
    )
  }
  const { py, mainPy, workdir, from } = found
  if (from !== '配置') log('info', `自动探测到 ComfyUI：${mainPy}`)

  // ★ 启动参数：配置里的 comfyArgs 完全接管；否则按 **GPU 厂商 / 架构**自动选。
  //   skipOnline: 走到这里说明 ComfyUI 本来就连不上（不是我们要启动它吗），
  //   所以别再去敲 /system_stats 白等 6 秒。
  const gpu = await detectGpuProfile(cfg, log, { skipOnline: true })
  if (gpu.note) log('info', `注意：${gpu.note}`)
  // ★ 2026-10-09：把探测到的显存总量**回写 cfg** —— 这样面板里的「显存驻留」项
  //   与这里真正加的参数读的是同一个数，不会出现"面板说已启用、实际没加参数"的假报告。
  if (Number.isFinite(gpu.vramGB) && gpu.vramGB > 0) cfg.vramGB = gpu.vramGB
  const ATTN_FLAG = {
    quad: '--use-quad-cross-attention',
    pytorch: '--use-pytorch-cross-attention',
    // ★ 2026-10-11：ComfyUI 自带 `--use-ck-attention`（help 原文 "Use Comfy Kitchen attention"）。
    //   也开放给 `comfyAttentionBackend: ck` 手动指定。
    ck: '--use-ck-attention',
    default: null,
  }
  const explicit = cfg.comfyAttentionBackend
  let autoArgs = gpu.args ?? []
  if (explicit && explicit !== 'auto') {
    // 显式配置优先（用户想接管就让他接管）
    const flag = ATTN_FLAG[explicit]
    autoArgs = flag ? [flag] : []
    log('info', `注意力后端由配置指定：${explicit}`)
  } else {
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-010（原 L421-425）
    const kernelFlag = AMD_KERNEL_FLAG[gpu.id]
    if (kernelFlag && cfg.amdKernel === true) {
      autoArgs = [kernelFlag]
      log('info', `已启用 A 卡专属内核（可选）：${kernelFlag}`)
    }
    if (String(gpu.id ?? '').startsWith('amd') && cfg.amdAsyncOffload === true) {
      autoArgs = [...autoArgs, '--async-offload']
      log('info', '已启用 A 卡专属优化（可选）：--async-offload（异步权重卸载）')
    }
  }

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-011（原 L437-442）
  if (String(gpu.id ?? '') === 'nvidia') {
    const mode = cfg.nvidiaSageAttention
    const want = mode === true || (mode !== false && SAGE_READY === true)
    // ★★★ 2026-10-13（任务 #62②「崩溃自动回退」）：记住"本次**是否真的挂了**
    //   `--use-sage-attention`" —— 只有挂了它却崩，才归咎于它、自动禁用。
    //   （`want` 为 false 时不记，避免把"没装 sage 导致启动失败"误判成 sage 的锅。）
    launch.sageAttempted = want === true
    if (want) {
      autoArgs = [...autoArgs, '--use-sage-attention']
      // ★ 性能 / 兼容模式（中文命名）：ComfyUI 的全局开关没有官方子模式参数，
      //   所以这里**只**在日志里标注用户选的模式，不编造命令行参数。
      const sageMode = cfg.nvidiaSageAttentionMode === 'compatibility' ? '兼容模式' : '性能模式'
      log('info', '已启用 N 卡 SageAttention：--use-sage-attention'
        + `（${mode === true ? '配置显式开启' : '后台自检确认已安装'}，模式=${sageMode}）`
        + (sageMode === '兼容模式'
          ? '｜兼容模式：若本次启动因 sage-attention 失败，将自动禁用以避免反复崩溃。'
          : ''))
    } else if (mode !== false && SAGE_READY === null) {
      log('info', 'SageAttention 就绪状态未知（加速自检尚未跑完）→ 本次不加 --use-sage-attention；'
        + '下次启动 ComfyUI 会按自检结果决定。想强制开启可把 nvidiaSageAttention 设为 true')
    } else if (mode !== false) {
      log('info', 'SageAttention 未安装 → 不加 --use-sage-attention（装了之后自检会自动启用）')
    }
    const gen = nvidiaGenOf(gpu.detected)
    if (gen === 'blackwell') {
      log('info', '注意：50 系（Blackwell / sm_120）需要**支持 sm_120 的** Triton / SageAttention 构建，'
        + '老版本不认这代卡 —— 装了不匹配的版本反而会让 ComfyUI 起不来')
    }
  }

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-012（原 L473-483）
  const VRAM_ARGS = resolveVramArgs({
    mode: cfg.vramMode,
    vramGB: gpu.vramGB,
    isMac: IS_MAC,
  })

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-013（原 L490-497）
  const CPU_ACCEL = resolveCpuAccelForLaunch(cfg, log)

  const useAutoArgs = !Array.isArray(cfg.comfyArgs)
  const finalArgs = useAutoArgs
    ? mergeLaunchArgs({ autoArgs, vramArgs: VRAM_ARGS.args, cpuArgs: CPU_ACCEL.args })
    : cfg.comfyArgs
  if (useAutoArgs && VRAM_ARGS.note) log('info', `显存驻留：${VRAM_ARGS.note}`)
  if (!useAutoArgs && CPU_ACCEL.mode !== 'off') {
    // 用户用 comfyArgs 完全接管了启动参数 —— 档位不生效这件事必须说出来，
    // 否则就是本项目明令禁止的"面板说一套、实际跑另一套"。
    log('warn', `你用 comfyArgs 接管了启动参数 → CPU 加速档（${CPU_ACCEL.mode}）不会生效；`
      + '要让它生效请清空 comfyArgs，或把参数手写进 comfyArgs')
  }

  const extraArgs = finalArgs
  log('info', `启动参数：${extraArgs.length > 0 ? extraArgs.join(' ') : '(无额外参数)'}`)
  const args = [
    '-s', mainPy,
    // --windows-standalone-build 只对 Windows 便携包有意义；Linux 上不加（无意义，个别版本还会挑刺）
    ...(IS_WINDOWS ? ['--windows-standalone-build'] : []),
    '--disable-auto-launch',
    ...extraArgs,
  ]

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-014（原 L522-541）
  const launchEnv = (() => {
    const kept = []
    if (IS_MAC) {
      const pairs = Object.entries(gpu.env ?? {}).map(([k, v]) => [k, String(v)])
      const macPairs = cfg.appleMpsFallback === false
        ? pairs.filter(([k]) => k !== 'PYTORCH_ENABLE_MPS_FALLBACK')
        : pairs
      kept.push(...macPairs)
      if (cfg.appleMpsUnlimitedMem === true) {
        kept.push(['PYTORCH_MPS_HIGH_WATERMARK_RATIO', '0.0'])
      }
    }
    // CPU 加速档注入的线程数（默认 off 时 CPU_ACCEL.env 为空 → 零漂移）。
    // 同名变量不重复注入，避免出现两条 `set OMP_NUM_THREADS=` 互相覆盖的糊涂账。
    for (const pair of CPU_ACCEL.env ?? []) {
      if (!kept.some(([k]) => k === pair[0])) kept.push(pair)
    }
    return kept
  })()
  if (launchEnv.length > 0) {
    log('info', `注入环境变量：${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
    diag('start', `env ${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-015（原 L566-588）
  const launchLog = path.join(comfyDirsFrom(found).base, '.dshqp-launch.log')
  let childPid = 0
  try {
    if (IS_WINDOWS) {
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-016（原 L593-605）
      const batPath = path.join(comfyDirsFrom(found).base, '.dshqp-launch.cmd')
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-017（原 L607-611）
      const line = [
        ...launchEnv.map(([k, v]) => `set ${k}=${v}`),
        [py, ...args].map((a) => `"${String(a)}"`).join(' '),
      ].join('\r\n')
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-018（原 L616-636）
      const ps1Path = path.join(comfyDirsFrom(found).base, '.dshqp-minwin.ps1')
      const ps1 = [
        '# Minimize the ComfyUI launcher console window. Generated by dsh-qwen-paint.',
        '# MUST STAY PURE ASCII: PowerShell 5.1 reads .ps1 as ANSI without a BOM,',
        '# so non-ASCII comments corrupt the parse (bogus "unexpected token }").',
        '#',
        '# 2026-10-10 KEY FIX (window never got minimized):',
        '# When the default terminal is Windows Terminal (Win11 default), GetConsoleWindow()',
        '# returns an INVISIBLE pseudo-console window (non-zero handle). ShowWindow on it has',
        '# NO visible effect -- and because the old script accepted any non-zero handle,',
        '# the later "find window by class" fallbacks were never reached. So nothing minimized.',
        '# New order: prefer a VISIBLE window (by title first, then by class), own console last.',
        '$sig = @(',
        '  \'[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);\',',
        '  \'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\',',
        '  \'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);\',',
        '  \'[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder s, int n);\',',
        '  \'[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();\'',
        ') -join [Environment]::NewLine',
        '$api = Add-Type -MemberDefinition $sig -Name WinApi -Namespace DshqpHelp -PassThru',
        '$title = \'DSHQP-ComfyUI\'',
        '$hwnd = [IntPtr]::Zero',
        '$how = \'\'',
        '# 1) by title (the .cmd runs: title DSHQP-ComfyUI) -- most precise, works on WT + conhost',
        '$h = $api::FindWindow($null, $title)',
        'if ($h -ne [IntPtr]::Zero) { $hwnd = $h; $how = \'title\' }',
        '# 2) a VISIBLE Windows Terminal window',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $h = $api::FindWindow(\'CASCADIA_HOSTING_WINDOW_CLASS\', $null)',
        '  if ($h -ne [IntPtr]::Zero -and $api::IsWindowVisible($h)) { $hwnd = $h; $how = \'WT\' }',
        '}',
        '# 3) a VISIBLE classic console window',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $h = $api::FindWindow(\'ConsoleWindowClass\', $null)',
        '  if ($h -ne [IntPtr]::Zero -and $api::IsWindowVisible($h)) { $hwnd = $h; $how = \'console\' }',
        '}',
        '# 4) last resort: our own console window -- only if it is actually visible',
        'if ($hwnd -eq [IntPtr]::Zero) {',
        '  $own = $api::GetConsoleWindow()',
        '  if ($own -ne [IntPtr]::Zero -and $api::IsWindowVisible($own)) { $hwnd = $own; $how = \'own\' }',
        '}',
        'if ($hwnd -ne [IntPtr]::Zero) { $null = $api::ShowWindow($hwnd, 6) }',
        '# Write the outcome to a log -- the old script swallowed everything, so failures were invisible.',
        '$cls = New-Object System.Text.StringBuilder 256',
        'if ($hwnd -ne [IntPtr]::Zero) { $null = $api::GetClassName($hwnd, $cls, 256) }',
        '$line = (Get-Date).ToString(\'s\') + \' hwnd=\' + $hwnd + \' how=\' + $how + \' class=\' + $cls.ToString()',
        '$logPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) \'.dshqp-minwin.log\'',
        'Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue',
        '',
      ].join('\r\n')
      let minWinLine = ''
      try {
        await fsp.writeFile(ps1Path, ps1, 'ascii')
        // 先 start /b 起 powershell（它自己用 -WindowStyle Hidden 不显示窗口），
        // 让它去最小化 cmd 的窗口；`>nul 2>&1` 免得它自己往控制台打字。
        // ⚠ `DSHQP_NOMIN=1` 是留的逃生门：万一这个最小化在某些环境上出问题，
        //   用户可以在启动前设这个环境变量把这段跳过（不必改代码）。
        minWinLine = [
          'if not "%DSHQP_NOMIN%"=="1" (',
          '  start "" /b powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass'
            + ` -WindowStyle Hidden -File "${ps1Path}" >nul 2>&1`,
          ')',
        ].join('\r\n')
      } catch (error) {
        // ★ 最小化只是"体验优化"，**绝不能因为它失败就不启动后端**。
        log('warn', `生成窗口最小化脚本失败（不影响启动）：${error?.message ?? error}`)
      }
      await fsp.writeFile(
        batPath,
        [
          '@echo off',
          // ★ 2026-10-10：给控制台一个**唯一标题** —— 最小化脚本优先按它精确定位窗口
          //   （Win11 用 Windows Terminal 时按类名找会撞上别的终端窗口，按标题最稳）。
          //   顺带也让任务栏里显示成 "DSHQP-ComfyUI" 而不是 "cmd.exe"，更好认。
          'title DSHQP-ComfyUI',
          minWinLine,
          `${line} > "${launchLog}" 2>&1`,
          '',
        ].join('\r\n'),
        'utf8',
      )
      const script = [
        "$ErrorActionPreference = 'Stop'",
        // ⚠ `-Arguments @{...}` 是**哈希字面量**，内部**不能用分号**把多行压成一行 ——
        //   压了以后 PowerShell 会报 IncompleteHashLiteral（实测踩到）。
        //   所以这里用数组的 join("\n") 保留真正的换行。
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{`,
        `  CommandLine = 'cmd.exe /c "${batPath.replace(/'/gu, "''")}"'`,
        `  CurrentDirectory = '${workdir.replace(/'/gu, "''")}'`,
        '}',
        'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create 失败，ReturnValue=$($r.ReturnValue)" }',
        'Write-Output $r.ProcessId',
      ].join('\n')
      const out = await runShell(script, 30000)
      const cmdPid = Number.parseInt(String(out).trim().split(/\s+/u).pop() ?? '', 10) || 0
      // ★ 关键一步：拿到的只是 cmd.exe 的 pid，真实 python 是它的子进程 —— 查出来。
      childPid = await resolveChildPid(cmdPid, log)
    } else {
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-019（原 L735-750）
      const pidFile = `${launchLog}.pid`
      const hasSetsid = await runShell(
        'if command -v setsid >/dev/null 2>&1; then echo YES; else echo NO; fi',
        8000,
      )
      // ★ 2026-10-12：命令构造抽成纯函数（见 buildPosixLaunchCommand 的说明）——
      //   便于单测，且环境变量注入与引号转义只有**一处**实现。
      const launchCmd = buildPosixLaunchCommand({
        py,
        args,
        pidFile,
        logPath: launchLog,
        launchEnv,
        useSetsid: hasSetsid.trim() === 'YES',
      })
      await runShell(launchCmd.full, 30000)
      // 稍等一下让 pid 文件落盘，再读真实 pid
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        childPid = Number.parseInt(String(await fsp.readFile(pidFile, 'utf8')).trim(), 10) || 0
      } catch {
        childPid = 0
      }
    }
  } catch (error) {
    launchMarkFailed(`无法启动进程（${py}）：${error?.message ?? error}`)
    log('error', `启动 ComfyUI 失败：${error?.message ?? error}`)
    return
  }

  launchMarkStarting(launchLog)
  log('info', `已拉起 ComfyUI 进程（pid=${childPid || '未知'}），等待它就绪…`)
  diag('start', `已拉起 pid=${childPid || 0} args=${args.join(' ')}`)

  // ★ 脱离式的子进程拿不到 exit 事件，所以**用轮询看它还在不在**。
  //   这与状态端点的 5 秒轮询解耦：这里 1 秒一次、只查进程存活，开销极小。
  //   ⚠ pid 为 0（没定位到）时仍然要监视 —— 见 watchLaunchedProcess 的说明：
  //     它会退化成"只靠探活 + 日志"，这比完全不监视安全得多。
  watchLaunchedProcess(cfg, log, childPid)
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-020（原 L792-801）
export function watchLaunchedProcess(cfg, log, pid) {
  // ★★★ 不再因为 pid<=0 就整个放弃监视。
  //   拿不到可靠 pid 时仍要盯着：**探活 + 日志**这两条路一样能判断成败，
  //   而且它们才是权威事实。只有"进程存活查询"这一步会被跳过（见循环里）。
  const hasPid = Number.isSafeInteger(pid) && pid > 0
  let checks = 0
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-021（原 L808-813）
  const FAST_CHECKS = Math.ceil(LAUNCH_TIMEOUT_MS / 1000)
  const timer = setInterval(async () => {
    checks += 1
    // 已经就绪 / 已经判过失败 / 超时 → 收摊（ready 翻转只剩本监视器的探活路径）
    if (launch.phase !== 'starting') {
      clearInterval(timer)
      return
    }
    // 快段过后降频：第 FAST_CHECKS+5、+10、… 轮才真探，其余轮空转（不砍覆盖面）
    if (checks > FAST_CHECKS && (checks - FAST_CHECKS) % 5 !== 0) return

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-022（原 L825-829）
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
      if (res.ok) {
        clearInterval(timer)
        launchMarkReady()
        if (typeof log === 'function') log('info', 'ComfyUI 已就绪（启动监视结束）')
        await reportSlowImports(launch.logPath, log)
        return
      }
    } catch {
      /* 还没起来，继续往下判 */
    }

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-023（原 L843-847）
    const tail = await readLaunchLog(launch.logPath)
    if (tail !== '') {
      const fatal = fatalLineInLog(tail)
      if (fatal !== '') {
        clearInterval(timer)
        // ★★★ 2026-10-13（任务 #62②）：崩溃自动回退 —— 若本次挂了 sage-attention 且崩因指向它，
        //   先禁用再判失败，避免用户重试又崩、陷入循环。
        if (launch.sageAttempted === true && launchFailedDueToSage(tail)) recoverFromSageCrash(cfg, log)
        const hint = looksLikeBadArgs(tail)
          ? '。这看起来是**启动参数不被当前 ComfyUI 支持** —— 可在 cordis.patch.yml 里把 '
            + 'comfyArgs 设为 [] 或改 comfyAttentionBackend 后重试'
          : ''
        launchMarkFailed(fatal + hint)
        log('error', `ComfyUI 启动失败（日志已报错，立即判定）：${launch.error}`)
        return
      }
    }

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-024（原 L866-873）
    if (hasPid) {
      let alive = false
      try {
        const out = await runShell(
          IS_WINDOWS
            ? `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`
            : `if kill -0 ${pid} 2>/dev/null; then echo YES; else echo NO; fi`,
          8000,
        )
        alive = out.trim() === 'YES'
      } catch {
        // 查询命令本身失败（powershell 起不来等）→ **不能**据此判定进程死了
        alive = true
        diag('watch', `存活查询失败，本轮跳过判定（pid=${pid}）`)
      }
      if (alive) return
    } else {
      // 没有可靠 pid：**只报告，不判定** —— 结论完全交给探活与日志
      return
    }
    // 进程确认已消失 —— 读日志给出原因
    clearInterval(timer)
    // ★★★ 2026-10-13（任务 #62②）：崩溃自动回退（同日志路径）。
    if (launch.sageAttempted === true && launchFailedDueToSage(tail)) recoverFromSageCrash(cfg, log)
    // ★ 如果错在「参数不被支持」，把提示写得更能照做：
    //   各厂商 / 各版本支持的 attention 参数并不一致，这是最常见的一种失败。
    //   （不再自动重试 —— 用户可以从菜单里点重试，或把 comfyArgs 清空，更可控。）
    const base = summarizeLaunchError(tail, `进程在就绪前退出（pid=${pid}）`)
    const hint = looksLikeBadArgs(tail)
      ? '。这看起来是**启动参数不被当前 ComfyUI 支持** —— 可在 cordis.patch.yml 里把 '
        + 'comfyArgs 设为 [] 或改 comfyAttentionBackend 后重试'
      : ''
    launchMarkFailed(base + hint)
    log('error', `ComfyUI 启动失败：${launch.error}`)
  }, 1000)
  if (typeof timer.unref === 'function') timer.unref()
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-025（原 L912-921）
export function fatalLineInLog(text) {
  const FATAL = [
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-026（原 L924-932）
    /unrecognized arguments/i,
    /is already in use/i,
    /ModuleNotFoundError:/i,
    /ImportError:/i,
    /Traceback \(most recent call last\)/i,
    /Address already in use/i,
  ]
  const lines = String(text ?? '').split(/\r?\n/u).map((s) => s.trim()).filter((s) => s !== '')
  // 从后往前找：最后出现的错误最有代表性
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // 去掉 ANSI 颜色码再匹配（ComfyUI 的 [ERROR] 是带色的）
    const clean = lines[i].replace(/\u001B\[[\d;]*m/gu, '')
    // ★ 第二道闸：明确标了 INFO / WARNING / DEBUG 的行**一律不当致命** ——
    //   有些 INFO 行里恰好含关键词（那句 OpenGL 提示就是），靠前缀把它们挡掉。
    if (/^\[?(INFO|WARNING|DEBUG)\]?[\s:]/i.test(clean) && !/\[ERROR\]/i.test(clean)) continue
    if (FATAL.some((re) => re.test(clean))) return clean.slice(0, 300)
  }
  return ''
}

/** 读启动日志的尾部；读不到就返回空串（绝不抛错）。 */
export async function readLaunchLog(logPath) {
  if (!logPath) return ''
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    return String(text).slice(-2000)
  } catch {
    return ''
  }
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-027（原 L964-970）
export function parseImportTimes(logText, topN = 5) {
  if (typeof logText !== 'string' || logText === '') return null
  const clean = String(logText).replace(/\x1b\[[0-9;]*m/gu, '')
  const m = clean.match(/Import times for custom nodes:([\s\S]*)/u)
  if (!m) return null
  const out = []
  for (const mm of m[1].matchAll(/([\d.]+)\s+seconds?\s*(\(IMPORT FAILED\))?:\s*(.+)$/gmu)) {
    const pack = String(mm[3]).trim().split(/[\\/]/).pop() || String(mm[3]).trim()
    out.push({ seconds: Number(mm[1]) || 0, failed: mm[2] !== undefined, pack })
  }
  if (out.length === 0) return null
  const slowest = [...out].sort((a, b) => b.seconds - a.seconds).slice(0, Math.max(1, topN))
  return {
    packs: out.length,
    failed: out.filter((x) => x.failed).length,
    totalSeconds: Math.round(out.reduce((s, x) => s + x.seconds, 0) * 10) / 10,
    slowest,
  }
}

/** 就绪时把逐包耗时写进日志（「为什么加载慢」的数据面）；失败静默，绝不拖累就绪路径。 */
async function reportSlowImports(logPath, log) {
  try {
    const text = await readLaunchLog(logPath)
    const r = parseImportTimes(text)
    if (!r || typeof log !== 'function') return
    const line = '启动逐包加载：'
      + r.slowest.map((x) => `${x.pack} ${x.seconds}s${x.failed ? '（导入失败）' : ''}`).join('，')
      + ` —— 共 ${r.packs} 包 / 合计 ${r.totalSeconds}s / 导入失败 ${r.failed}`
      + '（包 import 快 ≠ 整体就绪快：torch/ROCm 初始化与权重扫描发生在 import 之前/之后，均计入总就绪时长）'
    log('info', line)
  } catch {
    /* 诊断失败不影响任何主路径 */
  }
}

// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-028（原 L1007-1015）

/**
 * ★ 探活；没开就**隐藏启动**并等它就绪 —— 需求方要求后端完全不可见、且全自动。
 * 配合空闲关停：出图前自动拉起、闲置 5 分钟自动关掉，全程不需要用户动手。
 */
export async function ensureComfyUp(cfg, log, signal) {
  try {
    await assertComfyUp(cfg, signal)
    // ★ 规则②：一开始就在线 —— 直接置 ready，别留下任何过期的启动态
    launchMarkReady()
    // ★ 2026-10-10（提速 M8）：预热能力探测（fire-and-forget）。
    //   命中缓存时是空操作；未命中时提前把 10 次 /object_info 的往返做掉，
    //   这样下面 runDraw 里的 probeCapabilities 直接命中缓存，不占关键路径。
    probeCapabilities(cfg, log, signal).catch(() => {})
    // ★ 2026-11-14（C14）：提交前查一次队列 / 显存水位，紧张时留一句预警。
    //   fire-and-forget：结果不参与出图决策，探不到也不影响出图 ——
    //   这个函数是「每次出图必经、且已确认服务可用」的唯一位置，放这里不会重复探活。
    warnQueueGate(cfg, log, signal, { fetchFn: fetchWithTimeout }).catch(() => {})
    return
  } catch (error) {
    if (cfg.autoStartComfy === false) throw error
    log('info', 'ComfyUI 没在跑 → 后台隐藏启动它')
  }
  await startComfyHidden(cfg, log)
// 设计说明已外置 → docs/comfy-launch-design-notes.md#comfy-launch-note-029（原 L1040-1043）
  if (launch.phase === 'failed') {
    throw new Error(launch.error || 'ComfyUI 启动失败（进程未能拉起）')
  }
  // ★ 等待上限：默认 240 秒（首次要加载十几 GB 模型，慢是正常的）。
  //   ★ 单调钟计时（2026-11-18 审计）——NTP 回拨会让墙上时钟等待变成"永不超时"。
  const started = performance.now()
  //   它**只决定 `ensureComfyUp` 这个调用等多久**；界面上"启动中"的显示上限
  //   由 LAUNCH_TIMEOUT_MS（120 秒）独立决定 —— 两者职责不同，不要混。
  const limit = Number(cfg.startTimeoutMs ?? 240000)
  for (;;) {
    // 监视器（watchLaunchedProcess）可能已把状态置成 failed/timeout → 立即结束，不再空等。
    if (launch.phase === 'failed' || launch.phase === 'timeout') {
      throw new Error(launch.error || 'ComfyUI 启动失败')
    }
    if (performance.now() - started > limit) {
      // 只在仍处"启动中"时才置超时 —— 避免把已经明确的"失败"覆盖成"超时"。
      if (launch.phase === 'starting') {
        launchMarkTimeout(
          `等待 ${Math.round(limit / 1000)} 秒仍未就绪（首次要加载十几 GB 模型，可能更久）`,
        )
      }
      throw new Error(
        `已在后台启动 ComfyUI，但 ${Math.round(limit / 1000)} 秒内没就绪（首次要加载十几 GB 模型，可能更久）。`
        + '稍等一会儿再让我画一次即可。若一直不行，可在左下角状态点菜单里点「启动 ComfyUI」重试，'
        + '或手动启动你机器上的 ComfyUI。',
      )
    }
    if (signal?.aborted) throw cancelReason(signal)
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      await assertComfyUp(cfg, signal)
      // ★ 规则②：探到通就置 ready —— **就地**改，不指望别人擦屁股。
      //   （之前这里只 log 不改状态，是"永远卡在启动中"的直接原因。）
      launchMarkReady()
      // ★ 2026-11-19：这里原先是 `Date.now() - started`，而 started 是 performance.now()——
      //   两个钟混减，"等了 N 秒"打出来是天文数字（挂账 ⑦Date.now 排查的一处）。统一单调钟。
      log('info', `ComfyUI 已就绪（等了 ${Math.round((performance.now() - started) / 1000)} 秒）`)
      await reportSlowImports(launch.logPath, log)
      // ★ 2026-10-10（提速 M8）：刚起来就预热能力探测，别等第一次出图才探 10 次。
      probeCapabilities(cfg, log, signal).catch(() => {})
      return
    } catch {
      /* 还在加载，继续等 */
    }
  }
}

/** 探活：ComfyUI 在不在，不在就给一句能照做的提示。 */
export async function assertComfyUp(cfg, signal) {
  try {
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 8000, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    throw new Error(
      `连不上本机 ComfyUI（${cfg.comfyUrl}）：${error?.message ?? error}\n` +
        '请先启动 ComfyUI（例如双击你本机 ComfyUI 的启动入口），' +
        '等服务起来后再让我画一次。',
    )
  }
}
