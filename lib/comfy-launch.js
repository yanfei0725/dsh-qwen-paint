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
import { diag } from './diag.js'

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

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-09 **完全重写**：启动状态机（单一真相源）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要推倒重来
 *   之前是三轮补丁叠出来的，结果**两套状态并行**：
 *     · `launchState`（我在 2026-10-09 加的）
 *     · `comfyStartRequestedAt`（更早的"90 秒内算启动中"时间戳）
 *   两者都在决定 `starting`，互相覆盖，谁也说不清最终值。主人反复看到
 *   "一直卡在启动中"就是这么来的 —— 那是**状态机本身坏了**，不是某个判断写错。
 *
 * ## 现在的设计（就三条规则，没有例外）
 *   ① **只有一个事实来源**：`probe()` 探活的结果 + `phase`。
 *      `starting` 只由 `phase === 'starting'` 决定，**没有第二套时间戳**。
 *   ② **在线就是在线**：任何时刻探到通，phase 立刻变 `ready`，
 *      启动窗口、失败原因、计时全部清空 —— 不允许残留状态把界面卡住。
 *   ③ **窗口必然收口**：`starting` 有个硬性截止时间（`LAUNCH_TIMEOUT_MS`，现为 120 秒）。
 *      到点还没通 → 变 `failed`（带原因）。**绝不会无限停在 starting。**
 *
 * ## 状态流转（穷举，没有别的可能）
 *   idle ──start()──▶ starting ──探到通──▶ ready
 *                        │
 *                        ├─ 日志出现致命错 ──▶ failed
 *                        ├─ 进程消失 ────────▶ failed
 *                        └─ 超过 LAUNCH_TIMEOUT_MS ─▶ timeout
 *   ready ──探到不通──▶ idle（回到起点，下次可再启动）
 */
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

/**
 * ★★★ 2026-10-13（任务 #62②「SageAttention 崩溃自动回退」）：判断这次启动失败
 * **是否由 `--use-sage-attention` 引起**。
 *
 * ## 为什么需要它
 *   启动失败的原因很多（端口被占、依赖缺失、显存不够…），**不能**一概归咎于 SageAttention。
 *   只有日志**明确指向 sage-attention** 时才认 —— 否则会误关用户想要的功能。
 *
 * ## 判据（宁可漏判、不可误判）
 *   · `unrecognized arguments` + 提到 sage-attention —— argparse 不认这个参数（版本太老）
 *   · `No module named 'sageattention'` —— 硬依赖没装却强制开了（auto 档永远不会走到这）
 *   · 提到 sage_attn / sageattention + 编译 / sm_120 / build 失败 —— Blackwell 构建不匹配
 *   · 日志里 sage-attention 与 ImportError / ModuleNotFoundError / Traceback 同时出现
 */
export function launchFailedDueToSage(tail) {
  const t = String(tail ?? '').toLowerCase()
  if (/unrecognized arguments/i.test(t) && /sage[-_]?attention/i.test(t)) return true
  if (/no module named ['"]?sageattention/i.test(t)) return true
  if (/(sage[-_]?attn|sageattention).{0,80}(not compiled|sm_120|build|error)/i.test(t)) return true
  if (/sage[-_]?attention/i.test(t) && /(importerror|modulenotfounderror|traceback)/i.test(t)) return true
  return false
}

/**
 * 归咎于 SageAttention 时，在本会话内自动关掉它，避免崩溃循环。
 * ⚠ **只改内存中的 cfg**（与界面开关的持久化策略一致：面板开关也只改内存、不写盘）。
 *   要永久关闭，需在 cordis.patch.yml 把 `nvidiaSageAttention` 设成 false。
 * @returns {boolean} 是否真的做了禁用（已关则返 false，避免重复日志）。
 */
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
  const starting = launch.phase === 'starting' && Date.now() - launch.startedAt < LAUNCH_TIMEOUT_MS
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

/**
 * ★★★ 2026-10-12 抽出：**构造 POSIX（Linux / macOS）下的 ComfyUI 启动命令**。
 *
 * ## 为什么要抽成纯函数
 *   这段逻辑（尤其是**引号转义**）此前内联在 `ensureComfyUp` 里，
 *   于是它**永远没法被单测** —— 而它恰恰是最容易写坏的一处：
 *   启动命令要穿 `sh -c` → `sh -c` → `exec` 三层引号，写错一个字符就是
 *   "命令返回成功、但什么都没发生"（本项目已踩过一次同类坑）。
 *   本轮给它加了**环境变量注入**（macOS 的 MPS 两个变量），风险更高 ⇒ 必须能测。
 *   抽成纯函数后由 `_mac_env_test.mjs` **真起一个 sh 跑一遍**，
 *   断言变量确实传到了子进程里。
 *
 * ## 引号约定（照原样保留，别改）
 *   `q()` 用单引号包裹，内部单引号转义成 `'\''`。
 *   外层 `sh -c ${q(wrapped)}` 会把 `wrapped` 里的引号再转义一层 ——
 *   最终由**最内层**的 sh 解析出正确命令。这是本项目已验证的写法。
 *
 * ## 环境变量为什么用 `export K=V; exec ...`
 *   POSIX 下 `exec` 是**特殊内建**：`exec K=V cmd` 里的 `K=V` 会被当成 exec 的
 *   **第一个操作数（命令名）**，语义不明确。先 export 再 exec 是无歧义的写法。
 *
 * @param {object} o
 * @param {string} o.py        python 解释器路径
 * @param {string[]} o.args    传给 python 的参数（含 main.py）
 * @param {string} o.pidFile   写 pid 的文件（`$$` 即真正执行者的 pid，exec 不换 pid）
 * @param {string} o.logPath   启动日志路径（stderr/stdout 重定向目标）
 * @param {Array<[string,string]>} [o.launchEnv] 要注入的环境变量
 * @param {boolean} [o.useSetsid] 有 setsid 时用 `setsid --fork`，否则退回 `nohup ... &`
 */
export function buildPosixLaunchCommand({ py, args, pidFile, logPath, launchEnv = [], useSetsid = false }) {
  const q = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
  const inner = [py, ...args].map(q).join(' ')
  const envExport = launchEnv.map(([k, v]) => `export ${k}=${q(v)};`).join(' ')
  // ★★★ 2026-10-12 **修 bug（真事故，且 macOS 上必然踩到）**：
  //   原写法是 `sh -c 'echo $$ > ${q(pidFile)}; exec ${inner}'` —— 用**手写引号**
  //   去包内层脚本。问题在于：内层脚本里那些 `q()` 产生的单引号，会和手写的
  //   外层引号**互相配对**，被外层 shell"抹平"（引号只做分组、不进最终文本），
  //   于是内层 sh 收到的是**没有引号的裸命令**。
  //   实测（Git Bash 的 sh，本机复现）：
  //     `exec 'sh' '-c' 'echo hi'` → 内层变成 `exec sh -c echo hi`
  //     ⇒ `sh -c echo`（`hi` 成了 $0）⇒ 什么都没跑、只吐一个空行；
  //     含空格的路径 `> '/tmp/a b/x.pid'` → 内层变成 `> /tmp/a b/x.pid`
  //     ⇒ 重定向到 `/tmp/a`、多出一个参数 ⇒ **路径带空格就彻底失效**。
  //   ⇒ 修法：**不要手写外层引号**，整段内层脚本用 `q()` 正规转义一层。
  //     这样外层 shell 把脚本**原样**交给内层 sh，内层再按它自己的引号解析 —— 两层的
  //     引号各自独立、互不干扰。`q()` 的 `'\''` 转义会让这段文本安全穿过两层。
  //   ⚠ 这一条对 macOS 尤其重要：Mac 上 ComfyUI 常装在
  //     `/Users/<名字>/My ComfyUI` 这类**带空格**的路径下。
  const innerScript = `echo $$ > ${q(pidFile)}; ${envExport}${envExport ? ' ' : ''}exec ${inner}`
  const wrapped = `sh -c ${q(innerScript)}`
  const cmd = useSetsid ? `setsid --fork sh -c ${q(wrapped)}` : `nohup sh -c ${q(wrapped)} &`
  return { wrapped, cmd, full: `${cmd} >${q(logPath)} 2>&1 < /dev/null &` }
}

/**
 * ★★★ 2026-10-09 新增：由**父进程 pid** 找出真正在跑 ComfyUI 的子进程 pid。
 *
 * ## 为什么必须这么做（Windows / Linux 踩到了同一个坑）
 *   启动 ComfyUI 时中间隔了一层"壳"：
 *     · Windows：`Win32_Process.Create` 起的是 **cmd.exe**，python 是它的子进程；
 *     · Linux  ：`setsid` 起的是 **sh / setsid**，python 也是子进程。
 *   拿这层壳的 pid 去做"进程还在不在"的存活检查是**错的** ——
 *   壳的死活跟 ComfyUI 的死活不是一回事。
 *   后果：进程明明活着却被判"已退出"（或反之），
 *   界面表现正是主人反复看到的**"一直卡在启动中"**。
 *
 * ✓ 正解：按**父子关系**找出真正的 python。查不到就返回 0 ——
 *   调用方会退化成"只靠探活判断"，那也远比盯错一个进程靠谱。
 */
export async function resolveChildPid(parentPid, log) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return 0
  try {
    // ★ 关键：**不能只查一层子进程**。
    //   实测链路是 `WMI → cmd.exe → (可能还有一层) → python`，
    //   只查直接子进程经常扑空（日志里就记着"定位子进程失败（父 8980）"）。
    //   所以改成**按命令行全表搜**：谁的命令行含 main.py 且 pid 命中，
    //   就取谁 —— 这比顺着父子关系爬更稳，也省掉"中间隔了几层"的不确定性。
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

export async function startComfyHidden(cfg, log) {
  // ★★ 2026-10-07 实测修正：**绝对不能用 pythonw.exe**！
  //    它没有控制台、sys.stdout 是 None，而 ComfyUI 启动时会大量 print ——
  //    一打印就抛异常、进程立刻退出。现象是出图报「240 秒内没就绪」，实际上
  //    python.exe 11 秒就能起（实测：pythonw 那次 8188 不在听、python 进程一个都没有）。
  //    正确组合 = python.exe + -WindowStyle Hidden：窗口藏住、输出流仍在。
  // ★ 2026-10-09（通用化）：路径不再写死 —— 先看配置，再自动探测。
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
    // ★★★ 2026-10-11：**A 卡专属优化（可选，默认关）** —— 与"厂商专属优化"同一套思路。
    //   两项都是**质量中性**的（换后端 / 改加载时机，都不改计算结果）：
    //     · `amdKernel`        —— 换本代的替代注意力内核（按代数挑 flag，见 AMD_KERNEL_FLAG）
    //     · `amdAsyncOffload`  —— `--async-offload`（N 卡默认开、A 卡默认关，这里补上）
    //   ⚠ 默认**一个都不加** —— 没实测过的卡上绝不擅自改默认路径。
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

  // ★★★ 2026-10-11 新增：**N 卡 SageAttention**（40 系 Ada / 50 系 Blackwell 的专属加速）。
  //   ⚠ `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，ComfyUI 直接起不来。
  //   ⇒ 三档（见 DEFAULTS.nvidiaSageAttention）：
  //        true  → 强制挂（用户确认装了）
  //        false → 永不挂
  //        auto / 未设 → **只在后台自检确认已装时**才挂；状态未知时**不加**（保守）
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

  // ★★★★ 2026-10-09：**显存驻留参数** —— 整条工作流 90 秒的真正解药。
  //   实测（6 笔出图逐笔拆解）：**非采样开销平均 36.99 s，占总耗时 40.7%**。
  //   时间不是花在"画画"（采样仅 8~11 s），而是把 13.58 GB 模型
  //   （TE 6019 + UNET 6920 + VAE 644）反复搬进显存；ComfyUI 全程只启动过 1 次，
  //   所以这不是冷启动问题，是模型被反复卸载又加载。
  //   对照：模型已在显存的那笔采样只要 15 s，需要全量加载的要 45~124 s（差 3~8 倍）。
  //   ⇒ 按显存总量选档：≥24 GB 用 `--highvram`；≥16 GB 用 `--highvram` + 极少保留；
  //     <16 GB 不加（强行 highvram 会 OOM，退化成更糟的换页）。
  //   ★ 保留量 1.5 GB → 0.5 GB：19.98 GB 里 13.58 GB 是模型，再扣 1.5 GB 后激活装不下，
  //     ComfyUI 会把模型切成 150+ 块换页，采样从 15 s 涨到 45 s。
  //   ⚠ 这是**权衡值**（取决于本机桌面占多少显存），且仅在未显式配 comfyArgs 时介入。
  const VRAM_ARGS = resolveVramArgs({
    mode: cfg.vramMode,
    vramGB: gpu.vramGB,
    isMac: IS_MAC,
  })

  const useAutoArgs = !Array.isArray(cfg.comfyArgs)
  const finalArgs = useAutoArgs ? [...autoArgs, ...VRAM_ARGS.args] : cfg.comfyArgs
  if (useAutoArgs && VRAM_ARGS.note) log('info', `显存驻留：${VRAM_ARGS.note}`)

  const extraArgs = finalArgs
  log('info', `启动参数：${extraArgs.length > 0 ? extraArgs.join(' ') : '(无额外参数)'}`)
  const args = [
    '-s', mainPy,
    // --windows-standalone-build 只对 Windows 便携包有意义；Linux 上不加（无意义，个别版本还会挑刺）
    ...(IS_WINDOWS ? ['--windows-standalone-build'] : []),
    '--disable-auto-launch',
    ...extraArgs,
  ]

  // ★★★ 2026-10-12 新增：**给 ComfyUI 进程注入环境变量**（此前插件**一个都不注入**）。
  //
  // ## 为什么需要（这是 macOS 端"零优化"的第二块拼图）
  //   PyTorch 的 MPS 行为**没有命令行开关**，只能通过环境变量调
  //   （官方文档 "MPS Environment Variables"）。最要紧的一个是
  //   `PYTORCH_ENABLE_MPS_FALLBACK`：MPS 后端未实现的算子自动回退 CPU。
  //   没有它时，链路里碰到一个未实现的算子，**整次出图直接抛错**（不是慢一点，是失败）。
  //
  // ## 两个变量的来源与取舍
  //   · 档案级默认（`gpu.env`）—— 目前只有 Mac 三档带，值是 PYTORCH_ENABLE_MPS_FALLBACK=1；
  //   · 用户开关（见 DEFAULTS.appleMpsFallback / appleMpsUnlimitedMem）——
  //     前者能**关掉**档案默认，后者能**加上** `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
  //     （取消 MPS 分配器的硬上限，让大模型能在小内存 Mac 上跑；默认关，因为
  //      取消上限后系统级 OOM 会连系统一起拖垮 —— 那是"用稳定性换可用性"的取舍）。
  //
  // ⚠ 只在 macOS 注入：其它平台没有 MPS 后端，注入了也只是噪音。
  //   所以 Windows 上 `launchEnv` 恒为空 —— 下面两条启动路径都因此不受影响。
  const launchEnv = (() => {
    if (!IS_MAC) return []
    const pairs = Object.entries(gpu.env ?? {}).map(([k, v]) => [k, String(v)])
    const kept = cfg.appleMpsFallback === false
      ? pairs.filter(([k]) => k !== 'PYTORCH_ENABLE_MPS_FALLBACK')
      : pairs
    if (cfg.appleMpsUnlimitedMem === true) {
      kept.push(['PYTORCH_MPS_HIGH_WATERMARK_RATIO', '0.0'])
    }
    return kept
  })()
  if (launchEnv.length > 0) {
    log('info', `注入环境变量：${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
    diag('start', `env ${launchEnv.map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  // ★★★★ 2026-10-09 重大修正：**把 spawn 换回"平台原生派生进程"**。
  //
  // ## 为什么（实测结论，不是推测）
  //   我上一轮为了"修复 Linux 上没有 Start-Process"而改成 Node 的 `spawn`，
  //   结果**把 Windows 上也搞坏了** —— 本机实测三种方式启动同一个 ComfyUI：
  //     · PowerShell `Start-Process`            → ✅ 进程存活、8188 正常监听
  //     · `spawn(detached: true)` + unref()     → ❌ 进程随即消失
  //     · `spawn()`（普通、不 detached）         → ❌ 进程随即消失
  //   端口空着、无并发冲突，两种 spawn 都是"起来了又没了"。
  //   而 DSH 宿主（Electron）不是控制台进程，Node 在这种宿主里派生的子进程
  //   很容易随宿主的活动/作业对象被回收 —— 这正是主人遇到的"后端拉不起来"。
  //
  // ## 现在的做法：各平台用各自的"脱离式启动"
  //   · Windows：`Start-Process -WindowStyle Hidden` —— 它是**独立进程**，
  //     不属于 DSH 的作业对象，宿主重启也不会把它带走（这正是 2026-10-08 那条
  //     "DSH 重启后 ComfyUI 被连带杀死"的教训所指向的正解）。
  //   · Linux：`setsid ... &` —— 新会话（new session）里跑，
  //     同样脱离父进程的进程组，且 `setsid` 是 util-linux 标准组件，普遍都有。
  //
  // ## stderr 怎么办（这才是真正的难点）
  //   进程由 shell 派生，Node 拿不到它的 stderr 流了。所以改成
  //   **把 stderr 重定向到临时文件**，失败时回头读那个文件 —— 见下面的 readLaunchLog。
  //   不能像以前那样用 spawn 的 'pipe'：那个方案正是让进程活不下来的原因。
  const launchLog = path.join(comfyDirsFrom(found).base, '.dshqp-launch.log')
  let childPid = 0
  try {
    if (IS_WINDOWS) {
      // ★★★★ 2026-10-09 实测：**唯一可靠的拉起方式**（试了五种）。
      //   ① Start-Process（会话内）✅　② 再包一层 shell ❌ 进程被父 shell 收走
      //   ③ Node spawn(detached) ❌　④ WMI + 内联长命令 ❌ 引号被吃、没跑
      //   ⑤ **写 .cmd 文件 + WMI 创建该文件** ✅ 存活、8188 正常监听 ← 采用这个
      //   为什么：WMI 由服务端直接派生，不属于任何 shell / DSH 作业对象，父 shell 退出与
      //   DSH 重启都不会带走它（顺带解决"重启后 ComfyUI 被连带杀死"）；走 .cmd 文件则绕开
      //   **多层引号嵌套**（内联写法里路径带空格/反斜杠时，引号会被各层 shell 各吃一层
      //   → 表现为"返回成功但什么都没发生、日志也不生成"）。
      //   stderr 仍保留：.cmd 里用 `>` 重定向写日志，失败时由 readLaunchLog 读回来。
      //
      // ★ 另一个修正：**pid 不能拿 WMI 返回的那个** —— 那是 cmd.exe 的 pid，真正跑
      //   ComfyUI 的是它启动的 python（子进程）。用 cmd 的 pid 做存活检查会直接失真。
      //   ⇒ 靠**父子关系**反查真实 python pid（见 resolveChildPid）。
      const batPath = path.join(comfyDirsFrom(found).base, '.dshqp-launch.cmd')
      // ★ 2026-10-12：环境变量（若有）以独立 `set` 行写在启动命令**之前**。
      //   后面的 `> "${launchLog}" 2>&1` 重定向只作用于最后一行（即真正的启动命令），
      //   这正是我们要的 —— set 行本身不需要重定向。
      //   ⚠ 目前 Windows 上 launchEnv 恒为空（见上面的 IS_MAC 闸），这条是**为将来留的**：
      //     真要在 Windows 上注入变量时不必再改这里。
      const line = [
        ...launchEnv.map(([k, v]) => `set ${k}=${v}`),
        [py, ...args].map((a) => `"${String(a)}"`).join(' '),
      ].join('\r\n')
      // ★★★★ 2026-10-09 新增（主人要求「每次拉起后端时自动最小化窗口，别让人再手动点掉」）：
      //   `cmd.exe /c` 会在桌面弹一个控制台黑窗，且**不会自己消失**
      //   （python 一直在前台跑，cmd 得等着它）→ 每次启动后端都要人手动点掉。
      //
      // ## 做法：启动 python **之前**，用 powershell 把控制台窗口最小化
      //   时序是关键：必须在 `line`（启动 python）之前。放到后面的话，
      //   python 已占住前台，那条命令要等 ComfyUI 退出才执行 —— 等于没用。
      //
      // ## 为什么把 PowerShell 脚本放**独立文件**而不是内联
      //   内联 `.cmd` 里嵌 PowerShell 要穿四五层引号（cmd → powershell → C# 签名），
      //   实测极易被吃坏。改成独立 .ps1 后 **零引号嵌套**，只需 `-File` 一个参数。
      //
      // ## ⚠⚠ 写 .ps1 的硬性约束（四次实测才搞明白，务必保留）
      //   **.ps1 必须是纯 ASCII！** PowerShell 5.1 在没有 BOM 时按 ANSI 读 .ps1，
      //   中文注释会被解成乱码 → 解析错位 → 报**完全不相干的行**上
      //   `表达式或语句中包含意外的标记"}"`（ParserError: UnexpectedToken）。
      //   我为此白折腾了三轮。所以下面用 fsp.writeFile 写**英文注释**的 ps1。
      //
      // ## 为什么选 SW_MINIMIZE(6) 而不是 SW_HIDE(0)
      //   隐藏后用户在任务栏找不到入口，ComfyUI 万一卡住他想看日志都看不到；
      //   最小化只是收进任务栏 —— 不碍事，但需要时点一下就能看。
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
      // ══ Linux / macOS ══
      // ★★★ 2026-10-09 修正（**真 bug**）：原先写的是
      //     `setsid nohup <cmd> & echo $!` —— 那样拿到的 `$!` 是 **setsid 的 pid**，
      //     而 setsid 会立刻 exec 成目标进程……**大多数情况下没问题，但并不总是**：
      //     setsid 若是 fork 后再 exec（util-linux 在某些场景下会），
      //     真正跑 ComfyUI 的是**它的子进程**，用 setsid 的 pid 去做存活检查就会查错对象
      //     → 进程明明活着却被判"已退出" → 界面报"启动失败"。
      //
      //   ✓ 现在改用 `--fork` 明确的语义 + **用 pid 文件**回报真实 pid：
      //     `setsid --fork` 让 setsid 直接返回、目标进程独立成会话首进程；
      //     再加 `sh -c 'echo $$ > pidfile'` 把**真正执行者的 pid** 写出来。
      //     这样无论 setsid 怎么实现，我们盯的都是那个真正在跑的 shell（及其子进程）。
      //
      //   ⚠ `--fork` 是 util-linux 的写法；macOS 的 setsid 没有这个选项（其实 macOS
      //     根本没有 setsid 命令），所以下面做了**能力探测**，没有 setsid 时退回
      //     `nohup ... &`（macOS 上够用：nohup 已能免疫挂断信号）。
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

/**
 * 看着刚拉起的进程：它要是**提前死了**，就判失败并把日志里的原因摘出来。
 *
 * ★ 为什么不能用 `child.on('exit')`：改用 Start-Process / setsid 之后，
 *   进程由 shell 派生，Node 这边**没有它的句柄**，自然会收不到 exit 事件。
 *   所以退回到"定时看它还在不在" —— 简单、跨平台、且不依赖任何句柄。
 *
 * ⚠ 只在 state === 'starting' 期间工作，一旦就绪（或超时）立刻自行退出，
 *   不会变成常驻轮询、也不会和状态端点重复请求 ComfyUI 接口。
 */
export function watchLaunchedProcess(cfg, log, pid) {
  // ★★★ 不再因为 pid<=0 就整个放弃监视。
  //   拿不到可靠 pid 时仍要盯着：**探活 + 日志**这两条路一样能判断成败，
  //   而且它们才是权威事实。只有"进程存活查询"这一步会被跳过（见循环里）。
  const hasPid = Number.isSafeInteger(pid) && pid > 0
  let checks = 0
  const timer = setInterval(async () => {
    checks += 1
    // 已经就绪 / 已经判过失败 / 已经查够次数（LAUNCH_TIMEOUT_MS ÷ 1 秒）→ 收摊
    if (launch.phase !== 'starting' || checks > 46) {
      clearInterval(timer)
      return
    }

    // ★★★ 2026-10-09 竞态防护：**先确认它真的还没就绪**，再谈失败。
    //   实测踩到过：ComfyUI 明明 9 秒就绪了，但日志里那句
    //   「No OpenGL_accelerate module loaded」被误判成致命错 → 状态被设成 failed，
    //   而进程其实活得好好的、端口也通了。用户看到的就是"报错了但明明能用"。
    //   所以每轮先探一次活；**只要在线就立刻收摊并置为 ok**，根本不给误判机会。
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
      if (res.ok) {
        clearInterval(timer)
        launchMarkReady()
        if (typeof log === 'function') log('info', 'ComfyUI 已就绪（启动监视结束）')
        return
      }
    } catch {
      /* 还没起来，继续往下判 */
    }

    // ★★★ 2026-10-09（主人要求：「如果直接启动失败你就直接报错，不要干等超时」）：
    //   **先查日志**再查进程 —— 日志里一旦出现致命错误，立刻报错并收摊，
    //   根本不用等进程真的死掉、更不用干等到超时。
    //   典型：`unrecognized arguments`（参数被拒）、`Port 8188 is already in use`
    //   （端口被占）、`ModuleNotFoundError`（依赖缺失）—— 这些一出现就注定失败。
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

    // ★★★ 再看进程还在不在。
    //   ⚠⚠ 这里有个**必须守住的前提**：pid 无效时**绝不能**做存活判断。
    //   实测踩到：`resolveChildPid` 没定位到时 pid=0，而 `Get-Process -Id 0`
    //   必然失败 → `alive=false` → **立刻被判成"进程已退出"** →
    //   界面报"启动失败"，可 ComfyUI 其实正在正常加载。
    //   （这正是主人反复看到"卡在启动中/启动失败"的直接原因之一。）
    //   ✓ 拿不到可靠 pid 时**跳过存活判断**，把结论完全交给"探活 + 日志"——
    //     探活才是唯一权威的事实来源。
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

/**
 * ★ 2026-10-09 新增：从日志里找出「注定失败」的那一行，找到就立刻报错、不等超时。
 *
 * 为什么需要它：有些失败**压根不会让进程立刻退出**（例如端口被占时，
 * 有的版本是先打印 ERROR 再自己退），也可能进程挂着不动。
 * 与其干等到超时，不如一看到这些关键字就当场判定 ——
 * 主人明确要求「如果直接启动失败你就直接报错，不要干等超时」（超时值见 LAUNCH_TIMEOUT_MS）。
 *
 * ⚠ 关键字只挑**确定致命**的，不能把普通 WARN 也算进来（否则会误报失败）。
 */
export function fatalLineInLog(text) {
  const FATAL = [
    // ⚠ 只放**真正致命**的。每条都是踩坑后收进来的：
    //   · `unrecognized arguments` —— argparse 拒绝参数，进程当场退
    //   · `is already in use`      —— 端口被占，起不来
    //   · `ModuleNotFoundError:`   —— **必须带冒号**
    //   · `ImportError:`           —— **必须带冒号**
    //   ⚠⚠ 绝不能写成泛化的 /No module named/ —— ComfyUI 正常启动时会打
    //      「No OpenGL_accelerate module loaded: No module named 'OpenGL_accelerate'」，
    //      那只是一句 INFO（可选加速模块没装），**完全不影响运行**。
    //      实测：这行误判把一次**成功**的启动报成了"启动失败"，是本文件最阴的坑。
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

/**
 * ★ 2026-10-09：**不再需要 `startComfyHiddenWith`（spawn 版的重试入口）**。
 *
 * 它当初是为"参数被拒就降级重试"抽出来的，但用的是 `spawn` —— 而实测已证明
 * spawn 在本机（DSH/Electron 宿主里）起的 ComfyUI 会立刻消失。
 * 参数降级的能力**并没有丢**：现在由状态端点里的超时/退出判定 + 菜单里的
 * 「点此重试」按钮承担 —— 用户去掉注意力参数（`comfyArgs: []`）或点重试即可，
 * 比自动重试更可控，也不会在后台悄悄多起一个进程。
 */

/**
 * ★ 探活；没开就**隐藏启动**并等它就绪 —— 主人要求后端完全不可见、且全自动。
 * 配合空闲关停：出图前自动拉起、闲置 5 分钟自动关掉，全程不需要主人动手。
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
    return
  } catch (error) {
    if (cfg.autoStartComfy === false) throw error
    log('info', 'ComfyUI 没在跑 → 后台隐藏启动它')
  }
  await startComfyHidden(cfg, log)
  // ★★★ 2026-10-10 修 bug：`startComfyHidden` 在 spawn 失败时是 **`launchMarkFailed()` + `return`**
  //   （**不抛错**），原代码无法区分"已拉起"与"拉起即失败"，于是照样进等待循环、空等满 240 秒，
  //   到点还会把已经明确的 `failed` **覆盖成 `timeout`**（用户看到的失败原因被抹掉）。
  //   ⇒ 补一道：启动已判失败就当场抛，保留原因。
  if (launch.phase === 'failed') {
    throw new Error(launch.error || 'ComfyUI 启动失败（进程未能拉起）')
  }
  const started = Date.now()
  // ★ 等待上限：默认 240 秒（首次要加载十几 GB 模型，慢是正常的）。
  //   它**只决定 `ensureComfyUp` 这个调用等多久**；界面上"启动中"的显示上限
  //   由 LAUNCH_TIMEOUT_MS（120 秒）独立决定 —— 两者职责不同，不要混。
  const limit = Number(cfg.startTimeoutMs ?? 240000)
  for (;;) {
    // 监视器（watchLaunchedProcess）可能已把状态置成 failed/timeout → 立即结束，不再空等。
    if (launch.phase === 'failed' || launch.phase === 'timeout') {
      throw new Error(launch.error || 'ComfyUI 启动失败')
    }
    if (Date.now() - started > limit) {
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
      log('info', `ComfyUI 已就绪（等了 ${Math.round((Date.now() - started) / 1000)} 秒）`)
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
        '请先启动 ComfyUI（例如双击 D:\\ComfyUI\\启动ComfyUI.bat，或先打开「小鲸鱼生图」），' +
        '等服务起来后再让我画一次。',
    )
  }
}
