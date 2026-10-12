/**
 * dsh-qwen-paint —— 让 DeepSeek Harness 在对话里直接调用本机 ComfyUI，用千问
 * （Qwen-Image 2.1）模型画图。
 * ============================================================================
 * 设计要点（都是照官方内核实现与主人的既有环境核过的，别凭感觉改）：
 *
 * ① **零外部依赖**：不 import `@deepseek-ai/dsh-tools` 之类 dsh 自带的包。
 *    理由 —— `tools.register()` 只强校验 `output.schema` 必须是标准 JSON Schema
 *    （`assertSupportedJsonSchema`），而 `parameters` 的 spec→JSON Schema 转换是
 *    `defineTool()` 干的、`register()` 根本不校验。既然我们自己写成标准
 *    JSON Schema，就不需要 defineTool，也就没有"装进 profile 后解析不到包"的
 *    风险（插件解析失败会让 DSH 起不来，代价太大）。
 *    只用官方 present 工具也用过的关键字子集：type / properties / required /
 *    items / additionalProperties / description。
 *
 * ② **workflow 照抄 `D:\ComfyUI\小鲸鱼生图\app.py` 的 build_workflow()** ——
 *    那是主人机器上**已经在用、已验证**的那份千问文生图工作流，节点与连线
 *    一个字都不改，只把提示词/尺寸/步数/种子做成参数。
 *
 * ③ **纯本地**：只连 127.0.0.1 的 ComfyUI，不出网、不需要任何 API Key。
 *
 * ④ **落盘位置**：默认桌面「千问1生图」，遵循工作区约定。
 *
 * ⑤ **图片怎么显示在聊天框**：真正有效的只有两条 —— 正文 Markdown 图片
 *    （靠 systemPrompt 段落保证）与客户端自定义 toolview（lib/client.js）。
 *    ImageBlock / presentCall / presentationMeta / present 卡片**都不行**。
 *
 * ⑥ **空闲自动关停 ComfyUI**（主人 2026-10-07 要求："不要让 comfyUI 一直跑着，
 *    只要五分钟不生图 comfyUI 后端自动关闭"）：
 *    · 计时**只在插件出过图之后**才开始（`lastActivityAt` 初始为 null）——
 *      这样绝不会误关主人自己打开的、正在「小鲸鱼生图」里用的 ComfyUI；
 *    · 到点还要再确认两件事：ComfyUI 在线、且 `/queue` 为空（有任务在跑就续期）；
 *    · **只杀"监听该端口 且 命令行确实像 ComfyUI（含 comfy…main.py）"的进程**，
 *      认不出来就跳过并记日志——绝不按端口盲杀。
 *
 * ⑦ **只读状态端点**（给客户端的状态指示器用）：
 *    `GET /api/qwen-paint/status.json`（另注册一个根路径同内容作回退）。
 *    只回 {online, busy, idleShutdownInMs, ...} 这类事实，**不含任何路径/密钥**；
 *    并且只放行本机请求。
 * ============================================================================
 */

import { promises as fsp, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
// ★★ 2026-10-08：hipfire 出图后端（通用桥接）。
//   只在 cfg.imageBackend === 'hipfire' 时被调用；默认后端仍是 comfyui，
//   现有 ComfyUI 出图路径**一行不改**。
import { generateWithHipfire, HIPFIRE_DEFAULTS, HIPFIRE_SIZE_MULTIPLE } from './hipfire-img.js'

export const execFileAsync = promisify(execFile)

/**
 * ★★ 2026-10-08：「正在生成图片」的呼吸动图 —— 路径与准备。
 *
 * 为什么这么做（主人给的正解，原话）：
 *   「你直接把这个动画当成一张图片发出来不就完美了吗」
 * 在此之前我三次尝试往消息树里插 DOM，最后一次把界面搞成整片空白 —— 那棵树由 React 管理，
 * 插自己的节点会被下一次渲染重排/清空（MEMO 里记过的红线：**只加属性、不改结构**）。
 * 改成动图后：位置就是正文图片的位置、随消息滚动、且完全不碰内核结构。
 *
 * 路径**动态算**（outputDir 已是按当前用户桌面推算的），复制到那儿供正文引用。
 */
function loadingGifPath(cfg) {
  // ★ 2026-10-08：**改用 webp**。GIF 版本在 DSH 里显示「图片无法预览」；
  //   而内核的 MIME 白名单明确支持 png / jpeg / webp / gif 四种（见 client.js L3728-3741），
  //   所以那次失败更可能是"GIF 编码/体积"而非格式本身 —— webp 只有 80KB（GIF 是 266KB）。
  return path.join(cfg.outputDir, '_正在生成图片.webp')
}

/** 把动图复制到用户目录（后台执行，不阻塞 systemPrompt 注册）。 */
async function prepareLoadingGif(cfg, log) {
  try {
    const src = fileURLToPath(new URL('../assets/loading.webp', import.meta.url))
    await fsp.mkdir(cfg.outputDir, { recursive: true })
    await fsp.copyFile(src, loadingGifPath(cfg))   // 每次覆盖：插件升级后动图可能变过
    return true
  } catch (error) {
    log('warn', `准备「正在生成」动图失败（不影响出图）：${error?.message ?? error}`)
    return false
  }
}

/** 稳定标识（与 cordis.patch.yml 里的 id 无关，这个是插件名）。 */
export const name = 'qwen-paint'

/**
 * ★★★ 2026-10-09 **关键修复**：模块级声明依赖 —— 这是 DSH 的**官方模式**。
 *
 * ## 为什么必须这么写（踩了很久的坑）
 *   本插件原先在 `apply()` 里用 `root.inject(['tools'], (ctx) => { …整个初始化… })`，
 *   把**所有初始化都塞进那个回调**。实测日志反复出现：
 *     `[apply] 插件开始加载` → `[inject] 准备注册` → **然后什么都没有**
 *   即：`root.inject` 的回调**从未执行**（cordis 的 scoped inject 在依赖解析上
 *   不可靠 / 静默挂起），于是工具、状态端点、提示词全都注册不上，
 *   界面上就是「一直卡在正在启动中」。
 *
 * ## 官方模式长什么样（对照两个正常工作的一线插件）
 *   · `@liustack/modlens`：`export const inject = ['tools','agents','attachments','llm']`，
 *     然后 `apply(ctx, config)` 里**直接** `ctx.tools.register(...)`
 *   · `dsh-univer-office`：`inject = ['univer','tools']`，同样直接 `ctx.tools.register(...)`
 *
 *   ⇒ **`export const inject` 是"声明"**：DSH 会等这些服务就绪后**才调用 `apply`**，
 *     而 `apply` 的 `ctx` 上**直接就有** `tools`，**根本不需要再 inject 一次**。
 *
 * ## 改法
 *   ① 这里声明 `inject = ['tools']`；
 *   ② `apply` 里把原来的 `root.inject(['tools'], cb)` 改成**立即执行**（IIFE），
 *      `ctx` 就是 `apply` 的第一个参数本身。
 *
 *   ⚠ `webServer` 是**可选**服务，仍走 `ctx.inject(['webServer'], …)`
 *     （modlens 也是这么用的：**必需**服务靠 export 声明，**可选**服务靠 inject 等它出现）。
 */
export const inject = ['tools']

import {
  defaultOutputBase,
  defaultOutputDir,
  resolveOutputDir,
  DEFAULTS,
  FLOW_STYLES,
  ASPECTS,
  uiStatePath,
  readUiState,
  writeUiState,
  makeLog,
  r32,
  calcSize,
  safeStem,
  portOf,
  toError,
  cancelReason,
  uniquePath,
  GPU_PROFILES,
  VENDOR_RULES,
  PCI_VENDOR,
  ACCEL_PACKS,
  ACCEL_SOURCES,
  PIP_MIRRORS,
  MODEL_HINTS,
  FULL_CAPS,
  MODEL_TIERS,
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
  resolvePlan,
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
} from './config.js'

/** 带超时的 fetch（同时尊重 exec.signal 的取消）。 */
const IS_LINUX = process.platform === 'linux'
function packAppliesToOs(pack) {
  const list = pack.os ?? ['win32', 'linux', 'darwin']
  return list.includes(process.platform)
}

/** 存在性检查（不抛异常）。 */
async function pathExists(target) {
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
async function runInstallSource(source, env) {
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
function comfyDirsFrom(paths) {
  const base = path.dirname(paths.mainPy)
  return { base, customNodes: path.join(base, 'custom_nodes') }
}

/**
 * 探测单个加速包是否已就位。
 * · `custom_node` 类 → 先看 custom_nodes 下有没有对应目录（快，且不依赖 python 能起来）
 * · `pip` 类        → 只能问 python 能不能 `import`
 */
async function probeAccelPack(pack, env, log) {
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
async function probeAcceleration(cfg, log) {
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
async function autoSetupAcceleration(cfg, log) {
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
async function installAccelPack(packId, env, log) {
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
 *   ③ 超时封顶 → 45 秒还没就绪就判失败（不再无限"启动中"）；
 *   ④ 认得出"参数被拒"这种错 → 自动去掉该参数重试一次（这才是真正通用的修法）。
 */
const LAUNCH_TIMEOUT_MS = 45000

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
 *   ③ **窗口必然收口**：`starting` 有个硬性截止时间（45 秒）。
 *      到点还没通 → 变 `failed`（带原因）。**绝不会无限停在 starting。**
 *
 * ## 状态流转（穷举，没有别的可能）
 *   idle ──start()──▶ starting ──探到通──▶ ready
 *                        │
 *                        ├─ 日志出现致命错 ──▶ failed
 *                        ├─ 进程消失 ────────▶ failed
 *                        └─ 超过 45 秒 ──────▶ timeout
 *   ready ──探到不通──▶ idle（回到起点，下次可再启动）
 */
const launch = {
  /** idle | starting | ready | failed | timeout */
  phase: 'idle',
  /** 本次 starting 的开始时刻（ms）。phase 非 starting 时为 0。 */
  startedAt: 0,
  /** 失败/超时的原因（给界面显示）。 */
  error: '',
  /** 启动日志文件路径（拿错误原文用）。 */
  logPath: '',
}

/** 把状态重置为"在线"。**这是唯一的"成功"入口**，任何人探到通都该调它。 */
function launchMarkReady() {
  launch.phase = 'ready'
  launch.startedAt = 0
  launch.error = ''
}

/** 把状态置为"启动中"。 */
function launchMarkStarting(logPath) {
  launch.phase = 'starting'
  launch.startedAt = Date.now()
  launch.error = ''
  launch.logPath = logPath ?? launch.logPath
}

/** 置为失败（带原因）。 */
function launchMarkFailed(reason) {
  launch.phase = 'failed'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
}

/** 置为超时（无报错、纯等不到）。与 failed 分开，因为对用户含义不同。 */
function launchMarkTimeout(reason) {
  launch.phase = 'timeout'
  launch.startedAt = 0
  launch.error = String(reason ?? '').slice(0, 600)
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
function launchView(online) {
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
function looksLikeBadArgs(text) {
  return /unrecognized arguments|unknown argument|invalid choice|no such option|error: argument/i
    .test(String(text ?? ''))
}

/** 从 stderr 尾部挑出一行最有用的错误（优先带 error/Error 的），供展示。 */
function summarizeLaunchError(stderrTail, exitNote) {
  const lines = String(stderrTail ?? '')
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const key = lines.filter((s) => /error|Error|Traceback|ModuleNotFound|cannot|failed/i.test(s))
  const picked = (key.length > 0 ? key : lines).slice(-3).join(' / ')
  return exitNote + (picked === '' ? '' : `：${picked}`)
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
async function resolveChildPid(parentPid, log) {
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

async function startComfyHidden(cfg, log) {
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
    if (want) {
      autoArgs = [...autoArgs, '--use-sage-attention']
      log('info', '已启用 N 卡 SageAttention：--use-sage-attention'
        + `（${mode === true ? '配置显式开启' : '后台自检确认已安装'}）`)
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

  // ★★★★ 2026-10-09 新增：**显存驻留参数** —— 这才是整条工作流 90 秒的真正解药。
  //
  // ## 问题（实测账，不是推测）
  //   加速节点只优化"采样那 8 步"（8~11 秒），而**整条工作流实测 90~150 秒**。
  //   差额几乎全在**模型反复装卸**上，日志里是这种模式：
  //       Requested to load QwenImage21     ← 装 6.9 GB
  //       Requested to load WanVAE          ← 装 VAE
  //       Unloaded partially: 1325.83 MB freed   ← 又卸
  //   原因：UNET(6.9) + CLIP(6.0) + VAE(0.64) ≈ 13.5 GB，
  //   而 ComfyUI 当时**只拿到 12.09 GB 可用**（19.98 GB 里有 7.89 GB 被占）
  //   ⇒ 装不下全部，只能"用完就卸、要用再装"，每次装卸按十秒计。
  //
  // ## ★★★ 2026-10-09 硬数据复核（scripts/_timing_forensics.py 跑出来的，不是推测）
  //   对 X:\ComfyUI-rocm\ComfyUI\.dshqp-launch.log 里 6 笔出图逐笔拆解：
  //
  //       #  采样s    总s    非采样s  非采样%   加载MB   lowvram补丁
  //       1  124.0  169.75   45.75   27.0%    13584        0
  //       3   15.0   58.73   43.73   74.5%     1288        0
  //       4   28.0   45.99   17.99   39.1%    13584      156
  //       5   57.0   99.77   42.77   42.9%    13584        0
  //       6   45.0   79.70   34.70   43.5%    13584      150
  //       ─────────────────────────────────────────────────────
  //       平均非采样开销 = **36.99 s，占总耗时 40.7%**
  //
  //   三个关键事实：
  //   ① **非采样开销占四成** —— 用户看到的 80 秒里有 ~35 秒不是"在画画"，
  //      而是把 13.58 GB 模型（TE 6019 + UNET 6920 + VAE 644）重新搬进显存。
  //   ② **ComfyUI 全程只启动了 1 次**（"To see the GUI go to" / "Total VRAM"
  //      各只出现 1 次）⇒ 这**不是冷启动问题**，是模型被反复卸载又加载。
  //   ③ 第 3 笔只加载 1288 MB（模型已在显存）→ 采样只要 **15 s / 1.88 s每步**；
  //      需要全量加载的那几笔 → 采样 45~124 s。**差 3~8 倍。**
  //
  //   ⇒ 结论：**消除"每次重新加载 13.58 GB"，就是最大的一块时间。**
  //
  // ## 做法：按显存总量选驻留档位
  //   · ≥ 24 GB：`--highvram` —— 模型全留显存，绝不卸载（最快）
  //   · ≥ 16 GB：`--highvram` + **极少**保留 —— 刚好够装下 13.58 GB 那套 + 激活值
  //   · < 16 GB：不加（强行 highvram 会 OOM，退化成更糟的反复换页）
  //
  // ★★ 2026-10-09 二次修正：**保留量从 1.5 GB 降到 0.5 GB**。
  //   为什么：这台机器 19.98 GB，模型 13.58 GB，只剩 6.4 GB 给激活值；
  //   再被 reserve 扣掉 1.5 GB → 只剩 4.9 GB ⇒ 1408×1408 的激活装不下
  //   ⇒ ComfyUI 把模型切成 150~156 块换页（日志里 `lowvram patches: 150`）
  //   ⇒ 采样从 15 s 涨到 45 s。这 1.5 GB 恰恰是压垮骆驼的那根。
  //   降到 0.5 GB：既给桌面合成器留一口气，又把 1 GB 还给模型/激活。
  //   ⚠ 这是**权衡值**，不是实测最优值 —— 保留多少取决于本机桌面占多少显存。
  //
  // ⚠ 仅在**没显式配 comfyArgs** 时介入（用户接管就完全听用户的）。
  const VRAM_ARGS = (() => {
    const gb = Number(gpu.vramGB ?? 0)
    // 拿不到显存信息时不猜
    if (!Number.isFinite(gb) || gb <= 0) return { args: [], note: '' }
    // ★★★ 2026-10-11：**Apple Silicon 显式跳过** —— 统一内存没有独立显存，
    //   `--highvram` / `--reserve-vram` 这套是给**离散显存**设计的，
    //   搬到 MPS 上只会误导（而且 ComfyUI 官方对 Mac 也没给这类参数）。
    if (gpu.id === 'apple') {
      return {
        args: [],
        note: `Apple Silicon（统一内存，PyTorch 建议工作集约 ${gb} GB）`
          + ' → 不加离散显存驻留参数（--highvram 这套不适用于统一内存）',
      }
    }
    if (gb >= 24) {
      return { args: ['--highvram'], note: `${gb} GB ≥ 24 GB → --highvram（模型全驻留）` }
    }
    if (gb >= 16) {
      // 16~24 GB 区间：13.5 GB 那套装得下，但要给系统留一点，否则桌面会卡。
      // ★ 0.5 而非 1.5：见上面 2026-10-09 二次修正的实测账（19.98 GB 机器上
      //   1.5 GB 的保留会把 1408×1408 逼进换页，采样 15 s → 45 s）。
      return {
        args: ['--highvram', '--reserve-vram', '0.5'],
        note: `${gb} GB ∈ [16,24) → --highvram + 保留 0.5 GB 给系统`,
      }
    }
    // ★ 2026-10-11 撤回：这里一度想给 A 卡加"减负档"（`--cache-none` 等），
    //   **已删除** —— 主人明确纠正：「我说的是做**专门的优化**，不是以降低原生质量为代价」。
    //   `--cache-none` 的原文是 "Reduced RAM/VRAM usage **at the expense of executing
    //   every node for each run**" —— 那是**拿性能换空间**，不是优化，方向错了。
    //   A 卡的专属优化改为**可选、质量中性**的开关，见 `amdKernel` / `amdAsyncOffload`。
    return {
      args: [],
      note: `${gb} GB < 16 GB → 不加驻留参数（强行 highvram 会 OOM，反而不如让 ComfyUI 自己调度）`,
    }
  })()

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
      // ★★★★ 2026-10-09 实测得出的**唯一可靠方式**（试了四种，只有这种活下来）：
      //     ① 直接 `Start-Process`（在会话里）           → ✅ 存活
      //     ② 经 `powershell -Command` 包一层            → ❌ 进程被父 shell 收走
      //     ③ Node `spawn(detached)` / 普通 `spawn`      → ❌ 进程消失
      //     ④ WMI `Win32_Process.Create` + 内联长命令行   → ❌ cmd 引号被吃、压根没跑
      //     ⑤ **写 .cmd 文件 + WMI 创建该文件**           → ✅ **存活、8188 正常监听**
      //
      //   为什么最终选 ⑤：
      //     · WMI 由服务端直接派生进程，**不属于任何 shell、也不属于 DSH 的作业对象**，
      //       父 shell 退出与 DSH 重启都不会带走它（顺带解决了 2026-10-08
      //       "DSH 重启后 ComfyUI 被连带杀死"那个老问题）；
      //     · 走 .cmd 文件则彻底绕开**多层引号嵌套**这个坑 ——
      //       内联写法里 python 路径带空格/反斜杠时，引号会被 cmd 与 PowerShell 各吃一层，
      //       表现为"命令返回成功、但什么都没发生、日志也不生成"（踩过）。
      //
      //   stderr 依然保留：在 .cmd 里用 `>` 重定向写进日志文件，
      //   失败时由 readLaunchLog 读回来 —— 这是能给出"能照做的原因"的前提。
      //
      // ★★★ 另一个关键修正：**pid 不能拿 WMI 返回的那个**。
      //   `Win32_Process.Create` 返回的是 **cmd.exe 的 pid**，而真正跑 ComfyUI 的
      //   是它启动的 python（**子进程**，pid 完全不同）。拿 cmd 的 pid 去做
      //   "进程还在不在"的存活检查，会在 python 已经退出时仍看到 cmd 还活着
      //   （或反之），判断直接失真。
      //   ✓ 让 .cmd 自己把 **python 的 pid** 写进文件 —— `%~dp0` 无关，
      //     用 wmic/PowerShell 都太重，这里用最朴素的办法：cmd 启动 python 前
      //     先记下自己的 pid 不够（那是 cmd 的），
      //     所以改为**由 python 自己写 pid**？不行，ComfyUI 不干这事。
      //     最终用 PowerShell 的 `-Resolve` 思路：启动后由外部查"哪个 python 的父进程是它"。
      //     —— 见下方 readChildPid，靠**父子关系**拿到真实 python pid。
      const batPath = path.join(comfyDirsFrom(found).base, '.dshqp-launch.cmd')
      const line = [py, ...args].map((a) => `"${String(a)}"`).join(' ')
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
      const q = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
      const pidFile = `${launchLog}.pid`
      const inner = [py, ...args].map(q).join(' ')
      // 用一层 sh 包住：先把**自己的 pid** 写进文件，再 exec 目标（exec 不换 pid）
      const wrapped = `sh -c 'echo $$ > ${q(pidFile)}; exec ${inner}'`
      const hasSetsid = await runShell(
        'if command -v setsid >/dev/null 2>&1; then echo YES; else echo NO; fi',
        8000,
      )
      const cmd = hasSetsid.trim() === 'YES'
        ? `setsid --fork sh -c ${q(wrapped)}`
        : `nohup sh -c ${q(wrapped)} &`
      await runShell(`${cmd} >${q(launchLog)} 2>&1 < /dev/null &`, 30000)
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
function watchLaunchedProcess(cfg, log, pid) {
  // ★★★ 不再因为 pid<=0 就整个放弃监视。
  //   拿不到可靠 pid 时仍要盯着：**探活 + 日志**这两条路一样能判断成败，
  //   而且它们才是权威事实。只有"进程存活查询"这一步会被跳过（见循环里）。
  const hasPid = Number.isSafeInteger(pid) && pid > 0
  let checks = 0
  const timer = setInterval(async () => {
    checks += 1
    // 已经就绪 / 已经判过失败 / 已经查够次数（45 秒 ÷ 1 秒）→ 收摊
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

    // ★★★ 2026-10-09（主人要求：「如果直接启动失败你就直接报错，不要等 45 秒」）：
    //   **先查日志**再查进程 —— 日志里一旦出现致命错误，立刻报错并收摊，
    //   根本不用等进程真的死掉、更不用等 45 秒超时。
    //   典型：`unrecognized arguments`（参数被拒）、`Port 8188 is already in use`
    //   （端口被占）、`ModuleNotFoundError`（依赖缺失）—— 这些一出现就注定失败。
    const tail = await readLaunchLog(launch.logPath)
    if (tail !== '') {
      const fatal = fatalLineInLog(tail)
      if (fatal !== '') {
        clearInterval(timer)
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
 * 与其等 45 秒超时，不如一看到这些关键字就当场判定 ——
 * 主人明确要求「如果直接启动失败你就直接报错，不要等 45 秒」。
 *
 * ⚠ 关键字只挑**确定致命**的，不能把普通 WARN 也算进来（否则会误报失败）。
 */
function fatalLineInLog(text) {
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
async function readLaunchLog(logPath) {
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
  //   由 LAUNCH_TIMEOUT_MS（45 秒）独立决定 —— 两者职责不同，不要混。
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
async function assertComfyUp(cfg, signal) {
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

/**
 * ComfyUI 状态（带缓存）。
 * 缓存是为了让客户端每 5 秒的轮询不至于每次都去敲 ComfyUI（它可能正忙）。
 */
function makeComfyStatus(cfg) {
  let cache = { at: 0, online: false }
  /** ★ 2026-10-09：队列忙碌状态的短缓存（见 queueBusy 的说明）。 */
  let queueCache = { at: 0, busy: false }
  return {
    async probe(force = false) {
      const now = Date.now()
      if (!force && now - cache.at < cfg.statusCacheMs) return cache.online
      let online = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/system_stats`, { timeoutMs: 3000 })
        online = res.ok
      } catch {
        online = false
      }
      cache = { at: now, online }
      return online
    },
    /** 队列里有东西就算了"忙"——空闲关停会因此续期，绝不打断别人正在跑的任务。 */
    async queueBusy() {
      // ★ 2026-10-09：加个 2 秒的短缓存。
      //   `probe()` 本来就有 statusCacheMs 缓存，而这里原先**每次都真发请求** ——
      //   两边不对称，等于每轮状态轮询都固定多打一次 ComfyUI。
      //   2 秒足够挡住"同一轮里被调两次"（状态端点 + 空闲关停检查），
      //   又不会让"忙/闲"的显示明显滞后。
      const now = Date.now()
      // ★ 2026-10-11：TTL 做成**可配置**（默认 2000ms，生产行为一字不变）。
      //   起因：TTL 原先是写死的 2000 —— 自测里连续断言"忙/闲"两种状态时，
      //   第二次调用必然命中缓存、测不出变化（自测只能靠 sleep 绕过，又慢又不稳）。
      //   现在 `cfg.queueCacheMs` 可覆盖：生产不配 = 沿用 2 秒；自测置 0 = 每次真查。
      if (now - queueCache.at < (cfg.queueCacheMs ?? 2000)) return queueCache.busy
      let busy = false
      try {
        const res = await fetchWithTimeout(`${cfg.comfyUrl}/queue`, { timeoutMs: 3000 })
        if (res.ok) {
          const data = await res.json()
          const running = Array.isArray(data?.queue_running) ? data.queue_running.length : 0
          const pending = Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
          busy = running + pending > 0
        }
      } catch {
        busy = false
      }
      queueCache = { at: now, busy }
      return busy
    },
    invalidate() {
      cache = { at: 0, online: cache.online }
    },
  }
}

/* ------------------------------------------------- 空闲关停 + 进程识别（★ 安全） ---- */

/**
 * ★★ 找出"确实是 ComfyUI"的进程。两道闸：
 *   ① 它必须正监听 ComfyUI 的端口；
 *   ② 它的命令行必须同时含 `comfy` 与 `main.py`（本机启动命令是
 *      `…\python_embeded\python.exe -s .\ComfyUI\main.py --windows-standalone-build`）。
 * 只要有一条不满足就返回 null —— **绝不动手**。宁可留着占显存，也不误杀别人的进程。
 * @returns {{pid:number, commandLine:string}|null}
 */
async function findComfyProcess(cfg, log) {
  const port = portOf(cfg.comfyUrl)
  try {
    // ★ 2026-10-09 补齐 Linux：这两个命令原先**只有 PowerShell 版**，
    //   在 Linux 上 sh 会直接报 "command not found"，被下面的 catch 吞掉 →
    //   表现为"空闲关停静默失效"（不会误杀进程，但也永远关不掉）。
    const pidText = IS_WINDOWS
      ? await runShell(
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | `
        + 'Select-Object -First 1 -ExpandProperty OwningProcess)',
      )
      // Linux：优先 lsof（最省事），没有就退回 ss + sed 提取 pid=
      : await runShell(
        `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1; `
        + `ss -ltnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1`,
      )
    const pid = Number.parseInt(String(pidText).split(/\s+/u)[0] ?? '', 10)
    if (!Number.isInteger(pid) || pid <= 0) return null

    const commandLine = IS_WINDOWS
      ? await runShell(
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | `
        + 'Select-Object -ExpandProperty CommandLine)',
      )
      // Linux：`ps -o args=` 取完整命令行（含参数）
      : await runShell(`ps -p ${pid} -o args= 2>/dev/null`)

    if (!/comfy/iu.test(commandLine) || !/main\.py/iu.test(commandLine)) {
      log('warn', `端口 ${port} 上的 PID ${pid} 命令行不像 ComfyUI，拒绝关闭：${commandLine.slice(0, 160)}`)
      return null
    }
    return { pid, commandLine }
  } catch (error) {
    log('warn', `识别 ComfyUI 进程失败：${error?.message ?? error}`)
    return null
  }
}

/**
 * 空闲关停器。
 *
 * ★ 计时**只在插件出过图之后**才开始：`lastActivityAt` 初始为 null，此时 tick 永远
 *   返回 false。所以「主人自己打开 ComfyUI 在别处画图」绝不会被本插件关掉。
 * ★ 到点后还要过两关：ComfyUI 在线、`/queue` 为空。队列非空 → 续期（有人在用）。
 */
function makeIdleShutdown(cfg, log, status) {
  const state = { lastActivityAt: null, shuttingDown: false, shutdowns: 0 }

  return {
    /** 记一次活动（出图成功后调用）。 */
    touch() {
      state.lastActivityAt = Date.now()
    },
    /** 距离下次自动关停还有多久（毫秒）；不可用时返回 0。 */
    idleShutdownInMs() {
      if (!cfg.autoShutdown) return 0
      // ★ 2026-10-07 新增：`idleShutdownMs <= 0` 表示**不自动关闭**（主人在界面上选了这一项）。
      //   remaining() 返回 0、shouldShutdown() 返回 false，两者都要挡住，否则会算出负数/立刻关停。
      if (cfg.idleShutdownMs <= 0) return 0
      if (state.lastActivityAt === null) return 0
      return Math.max(0, cfg.idleShutdownMs - (Date.now() - state.lastActivityAt))
    },
    snapshot() {
      return {
        autoShutdown: cfg.autoShutdown,
        lastActivityAt: state.lastActivityAt,
        idleShutdownMs: cfg.idleShutdownMs,
        idleShutdownInMs: this.idleShutdownInMs(),
        shutdowns: state.shutdowns,
      }
    },
    /** 定时检查。真关掉了返回 true。 */
    async tick() {
      if (!cfg.autoShutdown) return false
      // ★ 2026-10-07：idleShutdownMs <= 0 = 主人在界面上选了「不自动关闭」
      if (cfg.idleShutdownMs <= 0) return false
      if (state.lastActivityAt === null) return false
      if (state.shuttingDown) return false
      if (Date.now() - state.lastActivityAt < cfg.idleShutdownMs) return false

      // 关之前必须确认它还在（不在就没什么可关的，顺手复位计时）
      const online = await status.probe(true)
      if (!online) {
        state.lastActivityAt = null
        return false
      }
      // 队列非空 → 有人在用，续期，绝不打断
      if (await status.queueBusy()) {
        state.lastActivityAt = Date.now()
        // ★ 2026-10-10（M5）：把"续期"也记一笔 —— 否则用户会以为"到点却没关"是坏了。
        log('info', '空闲已到点，但队列非空 → 续期，本次不关闭 ComfyUI')
        return false
      }

      state.shuttingDown = true
      try {
        const found = await findComfyProcess(cfg, log)
        if (found === null) {
          log('warn', '空闲已超时，但没能确认哪个进程是 ComfyUI，本次不关闭')
          return false
        }
        // ★ Linux 用 kill（先 SIGTERM 温和，再兜底 SIGKILL）；Windows 用 Stop-Process -Force
      await runShell(IS_WINDOWS
        ? `Stop-Process -Id ${found.pid} -Force`
        : `kill ${found.pid} 2>/dev/null || kill -9 ${found.pid} 2>/dev/null`)
        state.shutdowns += 1
        log('info', `已空闲 ${Math.round((Date.now() - state.lastActivityAt) / 1000)} 秒，关闭 ComfyUI（PID ${found.pid}）`)
        state.lastActivityAt = null
        status.invalidate()
        return true
      } catch (error) {
        log('warn', `关闭 ComfyUI 失败：${error?.message ?? error}`)
        return false
      } finally {
        state.shuttingDown = false
      }
    },
  }
}

/** 只放行本机请求（照 dsh-boot-splash 余额路由的做法）。 */
function isLocalRequest(req) {
  const host = String(req?.headers?.host ?? '').toLowerCase()
  const remote = String(req?.socket?.remoteAddress ?? '')
  const hostOk = host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(host)
  const remoteOk = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return hostOk && remoteOk
}

/** 回 JSON；任何异常都降级成一个可读的错误体，绝不 5xx。 */
function respondJson(res, body, code = 200) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  } catch (error) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
    } catch {
      /* 连接已经没了 */
    }
  }
}

/* ---------------------------------------------------------------- 工作流与出图 ---- */

/**
 * ★★ 2026-10-08 新增：探活请求该不该发。
 *
 * 参考图那一路为了省掉一次 8 秒的「连不上」超时（图要上传说明后端肯定在跑），
 * 故意**跳过探活** —— 这是原有行为，这里只是把它抽成纯函数便于自测。
 */
async function uploadReference(cfg, filePath, signal) {
  let bytes
  try {
    bytes = await fsp.readFile(filePath)
  } catch (error) {
    throw new Error(`读不到参考图：${filePath}（${error?.message ?? error}）`)
  }
  const form = new FormData()
  form.append('image', new Blob([bytes]), path.basename(filePath))
  form.append('overwrite', 'true')

  const controller = new AbortController()
  // ★ 同 fetchWithTimeout：不转发裸 signal.reason（普通对象 → [object Object]）
  const onAbort = () => controller.abort(cancelReason(signal))
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('上传参考图超时')), 120000)
  try {
    const res = await fetch(`${cfg.comfyUrl}/upload/image`, { method: 'POST', body: form, signal: controller.signal })
    if (!res.ok) throw new Error(`参考图上传失败：HTTP ${res.status}`)
    const data = await res.json()
    if (!data?.name) throw new Error(`参考图上传返回异常：${JSON.stringify(data).slice(0, 200)}`)
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 提交任务，拿 prompt_id。 */
/**
 * ★★★ 2026-10-09 新增：**一次请求摸清后端"能不能马上接活"**。
 *
 * ## 为什么需要它（主人原话：「调用再聪明一点，不要那么傻」）
 *   原先进 execute 后是**串行**打三枪：
 *     ① `ensureComfyUp` → `/system_stats`（探活）
 *     ② `probeCapabilities` → 10 次 `object_info`（能力）
 *     ③ `submitPrompt` → `/prompt`
 *   其中 ② 有 10 分钟缓存、实际多半是命中的，但 ① 每次都要真发一次；
 *   更要命的是**它不知道后端忙不忙** —— 后端正在跑别人的任务时，它照样提交，
 *   于是任务排进队列，`waitForResult` 傻等，用户看到的是"卡住不动"。
 *
 * ## 这个函数做什么
 *   用 `/queue` 一次拿到三件事：
 *     · `online` —— 通了就说明后端活着（省掉一次 `/system_stats`）
 *     · `busy`   —— 有 running 就说明正在跑（据此决定"先等一下"而不是硬塞）
 *     · `pending`—— 排了多少（据此给用户一句**诚实**的预估，而不是假装马上出）
 *   失败不抛错：拿不到就当"未知"，走老路径（探测失败绝不能变成出图失败）。
 *
 * @returns {Promise<{online:boolean, busy:boolean, running:number, pending:number}>}
 */
async function submitPrompt(cfg, workflow, signal) {
  const res = await fetchWithTimeout(`${cfg.comfyUrl}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ prompt: workflow, client_id: `dsh-qwen-paint-${process.pid}` }),
    timeoutMs: 60000,
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ComfyUI 拒绝了这次任务（HTTP ${res.status}）：${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`ComfyUI 返回了看不懂的内容：${text.slice(0, 300)}`)
  }
  if (payload?.error) {
    const detail = payload.error?.message ?? JSON.stringify(payload.error).slice(0, 300)
    const nodeErrors = payload.node_errors === undefined ? '' : `\n节点校验详情：${JSON.stringify(payload.node_errors).slice(0, 500)}`
    throw new Error(`ComfyUI 报错：${detail}${nodeErrors}`)
  }
  if (typeof payload?.prompt_id !== 'string') throw new Error('ComfyUI 没有返回 prompt_id，无法跟踪任务')
  return payload.prompt_id
}

/**
 * 轮询等结果。每 tick 回调一次进度，方便主人看到"在动"。
 *
 * ★★★ 2026-10-09 改造（主人：「调用再聪明一点，不要那么傻」）：
 *   原先这个循环只会说「排队/加载模型中…」「运行中… 已等 Ns」——
 *   用户根本分不清"在排队"和"在算"，更不知道还要多久，观感就是"卡死"。
 *   现在改成**看得懂的三段状态**：
 *     · 队列里还没轮到   → 报「排在队列第 N 位」
 *     · 正在跑但不吐进度 → 报「ComfyUI 正在执行（已 Ns）」
 *     · 有真实进度       → 直接报百分比 + 当前步数
 *   进度从 `/prompt` 的 websocket 太麻烦，改用 `/history` 里 ComfyUI 自己
 *   写回的时间戳/状态 —— 拿不到就退化成上面的粗粒度文案，**绝不编数字**。
 *
 * @returns 输出图片描述数组 [{filename, subfolder, type}]
 */
async function waitForResult(cfg, promptId, { signal, onTick, timeoutMs }) {
  const started = Date.now()
  let lastNote = ''
  let idleTicks = 0
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error(`等 ComfyUI 出图超时（已等 ${Math.round((Date.now() - started) / 1000)} 秒）`)
    if (signal?.aborted) throw cancelReason(signal)
    await new Promise((resolve) => setTimeout(resolve, cfg.pollIntervalMs ?? 1200))

    let history
    try {
      const res = await fetchWithTimeout(`${cfg.comfyUrl}/history/${promptId}`, { timeoutMs: 30000, signal })
      if (!res.ok) continue
      history = await res.json()
    } catch {
      continue // ComfyUI 短暂忙不过来时不要当场判死
    }
    const entry = history?.[promptId]
    if (!entry) {
      // ★ 还没进 history 说明要么在队列里、要么在跑。去 /queue 问一句"我排第几"，
      //   比干说"排队/加载模型中"有用得多 —— 这是"聪明一点"最直接的体现。
      idleTicks += 1
      if (onTick) {
        // 每 3 个 tick 才去问一次队列，避免把 ComfyUI 问烦
        if (idleTicks % 3 === 1) {
          const q = await probeReadiness(cfg, signal)
          const waited = Math.round((Date.now() - started) / 1000)
          if (q.pending > 0) {
            const note = `正在等前一个任务（前方还有 ${q.pending} 个），已等 ${waited}s`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          } else if (q.running > 0) {
            const note = `ComfyUI 正在执行（已等 ${waited}s；若刚换过尺寸，首次会重载模型，偏慢正常）`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          } else {
            const note = `已提交，正在装载模型… 已等 ${waited}s`
            if (note !== lastNote) { lastNote = note; onTick(note) }
          }
        }
      }
      continue
    }
    const status = entry.status
    if (status?.status_str === 'error' || status?.completed === false) {
      const messages = status?.messages
      if (Array.isArray(messages) && messages.some((m) => Array.isArray(m) && m[0] === 'execution_error')) {
        const err = messages.find((m) => Array.isArray(m) && m[0] === 'execution_error')?.[1]
        throw new Error(`ComfyUI 执行失败：${err?.exception_message ?? JSON.stringify(err).slice(0, 400)}`)
      }
    }
    const images = []
    for (const nodeOutput of Object.values(entry.outputs ?? {})) {
      for (const image of nodeOutput?.images ?? []) {
        if (image?.filename) images.push(image)
      }
    }
    if (images.length > 0) return images
    const note = status?.status_str === 'success' ? '成功但没有图片输出' : `运行中… 已等 ${Math.round((Date.now() - started) / 1000)}s`
    if (note !== lastNote) {
      lastNote = note
      if (onTick) onTick(note)
    }
  }
}

/**
 * 取图片字节。
 *
 * ★★ 0.1.2 修正（真事故，主人一眼看出来的）：
 *   **先走 ComfyUI 官方的 `/view`，本地目录只当兜底。**
 *
 * 原来顺序是反的（先读本地 `comfyOutputDir`），结果踩了个大坑：
 *   ComfyUI 的 output 目录**未必是配置里那个** —— 插件自己拉起 ComfyUI 时会带
 *   `--output-directory <别处>`，或者机器上跑的是另一个实例。而两个实例的
 *   SaveImage 编号**都从 00001 重新开始**，于是**旧目录里恰好躺着一个同名文件** ✗
 *   → `readFile` 成功 → **根本走不到兜底** → 把昨天的旧图当成这次的成果，
 *     还按新 prompt 命名、报新请求的尺寸。主人看到的就是"画得完全不对"。
 *
 *   `/view` 是**问 ComfyUI 要它自己那次产出的文件**，不存在这个问题 ✓
 *   （代价只是多一次本地回环 HTTP，几 MB 而已。）
 */
async function fetchImageBytes(cfg, image, signal) {
  // ① 先问 ComfyUI 本人要 —— 这是唯一权威的来源
  try {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    const res = await fetchWithTimeout(`${cfg.comfyUrl}/view?${query.toString()}`, { timeoutMs: 120000, signal })
    if (res.ok) return Buffer.from(await res.arrayBuffer())
  } catch (error) {
    /* 落下去试本地兜底 */
  }
  // ② 本地目录兜底（老版本 ComfyUI、或 /view 不可用时）
  //   ★ 2026-10-09 通用化：`comfyOutputDir` 默认**留空** —— 写死作者机器的路径对别人
  //     毫无意义（必然先白失败一次）。留空则直接跳过本地这一路，报错也更干净。
  const local = cfg.comfyOutputDir
    ? path.join(cfg.comfyOutputDir, image.subfolder ?? '', image.filename)
    : ''
  if (local !== '') {
    try {
      return await fsp.readFile(local)
    } catch (error) {
      /* 落到下面的统一报错 */
    }
  }
  throw new Error(
    `取图失败：/view 读不到 ${image.filename}`
    + (local === '' ? '（未配置本地 output 目录，无法本地兜底）' : `，本地 ${local} 也读不到`),
  )
}

/**
 * 从 PNG 字节头读尺寸；不是 PNG（或太短）返回 null。
 *
 * ★★ 0.1.2 新增：用来做**尺寸校验** —— 这次事故里插件报的是请求尺寸
 *   （832x1216），而实际拿到的文件是 992x992，机器明明"知道"却没人拦。
 *   加上这道闸，同类问题会**当场报错**，不会再静默产出错图。
 */
function readPngSize(bytes) {
  if (!bytes || bytes.length < 24) return null
  // PNG 魔数：89 50 4E 47
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/* ------------------------------------------------------------------ 列出可用模型 ---- */

/**
 * ★★ 2026-10-09 新增：列出本机 ComfyUI 当前可用的模型文件。
 *
 * 直接问 ComfyUI 本人（`/object_info/<节点类型>` 子路径，只回该节点 schema，远比全量
 * 1.97MB 的 `/object_info` 轻），取各加载器输入项的 `OPTIONS`（下拉候选 = 磁盘上的模型文件名）。
 * 纯本地、不出网；用来正面回应"查看可用的模型"——宿主顶部的 LLM 模型下拉若卡住，
 * 这一条能直接把 ComfyUI 这边的模型清单拉出来看。
 *
 * ⚠ 子路径 `/object_info/<Type>` 在 ComfyUI 上是稳定的；若某个加载器节点不存在
 *   （如未装某自定义节点），对应项返回 null 而非报错，绝不拖垮整次查询。
 */
function makeAccelTool(cfg, log) {
  return {
    name: 'check_acceleration',
    description:
      '检查本机 GPU 与生图加速环境：识别显卡厂商与架构、当前采用的注意力后端参数、'
      + '通用优化链（turbo8 / 前缀缓存 / 跳步缓存）与厂商专用加速包的就位情况，并给出缺什么。'
      + 'action=status（默认）只读查看；action=install 配合 packId 安装指定加速包。'
      + 'status 纯本地、不联网；只有 install 才会下载。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'status（默认，只读检查）/ install（安装加速包）' },
        packId: { type: 'string', description: '要安装的加速包 id（见 status 返回的 packs[].id）' },
      },
    },
    timeoutMs: 900000,
    async execute(args, exec) {
      if (args?.action === 'install') {
        if (cfg.accelAutoInstall === false) {
          throw new Error(
            '当前配置 accelAutoInstall=false，已禁止安装加速包。'
            + '要允许安装，请把 cordis.patch.yml 里的 accelAutoInstall 改成 true 后重试。',
          )
        }
        const packId = String(args?.packId ?? '').trim()
        if (packId === '') throw new Error('action=install 需要同时提供 packId（见 status 返回的 packs[].id）')
        const report = await probeAcceleration(cfg, log)
        const installed = await installAccelPack(packId, report.env, log)
        return { ...report, installed }
      }
      return await probeAcceleration(cfg, log)
    },
  }
}

/* ------------------------------------------------------------------ 环境自适应 ---- */

/**
 * ★★★ 2026-10-09（通用化改造）：**从"写死优化链路"改为"探测后自适应"**。
 *
 * ## 为什么必须改
 * 优化链上的每一环都是**可选依赖**，别人机器上未必有：
 *   · `turbo8_lora_step2500.safetensors`（1.36 GB，要自己下）
 *   · `TE-Speed-QwenImage21` 自定义节点（闭源 `nodes.pyd`）
 *   · `ComfyUI-Qwen-Image-2.1-Speedup` 自定义节点
 *   · 官方前缀缓存节点 `QwenImage21Cache`（要足够新的 ComfyUI）
 * 而 ComfyUI 遇到"引用了不存在的节点类型"或"模型名不在候选列表里"是**整单拒收**
 * （`node type not found` / `value not in list`），**不会静默降级**。
 * 所以老版本一旦发出去，凡是不满足条件的人一画图就报错 —— 包等于是坏的。
 *
 * ## 现在怎么做
 * 出图前先**问 ComfyUI 本人**（`/object_info/<节点类型>`）：摸清"有哪些节点、
 * 磁盘上模型文件的真实名字叫什么"，再据此选一档**可用的最高链路**。
 * 探测结果按 ComfyUI 地址缓存（默认 10 分钟），不会每次出图都重查。
 *
 * ## 三档链路（自动取可用的最高档）
 *   `full`  turbo8 + 前缀缓存 + 跳步缓存 → 8 步 / CFG 1.0（最快；作者本机 8.2s）
 *   `turbo` turbo8（缺跳步缓存也可以）  → 8 步 / CFG 1.0
 *   `basic` 没有 turbo8 LoRA            → 25 步 / CFG 2.5（慢，但任何千问环境都能出图）
 *
 * ⚠ 探测**失败**（ComfyUI 连不上等）**不拦截出图**：一律当 `full` 处理，
 *   让 ComfyUI 自己抛原始错误 —— 比插件"猜"出一个含糊结论要诚实。
 */

/**
 * 模型文件名的**模糊匹配表**（按优先级打分，从高到低）。
 *
 * 为什么必须模糊匹配：作者本机用的是 int8 量化版（`..._int8_convrot` / `..._w4a8`），
 * 但别人下的可能是 bf16 版、fp8 版，文件名并不相同。**写死文件名 = 换台机器就拒收**。
 * 这里按关键字从"磁盘上真实存在的"列表里挑一个最合适的；一个都匹配不上则返回 null，
 * 交给上层降级处理。
 *
 * ⚠ 正则都**不带 `g` 标志** —— 带 g 的 `test()` 有 `lastIndex` 状态，会漏匹配。
 */
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

/** 能力探测结果的缓存（按 ComfyUI 地址）。 */
async function executeHipfire(args, exec, { cfg, log, prompt, steps, seed, width, height, onProduced }) {
  const signal = exec?.signal
  const started = Date.now()

  // hipfire 的宽高必须是 16 的倍数
  const hw = Math.max(HIPFIRE_SIZE_MULTIPLE, Math.round(width / HIPFIRE_SIZE_MULTIPLE) * HIPFIRE_SIZE_MULTIPLE)
  const hh = Math.max(HIPFIRE_SIZE_MULTIPLE, Math.round(height / HIPFIRE_SIZE_MULTIPLE) * HIPFIRE_SIZE_MULTIPLE)

  // 用户**显式**传了 steps 才透传；否则交给 hipfire 用自己的架构默认
  // （schnell=4 / dev=28），避免把插件的默认 25 硬塞给步蒸馏模型。
  const explicitSteps = Number.isFinite(args?.steps) ? steps : undefined

  const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
  const references = refPath === '' ? [] : [refPath]

  // ⚠ 这行原先写成了**嵌套模板字符串**（外层反引号里又嵌了一个反引号模板），
  //   JS 解析歧义、node --check 直接报语法错 —— 整个文件都过不了。
  //   拆成"先算个变量"再插值，结果完全一样但没有嵌套。
  const modeText = references.length > 0 ? `（图生图 参考=${refPath}）` : '（文生图）'
  log('info', `hipfire 出图 ${hw}x${hh} steps=${explicitSteps ?? '(模型默认)'} seed=${seed}${modeText}`)

  const result = await generateWithHipfire(
    cfg,
    { prompt, negative: args?.negative, width: hw, height: hh, steps: explicitSteps, seed, references },
    signal,
    log,
  )

  if (!result.ok) {
    // ★ 失败**必须明确抛出** —— 绝不返回假成功（出图是用户可见产物）。
    throw new Error(`hipfire 出图失败：\n${result.error}`)
  }
  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error('hipfire 出图报告成功，但没有返回任何文件路径')
  }

  const seconds = Number(((Date.now() - started) / 1000).toFixed(1))
  const value = { path: result.files[0], width: hw, height: hh, seed, seconds, files: result.files }
  if (typeof onProduced === 'function') {
    try {
      onProduced(exec, value)
    } catch (error) {
      log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
    }
  }
  return value
}

/**
 * 建工具定义。注意这里**不用 defineTool**：register 要的就是这么个对象。
 * @param ctx - 已注入 tools 的上下文
 * @param cfg - 合并后的配置
 * @param log - 记日志
 * @param onProduced - 出图成功后回调（用来 append 交付事件 + 记活动时间）
 */
function makeDrawTool(ctx, cfg, log, onProduced, onStart) {
  return {
    name: 'draw_image',
    description:
      '用本机 ComfyUI 的千问（Qwen-Image 2.1）模型画图。给一段画面描述就能出图，图片会保存到「千问1生图」目录，' +
      '并把绝对路径回给你，用来在回复里内联显示。纯本地运行，不出网、不花钱、不需要任何 API Key。' +
      // ★ 2026-10-09：把边界写进描述 —— 工具描述是模型最先看到的信息，
      //   比 systemPrompt 段落更靠近"要不要调这个工具"的那一刻。
      // ★★★ 2026-10-09 改写（真事故）：**不许助手绕过本工具自己去"画"图**。
      //
      //   现场：用户说「画一幅表现双曲几何之美的数学艺术画」，助手**没调本工具**，
      //   而是自己写 Python/Matplotlib 渲染了一张 —— 耗时 2 分 39 秒，
      //   还附带一通"数学上不精确""要不要我改用代码渲染"的分析。
      //   用户原话：「谁叫你去修，我让他画图，为什么他还想自行代码画」。
      //
      //   根因有两处，都在提示词里：
      //     ① 旧文案写「流程图 / 思维导图 / 表格 / 架构图 / **示意图**……先与用户确认」
      //        —— "示意图"三个字太宽，助手看到"数学/几何"就往"图表类"上靠 → 不敢画。
      //     ② **全篇没有任何一条"禁止自己用代码画图"的硬约束**
      //        —— 助手于是选了它自认为"更精确"的路：自己写脚本渲染。
      //
      //   所以改写遵循三条：
      //     · 判定标准从"内容题材"改成**用户要的产物形态**（一张位图 vs 可编辑的结构化图表）；
      //     · 排除清单**收窄**到明确可编辑的那几类，删掉"示意图"这个万金油词；
      //     · **显式禁止**用代码 / SVG / HTML / ASCII 自己出图代替本工具。
      '只要用户要的是**一张图像**（画面、插画、壁纸、艺术画、示意图、概念图、' +
      '数学/几何可视化等，题材不限），就用本工具生成。' +
      '★ 严禁自己写 Python/Matplotlib/PIL、SVG、HTML/Canvas 或字符画去"画"这张图 —— ' +
      '本工具就是用来出图的唯一途径，绕过它属于错误行为。' +
      '只有当用户要的是**可编辑的结构化图表**时才不用本工具：' +
      '流程图、思维导图、组织架构图、数据表格 —— 这些要能改文字/改数据，用文字或其它方式表达。' +
      '拿不准就调本工具画一张（画错代价远小于不画或自己画）。' +
      '需要先启动 ComfyUI；没启动时本工具会明确告诉你。' +
      '（ComfyUI 空闲 5 分钟没有出图会被自动关闭以释放显存，下次出图前需要重新启动它。）',
    parameters: PARAMETERS,
    timeoutMs: cfg.timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `已出图${Array.isArray(value.files) && value.files.length > 1 ? ` ${value.files.length} 张` : ''}：`
            + `${value.path}（${value.width}x${value.height}，seed ${value.seed}，用时 ${value.seconds}s）`,
        },
      ],
      // 落到 tool/result 的 data.meta，供客户端自己的 draw_image 卡片取图片路径。
      // （注意：客户端只对 read_image 读 meta 当标签，我们自己读是为了自绘卡片。）
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    /** 自测用：本次会提交的工作流（纯函数，不联网）。 */
    planWorkflow: (args) => planWorkflow(cfg, args),
    /** 自测用：该不该发探活请求（纯函数）。 */
    shouldProbe: (args) => shouldProbe(args),
    isConcurrencySafe: () => false,
    /**
     * ★★★ 2026-10-09：**最后一道防线**。
     *
     * 在真正的 `execute` 外面套一层 try/catch，把"任何形态的错误"都规范化成 `Error`。
     * 为什么非要有这一层：宿主把 `execute` 的 reject 值直接 `String()` 了 ——
     * 只要有一处漏网地抛了个普通对象，用户看到的就是 `Error: [object Object]`
     * （真事故，已实测复现）。这一层保证**无论哪里漏出来**，用户看到的都是人话。
     */
    async execute(args, exec) {
      try {
        // ★★★ 2026-10-09 **真事故修复**：必须把这四个**闭包变量**显式传进去！
        //
        //   现场：用户点「画一张」报 `cfg is not defined`。
        //   根因：我为了给 [object Object] 加一层规范化，把原来的 execute 函数体
        //         原样搬成了外层的 `runDraw` —— 但函数体里引用的 `cfg` / `log` /
        //         `onProduced` / `onStart` **本来就是 `makeDrawTool` 的闭包变量**，
        //         搬出去之后**全丢了作用域**。`runDraw` 体里 `cfg` 被引用 17 次、
        //         `log` 10 次，一执行必炸。
        //   ⚠ 这正是"重构时最容易漏"的一类错：`node --check` 只查语法，
        //     自由变量在语法上是合法的，**只有真跑一遍才会暴露**。
        //     ⇒ 所以下面 `_draw_symbol_test.mjs` 专门做"符号解析"静态检查兜底。
        return await runDraw(args, exec, { cfg, log, onProduced, onStart })
      } catch (error) {
        if (error instanceof Error) throw error
        log('warn', `出图过程中抛出了非 Error 对象（已规范化）：${Object.prototype.toString.call(error)}`)
        const normalized = toError(error)
        normalized.message = `出图失败：${normalized.message}`
        throw normalized
      }
    },
  }
}

/**
 * 真正的出图逻辑（由 `execute` 包一层规范化，见上）。
 *
 * ★★★ 2026-10-09：这四个依赖**必须显式传参**，不能再靠闭包。
 *   它原先是 `makeDrawTool` 的**内部函数**，改成顶层函数之后闭包就断了 ——
 *   而 `node --check` 查不出"自由变量"，只有真跑才会报 `cfg is not defined`。
 *   @param args 工具入参
 *   @param exec 执行上下文（含 signal）
 *   @param deps { cfg, log, onProduced, onStart } —— 全部来自 makeDrawTool 的闭包
 */
async function runDraw(args, exec, deps) {
  const { cfg, log, onProduced, onStart } = deps ?? {}
  if (!cfg || typeof log !== 'function') {
    // 配置/日志缺失属于**编码错误**，不该让用户看到"undefined is not a function"这种天书。
    throw new Error('插件内部错误：出图逻辑缺少必需依赖（cfg / log）。这是插件的 bug，请重载插件后重试。')
  }
  const signal = exec?.signal
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('prompt 不能为空：请描述你想画什么。')
      // ★ 出图**一开始**就记一次活动。否则存在这么一个毫秒级窗口：上次出图已过 5 分钟，
      //   这次刚进来还没 submit（所以 /queue 还是空的），定时器正好 tick 到 → 会把
      //   正在用的后端关掉。先 touch 就彻底堵上这个窗口。
      if (typeof onStart === 'function') onStart()

      const aspect = typeof args?.size === 'string' && ASPECTS[args.size] ? args.size : '1:1'
      const megapixels = Number.isFinite(args?.megapixels) && args.megapixels > 0 ? args.megapixels : 1.0
      // ★ 2026-10-09 修正（**真 bug**）：**不要**回落到 cfg.steps —— 它默认 = 8，
      //   那是 turbo8 蒸馏 LoRA 的工作点。一旦回落，basic 档（没装 LoRA）也会拿到
      //   8 步 → 直接出糊图，正好把"没 turbo8 就回退 25 步"的设计整个抵消。
      //   调用方没传就如实传 undefined，由 buildWorkflow 按链路决定默认步数。
      const steps = Number.isFinite(args?.steps) ? Math.trunc(args.steps) : undefined
      const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
      // ★ 2026-10-10（提速 M4）：一次出几张，**默认 1**（守住"每次只生一张"）。
      const count = Number.isFinite(args?.count) ? Math.max(1, Math.min(4, Math.trunc(args.count))) : 1
      const [width, height] = calcSize(aspect, megapixels)

      // ★★★ 2026-10-08：**后端分派**。默认 'comfyui' → 走下面原有逻辑，一行不改。
      if (cfg.imageBackend === 'hipfire') {
        return await executeHipfire(args, exec, { cfg, log, prompt, aspect, megapixels, steps, seed, width, height, onProduced })
      }

      if (shouldProbe(args)) await ensureComfyUp(cfg, log, signal)

      // ★★★ 2026-10-09 新增：**提交前先看一眼队列**，别把任务硬塞进一个正忙的后端。
      //   老行为是闭着眼 submit —— 后端在跑别人的活儿时，这次任务就排在后面，
      //   而 waitForResult 只会说"排队/加载模型中"，用户观感是"卡住了"。
      //   现在：能提前告知就提前告知（一句 honest 的话，胜过三十秒的沉默）。
      //   ⚠ 只"告知"，**不取消、不拒单** —— 用户要的是图，不是被教育。
      // ★★★ 2026-10-10（提速 M6）：这三步**互不依赖**，原先却串行 await ——
      //   · probeReadiness   看队列忙不忙（1 次 /queue）
      //   · uploadReference  传参考图（仅图生图）
      //   · probeCapabilities 探测后端能力（结果按地址缓存 10 分钟）
      //   三者都是对**已就绪** ComfyUI 的独立请求 ⇒ 并发发出，省下两段往返。
      //   ⚠ 必须在 ensureComfyUp 之后（后端得先在线，否则上传/探测都会失败）。
      //   ⚠ 用 Promise.all：任一真失败就整体失败（与原先串行的语义一致）。
      const refPath = typeof args?.reference === 'string' ? args.reference.trim() : ''
      const [ready, reference, caps] = await Promise.all([
        probeReadiness(cfg, signal),
        refPath !== '' ? uploadReference(cfg, refPath, signal) : Promise.resolve(''),
        probeCapabilities(cfg, log, signal),
      ])
      if (ready.online && ready.busy) {
        const ahead = ready.running + ready.pending
        // ⚠ 这里**没法**给用户实时报进度：makeDrawTool 只注入了 onProduced / onStart，
        //   没有进度通道。所以如实落到日志（用户能在诊断里看到），
        //   真正的"看得见的进度"由 waitForResult 负责。
        log('info', `ComfyUI 正忙（前方 ${ahead} 个任务）→ 本次任务会排在后面，稍慢是正常的`)
      }
      // ★ 给了参考图就走图生图：先把图**上传**给 ComfyUI，拿到它那边的文件名。
      //   为什么不自己复制进 input 目录：那个目录未必是配置里以为的那个
      //   （ComfyUI 可以用 --input-directory 改），复制过去很可能放错地方 ✗
      if (refPath !== '') log('info', `参考图已上传：${refPath} → ${reference}`)
      const workflow = buildWorkflow(cfg, { prompt, negative: args?.negative, width, height, steps, seed, reference, count }, caps)
      const usedSteps = workflow[8]?.inputs?.steps ?? steps
      if (count > 1 && reference !== '') {
        log('warn', `图生图暂不支持一次多张（count=${count} 已按 1 张处理）`)
      }
      // ★★★ 2026-10-09 **以"生效尺寸"为准**（修「出的图尺寸不对」那个误报）。
      //   锁尺寸档（forceOptimizedSize=true）下，buildWorkflow 会把 864x1152 这类
      //   请求**改写成 1024x1024**。之后的"尺寸校验 / 文件名 / 返回值"必须都用
      //   **实际生效的那个**，否则就是在拿请求值跟实际值对账 —— 必然对不上。
      const eff = workflow.__effective ?? { width, height, locked: false }
      // ★ 2026-10-10 修 bug：改成 `let` —— 图生图的真实输出尺寸要**用实测值覆盖**（见下）。
      let outWidth = eff.width
      let outHeight = eff.height
      if (outWidth !== width || outHeight !== height) {
        log('info', `尺寸已按优化档归一到 ${outWidth}x${outHeight}（请求 ${width}x${height}；`
          + `forceOptimizedSize=${cfg.forceOptimizedSize !== false}）`)
      }
      log('info', `提交任务 ${outWidth}x${outHeight} 档位=${caps.level} steps=${usedSteps} cfg=${workflow[8]?.inputs?.cfg} seed=${seed}${reference === '' ? '（文生图）' : `（图生图 参考=${reference}）`}`)
      const promptId = await submitPrompt(cfg, workflow, signal)

      const started = Date.now()
      const images = await waitForResult(cfg, promptId, {
        signal,
        timeoutMs: cfg.timeoutMs,
        onTick: (note) => log('info', `prompt_id=${promptId} ${note}`),
      })
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1))

      await fsp.mkdir(cfg.outputDir, { recursive: true })
      const savedFiles = []
      let firstPath = ''
      let index = 0
      // ★★ 2026-10-08 主人要求「每次只生一张图」——**默认仍严格守住**：
      //   `count` 默认 1，切片也只取前 count 张。
      //   ★ 2026-10-10（提速 M4）：只有调用方**显式**传 count=2..4（用户明确要一次多张）时
      //   才会批量产出；普通出图仍是 1 张。批量比"连着调多次"省 (N-1) 次模型装卸。
      for (const image of images.slice(0, count)) {
        index += 1
        const bytes = await fetchImageBytes(cfg, image, signal)

        // ★★ 尺寸校验（2026-10-08 真事故的防线）：
        //   ComfyUI 的 output 目录被 `--output-directory` 改过，而两个实例的
        //   SaveImage 编号**都从 00001 开始** → 旧目录里恰好躺着同名的旧文件
        //   → 老代码先读本地、读到了 → 把**昨天的图**当成这次的成果，
        //     还按新 prompt 命名、报新请求的尺寸。主人一眼看出"画得完全不对"。
        //   ✓ 现在：取图先走 /view（顺序已反转），这里再加一道 —— 尺寸不符**当场报错**，
        //     绝不静默产出错图。机器"知道"的事，就该拦住。
        //   ⚠ 只对**文生图**校验：图生图的输出尺寸由 resolution=sqrt(W*H) 决定，
        //     和请求的 width/height 本来就不是一回事，校验会误报。
        //   ★★★ 2026-10-09 修正：比对基准从"请求尺寸"改成**"生效尺寸"(outWidth/outHeight)**。
        //     锁尺寸档会把 864x1152 归一到 1024x1024，拿请求值比对必然误报
        //     （实测就是这样把一张正常图拦下来报"尺寸不对"的）。
        // ★★★ 2026-10-10 修 bug（图生图尺寸）：图生图的输出尺寸由
        //   `resolution = round(sqrt(effWidth*effHeight))` **直接决定**（≈正方形），
        //   与请求的 width/height **本来就不是一回事**。原代码只跳过校验、却仍拿请求值
        //   当"实际尺寸"写进文件名与返回值 —— 属于数据错误（比如请求 864x1152、实际 ~998²）。
        //   ⇒ 这里用**实测 PNG 尺寸**覆盖 outWidth/outHeight，文件名与返回值都跟着变对。
        const actual = readPngSize(bytes)
        if (reference !== '' && actual !== null) {
          outWidth = actual.width
          outHeight = actual.height
        }
        if (reference === '') {
          if (actual !== null && (actual.width !== outWidth || actual.height !== outHeight)) {
            throw new Error(
              `ComfyUI 出的图尺寸不对：本次任务应为 ${outWidth}x${outHeight}，实际 ${actual.width}x${actual.height}。`
              + `\n（原始请求 ${width}x${height}，${outWidth !== width || outHeight !== height
                ? `已被"优化档"归一到 ${outWidth}x${outHeight}`
                : '未被归一'}；比对基准是归一后的生效尺寸。）`
              + '\n这通常意味着取到的不是本次任务的文件（output 目录被改过，或目录里存在同名旧文件）。'
              + `\n本次文件名：${image.filename ?? '(未知)'}`,
            )
          }
        }

        const filename = `${safeStem(prompt, 22)}_${cfg.filePrefix}_${outWidth}x${outHeight}_${String(index).padStart(2, '0')}.png`
        const target = await uniquePath(cfg.outputDir, filename)
        await fsp.writeFile(target, bytes)
        savedFiles.push(target)
        if (firstPath === '') firstPath = target
        log('info', `落盘 ${target}（${bytes.length} 字节）`)
      }
      if (firstPath === '') throw new Error('ComfyUI 报告成功，但没有取到任何图片')

      // ★★★ 2026-10-09：这里返回的 width/height 必须是**生效尺寸** ——
      //   它会直接进工具返回值显示给模型看。以前返回请求值，
      //   于是"图是 1024²、回报却是 864x1152"，前后对不上。
      //   原始请求值另用 reqWidth/reqHeight 保留，供排查。
      const value = {
        path: firstPath,
        width: outWidth,
        height: outHeight,
        seed,
        seconds,
        files: savedFiles,
        ...(outWidth !== width || outHeight !== height ? { requestedWidth: width, requestedHeight: height } : {}),
      }
      if (onProduced) {
        try {
          onProduced(exec, value)
        } catch (error) {
          log('warn', `交付事件登记失败（不影响出图）：${error?.message ?? error}`)
        }
      }
      return value
}

/* ------------------------------------------------------------------ 插件入口 ---- */

/**
 * 宿主侧入口。按主人的经验（MEMO 5189）：**用局部 `root.inject` 等服务**，
 * 不要用对象级 `inject` —— 对象级会把整个 apply 推迟到服务就绪之后，某个服务
 * 在老宿主里不存在时插件会**永远不 apply**，而且不报错，极难排查。
 */
/**
 * ★★★ 2026-10-09 **同步落盘诊断**（DSH/Electron 环境下唯一可靠的取证手段）。
 *
 * ## 为什么必须用它
 *   插件跑在 DSH（Electron）主进程里，它的 stdout/stderr 我们**拿不到** ——
 *   `console.log`／宿主 logger 全都看不到。所以"插件到底加载到哪一步、
 *   每次轮询看到什么值"就只能靠它自己写文件。
 *
 * ## 为什么用 `writeFileSync` 而不是 `fsp.writeFile`
 *   异步写需要 await、还可能被事件循环里别的活插队；而我们在排查的就是
 *   "某个 await 之后的代码到底有没有执行"。同步写**在调用点当场落盘**，
 *   不会因为后面抛错/中断而丢失 —— 排查期这点极重要。
 *
 * ## 会不会拖慢/写爆
 *   每次调用只 append 一行、文件上限 400 行（超出自动截断）。
 *   只在**插件加载**与**状态端点每次轮询**时写，开销可忽略。
 *   排查结束后整块删掉即可（已用 `DSHQP_DIAG` 开关收口，见下）。
 */
export function diag(tag, detail) {
  if (!DIAG_ON || DIAG_FILE === '') return
  try {
    const line = `${new Date().toISOString()} [${tag}] ${detail ?? ''}\n`
    let prev = ''
    try { prev = readFileSync(DIAG_FILE, 'utf8') } catch { prev = '' }
    const lines = prev.split('\n')
    const kept = lines.length > 400 ? `${lines.slice(-400).join('\n')}\n` : prev
    writeFileSync(DIAG_FILE, kept + line, 'utf8')
  } catch {
    /* 诊断永远不该成为故障源 */
  }
}

/**
 * ★★★ 2026-10-09 **安全探测宿主可选服务**（血泪教训换来的工具函数）。
 *
 * ## 为什么不能用 `typeof ctx?.xxx` 探测
 *   cordis 的 `ctx` 是 **Proxy**（见 `cordis/lib/index.js` 的 `ReflectService.handler.get`）。
 *   访问一个"**没有写在 `inject` 里、当前也未就绪**"的服务属性时，它**直接 throw**：
 *     `Error: cannot get property "<name>" without inject`
 *   ⇒ 所以 `typeof ctx?.webServer` 不是"安全的存在性检查"，它等于**真去读那个属性**。
 *
 * ## 实际踩到的后果（用 DSH 自带 cordis 真实复现）
 *   `diag('host', … webServer=${typeof ctx?.webServer} …)` 这一行本身抛错
 *   → `apply` 抛错 → fiber 进入 `FAILED`
 *   → 插件管理器显示「**异常**」、工具注册数 = 0、状态端点根本没注册
 *   → 界面表现：**一直卡在"正在启动中"**。
 *
 * ## 正确姿势
 *   · 探测服务是否存在：`ctx.get?.(name)` —— 不存在时返回 `undefined`，**不抛错**
 *     （`ctx.get` 本身是混入在 ctx 上的方法，属于安全属性）。
 *   · 非要读属性：包在 try 里（就是本函数）。
 *
 * @param read 一个惰性读取器；抛错则视为"该服务不可用"
 * @returns 读到的值的 `typeof` 字符串，读不到返回 `'absent'`
 */
function safePeek(read) {
  try {
    const v = read()
    return v === undefined ? 'absent' : typeof v
  } catch {
    return 'absent'
  }
}

export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const log = makeLog(root)
  // ★ 第一行就记：能证明"插件 host 半边确实被加载了"。
  //   （之前排查时最大的困难就是分不清"没加载"和"加载了但判断错"。）
  diag('apply', `插件开始加载 pid=${process.pid} platform=${process.platform} node=${process.version}`)
  // ★ 落盘的界面偏好（生图动画）恢复。**优先级低于显式配置** ——
  //   cordis.patch.yml 里写了 flowStyle 就以它为准，没写才用上次在界面上选的。
  const savedUi = readUiState()
  if (rawConfig?.flowStyle === undefined && FLOW_STYLES.includes(savedUi.flowStyle)) {
    cfg.flowStyle = savedUi.flowStyle
    log('info', `生图动画：沿用上次界面选择（${cfg.flowStyle}）`)
  }
  // ★★★ 2026-10-10 修 bug：**「生图判断」档位原先只写不读** ——
  //   状态端点把它写进了 qwen-paint-ui.json（`?drawTrigger=xxx`），但 apply() 从不读回，
  //   于是"重载后生效"永远不生效：重启 DSH 后 cfg.drawTrigger 又回到 DEFAULTS。
  //   这里与 flowStyle **对称**地补上恢复逻辑（显式配置优先）。
  if (rawConfig?.drawTrigger === undefined
      && Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, savedUi.drawTrigger)) {
    cfg.drawTrigger = savedUi.drawTrigger
    log('info', `生图判断策略：沿用上次界面选择（${cfg.drawTrigger}）`)
  }

  // ★★★ 2026-10-12（用户要求：允许自选输出目录）**启动时就校验并定死** outputDir。
  //   原来直接拿去用 —— 配错（盘符不存在 / 没写权限 / 路径指到文件）要到**出图那一刻**
  //   才失败，报的还是"写文件失败"这种看不出原因的错。现在启动时校验、明确告知、安全退回。
  //   校验后的绝对路径写回 cfg.outputDir，后面所有用它的地方（落盘、读回、面板显示）就都一致了。
  {
    const r = resolveOutputDir(rawConfig?.outputDir ?? DEFAULTS.outputDir, log)
    cfg.outputDir = r.dir
    cfg.outputDirSource = r.source
    log('info', `输出目录：${r.dir}（${r.source}）`)
    if (r.problem) {
      log('warn', `⚠ 配置里的 outputDir 不可用（${r.problem}）→ 已退回默认目录。`
        + '改好后重开 DSH 即可生效。')
    }
  }

  // ★ 2026-10-09 取证：确认 apply 真的走到了"注册 inject"这一步。
  //   有了本行 + 回调里的 [host]，就能一刀切开两种完全不同的故障：
  //     · 只有本行、**没有** [host] → 依赖服务（tools / sessionProjections）未就绪，
  //       回调被 cordis 挂起（不报错、不执行）—— 工具和状态端点都不会注册；
  //     · **连本行都没有** → apply 在更早的地方就中断了。
  //   实测踩到过：某次重启后日志只有 [apply] 一行，靠这两行才能立刻分辨是哪一种。
  // ★★★ 2026-10-09 **关键修正**：依赖从 `['tools','sessionProjections']` 收窄为 `['tools']`。
  //
  //   为什么必须改：实测日志反复出现「有 [inject]、**没有 [host]**」——
  //   即 `root.inject` 被调用了、但**回调从未执行**。cordis 的 inject 在依赖未满足时
  //   是**静默挂起**（不报错、不执行），于是工具、状态端点、提示词全都注册不上，
  //   界面上就是"一直卡在正在启动中"。
  //
  //   `sessionProjections` 在本插件里**只用于一个 try/catch 内的可选查询**
  //   （取 turn boundary，取不到就跳过）—— 它根本不配当"必需依赖"。
  //   把它列为必需，等于赌"这个服务一定在插件加载前就绪"；赌输一次，整个插件哑火。
  //   ⇒ 现在改成**可选获取**（见下面 onProduced 里的 `sp`），并把它记录进 [host] 快照。
  /** 初始化回调是否真的执行了 —— 供下面的兜底定时器判断（见 8 秒回看）。 */
  let inited = false
  diag('inject', '准备注册 root.inject([tools])（sessionProjections 已改为可选，不再阻塞）')
  // ★ 兜底回看：8 秒后若回调仍未执行，就把"依赖真没就绪"这件事**明确写进日志** ——
  //   以前这种情况是完全静默的（[apply] 之后什么都没有），只能靠猜。
  try {
    const t = setTimeout(() => {
      if (inited) return
      diag('inject', '8 秒内 root.inject([tools]) 回调仍未执行 → tools 服务未就绪（插件哑火，工具/状态端点都没注册）')
    }, 8000)
    if (typeof t?.unref === 'function') t.unref()
  } catch { /* 取证不该成为故障源 */ }
  // ★★★ 2026-10-09：改成**立即执行**（原先是 `root.inject(['tools'], cb)` —— 那个回调
  //   在本机 DSH 上**从不执行**，日志里就是"[inject] 准备注册"之后再无下文。
  //   见文件上方 `export const inject = ['tools']` 的详细说明。）
  //   `ctx` 就是 apply 的第一个参数：DSH 已按 `inject = ['tools']` 等 tools 就绪后才调 apply，
  //   所以这里**直接注册即可**，不需要再 inject 一次。
  ;((ctx) => {
    inited = true
    // ★★★ 2026-10-09 **宿主能力快照**（终结猜测用）。
    //   为什么值得单独记一行：本插件历史上被"宿主到底提供了什么"坑过多次 ——
    //   实测踩到 `ctx.on is not a function`（裸调用抛错 → 掐死后续所有初始化
    //   → 状态端点注册不上 → 界面"一直卡在启动中"）。
    //   这一行把宿主给的全部关键 API 一次性列出来，下次出问题**不用再猜**。
    //   ★★★ 2026-10-09 **灾难级修正**：这一行原来写的是
    //       `webServer=${typeof ctx?.webServer}`
    //     —— 结果它自己成了故障源。**cordis 的 ctx 是 Proxy，
    //     访问一个"没写在 inject 里、当前也没就绪"的服务属性会【直接抛错】**：
    //       Error: cannot get property "webServer" without inject
    //       at lib/index.js (ctx.tools.register 之前)
    //     实测（用 DSH 自带 cordis 真实复现）：
    //       fiber.state = 3 (FAILED)  ← 插件管理器显示「异常」就是它
    //       工具注册数 = 0、状态端点根本没注册 → 界面卡在"正在启动中"
    //     教训：**`typeof ctx?.xxx` 不是"安全的探测"，在 Proxy 上它等于"读取"**。
    //     探测可选服务只能走 `ctx.get?.(name)`（下面这种），或包在 try 里。
    diag('host', `ctx API：on=${typeof ctx?.on} effect=${typeof ctx?.effect}`
      + ` inject=${typeof ctx?.inject} get=${typeof ctx?.get}`
      + ` tools=${typeof ctx?.tools}`
      + ` webServer=${safePeek(() => ctx?.webServer)}`
      + ` sessionProjections=${safePeek(() => ctx?.sessionProjections)}`)

    const status = makeComfyStatus(cfg)
    const idle = makeIdleShutdown(cfg, log, status)

    /** 出图后：登记交付物（与官方 present 同载荷）+ 记一次活动时间。 */
    const pending = new WeakMap()
    const onProduced = (exec, value) => {
      idle.touch()
      const session = exec?.agent?.session
      if (session === undefined) return
      let turn
      try {
        // ★ 2026-10-09：`sessionProjections` 改成**可选获取** —— 它已不是 inject 的必需依赖，
        //   所以这里必须自己兜底（宿主没这个服务时静默跳过"登记 turn"即可，不影响出图）。
        //   ⚠⚠ **顺序很重要**：ctx 是 Proxy，`ctx.sessionProjections` 在未 inject 时**会抛错**。
        //     如果写成 `ctx?.sessionProjections ?? ctx?.get?.(...)`，
        //     左侧一抛错就**直接跳进 catch**，右侧那条**永远没机会执行** ——
        //     等于这个服务永远取不到。所以必须**先走安全的 `ctx.get`**。
        const sp = ctx?.get?.('sessionProjections')
        const boundary = sp?.stateOf?.(session, 'turnBoundary')
        turn = boundary?.lastTurn
      } catch {
        turn = undefined
      }
      if (!Number.isSafeInteger(turn)) return
      const files = value.files.map((file) => ({ path: file, description: '千问（Qwen-Image 2.1）生成' }))
      pending.set(exec, { session, turn, files })
    }

    const tool = makeDrawTool(ctx, cfg, log, onProduced, () => idle.touch())

    // ★★★ 2026-10-09：**总开关**（`enabled`）。
    //   false 时不注册绘图工具、不注入提示词、不预热后端、不做空闲关停 ——
    //   插件对 DSH 相当于"不存在"，但下面两个**诊断类**工具仍然注册：
    //   它们只读、不画图，出了问题还得靠它们排查。
    if (cfg.enabled === false) {
      const offList = makeListModelsTool(cfg, log)
      ctx.tools.register(offList)
      const offAccel = makeAccelTool(cfg, log)
      ctx.tools.register(offAccel)
      log('info', `插件已停用（enabled=false）：不注册 draw_image、不注入提示词、不预热后端；`
        + `仅保留诊断工具 ${offList.name} / ${offAccel.name}`)
      return
    }

    // ★★★ 2026-10-09 **步骤级保护 + 取证**（这次「卡在启动中」的真正修法）。
    //
    //   ## 为什么必须这么改（实测证据）
    //   诊断日志里永远只有 `[apply]` 和 `[tools]` 两行，**之后再无任何记录** ——
    //   包括我上一轮新加的 `[route] 准备注册` 也没出现。而 `[tools]`(原 3693) 与
    //   route 注册(原 3847) 同在**同一个 inject 回调**内、中间没有提前 return，
    //   这说明：**回调执行到中途抛了未捕获的异常，整个回调被中断**，
    //   后面的「状态端点注册」压根没跑到 —— 前端于是永远拿不到状态，卡在"启动中"。
    //
    //   ## 之前的问题
    //   这段初始化里有若干**裸调用宿主 API**的地方（`ctx.tools.register` / `ctx.on` …），
    //   任何一处因宿主版本差异或服务缺失而抛错，都会**连带掐死后面所有初始化**
    //   （包括状态端点）。而项目自己的约定写得很清楚（见下方空闲关停处注释）：
    //   「宿主若缺 XX，也不许把插件加载拖垮」—— 这里以前漏了。
    //
    //   ## 现在
    //   每一步都**单独 try/catch**，失败只 warn + 落盘 diag，**绝不再阻断后续步骤**；
    //   并且每步都写一行 `[init]` 诊断 —— 下次一眼就能看出卡在哪一步。
    const step = (name, fn) => {
      try {
        const value = fn()
        diag('init', `${name} OK`)
        return value
      } catch (error) {
        const msg = String(error?.message ?? error)
        diag('init', `${name} 失败：${msg}`)
        log('warn', `初始化步骤「${name}」失败（继续后面的步骤）：${msg}`)
        return undefined
      }
    }

    step('register.draw_image', () => {
      ctx.tools.register(tool)
      log('info', `已注册工具 ${tool.name}（ComfyUI=${cfg.comfyUrl}，输出=${cfg.outputDir}，生图策略=${cfg.drawTrigger}）`)
      diag('tools', `已注册 ${tool.name} comfyUrl=${cfg.comfyUrl} enabled=${cfg.enabled !== false} drawTrigger=${cfg.drawTrigger}`)
    })

    // ★★ 2026-10-09 新增：列出本机 ComfyUI 可用模型（正面回应"查看可用的模型"）。
    step('register.list_available_models', () => {
      const listModelsTool = makeListModelsTool(cfg, log)
      ctx.tools.register(listModelsTool)
      log('info', `已注册工具 ${listModelsTool.name}（ComfyUI=${cfg.comfyUrl}）`)
    })

    // ★★ 2026-10-09 新增：查看 / 配置加速环境（GPU 厂商自适应 + 厂家专用加速包）。
    step('register.accel_env', () => {
      const accelTool = makeAccelTool(cfg, log)
      ctx.tools.register(accelTool)
      log('info', `已注册工具 ${accelTool.name}（自动安装=${cfg.accelAutoInstall === true ? '允许' : '已禁止'}）`)
    })

    // ★★★ 2026-10-09：**自动加速环境配置**。
    //   检测到本机缺哪个厂商专用加速包 → 自动运行下载脚本装上。
    //   包内只带下载器、不预置已下载的文件，所以这里是真的去网上取。
    //   延迟 20 秒 + unref：避开插件加载与首次出图的路径，绝不拖慢任何正常操作；
    //   整个过程失败也只写日志，出图功能完全不受影响。
    if (cfg.accelAutoInstall === true) {
      const timer = setTimeout(() => {
        autoSetupAcceleration(cfg, log).catch(() => {})
      }, 20000)
      if (typeof timer.unref === 'function') timer.unref()
      log('info', '加速环境自动配置已启用（20 秒后自检并补齐缺失的厂商专用加速包）')
    }

    // 让"出图后必须在正文里内联展示"成为插件的固有行为，而不是靠模型自觉。
    // 走的是官方那条路（与内核自带的 FILE_REFERENCE_PROMPT 同一机制）：
    // 正文里的 Markdown 图片 → 客户端 fileMediaUrl() 重写成 /api/file?path=… → 真 <img>。
    // ⚠ 不要改用 ImageBlock / presentCall / presentationMeta —— 客户端对非 read_image
    //   工具返回的 image block 只会 JSON.stringify 成文本，present 卡片里也根本没有 <img>。
    try {
      const systemPrompt = ctx.get?.('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        // ★★★ 2026-10-08 十五次修正 —— **删掉"出图前先发动图"这条指令**。
        //   主人早就说过「不用图片了」（改成 DOM 动画块），但我一直没把这条摘掉，
        //   结果出图时**动图和动画块同时出现**，看起来就像"重复发了一遍动画"。
        //   ✓ 现在动画只由客户端的 DOM 块承担 —— 那才是"位置正确、随消息滚动"的正解。
        //     本地副本与图片路由保留，仅作备用，**不再进正文**。
        prepareLoadingGif(cfg, log).catch(() => {})   // 只留一份本地副本备用

        systemPrompt.section({
          name: 'qwen-paint:inline-generated-image',
          order: 9100, // 紧挨内核 DELIVERABLE_FILE_REFERENCES(9000) 之后
          text: INLINE_IMAGE_PROMPT,
        })
        log('info', '已注册 systemPrompt 段落：出图后内联展示')

        // ★ 主人定的铁律（2026-10-07，当天三次加严；2026-10-08 又加两条）：
        //   ① 识别到要生图 → 只简短回一句，然后**立刻开画**（不解释、不列参数、不反问）
        //   ② 出图后 → 回复正文**只保留那一句话，紧接着就是图片**（不写耗时/尺寸/提示词等附加说明）
        //   ③ 生成中的呼吸灯 → 出图后由客户端**平滑过渡**成图片（插件已实现，模型无需描述过程）
        //   ④ ★ 思考过程也要极简 —— 界面上思考块是**显示出来**的，用户要看的是图不是分析
        //   ⑤ ★★ 2026-10-08：**生图意图识别提到最高优先级** —— 判断出来就**第一个动作调工具**
        //   ⑥ ★★ 2026-10-08：**默认一次只生一张**（代码层面保证，见落盘那里的 slice(0, count)；
        //      count 默认 1。2026-10-10 提速 M4 后允许"用户明确要一次多张"时传 count=2-4）
        //
        //   ⚠ 为什么"立刻调工具"等于"立刻切动画"：客户端插件**看不到用户消息**，
        //     它能感知的最早事件就是"工具开始跑"。所以动画起点的早晚，
        //     完全取决于模型多快调用 draw_image —— 提示词越狠，动画来得越早。
        systemPrompt.section({
          name: 'qwen-paint:brief-reply-then-draw',
          order: 9101,
          text: buildDrawIntentPrompt(cfg.drawTrigger),
        })
        log('info', `已注册 systemPrompt 段落：生图意图判定（策略=${cfg.drawTrigger}）`)
      }
    } catch (error) {
      log('warn', `注册 systemPrompt 段落失败（不影响出图）：${error?.message ?? error}`)
    }

    // ★★★ 2026-10-08 十七次修正 —— **DSH 启动时预热后端**。
    //
    //   主人反馈「怎么我重启就关闭了」：ComfyUI 是 DSH 的子进程，
    //   DSH 重启时整棵进程树被终止（Windows 默认行为），它被连带带走。
    //   而原来只在"出图时"才拉起 —— 于是每次重启后第一次出图都要冷启动等 30 多秒。
    //
    //   ✓ 修法：插件加载后**立刻在后台探一次**，不在线就异步拉起。
    //     这样重启 DSH 之后不用等出图，后端已经在跑了。
    //     ⚠ 完全异步：不 await、不阻塞插件加载，更不阻塞 DSH 启动；
    //       失败只 warn（出图时还有一次自动启动兜底，不会因为预热失败而画不了图）。
    try {
      ctx.effect(() => {
        if (cfg.autoStartComfy === false) return undefined
        let cancelled = false
        Promise.resolve()
          .then(() => status.probe(false))
          .then((online) => {
            if (cancelled) return undefined
            // ★★★ 2026-10-08 修「自动关闭失效」（主人实测）：
            //   原来空闲计时**只在出图成功之后**才开启（lastActivityAt 初始为 null），
            //   而 tick() 的第一道判断就是 `if (state.lastActivityAt === null) return false`
            //   —— 于是"重启 DSH 之后一次图都没画"的场景里，**它永远不关**，
            //   主人在菜单里选「1 分钟后关闭」也没用（状态显示为"在线"，不是"空闲 N 分"）。
            //   ✓ 现在：预热这一趟只要**确认后端在线**（原本就在线、或刚被拉起来），
            //     就把计时起点定在此刻。之后 N 分钟没有新活动，照样会关。
            //     （出图开始时 / 出图成功后依然会 touch 续期，原有语义不变。）
            if (online) {
              idle.touch()
              log('info', '启动预热：ComfyUI 已在线（空闲计时从此刻开始）')
              return undefined
            }
            log('info', '启动预热：ComfyUI 不在线，后台拉起（隐藏窗口）')
            return ensureComfyUp(cfg, log, null).then((started) => {
              if (!cancelled) idle.touch()
              return started
            })
          })
          .catch((error) => log('warn', `启动预热失败（出图时还会再试）：${error?.message ?? error}`))
        return () => { cancelled = true }
      }, 'qwen-paint:warmup')
    } catch (error) {
      log('warn', `注册启动预热失败（不影响出图）：${error?.message ?? error}`)
    }

    // 官方 present 就是这么干的：工具**成功**之后才 append 交付事件。
    // ★ 2026-10-09：**必须用 step 包住**。`ctx.on` 属于宿主 API，裁剪版/老版本宿主上
    //   可能不存在；裸调用一旦抛 TypeError，就会**掐死同一个回调里后面所有初始化**
    //   （包括状态端点注册）—— 这正是「界面卡在启动中」的中断点。
    step('hook.tools-result', () => {
      ctx.on('tools/result', (exec, result) => {
        const delivery = pending.get(exec)
        pending.delete(exec)
        if (delivery === undefined || result?.isError) return
        try {
          delivery.session.append('deliverables/presented', {
            turn: delivery.turn,
            callId: exec.callId,
            files: delivery.files,
          })
        } catch (error) {
          log('warn', `append deliverables/presented 失败：${error?.message ?? error}`)
        }
      })
    })

    // 空闲关停的定时器：随 ctx 卸载自动清掉。
    // ★ 全包 try/catch：宿主若缺 ctx.effect（裁剪版/老版本），也不许把插件加载拖垮。
    if (cfg.autoShutdown) {
      // ★ 2026-10-10（提速 M5）：抽成函数，并在宿主**没有 ctx.effect** 时用裸定时器兜底。
      //   原先直接 `ctx.effect(cb)`：若该宿主不执行 effect 回调（本机历史上 inject 回调
      //   就出现过"注册了但从不执行"），空闲关停会**整个不启动**，只在 catch 里留一句 warn
      //   —— 功能等于没有，却很难被发现。现在：effect 不可用就自己起定时器。
      const startIdleTimer = () => {
        const timer = setInterval(() => {
          idle.tick().catch((error) => log('warn', `空闲检查出错：${error?.message ?? error}`))
        }, cfg.idleCheckMs)
        // 别让这个定时器把 node 进程吊住
        if (typeof timer.unref === 'function') timer.unref()
        log('info', `空闲关停已启用：出图后 ${Math.round(cfg.idleShutdownMs / 60000)} 分钟没再出图就关掉 ComfyUI`
          + `（每 ${Math.round(cfg.idleCheckMs / 1000)} 秒检查一次）`)
        return () => clearInterval(timer)
      }
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(startIdleTimer, 'qwen-paint:idle-shutdown')
        } else {
          // 宿主没有 effect（裁剪版/老版本）→ 直接起定时器（已 unref，不会吊住进程）。
          // 代价：插件卸载时无法自动清理；但 unref 的定时器随进程退出即消失，可接受。
          log('warn', '宿主没有 ctx.effect → 空闲关停改用裸定时器（无法随插件卸载自动清理）')
          startIdleTimer()
        }
      } catch (error) {
        log('warn', `启动空闲关停失败（不影响出图）：${error?.message ?? error}`)
      }
    }

    // 只读状态端点（客户端的状态指示器读它）。webServer 是可选服务 → 用局部 inject，
    // 没有它插件照常出图，只是不显示状态。
    // ★ ctx.inject 本身也可能不存在 → 先检查，宿主差异不许把插件加载拖垮。
    if (typeof ctx.inject !== 'function') {
      log('warn', '宿主没有 ctx.inject，跳过状态端点（不影响出图）')
      // ★ 2026-10-09 补：这里以前**没有任何取证**，外面只能看到"状态端点不通"，
      //   却分不清是"没注册"还是"注册了但请求失败"。现在如实落盘。
      diag('route', `宿主无 ctx.inject → 状态端点跳过（webServer 探测=${safePeek(() => ctx?.webServer)}）`)
      return
    }
    // ★ 2026-10-09 补：登记"我开始尝试了"。若之后日志里**没有**下面那条
    //   「webServer 已就绪」，就说明 inject 回调从未执行 —— 即当前 profile
    //   根本没有 webServer 服务（官方插件 modlens 的注释明确写了：
    //   webServer 只在 web profile 下存在，不存在时闭包永不运行）。
    //   ⚠ 这里**绝不能**写 `ctx?.webServer ? '有' : '无'` —— ctx 是 Proxy，
    //     读未 inject 的 webServer 会直接抛错（详见 safePeek 的注释）。
    diag('route', `准备注册状态端点：ctx.inject 可用，webServer 探测=${safePeek(() => ctx?.webServer)}`)
    /** 状态端点是否已注册成功。供下面的延时回看用 —— 这是"到底注册上没有"的权威标志。 */
    let routeMounted = false
    ctx.inject(['webServer'], (webCtx) => {
      diag('route', 'webServer 已就绪，开始注册状态端点')
      // ★ 命中计数：用来**从外部**判断客户端的状态指示器到底加载了没有 ——
      //   它每 5 秒轮询一次、且优先打 /api/ 那条路径；api 计数一直涨就说明
      //   客户端半边确实加载并在运行（哪怕界面上暂时没看见）。
      //   我自己用 PowerShell 探测走的是不带 /api/ 的根路径，两者互不混淆。
      const visits = { api: 0, plain: 0, pings: [], firstAt: null, lastAt: null }
      // ★★★ 2026-10-09：原来这里有个 `comfyStartRequestedAt` 时间戳，用来表达
      //   "最近点过启动、所以算启动中"。**已整个删除** ——
      //   它和 `launch.phase` 是**两套并行状态**，互相覆盖，谁也说不清最终值，
      //   这正是主人反复看到"一直卡在启动中"的根源。
      //   现在 `starting` 只有一个来源：`launch.phase`（见文件上方的重写说明）。
      const handler = async (req, res) => {
        try {
          const hit = String(req?.url ?? '')
          if (hit.startsWith('/api/')) visits.api += 1
          else visits.plain += 1
          // 客户端会在 apply 的每个分支自报一次（?ping=apply / no-react / no-slots / registered），
          // 去重记下来 —— 这是判断"客户端到底加载到哪一步"的唯一外部依据。
          const ping = /[?&]ping=([^&]*)/u.exec(hit)
          if (ping !== null) {
            let reason = ping[1]
            try { reason = decodeURIComponent(reason) } catch { /* 原样用 */ }
            if (reason !== '' && !visits.pings.includes(reason)) visits.pings.push(reason)
          }
          if (visits.firstAt === null) visits.firstAt = Date.now()
          visits.lastAt = Date.now()
        } catch {
          /* 计数失败不影响状态返回 */
        }
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        try {
          const online = await status.probe()
          // ★★ 2026-10-07 新增：`?idleMinutes=N` 现场改「多久没出图就自动关掉后端」。
          //   N = 0 表示**不自动关闭**。安全性：这个端点只放行本机请求（isLocalRequest 在更上面挡住），
          //   而且只改一个数字，不碰任何路径或命令；越界值直接忽略。
          const query = new URL(req.url ?? '/', 'http://127.0.0.1')
          const rawMinutes = query.searchParams.get('idleMinutes')
          if (rawMinutes !== null) {
            const minutes = Number(rawMinutes)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              cfg.idleShutdownMs = Math.round(minutes) * 60000
              // ★★★ 2026-10-08 修「自动关闭失效」：**选完档位就从此刻开始计时**。
              //   原来这里只改数字、不碰计时起点，于是"重启后从没出过图（起点为 null）"
              //   时，主人选了「1 分钟后关闭」也不会关 —— 他实测报的就是这个。
              //   选 0（不自动关闭）时不留起点，保持"不关"的语义干净。
              if (minutes > 0) idle.touch()
              log('info', minutes <= 0
                ? '空闲关停：已按界面选择关闭（不再自动关后端）'
                : `空闲关停：已按界面选择改为 ${Math.round(minutes)} 分钟`)
            }
          }

          // ★★ 2026-10-08 新增：`?flowStyle=xxx` 现场改「生图过程的动画」。
          //   界面（composer 状态点的菜单）点一下就调这里；合法值**立刻落盘**，
          //   重启 DSH 之后照样记得住。非法值只记一行日志、绝不写进样式名。
          const rawStyle = query.searchParams.get('flowStyle')
          if (rawStyle !== null) {
            if (FLOW_STYLES.includes(rawStyle)) {
              cfg.flowStyle = rawStyle
              // 合并写：别把文件里以后可能新增的其它偏好字段冲掉
              writeUiState({ ...readUiState(), flowStyle: rawStyle }, log)
              log('info', `生图动画已改为 ${rawStyle}`)
            } else {
              log('warn', `生图动画取值不在白名单里，已忽略：${String(rawStyle).slice(0, 40)}`)
            }
          }

          // ★★★ 2026-10-09 新增：`?drawTrigger=xxx` —— 界面上切换「生图判断」档位。
          //
          //   主人原话：「不是你这个档位写是写进去的，但是你倒是给人家在界面上一个选择的按键呀」。
          //   确实——四档策略只存在于配置文件和提示词里，用户在界面上根本够不着。
          //
          //   ⚠ 生效时机：档位最终是**写进 systemPrompt 段落**的（模型靠它判断要不要画），
          //     而 systemPrompt 是在插件**加载时**注册的静态文本。所以：
          //       · 配置**立刻落盘**（重启也记得住）；
          //       · 但提示词要**重载插件 / 重启 DSH** 才会换成新档位。
          //     这一点必须让用户知道，否则他会以为"选了没用"——所以界面上那组标题
          //     直接写明了"重载后生效"，而不是藏着不说。
          const rawTrigger = query.searchParams.get('drawTrigger')
          if (rawTrigger !== null) {
            if (Object.prototype.hasOwnProperty.call(DRAW_INTENT_MODES, rawTrigger)) {
              cfg.drawTrigger = rawTrigger
              writeUiState({ ...readUiState(), drawTrigger: rawTrigger }, log)
              log('info', `生图判断策略已改为 ${rawTrigger}（需重载插件后生效）`)
            } else {
              log('warn', `生图判断策略取值不在白名单里，已忽略：${String(rawTrigger).slice(0, 40)}`)
            }
          }

          // ★★★ 2026-10-09 诊断落盘：把每次状态轮询看到的**真实值**写进文件。
          //
          //   为什么需要它：主人反复反馈"界面卡在启动中"，但我在外面查什么都正常
          //   （8188 通、进程在、代理无影响）。**猜是猜不出结论的** ——
          //   必须让插件把"它自己看到了什么"写下来，才能定位。
          //   写的是最关键的几个量：探活结果、launchState、以及探测用的 URL。
          //
          //   ⚠ 只保留最近 200 行，避免长跑把磁盘写满。
          try {
            const v = launchView(online)
            const line = `${new Date().toISOString()} online=${online} phase=${launch.phase}`
              + ` starting=${v.starting} failed=${v.failed} timedOut=${v.timedOut}`
              + ` err=${launch.error ? launch.error.slice(0, 80) : '-'}`
              + ` url=${cfg.comfyUrl}\n`
            const diagPath = path.join(cfg.outputDir ?? os.tmpdir(), 'qwen-paint-status.log')
            const prevLines = await fsp.readFile(diagPath, 'utf8').catch(() => '')
            const kept = prevLines.split('\n').slice(-200).join('\n')
            await fsp.mkdir(path.dirname(diagPath), { recursive: true }).catch(() => {})
            await fsp.writeFile(diagPath, `${kept}${kept === '' ? '' : '\n'}${line}`, 'utf8')
          } catch {
            /* 诊断写不进去绝不能影响状态返回 */
          }

          // ★★★ 2026-10-09 新增：`?start=1` —— 界面上的「启动 ComfyUI」按钮。
          //
          //   为什么需要它：菜单里早就能设"多久后自动关闭"，却**没有"现在打开"** ——
          //   用户想立刻用，只能等到下次出图才触发拉起，或者自己跑去手动开。
          //
          //   ⚠ 刻意**不 await**：真正拉起要几十秒（首次加载模型 20GB 更久），
          //     让状态接口立刻返回，前端好马上显示"启动中…"；
          //     下一次轮询（5 秒后）自然就能看到进展。await 会把轮询拖死。
          if (query.searchParams.get('start') === '1') {
            // ★ 重写后：**立刻**把状态标成启动中（单一真相源），
            //   这样紧接着这次响应里的 launchView() 就会给出 starting=true，
            //   界面无需等到下一次轮询才有反馈。
            launchMarkStarting()
            log('info', '界面点击了「启动 ComfyUI」，开始后台拉起')
            ensureComfyUp(cfg, log, null).catch((error) => {
              log('warn', `界面触发的启动失败：${error?.message ?? error}`)
              // 失败就用**准确的类型**收口（超时 or 失败），不再让状态悬着
              if (launch.phase === 'starting') {
                launchMarkFailed(`启动失败：${error?.message ?? error}`)
              }
            })
          }

          // ★★★ 2026-10-09 新增：`?blockcache=on|off` —— 界面上的「BlockCache T8」开关。
          //
          //   主人要求原话：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
          //   TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
          //   请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
          //
          //   实现方式（**运行时覆盖**，不是改配置文件）：
          //     · `cfg.blockCacheEnabled` 在插件启动时就从 cordis.patch.yml 读进来了，
          //       改它**当场生效**（下次出图就走新链路），不需要重启 ComfyUI；
          //     · 但它是**内存态** —— DSH 重载后会被配置文件里的值盖回去。
          //       这点必须在界面上**如实告诉用户**，并给出"怎么永久保存"的指引，
          //       否则就成了"我调了、重启又变回去"的假开关（正是主人最反感的那种）。
          //   ⚠ 为什么不去改 yml 文件：插件拿不到自己配置文件的**可靠路径**
          //     （DSH 的 profile 路径因安装方式而异），盲写文件风险远大于收益。
          //     让用户改一行配置，比插件猜路径写坏配置安全得多。
          const blockCacheParam = String(query.searchParams.get('blockcache') ?? '').toLowerCase()
          if (blockCacheParam === 'on' || blockCacheParam === 'off') {
            const want = blockCacheParam === 'on'
            if (cfg.blockCacheEnabled !== want) {
              cfg.blockCacheEnabled = want
              log('info', `界面把 BlockCache T8 切成了 ${want ? '开' : '关'}`)
            }
            // 切成"开"时要提醒用户：TE-Speed / Speedup 会自动让位，这是结构互斥的必然结果
            if (want) {
              log('info', 'BlockCache T8 已开启 → TE-Speed / Speedup 会让位（三者结构互斥，不能共存）')
            } else {
              log('info', 'BlockCache T8 已关闭 → TE-Speed / Speedup 回到链路（实测这一组更快）')
            }
          }

          // ★★★ 2026-10-12（用户要求）：**在界面上直接改输出目录**。
          //   `?outputDir=<url编码的路径>` —— 空值 = 恢复默认。
          //   ⚠ 校验与 apply() 那一步**完全同一套**（resolveOutputDir），
          //     避免"端点收下、下次启动又判非法"的两套标准。
          const wantDir = query.searchParams.get('outputDir')
          if (wantDir !== null) {
            const r = resolveOutputDir(wantDir, log)
            if (r.problem) {
              log('warn', `界面想把输出目录改成「${wantDir}」，但不可用（${r.problem}）→ 未采用`)
            } else if (r.dir === cfg.outputDir) {
              log('info', `界面设置输出目录：与当前一致（${r.dir}）`)
            } else {
              cfg.outputDir = r.dir
              cfg.outputDirSource = r.source
              log('info', `界面把输出目录改成了：${r.dir}（${r.source}）`)
            }
          }

          const busy = online ? await status.queueBusy() : false

          // ★★★ 2026-10-11 新增：**A 卡专属优化（可选）的两个开关** ——
          //   `?amdkernel=on|off` / `?asyncoffload=on|off`。
          //   与上面的 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //   ⚠ 但这两个是**启动参数** ⇒ 要等**下次启动 ComfyUI** 才真正起作用 ——
          //     面板的 hint 里已经写明，用户不会以为是"点了没反应"。
          for (const [param, key, label] of [
            ['amdkernel', 'amdKernel', 'A 卡专属内核'],
            ['asyncoffload', 'amdAsyncOffload', 'A 卡异步卸载'],
            // ★ 2026-10-11：N 卡 SageAttention（三档，这里是 true/false 两档）
            ['sagesa', 'nvidiaSageAttention', 'N 卡 SageAttention'],
          ]) {
            const v = String(query.searchParams.get(param) ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const want = v === 'on'
              // ★★★ 2026-10-11 加固：`--use-sage-attention` 是**硬依赖**参数 ——
              //   已确认"没装"时**在服务端就拒绝打开**。
              //   面板虽然把开关置灰了，但端点本身也必须有护栏 ——
              //   否则一个手拼的 URL 就能把 ComfyUI 弄成起不来。
              if (key === 'nvidiaSageAttention' && want && SAGE_READY === false) {
                log('warn', '界面想打开 N 卡 SageAttention，但自检确认 sageattention **未安装** → 已拒绝'
                  + '（硬依赖参数，挂上会让 ComfyUI 起不来）。请先安装，装好后自检会自动启用。')
                continue
              }
              if (cfg[key] !== want) {
                cfg[key] = want
                log('info', `界面把「${label}」切成了 ${want ? '开' : '关'}（启动参数，重启 ComfyUI 后生效）`)
              }
            }
          }

          // ★★★ 2026-10-09 **重写后的状态机**（旧的 launchState + comfyStartRequestedAt
          //   两套并行状态已删除 —— 它们互相覆盖，正是"永远卡在启动中"的根源）。
          //
          //   现在只有三条规则（见文件上方 launch 的注释）：
          //     ① 单一真相源：starting 只看 launch.phase
          //     ② 在线就是在线：探到通立刻清空一切过期状态
          //     ③ 必然收口：45 秒到点必判超时，不会无限 starting
          if (online) {
            // 规则②：在线即 ready，顺带把失败/超时痕迹清干净
            if (launch.phase !== 'ready') {
              launchMarkReady()
              log('info', 'ComfyUI 已就绪（状态端点确认）')
            }
          } else if (launch.phase === 'starting'
            && Date.now() - launch.startedAt > LAUNCH_TIMEOUT_MS) {
            // 规则③：到点收口。先看日志有没有致命错 —— 有就是**失败**，
            // 没有才是**超时**（两者对用户含义不同：一个要去查错误，一个只是慢）。
            const tail = await readLaunchLog(launch.logPath)
            const fatal = fatalLineInLog(tail)
            if (fatal !== '') {
              launchMarkFailed(`${fatal}（进程仍挂着但已注定失败，未等满超时）`)
              log('error', `ComfyUI 启动失败（日志报错）：${launch.error}`)
            } else {
              launchMarkTimeout(
                `启动超过 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒仍未就绪`
                + '（进程没退出、日志里也没有报错，多半卡在加载模型或某个自定义节点上）',
              )
              log('warn', `ComfyUI 启动超时：${launch.error}`)
            }
          }

          // 折算成给前端的字段（纯函数，可单测）
          const view = launchView(online)
          // ★ 诊断：把"这次轮询看到了什么"如实落盘。
          //   这一行就是定位"界面卡住"的决定性证据 ——
          //   online 与 phase 一摆出来，立刻能分清是"探活失败"还是"状态机没收口"。
          diag('poll', `online=${online} phase=${launch.phase}`
            + ` starting=${view.starting} failed=${view.failed} timedOut=${view.timedOut}`
            + ` err=${view.error ? view.error.slice(0, 70) : '-'}`)

          // ★★★ 2026-10-09：把「优化到底有没有生效、没生效为什么」一并给前端。
          //   以前这些只写在日志里，用户在界面上完全看不到。
          //   ⚠ 这里**只在在线时**才去探测（否则会白等一次超时，拖慢每 5 秒一次的轮询）。
          let optimization = null
          if (online) {
            try {
              const caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              // ★ 2026-10-09：把显存总量一并喂给面板 —— 「显存驻留」那一项要靠它判定。
              //   ComfyUI 在线时 /system_stats 是权威值（probeCapabilities 里已取到）。
              optimization = describeOptimization(cfg, caps)
            } catch (error) {
              optimization = {
                level: 'unknown',
                ok: false,
                summary: '优化状态未获取',
                reasons: [`探测过程出错：${error?.message ?? error}`],
                detail: [],
              }
            }
          } else {
            optimization = describeOptimization(cfg, null)
          }
          respondJson(res, {
            ok: true,
            online,
            busy,
            // ★ 启动状态：全部来自 launchView(online) 这一个纯函数。
            //   前端只认这几个字段，不再需要理解后端有几套状态。
            starting: view.starting,
            launchFailed: view.failed,
            launchTimedOut: view.timedOut,
            launchError: view.error,
            launchElapsedMs: view.starting ? Date.now() - launch.startedAt : 0,
            url: cfg.comfyUrl,
            visits,
            flowStyle: cfg.flowStyle,
            enabled: cfg.enabled !== false,
            drawTrigger: cfg.drawTrigger,
            // ★★★ 2026-10-12（用户要求）：输出目录 + 它是怎么来的 ——
            //   前端据此显示"当前出图存到哪"，并给出修改入口。
            outputDir: cfg.outputDir,
            outputDirSource: cfg.outputDirSource ?? '默认桌面目录',
            outputDirDefault: defaultOutputDir(),
            optimization,
            ...idle.snapshot(),
          })
        } catch (error) {
          // ★★★ 2026-10-09 **关键修复**：这里以前只回 `ok:false`，
          //   **没有 online / starting 字段** —— 而前端 `startingNow` 只在
          //   `typeof data.starting === 'boolean'` 时才更新（见 client.js）。
          //   于是 handler 一旦抛错，前端就**永远收不到状态**，
          //   `startingNow` 卡在 true，界面永久停在「正在启动…」。
          //   ⇒ 现在：① 如实落盘原因（以前完全静默）；② **必须带上状态字段**，
          //      让前端能把"启动中"收掉（宁可显示"未就绪"，也不能假装在启动）。
          const msg = String(error?.message ?? error)
          diag('status', `状态接口抛错：${msg}`)
          log('warn', `状态接口抛错（已回退为"未就绪"，不再让界面卡住）：${msg}`)
          respondJson(res, {
            ok: false,
            reason: msg,
            // ★ 状态字段（前端据此收口，避免永久"启动中"）
            online: false,
            starting: false,
            launchFailed: false,
            launchTimedOut: false,
            launchError: `状态接口出错：${msg}`,
            optimization: {
              level: 'unknown',
              ok: false,
              summary: '优化状态未获取（状态接口出错）',
              reasons: [
                `状态接口本身抛错了：${msg}`,
                '这属于插件后端的问题，不是 ComfyUI 或优化的配置问题。可先重载插件再试。',
              ],
              detail: [],
            },
          })
        }
      }
      try {
        webCtx.effect(() => {
          const disposers = [
            '/api/qwen-paint/status.json',
            '/qwen-paint/status.json',
          ].map((routePath) => webCtx.webServer.register({ kind: 'exact', path: routePath, handler }))
          log('info', '已注册只读状态端点 /api/qwen-paint/status.json')
          routeMounted = true
          diag('route', '已注册 /api/qwen-paint/status.json（前端从这里取状态）')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:status-route')
      } catch (error) {
        log('warn', `注册状态端点失败（不影响出图）：${error?.message ?? error}`)
        diag('route', `注册状态端点失败：${error?.message ?? error}`)
      }

      // ★★★ 2026-10-09 补：**延时回看** —— 状态端点到底注册上没有，只靠看代码永远说不清。
      //
      //   为什么必须有这一行：`ctx.inject(['webServer'], cb)` 在依赖不满足时是**静默挂起**，
      //   既不报错也不回调。于是"插件加载了、工具也注册了、但状态端点从未注册"
      //   这种状态在外界完全看不出来 —— 排查时只能猜。
      //   6 秒后回看 `routeMounted`，就能把结论直接写进诊断文件：
      //     · 已注册 → 界面状态应该正常，若还异常那是前端/请求问题；
      //     · 未注册 → 当前 profile 没有 webServer（插件装错 profile），
      //       界面状态必然拿不到，**但不影响出图**。
      try {
        const timer = setTimeout(() => {
          if (routeMounted) return
          diag('route', '状态端点 6 秒内未注册：当前上下文没有 webServer 服务'
            + '（插件装在非 web profile 时会这样 —— 界面状态永远拿不到，但出图照常）')
        }, 6000)
        // Electron 里不留悬挂定时器：不该因为它拖住进程退出
        if (typeof timer?.unref === 'function') timer.unref()
      } catch {
        /* 取证永远不该成为故障源 */
      }

      // ★★★ 2026-10-08：**插件自己的动画图片路由** —— 这是"做进插件的新功能"。
      //
      // 为什么需要它（一路试出来的结论）：
      //   · 内核的 `/api/file?path=…` 只肯服务"**被登记过的**文件"：真图是 draw_image 的交付物，
      //     所以正常显示；而「正在生成」动图没被登记 → 一律回「图片无法预览」
      //     （GIF / WebP / 静态 PNG **三种都试过**，与格式无关，也与文件名无关）。
      //   · 往消息树里插 DOM 更不行 —— 会把界面搞成整片空白（React 管理那棵树）。
      //   · 改 app.asar 里的内核代码也不能做：DSH 一升级就全被覆盖。
      // ✓ 正解：由插件自己开一个路由**直接吐字节**，绕开 /api/file 的登记限制；
      //   而且它属于插件本身，**升级 DSH 也不会丢**。
      try {
        webCtx.effect(() => {
          const assetRoute = (name, mime) => async (req, res) => {
            try {
              if (!isLocalRequest(req)) {
                respondJson(res, { ok: false, reason: 'local requests only' }, 403)
                return
              }
              const bytes = await fsp.readFile(
                fileURLToPath(new URL(`../assets/${name}`, import.meta.url)),
              )
              res.writeHead(200, {
                'content-type': mime,
                'content-length': bytes.length,
                'cache-control': 'public, max-age=3600',
                'access-control-allow-origin': '*',
              })
              res.end(bytes)
            } catch (error) {
              respondJson(res, { ok: false, reason: String(error?.message ?? error) }, 500)
            }
          }
          const disposers = [
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.webp',
              handler: assetRoute('loading.webp', 'image/webp'),
            }),
            webCtx.webServer.register({
              kind: 'exact',
              path: '/qwen-paint/loading.gif',
              handler: assetRoute('loading.gif', 'image/gif'),
            }),
          ]
          log('info', '已注册动画图片路由 /qwen-paint/loading.webp')
          return () => { for (const dispose of disposers) dispose() }
        }, 'qwen-paint:animation-route')
      } catch (error) {
        log('warn', `注册动画图片路由失败（不影响出图）：${error?.message ?? error}`)
      }
    })
  })(root)
}

/**
 * 内部导出的**取值源** —— 故意包在箭头函数里：只有真正访问某个属性时才读绑定。
 *
 * ⚠⚠ 为什么不能直接写 `export const __internal = { DEFAULTS, ... }`：
 *   本文件（index.js）与 config.js **互相 import**（config 反向取本文件的
 *   ensureComfyUp / getNodeSchema / nodeFileList / execFileAsync 等运行时胶水）。
 *   若这里在**模块求值期**就读 config 的绑定，一旦有人**先** `import './config.js'`，
 *   config 还没求值完，本文件顶层就已经去读它的绑定 → 直接 TDZ 崩：
 *     ReferenceError: Cannot access 'DEFAULTS' before initialization
 *   生产路径按 `main` 先加载 index.js，所以一直没暴露 —— 但那是"碰巧安全"，
 *   不是"设计安全"（任何先 import config.js 的测试/工具都会当场炸）。
 *
 * 用 Proxy 把求值推迟到**属性访问时**；Object.keys / 解构 / 展开 / JSON 全部照常。
 * 这些只给自测用，真机不依赖。
 */
const internalOf = () => ({
  DEFAULTS,
  // ★ 2026-10-11：面板数据的两个纯函数 —— 供"按显卡过滤"的回归断言直接调
  describeOptimization,
  genericOptimizations,
  // ★ 2026-10-09 真事故修复：[object Object] 的规范化工具（供自测断言）
  toError,
  cancelReason,
  ASPECTS,
  FLOW_STYLES,
  calcSize,
  r32,
  safeStem,
  buildWorkflow,
  planWorkflow,
  // ★ 2026-10-09 二次修正：按尺寸挑互斥 wrapper 的决策函数（供自测断言）
  pickWrapperSet,
  shouldProbe,
  makeDrawTool,
  uniquePath,
  portOf,
  makeComfyStatus,
  makeIdleShutdown,
  isLocalRequest,
  listComfyModels,
  makeListModelsTool,
  // ★ 2026-10-09 通用化新增：环境自适应相关（供自测断言）
  probeCapabilities,
  resolvePlan,
  // ★ 2026-10-09 「调用更聪明」新增：提交前的一次性就绪探测（在线/忙/排队数）
  probeReadiness,
  pickBestModel,
  MODEL_HINTS,
  FULL_CAPS,
  // ★ 2026-10-11：模型档位（小显存适配）—— 供回归直接断言加载器切换
  unetLoaderFor,
  unetLoaderNode,
  MODEL_TIERS,
  resolveOutputDir,
  defaultOutputDir,
  defaultOutputBase,
  tierLabelOf,
  // ★ 2026-10-11：N 卡代系识别（40 系 Ada / 50 系 Blackwell）—— 供回归断言
  nvidiaGenOf,
  discoverComfyPaths,
  // ★ 2026-10-09 三厂商自适应（A/N/I 卡 + 3000/6000/7000/9000 系细分）
  detectGpuProfile,
  GPU_PROFILES,
  VENDOR_RULES,
  vendorIdOf,
  ACCEL_PACKS,
  ACCEL_SOURCES,
  PIP_MIRRORS,
  pipSources,
  packAppliesToOs,
  runInstallSource,
  autoSetupAcceleration,
  probeAcceleration,
  probeAccelPack,
  installAccelPack,
  makeAccelTool,
  comfyDirsFrom,
  pathExists,
  // ★ 平台适配（供自测断言两端都有对应实现）
  IS_WINDOWS,
  IS_LINUX,
  // ★ 2026-10-11：macOS 标志也导出（供可移植性回归断言"三平台都覆盖"）
  IS_MAC,
  GPU_PROBE_WIN,
  GPU_PROBE_LINUX,
  COMFY_SEARCH_WIN,
  COMFY_SEARCH_NIX,
  normalizeGpuText,
  PCI_VENDOR,
  // ★ 2026-10-09：DSH 联动层（生图意图判定 + 总开关）
  DRAW_INTENT_MODES,
  buildDrawIntentPrompt,
  INLINE_IMAGE_PROMPT,
  describeOptimization,
  // ★ 2026-10-09：启动链路（供自测直接跑真实入口，验证"进程能不能活下来"）
  ensureComfyUp,
  startComfyHidden,
  launch,
  launchView,
  launchMarkReady,
  launchMarkStarting,
  launchMarkFailed,
  launchMarkTimeout,
  LAUNCH_TIMEOUT_MS,
  fatalLineInLog,
  summarizeLaunchError,
  looksLikeBadArgs,
})

/**
 * 给自测用的内部导出（真机不依赖这些）。
 * ⚠ 必须是**惰性**的（见上面 `internalOf` 的长注释）：求值推到属性访问时，
 *   这样任何 import 顺序都不会撞上循环 import 的 TDZ。
 */
export const __internal = new Proxy({}, {
  get: (_t, k) => internalOf()[k],
  has: (_t, k) => k in internalOf(),
  ownKeys: () => Reflect.ownKeys(internalOf()),
  getOwnPropertyDescriptor: (_t, k) => {
    const src = internalOf()
    return k in src
      ? { value: src[k], enumerable: true, configurable: true, writable: false }
      : undefined
  },
})
