/**
 * lib/comfy-accel.js —— 加速包的**探测与安装**子系统。
 *
 * ★★★ 2026-10-17 从 `lib/index.js` 拆出，**唯一原因**是体积：
 *   `lib/index.js` 涨到 263,997 B，**超过了 DSH Store 的单文件上限 262,144 B**
 *   （超限文件会被判"扫描面不完整"，等于审不到主文件 —— 对一个正在接受安全
 *   复核的插件来说，这比"体积大"本身严重得多）。
 *   这与当初把 `index.js` 拆出 `config.js`、再把 `config.js` 拆出 `describe.js`
 *   是**同一件事的第三次复发** —— 所以拆完必须有护栏：`scripts/selftest.mjs`
 *   的「发布体积护栏」会逐文件比对 262,144 B。**下次再涨会被它挡住**，
 *   不用等机器人拦下才发现。
 *
 * 拆分原则：**整块搬、不改一行逻辑**。本文件里的函数与搬走前逐字相同，
 * 只是给 `function` 加了 `export`；调用方（`lib/index.js`）改为 import。
 * 之所以挑这一块：它是**自洽**的（依赖全部来自 `./config.js` 与 node 内置模块），
 * 且**没有任何测试按名字引用它**，搬迁面最小。
 */
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  ACCEL_PACKS,
  ACCEL_SOURCES,
  IS_WINDOWS,
  SAGE_READY,
  detectGpuProfile,
  discoverComfyPaths,
  genericOptimizations,
  probeCapabilities,
  runShell,
} from './config.js'

export function packAppliesToOs(pack) {
  const list = pack.os ?? ['win32', 'linux', 'darwin']
  return list.includes(process.platform)
}

/** 存在性检查（不抛异常）。 */
export async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------- 多套下载方案（★ 2026-10-09）---- */

/**
 * ★★★ 每个加速包都给**一串候选下载源**，按顺序试，**任一套成功即止**。
 *
 * 为什么必须这样：用户环境千差万别 —— 公司网络挡 GitHub、pip 官方源不通、
 * 只有国内镜像可达、代理只放行部分域名、IPv6 抽风……**任何单一下载源都必然有人装不上**。
 * 多源 + 自动顶上，才是"通用包"该有的样子。
 *
 * ⚠ 全部源都失败也**不影响出图** —— 见 README「内置通用配置」一节：
 *   缺任何加速件都会自动降级到可用的链路，而不是报错罢工。
 */
export async function runInstallSource(source, env) {
  const q = IS_WINDOWS
    ? (s) => `'${String(s).replace(/'/gu, "''")}'`
    : (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
  /** 同一段命令在两个平台上的收尾差异（PowerShell 需要 & 调用符 + Out-String）。 */
  const wrap = (cmd, timeoutMs) => runShell(
    IS_WINDOWS ? `${cmd} 2>&1 | Out-String` : `${cmd} 2>&1`,
    timeoutMs,
  )

  const target = source.pipGit ?? source.pip
  if (target) {
    const args = ['-m', 'pip', 'install', '--upgrade', '--timeout', '15', '--retries', '1']
    if (source.index) args.push('-i', source.index)
    if (source.extraIndex) args.push('--extra-index-url', source.extraIndex)
    args.push(target)
    const exe = IS_WINDOWS ? `& ${q(env.py)}` : q(env.py)
    return await wrap(`${exe} ${args.map(q).join(' ')}`, 900000)
  }

  // ⚠ 与 probeAccelPack 里的 `custom_node` 分支同理：当前没有这类包，属**扩展预留**。
  if (source.gitClone) {
    if (!env.customNodes) throw new Error('没找到 custom_nodes 目录')
    const hasGit = await runShell(
      IS_WINDOWS
        ? "if (Get-Command git -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }"
        : 'if command -v git >/dev/null 2>&1; then echo YES; else echo NO; fi',
      15000,
    )
    if (hasGit.trim() !== 'YES') throw new Error('本机没有 git')
    const dest = path.join(env.customNodes, source.dirName ?? 'pack')
    return await wrap(`git clone --depth 1 ${q(source.gitClone)} ${q(dest)}`, 300000)
  }

  throw new Error('这套下载方案没有可执行的命令')
}

/** 从探测到的 ComfyUI 路径推出关键目录（custom_nodes 由 main.py 所在目录推）。 */
export function comfyDirsFrom(paths) {
  const base = path.dirname(paths.mainPy)
  return { base, customNodes: path.join(base, 'custom_nodes') }
}

/**
 * 探测单个加速包是否已就位。
 * · `custom_node` 类 → 先看 custom_nodes 下有没有对应目录（快，且不依赖 python 能起来）
 * · `pip` 类        → 只能问 python 能不能 `import`
 */
export async function probeAccelPack(pack, env, log) {
  // ⚠ 当前白名单里的包**全是 `pip` 类**，所以下面这个 `custom_node` 分支暂时走不到。
  //   保留它是为将来收录"只能靠 git clone 装"的自定义节点时不必再改这里。
  if (pack.kind === 'custom_node' && env.customNodes) {
    const dir = path.join(env.customNodes, pack.dirName ?? pack.id)
    if (await pathExists(dir)) {
      // ★ 目录存在还不够 —— `git clone` 中途失败会留下一个**空壳目录**，
      //   只看 "目录在不在" 会把它误判成"已经装好了"，以后再也不会重试。
      //   这里要求里面至少有一个条目。
      try {
        const entries = await fsp.readdir(dir)
        if (entries.length > 0) return true
      } catch {
        /* 读不了就当作没装，落到下面用 python 模块名再试一次 */
      }
    }
  }
  if (!env.py || !pack.pythonModule) return false
  // ★★★ 2026-10-09 修复（**真 bug，通用性**）：这里的脚本**必须按平台分叉**。
  //   原先是写死的 PowerShell 语法（`& '...'`、`Out-Null`、`$LASTEXITCODE`），
  //   而 `runShell` 在非 Windows 上走的是 `sh -c` —— `&` 是 shell 的**后台运算符**，
  //   整条命令会在 Linux/macOS 上语法错、被下面的 catch 吞掉、恒返回 false。
  //   后果不只是"显示未安装"：`autoSetupAcceleration` 会据此**反复尝试重装**，
  //   每次都失败 —— 用户看到的是"明明装了却一直说没装，还不停重试"。
  //   ⚠ 这正是 runShell 注释里警告过的"绕过它写 Windows 专有命令"那种错，
  //     我自己在别处写对了、在这一行漏了。
  const probeScript = IS_WINDOWS
    // PowerShell：模块能 import 就算装好了（`2>&1 | Out-Null` 是必须的 ——
    // 否则 ImportError 的堆栈会混进 stdout，把后面的 YES/NO 判断弄脏）。
    ? `& '${env.py.replace(/'/gu, "''")}' -c "import ${pack.pythonModule}" 2>&1 | Out-Null; `
      + "if ($LASTEXITCODE -eq 0) { 'YES' } else { 'NO' }"
    // POSIX：用 `>/dev/null 2>&1` 丢输出，按退出码判断。
    // ⚠ 路径整体加单引号，且**转义规则走 POSIX 版**（`'\''`）——
    //   这不是 `runInstallSource` 里那个按平台选引号的局部 `q`，
    //   这里已经确定是 POSIX 分支，直接用 POSIX 写法即可。
    //   不转义的话，路径带空格（如 `/home/a b/ComfyUI/venv/bin/python`）会被拆成两个参数。
    : `'${String(env.py).replace(/'/gu, "'\\''")}'`
      + ` -c 'import ${pack.pythonModule}' >/dev/null 2>&1 && echo YES || echo NO`
  try {
    const out = await runShell(probeScript, 40000)
    return out.trim() === 'YES'
  } catch (error) {
    log?.('warn', `探测加速包 ${pack.id} 失败：${error?.message ?? error}`)
    return false
  }
}

/**
 * 通用优化（与显卡无关）的**实际启用情况** —— 跟着能力探测结果走，不是一张静态清单。
 * 这样用户看到的"启用了什么"和真正提交的工作流永远一致。
 */
export async function probeAcceleration(cfg, log) {
  // ★ 三项探测互不依赖 → **并发**；其中 paths / caps 都有缓存，实际开销很小。
  const [gpu, paths, caps] = await Promise.all([
    detectGpuProfile(cfg, log),
    discoverComfyPaths(cfg, log),
    probeCapabilities(cfg, log).catch(() => null),
  ])
  const env = paths
    ? { py: paths.py, ...comfyDirsFrom(paths), from: paths.from }
    : { py: '', customNodes: '', base: '', from: '未找到' }

  // ★ 按当前操作系统过滤（见 packAppliesToOs 的说明）：Windows 与 Linux 各取自己那套
  const wanted = (gpu.packs ?? [])
    .map((id) => ACCEL_PACKS[id])
    .filter((pack) => pack && packAppliesToOs(pack))

  // ★ 各包探测同样互不依赖，而且**每个都要起一次 Python**（`import` 检查），
  //   串行在 N 卡上要白等好几秒 —— 并发跑。
  const packs = await Promise.all(wanted.map(async (pack) => ({
    id: pack.id,
    name: pack.name,
    installed: await probeAccelPack(pack, env, log),
    kind: pack.kind,
    repo: pack.repo,
    requires: pack.requires,
    why: pack.why,
    verified: pack.verified,
  })))
  const missing = packs.filter((p) => !p.installed)

  return {
    gpu: {
      id: gpu.id,
      label: gpu.label,
      detected: gpu.detected,
      source: gpu.source,
      args: gpu.args ?? [],
      tuning: gpu.tuning,
      note: gpu.note ?? '',
    },
    env,
    // 通用优化的**真实**状态（跟着上面那次能力探测走）
    generic: genericOptimizations(caps, cfg),
    caps: caps
      ? {
        level: caps.level,
        // ★ 必须带上：上层靠它区分"真的缺件"和"这次没探测成功"（后者不该显示成"未启用"）
        probeFailed: caps.probeFailed,
        cached: caps.cached,
        nodes: caps.nodes,
        models: caps.models,
        notes: caps.notes,
      }
      : null,
    packs,
    missing,
  }
}

/**
 * ★★★ 2026-10-09：**自动加速环境配置** —— 检测到缺哪个厂商专用加速包，就自动下载安装。
 *
 * 包内**只带下载器、不预置任何已下载的文件**，所以必须真的去网上取。
 *
 * 设计要点（都是刻意的）：
 *   · **不阻塞任何事**：插件加载后延迟再跑，且任何失败都只写日志，绝不影响出图；
 *   · **只装当前平台适用的**（`packAppliesToOs`）—— Windows 装 triton-windows，
 *     Linux 装官方 triton，装错了会顶掉正确的那个；
 *   · **只补缺失的**：已装的一律跳过（`installAccelPack` 内部也会再查一次）；
 *   · 顺序即 `packs` 数组顺序 —— 前置组件排在前面（Triton → SageAttention → Nunchaku）。
 */
export async function autoSetupAcceleration(cfg, log) {
  try {
    const report = await probeAcceleration(cfg, log)
    // ★ 2026-10-11：顺手把 SageAttention 的就绪状态记下来 —— 启动 ComfyUI 时要用它决定
    //   要不要挂 `--use-sage-attention`（**没装就挂上，ComfyUI 会直接起不来**）。
    //   放在这里是因为自检本来就跑在后台、且已经付过"起 Python 探测"的成本。
    {
      const sage = (report.packs ?? []).find((p) => p.id === 'sageattention')
      if (sage) SAGE_READY = sage.installed === true
    }
    if (report.missing.length === 0) {
      log('info', `加速环境自检：${report.gpu.label} 对应的专用加速包已全部就位`)
      return { ok: true, skipped: '都已就位', installed: [] }
    }
    log('info', `加速环境自检：发现 ${report.missing.length} 个缺失项（${report.missing.map((p) => p.id).join(', ')}）→ 开始自动下载`)
    const installed = []
    for (const pack of report.missing) {
      try {
        const result = await installAccelPack(pack.id, report.env, log)
        installed.push(result)
        // ★★★ 2026-10-11 修 bug：**装完立刻刷新** SageAttention 的就绪状态。
        //   原先只在探测时写一次，而探测跑在**安装之前** ⇒ 本次会话装了它，
        //   也要等**下次重启 DSH** 才生效；用户不重启就永远拿不到。
        if (pack.id === 'sageattention' && result.ok === true) SAGE_READY = true
        log('info', `${pack.name}：${result.ok ? '安装完成' : '安装未成功'}${result.skipped ? `（${result.skipped}）` : ''}`)
      } catch (error) {
        // 单个包失败不中断其余的，也不影响出图
        log('warn', `${pack.name} 安装失败（不影响出图）：${error?.message ?? error}`)
        installed.push({ ok: false, id: pack.id, error: String(error?.message ?? error) })
      }
    }
    return { ok: true, installed }
  } catch (error) {
    log('warn', `加速环境自检失败（不影响出图）：${error?.message ?? error}`)
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 安装一个加速包。
 *
 * ★ 安全边界（刻意设计成这样）：
 *   · 只接受 `ACCEL_PACKS` 白名单里的 id，**绝不接受任意 URL / 任意 pip 包名**；
 *   · 装之前先查一次是否已就位，已装就不动；
 *   · 失败**只返回错误，不回滚也不影响出图** —— 加速是锦上添花，不能反过来搞坏环境。
 */
export async function installAccelPack(packId, env, log) {
  const pack = ACCEL_PACKS[packId]
  if (!pack) throw new Error(`不认识的加速包：${packId}（只支持白名单内的 ${Object.keys(ACCEL_PACKS).join(' / ')}）`)
  if (!packAppliesToOs(pack)) {
    throw new Error(
      `${pack.name} 不适用于当前系统（${process.platform}）；它只支持：${(pack.os ?? ['全平台']).join(' / ')}`,
    )
  }
  if (!env.py) throw new Error('还没定位到 ComfyUI 的 python，无法安装')

  // 已经装好了就不动它
  if (await probeAccelPack(pack, env, log)) {
    return { ok: true, id: pack.id, name: pack.name, skipped: '已经装好了，未做改动' }
  }

  const sources = ACCEL_SOURCES[packId] ?? []
  if (sources.length === 0) throw new Error(`${pack.name} 没有配置任何下载方案`)

  // ★★ 逐套尝试，**任一套成功即止**；一套不通就自动顶上下一套。
  //    这是"避免因用户网络环境装不上"的核心（见 ACCEL_SOURCES 的说明）。
  const attempts = []
  for (const source of sources) {
    const label = source.label ?? '未命名源'
    log('info', `安装 ${pack.name}：尝试「${label}」`)
    try {
      await runInstallSource(source, env)
      // 用**重新探测**判定成败，而不是"命令没抛异常就算成功"——
      // runShell 只回 stdout、拿不到退出码，装失败也可能干干净净地退出。
      if (await probeAccelPack(pack, env, log)) {
        log('info', `${pack.name} 安装成功（来源：${label}）`)
        return { ok: true, id: pack.id, name: pack.name, via: label, attempts }
      }
      attempts.push({ source: label, ok: false, note: '命令跑完了，但复检仍未就位' })
      log('warn', `「${label}」跑完但复检未通过 → 换下一个源`)
    } catch (error) {
      attempts.push({ source: label, ok: false, note: String(error?.message ?? error) })
      log('warn', `「${label}」失败：${error?.message ?? error} → 换下一个源`)
    }
  }

  // 全挂了也要给一句能照做的话，并明确"不影响出图"
  return {
    ok: false,
    id: pack.id,
    name: pack.name,
    attempts,
    hint: `所有下载方案（共 ${sources.length} 套）都没成功。可稍后重试，或照 ${pack.repo} 手动安装。`
      + '**这不影响出图**：缺件会自动降级到可用的链路。',
  }
}
