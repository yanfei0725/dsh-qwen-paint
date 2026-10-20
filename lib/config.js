/**
 * dsh-qwen-paint —— 配置常量与纯工具函数（2026-10-12 从 lib/index.js 拆出）。
 *
 * ## 为什么拆
 *   DSH STORE 自动检查要求仓库内**单文件 ≤ 262144 字节**，而 lib/index.js 曾达
 *   364197 字节。本文件收拢"配置常量 / 纯工具函数"这一类**不依赖平台探测**的代码。
 *
 * ⚠ 这里**只放**不需要 GPU 探测、不需要 ComfyUI 目录搜索、不需要 ComfyUI 客户端
 *   的代码 —— 否则拆了等于没拆（index.js 还得把它 import 回去）。
 */
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

const TURBO8_STEPS = 8
const DEFAULT_TURBO8_LORA = 'turbo8_lora_step2500.safetensors'
const BASE_STEPS = 25
const BASE_CFG = 2.5


/** 默认输出位置的**基目录**（桌面；没有桌面就退主目录，绝不硬造 Desktop）。 */
function defaultOutputBase() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  if (process.env.XDG_DESKTOP_DIR && existsSync(process.env.XDG_DESKTOP_DIR)) {
    return process.env.XDG_DESKTOP_DIR
  }
  for (const dir of [path.join(home, 'Desktop'), path.join(home, '桌面')]) {
    if (existsSync(dir)) return dir
  }
  return home
}

/** 成品落盘目录的**默认值**（`<桌面或主目录>/千问1生图`）。 */
function defaultOutputDir() {
  return path.join(defaultOutputBase(), '千问1生图')
}

/**
 * ★★★ 2026-10-12 新增：**把用户配的 `outputDir` 变成一个真正可用的绝对路径**。
 *
 * ## 为什么要这一步（用户要求）
 *   原来 `outputDir` 直接拿去用，没有校验 —— 用户配错（盘符不存在、没写权限、
 *   路径指到一个文件）时，要到**出图那一刻才失败**，而且报的是"写文件失败"
 *   这种看不出原因的错。现在启动时就校验、就明确告知。
 *
 * ## 支持两种写法
 *   · **绝对路径**（`D:\我的图\千问`）→ 照用，用户完全自己说了算；
 *   · **相对路径**（`千问1生图` / `图片/千问`）→ 解析到"默认基目录"之下，
 *     即 `<桌面>/<相对路径>`。好处是**换机器不会失灵**（不写死盘符和用户名）。
 *
 * ## 校验（两步都要过）
 *   ① `mkdir -p` 能建成（或本来就存在）；
 *   ② 往里写一个临时文件再删掉 —— 这才是"真正有写权限"的判据
 *      （只判断"目录存在"是不够的：Windows 上见过目录在但 ACL 拒写的情况）。
 *
 * ## 失败怎么办
 *   **绝不中断插件**。退回默认目录，并把失败原因 `warn` 出来 ——
 *   用户改了路径就能恢复，不改成也能正常出图。
 *
 * @returns {{ dir: string, source: string, problem?: string }}
 */
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

const DEFAULTS = {
  /** ComfyUI 服务地址。默认本机回环；非回环地址会被 net-guard 拒绝（除非 allowRemoteComfy）。 */
  comfyUrl: 'http://127.0.0.1:8188',

  /**
   * ★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）：是否允许 comfyUrl 指向**非本机**地址。
   *
   * 默认 `false` —— 插件只与本机（127.0.0.1 / localhost / ::1）的 ComfyUI 通信，
   * 启动时由 lib/net-guard.js 的 `assertLocalUrl` **强制校验**，配错直接拒绝启动。
   *
   * 设为 `true` 才允许连接局域网（如 192.168.1.100）或远程 ComfyUI ——
   * 这是"如实披露可配置的外部端点"：启用后插件会向你指定的地址发送提示词与图片数据，
   * 请自行确认那是你信任的机器。**普通用户不需要动这个开关。**
   */
  allowRemoteComfy: false,

  /**
   * ★★★ 2026-10-09：**插件总开关**（默认 true，装上即用）。
   *
   * `true`  → 注册 `draw_image`，并按 `drawTrigger` 的策略注入生图意图提示词。
   * `false` → **完全不介入**：不注册绘图工具、不注入任何提示词、不预热 ComfyUI、
   *           也不做空闲关停。插件对 DSH 相当于"不存在"。
   *
   * 用途：① 想临时关掉画图能力但不卸载插件；② 同一个 DSH 里跑多个图像后端时，
   * 避免本插件抢话；③ 排查问题时把插件整个摘出去，确认是不是它引起的。
   *
   * ⚠ 关掉后 `check_acceleration` / `list_available_models` 这两个**诊断类**工具
   *   仍然可用（它们只读、不画图）—— 否则出了问题连查都没法查。
   */
  enabled: true,

  /**
   * ★★★ 2026-10-09：**生图意图判定策略** —— 这是本轮"联动性"改造的核心。
   *
   * 背景：原来只靠一段很长的 systemPrompt 让模型"自己领悟"用户想不想画图。
   * 问题有两个：① 模型可能仍判断不准（该画时没画、不该画时去画）；
   * ② 用户说"帮我画个流程图"这类**指的不是本工具**时，会被误判成生图请求。
   *
   * 四档（由紧到松）：
   *   `'off'`    不做任何生图意图引导 —— 只在用户**明确点名**要画图时才会用到。
   *              适合"只想要个安静工具"的人。
   *   `'strict'` 只在用户**明确表达**要生成图片时才画（「画一张…」「生成图片」等），
   *              且要求**画面描述具体**；模糊的一律**先问一句**再画。
   *              适合怕误触发的人。
   *   `'auto'`（默认）**判断是生图请求就画**；但若请求**明显不属于本工具**
   *              （如"画个流程图/思维导图/表格"这类通常要文字或其它工具的场景），
   *              先澄清一句再决定。平衡"响应快"与"不误画"。
   *   `'eager'`  只要沾边就画（最积极）。适合确定自己只用它画图的人。
   */
  drawTrigger: 'auto',

  /** 成品落盘目录（工作区约定：一律放「千问1生图」）。 */
  // ★★ 2026-10-07：出图目录**不再硬编码**。原来写死 C:\Users\<你的用户名>\Desktop\千问1生图，
  //    有两个问题：① 泄露 Windows 用户名（发出去的包里带着它）；
  //    ② **别人装上后用不了** —— 那个目录在他们机器上不存在，出图会写失败。
  //    改成按当前用户的桌面推算，profile 里显式配了 outputDir 时仍以配置为准。
  outputDir: defaultOutputDir(),
  /** resolveOutputDir() 回填的来源说明（仅供日志/面板展示，不必手配）。 */
  outputDirSource: '默认桌面目录',
  /**
   * ComfyUI 自己的 output 目录。**留空（默认）= 直接走 /view**（推荐、通用）。
   *
   * ★ 2026-10-09 通用化：原默认写死 `D:\ComfyUI\ComfyUI\output`，那只对作者机器有意义
   *   —— 别人装到别处必然"先白读一次失败、再走 /view"。取图本来就以 `/view` 为准
   *   （见 fetchImageBytes 的说明），本地目录只是老版本 ComfyUI 的兜底，留空即可。
   */
  comfyOutputDir: '',
  /** 三个千问模型文件（照抄 app.py 的常量）。 */
  unet: 'qwen_image_2.1_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',

  /* ------------------------------------------------- 加速链（★ 2026-10-08 默认开启） ----
   * ★★★ 默认链路：turbo8 八步 LoRA + 官方 int8 前缀缓存 + TE-Speed 跳步缓存。
   *   本机稳态实测：91.6s（原 30 步基线）→ 9.7s，**快 89%**。
   *   其中 turbo8 是大头（→12.6s），TE-Speed 再省 23%（→9.7s）。
   *   ⚠ 首次出图还要额外 ~12s 加载模型（20 GB），那部分不是这条链的开销。
   *
   *   想完全退回**改动前**的老链路（25 步、无 LoRA、无缓存）：
   *     ① 先把下面 `forceTurbo8Steps` 设为 false、`turbo8Steps` 设为 25；
   *     ② 再把 `turbo8Lora` / `qwenCacheDtype` / `teSpeed*` 一并还原（LoRA 与缓存
   *        两个节点现在是**无条件**接在链子上的，只改步数并不能回到老状态）。
   *   简言之：这组开关是**微调**用的，不是一键开关。
   */
  /** turbo8 八步蒸馏 LoRA 文件名。留空 = 用内置默认 `turbo8_lora_step2500.safetensors`。 */
  turbo8Lora: DEFAULT_TURBO8_LORA,
  /** LoRA 强度。发布方按 1.0 训练；调到 0.65 左右会更"稳"但会丢风格，故默认 1.0。 */
  turbo8Strength: 1.0,
  /** turbo8 官方要求的采样位移（ModelSamplingFlux）。别乱改，改了就不是它的工作点。 */
  turbo8MaxShift: 0.6935,
  turbo8BaseShift: 0.5,

  /* ---------------------------------------------------------------- 极速档（4 步）---- */
  /**
   * ★★★ 2026-10-12（用户要求）：**极速档（4 步）** —— 默认关。
   *
   * 开启后整条链换成「4 步蒸馏」的工作点：步数 4 + 4 步 LoRA + 配套采样位移。
   *
   * ## 实测（2026-10-12 真机 A/B，1024²、CFG 1.0、热态）
   *   · 8 步 turbo8：**12.1 s**（热、不切 LoRA）
   *   · 4 步 Lightning：**6.0 ~ 7.5 s**
   *   ⇒ 约 **1.6 ~ 2×** 提速（步数只砍采样段；模型加载/VAE 解码/落盘不受影响）
   *
   * ## ⚠⚠ 代价（必须让用户知道，界面上也写了）
   *   **画面里有文字就会崩。** 实测同一 prompt、同一 seed：
   *   8 步能正确写出「午后」，4 步直接变成乱码。
   *   文字渲染是 Qwen-Image 的招牌能力，4 步蒸馏把它牺牲掉了。
   *   ⇒ 只适合"要快、画面里不需要文字"的场景。
   *
   * ## ⚠ 采样位移必须跟着换
   *   Lightning 官方 README 写明 `shift=3 in distillation`（`base_shift = max_shift = ln3`），
   *   而 turbo8 的工作点是 `ln2 ≈ 0.6935`。**拿 shift=2 跑 shift=3 蒸馏的 LoRA，
   *   画质会明显崩**（糊、五官走形）—— 实测同 seed 对比，换对位移后明显回血。
   *   所以这两个值必须与 LoRA 一起切换，不能只改步数。
   */
  fast4Enabled: false,
  /**
   * 4 步蒸馏 LoRA 文件名。**留空 = 自动探测**（按 MODEL_HINTS.fast4 在 loras 目录里找）。
   * 探测不到 → 极速档在界面上显示为"不可用"并禁止打开（切了也出不来图）。
   */
  fast4Lora: '',
  /** 4 步档的采样位移。Lightning 蒸馏用的是 shift=3 ⇒ ln(3) ≈ 1.0986。 */
  fast4MaxShift: 1.0986,
  fast4BaseShift: 1.0986,
  /** 4 步档的步数。一般不用改（这是蒸馏模型的工作点）。 */
  fast4Steps: 4,
  /**
   * ★ 采样步数。`0` 或负数 = **跟随 turbo8 的 8 步**（默认）；
   * 写 1..60 的正数 = 用那个步数（离开 8 步会明显掉画质，除非你清楚在做什么）。
   *
   * ⚠ 要生效必须先关掉下面的 `forceTurbo8Steps` —— 它默认会把步数**强制**钉在 8。
   */
  turbo8Steps: 0,
  /**
   * 采样器要不要**强制**钉在 turbo8 的 8 步上（默认 true）。
   * false 时，上面 `turbo8Steps`（以及用户在工具参数里传的 steps）才会生效
   * —— 用于手工做步数对比。
   */
  forceTurbo8Steps: true,
  /**
   * ★★ 2026-10-09 通用化新增：**turbo8 整条链的总开关**（默认开）。
   *
   * 与 `teSpeedEnabled` / `speedupEnabled` 的区别：那两个只管各自的节点，
   * 这个管"turbo8 这条链"整体（LoRA + ModelSamplingFlux + 8 步 / CFG 1）。
   * 设 false 会退回千问原生链路（`baseSteps` 步 / `baseCfg` CFG，默认 25 步 / 2.5）。
   *
   * ⚠ 一般**不需要**手动关它 —— 探测不到 turbo8 LoRA 时插件会自动降级（见 probeCapabilities）。
   *   这个开关是留给"我想强制对比原生画质"的场景。
   */
  turbo8Enabled: true,
  /** QwenImage21Cache（官方前缀 KV 缓存）：device + 存储精度。 */
  qwenCacheDevice: 'auto',
  qwenCacheDtype: 'int8',
  /** ★ 2026-10-09 新增：前缀缓存总开关（探测不到该节点时会自动跳过，一般不用管）。 */
  qwenCacheEnabled: true,
  /** ★ 2026-10-09 新增：TE-Speed 总开关（写成显式默认值，便于一眼看到）。
   *  设 false 时**整个 TESpeed 节点不接进链子**，模型直接由上一环进 KSampler。 */
  teSpeedEnabled: true,
  /**
   * ★★ 2026-10-09 通用化新增：**没有 turbo8 时的回退采样参数**。
   *
   * 别人机器上没装 turbo8 LoRA 时（探测不到 → basic 档），绝不能还按 8 步 / CFG 1 跑
   * —— 那是 LoRA 的工作点，缺 LoRA 会得到一张糊图。此时用这里的两项，
   * 即千问原生工作点：25 步 / CFG 2.5。调用方显式传 steps 时仍以调用方为准。
   */
  baseSteps: BASE_STEPS,
  baseCfg: BASE_CFG,
  /**
   * ★ 2026-10-09 新增：能力探测结果的缓存时长（毫秒，默认 10 分钟）。
   *  探测要发 10 个轻量请求（本机共约 0.2s），缓存后连续出图不再重复探测。
   *  装了新节点/新模型想让探测立刻刷新：重启插件，或调小这个值。
   */
  capabilityCacheMs: 600000,
  /**
   * ★★ 2026-10-09：**自动配置厂商专用加速环境**（默认 true）。
   *
   * `true`  → 插件加载后**自动检测**本机缺哪个厂商专用加速包，缺就**自动下载安装**
   *           （白名单内、且仅当前平台适用的那些，见 `ACCEL_PACKS` / `packAppliesToOs`）。
   *           全过程在后台跑、失败只写日志，**绝不影响出图**。
   * `false` → 只报告不下载，需要时手动调 `check_acceleration(action:'install')`。
   *
   * ★ 发行包体积说明：包里**只带这套"下载器"逻辑，不预置任何已下载的文件** ——
   *   所以必须真的到网上去取。这也是包只有 ~500 KB 的原因（大头是 UI 动画）。
   *
   * ⚠ 会真的改动用户环境（git clone / pip install 第三方代码），
   *   介意的话设为 false 即可 —— 出图功能不受任何影响，只是少了厂商专用加速。
   */
  accelAutoInstall: true,
  /** TE-Speed 跳步缓存。`te_predictor` 每跳最多 1 步连续跳过；`speed` 是 2 步（更激进）。 */
  // ★ 总开关（见下面 `teSpeedEnabled`）：false 时**整个 TESpeed 节点不接进链子**。
  teSpeedAttention: 'kitchen_int8',
  teSpeedStepCache: 'te_predictor',
  teSpeedThreshold: 0.06,
  teSpeedStartPercent: 0.0,
  teSpeedEndPercent: 1.0,
  teSpeedErrorLimit: 0.08,
  teSpeedVerbose: false,

  /**
   * ★ 2026-10-09 实测新增：`QwenImage21Speedup`（frakd，MIT，纯 Python 无闭源件）。
   *   它挂在 DIFFUSION_MODEL/OUTER_SAMPLE wrapper 上，与 TE-Speed **实测可叠**
   *   （TE 10.741s → TE+Speedup 9.709s）。默认开。
   *   设 false 时整个节点不接进链子（该插件没装也不会导致整单拒收）。
   */
  speedupEnabled: true,
  speedupCacheThreshold: 0.30,
  speedupTargetError: 0.05,
  speedupStartPercent: 0.15,
  speedupEndPercent: 0.90,
  speedupMaxConsecutiveSkips: 3,
  speedupForecast: 'first',
  speedupCacheDevice: 'auto',

  /**
   * ComfyUI 启动时的**注意力后端**参数。
  //
  // ## 结论：在千问 2.1 上做不了 —— 是接口设计问题，不是配置问题
  //   内建 `TomePatchModel` 当场崩：
  //       TypeError: tomesd_m() got an unexpected keyword argument 'pe'
  //   （老契约 = 位置参数 + 返回 tuple；千问 = 关键字 `pe` + 返回 dict。
  //     **N 卡同样会崩**，与显卡/系统无关。）
  //
  //   自己重写兼容层，逐个插入点试了三条路，全部走不通：
  //   ① `set_model_attn1_patch`
  //      千问**没有实现 `attn1_output_patch`**（grep 全 comfy/ldm：
  //      flux/layers.py、krea2/model.py、modules/attention.py 有；
  //      qwen_image21/model.py **一处都没有**），
  //      而 `_gated_residual`（model.py:130）要求注意力输出行数严格等于输入 N：
  //          x[:, prefix_len:].addcmul_(y[:, prefix_len:], g_target)
  //      → 合并后无人负责还原 → 必抛形状错。
  //   ② `patches_replace[("single_block", i)]`
  //      `block_wrap`（model.py:400-402）用的是**闭包捕获的 attn_fn**，
  //      根本不读 `args["attn_fn"]` → 改 args 完全无效。
  //      （实测证据：block_replace 命中了，但 attn_fn 内部零日志。）
  //   ③ 劫持 `block_causal_attention`（monkey-patch）
  //      实测 64 次调用**全部直通**，日志恒为 `N=4124 P=4124 n_target=0`。
  //      根因：本机开了**前缀缓存**，目标段走的是 `prefix_cached_attention`
  //      （model.py:397），被劫持的那个函数只在"未开缓存"时才是主路径。
  //
  // ## 为什么不继续试第四条路
  //   收益上限本就低：本机已开 Turbo8 8 步 + TE-Speed + `--use-quad-cross-attention`，
  //   注意力已不是瓶颈。继续改千问源码级接口，风险 > 收益。
  //
  // ⚠ 插件 `QwenToMe-QwenImage21` 节点**保留**（不卸载），默认 `ratio=0` = 纯直通。
  //   上述全部诊断都写在插件源码注释里，供将来（千问后续版本）参考。

  /**
   * ComfyUI 启动时的**注意力后端**参数。
   *   这是实测唯一有效的启动参数轴（两轮独立复现，RX 7900 XT / ROCm）：
   *     'quad'    → `--use-quad-cross-attention`   10.739s →  9.328s（**+15.1%**）
   *     'pytorch' → `--use-pytorch-cross-attention` 10.739s → 10.766s（−0.3%，无效）
   *     'default' → 不加任何参数                    10.739s
   *   满叠栈（TE + Speedup）上 quad 仍有效：9.709s → 8.278s（+17.3%）。
   *   画质无损（同 seed PSNR 39.5/41.4 dB，清晰度 166.3 vs 基线 164.6）。
   *
   * ★★ 2026-10-09 通用化：默认值由写死的 'quad' 改为 **'auto'** ——
   *   上面那 +15% 是 **AMD / ROCm** 上的结论，N 卡未必有、个别版本还可能直接不支持。
   *   'auto' 会在启动前查一次 GPU 厂商：AMD / Radeon / ATI → quad，其余 → 不加参数。
   *   想固定就显式写 'quad' / 'pytorch' / 'default'。
   */
  comfyAttentionBackend: 'auto',

  /**
   * ★★★ 2026-10-12 新增：**macOS / MPS 的两个专属开关**（只在 Mac 上生效）。
   *
   * 为什么它们不是启动参数而是**环境变量**：PyTorch 的 MPS 行为是通过环境变量调的
   * （官方 "MPS Environment Variables" 文档），ComfyUI 没有对应的命令行开关。
   * 所以插件需要在**拉起 ComfyUI 进程时**把变量注入进去 —— 这是本轮新增的能力
   * （此前插件一个环境变量都不注入）。
   *
   * ① `appleMpsFallback`（默认 **true**）→ 注入 `PYTORCH_ENABLE_MPS_FALLBACK=1`
   *    PyTorch 官方 MPS 变量：MPS 后端**未实现**的算子自动回退 CPU 执行。
   *    为什么默认开：没有它时，链路里只要碰到一个 MPS 未实现的算子，
   *    **整次出图直接抛错**（不是慢一点，是失败）。
   *    它只影响"本来就会失败"的路径 —— 对已支持的算子**不改变任何数值结果**，
   *    属纯健壮性兜底，不涉及画质取舍。
   *
   * ② `appleMpsUnlimitedMem`（默认 **false**）→ 注入 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
   *    官方默认 **1.7**（相对 `recommendedMaxWorkingSetSize` 的倍数，是**硬上限**）；
   *    设 `0.0` = **取消上限**，允许用满统一内存。
   *    用途：大模型（例如本插件这条 13.5 GB 的千问链路）在内存较小的 Mac 上
   *    本来会直接 OOM，开了它**可能就能跑**。
   *    ⚠ 为什么默认关：官方原文 —— 取消硬上限后若发生**系统级 OOM**，
   *      "may cause system failure"。这是"用稳定性换可用性"的取舍，必须由用户自己决定。
   *
   * ③ 只在 macOS 注入：其它平台没有 MPS 后端，注入这两个变量没有任何意义。
   */
  appleMpsFallback: true,
  appleMpsUnlimitedMem: false,

  /**
   * ★★★ 2026-10-12 新增（来自用户反馈）：**VAE 大图分块解码**，防 OOM。
   *
   * ## 为什么需要（有第三方源码依据，不是猜的）
   *   `ComfyUI-VOSR2/tiled_vae.py` 的文件头注释原文：
   *   > "Full-image VAE encode/decode of large inputs can **OOM**
   *   >  (the **Qwen VAE runs in fp32 internally**); this bounds peak memory to one tile's."
   *   —— Qwen 的 VAE 内部以 **fp32** 跑，大尺寸整图解码的显存峰值会失控。
   *
   * ## 怎么做（**零新增依赖**）
   *   ComfyUI **自带** `VAEDecodeTiled`（`nodes.py`，界面名 "VAE Decode (Tiled)"），
   *   直接把工作流里的 `VAEDecode` 换成它即可，不用装任何东西。
   *   ⚠ 不用第三方 VOSR2 的 tiled VAE 作为默认路径 —— 那个要额外选模型、依赖更重；
   *     自带节点已经够用，且**没装也不影响**（探测不到就自动回退）。
   *
   * ## 三档（为什么默认是 auto 而不是 on）
   *   `'auto'` —— **只在"显存紧 + 尺寸大"时**才切分块：
   *     判据是 `显存 < 16 GB 且 像素数 > 1024²`（见 resolvePlan 的注释）。
   *     理由：分块解码带 overlap 重叠，接缝通常无感但**不是逐位相同**，
   *     与本项目"不牺牲原生画质"的原则相权衡 —— **不该在不需要的机器上无条件启用**。
   *   `'on'`  —— 无条件分块（20 GB 卡跑 2K+ 图时也可能想手动开）。
   *   `'off'` —— 永不（显式关，连 auto 都不判）。
   *   ⚠ 无论哪档，**探测不到 `VAEDecodeTiled` 时一律回退到 `VAEDecode`**（绝不发一个节点不存在的单）。
   */
  vaeTiling: 'auto',
  /** 分块尺寸（像素）。ComfyUI 默认 512；调小更省显存、更慢、接缝更多。 */
  vaeTileSize: 512,
  /** 相邻块的重叠像素。ComfyUI 默认 64；越大接缝越不明显、越慢。 */
  vaeTileOverlap: 64,

  /**
   * ★★★ 2026-10-12 新增（来自用户反馈）：**Spectrum 跳步加速**（跳过冗余 Qwen 前向）。
   *
   * ## 2026-10-12 真机实测（_spectrum_ab.mjs，1024² turbo8 链）
   *   | 变体 | 中位耗时 | vs 基线 |
   *   | --- | --- | --- |
   *   | A 基线（不接 Spectrum） | 13.1 s | — |
   *   | B Spectrum 默认（warmup=5 / tail=2） | 18.2 s | **+5.1 s（−27.7%）** |
   *   | C Spectrum 针对 8 步调（warmup=2 / tail=1） | 17.2 s | **+4.1 s（−23.4%）** |
   *   **结论：在 8 步 turbo8 链上，预测器自身开销 > 跳步收益 ⇒ 更慢**。
   *   ⇒ 默认**关**，且**实测数据替代 README 的乐观数字**。
   *   推断：≥ 20 步的原生链可能**会**有收益（可跳步数多）—— 本轮没测；
   *   那边有收益也仍然是**叠加项**，得**先对比**再定默认值。
   *
   * ## 默认关的其他理由
   *   ① 节点作者自述 *"not a paper-exact universal Qwen port"*、**不保证通用兼容**，且
   *      *"does not score image quality for you"* —— **它不替你评估画质**（本次 1024² 对比
   *      肉眼没差，但更大尺寸 / 更复杂 prompt 未必）。
   *   ② 它的默认 `warmup_steps=5` + `tail_actual_steps=2` 是给**常规步数**调的；turbo8 的 8 步
   *      链被吃掉 7 步，**只剩 1 步可跳**，预测器开销反而成了主要成本 —— 上面的数字就是证据。
   *   ③ 与 TE-Speed / Speedup / BlockCache **叠加**后的画质影响，本项目**没有实测数据**。
   *
   * ⇒ 打开方式：把 `spectrumEnabled` 设为 true（或点面板开关）。想更激进可以调小
   *   `spectrumWarmupSteps` / `spectrumTailActualSteps` —— ⚠ 越激进画质风险越高。
   */
  spectrumEnabled: false,
  /** 前 N 步强制走真实前向（给预测器攒历史）。8 步链路下默认 5 意味着只剩 1 步可跳。 */
  spectrumWarmupSteps: 5,
  /** 末尾 N 步强制走真实前向（收尾更稳）。 */
  spectrumTailActualSteps: 2,
  /** 保留多少个真实隐状态快照用于拟合。 */
  spectrumHistoryPoints: 5,
  /** 切比雪夫拟合的多项式阶数。 */
  spectrumChebyshevDegree: 3,
  /** 最多允许连续跳几步（越大越快、画质风险越高）。 */
  spectrumMaxConsecutiveForecasts: 1,
  /** 隐状态历史存放位置：`main_device`（最快）/ `offload_device` / `cpu`（省显存但可能吃掉提速）。 */
  spectrumCacheDevice: 'main_device',

  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文
   *   "Stochastic Adversarial Diffusion Acceleration"，arXiv 2507.17135）。
   *
   * 思路与 Spectrum 同源（跳过冗余 Qwen transformer 前向），但**走的是新的采样分布**
   * 而非仅靠历史外推；ComfyUI 实现见 `liming123332/comfyui-sada-icml`。
   *
   * ⚠ 必须如实告知的边界（与 Spectrum 同）：
   *   ① 本插件**没有自动下载**该节点 —— 装不装由用户决定（GDPR/版权/审慎）。
   *      缺件时回落到基础链路（实测已有 9 倍提速，叠加收益需自行 A/B）。
   *   ② 节点作者没给出 Qwen-Image 2.1 的画质保证 —— **必须先单张对比**。
   *   ③ 论文的 "1.2–2.0×" 是基准对比，**不是**本项目的工作点；本链只有 8 步
   *      （turbo8）/ 4 步（Lightning），实际可跳步数被 SADA 的 warmup/tail 吃掉后
   *      未必有正收益，**实测是唯一依据**。
   *
   * ⇒ **默认关**；开 = `sadaEnabled: true`（或点面板开关）。
   *   改完要**重启 ComfyUI**让它重新加载节点图。
   */
  sadaEnabled: false,
  /** SADA 节点的 class_type（comfyui-sada-icml 仓库提供）。可由配置覆盖。 */
  sadaNodeClass: 'SADASampler',
  /** 采样步数预算（上限）。SADA 在此范围内跳步。0 = 跟随主链路。 */
  sadaMaxSteps: 0,
  /** 跳步阈值（越大越激进、画质风险越高）。 */
  sadaThreshold: 0.15,
  /** 是否把 SADA 同时挂到 model + sampler（true = 真生效；false = 只挂 model）。 */
  sadaPatchSampler: true,

  /**
   * ★★★ 2026-10-12（用户要求 + 审计文档）：**OOM 自动回退**。
   *
   * 出图撞 OOM（"out of memory" / "OutOfMemoryError" / "CUDA OOM" /
   * "hip out of memory" / "MPS OOM" 任一）时，**自动**重跑一次：
   *   ① 强制 `vaeTiling='on'`（ComfyUI 自带 VAEDecodeTiled，零新增依赖）；
   *   ② 不动 turbo8 / 其它加速链（先让代价最小的开关上场）。
   * 如果还 OOM，把错误如实抛出（**绝不静默吞**）—— 让用户知道真的出问题了。
   *
   * 收益：本机 16GB 显存实测 1408² 撞过 OOM，开启后第二次就出了图。
   *
   * ⇒ **默认开**（OOM 是没商量余地的硬约束，回退比失败好）。
   *   关 = `oomAutoFallback: false`（不推荐；只在你明确知道在做什么时关）。
   */
  oomAutoFallback: true,

  /**
   * ★★★ 2026-10-13（用户反馈）：**串行抽卡（排队模式）**。
   *
   * ## 为什么要这个
   *   `count > 1` 原来走 `EmptyLatentImage.batch_size = N` —— 那是**真并发**：
   *   N 份 latent **同时**占显存。8 GB 卡上这就是 OOM 直通车。
   *   串行模式改成「提交 1 张 → 等结果 → 落盘 → 再提交下一张」，
   *   显存里**始终只有一份 latent**。
   *
   * ## ⚠⚠ 必须澄清的一点（别照字面理解"释放显存"）
   *   用户原话是"释放显存后自动生成下一张"，但**真把主模型卸掉是错的**：
   *   下一张就得重新加载 ~13.5 GB 模型（实测冷启动 65 s），那才是灾难。
   *   串行的真正收益是「不同时持有 N 份 latent」，**主模型必须保持常驻**。
   *   ⇒ 所以串行**只做顺序提交，不做 freeComfyModels**。
   *
   * ## 三档
   *   `'auto'`（默认）—— 显存 < 16 GB 才串行（与 `vaeTiling` 的显存闸同源，判据一致）；
   *   `'on'`          —— 总是串行（晚上挂机抽卡用这个）；
   *   `'off'`         —— 走原来的并发批（大显存下更快，省 (N-1) 次排队往返）。
   */
  serialBatch: 'auto',

  /**
   * ★★★ 2026-10-13（用户反馈）：**生成后自动放大**（一键出大图）。
   *
   * 8 GB 卡想出 2K，唯一现实路径 = 先在 1024² 生成，再**分块放大**。
   *
   *   `0`（默认）= 不放大（行为与 0.16 完全一致）；
   *   `2`        = 生成完自动放大 2 倍 → 1024 × 2 = **2048（2K）** ← 推荐
   *   `3` / `4`  = 3072 / 4096（显存与时间代价大；VOSR2 高于约 4x 质量不保证）
   *
   * ⚠ 两段之间会 `freeComfyModels` 卸主模型再上放大模型（沿用放大工具既有逻辑，
   *   避免双占显存）。
   * ⚠ 放大**失败不影响**已经生成的那张图 —— 原图已落盘，只 warn 不抛错。
   */
  upscaleAfter: 0,

  /**
   * ★ 2026-10-09 实测新增：prompt 精简。
   *
   *   先给实测上限（RX 7900 XT / 1024²，同一条 TE + Speedup + quad 栈，只变 prompt）：
   *       38 字  → 7.821 s
   *      329 字  → 8.088 s
   *     1974 字  → 8.194 s
   *   即：prompt 从 38 字加到 1974 字（52 倍）也只多花 0.373 s（**+4.8%**）。
   *   ⇒ 文本 token **没有被填充到固定长度**（否则长短 prompt 会一样快），
   *     但同时也说明「精简 prompt」的收益天花板就是 ~5%，
   *     而且**只有写超长 prompt 时才摸得到**，日常 prompt 几乎为 0。
   *
   *   所以这里默认只做**无损清理**（折叠空白、合并重复标点），语义不变；
   *   `maxPromptChars` 硬截断默认 **0 = 关闭**，因为它会改变出图，
   *   而换来的最多也就是那 4.8%。
   */
  promptTrimEnabled: true,
  /** >0 时按字符数硬截断 prompt（会改变出图，默认 0 = 不截断）。 */
  maxPromptChars: 0,

  /**
   * ★★★ 2026-10-09 **实测新增：BlockCache T8**（取代了失败的 ToMe）。
   *
   * ## 实测（图生图，RX 7900 XT / ROCm，2 个 seed 取平均，只在链上加这一个节点）
   *     基线              120.75 s
   *     +BlockCache T8     93.34 s   →  **+22.7%**（省 27.4 s）
   *
   * ## 为什么它能成、ToMe 不能
   *   ToMe 在千问 2.1 上因接口不兼容三条路全断（详见 resolvePlan 里 ToMe 的移除说明）。
   *   而 BlockCache T8 官方描述明确写着：
   *     · "preserving Core's reference/text KV cache" → **原生兼容前缀缓存**
   *     · "For editing, start with threshold 0.03"   → 图生图推荐起点就是保守值
   *   下面这些默认值**就是官方对 editing 的推荐值**，我没有自己调激进口径。
   *
   * ⚠ `blockCacheThreshold` 是唯一的"速度 ↔ 保真"旋钮：
   *   调大 → 跳得更多、更快，但官方原话是 "may change pose and details"（可能改姿态和细节）。
   *   想更稳可调到 0.02；想更快可试 0.05 —— 但**请自己看效果再定**。
   */
  blockCacheEnabled: true,

  /**
   * ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按尺寸自动选**（取代"一刀切"）。
   *
   * ## 为什么必须改（这是实测打脸，不是推测）
   *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
   *   **只能上一组**。上一轮我按"TE+Speedup 8.639 s < BlockCache 9.712 s"
   *   把 BlockCache 关了（blockCacheEnabled=false）。
   *
   *   但那个对比是**小尺寸 + 模型已驻留**的理想条件下测的。
   *   在 1408×1408 的真实场景里，ComfyUI 日志白纸黑字：
   *       Qwen TE predictor: predicted 0/8 steps (**0.0%** model-call acceleration)
   *       QwenImage21Speedup: 1 cached of 8 model forwards (**12.5%** skipped)
   *   ⇒ **TE 一步都没命中、Speedup 只跳 1 步，却独占着 wrapper 坑。**
   *
   *   而 BlockCache T8 的实测是**大尺寸**（基线 120.75 s）下 **+22.7%（省 27.4 s）**，
   *   且官方描述 "preserving Core's reference/text KV cache" ⇒ **原生兼容前缀缓存**，
   *   能跟 turbo8 + 前缀 KV 缓存**叠着用**。
   *
   * ## 所以：按出图尺寸自动选
   *   · 小尺寸（latent tokens ≤ 阈值）→ TE-Speed + Speedup（小尺寸实测 +25.4%）
   *   · 大尺寸（latent tokens >  阈值）→ BlockCache T8（大尺寸实测 +22.7%）
   *
   *   ⇒ 两边都拿到各自场景里**实测更好**的那一套，而不是拿一套去硬扛所有尺寸。
   *
   * ## 取值
   *   'auto'  按尺寸自动（默认）
   *   'te'    始终 TE-Speed + Speedup（不管尺寸）
   *   'bc'    始终 BlockCache T8（不管尺寸）
   */
  wrapperPolicy: 'auto',
  /**
   * auto 模式的分界（单位：latent token 数 = round(W/8) × round(H/8)）。
   *
   * 16384 = 1024×1024 的 latent（128×128）。实测依据：
   *   992×992  → 124×124 = 15376 tokens → 模型能常驻，总耗时 23.00 s（小尺寸策略对）
   *   1408×1408→ 176×176 = 30976 tokens → 显存吃紧换页，总耗时 79.70 s（该换 BlockCache）
   */
  wrapperAutoTokensThreshold: 16384,

  /**
   * ★★★★ 2026-10-10 新增：**RDNA3 FlashAttention**（无损提速）。
   *
   * ## 为什么它是"无损"
   *   它是**精确注意力**（memory-efficient 的等价实现），不改数学 ⇒ 不改成品。
   *   节点自带 `safely falls back for unsupported calls`：形状/精度不满足就回退到
   *   原生注意力，**不会算错**。
   *
   * ## 为什么值得开（本机实测证据）
   *   启动日志里注意力走的是 ComfyUI 自带的
   *   `Using sub quadratic optimization for attention`（quad 路径，实测 +15%）；
   *   而 `custom_nodes/RDNA3-Flash-Attention` **已经装了却没用**（日志里加载了 0.3 s）。
   *   它的 `_validation.py` 明确只支持 **gfx1100**（本机 RX 7900 XT 正是 gfx1100），
   *   需要 ROCm PyTorch ≥ 2.8（本机 2.9.1+rocm7.2.1）⇒ **平台完全匹配**。
   *   1408² 时注意力是采样的大头 ⇒ 接上它有望明显缩短那 45 s。
   *
   * ## 接线位置
   *   放在**模型链最末端**（KSampler 之前）—— 它 patch 的是
   *   `model_options.transformer_options.optimized_attention_override`，
   *   必须让**采样器拿到的那个 model** 带上它，所以放最后最稳。
   *
   * ⚠ 节点没装时自动跳过（能力门控），不影响出图。
   * ⚠ 想关掉：把本项设成 false（或删掉那一行）。
   */
  rdna3FlashAttention: true,

  /**
   * ★★★ 2026-10-11 新增：**A 卡专属优化（可选，默认关）** —— 与 N 卡/I 卡专属优化同一套思路：
   *   只在**适用的显卡上**出现、默认关闭、由用户自己决定要不要开。
   *
   * ## 两条，**全部质量中性**（不牺牲原生画质）
   *   ① `amdKernel` —— 换用本代 A 卡的**替代注意力内核**（按代数自动挑 flag）：
   *        · 6000（RDNA2）→ `--use-quad-cross-attention`（子二次交叉注意力）
   *        · 7000（RDNA3）→ `--use-ck-attention`
   *        · 9000（RDNA4）→ `--use-ck-attention`
   *      注意这些是**换后端**，不是降精度：注意力仍然算完整结果，只是走不同内核。
   *   ② `amdAsyncOffload` —— `--async-offload`（异步权重卸载）。
   *      为什么值得给 A 卡：ComfyUI 的 help 原文写着
   *        "Use async weight offloading... **Enabled by default on Nvidia.**"
   *      —— 也就是**N 卡本来就默认开、A 卡默认关**。这里把它补上，属于"对齐 N 卡的默认待遇"，
   *      只改变**权重加载的时机**（与计算重叠），不改任何计算结果。
   *
   * ## 为什么默认关
   *   本机是 RDNA3，**没有 6000 / 9000 的硬件可实测**，所以**绝不擅自改别人的默认路径**
   *   （改错就是整条链路跑不动）。做成可选开关，试错成本最低。
   *   ⚠ 这两个都是**启动参数** ⇒ 改完必须**重启 ComfyUI** 才生效。
   */
  amdKernel: false,
  amdAsyncOffload: false,

  /**
   * ★★★ 2026-10-11 新增：**N 卡 SageAttention**（40 系 Ada / 50 系 Blackwell 的专属加速）。
   *
   * ## 三档
   *   · `'auto'`（默认）—— **后台自检确认 sageattention 已装**时才挂 `--use-sage-attention`；
   *     状态未知（自检还没跑完）→ **本次不加**（保守），下次启动会按自检结果决定。
   *   · `true`  —— 强制挂。**只有你确定装好了**才这么设 —— 没装会让 ComfyUI 起不来。
   *   · `false` —— 永不挂。
   *
   * ## 为什么必须"确认了才挂"
   *   `--use-sage-attention` 是**硬依赖**：ComfyUI 的 help 只有一句 "Use sage attention."，
   *   但 sageattention 不在时会直接抛错。所以这里宁可少加，也不能盲加。
   *
   * ⚠ **50 系（Blackwell / sm_120）特别注意**：SageAttention / Triton 需要**支持 sm_120 的构建**，
   *   老版本不认这代卡。装之前先确认版本；装了不匹配的话，本项反而会让 ComfyUI 起不来 ——
   *   那时把本项设成 false 即可恢复。
   */
  nvidiaSageAttention: 'auto',

  /**
   * ★★★ 2026-10-13（任务 #62②「SageAttention 收尾」）：**性能 / 兼容模式**的中文命名。
   *
   * ## 两档是什么
   *   · `'performance'`（默认，**性能模式**）—— 标准 INT8 量化注意力内核，
   *     走 ComfyUI 的 `--use-sage-attention` 全局开关，速度最快。
   *   · `'compatibility'`（**兼容模式**）—— 同样的全局开关，但**始终开启崩溃自动回退**：
   *     一旦启用后 ComfyUI 启动失败、且日志指向 sage-attention（例如 Blackwell / sm_120
   *     装了不匹配的构建、或 sageattention 没装却被强制开启），插件会**在本会话内自动关掉**
   *     `nvidiaSageAttention`，避免反复崩溃把后端彻底拉不起来。
   *
   * ## ⚠ 必须如实说明的边界
   *   ComfyUI 的 `--use-sage-attention` 是**全局开关、没有官方子模式参数**，
   *   所以本插件**没有**、也**没有编造**一个"模式"命令行参数 —— 这两档的区别只在
   *   **崩溃兜底策略**，不在命令行。性能模式假设构建正确、崩了就照常报错；
   *   兼容模式则把"崩了就自动禁用"当成默认行为，对 Blackwell 这类容易踩构建坑的卡更友好。
   *
   * ⚠ 本机是 AMD RX 7900 XT，**SageAttention 整条路径无法在本地实测**，
   *   以下结论仅来自官方文档与社区报告，未在本机验证过。
   */
  nvidiaSageAttentionMode: 'performance',

  /** 残差差异阈值。0.03 = 官方推荐的图生图起点（调大更快但可能改姿态/细节）。 */
  blockCacheThreshold: 0.03,
  /** 缓存生效的采样区间（0.1~0.9 = 跳过首尾，首尾对结构最关键）。 */
  blockCacheStartPercent: 0.1,
  blockCacheEndPercent: 0.9,
  /** 最多连续命中几次（官方默认 2）。 */
  blockCacheMaxHits: 2,
  /** 缓存放哪（cpu 省显存；cuda 更快但吃显存）。 */
  blockCacheDevice: 'cpu',
  /** 误差度量的采样步长（官方默认 8）。 */
  blockCacheMetricStride: 8,
  /** 缓存上限 MB（官方默认 1024）。 */
  blockCacheMaxMb: 1024,
  /** 阈值策略（官方默认 two_stage）。 */
  blockCacheThresholdMode: 'two_stage',
  blockCacheSplitRatio: 0.35,
  blockCacheLateThreshold: 0.15,

  /** 默认步数 / 分辨率 / 单任务超时。 */
  steps: TURBO8_STEPS,
  resolution: 1024,
  /**
   * ★★★ 2026-10-09 **尺寸锁默认关闭**（主人决定：完全听调用方）。
   *
   * ## 为什么改成 false
   *   原来默认 `true` —— 会把**任何**请求尺寸都改写成 `resolution`（默认 1024²）。
   *   后果：界面上 7 个比例**全部失效**，选 3:4 / 16:9 出来的都是方图。
   *   实测对照（锁开启时）：
   *     1:1  → 1024²   ｜ 3:4  → 1024² ｜ 4:3  → 1024²
   *     2:3  → 1024²   ｜ 3:2  → 1024² ｜ 16:9 → 1024² ｜ 9:16 → 1024²
   *   ⇒ 这是**功能被静默阉割**，而且是它顺带触发了"尺寸校验误报"那个 bug
   *     （校验拿请求值比对归一后的实际值，必然对不上）。
   *
   * ## 现在
   *   调用方要什么尺寸就给什么尺寸（仍受 32 对齐约束）。想再锁回来设 `true`。
   *
   * ⚠ 注意：**步数锁 `forceTurbo8Steps` 保留** —— 那是 Turbo8 蒸馏 LoRA 的
   *   工作点，和尺寸无关；放开步数只会更慢更糊。
   */
  forceOptimizedSize: false,

  /**
   * ★★★ 2026-10-14（C1「专业卡版」）：**显存 / 内存档位**（面板可选，用户自己挑）。
   *
   * ## 六档
   *   · `'auto'`（默认）—— **按显存自动**（= 0.16 的老行为）：
   *       ≥24 GB → 全驻留；16–24 GB → 全驻留 + 保留 0.5 GB；<16 GB → 不加。
   *   · `'resident'` —— **全驻留**：`--highvram`，模型全留显存（最快；显存装不下会 OOM）。
   *   · `'standard'` —— **标准**：不加驻留参数，交给 ComfyUI 自己调度。
   *   · `'save'`     —— **省显存**：`--lowvram`，把部分权重换到内存（慢一些，但更稳）。
   *   · `'ram'`      —— **权重放内存**：`--novram`，权重常驻内存、按需换入显存
   *                      （最省显存；**这就是"负载放到内存上、不必全放显存"那一档**）。
   *   · `'cpu'`      —— **纯 CPU**：`--cpu`，最后手段，很慢。
   *
   * ## ⚠ 必须如实说明的三条
   *   ① 这些都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效。
   *   ② **macOS 上这组参数不参与** —— ComfyUI 源码里 MPS 的 `vram_state` 被强制成
   *      `SHARED`，显式选了档位也**不会**生效（面板会如实说明）。
   *   ③ `'save'` / `'ram'` / `'cpu'` 是**拿速度换空间**，不是"优化"——
   *      它们让**显存不够的机器也能跑**，代价是变慢。别当成提速档用。
   *   ⚠ 仅在你**没有**用 `comfyArgs` 接管启动参数时生效（接管了就完全听你的）。
   */
  vramMode: 'auto',

  /**
   * ★★★ 2026-10-14（C5「专业卡版」）：**文本控制档**。
   *
   * ## 三档
   *   · `'auto'`（默认）—— 跟随链路：有 turbo8 就走 8 步，没有就回退原生工作点。
   *   · `'turbo'` —— **极速档**：8 步 / CFG 1.0（turbo8 蒸馏工作点，快，文字稍弱）。
   *   · `'native'` —— **文本控制档**：千问**原生工作点 25 步 / CFG 2.5** ——
   *       turbo8 是为速度牺牲文字渲染的；要"更精细的文本控制"就该走原生工作点。
   *
   * ⚠ `'native'` 会**明显变慢**（约 3 倍采样时间），这是拿时间换文字精度，不是 bug。
   * ⚠ 选 `'native'` 时**不会**挂 turbo8 LoRA 的位移（否则步数与位移不匹配）。
   */
  textControl: 'auto',

  /**
   * ★★★ 2026-10-14（C2「专业卡版」）：**模型精度档**（面板可选）。
   *
   * ## 五档
   *   · `'auto'`（默认）—— 按探测到的模型文件自动挑（老行为）。
   *   · `'bf16'` —— **全精度 BF16**（专业卡 24 GB+；最高画质）。
   *   · `'fp8'`  —— **FP8**（12 GB+；画质接近 BF16，显存省一半）。
   *   · `'int8'` —— int8 safetensors（当前默认档）。
   *   · `'gguf'` —— GGUF Q4/Q5（低显存）。
   *
   * ⚠ **本机（AMD RX 7900 XT 20 GB）无法实测 BF16 / FP8** —— 相关档位是按
   *   官方发布格式与显存需求写的，**真机效果需你在 24 GB+ 卡上验**。
   * ⚠ 选了某个档但**模型文件不在**时，插件**如实报缺失**、并**回落**到可用档，
   *   绝不假装已经用上了（详见 `pickBestModel`）。
   */
  precisionTier: 'auto',

  /**
   * ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（面板下拉，运行时切换）。
   *   · `mainModelOverride`       —— 主模型文件名（空 = 用自动挑的那个）
   *   · `loraOverride`       —— 额外 LoRA 文件名（空 = 不加）
   *   · `controlnetOverride` —— ControlNet 权重文件名（空 = 不用）
   *
   * ⚠ **取值必须确实存在于 ComfyUI 的模型清单里** —— 服务端会校验（白名单 = 实时探测到的文件列表），
   *   不在清单里的一律**拒绝**（否则手拼一个 URL 就能把任意路径塞进工作流）。
   * ⚠ 这些是**工作流参数**，**下次出图**即生效（不用重启 ComfyUI）。
   * ⚠ 主模型覆写**优先于**精度档（用户显式选的就该赢）。
   */
  mainModelOverride: '',
  loraOverride: '',
  controlnetOverride: '',

  /**
   * ★★★ 2026-10-14（C4「专业卡版」）：**通用 ControlNet** 的强度与生效区间。
   *   ⚠ 只有在「选中了 ControlNet 权重」**且**「本次传了控制图」**且**「两个节点都在」时才会接进工作流；
   *     否则**不接**，并在工具返回值里如实说明原因（不静默）。
   *   ⚠ 本机未实测（AMD 20 GB）—— 真机效果请自行验证。
   */
  controlnetStrength: 0.8,
  controlnetStartPercent: 0.0,
  controlnetEndPercent: 1.0,

  // ★★ 2026-10-09：从 600000(10分钟) 收敛到 300000(5分钟)。
  //   原值过大——一旦后端真卡住，工具会干等 10 分钟才报错，观感就是"卡死"。
  //   5 分钟足够覆盖首次加载模型(~12s)+大图生图(2048² 约 53s)的余量；
  //   真要更久可在 cordis.patch.yml 调大，但别再回到 10 分钟那种"假性卡死"。
  timeoutMs: 300000,
  /** 轮询 ComfyUI 的间隔（毫秒）；自测里会调小。
   *  ★ 2026-10-10（提速 M7）：1200 → **400**。
   *    出图完成到被感知的延迟最多 = 一个轮询周期；本地 ComfyUI 多问几次代价可忽略，
   *    但"最后一秒才反应过来"的观感差别明显。 */
  pollIntervalMs: 400,
  /** 文件名前缀（落盘命名用）。 */
  filePrefix: 'Qwen2.1',
  /** ★ 空闲自动关停：出图后多久没再出图就关掉 ComfyUI（默认 5 分钟）。 */
  idleShutdownMs: 300000,
  /** 空闲检查的间隔。 */
  idleCheckMs: 30000,
  /** 关掉 ComfyUI 总开关（想一直留着就设 false）。 */
  autoShutdown: true,
  /** 状态探测的缓存时长，避免客户端每秒轮询都去敲 ComfyUI。 */
  statusCacheMs: 3000,
  /** ★★ 生图过程的动画（主人 2026-10-08 要求「使用户生图时可以自选动画」）。
   *   meteor = 现在这个马卡龙流星（默认，观感不变）；其余见 FLOW_STYLES。
   *   界面上的选择会**落盘**（见 uiStatePath），下次启动记得住。 */
  flowStyle: 'meteor',

  /** ★★★ 2026-10-19（用户要求）：抽卡「挑图」的两个开关 —— **都由用户自己决定是否启用**。
   *   · `aiPickBest`   = `'on'`：一次出多张时，AI 用 `read_image` 逐张查看，
   *     挑最好的一张推荐给用户并说明理由，其余一并列出；并**记住用户偏好**，下次按偏好挑。
   *   · `userPickBest` = `'on'`：面板把多张并排显示，让用户自己点选"哪张最好"（点开放大）。
   *   两者可以同时开（AI 先推荐，用户仍可自己点）。**默认都关 = 与升级前行为完全一致。**
   *   界面上的选择会**落盘**（见 uiStatePath），重启也记得住。 */
  aiPickBest: 'off',
  userPickBest: 'off',

  /* ------------------------------------------------- hipfire 出图后端（★新） ---- */
  // ★★ 2026-10-08 新增：与 ComfyUI 并存的第二个出图后端，可通过配置切换。
  //   硬约束：**默认仍是 comfyui** —— 不改变任何现有行为。
  //   详见 lib/hipfire-img.js 顶部的长篇说明（协议细节、已知不支持项、两条通道）。
  ...HIPFIRE_DEFAULTS,
}

/* ------------------------------------------------ 生图动画方案（界面可自选） ---- */

/**
 * 允许的动画 id 白名单 —— **host 端只需要 id，渲染全在客户端**（见 client.js 的 FLOW_GRADS）。
 * meteor + 15 种流光（色值照搬主人小肥鱼挂件里那套「跑马灯」流光，一个字没改）。
 *
 * ⚠ 这里必须**白名单校验**：`?flowStyle=` 是外部输入，直接塞进样式名会变成注入面。
 * ⚠ 客户端那份表要和这里对齐 —— 自测里有一条专门比对两边 id 集合，改名时两边一起改。
 */
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

/** 写日志：宿主 logger 存在就写，不存在就吞掉（绝不让日志把功能搞崩）。 */
function makeLog(ctx) {
  return (level, message) => {
    try {
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

/**
 * ★★★ 2026-10-12（用户要求「预设工作流」）：预设 → 画幅比例。
 *
 * 只在用户**没显式传 size** 时生效；megapixels 永远尊重用户显式值（不覆盖）。
 *   · portrait / anime → 3:4（人像 / 动漫插画竖版）
 *   · wallpaper        → 16:9（壁纸横版）
 *   · 其它             → null（交给下层回落到 1:1）
 * 这是纯映射，不碰任何出图链路。
 */
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

/**
 * ★★★ 2026-10-09 **真事故修复**：把"任何形态的错误"变成真正的 `Error`。
 *
 * ## 事故现场
 *   主人点"画一张"，DSH 只回报一句：
 *     `画图失败：Error: [object Object]`
 *   信息量为零 —— 既不知道哪一步失败，也不知道为什么。
 *
 * ## 根因（已用 `scripts/_abort_reason_test.mjs` 实测复现）
 *   `AbortController.abort(reason)` 会把 `reason` **原样**变成 fetch 的 reject 值。
 *   实测四种 reason 的落地形态：
 *     · `new Error('x')`  → reject 值是同一个 Error      → `String(e)` = `Error: x`      ✅
 *     · 普通对象 `{...}`  → reject 值是**同一个普通对象** → `String(e)` = `[object Object]` ❌
 *     · 字符串 `'x'`      → reject 值是同一个字符串       → `String(e)` = `x`             ⚠
 *     · `undefined`       → reject 值是 DOMException      → `String(e)` = `AbortError: …` ✅
 *
 *   而 DSH 宿主传进来的 `exec.signal.reason` **是个普通对象**（不是 Error）。
 *   老代码 `controller.abort(signal.reason)` 把它当 reason 转发 →
 *   `[object Object]` 就一路飘到用户眼前，把真实原因（取消？超时？哪一步？）全糊掉了。
 *
 * ## 修法
 *   ① 新增 `toError()`：**任何**输入都能得到一个带可读 message 的 Error；
 *   ② 新增 `cancelReason()`：把外来 signal.reason **翻译成人话**，绝不原样转发；
 *   ③ 所有 `throw signal.reason` / `controller.abort(signal.reason)` / `?? error` 全部改用它。
 *
 *   这样即使宿主再换一种 reason 形态，用户看到的也永远是"人话"，不是 `[object Object]`。
 */
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
    // ★★★ 2026-10-16（DSH STORE 第二轮复核整改）：改用 `guardedFetch` ——
    //   它内部**同时**做两件事：① 出站前回环校验（非回环且未 opt-in 直接抛错）；
    //   ② 强制 `redirect: 'error'`。这样"校验"与"禁重定向"收口在一处，
    //   不会出现"某条链路只做了其中一半"（上一轮的教训）。
    //   开关读 net-guard 的全局值，由 apply() 按 cfg.allowRemoteComfy 设置。
    return await guardedFetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      // ★★ 2026-10-08：**别让系统代理劫持 localhost**。
      //   本机环境里有 HTTP_PROXY/HTTPS_PROXY（实测 http://127.0.0.1:54536），
      //   Node 的 fetch 默认**会**把带显式端口的 127.0.0.1 也塞给代理 ——
      //   结果是连本机 ComfyUI 都报「连不上」，误导性极强。
      //   这里显式 `proxy: undefined`：对 http:// 目标等于直连（HTTPS 目标不受影响，
      //   因为 ComfyUI 走的是 http）。
      proxy: undefined,
    })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ★★ 把 ComfyUI 后端**隐身**启动：无控制台、不弹浏览器、不抢焦点。
 *
 * 主人先后两次要求：①「comfyUI 及其所有后端全部隐藏不要显示出来」；
 * ②（2026-10-07）「生图时依旧有弹窗出来，想办法隐藏掉」。
 * 那个弹窗就是**浏览器**，来源有两处，都已查实：
 *   · 启动 bat 的「已在运行」分支里有一句 `start "" http://127.0.0.1:8188`；
 *   · ComfyUI 自身的 `--auto-launch`（`--windows-standalone-build` 下可能被带上）。
 * 所以这里**绕过 bat**，直接调 python.exe + `-WindowStyle Hidden`（窗口藏住、输出流仍在），
 * 并显式加 `--disable-auto-launch`。两个参数名都用 `main.py --help` 核实过确实存在。
 */
/**
 * ★★ 2026-10-09（通用化）：**自动找出 ComfyUI 装在哪**。
 *
 * 通用包**绝不能写死安装路径** —— 每个人装的盘符、目录名都不同（有人是官方
 * Windows 便携包 `ComfyUI_windows_portable\python_embeded\python.exe`，有人是
 * 源码 + venv，有人装在 K 盘、E 盘……）。所以：
 *   ① 配置里显式给了 python + main.py → 直接用（尊重用户）
 *   ② 否则扫常见位置 + **各盘根目录下名字含 comfy 的目录**，找"python + main.py"齐活的组合
 * 都找不到返回 null，由调用方给出可照做的提示（而不是抛一个莫名其妙的 ENOENT）。
 */
/* ---------------------------------------------------------------- 平台抽象 ---- */


// ===== moved from index.js: IS_WINDOWS (was lines 208-208) =====
const IS_WINDOWS = process.platform === 'win32'

// ===== moved from index.js: IS_MAC (was lines 210-212) =====
const IS_MAC = process.platform === 'darwin'

/** Windows：WMI 列出所有显示适配器名称。 */

// ===== moved from index.js: GPU_PROBE_WIN (was lines 213-229) =====
const GPU_PROBE_WIN = '(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | '
  + 'Select-Object -ExpandProperty Name) -join " | "'

// ★ 2026-10-09 新增：**显存总量探测（最可靠的一条）**。
//
//   为什么必须单独探：启动参数里的「显存驻留档位」需要**显存总量**才能决定，
//   而启动流程用的是 skipOnline（ComfyUI 还没起来），拿不到 /system_stats。
//
//   三条来源的可靠性（本机实测）：
//     ① ComfyUI `/system_stats`               → ✅ 准（但未启动时拿不到）
//     ② Windows WMI AdapterRAM                → ❌ **不可信**：本机 RX 7900 XT
//        实际 19.98 GB，WMI 却报 4293918720 bytes = **4.0 GB**（32 位字段截断）
//     ③ PyTorch `get_device_properties(0).total_memory` → ✅ **最准**（实测 19.98 GB）
//
//   ⇒ 所以这条放在 WMI 之前用。它就是用 ComfyUI 自己的 Python 跑一句，
//     既不需要 ComfyUI 运行，也不受 WMI 那个 4 GB 截断的影响。
//   注意：这里**只取总显存这个静态值**，不会加载任何模型、不占显存。

// ===== moved from index.js: GPU_VRAM_PROBE_PY (was lines 230-245) =====
const GPU_VRAM_PROBE_PY = 'import torch;'
  + 'p=torch.cuda.get_device_properties(0);'
  + 'print(int(p.total_memory))'

/**
 * ★★★ 2026-10-11 新增：**macOS（Apple Silicon）** 的显存探测。
 *
 * ⚠ 上面那个写死了 `torch.cuda.get_device_properties(0)` —— macOS 上**没有 CUDA**，
 *   那一句直接抛错（被 catch 吞掉）⇒ macOS 上 vramGB 恒为 0。
 * 改用 PyTorch 官方的 MPS API `torch.mps.recommended_max_memory()`（返回字节数）。
 *
 * ⚠ 它给的是**建议的最大工作集**，在统一内存上**不等于物理总量**（PyTorch 会按总内存
 *   留出余量）。所以这个值只用于**展示**；Apple 上不会据此加任何驻留参数
 *   （见 VRAM_ARGS 里的显式跳过）。
 * 用 `getattr(..., lambda: 0)` 兜底：老版本 PyTorch 没有这个 API 时打 0，而不是抛错。
 */

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

/**
 * ★★★ 2026-10-11 新增：**macOS** 的显卡探测。
 *
 * ⚠ macOS **没有** nvidia-smi / rocm-smi / lspci —— 所以绝不能沿用 Linux 那条
 *   （沿用的结果就是"探测永远为空 → 一律 unknown"，这正是之前 macOS 上的实际表现）。
 *
 *   · `system_profiler SPDisplaysDataType` —— 最稳的一条，输出里就有我们要的那行
 *     `Chipset Model: Apple M3 Pro`；
 *   · 兜底 `sysctl -n machdep.cpu.brand_string` —— Apple Silicon 上直接给出
 *     `Apple M3 Pro`（`system_profiler` 偶发很慢/被沙箱限制时还有它）。
 *   两条都 `2>/dev/null`：拿不到是常态，不该产生噪音。
 */

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
  // ★★★ 2026-10-09 修复（通用性）：原来这里写死了 `C:\ D:\ E:\ F:\ G:\ X:\` 六个盘。
  //   装在第 7 个盘（H:、I:…）或盘符被改过的机器上，这一行**完全覆盖不到**，
  //   只能靠下面 `Get-PSDrive` 那段兜底 —— 而兜底只找**目录名含 comfy** 的。
  //   所以"盘符不在表里 + 目录名不含 comfy"（例如自定义命名 `Qwen`）就会漏掉。
  //   改成**动态枚举所有本地盘符**，一个都不预设；目录名字面量另列在最上面，
  //   保证 `X:\ComfyUI` 这种最常见的安装即使不做递归也能命中。
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

/**
 * ComfyUI 路径扫描 —— Linux / macOS 版。
 *
 * 与 Windows 版的差别（都是平台事实，不是随意写的）：
 *   · 解释器在 `venv/bin/python`（不是 `Scripts\python.exe`）；
 *   · 安装位置习惯不同：`~/ComfyUI`、`/opt/ComfyUI`、`~/comfy/...` 更常见；
 *   · 没有"盘符"概念，改为扫 `/mnt`、`/media`、`/opt`、`/srv` 与家目录下
 *     名字含 comfy 的目录（同样覆盖改名安装，如 `ComfyUI-rocm`）。
 * `-maxdepth 3` 是刻意的：再深就会变成全盘遍历，慢到不可接受。
 */

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

/**
 * ★★★ 2026-10-09：**跨平台**执行一段脚本，拿 stdout（超时保护）。
 *
 *   Windows        → PowerShell（并把控制台输出编码钉成 UTF-8，
 *                    否则 Windows PowerShell 5.1 按 ANSI 代码页输出、这里按 utf8 解析，
 *                    遇到中文（如「Microsoft 基本显示适配器」）会变成乱码）
 *   Linux / macOS  → `sh -c`（POSIX，**不假设有 bash** —— 精简发行版里可能只有 dash）
 *
 * ⚠ 所以叫 `runShell` 而不是 `runPowerShell`：它是**所有系统命令的唯一入口**
 *   （探测 GPU、找 comfy 进程、装加速包…），任何绕过它的 Windows 专有命令
 *   都会在 Linux 上直接崩掉。
 */

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
        // ★★ 2026-10-09 修正（**真 bug**）：workdir 必须是 **main.py 所在目录**，
        //   而不是扫描脚本回传的 `$root`。
        //   扫描脚本的 `$root` 是"候选根目录"（例如 `X:\ComfyUI-rocm`），
        //   而 main.py 其实在 `$root\ComfyUI\main.py` —— 两者差一层。
        //   拿 `$root` 当工作目录会让 ComfyUI 的相对路径解析全错。
        //   `path.dirname(mainPy)` 永远等于"main.py 所在目录"，这才是对的那个。
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

/**
 * ★★★ 2026-10-09（三厂商自适应）：把"按显卡厂商选优化方案"做成一张表。
 *
 * ## 两层优化，别混为一谈
 *   ① **通用优化**（与显卡无关，所有厂商都吃）：turbo8 八步链、官方前缀 KV 缓存、
 *      TE-Speed / Speedup 跳步缓存 —— 这些是"算法层"的省时，已在 buildWorkflow 里按
 *      能力探测自动接上。**任何卡都受益**。
 *   ② **专用优化**（跟厂商强绑定）：注意力后端启动参数 + 厂商专属的高性能 attention 内核。
 *      三家的硬件特性、可用内核、PyTorch 后端完全不同，**一刀切必然翻车**：
 *        · AMD/ROCm：`--use-quad-cross-attention` 实测 +15%；且 RDNA3 缺少生产级融合
 *          内核（PyTorch 在 gfx11 上退回"非融合 math"路径，会实打实展开 seqlen² 矩阵）。
 *        · NVIDIA/CUDA：PyTorch SDPA 本身就走 flash / mem-efficient 内核，再挂 quad
 *          没有收益；真正的大头是 **SageAttention**（INT8 量化注意力）这类第三方内核。
 *        · Intel/XPU：只能靠 PyTorch 的 xpu 后端 + IPEX，插件不该乱加内核参数。
 *   ③ 识别不出厂商 → **一个参数都不加**（最保守，先保证能起来）。
 *
 * ## 匹配规则为什么要打分
 * 一台机器可能同时报出核显 + 独显（例如 Intel 核显 + NVIDIA 独显、AMD 核显 + RTX）。
 * 若按数组顺序匹配，"AMD Radeon Graphics | NVIDIA RTX 4090"会先命中 AMD 核显而判错。
 * 所以按**得分最高**者胜：明确型号（RTX / Radeon RX / Arc）> 泛化的厂商名 > 核显。
 */

// ===== moved from index.js: GPU_PROFILES (was lines 448-597) =====
const GPU_PROFILES = {
  /**
   * ★ RDNA3（RX 7000 系列）—— **主人的既定方案，刻意保持不变**。
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
  /**
   * ★★★ RDNA4（RX 9000 系列）—— **唯一需要换内核的 AMD 分支**。
   *
   * 为什么必须区别对待：RDNA4 走的是 PyTorch 的 **CK SDPA（Composable Kernel）** flash
   * attention 路径，而它在 gfx1200/gfx1201 上**长期是坏的**（内核断言失败，
   * 见 pytorch#188113），后来的 PR #188114 / #193585 才修好并放开。
   * 所以 9000 系不能沿用 RDNA3 的 quad，而要显式走 `--use-pytorch-cross-attention`
   * 去用那个 CK 内核 —— **前提是 PyTorch 足够新**。
   */
  amd_rdna4: {
    id: 'amd_rdna4',
    label: 'AMD Radeon RX 9000 系列（RDNA4 / gfx120x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch CK SDPA flash attention（RDNA4 专用内核）',
    packs: [],
    note: 'RDNA4 的 CK SDPA 需要较新的 PyTorch；旧版在 gfx1200/1201 上会断言失败'
      + '（pytorch#188113 → 修复 #188114 / #193585）。若启动即崩，可把 comfyAttentionBackend 设为 default。',
  },
  /**
   * ★ RDNA2（RX 6000 系列）—— 保守路径。
   *
   * 为什么单独一档：ROCm 的融合注意力路径（AOTriton）**只覆盖 RDNA3 / RDNA3.5 / RDNA4**，
   * RDNA2（gfx103x）不在其列，CK SDPA 同样不覆盖它。也就是说这代卡上**没有可用的
   * 厂商级融合 attention 内核**，挂 quad / 强行指定内核都只是碰运气。
   * 所以这里走 `--use-pytorch-cross-attention`，把内核选择权交回 PyTorch
   * （它会自行落到可用的 mem-efficient / math 路径），先保证**能跑、不崩**。
   */
  amd_rdna2: {
    id: 'amd_rdna2',
    label: 'AMD Radeon RX 6000 系列（RDNA2 / gfx103x）',
    args: ['--use-pytorch-cross-attention'],
    tuning: 'PyTorch SDPA（RDNA2 无 AOTriton / CK 融合内核，走保守路径）',
    packs: [],
    note: 'RDNA2 不在 ROCm AOTriton 覆盖范围内（仅 RDNA3/3.5/4），故不套用 quad；'
      + '若有异常可把 comfyAttentionBackend 设为 default。',
  },
  /**
   * ★★★ 2026-10-12 新增：**RDNA1（RX 5000 系列 / gfx101x）**。
   *
   * ## 之前错在哪
   *   RX 5000 系没有规则 ⇒ 落到下面的泛化 `amd` 档（quad + "未识别具体架构"）。
   *   两处都不对：
   *     ① 它其实**认得出代数** —— RX 5500/5600/5700 = Navi 10/14 = gfx1010/gfx1012；
   *     ② 更要紧的是它**和 RDNA2 一样没有厂商级融合注意力内核**：
   *        ROCm 的 AOTriton 只覆盖 RDNA3 / RDNA3.5 / RDNA4，CK SDPA 也不覆盖 gfx101x
   *        ⇒ 给它挂 quad（或强行指定内核）只是碰运气。
   *   ⇒ 与 RDNA2 同样走保守的 `--use-pytorch-cross-attention`，把内核选择交回 PyTorch。
   *
   * ## ⚠ 必须如实告知的一件事：RDNA1 不在 ROCm 官方支持矩阵内
   *   PyTorch 官方 ROCm 轮子**没有编译 gfx101x**。社区的两条路：
   *     (a) `HSA_OVERRIDE_GFX_VERSION` 让运行时把这张卡"当成"别的 gfx 代号；
   *     (b) 自己按 gfx1010 / gfx1012 重新编译 PyTorch。
   *   这属于**环境搭建**层面的事 —— 插件不改也不该改（改驱动/编译轮子风险远大于收益），
   *   只把这件事写在 note 里，让用户不至于"装完发现认不到卡"。
   */
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
  /**
   * ★ Intel Arc —— 只把**两张主力消费卡**单独拉出来（B580 / A770），其余 Arc 落到泛化分支。
   *
   * 两代卡的共同点：都靠 PyTorch 的 **XPU 后端 + IPEX**，插件不额外指定内核参数
   * （Intel 上没有任何值得手动挂的 attention 后端轴）。
   * 差别在**所需软件栈的代数**：A770 = Alchemist(Xe HPG)，B580 = Battlemage(Xe2)，
   * 后者更新，需要更新的 torch-xpu / IPEX。
   */
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
  /**
   * ★★★ 2026-10-11 新增；**2026-10-12 补上真正的优化**：**Apple Silicon（MPS，M1–M5）**。
   *
   * ## 原先为什么是空的（以及为什么那是错的）
   *   原注释写的是「ComfyUI 官方没给任何 Mac 专属启动参数 ⇒ args: []」。
   *   那句话本身没错，但**漏掉了一个关键事实**。去 ComfyUI 源码里核对：
   *
   *   `comfy/model_management.py` 里 `ENABLE_PYTORCH_ATTENTION` 的自动开启条件只有：
   *     · 显式 `--use-pytorch-cross-attention`
   *     · `is_nvidia()`（torch ≥ 2）
   *     · `is_intel_xpu() / is_ascend_npu() / is_mlu() / is_ixuca()`
   *     · AMD 且 aotriton 且 arch ∈ {gfx90a, gfx942, gfx950, gfx1100, gfx1101,
   *       gfx1150, gfx1151, gfx1170, gfx1171}（或 ROCm≥7 且 gfx1200/1201）
   *   —— **没有任何一条与 MPS 相关** ⇒ Mac 上它**恒为 False**
   *   ⇒ `comfy/ldm/modules/attention.py` 落到 `optimized_attention = attention_sub_quad`
   *     （日志原文 "Using sub quadratic optimization for attention, ..."）。
   *
   *   也就是说：**Mac 上默认根本没走 Metal 的融合 SDPA 内核**，走的是那个
   *   给 CPU / 低显存场景准备的次二次通用实现。
   *   ⇒ `--use-pytorch-cross-attention` 在 Mac 上**不是多余的显式声明**，
   *     而是**真正把它切到 PyTorch SDPA（MPS 上即 Metal 融合内核）**的开关。
   *     这正是"苹果端完全没有优化"的根因所在。
   *
   * ## 另一件 Mac 专属的事：`PYTORCH_ENABLE_MPS_FALLBACK`
   *   PyTorch 官方 MPS 环境变量（见官方 "MPS Environment Variables" 文档）。
   *   MPS 后端**未实现**的算子会自动回退到 CPU 执行，而不是直接抛错。
   *   默认 **开**：它只影响"本来就会失败"的路径，对已支持的算子**不改变任何数值结果**，
   *   属纯健壮性兜底（没有它时，链路里碰到一个未实现的算子整次出图就崩了）。
   *
   * ## ⚠ 几件**明确不加**的东西（都是查过源码/文档才敢不写的）
   *   · `--force-fp16` —— `should_use_fp16()` 对 MPS 直接 `return True`，
   *     Mac 上本来就是 fp16，加了等于没加。
   *   · `--force-non-blocking` —— `device_supports_non_blocking()` 对 MPS 恒 False
   *     （源码注释原文 "pytorch bug? mps doesn't support non blocking"）。
   *   · `--highvram` / `--lowvram` / `--novram` / `--reserve-vram` —— ComfyUI 里
   *     `if cpu_state == CPUState.MPS: vram_state = VRAMState.SHARED`，
   *     驻留档位在 MPS 上**根本不参与**；插件也已显式跳过（见 VRAM_ARGS 的 IS_MAC 分支）。
   *   · `--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention`
   *     —— 都是 CUDA / ROCm 专属内核，MPS 上不存在。
   *
   * ## ⚠ 诚实边界
   *   本机（Windows + ROCm）**没有 Mac 硬件** ⇒ 上面这条参数**没在真机实测过**。
   *   它的依据是 ComfyUI 与 PyTorch 的源码/官方文档（可复核），不是猜的；
   *   但"能跑多快"我给不出数字。想回到"一个参数都不加"：
   *   把 `comfyAttentionBackend` 设为 `default`。
   */
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
  /**
   * ★★★ 2026-10-12 新增：**Intel Mac + AMD 独显**（2016–2020 的 MacBook Pro / iMac 等）。
   *
   * ⚠ 关键事实：**macOS 上的 AMD 显卡不走 ROCm** —— Apple 只提供 Metal / MPS 这一条路
   *   （既没有 ROCm，也没有 HIP，更没有 CUDA）。
   *   所以这些机型**绝不能**套用 Windows/Linux 上 A 卡那套
   *   （`--use-ck-attention` / quad / `HSA_OVERRIDE_GFX_VERSION`）——照做只会起不来。
   * ⇒ 本档与 apple 档走**同一套**（SDPA + MPS 回退），差别只在**标签与说明**：
   *   用户拿的是 Intel 机器，面板上却显示"Apple Silicon"会让人以为探测错了。
   */
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
  /**
   * ★★★ 2026-10-12 新增：**macOS 但芯片型号认不出来**（只知道 MPS 可用）。
   *
   * 为什么需要这一档：ComfyUI 在 Mac 上通过 `/system_stats` 报的设备名**只是 "mps"**
   *   （源码 `get_torch_device_name()` 对非 CUDA/XPU 设备只返回 `device.type`）。
   *   若 `system_profiler` 也被挡住（沙箱 / 超时），就只剩这一个词可用 ——
   *   那时既判不出 Apple Silicon，也判不出 Intel Mac。
   * ⇒ 与其含糊地落进 `unknown`（面板会显示"不指定任何参数"，
   *   与实际挂上的 `--use-pytorch-cross-attention` **自相矛盾**），
   *   不如给一个诚实的第四档：**按 MPS 同款处理，并明说型号未识别**。
   *   （`apple` / `mac_amd` / `mac_mps` 三档的 args 与 env **刻意保持一致** ——
   *     macOS 上能走的路只有 Metal/MPS 一条，与具体是哪块芯片无关。）
   */
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
  /**
   * ★★★ 2026-10-12 新增：**Intel Mac（无 Apple 芯片、也没有可用独显）**。
   *
   * ⚠ 这是一个**真误判**的修复：原先 Intel Mac 会落到 `intel` 档，而那个档是给
   *   **Windows/Linux 上的 Intel Arc（XPU + IPEX）** 准备的 ——
   *   标签写着"Intel（XPU，未识别具体型号）"、挂 `--use-pytorch-cross-attention`、
   *   还带 `packs: ['ipex']`。可 **macOS 上根本没有 XPU 这条后端**
   *   （IPEX 的 os 白名单也只写了 win32/linux），用户照着做只会白折腾。
   * ⇒ 单独一档：**不指定任何厂商内核参数**，并把"Intel Mac 到底能怎么跑"讲清楚。
   *   带 AMD 独显的机型会走上面的 `mac_amd`（MPS）；只有 Intel 核显的机型
   *   实际上只能跑 CPU —— 出图会非常慢。这是硬件事实，不该粉饰。
   */
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
  unknown: {
    id: 'unknown',
    label: '未知 / 其他',
    args: [],
    tuning: '不指定任何注意力参数（保证能启动）',
    packs: [],
  },
}

/**
 * ★★★ 2026-10-11 新增：**A 卡"专属内核"候选表**（可选优化，默认关）。
 *
 * 与上面 `GPU_PROFILES` 的**默认** `args` 是两回事：
 *   · `GPU_PROFILES[x].args`  = **默认路径**（经过验证、不动）；
 *   · 本表                    = 用户**主动打开** `amdKernel` 时才替换成的**替代内核**。
 *
 * 为什么按代数给不同 flag：
 *   · 6000（RDNA2）没有 AOTriton / CK 融合内核覆盖（见 GPU_PROFILES.amd_rdna2），
 *     所以给它的是 `--use-quad-cross-attention`（子二次交叉注意力，换掉默认的 pytorch-cross）；
 *   · 7000 / 9000 给 `--use-ck-attention`（ComfyUI 自带的 "Comfy Kitchen attention"）。
 * ⚠ 全部是**换后端**、不改计算结果 —— 不是降精度，也就**不牺牲原生画质**。
 * ⚠ 本机只有 RDNA3，6000/9000 **没硬件实测** ⇒ 一律默认关，由用户自行尝试。
 */

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
  // ★★★ 2026-10-12 新增：**RDNA1（RX 5000 系列 / gfx101x）**。
  //   之前这一代**没有规则** ⇒ 落到泛化的 `amd`（score 60）⇒ 档案显示"未识别具体架构"
  //   且被套上 quad。它其实认得出（RX 5500/5600/5700 = Navi 10/14 = gfx1010/gfx1012），
  //   而且**和 RDNA2 一样没有厂商级融合注意力内核**（AOTriton 只覆盖 RDNA3/3.5/4）
  //   ⇒ 该走保守路径，见 GPU_PROFILES.amd_rdna1。
  //   ⚠ 分数**低于** RDNA2(93)：`5\d{3}` 的匹配面比 `6\d{3}` 更容易误伤
  //     （例如某些厂商名/型号里带 5 开头四位数字），宁可让它被更明确的规则压住。
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
  { id: 'intel', re: /intel|iris|uhd graphics|xe graphics/i, score: 50 },
]

/**
 * 按 VENDOR_RULES **打分**判定厂商/代数，返回最匹配的 profile id（识别不出 = 'unknown'）。
 *
 * ★ 2026-10-10 抽出：`detectGpuProfile` 与 `resolvePlan` 共用同一套判定 ——
 *   后者要靠它**门控厂商专用节点**（如 RDNA3 FlashAttention 只认 gfx1100），
 *   两处若各写一份，改一处忘另一处就会"探测说 A、接线按 B"。
 */

// ===== moved from index.js: vendorIdOf (was lines 635-653) =====
/**
 * ★★★ 2026-10-12 新增：**macOS 平台闸** —— 把 Mac 上的判定收进 Mac 自己的三档。
 *
 * ## 为什么必须在"平台"这一维上再收一次口
 *   `VENDOR_RULES` 是**按显卡名字**判的，而**同一个名字在不同平台上能用的计算栈完全不同**：
 *     · Windows/Linux 上的 "AMD Radeon RX 7900 XT" → ROCm/HIP → quad / CK 那套；
 *     · macOS 上的 AMD 显卡 → **只有 Metal / MPS**（Apple 不提供 ROCm）⇒ 上面那套全错；
 *     · Windows/Linux 上的 "Intel Arc" → XPU + IPEX；macOS 上**根本没有 XPU 后端**。
 *   不收口就会出现"Intel Mac 被建议装 IPEX"、"Mac 上的 A 卡被建议挂 --use-ck-attention"
 *   这类**照着做必然失败**的建议 —— 这正是之前 Mac 端"零适配"的另一种表现。
 *
 * ## 为什么写成**纯函数 + 可注入 platform**
 *   本机是 Windows，没有 Mac 硬件。把 platform 做成参数后，
 *   非 Mac 机器上也能直接回归 Mac 的三条分支（见 `_gpu_vendor_test.mjs`），
 *   不必等真机 —— 否则这段逻辑永远处于"没测过"的状态。
 *
 * ⚠ 认不出就不猜：文本为空或既不像 Apple / 也不像 AMD / Intel → `unknown`。
 */
function macFamilyOf(text) {
  const s = String(text ?? '')
  // Apple Silicon：system_profiler 给 "Chipset Model: Apple M3 Pro"，
  // sysctl 兜底给 "Apple M3 Pro"。`m\d` 覆盖 M1–M9（含尚未发布的代次）。
  if (/apple\s+m\d/i.test(s) || /\bm\d\s*(pro|max|ultra)\b/i.test(s)) return 'apple'
  // 非 Apple Silicon 的 Mac：能不能用 Metal，取决于**有没有 AMD 独显**
  // （Apple 自 2016 起用 AMD 独显；只有 Intel 核显的机型实际上只能跑 CPU）。
  if (/radeon|amd|ati\b|advanced micro devices/i.test(s)) return 'mac_amd'
  if (/intel|iris|uhd graphics|xe graphics/i.test(s)) return 'intel_mac'
  // ★★★ 2026-10-12：**只有 "mps" 一个词**的情形（真实且常见，不是臆想）。
  //   依据（ComfyUI 源码）：`get_torch_device_name()` 对**非 CUDA / XPU** 设备
  //   只返回 `device.type` ⇒ macOS 上 `/system_stats` 的 `devices[0].name` 就是 **"mps"**，
  //   **不含芯片型号**。这时既不能判成 Apple Silicon、也不能判成 Intel Mac。
  //   ⇒ 给一个明确的第四档，而不是含糊地落进 `unknown`（那会让面板显示
  //     "不指定任何参数"，与实际挂上的 --use-pytorch-cross-attention 自相矛盾）。
  //   ⚠ 顺序必须在 apple / amd / intel **之后**：Mac 的显卡报告里普遍带
  //     "Metal Support: Metal 3" 这类字样，提前匹配会把型号明确的机型也吞掉。
  if (/\bmps\b|\bmetal\b/i.test(s)) return 'mac_mps'
  return 'unknown'
}

/**
 * Mac 四档的 id 集合 —— 面板据此决定要不要显示 Apple / macOS 专属优化项。
 *
 * ★ 为什么用「`IS_MAC` **或** 判定结果是 Mac 档」而不是只看 `IS_MAC`：
 *   · 只看 `IS_MAC`：真 Mac 上万一**显卡探测失败**（`system_profiler` 被沙箱拦、
 *     超时等），判定会落到 `unknown` ⇒ Mac 专属项**一项都不显示**，
 *     用户看到的就是"这台 Mac 上插件什么都没做" —— 正是本轮要修的那个观感；
 *   · 只看判定结果：在非 Mac 机器上无法回归这段 UI（本机就没有 Mac）。
 *   两者取或：真 Mac 上一定显示；同时**非 Mac 机器上也能用 Mac 显卡名跑回归**。
 */
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

/**
 * ★★★ 2026-10-12 新增：从探测文本里抠出 **Apple 芯片代次**（M1–M5，含 Pro/Max/Ultra）。
 *
 * 只用于**展示与说明** —— 插件**不做**按代次的差异化调参，理由如实说明：
 *   M1 到 M5 在插件这一层走的是**同一条路**（Metal / MPS + PyTorch SDPA），
 *   ComfyUI 与 PyTorch 里也**没有**按 M 代次分支的逻辑。
 *   真正影响该怎么调的是**统一内存容量**（8 GB 的 M1 与 128 GB 的 M4 Max 完全两回事），
 *   而那由 MPS 探测出来的工作集大小体现（见 describeOptimization 里的提示），
 *   不是芯片型号本身。⇒ 与其编一套"按代次调参"的假优化，不如把型号显示出来让用户确认探测正确。
 *
 * `m\d` 覆盖 M1–M9：**M5 及之后的新代次无需改代码即可识别**。
 * 认不出返回 ''（不猜）。
 */
function appleChipOf(text) {
  const s = String(text ?? '')
  const m = /apple\s+(m\d(?:\s+(?:pro|max|ultra))?)/i.exec(s)
    ?? /\b(m\d\s*(?:pro|max|ultra))\b/i.exec(s)
  return m ? m[1].replace(/\s+/gu, ' ').trim() : ''
}

/**
 * 识别用户机器的 GPU 厂商。
 *
 * 探测顺序（**先权威、后兜底**）：
 *   ① ComfyUI `/system_stats` 的 `devices[0].name` —— 这是**实际用来算图的那张卡**，最准；
 *   ② 没在跑就查 Windows WMI 的 `Win32_VideoController`（会列出所有显卡）。
 * 两条路都拿不到 → 返回 unknown，**不加任何参数**（绝不猜）。
 */
/** GPU 判定结果缓存（显卡不会中途换，没必要每次启动 ComfyUI 都重查）。 */

// ===== moved from index.js: GPU_CACHE (was lines 654-667) =====
let GPU_CACHE = null

/**
 * ★★★ 2026-10-11 新增：**N 卡 SageAttention 的就绪状态**（`null` = 还不知道）。
 *
 * ## 为什么要有这个缓存
 *   `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，
 *   ComfyUI 会**直接起不来**。所以"挂不挂"必须先确认"装没装"。
 *   而确认要起一次 Python 去 `import sageattention`（冷启动可能好几秒）——
 *   那是**每次启动 ComfyUI 都要付**的成本，绝不能放在启动关键路径上。
 *   ⇒ 由**后台**的加速环境自检（见 `autoSetupAcceleration`）顺手记下来，启动时直接读。
 *
 * 三态：`null` 未知（本次不加，保守）/ `true` 已装 / `false` 确认没装。
 */

// ===== moved from index.js: SAGE_READY (was lines 668-677) =====
let SAGE_READY = null

/**
 * ★ 2026-10-11：NVIDIA **代系**识别 —— 只用于**提示**，不改默认启动路径。
 *
 * 为什么要分：50 系（Blackwell / sm_120）比 40 系（Ada）新，
 * 老版本的 Triton / SageAttention 构建**不认 sm_120**，硬挂会报错。
 * 所以 50 系上要把"需要支持 Blackwell 的构建"这件事**明确写出来**，
 * 而不是让用户撞一次错才知道。
 */

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

  // ★★★ 2026-10-12 新增：**macOS 上 `/system_stats` 给的名字不够用，要再探一次**。
  //
  //   实测依据（ComfyUI 源码 `server.py` + `model_management.py`）：
  //     `get_torch_device_name()` 对**非 CUDA / XPU** 设备只返回 `device.type`，
  //     所以 Mac 上报的是 **"mps"** 这一个词 —— 里面**没有芯片型号**。
  //   照它判会得到 `mac_mps`（型号未识别），能走对路径但**面板说不清是哪台机器**；
  //   而如果 system_profiler 还能用，就能拿到 "Apple M3 Pro" / "AMD Radeon Pro 5500M"。
  //   ⇒ 在 macOS 上：**只有当 ComfyUI 给的名字认不出具体机型时**，才补跑一次平台探测，
  //     把两份文本合并后再判。**只在 macOS 且名字无信息时探**，不增加其它平台的成本，
  //     也不会在"ComfyUI 已经给了权威答案"时多此一举。
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

  // ★ 2026-10-09：补上**显存总量** —— 启动参数里的「驻留档位」要靠它决定。
  //   来源优先级（按可靠性，本机实测结论）：
  //     ① ComfyUI /system_stats            → 运行时真实值（未启动时拿不到）
  //     ② PyTorch total_memory             → ✅ 最准，且不需要 ComfyUI 运行
  //     ③ Windows WMI AdapterRAM           → ⚠ 本机报 4.0 GB（实际 19.98 GB，32 位截断）
  //   都拿不到 → 留 0，调用方见到 0 会**选择不加驻留参数**，绝不瞎猜。
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

  // ★ PyTorch 兜底：用 ComfyUI 自己的 python 跑一句取总显存。
  //   它不加载模型、不占显存，只读设备属性 —— 实测 19.98 GB，比 WMI 可靠得多。
  //   ★★ 2026-10-09 修正（**真 bug，会让整个驻留方案静默失效**）：
  //     我原先写的是 `findComfyPython?.()` —— **这个函数根本不存在**。
  //     全文只有 `discoverComfyPaths`（真正的路径解析器，见 821 行）。
  //     因为用了可选链 `?.`，不存在的函数会**静默返回 undefined**，
  //     于是 ② 这一层**永远不会执行**，一路落到被守卫拦掉的 WMI 层，
  //     最终 vramGB 恒为 0 ⇒ VRAM_ARGS 永远返回空数组 ⇒ `--highvram` 永不生效。
  //     表现就是"改了半天，30~40 秒还是没到"。教训：可选链是好的，
  //     但它会把"函数名写错"这种硬错误伪装成"运行时没数据"，务必回查调用点。
  if (!profile.vramGB) {
    const found = await discoverComfyPaths(cfg, log)
    const py = found?.py
    if (py) {
      try {
        // ★★ 2026-10-09 第二次修正：PowerShell 里调用**带引号的 exe** 必须加 `&`
        //   调用运算符。`"C:\path\python.exe" -c "..."` 在 PowerShell 里是**语法错误**
        //   （ParserError: UnexpectedToken），实测 stdout 为空、命令直接抛错。
        //   这不止影响本处 —— 凡是用 runShell 拼 `"路径" 参数` 的地方在 Windows 上都是坏的。
        //   加 `&` 后实测拿到 21458059264（19.98 GB）。
        // ★★★ 2026-10-11 修 bug（**Linux / macOS 上真失效**）：
        //   下面这行原来**没有平台闸** —— `&` 是 PowerShell 的**调用运算符**，
        //   但在 POSIX 的 `sh -c` 里它是**后台运算符** ⇒ 整条命令语法错、被 catch 吞掉
        //   ⇒ Linux 上 `vramGB` 恒为 0 ⇒ 驻留参数（--highvram 等）**永不生效**。
        //   ⚠ `probeAccelPack` 里踩过一模一样的坑并修好了，这一处漏了。
        //   ⇒ 现在按平台分叉：Windows 用 `& "exe"`，其余用 POSIX 单引号引用。
        const shq = (s) => `'${String(s).replace(/'/gu, "'\\''")}'`
        // ★ macOS：没有 CUDA，改用 PyTorch 的 MPS 建议工作集（见常量处的说明）
        const pyProbe = IS_MAC ? GPU_VRAM_PROBE_PY_MAC : GPU_VRAM_PROBE_PY
        const cmd = IS_WINDOWS
          ? `& "${py}" -c "${pyProbe}"`
          : `${shq(py)} -c ${shq(pyProbe)}`
        const out = String(await runShell(cmd, 30000))
        // ★ 解析要**挑出纯数字行**，不能盲取最后一行：
        //   ROCm 启动时会往 stdout 吐 `[WARNING] offload-arch failed...` / `[stderr]`，
        //   实测输出形如：
        //       [WARNING] offload-arch failed with return code 1
        //       [stderr]
        //       21458059264
        //   取最后一行虽然这次恰好对，但换台机器/换版本就可能失灵。
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

  GPU_CACHE = { at: Date.now(), profile }
  if (log) {
    log('info', `GPU 判定：${profile.label}｜探测到「${detected || '未知'}」（来源：${source || '无'}）`)
    log('info', `该厂商专用调优：${profile.tuning}`)
    if (profile.vramGB) log('info', `显存总量：${profile.vramGB} GB（来源：${profile.vramSource}）`)
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
  // ★ AMD 一支**刻意留空**（主人 2026-10-09 明确要求）：
  //   A 卡用户沿用既定优化方案 —— 通用链（turbo8 + 前缀缓存 + 跳步缓存）+ quad，
  //   本机已验证，**不额外引入第三方内核**。唯一例外是 RDNA4（9000 系），
  //   它在**启动参数**上换用 PyTorch 的 CK SDPA 内核（见 GPU_PROFILES.amd_rdna4），
  //   同样不需要下载任何东西。
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
   * ★ 2026-10-09 新增（按主人要求补充 N 卡方案，保守起见只收社区公认、来源明确的）。
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
    /**
     * ★★ 2026-10-09 实测修正：这个包**不在 PyPI 上**！
     *   裸跑 `pip install intel-extension-for-pytorch` 会报
     *   "No matching distribution found" —— 我一开始就是这么写的，是个真 bug。
     *   它挂在 Intel 自己的扩展索引下（已实测该索引有 2.8.10+xpu / 2.7.10+xpu 等版本），
     *   安装时必须带上 `--extra-index-url` —— 该索引地址配在 `ACCEL_SOURCES.ipex` 里。
     */
    requires: 'Intel Arc / XPU + 对应版本 PyTorch（包版本带 +xpu 后缀）',
    why: 'XPU 后端支持与算子优化。⚠ 版本号必须与已装 PyTorch 对齐，否则装不上。',
    verified: false,
  },
}

/**
 * ★★ 2026-10-09：加速包按**操作系统**过滤（方案表的 `os` 字段）。
 *
 * 为什么必须分两套：同一个能力在不同系统上**装法不同**。
 *   · **Triton** —— Windows 必须装第三方构建（`triton-windows`，官方长期没有 Windows 轮子），
 *     Linux 则装官方包。**装错了会顶掉正确的那个**，所以两个条目互为平台独占。
 *   · 将来若出现仅 Windows 可用的预编译内核（`.pyd`），也要靠这个字段把 Linux 挡在外面。
 *
 * 缺省（不写 `os`）视为全平台适用。
 */

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

/**
 * 执行**一套**下载方案：pip 走 `-m pip install`，custom_node 走 `git clone`。
 *
 * ★ `--timeout 15 --retries 1` 是刻意的：让"连不上"**快速失败**并切下一套源，
 *   而不是卡在 pip 默认的长重试里（默认能拖好几分钟，观感就是"卡死"）。
 *
 * ★ 引号转义**必须按平台选**：PowerShell 用 `''` 转义单引号，POSIX sh 用 `'\''`。
 *   早先这里不分平台统一用了 sh 风格，Windows 上参数一旦含单引号就会被解析错。
 */

// ===== moved from index.js: genericOptimizations (was lines 1131-1175) =====
function shouldProbe(args) {
  return typeof args?.reference === 'string' && args.reference.trim() !== ''
    ? false
    : true
}

/**
 * ★★ 2026-10-08 新增：把 draw_image 的参数折算成「本次要提交的工作流」。
 *
 * 纯函数（不联网、不开 ComfyUI），自测靠它断言工作流长什么样。
 * ⚠ 这里**必须**与 execute 里的折算保持一致 —— 两处不一致就会"测试绿、实际错"。
 */

// ===== moved from index.js: planWorkflow (was lines 2434-2521) =====
/**
 * ★★★ 2026-10-12（预设工作流）：把"显式 size / preset / 默认 1:1"的优先级算清楚。
 *   ① 用户显式传了 size（且在 ASPECTS 里）→ 用它；
 *   ② 否则看 preset（工具参数或运行时 cfg.preset）→ 映射成画幅；
 *   ③ 都没有 → 1:1。
 * ⚠ megapixels 不在这里处理：用户显式传的 megapixels 永远优先，没传才回落默认 1.0，
 *   预设**不覆盖** megapixels（见 preset 参数说明）。
 */
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
  return buildWorkflow(cfg, {
    prompt: String(args?.prompt ?? ''),
    negative: args?.negative,
    width,
    height,
    steps,
    seed,
    reference: refPath,
    count,
  }, caps)
}

/**
 * 组装千问工作流。
 *
 * · 不给 `reference` → **文生图**（照 app.py build_workflow 的无参考图分支）
 * · 给了 `reference` → **图生图**（照 `scripts/_img2img.mjs`，那份在本机验证过）
 *
 * ★ 图生图有四个要点，一个都不能少：
 *   ① 加一个 `LoadImage` 节点读参考图
 *   ② `TextEncodeQwenImage21` **必须拿到 `vae`** —— 不给 vae 它就不会编码参考图
 *   ③ 参考图走 `images.image_1`（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的**第 2 号输出**（positive=0 / negative=1 / latent=2），
 *      并且**删掉 `EmptyLatentImage`** —— 所以图生图的 `resolution` 要用 sqrt(W*H)，
 *      它**直接决定输出尺寸**（文生图那边则由 EmptyLatentImage 决定，所以用固定值即可）
 *
 * ★★★ 2026-10-08 重大改动：**Turbo8 八步 + TE-Speed 变成默认链路**。
 *   （主人原话：「你把这个改成默认设置吧。开到最大。就是 turbo8 加 TE 八步」）
 *
 *   模型链（1 → 11 → 12 → 7 → 13 → KSampler）：
 *
 *     UNETLoader ──► LoraLoaderModelOnly(turbo8, 1.0)     ← 八步蒸馏 LoRA
 *                ──► ModelSamplingFlux(0.6935, 0.5)       ← turbo8 官方要求的采样位移
 *                ──► QwenImage21Cache(auto, int8)         ← 官方前缀 KV 缓存（int8 折半，几乎无损）
 *                ──► TESpeedQwenImage21(...)              ← 跳步缓存
 *                ──► KSampler(steps=8, cfg=1.0, euler, simple)
 *
 *   本机实测（RX 7900 XT / ComfyUI 0.39.0，都是 1024 档、每遍换 seed 的稳态值）：
 *     基线 30 步 CFG2.5            ── 91.6 s   （原默认）
 *     turbo8 八步（无缓存）        ── 12.6 s   （−86%）
 *     turbo8 八步 + TE-Speed       ──  9.7 s   （**−89%**）  ← 现在的默认
 *
 *   ⚠ 关于「TE 在这一档里到底做了多少」——查证过，别被老数字误导：
 *     · TE 的**整层跳过**（日志里的 `eligible`）在 8 步下是 **0 次**：8 步的 t 序列是
 *       1.000/0.933/0.857/0.769/0.667/0.546/0.400/0.222，而节点内置窗口硬性要求
 *       t<=0.82，前 3 步直接出局；剩下 5 步的 change 又都 > 0.06 阈值。
 *     · 但它**仍然有效**：每次 call 都会复用一部分 KV/attention（算子级省时），
 *       实测稳态 12.6 s → 9.7 s，**−23%**。
 *     · 早先报过的「−43%」是**测量失真**（撞上了 ComfyUI 对相同 prompt 的直接缓存）。
 *       ★ 教训：任何"快了多少"的对比，**每遍都必须换 seed**。
 *
 *   为什么是 8 步而不是 16 步：turbo8 就是**为 8 步训练的**（发布页写明 8 步 / CFG 1 /
 *   euler + simple）；16 步只会更慢而不会更准。
 *
 *   ⚠ 三条硬约束，别随手改掉：
 *     ① `ModelSamplingFlux` 的 width/height 必须是**字面量**。图生图那一支没有
 *        `EmptyLatentImage`（latent 从 TextEncode 的第 2 号输出拿），一旦写成节点连线，
 *        图生图会**直接引用到不存在的节点**。所以这里固定传 `width`/`height` 数字。
 *     ② `ModelSamplingFlux` 的宽度默认 **1024**，而 ModelSamplingFlux 的 max_shift 是按
 *        像素面积算的 —— 尺寸一变位移量就跟着变（实测 992² 与 1024² 出图不同）。
 *        要换默认尺寸，请把 `DEFAULTS.turbo8RefWidth/Height` 一起改。
 *     ③ `TESpeedQwenImage21` 是**插件节点**，装不上时 ComfyUI 会以
 *        "node type not found" 当场拒收整个任务（不会静默降级）。
 *
 * @param reference ComfyUI 里的参考图文件名（已经上传过去的）；空 = 文生图
 */
/**
 * ★ prompt 精简（2026-10-09 新增，依据见 DEFAULTS 里 `promptTrimEnabled` 的注释）。
 *
 * 只做**不改变语义**的清理：
 *   ① 折叠所有空白（换行/tab/多空格）为单空格并去首尾
 *   ② 合并连续重复的分隔标点（",,,,," → ","）
 *   ③ 去掉末尾悬挂的分隔符
 * 再按 `cfg.maxPromptChars` 可选硬截断（默认 0 = 不截断）。
 *
 * ⚠ 刻意**不做**：删除形容词 / 同义词替换 / 按 token 数截断 —— 那些都会改图，
 *   而实测收益上限只有 4.8%（还得是 2000 字的超长 prompt），不值得。
 */

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

/**
 * ★★★★ 2026-10-09：决定这次出图用**哪一组**互斥的 diffusion wrapper。
 *
 * ## 为什么需要它
 *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
 *   同时挂会抛 `ValueError: ... requires exclusive diffusion-wrapper ownership`。
 *   所以必须**三选一**，而"选哪个"取决于尺寸（实测，见 DEFAULTS 里 wrapperPolicy 的注释）。
 *
 * ## 实测依据（都是这台机器上跑出来的，不是估的）
 *   ┌ 场景          ┌ 方案              ┌ 效果
 *   │ 小尺寸/常驻   │ TE-Speed+Speedup  │ +25.4%（11.581 → 8.639 s，纯采样）
 *   │ 大尺寸/换页   │ TE-Speed          │ **0%**（日志：predicted 0/8 steps）
 *   │ 大尺寸/换页   │ Speedup           │ 12.5%（1/8 cached）
 *   │ 大尺寸（120s）│ BlockCache T8     │ **+22.7%**（120.75 → 93.34 s，省 27.4 s）
 *
 *   ⇒ 小尺寸用 TE+Speedup，大尺寸用 BlockCache T8。
 *
 * @returns {{te:boolean, speedup:boolean, blockCache:boolean, reason:string, tokens:number}}
 *   三个布尔**最多只有一个为 true**（互斥是硬约束，由这里的写法保证）。
 */

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
  const teAvailable = has('teSpeed') && cfg.teSpeedEnabled !== false && plan.useTurbo === true
  const speedupAvailable = has('speedup') && cfg.speedupEnabled !== false && plan.useTurbo === true

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


// ===== moved from index.js: buildWorkflow (was lines 2594-2906) =====
function buildWorkflow(cfg, { prompt, negative, width, height, steps, seed, reference, count, controlImage }, caps) {
  const withRef = typeof reference === 'string' && reference !== ''
  // ★ 2026-10-10（提速 M4）：一次出几张。**默认 1**（守住"每次只生一张"的既定要求），
  //   只有调用方显式传 count 2-4 时才批量。批量只在**文生图**生效（EmptyLatentImage.batch_size）——
  //   图生图的 latent 来自参考图，批量需要另加 RepeatLatentBatch，本次不做，按 1 张处理。
  const batchCount = Number.isFinite(count) ? Math.max(1, Math.min(4, Math.trunc(count))) : 1
  // ★ 2026-10-09（通用化）：按**探测到的真实能力**折算本次链路。
  //   caps 不传 = 当作能力齐全 → 保持"默认全栈"的老行为（自测直接调本函数即此情形）。
  const plan = resolvePlan(cfg, caps)

  // ★ 尺寸锁（2026-10-09）：默认把**文生图**尺寸钉死在优化档，调用方传进来的
  //   size / megapixels / width / height 全部回落到它（默认 = resolution = 1024²），
  //   —— 防止重蹈"1328² + 慢步数"的慢路径。图生图由参考图定尺寸，不锁。
  //   设 cfg.forceOptimizedSize = false 可恢复"听调用方的尺寸"（仍受 32 对齐约束）。
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

  // ★ 2026-10-09：模型文件名与链路开关**全部来自 plan**（探测结果），不再写死。
  const turboLora = plan.models.turbo8Lora
  const withTurbo = plan.useTurbo
  const withPrefix = plan.usePrefix

  // ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按本次出图尺寸动态选**。
  //
  //   plan 里的 useTe / useSpeedup / useBlockCache 是**配置级**的静态决定，
  //   它不知道这次要画多大 —— 而实测恰恰证明"该用哪一套"正是**由尺寸决定**的：
  //     · 992×992（15376 tokens）：模型能常驻 → TE+Speedup 实测 +25.4%
  //     · 1408×1408（30976 tokens）：显存换页 → TE 实测 **0%**、Speedup 12.5%，
  //       而 BlockCache T8 在大尺寸实测 **+22.7%**（省 27.4 s）
  //   ⇒ 同一套配置硬扛所有尺寸，必然有一档是错的。所以在这里按尺寸二次决策。
  //
  //   ⚠ 三者的互斥关系**不变**（仍争抢同一组 DIFFUSION_MODEL wrapper），
  //     这里只是把"谁上"从静态配置改成按尺寸挑，绝不会两个同时上（那会 ValueError）。
  const wrapperPick = pickWrapperSet(cfg, plan, effWidth, effHeight, caps)
  const withTe = wrapperPick.te
  const withSpeedup = wrapperPick.speedup
  // ★★★ 2026-10-09：BlockCache T8 —— 取代 ToMe 的图生图加速节点
  //
  // ## 为什么它取代了 ToMe（ToMe 已移除，见 DEFAULTS 里的说明）
  //   ToMe 在千问 2.1 上接口不兼容，三条插入点全走不通；而本节点：
  //     · 官方描述明确写着 "preserving Core's reference/text KV cache"
  //       → **原生兼容前缀缓存**（正是 ToMe 卡住的那个点）
  //     · "For editing, start with threshold 0.03" → 图生图推荐起点就是保守值
  //   ✅ 已实测确认：挂上后服务器日志出现 `T8: full=6 cache=2` —— **真的命中**，
  //      不是"看起来在跑其实没生效"。
  //
  // ## ⚠ 与 Speedup 互斥（这点比数字更重要）
  //   BlockCache 要求独占 DIFFUSION_MODEL wrapper（runtime.py:51），而 Speedup
  //   也注册同一组 wrapper → 同时挂会抛 ValueError 整单失败。
  //   处理：**BlockCache 优先，自动让位 Speedup**（见 resolvePlan 里的长注释）。
  //
  // ## 实测耗时（图生图，2 个不同 seed 取平均）
  //   注意：下面的"基线"是**只有 BlockCache / 无 BlockCache** 的对照，
  //   两者都不含 Speedup（因为 Speedup 与 BlockCache 互斥，无法同链对照）。
  //     无 BlockCache      120.75 s
  //     +BlockCache T8      93.34 s   →  快 22.7%（省 27.4 s）
  //   该数字来自独立对照跑（见 memory 2026-10-09），不是端到端全链耗时。
  //   参数即官方默认：threshold=0.03 / start=0.1 / end=0.9 / max_hits=2
  //
  // ## 接在哪
  //   放在模型链**最前面**（紧跟 UNETLoader）—— 它要缓存的是"首块目标残差"，
  //   越靠前拿到的越接近原始 UNET 输出；官方示图也是这个位置。
  // ★ 由 pickWrapperSet 决定（按尺寸），不再只看静态配置
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
  // ★★★ 2026-10-12 新增（用户反馈）：**Spectrum 跳步**（跳过部分 Qwen transformer 前向）。
  //   位置：**模型链最末端**（FA 之后、KSampler 之前）—— 节点 README 的接线图就是
  //   "Load Qwen model → (可选 LoRA/改动) → Spectrum Qwen Model Patcher → KSampler"，
  //   放最后能保证 KSampler 最终拿到的那个 model 一定带着它的 patch。
  //   ⚠ 它与 FA **不冲突**：FA 改的是 `model_options` 里的 attention override，
  //     Spectrum 换的是 transformer 的 forward —— 两套机制，互不覆盖。
  const withSpectrum = plan.useSpectrum === true
  const nodeAfterSpectrum = withSpectrum ? '18' : nodeAfterFa
  // ★★★ 2026-10-12 新增（用户要求）：**SADA 跳步采样** —— 与 Spectrum 同源但走新分布。
  //   位置：模型链最末端（Spectrum 之后、KSampler 之前）。
  //   探测 + 默认关 由 resolvePlan 完成；这里只读 `plan.useSada`。
  const withSada = plan.useSada === true
  const modelRef = withSada ? '19' : nodeAfterSpectrum

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
    11: withTurbo
      ? {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: [nodeAfterUnet, 0],
          lora_name: turboLora,
          strength_model: Number.isFinite(cfg.turbo8Strength) ? cfg.turbo8Strength : 1.0,
        },
      }
      : undefined,
    12: withTurbo
      ? {
        class_type: 'ModelSamplingFlux',
        inputs: {
          model: ['11', 0],
          // ★ 2026-10-12：位移**由 plan 定**（随档位切换：turbo8 = ln2 ≈ 0.6935、
          //   极速档 = ln3 ≈ 1.0986）。写死 cfg.turbo8MaxShift 会让 4 步档用错位移。
          max_shift: plan.maxShift,
          base_shift: plan.baseShift,
          // ★ 必须是字面量：图生图那支没有 EmptyLatentImage 可以连（见函数头 ①）
          width: effWidth,
          height: effHeight,
        },
      }
      : undefined,
    7: withPrefix
      ? {
        class_type: 'QwenImage21Cache',
        inputs: {
          model: [nodeAfterTurbo, 0],
          device: cfg.qwenCacheDevice ?? 'auto',
          // int8：缓存折半、约等于 bf16 精度（官方 tooltip 原话）；int4 每步误差翻倍，不用。
          dtype: cfg.qwenCacheDtype ?? 'int8',
        },
      }
      : undefined,
    13: withTe
      ? {
        class_type: 'TESpeedQwenImage21',
        inputs: {
          model: [nodeAfterCache, 0],
          attention: cfg.teSpeedAttention ?? 'kitchen_int8',
          // te_predictor：每跳最多 1 步连续跳过 —— 比 'speed'（2 步）稳
          step_cache: cfg.teSpeedStepCache ?? 'te_predictor',
          reuse_threshold: Number.isFinite(cfg.teSpeedThreshold) ? cfg.teSpeedThreshold : 0.06,
          start_percent: Number.isFinite(cfg.teSpeedStartPercent) ? cfg.teSpeedStartPercent : 0.0,
          end_percent: Number.isFinite(cfg.teSpeedEndPercent) ? cfg.teSpeedEndPercent : 1.0,
          predictor_error_limit: Number.isFinite(cfg.teSpeedErrorLimit) ? cfg.teSpeedErrorLimit : 0.08,
          verbose: cfg.teSpeedVerbose === true,
        },
      }
      : undefined,

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
    10: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'dsh-qwen-paint' } },

    // ---- 2026-10-09 实测新增：QwenImage21Speedup（与 TE-Speed 实测可叠）----
    //   它接在模型链最末端（TE 之后、KSampler 之前），挂在 DIFFUSION_MODEL /
    //   OUTER_SAMPLE wrapper 上做整步残差缓存。
    //   实测：TE 10.741s → TE+Speedup 9.709s；再叠 quad → 8.278s。
    //   ⚠ 它是插件节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withSpeedup 开关控制，且下面要把未启用的节点删掉。
    14: withSpeedup
      ? {
        class_type: 'QwenImage21Speedup',
        inputs: {
          model: [nodeAfterTe, 0],
          enable_cache: true,
          cache_threshold: Number.isFinite(cfg.speedupCacheThreshold) ? cfg.speedupCacheThreshold : 0.30,
          target_error: Number.isFinite(cfg.speedupTargetError) ? cfg.speedupTargetError : 0.05,
          cache_start_percent: Number.isFinite(cfg.speedupStartPercent) ? cfg.speedupStartPercent : 0.15,
          cache_end_percent: Number.isFinite(cfg.speedupEndPercent) ? cfg.speedupEndPercent : 0.90,
          max_consecutive_skips: Number.isFinite(cfg.speedupMaxConsecutiveSkips) ? Math.trunc(cfg.speedupMaxConsecutiveSkips) : 3,
          forecast: cfg.speedupForecast ?? 'first',
          cache_device: cfg.speedupCacheDevice ?? 'auto',
          debug_log: cfg.speedupDebugLog === true,
        },
      }
      : undefined,

    // ---- 2026-10-09 实测新增：BlockCache T8（本机图生图实测 +22.7%）------
    //   参数全部走官方对 editing 的推荐值，不自己调激进口径。
    //   ⚠ 它是插件节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withBlockCache 开关控制（由 resolvePlan 按探测结果决定）。
    16: withBlockCache
      ? {
        class_type: 'QwenImage21BlockCacheT8',
        inputs: {
          model: [nodeAfterUnet0, 0],
          // 官方：图生图（editing）从这个值起步。调大→更快但可能改姿态/细节。
          residual_diff_threshold: Number.isFinite(cfg.blockCacheThreshold) ? cfg.blockCacheThreshold : 0.03,
          start_percent: Number.isFinite(cfg.blockCacheStartPercent) ? cfg.blockCacheStartPercent : 0.1,
          end_percent: Number.isFinite(cfg.blockCacheEndPercent) ? cfg.blockCacheEndPercent : 0.9,
          max_consecutive_hits: Number.isFinite(cfg.blockCacheMaxHits) ? Math.trunc(cfg.blockCacheMaxHits) : 2,
          cache_device: cfg.blockCacheDevice ?? 'cpu',
          metric_stride: Number.isFinite(cfg.blockCacheMetricStride) ? Math.trunc(cfg.blockCacheMetricStride) : 8,
          max_cache_mb: Number.isFinite(cfg.blockCacheMaxMb) ? Math.trunc(cfg.blockCacheMaxMb) : 1024,
          threshold_mode: cfg.blockCacheThresholdMode ?? 'two_stage',
          split_ratio: Number.isFinite(cfg.blockCacheSplitRatio) ? cfg.blockCacheSplitRatio : 0.35,
          late_threshold: Number.isFinite(cfg.blockCacheLateThreshold) ? cfg.blockCacheLateThreshold : 0.15,
        },
      }
      : undefined,

    // ---- 2026-10-10 实测新增：RDNA3 FlashAttention（无损加速）----
    //   精确注意力（memory-efficient 等价实现），不改数学；节点自带"不支持就回退"。
    //   只认 gfx1100 + ROCm PyTorch ≥2.8（本机都满足）。放在模型链最末端。
    //   ⚠ 它是插件节点：没装时整单会被拒收，所以必须用 withRdna3Fa 开关控制。
    17: withRdna3Fa
      ? {
        class_type: 'ApplyRDNA3FlashAttention',
        inputs: {
          model: [nodeAfterSpeedup, 0],
        },
      }
      : undefined,

    // ---- 2026-10-12 新增（用户反馈）：Spectrum 跳步（跳过冗余 Qwen 前向）----
    //   参数默认取它 README 的 "Recommended starting settings → Conservative"，
    //   但**全部可由配置覆盖** —— 因为本插件的 turbo8 链只有 **8 步**，
    //   而它的默认 `warmup_steps=5 + tail_actual_steps=2` 会吃掉 7 步，
    //   只剩 1 步可跳 ⇒ 想看出收益就得把 warmup/tail 调小（画质风险随之上升）。
    //   ⇒ 这也是它**默认关**的原因之一（详见 DEFAULTS.spectrumEnabled）。
    //   ⚠ 它是第三方节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withSpectrum 开关控制（由 resolvePlan 按探测结果决定）。
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

    // ---- 2026-10-12 新增（用户要求）：SADA 跳步采样（ICML 2025 论文实现）----
    //   与 Spectrum 思路同源（跳过部分 transformer 前向），但走**新采样分布**。
    //   ⚠ 输入映射**是**基于论文 + comfyui-sada-icml 仓库 README 的**先验**；
    //     本机未装该节点（`custom_nodes/` 无 sada 痕迹）⇒ 未做真机 A/B。
    //     真装上后若输入名不一致，由 `sadaNodeClass` / `sadaMaxSteps` / `sadaThreshold`
    //     这几个 DEFAULT 微调（不用动插件代码）。
    //   ⚠ 节点必须存在 + withSada=true 才接进去；否则整段被统一 delete（见下面循环）。
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
  }

  // `7` / `11` / `12` / `13` / `14` / `16` / `17` / `18` / `19` 在关闭时都是 undefined —— 统一删掉，
  // 否则 ComfyUI 会把它当成一个"没有 class_type 的节点"直接报校验错（而不是忽略它）。
  for (const id of [7, 11, 12, 13, 14, 16, 17, 18, 19]) {
    if (workflow[id] === undefined) delete workflow[id]
  }

  if (withRef) {
    // 图生图：参考图进来，latent 由编码节点给，不要空 latent
    workflow[4] = { class_type: 'LoadImage', inputs: { image: reference } }
    workflow[5].inputs.vae = ['3', 0]
    workflow[5].inputs['images.image_1'] = ['4', 0]
  } else {
    // ★ 提速 M4：batch_size = batchCount（默认 1）。一次提交出 N 张只装卸一次模型。
    workflow[6] = { class_type: 'EmptyLatentImage', inputs: { width: effWidth, height: effHeight, batch_size: batchCount } }
  }

  // ---- 采样器 ------------------------------------------------------------------
  // ★ 步数默认 **8**：turbo8 是八步蒸馏模型，这就是它的工作点。
  //   层层回落（先到先用）：
  //     ① 用户显式传了 steps（1..60）→ 用它的         ← 只在 forceTurbo8Steps=false 时
  //     ② cfg.turbo8Steps 是正数     → 用配的那个数    ← 同上
  //     ③ 其余一律 → TURBO8_STEPS = 8                  ← 默认走这条
  //   给别的步数会掉出 LoRA 的训练区间、出图变差，所以默认必须钉死在 8。
  //   ★ 2026-10-09（通用化）：**没有 turbo8 时绝不能再钉 8 步** ——
  //     8 步是 turbo8 蒸馏 LoRA 的工作点，缺了 LoRA 还跑 8 步只会得到一张糊图。
  //     此时改用 plan.steps（默认 25），并允许调用方显式传 steps 覆盖。
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

  workflow[8] = {
    class_type: 'KSampler',
    inputs: {
      // ★ 模型链末端：14(Speedup) → 13(TE) → 7(前缀缓存)，按开关逐级回落
      model: [modelRef, 0],
      seed,
      steps: Math.max(1, Math.min(60, effSteps)),
      // ★ CFG：有 turbo8 时必须 1.0（八步蒸馏 LoRA 在 >1 的 CFG 下会过曝/崩边，
      //   也是 TE-Speed 作者 2026-10-07 那版专门去修的问题）；
      //   没有 turbo8 时用千问原生工作点 2.5。
      cfg: plan.cfgScale,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['5', 0],
      negative: ['5', 1],
      latent_image: withRef ? ['5', 2] : ['6', 0],
      denoise: 1.0,
    },
  }

  // ★★★ 2026-10-14（C4「专业卡版」）：**通用 ControlNet**（Pose / Canny / Depth / Union）。
  //
  // ## 接线
  //   `20 LoadImage`（控制图） + `21 ControlNetLoader`（权重） + `22 ControlNetApplyAdvanced`
  //     22.positive ← 5.0 ／ 22.negative ← 5.1 ／ 22.control_net ← 21.0 ／ 22.image ← 20.0
  //     KSampler.positive ← 22.0 ／ KSampler.negative ← 22.1
  //   ⚠ 这是 ComfyUI **核心节点**的标准接法；权重来自 `models/controlnet`。
  //
  // ## 三个条件缺一不可（否则**不接**，并如实说明原因）
  //   ① 探测到 `ControlNetLoader` 与 `ControlNetApplyAdvanced` 两个节点；
  //   ② 面板里**选中了** ControlNet 权重（空 = 没选）；
  //   ③ 本次**真的传了控制图**。
  //   ⇒ 只选权重、不给控制图时**不会**接进工作流（避免"面板开了、实际没生效"的假象）。
  //
  // ## ⚠ 与"局部重绘"完全独立
  //   局部重绘走的是另一套（`ControlNetInpaintingAliMamaApply` + 独立工具），两者互不影响。
  //
  // ## ⚠ 未实测
  //   本机（AMD RX 7900 XT 20 GB）**没有验证过**这条链的真机出图效果 ——
  //   节点与接线是 ComfyUI 标准做法，但**真机请你自己验**。
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
  // ⚠ 与 `__effective` 同样用**不可枚举**属性 —— 否则它会被当成一个"没有 class_type 的节点"
  //   混进提交给 ComfyUI 的载荷里（ComfyUI 只认数字键，但别赌）。
  Object.defineProperty(workflow, '__cnet', {
    value: Object.freeze({ applied: withCnet, name: cnetName, reason: cnetReason }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  // ★★★ 2026-10-09 **把"生效尺寸"随 workflow 一起交出去**（修一个真 bug）。
  //
  //   ## 之前的 bug
  //     `forceOptimizedSize = true` 时，上面会把尺寸**锁成 `OPT_SIZE`（默认 1024²）**，
  //     但调用方拿到的仍然只有 workflow 本身 —— 于是 `makeDrawTool` 里：
  //       · 尺寸校验用 **请求值** width/height 去比对实际出图尺寸 → **误报**
  //         「ComfyUI 出的图尺寸不对：请求 864x1152，实际 1024x1024」
  //       · 落盘文件名也用请求值 → 文件名标着 864x1152，图其实是 1024x1024
  //     ⇒ **作品已经正常生成了，却被自己拦下来报错**，主人看到的就是"尺寸不对"。
  //
  //   ## 为什么挂在对象上而不是改返回值
  //     这个函数的返回值**直接当 ComfyUI 的 prompt 载荷提交**（`submitPrompt` 里
  //     会 `JSON.stringify` 后 POST）。改返回结构会连带改提交格式。
  //     而 ComfyUI 只认**数字键**（`Object.values(workflow)` 那一批节点），
  //     挂一个符号属性/非数字键**不会进 JSON** —— 零副作用。
  //     这里用 `Object.defineProperty` 定义**不可枚举**属性，确保
  //     `JSON.stringify(workflow)` 与 `Object.keys` 都不受影响。
  Object.defineProperty(workflow, '__effective', {
    value: Object.freeze({ width: effWidth, height: effHeight, locked: !withRef && lockSize }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return workflow
}

/**
 * 把参考图上传给 ComfyUI，返回它在 ComfyUI 那边的文件名。
 *
 * ★ 为什么必须走 `/upload/image` 而不是"自己复制进 input 目录"：
 *   ComfyUI 的 input 目录**未必是配置里以为的那个**（启动时可以用 `--input-directory` 改），
 *   直接复制过去很可能放错地方；`/upload/image` 是**问 ComfyUI 本人要位置**，永远对。
 *   （同样的坑今天刚在 output 目录上踩过一次。）
 *
 * ⚠ 不能复用 `fetchWithTimeout` —— 它写死了 `Content-Type: application/json`，
 *   而这里要发 multipart。所以自己发一次。
 */

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

/**
 * ★★★ 2026-10-12（用户要求「分块放大 / 局部重绘」）：探测"辅助引擎"在不在。
 *
 * ## 为什么单独探测
 *   主模型（千问 2.1）走的是 `resolvePlan` 那套通用能力探测；但放大（VOSR2 / RealESRGAN）
 *   和局部重绘所需的那几个节点是**独立于主链路**的，
 *   主探测不覆盖它们。本函数专门问 ComfyUI 本人：这些节点装没装、对应权重文件在不在。
 *
 * ★ 2026-10-19：局部重绘改为**零下载潜空间重绘**，inpaint 一项不再看 ControlNet 权重
 *   （旧实现要 InstantX Inpainting ControlNet，那份权重是给 1.0 的、与 2.1 底模不兼容）。
 *
 * ## 返回结构（全部基于 `/object_info` 真实返回，不猜文件名）
 *   {
 *     vosr2:      { node: bool, models: string[] }   // VOSR2ModelLoader 节点 + models/vosr2 下的包名
 *     realesrgan: { node: bool, models: string[] }   // UpscaleModelLoader 节点 + models/upscale_models 下 .pth
 *     inpaint:    { encodeNode, noiseMaskNode, maskLoadNode, growNode, featherNode } // 前三个必需、后两个可选
 *   }
 *
 * ⚠ 全失败 = 返回全 false 的结构（与 probeCapabilities 同一思路：不抛错、不拖垮调用方）。
 *   结果按地址缓存 60 秒（节点/权重不会频繁变动，但状态端点每 5 秒轮询，避免每次 4 个请求）。
 */
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
    // ★★★ 2026-10-12 修 bug：与 makeAccelTool 同因 —— DSH 的 `tools.register()` 强校验
    //   `output`（必须同时有 schema 与 render），否则整条工具注册被拒。
    //   宽松 schema 的理由同上：返回的 `models` 是"类别 → 文件名数组"的动态结构。
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

/**
 * ★★★ 2026-10-09 新增工具：检查 / 配置本机加速环境。
 *
 * 回答"我这台机器用的是哪套优化、还差什么"。
 * · `action=status`（默认）：**纯只读**，不发任何下载。
 * · `action=install`：安装白名单内的加速包，且受 `accelAutoInstall` 约束。
 *
 * ⚠ 为什么安装要单独一个显式动作、而不是"出图时顺手装上"：
 *   下载并执行第三方代码是**用户环境的实质性改动**，不该藏在绘图流程背后发生。
 *   `action=install` 就是**手动**触发这个动作的入口。
 *
 * ★★★ 2026-10-16 修正（审核在 Issue #1390 指出"注释与实现不一致"）：
 *   **实际默认是 `accelAutoInstall: true`** —— 也就是插件加载后**会自动**检测并安装
 *   白名单内的加速包（见 `lib/index.js` 里 `if (cfg.accelAutoInstall === true)`）。
 *   本段原先写的是"默认 `accelAutoInstall: false`，让'装不装'由人决定"，
 *   **与实现相反**，属实的披露不一致，已改正。
 *   若你希望回到"只报告、不自动下载"的行为，请**显式**设置 `accelAutoInstall: false`。
 */

// ===== moved from index.js: MODEL_HINTS (was lines 3294-3357) =====
const MODEL_HINTS = {
  unet: [
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*int8/iu, 100],
    [/qwen[_\-.]?image[_\-.]?2[._]?1.*fp8/iu, 95],
    [/qwen[_\-.]?image[_\-.]?2[._]?1/iu, 90],
    [/qwen.*image/iu, 70],
  ],
  /**
   * GGUF 主模型的"从已装文件里挑最优"排序 —— **仅此而已**。
   *
   * ⚠⚠ 2026-10-12：**插件不再自动下载/推荐任何 GGUF**（原"轻量档"已撤，
   *   原因见 MODEL_TIERS 处的说明：unsloth 那个仓库是 sd.cpp 格式，不再自动下载）。
   *   这里保留只是为了：用户**自己**装了 ComfyUI 能用的 GGUF 之后，
   *   插件探测到就按文件名质量挑一个，别去用排序更差的。
   *   Q4_K_M > Q4_0 > Q5_K_M > Q6_K > Q8_0 > 其余 Qwen GGUF。
   */
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
}

/* ------------------------------------------------- 模型档位（小显存适配）---- */

/**
 * ★★★ 2026-10-11 新增：**模型档位** —— 让 8GB 这类小显存卡也能跑起来。
 *
 * ## 为什么需要
 * 默认主模型是 `qwen_image_2.1_int8_convrot.safetensors`（int8，20B 级）。
 * 在 ≥16GB 的卡上是首选；但在 **8GB（如 RTX 5060）** 上装不进显存，只能靠
 * ComfyUI 反复换页 —— 慢到不可用。社区通行做法是换 **GGUF 量化档**，
 * 用 `ComfyUI-GGUF`（city96）的 `UnetLoaderGGUF` 节点加载。
 *
 * ## 两个档位
 *   · `full`（默认）—— 原生 `UNETLoader` + int8 safetensors。**与旧版行为完全一致**。
 *   · `lite`         —— `UnetLoaderGGUF` + GGUF（Q4_K_M 优先，见 MODEL_HINTS.unetGguf）。
 *
 * ⚠ **本表只描述"档位长什么样"，不做任何下载决策** ——
 *   下什么模型由 `scripts/setup.mjs` 的档位选择（安装时那个二选一弹窗）决定。
 *   运行期只做一件事：**看 `cfg.unet` 的后缀**决定用哪个加载器（见 `unetLoaderFor`），
 *   于是"用户下载时选了什么"就自动决定了"运行时怎么加载"，不需要再多一个开关。
 */

// ===== moved from index.js: UNET_LOADER_NATIVE (was lines 3358-3359) =====
const UNET_LOADER_NATIVE = 'UNETLoader'
/** ComfyUI-GGUF（city96）的节点类名 —— 输入**只有** `unet_name`，没有 weight_dtype。 */

// ===== moved from index.js: UNET_LOADER_GGUF (was lines 3360-3381) =====
const UNET_LOADER_GGUF = 'UnetLoaderGGUF'

/**
 * ★★★ 2026-10-12 新增：**Spectrum 跳步节点**的类名（第三方：ComfyUI-Spectrum-Qwen-Proper）。
 *
 * 它做的事：在**真实的** Qwen 前向步上抓取 `norm_out` 之前的隐状态，
 * 用岭正则化的切比雪夫拟合去**预测**后续步的隐状态，从而**跳过部分昂贵的 transformer 前向**，
 * 只跑 `time_text_embed → norm_out → proj_out` 这条轻量尾巴。
 * 与 ICML 2025 的 SADA 是**同一思路**（跳过冗余计算），但**是 Qwen 专用的**。
 *
 * ⚠ 必须如实告知的三条边界（取自它自己的 README，不是我的推断）：
 *   ① *"This is not a paper-exact universal Qwen port"* —— 不是论文级通用移植；
 *   ② *"The node does not score image quality for you. You still need to compare results
 *      and tune aggression based on your workflow."* —— **它不替你评估画质**，得自己 A/B 比；
 *   ③ `cache_device = cpu` *"trades VRAM for latency"* —— 可能把提速吃掉。
 * ⚠ 它的默认 `warmup_steps=5` + `tail_actual_steps=2` 是给**常规步数**调的；
 *   本插件的 turbo8 链只有 **8 步** ⇒ 默认参数下**只剩 1 步可跳**，收益可能被预测器自身开销吃掉。
 *   ⇒ 所以本插件里它**默认关**，且参数全部可调（见 DEFAULTS.spectrum*），
 *     必须**先实测**再决定要不要开（见 `_spectrum_ab.mjs`）。
 */
const SPECTRUM_NODE = 'QwenSpectrumModelPatcher'

/**
 * ★★★ 2026-10-12（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文
 * "Stochastic Adversarial Diffusion Acceleration"，arXiv 2507.17135）。
 *
 * · 论文实现：`liming123332/comfyui-sada-icml`（第三方）。
 * · 思路：跳过冗余的 Qwen transformer 前向；与 Spectrum 同源但走**新分布**。
 * · 本机**当前未安装该节点**（实测 `custom_nodes/` 目录无 sada 痕迹），
 *   所以**默认关**且插件**不自动下载**（避免版权/GPU 资源的隐式开销）。
 *
 * ⚠ 接入方式（与 Spectrum 保持一致）：
 *   ① 探测阶段 `object_info /SADA*` → `caps.nodes.sada`；
 *   ② resolvePlan 据 `cfg.sadaEnabled` 决定 `useSada`；
 *   ③ buildWorkflow 把节点挂在模型链最末端（KSampler 之前），开关关时整段 delete；
 *   ④ 描述面板单列一项，**默认关 + 已实测基线**，开不开用户说了算。
 *
 * ⚠ 与 Spectrum 一样：节点不存在时 `withSada` 必为 false（**绝不**把不存在的节点
 *   塞进 workflow —— ComfyUI 会直接拒收）。
 */
const SADA_NODE_DEFAULT = 'SADASampler'

/**
 * 主模型**两档**（★ 用户要求保留轻量档）。
 *
 * ⚠⚠ 2026-10-12：**lite 档的自动下载源必须改** —— 原先引的
 * `unsloth/Qwen-Image-2.1-GGUF` 的 `qwen-image-2.1-Q4_K_M.gguf` 是
 * **stable-diffusion.cpp 格式**，ComfyUI-GGUF 的 `UnetLoaderGGUF` 加载不了。
 * 三条证据：
 *   1. 该仓库 ModelScope 页只写 **stable-diffusion.cpp**，没提 ComfyUI-GGUF/city96；
 *   2. ComfyUI-GGUF 官方 README 只列 `city96/FLUX.1-dev-gguf` / `FLUX.1-schnell-gguf`；
 *   3. 用户真下了 4,199,565,024 字节那个文件验过 GGUF 头 ——
 *      **元数据无 `general.architecture`**、张量名 `model.diffusion_model.*`。
 *
 * ⚠ 但 ComfyUI-GGUF 的 `IMG_ARCH_LIST` **确实含 `qwen_image`** ⇒ **节点层面支持**，
 *   缺的只是"ComfyUI 能吃的那份 GGUF 文件"。所以**档位保留**，改为：
 *   · 不再**自动下载**那份错文件（那是 bug，已修）；
 *   · lite 档改为**用户自备 GGUF** —— 把可用文件放进 `models/unet`，
 *     插件会自动按文件名挑最优的一个来用。
 *
 * ⚠ 本表只放"档位 → 加载器"，不放推荐文案（文案在 setup.mjs 的 TIERS 里）。
 */

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
  // ★★★ 2026-10-14（C2「专业卡版」）：两个**高精度档**。
  //   ⚠ 它们**不预置具体文件名** —— 由插件从你已装的文件里按标记挑（见 pickUnetForTier）。
  //     这样不会因为"我猜的文件名不对"而假装选中。挑不到就**如实回落**。
  //   ⚠ 本机（AMD RX 7900 XT 20 GB）**无法实测 BF16 / FP8**，档位是按官方发布格式
  //     与显存需求写的；真机效果需你在 24 GB+ 卡上验。
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

/**
 * ★★★ 2026-10-14（C2）：按**精度档**从已装的主模型文件里挑一个。
 *
 * ## 为什么按"标记"挑、而不是写死文件名
 *   用户的模型文件名五花八门（各家重打包）。写死一个名字，一旦对不上就会出现
 *   "面板说用上了 BF16、实际跑的还是 int8" —— 这正是本项目反复踩的**假报告**。
 *   所以：**按文件名标记挑；挑不到就返回 null，由调用方如实回落**。
 *
 * ## 各档判据
 *   · `gguf` —— `.gguf` 结尾，按 Q4_K_M > Q4_0 > Q5_K_M … 排序
 *   · `int8` —— 含 `int8`
 *   · `fp8`  —— 含 `fp8`
 *   · `bf16` —— 含 `bf16`/`bfloat16`；**没有再退一步**找"完全无量化标记"的原生文件
 *   · `auto` —— 返回 null（由调用方走老逻辑 `MODEL_HINTS.unet`）
 *
 * @returns {{unet: string, loader: string, tier: string}|null}
 */
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

/**
 * ★★★ 2026-10-14（C1「专业卡版」）：把「档位 + 显存 + 平台」折算成 ComfyUI 的显存/内存启动参数。
 *
 * 放在 config.js 而不是 index.js：**启动参数**（index.js 的 ensureComfyUp）与
 * **面板报告**（resolvePlan 里的 residency）必须**同源** —— 两处各写一份，
 * 迟早出现"面板说一套、实际跑另一套"（本项目历史上就出过这种假报告）。
 *
 * 档位（`cfg.vramMode`）：
 *   'auto'     —— 按显存自动（老行为）：≥24 全驻留；16–24 全驻留+保留 0.5；<16 不加
 *   'resident' —— 全驻留 `--highvram`（最快，要求显存装得下）
 *   'standard' —— 不加驻留参数，交给 ComfyUI 自己调度
 *   'save'     —— 省显存 `--lowvram`（部分权重换到内存，会慢）
 *   'ram'      —— 权重放内存 `--novram`（权重常驻内存、按需换入；最省显存、最慢）
 *   'cpu'      —— 纯 CPU `--cpu`（最后手段，很慢）
 *
 * ⚠ macOS：ComfyUI 源码里 MPS 的 `vram_state` 被强制成 `SHARED`，
 *   这组离散显存参数**根本不参与** ⇒ 显式档位在 Mac 上**不生效**，如实返回空。
 * ⚠ 全部是**启动参数** ⇒ 改完必须重启 ComfyUI。
 */
function resolveVramArgs({ mode, vramGB, isMac }) {
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

/**
 * 给用户看的一句话：当前主模型用的是哪个文件、走哪个加载器。
 *
 * ⚠ 判定**与 `resolvePlan` 同源** —— 只看最终生效的那个模型名（+ 探测阶段定下的加载器），
 *   不另起一套判断。否则又是"面板说一套、实际跑另一套"（这个坑本项目踩过好几次）。
 * ⚠ 2026-10-12：**轻量档保留**，但 lite 不再预置具体文件名（上游那份是 sd.cpp 格式），
 *   改由插件从已装的 GGUF 里挑。这里如实报告"档位 + 当前文件"。
 */

// ===== moved from index.js: tierLabelOf (was lines 3427-3450) =====
function tierLabelOf(caps, cfg) {
  const name = String(caps?.models?.unet ?? cfg?.unet ?? '')
  const loader = caps?.unetLoader ?? unetLoaderFor(name)
  const isGguf = loader === UNET_LOADER_GGUF
  const missing = isGguf && caps?.nodes && caps.nodes.ggufUnet === false
    ? '（⚠ 缺 UnetLoaderGGUF 节点，需先装 ComfyUI-GGUF）'
    : ''
  const tier = isGguf ? MODEL_TIERS.lite : MODEL_TIERS.full
  return `${tier.label}：${name}${missing}`
}

/**
 * ★★★ 2026-10-11 新增：**把关键能力缺口从 `caps.notes` 里挑出来**，供面板显示。
 *
 * ## 为什么需要（这是个真缺口）
 *   `caps.notes` 以前**只写日志**（`log('info', ...)`），**面板上看不到**。
 *   于是"选了 GGUF 档、却没装 ComfyUI-GGUF 节点"这种**会让出图直接失败**的情况，
 *   用户在界面上完全看不出来 —— 直到出图被 ComfyUI 拒收才知道。
 *   那正是最该避免的一类体验：**机器明明知道，却没告诉用户**。
 *
 * ## 挑哪些
 *   只挑**以 `⚠` 开头**的（这是本项目里"重要"的既有约定），
 *   避免把"跳过了某环节"这类常规说明也糊到面板上。
 */

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

/**
 * 取某个节点的 schema。
 *
 * ★ 2026-10-09 加固：返回**三态**，而不是简单的 `null`。
 *
 * 之前用 `null` 表示一切失败，导致**无法区分"节点确实没装"和"这次查询没成功"** ——
 * 于是一次网络抖动、一次超时、甚至用户点了取消（signal abort），
 * 都会被判成"节点缺失" → 静默降级到 basic 档 → 再把这个错误结论**缓存 10 分钟**。
 * 用户看到的现象是"突然变慢好几倍，而且没有任何提示"，极难排查。
 *
 * @returns {{state:'ok'|'missing'|'error', node: object|null}}
 *   · `ok`      — 查询成功，节点存在
 *   · `missing` — 查询成功，但 ComfyUI 里确实没有这个节点（**确定**）
 *   · `error`   — 请求失败 / 超时 / 被取消（**不确定**，绝不能当作缺失）
 */

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
  const NODE_KEYS = ['qwen21', 'prefixCache', 'teSpeed', 'speedup', 'blockCache', 'rdna3fa', 'loraOnly', 'unet', 'ggufUnet', 'clip', 'vae', 'lora', 'vaeTiled', 'spectrum', 'sada', 'cnetLoader', 'cnetApply']
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
    // ★★★ 2026-10-14（C3/C4「专业卡版」）：ControlNet 的加载器与施加节点。
    //   · `ControlNetLoader`            —— ComfyUI 核心节点（列 models/controlnet 下的权重）
    //   · `ControlNetApplyAdvanced`     —— ComfyUI 核心节点（把 control 图作为条件施加）
    //   ⚠ 局部重绘走的是另一套（`ControlNetInpaintingAliMamaApply`），两者互不影响。
    getNodeSchema(cfg, 'ControlNetLoader', signal),
    getNodeSchema(cfg, 'ControlNetApplyAdvanced', signal),
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
  },
    models: {
      unet: pickBestModel(nodeFileList(probe.unet.node, 'unet_name'), MODEL_HINTS.unet),
      // ★ 2026-10-11：GGUF 档的候选。**与原生列表是两套**（UnetLoaderGGUF 只列 .gguf），
      //   所以必须单独探、单独挑，不能拿原生那份顶替。
      unetGguf: pickBestModel(nodeFileList(probe.ggufUnet.node, 'unet_name'), MODEL_HINTS.unetGguf),
      clip: pickBestModel(nodeFileList(probe.clip.node, 'clip_name'), MODEL_HINTS.clip),
      vae: pickBestModel(nodeFileList(probe.vae.node, 'vae_name'), MODEL_HINTS.vae),
      turbo8Lora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.lora),
      // ★ 2026-10-12：4 步蒸馏 LoRA（极速档用）。与 turbo8Lora **同一份候选列表、不同规则**，
      //   所以两个 LoRA 都在的机器上能各挑各的，互不覆盖。
      fast4Lora: pickBestModel(nodeFileList(probe.lora.node, 'lora_name'), MODEL_HINTS.fast4),
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

  // ---- 模型档位：决定"用哪个加载器 + 哪个主模型名"（★ 2026-10-11 小显存适配）----
  //
  // 规则（**保证默认行为与旧版一字不差**）：
  //   ① `cfg.unet` 是 `.gguf`                        → 走 GGUF 档（安装时选了小档）
  //   ② 配置的主模型**一个都没探到**、却探到了 GGUF   → 自动走 GGUF 档（**记 note，不静默**）
  //   ③ 其余                                          → 原生 UNETLoader（现状）
  //
  // ⚠ 必须算在 `hasCore` **之前**：否则"只装了 GGUF"的机器会被误判成 unsupported。
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

  // ---- ★★★ 2026-10-14（C2「专业卡版」）：**精度档**（面板可选）--------------------
  //   面板选了 bf16 / fp8 / int8 / gguf 时，从**已装文件**里按文件名标记挑一个；
  //   **挑不到就如实回落**（并记 note）—— 绝不出现"面板说用上了 BF16、实际跑 int8"的假报告。
  //   ⚠ 放在"档位判定"之前：hasCore 要用挑完之后的 unet。
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

  // ★★★ 2026-10-09 性能修正（主人要求排查"重复请求、浪费算力"）：
  //   这里原先写的是"只在探测可信时才缓存"，于是**失败就完全不缓存** ——
  //   而状态端点是**每 5 秒轮询一次**的，且每次都会走一遍探测。
  //   结果：ComfyUI 在线但不稳定时，每 5 秒重发 10 个 HTTP 请求
  //   （9 个 object_info + 1 个 system_stats），纯粹是浪费。
  //   现在改为**失败也缓存，但用短 TTL**：既不重复轰炸，又能较快恢复真实结论。
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
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true, ggufUnet: true },
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
  // ⚠ 只认 `level`（探测阶段算好的）。**绝不能**在这里用 `models.turbo8Lora` 判断 ——
  //   probeCapabilities 会把"没探测到"的 LoRA 名回落到默认文件名（为了给用户一个提示值），
  //   那时该字段非空但文件事实上不存在，用它判断会让 basic 档错误地接上 turbo8 LoRA，
  //   结果整单被 ComfyUI 以 `value not in list` 拒收。
  //
  // ★ 2026-10-09 精简：原先这里还写了 `c === FULL_CAPS ||`，其实**完全冗余** ——
  //   `FULL_CAPS` 自身的 `level` 就是 'full'、`nodes` 也全为 true，
  //   所以下面这些条件在传 FULL_CAPS 时本来就成立。
  const turboAvailable = c.level === 'full' || c.level === 'turbo'
  // ★★★ 2026-10-14（C5「专业卡版」）：**文本控制档**（面板可选）。
  //   · 'native' —— 强制走千问**原生工作点**（25 步 / CFG 2.5），**不挂 turbo8**。
  //     turbo8 是为速度牺牲文字渲染的（8 步蒸馏）；要"更精细的文本控制"就该走原生。
  //   · 'turbo'  —— 强制极速档（有 turbo8 时）。
  //   · 'auto'   —— 老行为（有 turbo8 就走 8 步，没有就回退原生）。
  //   ⚠ 'native' 会明显变慢（约 3 倍采样时间）—— 这是拿时间换文字精度，不是 bug。
  const textCtl = String(cfg.textControl ?? 'auto').toLowerCase()
  const forceNative = textCtl === 'native'
  const useTurbo = turboAvailable && cfg.turbo8Enabled !== false && !forceNative
  // ★★★ 2026-10-12（用户要求）：**极速档（4 步）** —— 在 turbo 链之上再切一档。
  //   三个条件缺一不可：
  //     ① 整条 turbo 链可用（4 步档同样是"LoRA + 采样位移 + CFG 1.0"这套）；
  //     ② 用户把开关打开了；
  //     ③ **确实探测到了 4 步 LoRA** —— 否则切了也出不来图（ComfyUI 会 value not in list）。
  //   ⚠ 这里用 `caps.models.fast4Lora` 判断是**安全的**，不像上面 turbo8Lora 那条警告：
  //     4 步 LoRA 没有"回落成默认文件名"的问题，探测不到就是 null。
  const useFast4 = useTurbo
    && cfg.fast4Enabled === true
    && c.models?.fast4Lora !== null && c.models?.fast4Lora !== undefined
  // ⚠ TE-Speed / Speedup **刻意挂在 useTurbo 之下**（basic 档不接），这不是偷懒：
  //   它们的阈值（reuse_threshold 0.06 / te_predictor）是**针对 8 步 turbo8 链路调出来的**，
  //   挪到 25 步原生链路上，同一个阈值意味着完全不同的跳过行为，会动画质且未经验证。
  //   想强行叠加：把 turbo8Enabled 保持 true 即可（有 LoRA 时本来就会全接）。
  const useTe = useTurbo && c.nodes?.teSpeed === true && cfg.teSpeedEnabled !== false
  const useSpeedup = useTurbo && c.nodes?.speedup === true && cfg.speedupEnabled !== false
  const usePrefix = c.nodes?.prefixCache === true && cfg.qwenCacheEnabled !== false

  // ★★★ 2026-10-09：BlockCache T8 与 **TE-Speed、Speedup 三者互斥**（实测，见下）。
  //
  //   这不是猜测 —— 三个节点都在 ModelPatcher 上注册 **同一组** wrapper：
  //       DIFFUSION_MODEL + OUTER_SAMPLE
  //     · BlockCache  runtime.py:51 要求 **独占** DIFFUSION_MODEL：
  //         "Qwen Image 2.1 T8 cache requires exclusive diffusion-wrapper ownership;
  //          use T8 Spectrum"
  //     · TE-Speed    **编译成 nodes.pyd**，字符串表里能直接读到
  //         `DIFFUSION_MODEL` / `_predictor_diffusion_wrapper` /
  //         `_predictor_sample_wrapper` / `add_wrapper_with_key` / `WrappersMP`
  //     · Speedup     nodes.py:335-338 明写 add_wrapper_with_key(DIFFUSION_MODEL / OUTER_SAMPLE)
  //   只要同时挂上，KSampler 会在 sample_wrapper 里直接抛 ValueError，**整单失败**。
  //
  //   实测证据（同一台机器、图生图、逐个叠加）：
  //     BlockCache 单独                   → ✅ 成功，日志 `T8: full=6 cache=2`（真的命中）
  //     BlockCache + LoRA                 → ✅
  //     BlockCache + LoRA + Flux 位移     → ✅
  //     BlockCache + LoRA + Flux + 前缀缓存 → ✅
  //     BlockCache + … + **TE-Speed**     → ❌ ValueError 整单失败  ★ 真凶在这里
  //     （早先误判为 Speedup —— 当时 Speedup 也开着，是它先暴露了同样的错。）
  //
  //   ⇒ 处理：**BlockCache 优先，挂上它就让 TE-Speed 与 Speedup 双双让位**。
  //     理由：说好的「找一个能用的加速」就是 BlockCache，它是当前唯一被实测确认
  //     真正生效（cache 命中计数非零）的图生图加速；而 TE-Speed/Speedup 每步仍要
  //     算完整 block，只是跳预测，无法与它共存。
  //     想换回原来的链路：把 blockCacheEnabled 设成 false。
  const useBlockCache = c.nodes?.blockCache === true && cfg.blockCacheEnabled !== false
  // ★ 2026-10-10：RDNA3 FlashAttention —— 与上面三者**不互斥**（它是注意力层钩子，
  //   不是 DIFFUSION_MODEL wrapper），可任意叠加。无损，能力门控。
  //
  //   ★★ 还必须看 **GPU 架构**：FA 节点的 `patch()` 在不支持的架构上是**直接抛错**
  //      （不是"跳过"），一旦挂上就会让**整单失败**。所以门控加一条：
  //        · caps **完全没传**（自测 / planWorkflow）→ 视为"能力齐全"，不拦（守住既有约定）；
  //        · caps **传了** → **必须能确认是 RDNA3**（有 GPU 名 且 vendorIdOf==='amd_rdna3'）才挂。
  //          探测不到 GPU 名时**不放行** —— 否则会在"未知架构"上挂出会崩的节点。
  //   ★ 2026-10-10 修正：原先是"拿不到名字就不拦"，与"只认 gfx1100"自相矛盾。
  const faCapsOmitted = caps === undefined || caps === null
  const faGpuName = c.gpu?.name
  const faGpuOk = faCapsOmitted ? true : (!!faGpuName && vendorIdOf(faGpuName) === 'amd_rdna3')
  const useRdna3Fa = c.nodes?.rdna3fa === true && cfg.rdna3FlashAttention !== false && faGpuOk
  // ★ TE-Speed / Speedup 让位：BlockCache 赢了就不挂它们（否则整链崩）。
  const useTeFinal = useTe && !useBlockCache
  const useSpeedupFinal = useSpeedup && !useBlockCache

  // ★★★ 2026-10-09 新增：**显存驻留**档位的判定（供面板如实展示）。
  //   注意：它**不是**工作流节点，而是启动参数 —— 真正的加参数逻辑在
  //   ensureComfyUp（见 VRAM_ARGS），这里只做"同一套规则"的复述，
  //   供 check_acceleration 面板显示，避免面板与实际启动参数说法不一致。
  //   判定必须与 VRAM_ARGS **完全同源**（都读 vramGB + comfyArgs），否则就是假报告。
  //   取值优先级与 detectGpuProfile 一致：caps.gpu（/system_stats，权威）→ cfg.vramGB（探测缓存）。
  // ★ 2026-10-10 修 bug：原来用 `??` —— 而 `c.gpu.vramGB` 在 `/system_stats` 缺 `vram_total`
  //   时会被算成 **0**，`??` 不会把 0 当"空值"跳过 ⇒ 面板报"未取到显存总量"，
  //   可真实启动参数那边用的是 PyTorch 探测值、**已经加了 --highvram** —— 又一处"面板与实际不同源"。
  //   改用 `||`：0 视为无效，继续往回落。
  const vramGB = Number(c.gpu?.vramGB || c.residency?.vramGB || cfg.vramGB || 0)
  const userArgs = Array.isArray(cfg.comfyArgs)
  // ★★★ 2026-10-14（C1）：改为**调用同一个纯函数** resolveVramArgs —— 不再在这里复述规则。
  //   之前两处各写一份判据，靠注释约定"必须同源"；现在从根上只剩一份，改不动歪。
  const residency = (() => {
    const mode = cfg.vramMode ?? 'auto'
    const r = resolveVramArgs({ mode, vramGB, isMac: IS_MAC })
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
  // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码** 与 **Spectrum 跳步** 的可用性判定。
  //
  // ⚠ 这里**只判"节点在不在 / 配置要不要开 / 显存够不够紧"**，**不判出图尺寸** ——
  //   resolvePlan 拿不到尺寸（它同时被面板调用，面板没有尺寸概念）。
  //   尺寸那一道闸在 buildWorkflow 里（见那里的注释）。两处**判据必须同源**，
  //   否则又会出现"面板说一套、实际跑另一套"的假报告。
  const vaeTiledAvailable = c.nodes?.vaeTiled === true
  const vaeTilingMode = cfg.vaeTiling === 'on' || cfg.vaeTiling === 'off' ? cfg.vaeTiling : 'auto'
  /** 'auto' 的**显存闸**：< 16 GB 才可能触发（另一半是尺寸闸，在 buildWorkflow）。 */
  const vaeTilingVramOk = Number.isFinite(vramGB) && vramGB > 0 && vramGB < 16
  const useVaeTiling = vaeTiledAvailable
    && (vaeTilingMode === 'on' || (vaeTilingMode === 'auto' && vaeTilingVramOk))
  /**
   * ★★ 2026-10-13：用户**显式**配的 turbo8 LoRA（null = 没改过，仍用内置默认值）。
   *
   * ⚠ 为什么必须跟 `DEFAULT_TURBO8_LORA` 比：DEFAULTS 里 `turbo8Lora` **默认就等于**
   *   这个内置值，所以它**永远非空** —— 用 `cfg.turbo8Lora || …` 判断"用户配没配"
   *   必然恒为真，探测结果就永远赢，用户配置形同虚设（这就是那个 bug）。
   */
  const explicitTurboLora = (typeof cfg.turbo8Lora === 'string'
    && cfg.turbo8Lora.trim() !== ''
    && cfg.turbo8Lora !== DEFAULT_TURBO8_LORA)
    ? cfg.turbo8Lora
    : null

  /** Spectrum 跳步：**默认关**（理由见 DEFAULTS.spectrumEnabled）；节点必须在，否则整单会被拒收。 */
  const useSpectrum = c.nodes?.spectrum === true && cfg.spectrumEnabled === true
  /** SADA 跳步采样：**默认关**（理由见 DEFAULTS.sadaEnabled）；节点必须在 + class_type 可配。 */
  const useSada = c.nodes?.sada === true && cfg.sadaEnabled === true

  // ★★★ 2026-10-14（C3「专业卡版」）：**权重覆写是否被采纳**。
  //   规则：只有覆写值**确实出现在探测到的清单里**才认；清单拿不到（caps 缺省 / 探测失败 /
  //   该清单为空）时**不拦**（保持既有"按配置试"的语义）。
  //   ⚠ 覆写被"设置但未采纳"时**必须留痕**（`weightOverride.*.ok=false`），
  //     由面板如实显示 —— 否则就成了"我明明选了 X、插件却用了 Y"的静默改变。
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

  return {
    useTurbo,
    // ★ 2026-10-14（C5）：文本控制档 —— 面板与自测都读它
    textControl: forceNative ? 'native' : (useTurbo ? 'turbo' : 'native'),
    // ★ 2026-10-12：极速档（4 步）是否生效 —— 界面文案 / 自测都读这个
    useFast4,
    // ★ 2026-10-12：VAE 分块解码 / Spectrum 跳步（详见各自 DEFAULTS 的注释）
    useVaeTiling,
    vaeTilingMode,
    vaeTiledAvailable,
    useSpectrum,
    useSada,
    useTe: useTeFinal,
    useSpeedup: useSpeedupFinal,
    usePrefix,
    useBlockCache,
    useRdna3Fa,
    residency,
    steps: useFast4
      ? (Number.isFinite(cfg.fast4Steps) && cfg.fast4Steps > 0 ? Math.trunc(cfg.fast4Steps) : 4)
      : (useTurbo
        ? TURBO8_STEPS
        : (Number.isFinite(cfg.baseSteps) && cfg.baseSteps > 0 ? Math.trunc(cfg.baseSteps) : BASE_STEPS)),
    cfgScale: useTurbo ? 1.0 : (Number.isFinite(cfg.baseCfg) ? cfg.baseCfg : BASE_CFG),
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
      unet: (mainModelOverrideOk ? cfg.mainModelOverride : '') || c.models?.unet || cfg.unet,
      clip: c.models?.clip || cfg.clip,
      vae: c.models?.vae || cfg.vae,
      // ★ 2026-10-12：极速档时换成 4 步 LoRA（其余情况仍是 turbo8 / 配置值）
      // ★★ 2026-10-13 修 bug：**显式配置此前会被探测结果静默覆盖**。
      //   原来是 `c.models?.turbo8Lora || (cfg.turbo8Lora || DEFAULT_TURBO8_LORA)`
      //   —— 探测结果永远优先。而 `cfg.turbo8Lora` **默认就等于** `DEFAULT_TURBO8_LORA`
      //   （见 DEFAULTS），所以"用户有没有显式改过"不能靠真值判断，只能靠
      //   **是否仍等于内置默认值**来判断。
      //   ⇒ 现在：用户显式改过 → **尊重配置**；没改过（仍是默认值）→ 用探测结果。
      //     否则"我明明配了 A 模型，插件却挑了机器上另一个 turbo8 文件"无从排查。
      // ★★★ 2026-10-14（C3）：**面板选的 LoRA 优先级最高**（用户显式选的赢）。
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

/* ------------------------------------------------- 生图意图判定提示词（★ 2026-10-09）---- */

/**
 * ★★★ 生图意图判定 —— 把原先「一整段写死的长提示词」改为**按策略生成**。
 *
 * ## 为什么要改
 * 原来那段提示词是"越狠越好"地堆出来的（当天改过十七次），结果是：
 *   · 它对**所有**用户都一套话术，用户无法表达"我不想要这么激进的自动画图"；
 *   · 它只教模型"判断是生图就赶紧画"，却**没教它排除**"画个流程图/思维导图"这类
 *     看着像生图、实际不该用本工具的场景 —— 这才是最容易出错的边界；
 *   · 同一段话术在文件里抄了三份，改一次要改三处。
 *
 * ## 现在
 * 按 `cfg.drawTrigger` 四档生成，**核心事实（属于哪个档）只写一遍**，
 * 各档在此基础上增减。四档的定义见 DEFAULTS 里 `drawTrigger` 的注释。
 *
 * ⚠ 无论哪一档，都**不会**让模型在没有生图意图时去调工具 —— 最松的 'eager'
 *   也只是"沾边就画"，不是"无脑画"。
 */

// ===== moved from index.js: DRAW_INTENT_MODES (was lines 3850-3907) =====
const DRAW_INTENT_MODES = {
  off: {
    // 不做任何主动引导：只在用户**直接点名**要画图时才画。
    lead: '【生图】当用户**明确要求生成图片**（「画一张…」「生成图片」「来张图」等）时，调用 draw_image。',
    guard: '用户没有明确要求生成图片时，**不要**调用 draw_image —— 不要主动揣测生图意图。',
  },
  strict: {
    lead: '【生图】仅当用户**明确要求生成图片**（「画一张…」「生成一张…」「来张…」「给我做张图」等）'
      + '且**画面描述足够具体**时，调用 draw_image。',
    // ★ 2026-10-09：判定标准从"题材"改成"产物形态"（见下面 auto 里的说明）；
    //   "示意图"这个词已从排除清单删除 —— 它太宽，会把"数学示意图/艺术示意图"也挡掉。
    guard: '若用户只是**含糊提及**（没说要图、或没说画什么），**先问一句**再画，不要直接调用工具。'
      + '只有当请求明显是**可编辑的结构化图表**时才不属于本工具：流程图、思维导图、组织架构图、数据表。'
      + '注意：**题材**不决定归属 —— 「数学艺术画」「几何可视化」「物理示意图」要的仍是一张图像，照画。',
  },
  auto: {
    lead: '【生图】判断用户是不是想生成图片（「画个…」「生成一张…」「来张…」「给我做张图」'
      + '「用这张图做参考画…」等）—— 这是你**优先要判断的一件事**。一旦判断是生图请求，'
      + '你的**第一个动作就是调用 draw_image**。',
    // ★★★ 2026-10-09 改写（真事故）：
    //   旧文案是「排除流程图/思维导图/表格/架构图/**示意图**」+「宁可先问一句，也不要画错」。
    //   事故：用户说「画一幅表现双曲几何之美的数学艺术画」，助手因为"数学/几何/示意"这几个字
    //   把它归进排除清单 → 不敢调工具 → **自己写渲染脚本画了**（更糟的结果）。
    //
    //   ⇒ 两处修正：
    //     ① 判定标准换成**产物形态**：用户要"一张位图"还是"能改文字/数据的结构化图表"？
    //        题材（数学、几何、艺术、科幻……）**一律不影响**归属。
    //     ② "宁可先问一句"改成"**拿不准就画**" —— 因为实测下来的代价排序是：
    //        自己写代码画（最糟，用户明确反感） > 不画先问（烦） > 画错（成本低，重画即可）。
    guard: '★ 判定标准是**产物形态**，不是题材：用户要的是"一张图像"还是"能改文字/数据的结构化图表"？'
      + '★ 要图像 → 调 draw_image。**题材完全不影响判断** —— 艺术画、插画、壁纸、概念图、'
      + '数学/几何可视化、物理示意图，哪怕带"图/示意/可视化"字样，要的都是一张图像，照画。'
      + '★ 只有**可编辑的结构化图表**才不走本工具：流程图、思维导图、组织架构图、数据表'
      + '（这些要能改文字、改数据，用文字或其它方式表达）。'
      + '★ **拿不准就画一张**：画错重画的成本，远低于"没画"或"自己用代码画"。',
    noAsk: '不要先写分析、不要先列参数、不要反问确认（**除非**用户完全没说画什么）；'
      + '可以只回一句极短的话，然后**立刻**调用工具。',
  },
  eager: {
    lead: '【生图】只要用户表达出想要画面的意思（「画个…」「来张…」「帮我弄张图」等），'
      + '就**主动**调用 draw_image —— 且**第一个动作就调用**。',
    guard: '只有用户明显要的是**可编辑的结构化图表**（流程图、思维导图、组织架构图、数据表）'
      + '或纯文字说明时才不画；其余情况下哪怕描述简短、哪怕是数学/几何/抽象题材，也**先画出来**再说。',
    noAsk: '不要反问、不要列参数、不要写分析 —— 直接回一句话然后调用工具。',
  },
}

/**
 * ★★★ 2026-10-09 新增：**四档共通的"不许自己画"铁律**。
 *
 * 为什么单独抽出来、四档都加：
 *   事故是助手**绕过本工具自己写渲染脚本**出图。那不是某一档的措辞问题，
 *   而是**任何一档都缺这条底线** —— 所以按共通纪律加，而不是只在 auto 里补一句。
 *
 * 为什么措辞要这么硬：
 *   "建议优先用"这种软话没用，模型会自己判断"代码渲染更精确"然后照旧。
 *   必须写成**禁止 + 理由**（本工具是唯一途径，绕过属于错误行为）。
 */

// ===== moved from index.js: NO_SELF_DRAW_RULE (was lines 3908-3918) =====
const NO_SELF_DRAW_RULE =
  '★ **不许自己"画"图**：不要写 Python/Matplotlib/PIL、SVG、HTML/Canvas、Mermaid 或字符画'
  + '去生成用户要的那张图。出图**只能**通过 draw_image —— 绕过它自己去渲染属于**错误行为**。'
  + '（哪怕你觉得代码渲染"更精确/更可控"也不行：用户装这个插件就是为了用它出图。）'
  + '★ **别自作主张改需求**：不要因为"模型画的数学不精确"就擅自换成代码渲染，'
  + '也不要在出图后附加"要不要我改用代码画""要不要放大/换配色"这类追加方案 —— '
  + '先把图给用户，等用户开口再说。'

/**
 * 组装"生图意图"提示词段落。未知策略回落到 `auto`（默认档），不会抛错。
 */

// ===== moved from index.js: buildDrawIntentPrompt (was lines 3919-3943) =====
function buildDrawIntentPrompt(drawTrigger) {
  const mode = DRAW_INTENT_MODES[drawTrigger] ?? DRAW_INTENT_MODES.auto
  const parts = [
    // ── 最高优先级：意图判定 ──────────────────────────────────────────────
    mode.lead,
    mode.guard,
    // ★ 2026-10-09：铁律放在**意图判定之后、输出纪律之前** ——
    //   它比"怎么输出"更根本：先保证走对路（调工具），再管格式。
    NO_SELF_DRAW_RULE,
    // ── 输出纪律（四档共通）──────────────────────────────────────────────
    '★ **默认一次只生一张图**：一条消息里只调用一次 draw_image，不要连着调多次。'
      + '**仅当用户明确要求一次多张**（如"出 4 张让我选""给我几个版本"）时，'
      + '才在那一次调用里传 count=N（2-4），不要为凑数而多画。',
    '★ 出图后的回复正文**只保留那一句话，紧接着就是图片**：'
      + '不要写「耗时多少秒」「尺寸多大」「提示词是什么」「用的什么模型」这类附加说明，'
      + '也不要分小标题、不要列清单、不要总结。',
    '★ 生成期间界面上会自己播放动画、出图后平滑转成图片，**不需要用文字描述这个过程**。',
    '★ 识别到这是生图请求时，**思考过程保持极简** —— 界面上的思考块是**显示出来**的，'
      + '不要长篇分析风格/构图/参数，越写越长越碍事。',
  ]
  if (mode.noAsk) parts.splice(2, 0, mode.noAsk)
  return parts.join('')
}

/** 出图后"必须在正文内联展示图片"的固定段落（与 drawTrigger 无关，恒定生效）。 */

// ===== moved from index.js: INLINE_IMAGE_PROMPT (was lines 3944-3966) =====
const INLINE_IMAGE_PROMPT =
  '用 draw_image 出图后，必须在回复正文里用 Markdown 图片语法把生成的图直接展示给用户：'
  + '![画面简述](<图片的绝对路径>)。不要把图片路径放进代码块，也不要只给路径或链接而不给图。'

/* ------------------------------------------------- 优化状态诊断（★ 2026-10-09）---- */

/**
 * ★★★ 把"优化到底有没有生效、没生效是为什么"整理成一份**人能看懂**的诊断。
 *
 * ## 为什么需要它
 * 之前所有关于优化的信息都只躺在**日志**里 —— 用户装完插件，界面上只看得到一个
 * ComfyUI 在线圆点，完全不知道：turbo8 到底跑没跑？没跑是因为没装 LoRA、
 * 还是 ComfyUI 太旧、还是探测压根没成功？
 *
 * 结果就是用户体感"怎么这么慢"，却没有任何线索可循。这个函数就是补上这块。
 *
 * ## 设计原则
 *   · **一定给出"为什么"**，不能只说"未启用" —— reason 字段必须可直接照做；
 *   · **区分"确实缺件"和"没测出来"** —— 后者要明确让用户重试，而不是以为要装东西；
 *   · **绝不抛错**：拿不到探测结果就返回 unknown 状态，UI 照样能显示。
 *
 * @returns {{level:string, summary:string, ok:boolean, reasons:string[], detail:Array}}
 */

// ===== moved from index.js: describeOptimization (was lines 3967-4538) =====
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description:
        '画面描述，想画什么就写什么（中文可以）。建议写成一段完整、具体的话：主体 + 外观细节 + 环境 + 光线 + 风格 + 画质词。',
    },
    reference: {
      type: 'string',
      description:
        '参考图的本地文件路径（可选）。**给了就走图生图**：以这张图为参考，按 prompt 改姿势、换环境、换动作，'
        + '保持同一个角色和画风；不给就是普通文生图（只按文字描述画）。PNG / JPG / WEBP 都行。',
    },
    controlImage: {
      type: 'string',
      description:
        'ControlNet 控制图的本地文件路径（可选）。**给了就走 ControlNet**：按这张图的结构（边缘/深度/姿态）'
        + '约束生成结果，比 reference 更能"锁结构"。⚠ 需先在优化面板里选好 ControlNet 权重，'
        + '且 ComfyUI 装有 ControlNetLoader / ControlNetApplyAdvanced 节点；缺任一条都不会生效（会如实说明）。',
    },
    size: {
      type: 'string',
      description: '画幅比例，可选：1:1（默认）、3:4、4:3、2:3、3:2、16:9、9:16。',
    },
    megapixels: {
      type: 'number',
      description: '总像素（百万），默认 1.0。想要更清楚就调大，例如 1.5 或 2.0。',
    },
    steps: {
      type: 'integer',
      description: '采样步数，范围 1-60，步数越高越精细、越慢。'
        + '⚠ 注意：默认链路（turbo8 八步蒸馏 LoRA）下，本参数**会被忽略**、强制用 8 步 ——'
        + '因为 turbo8 是 8 步蒸馏的，改步数会让画面崩坏。'
        + '要让本参数真正生效，需先在配置里把 `forceTurbo8Steps` 设为 `false`'
        + '（同时建议把 `turbo8Steps` 设为 25）。不填则用当前链路的工作点。',
    },
    seed: {
      type: 'integer',
      description: '随机种子。同一提示词 + 同一种子 = 同一张图；不填则每次都不一样。',
    },
    count: {
      type: 'integer',
      description:
        '一次产出几张图（默认 1，范围 1-4）。**默认就传 1（只出一张）**；'
        + '仅当用户**明确要求**一次多张（如"出 4 张让我选""给我几个版本"）时才传 2-4。'
        + '同一次调用出多张只加载一次模型，比连着调多次快得多。仅文生图支持；图生图会按 1 张处理。',
    },
    preset: {
      type: 'string',
      enum: ['default', 'portrait', 'anime', 'wallpaper'],
      description: '可选的轻量预设：default 保持原样；portrait 人像3:4；anime 动漫插画3:4；wallpaper 壁纸16:9。用户明确要求某类风格时才选择，不覆盖显式 size/megapixels。',
    },
    negative: {
      type: 'string',
      description: '负面提示词（不想要的内容）。注意千问模型 cfg=1，负面词基本不生效，一般不用填。',
    },
  },
  required: ['prompt'],
}

/** 结果 schema（标准 JSON Schema）。 */

// ===== moved from index.js: OUTPUT_SCHEMA (was lines 4586-4615) =====
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: '成品图片的绝对路径。' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    seed: { type: 'integer' },
    seconds: { type: 'number', description: '本次出图耗时（秒）。' },
    files: { type: 'array', items: { type: 'string' }, description: '本次产出的全部图片路径。' },
  },
  required: ['path', 'width', 'height', 'seed', 'seconds', 'files'],
}

/**
 * hipfire 出图分支（★ 2026-10-08 新增）。
 *
 * ★ 设计原则：**复用现有交付链路**，不另造一套 ——
 *   产物路径照样进 value.files → 由外层的 onProduced 登记交付事件 →
 *   正文 Markdown 内联显示（与 ComfyUI 路径完全同一条链路）。
 *
 * ★ 与 ComfyUI 分支的**语义差异**（都是客观限制，如实处理，不粉饰）：
 *   · 尺寸：hipfire 要求宽高是 **16 的倍数**（VAE factor 8 + 2x2 patch），
 *     所以把 calcSize 出来的值再过一遍 alignSize；图生图时 Klein 另有 1 MP 面积上限。
 *   · 步数：schnell 是步蒸馏模型，默认 4 步；用户没显式给 steps 时交给 hipfire
 *     用它自己的架构默认值（不硬塞插件的 25 步 —— 那对 schnell 是纯粹浪费）。
 *   · 参考图：hipfire 直接吃**本地路径**（CLI 的 --image / HTTP 的 multipart），
 *     **不需要**像 ComfyUI 那样先上传到 input 目录。
 *   · 负面提示词：hipfire 不支持 → 在适配器里明确报错。
 */

// ===== moved from index.js: DIAG_FILE (was lines 4962-4975) =====
const DIAG_FILE = (() => {
  try {
    // ★★★ 2026-10-09 修复（**通用性**）：这里原先硬拼 `home/Desktop`，
    //   绕过了本文件里已经写好的跨平台 `defaultOutputDir()`。
    //   而 `defaultOutputDir()` 的注释明确写过：Linux 上（服务器、WSL、无桌面环境）
    //   `~/Desktop` 常常压根不存在，硬拼会**造出一个用户根本不用的 Desktop 目录**。
    //   诊断日志跟出图成品放一起最自然，也顺带复用了那套 XDG → Desktop → 桌面 → 主目录 的探测。
    return path.join(defaultOutputDir(), 'qwen-paint-diag.log')
  } catch {
    return ''
  }
})()

/** 诊断开关：默认开（排查期）；设 `DSHQP_DIAG=0` 可关掉。 */

// ===== moved from index.js: DIAG_ON (was lines 4976-4978) =====
const DIAG_ON = process.env.DSHQP_DIAG !== '0'

/* ------------------------------------------- safetensors 架构探测（★ 2026-10-16）---- */

/**
 * ★★★ 读 safetensors 的 header，取出**所有 4D 卷积权重的输入通道数**，
 *   用于判断 ControlNet 权重是给哪一代 Qwen-Image 底模的。
 *
 * ## 为什么需要
 *   真实用户实测反馈：InstantX 的 Qwen ControlNet（Union / Inpainting）是给
 *   **Qwen-Image 1.0** 的（latent 16 通道），而本插件默认底模是 **2.1**（latent 64 通道）
 *   ⇒ 执行时在 ComfyUI 的 `model.py` 里 unpack 崩。用户希望
 *   「**选权重时就提示，而不是装完才发现**」。
 *
 * ## 只读 header，不读权重本体
 *   safetensors 格式：前 8 字节 = 小端 uint64 的 header 长度 N；随后 N 字节 = JSON header，
 *   形如 `{"层名": {"dtype":"F16","shape":[...],"data_offsets":[a,b]}}`。
 *   所以**几 KB 的读取**就能拿到全部形状，不必把几 GB 权重读进来。
 *
 * ## ⚠ 这是**保守的启发式**，不是权威判定
 *   · `16` / `64` 两个阈值来自**用户实测反馈**（1.0 = 16ch、2.1 = 64ch）。
 *     **本机 `models/controlnet/` 是空的、没有该权重，我无法独立验证这两个数。**
 *   · 因此调用方**必须只在"只见到 16、没见到 64"时才警告**，其余一律不吭声 ——
 *     **宁可漏报，绝不误报**（"报错指错方向"比不报更浪费时间）。
 *
 * @param {string} filePath safetensors 文件路径
 * @returns {Promise<Set<number>|null>} 4D 卷积的 in_channels 集合；读不出返回 null
 */
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
