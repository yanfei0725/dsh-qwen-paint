/**
 * dsh-qwen-paint —— hipfire 出图后端适配器（**通用版**）
 * ============================================================================
 * 定位：让插件除 ComfyUI 之外还能用 **hipfire** 出图。
 *
 * ★ 需求原话是「适用于 A 卡用户」—— 所以本文件**不写死任何本机路径**：
 *   · exe 位置：cfg.hipfireExe → 环境变量 → PATH → 常见位置，逐级探测；
 *   · 模型名 / 后端 / 超时 / 传输方式全部可配；
 *   · 找不到 exe、找不到模型、hipfire 报错 → **一律明确抛错**，
 *     绝不返回一个假的成功（出图是用户可见产物，静默失败比报错更糟）。
 *
 * ★ 本文件**只在 `imageBackend: 'hipfire'` 时被调用**，默认后端仍是 comfyui。
 *   现有 ComfyUI 出图路径一行不改（这是硬约束）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 两条通道都实现，HTTP 优先（都由同一个 daemon 消息 `img_generate` 承载）：
 *
 *   · **HTTP**（推荐）：`hipfire serve` 起常驻服务 →
 *     `POST /v1/images/generations`。daemon 常驻，不必每次重新加载权重。
 *     ⚠ 协议约束（读上游 docs/SERVE.md + crates/hipfire-cli/src/serve/http.rs 核实）：
 *        1. 端点就是 `/v1/images/generations` —— 上游**没有** `/api/generate/image`；
 *        2. `response_format` **必须** `"b64_json"`，`n` **必须** `1`，否则 400；
 *        3. 响应 `{data:[{b64_json,width,height,seed,steps}], model, hipfire:{ms}}`，
 *           **不返回服务端文件路径** → 我们自己 base64 解码落盘。
 *        4. 图生图必须另走 `POST /v1/images/edits`（multipart，仅 FLUX.2 Klein）；
 *           `/v1/images/generations` **拒绝**带 images 字段的请求（回 400）。
 *
 *   · **CLI**（回退）：`hipfire img <MODEL> <PROMPT> … -o <OUT> -j`。
 *     每次调用是 fresh daemon 进程，**首次会慢**（要加载权重），不是卡死。
 *     ⚠ 选项必须全部放在 prompt **之前** —— prompt 是 greedy trailing
 *       positional，会吞掉后面所有内容（上游 --help 里明确警告）。
 *
 * `cfg.hipfireTransport`: 'auto'（默认，HTTP 探活失败就回退 CLI）| 'http' | 'cli'。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 明确不支持的功能（**如实报错，绝不假装支持**）
 *
 *   · **negative（负面提示词）**：hipfire 的 img 与 HTTP 两个接口**都没有**这个参数
 *     （`hipfire img --help` 没有，SERVE.md 字段表也没有）。调用方传了 → 明确报错。
 *   · **图生图**：仅 FLUX.2 Klein（arch 45）支持，FLUX.1 会拒绝。
 *   · **模型**：hipfire 只支持 FLUX.1（arch 40）与 FLUX.2 Klein（arch 45）。
 *     ComfyUI 的 Qwen-Image 模型**不能**喂给 hipfire（容器格式与架构都不支持）——
 *     这不是配置问题，是 arch_id / loader / kernel 都没有实现。
 * ============================================================================
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/* ------------------------------------------------------------ 常量与默认值 ---- */

/**
 * hipfire 的尺寸约束：上游 docs/IMAGEGEN.md §9 ——
 * 「Width and height must be multiples of 16: the VAE factor is 8 and the
 *  latent is packed in 2x2 patches」。
 */
export const HIPFIRE_SIZE_MULTIPLE = 16

/** 与 hipfire 相关的默认值（index.js 的 DEFAULTS 会合并这一份）。 */
export const HIPFIRE_DEFAULTS = {
  /** 'comfyui' | 'hipfire' —— 默认保持 comfyui，不改变现有行为。 */
  imageBackend: 'comfyui',
  /** hipfire 可执行文件。空串 = 自动探测（见 resolveHipfireExe）。 */
  hipfireExe: '',
  /**
   * 出图模型：registry tag、别名、文件名，或 **hfq trunk pack 的路径**。
   *
   * 默认给 FLUX.2 Klein 4B 的本地路径（本地打包产物，无需注册进 registry）。
   * 官方 docs/IMAGEGEN.md 明确：`hipfire img` 的 MODEL 参数接受
   * 「path to an HFQ trunk pack (`<base>-transformer.hfq`, with its sidecar
   * packs next to it)」—— 即只要 `<base>-transformer.hfq` 旁边放着同名的
   * `-qwen3.hfq` / `-vae.hfq`，直接给路径即可。
   *
   * 为什么默认不是 `flux.schnell:1`：FLUX.1 schnell 主干 23.8 GB、
   * 常驻约 24.3 GB，24 GB 卡（RX 7900 XT/XTX）装不下会 OOM；Klein 4B
   * 约 13 GB，能跑。见 docs/IMAGEGEN.md §10。
   */
  hipfireImgModel: 'X:\hipfire\models\flux-klein-transformer.hfq',
  /** 'auto' | 'http' | 'cli'。 */
  hipfireTransport: 'auto',
  /** HTTP 服务地址（hipfire serve 监听处）。 */
  hipfireUrl: 'http://127.0.0.1:11580',
  /** 单次出图超时（与插件既有 timeoutMs 对齐）。 */
  hipfireTimeoutMs: 600000,
  /**
   * 是否由插件自动拉起 `hipfire serve`。默认 false ——
   * serve 需要 daemon 已安装（HIPFIRE_DAEMON_BIN 或 ~/.hipfire/bin），
   * 在未核实的机器上自动拉起风险大，要自动就显式打开。
   */
  hipfireAutoStartServe: false,
  /** 执行后端：'gpu'（HIP MMDiT，A 卡走这条）/ 'cpu'（f32 oracle，很慢）。 */
  hipfireBackend: 'gpu',
  /** 探测 HTTP 服务是否在线时的超时。 */
  hipfireProbeMs: 4000,
  /**
   * ★★ 出图前预检模型是否已在本地。默认 **true**。
   *
   * 为什么必须默认开（实测踩到的真实事故）：
   *   `hipfire img <缺失的模型>` **不会报错**，而是**静默开始下载**（23.8 GB）——
   *   在插件的 600 秒超时里表现为"一直没动静"，最后报一个语焉不详的超时。
   *   更糟的是：它在 C 盘留下半截 .part 文件，而用户可能根本不想下这个模型。
   *   ✓ 所以先查 `hipfire list`，模型不在本地就**立刻明确报错**，绝不触发下载。
   *
   * 关掉它 = 接受"hipfire 可自动拉模型"的行为（半截文件会留在 hipfire 的模型目录）。
   */
  hipfirePrecheckModel: true,
}

/* ------------------------------------------------------------------ 小工具 ---- */

const noopLog = () => {}

/** 把 Windows 反斜杠换成斜杠，避免当参数传递时的转义问题。 */
export function toPosix(p) {
  return String(p).replace(/\\/gu, '/')
}

/**
 * 对齐到 n 的倍数（hipfire 要求宽高是 16 的倍数）。
 * 用 round 而非 floor —— 与插件既有的 r32() 语义保持一致。
 */
export function alignSize(value, multiple = HIPFIRE_SIZE_MULTIPLE) {
  const n = Number(value)
  const m = Number(multiple) > 0 ? Number(multiple) : HIPFIRE_SIZE_MULTIPLE
  if (!Number.isFinite(n) || n <= 0) return m * 64 // 默认 1024
  return Math.max(m, Math.round(n / m) * m)
}

/** 把 "1024x1024" / "1024*1024" 解析成 [w, h]；解析不出来返回 null。 */
export function parseSizeString(size) {
  if (typeof size !== 'string') return null
  const m = /^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/u.exec(size)
  if (m === null) return null
  return [Number(m[1]), Number(m[2])]
}

/* ------------------------------------------- exe 自动探测（"通用"的关键） ---- */

/**
 * 按优先级找一个**真实存在**的 hipfire 可执行文件。
 *
 * ① cfg.hipfireExe          用户显式配置，最高优先级
 * ② HIPFIRE_EXE             环境变量
 * ③ HIPFIRE_HOME 之下       hipfire / hipfire.exe / engine/ / bin/
 * ④ PATH                    hipfire.exe / hipfire（Windows 再试 .cmd/.bat）
 * ⑤ 常见安装位置            Windows 与 Linux 各若干（够用即可，不穷举）
 *
 * @returns {Promise<string>} 绝对路径；一个都没找到返回 ''（调用方据此明确报错）
 */
export async function resolveHipfireExe(cfg, log = noopLog) {
  const candidates = []
  const push = (p) => {
    if (typeof p === 'string' && p.trim() !== '') candidates.push(p.trim())
  }
  const exeNames = process.platform === 'win32' ? ['hipfire.exe', 'hipfire.cmd', 'hipfire'] : ['hipfire']

  // ① 显式配置 —— ★ 一旦配了就必须生效，找不到就报错
  //
  //   设计理由：cfg.hipfireExe 是用户**有意指定**的路径。如果它不存在却
  //   静默回退到自动探测，用户会以为"我配的生效了"，实际跑的是另一个 exe
  //   （版本可能不同，甚至来自 PATH 里的无关程序）。这属于**隐蔽的错误成功**，
  //   比直接报错更有害。所以显式配置失败 = 立即返回 ''，交由调用方明确报错。
  const explicit = typeof cfg?.hipfireExe === 'string' ? cfg.hipfireExe.trim() : ''
  if (explicit !== '') {
    try {
      const stat = await fsp.stat(explicit)
      if (stat.isFile()) return path.resolve(explicit)
    } catch {
      /* 落到下面的报错 */
    }
    log('error', `配置里的 hipfireExe 不存在：${explicit}（不会静默回退到自动探测）`)
    return ''
  }

  // ② 环境变量
  push(process.env.HIPFIRE_EXE)

  // ③ HIPFIRE_HOME
  const home = process.env.HIPFIRE_HOME
  if (typeof home === 'string' && home.trim() !== '') {
    for (const name of exeNames) {
      push(path.join(home, name))
      push(path.join(home, 'engine', name))
      push(path.join(home, 'bin', name))
    }
  }

  // ④ PATH
  const pathDirs = String(process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== '')
  for (const dir of pathDirs) {
    for (const name of exeNames) push(path.join(dir, name))
  }

  // ⑤ 常见安装位置
  //
  // ★ 盘符必须覆盖全 —— 实测有用户把 hipfire 装在 X:\hipfire\engine\
  //   （C 盘紧张、GPU 模型放数据盘的常见做法）。只列 C/D 会"探测不到"，
  //   表现为 resolved='' 后报"请显式配置 hipfireExe"，与"通用桥接"的定位相悖。
  //   Windows 实用盘符就是 C–K，穷举 9 个 × 2 布局的 stat 成本可忽略。
  const winDrives = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']
  const guesses = process.platform === 'win32'
    ? [
        ...winDrives.flatMap((d) => [`${d}:\\hipfire\\engine\\hipfire.exe`, `${d}:\\hipfire\\hipfire.exe`]),
        path.join(process.env.USERPROFILE ?? '', '.hipfire', 'bin', 'hipfire.exe'),
      ]
    : [
        '/opt/hipfire/engine/hipfire',
        '/usr/local/bin/hipfire',
        path.join(process.env.HOME ?? '', '.hipfire', 'bin', 'hipfire'),
        path.join(process.env.HOME ?? '', '.local', 'bin', 'hipfire'),
      ]
  for (const g of guesses) push(g)

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile()) return path.resolve(candidate)
    } catch {
      /* 不存在 → 试下一个 */
    }
  }
  log('warn', `没能自动找到 hipfire 可执行文件（试了 ${candidates.length} 个候选）。请显式配置 hipfireExe。`)
  return ''
}

/* ------------------------------------------------------------ 子进程执行器 ---- */

/**
 * spawn 一个子进程，收集 stdout / stderr，支持超时与 signal 取消。
 *
 * ★ 为什么必须用 spawn 而不是 exec：
 *   · exec 把整条命令交给 shell 解析 → 提示词里的 & | > " 都会变成注入面；
 *   · exec 默认 maxBuffer 1 MB，hipfire 的进度输出很容易超；
 *   · prompt 含空格 / 中文 / 引号时，spawn 传数组参数是唯一安全做法。
 *
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}>}
 */
export function runProcess(exe, args, { timeoutMs, signal, log = noopLog } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`无法启动 hipfire（${exe}）：${error?.message ?? error}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const kill = () => {
      try { child.kill('SIGKILL') } catch { /* 已经退出了 */ }
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onAbort() {
      aborted = true
      log('info', '收到取消信号，终止 hipfire 子进程')
      kill()
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        log('warn', `hipfire 执行超时（${timeoutMs} ms），终止子进程`)
        kill()
      }, timeoutMs)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    // stderr 里带进度条（\r 刷新的百分比），只留最后一段有意义的信息
    child.stdout?.on('data', (buf) => { stdout += buf.toString('utf8') })
    child.stderr?.on('data', (buf) => { stderr += buf.toString('utf8') })

    child.on('error', (error) => {
      fail(new Error(`hipfire 进程出错（${exe}）：${error?.message ?? error}`))
    })
    child.on('close', (code) => { finish({ code, stdout, stderr, timedOut, aborted }) })
  })
}

/**
 * 从 hipfire 的输出里抠出一行**人话**错误信息。
 *
 * hipfire 的 stderr 混着：GPU 信息、进度条（\r 刷新、超长）、以及真正的错误。
 * 直接整段抛给用户会淹没重点 → 这里按"最像错误的那条"来挑。
 */
export function extractErrorMessage(stdout, stderr) {
  const raw = `${stderr}\n${stdout}`
  // 进度条用 \r 刷新，先按 \r 和 \n 拆开，再去掉纯百分比的行
  const lines = raw
    .split(/[\r\n]+/u)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !/^\d+\.\d+%\s/u.test(l))              // 进度行
    .filter((l) => !/^GPU dev \d+/u.test(l))              // GPU 信息行
    .filter((l) => !/pre-compiled kernels/u.test(l))
    .filter((l) => !/^ETA\s/u.test(l))

  if (lines.length === 0) {
    // 全被过滤掉了 → 退而求其次：截取 stderr 尾部
    const tail = String(stderr).replace(/\r/gu, '\n').split('\n').filter((l) => l.trim() !== '')
    return tail.slice(-3).join('\n').slice(0, 500) || '(hipfire 没有输出任何错误信息)'
  }
  // 优先挑含 error / fail / not found / refused / 中文错误词的行
  const key = /error|fail|cannot|unable|not found|refused|missing|invalid|unsupported|OOM|out of memory|错误|失败|找不到|不支持|拒绝|超时/iu
  const hit = lines.filter((l) => key.test(l))
  const chosen = hit.length > 0 ? hit : lines.slice(-3)
  return chosen.join('\n').slice(0, 800)
}

/* ------------------------------------------------- 模型预检（防静默下载） ---- */

/**
 * ★★ 出图前先确认模型在本地 —— 这是实测事故的防线。
 *
 * 事故：`hipfire img flux.schnell:1` 在模型缺失时**不报错**，而是静默下载
 * 23.8 GB。在插件 600 秒超时里表现为"没有任何反馈"，最后只报超时；
 * 并且会在模型目录留下半截 `.part` 文件。
 *
 * ⚠ 判定依据必须是 `hipfire list --json` 的**结构化字段**，不能靠字符串匹配：
 *   实测 `hipfire list`（无 --json）会把 registry 里**全部 89 个模型**都打印出来，
 *   于是 `out.includes('flux.schnell:1')` 对**未下载**的模型也返回 true → 误判 ✗
 *   ✓ 而 `list --json` 明确分成：
 *       models   = 本地已下载
 *       registry = 远端目录，每项带 downloaded: true/false
 *
 * @returns {Promise<{local:boolean, known:boolean}>}
 *   local=true 表示确认在本地；known=false 表示预检本身没跑成（调用方据此放行）
 */
export async function checkModelLocal(exe, model, { signal, log = noopLog } = {}) {
  const tag = String(model ?? '').trim()
  if (tag === '') return { local: false, known: true }

  // 传的是 .hfq 文件路径时没法用 registry 判定 → 直接看文件在不在
  if (/\.hfq$/iu.test(tag) || tag.includes('/') || tag.includes('\\')) {
    try {
      const stat = await fsp.stat(tag)
      return { local: stat.isFile(), known: true }
    } catch {
      return { local: false, known: true }
    }
  }

  try {
    const result = await runProcess(exe, ['list', '--json'], { timeoutMs: 30000, signal, log })
    if (result.code !== 0) return { local: true, known: false }

    // stdout 可能混入别的行 → 取第一个能解析成 JSON 对象的花括号段
    const text = String(result.stdout ?? '')
    const start = text.indexOf('{')
    if (start < 0) return { local: true, known: false }
    let payload
    try {
      payload = JSON.parse(text.slice(start))
    } catch {
      return { local: true, known: false }
    }

    const localList = Array.isArray(payload?.models) ? payload.models : null
    if (localList !== null) {
      const hit = localList.some((entry) => {
        const t = String(entry?.tag ?? '')
        const n = String(entry?.name ?? '')
        return t === tag || n === tag || n === path.basename(tag)
      })
      if (!hit) log('info', `hipfire 预检：模型「${tag}」不在本地（本地共 ${localList.length} 个）`)
      return { local: hit, known: true }
    }

    // 回退：看 registry 里的 downloaded 标记
    const registry = Array.isArray(payload?.registry) ? payload.registry : null
    if (registry !== null) {
      const entry = registry.find((e) => String(e?.tag ?? '') === tag)
      if (entry === undefined) return { local: false, known: true }
      const dl = entry?.downloaded === true
      if (!dl) log('info', `hipfire 预检：模型「${tag}」在 registry 里但未下载`)
      return { local: dl, known: true }
    }

    return { local: true, known: false }
  } catch {
    return { local: true, known: false }   // 预检失败 → 放行，不挡功能
  }
}

/* --------------------------------------------------------------- HTTP 通道 ---- */

/** 带超时的 fetch（尊重 signal）。 */
async function fetchJson(url, { method = 'GET', body, headers, timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  // ★ 2026-10-10 修 bug：**绝不能把 `signal.reason` 原样转发**。
  //   DSH 传入的 abort reason 可能是**普通对象**，原样 abort(reason) 会让 fetch 直接
  //   reject 那个对象，宿主 `String()` 之后就成了 `Error: [object Object]`（零信息量）。
  //   index.js 里已为同款问题加了 `cancelReason()`，这里是漏网的一处 —— 归一化成 Error。
  const onAbort = () => {
    const reason = signal?.reason
    controller.abort(reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' && reason !== '' ? reason : '已取消'))
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, { method, body, headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** hipfire HTTP 服务在不在（探测 /health）。 */
export async function probeHipfireHttp(cfg, signal) {
  const base = String(cfg.hipfireUrl ?? '').replace(/\/+$/u, '')
  if (base === '') return false
  try {
    const res = await fetchJson(`${base}/health`, {
      timeoutMs: Number(cfg.hipfireProbeMs ?? 4000),
      signal,
    })
    return res.ok
  } catch {
    return false
  }
}

/** base64 → Buffer，解不出来明确报错。 */
function decodeB64(text, log = noopLog) {
  try {
    return Buffer.from(String(text), 'base64')
  } catch (error) {
    throw new Error(`hipfire 返回的 b64_json 解码失败：${error?.message ?? error}`)
  }
}

/**
 * HTTP 出图：POST /v1/images/generations（图生图走 /v1/images/edits）。
 *
 * @returns {Promise<{ok:true, files:string[]}|{ok:false, error:string}>}
 */
async function generateViaHttp(cfg, req, { signal, log = noopLog, outDir }) {
  const base = String(cfg.hipfireUrl ?? '').replace(/\/+$/u, '')
  const timeoutMs = Number(cfg.hipfireTimeoutMs ?? 600000)
  const hasRef = Array.isArray(req.references) && req.references.length > 0

  if (hasRef) {
    // ── 图生图：multipart/form-data，端点 /v1/images/edits（仅 FLUX.2 Klein）
    const form = new FormData()
    for (const refPath of req.references.slice(0, 4)) {
      let bytes
      try {
        bytes = await fsp.readFile(refPath)
      } catch (error) {
        return { ok: false, error: `读不到参考图：${refPath}（${error?.message ?? error}）` }
      }
      form.append('image', new Blob([bytes]), path.basename(refPath))
    }
    form.append('prompt', req.prompt)
    form.append('response_format', 'b64_json')
    form.append('n', '1')
    if (Number.isFinite(req.width)) form.append('width', String(req.width))
    if (Number.isFinite(req.height)) form.append('height', String(req.height))
    if (Number.isFinite(req.steps)) form.append('steps', String(req.steps))
    if (Number.isFinite(req.seed)) form.append('seed', String(req.seed))

    let res
    try {
      res = await fetchJson(`${base}/v1/images/edits`, {
        method: 'POST',
        body: form,
        timeoutMs,
        signal,
      })
    } catch (error) {
      return { ok: false, error: `连接 hipfire 服务失败（${base}）：${error?.message ?? error}` }
    }
    return await handleHttpImageResponse(cfg, res, req, log, outDir, '图生图')
  }

  // ── 文生图：JSON body
  const payload = {
    prompt: req.prompt,
    n: 1,                        // 上游强制：必须为 1
    response_format: 'b64_json', // 上游强制：必须 b64_json
  }
  if (typeof cfg.hipfireImgModel === 'string' && cfg.hipfireImgModel.trim() !== '') {
    // model 必须是服务端**已加载**的那个；给了但没加载服务端会回错，这正是我们要的明确失败
    payload.model = cfg.hipfireImgModel.trim()
  }
  if (Number.isFinite(req.width) && Number.isFinite(req.height)) {
    payload.size = `${req.width}x${req.height}`
  }
  if (Number.isFinite(req.steps)) payload.steps = req.steps
  if (Number.isFinite(req.seed)) payload.seed = req.seed

  let res
  try {
    res = await fetchJson(`${base}/v1/images/generations`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs,
      signal,
    })
  } catch (error) {
    return { ok: false, error: `连接 hipfire 服务失败（${base}）：${error?.message ?? error}` }
  }
  return await handleHttpImageResponse(cfg, res, req, log, outDir, '文生图')
}

/** 解析 HTTP 图像响应（两个端点响应同构）→ 解码落盘 → 返回路径。 */
async function handleHttpImageResponse(cfg, res, req, log, outDir, kind) {
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 600)
    try {
      const parsed = JSON.parse(text)
      detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? detail
    } catch { /* 不是 JSON，就原样用 */ }
    return { ok: false, error: `hipfire 拒绝这次请求（HTTP ${res.status}，${kind}）：${detail}` }
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, error: `hipfire 返回了看不懂的内容：${text.slice(0, 300)}` }
  }

  const items = Array.isArray(payload?.data) ? payload.data : []
  if (items.length === 0) {
    return { ok: false, error: `hipfire 报告成功但没有图片数据：${text.slice(0, 300)}` }
  }

  await fsp.mkdir(outDir, { recursive: true })
  const files = []
  for (const item of items.slice(0, 1)) { // 插件约定：一次只生一张
    if (typeof item?.b64_json !== 'string' || item.b64_json === '') {
      return { ok: false, error: 'hipfire 响应里没有 b64_json 字段，无法取图' }
    }
    const bytes = decodeB64(item.b64_json, log)
    // 尺寸以响应里的实际值为准（服务端可能按对齐规则微调过）
    const w = Number.isFinite(item.width) ? item.width : req.width
    const h = Number.isFinite(item.height) ? item.height : req.height
    const target = await uniquePath(outDir, buildFilename(req.prompt, cfg, w, h, files.length + 1))
    await fsp.writeFile(target, bytes)
    files.push(target)
    log('info', `hipfire(HTTP) 落盘 ${target}（${bytes.length} 字节）`)
  }
  return { ok: true, files }
}

/* ---------------------------------------------------------------- CLI 通道 ---- */

/**
 * 命令行出图：`hipfire img <MODEL> <PROMPT> --width … -o <OUT> -j`
 *
 * ⚠ **参数顺序是硬要求**：上游 `hipfire img --help` 的 NOTE 明确写
 *   「the prompt is a greedy trailing positional and swallows anything after it」，
 *   所以 `--image` / `--width` / `--height` / `--steps` / `--seed` / `-o` / `-j`
 *   **全部必须放在 prompt 之前**。
 */
async function generateViaCli(cfg, req, { signal, log = noopLog, outDir }) {
  const exe = await resolveHipfireExe(cfg, log)
  if (exe === '') {
    return {
      ok: false,
      error:
        'hipfire 出图不可用：没找到 hipfire 可执行文件。\n'
        + '请在配置里显式指定 hipfireExe（例如 X:\\hipfire\\engine\\hipfire.exe），'
        + '或设置环境变量 HIPFIRE_HOME / HIPFIRE_EXE。',
    }
  }

  const model = String(cfg.hipfireImgModel ?? '').trim()
  if (model === '') {
    return { ok: false, error: 'hipfire 出图不可用：hipfireImgModel 为空，请在配置里指定模型。可填 registry tag（如 flux.schnell:1）或本地 hfq trunk pack 路径（如 X:\hipfire\models\flux-klein-transformer.hfq）。' }
  }

  // ★★ 防静默下载：模型不在本地就当场报错，绝不触发 hipfire 的自动拉取
  if (cfg.hipfirePrecheckModel !== false) {
    const { local, known } = await checkModelLocal(exe, model, { signal, log })
    if (known && !local) {
      // 本地 hfq 路径写错 → 提示路径问题；registry tag 未下载 → 提示 pull
      const isPath = /\.hfq$/iu.test(model) || model.includes('/') || model.includes('\\')
      if (isPath) {
        return {
          ok: false,
          error:
            `hipfire 模型文件不存在：${model}\n`
            + '（这是本地 hfq trunk pack 路径。官方规定 MODEL 要指向 '
            + '`<base>-transformer.hfq`，且同目录下需有同名的 '
            + '`-qwen3.hfq` / `-vae.hfq` sidecar 包。）\n'
            + '请检查路径是否写对、文件是否已打包生成。',
        }
      }
      return {
        ok: false,
        error:
          `hipfire 模型「${model}」不在本地。\n`
          + '（hipfire 遇到缺失模型会**自动开始下载**，动辄几十 GB 且界面无反馈，'
          + '所以这里提前拦住，没有触发下载。）\n'
          + `如需使用，请先手动拉取：hipfire pull ${model}\n`
          + '或把 hipfireImgModel 改成本地已有的模型 / hfq 路径。',
      }
    }
  }

  await fsp.mkdir(outDir, { recursive: true })
  const out = await uniquePath(outDir, buildFilename(req.prompt, cfg, req.width, req.height, 1))

  // ★ 选项**全部**放在 prompt 之前（见上面的 NOTE）
  const args = ['img']
  if (Array.isArray(req.references) && req.references.length > 0) {
    for (const refPath of req.references.slice(0, 4)) {
      args.push('--image', toPosix(refPath))
    }
  }
  if (Number.isFinite(req.width)) args.push('--width', String(req.width))
  if (Number.isFinite(req.height)) args.push('--height', String(req.height))
  if (Number.isFinite(req.steps) && req.steps > 0) args.push('--steps', String(req.steps))
  if (Number.isFinite(req.seed)) args.push('--seed', String(req.seed))
  if (typeof cfg.hipfireBackend === 'string' && cfg.hipfireBackend !== '') {
    args.push('--backend', cfg.hipfireBackend)
  }
  args.push('-o', toPosix(out))
  args.push('-j')
  // prompt 必须**整体**作为一个参数（greedy trailing positional）
  args.push(model, req.prompt)

  const timeoutMs = Number(cfg.hipfireTimeoutMs ?? 600000)
  log('info', `hipfire(CLI) 执行：${exe} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)

  let result
  try {
    result = await runProcess(exe, args, { timeoutMs, signal, log })
  } catch (error) {
    return { ok: false, error: `hipfire 执行失败：${error?.message ?? error}` }
  }

  if (result.aborted) return { ok: false, error: '已取消' }
  if (result.timedOut) {
    return { ok: false, error: `hipfire 出图超时（已等 ${Math.round(timeoutMs / 1000)} 秒）。首次运行要加载权重，可稍后重试。` }
  }
  if (result.code !== 0) {
    return { ok: false, error: `hipfire 退出码 ${result.code}：${extractErrorMessage(result.stdout, result.stderr)}` }
  }

  // -j 会给一行 JSON；解析出来确认产物路径
  const jsonPath = extractJsonPathFromCliOutput(result.stdout)
  const finalPath = jsonPath !== null ? jsonPath : out

  // 不管 JSON 怎么说，落盘文件必须**真实存在**才算成功
  try {
    const stat = await fsp.stat(finalPath)
    if (!stat.isFile() || stat.size === 0) {
      return { ok: false, error: `hipfire 报告成功，但产物文件不存在或为空：${finalPath}` }
    }
    log('info', `hipfire(CLI) 落盘 ${finalPath}（${stat.size} 字节）`)
    return { ok: true, files: [finalPath] }
  } catch {
    return {
      ok: false,
      error:
        `hipfire 退出码为 0，但没找到产物文件：${finalPath}\n`
        + `stdout 片段：${String(result.stdout).slice(-300) || '(空)'}`,
    }
  }
}

/** 从 `-j` 的 stdout 里抠出输出文件路径（字段名兼容多种写法）。 */
export function extractJsonPathFromCliOutput(stdout) {
  const text = String(stdout ?? '')
  // 取最后一个 { 开头的完整 JSON 行（前面可能混着进度输出）
  const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i])
      const p = obj?.output ?? obj?.out ?? obj?.path ?? obj?.file ?? obj?.png ?? null
      if (typeof p === 'string' && p !== '') return p
    } catch { /* 这行不是完整 JSON，继续 */ }
  }
  // 兜底：整段里找 json 对象
  const m = /\{[^{}]*"(?:output|out|path|file|png)"\s*:\s*"([^"]+)"[^{}]*\}/u.exec(text)
  if (m !== null) return m[1]
  return null
}

/* ------------------------------------------------------------- 文件名与落盘 ---- */

/** 安全文件名主体（与插件既有 safeStem 精神一致，避免引入循环依赖故本地实现）。 */
function safeStem(prompt) {
  const cleaned = String(prompt ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return '无题'
  if (/^[\x20-\x7e]+$/u.test(cleaned)) {
    let out = ''
    for (const word of cleaned.split(' ')) {
      if (out.length + word.length + 1 > 34) break
      out = `${out} ${word}`.trim()
    }
    return out || cleaned.slice(0, 34)
  }
  return cleaned.slice(0, 22)
}

/** 落盘文件名：`<提示词>_<前缀>_<w>x<h>_01.png`。 */
export function buildFilename(prompt, cfg, width, height, index) {
  const prefix = typeof cfg?.hipfireFilePrefix === 'string' && cfg.hipfireFilePrefix !== ''
    ? cfg.hipfireFilePrefix
    : 'Hipfire'
  return `${safeStem(prompt)}_${prefix}_${width}x${height}_${String(index).padStart(2, '0')}.png`
}

/** 找一个不冲突的落盘路径。 */
export async function uniquePath(dir, filename) {
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

/* ------------------------------------------------------------------- 入口 ---- */

/**
 * 用 hipfire 出图。
 *
 * @param {object} cfg  合并后的插件配置
 * @param {object} req  { prompt, negative, width, height, steps, seed, references }
 * @param {AbortSignal} signal
 * @returns {Promise<{ok:true, files:string[]} | {ok:false, error:string}>}
 */
export async function generateWithHipfire(cfg, req, signal, log = noopLog) {
  const prompt = String(req?.prompt ?? '').trim()
  if (prompt === '') return { ok: false, error: 'prompt 不能为空：请描述你想画什么。' }

  // ★ negative：hipfire 两个接口都没有这个参数 —— 明确报错，不静默丢弃
  if (typeof req?.negative === 'string' && req.negative.trim() !== '') {
    return {
      ok: false,
      error:
        '当前的 hipfire 出图后端**不支持负面提示词（negative）**：\n'
        + 'hipfire 的 img 命令与 HTTP 接口都没有这个参数（上游 help / SERVE.md 均无）。\n'
        + '请去掉 negative 参数后重试，或改用 imageBackend: \'comfyui\'。',
    }
  }

  const width = Number.isFinite(req?.width) ? alignSize(req.width) : undefined
  const height = Number.isFinite(req?.height) ? alignSize(req.height) : undefined
  const normalized = {
    prompt,
    width,
    height,
    steps: Number.isFinite(req?.steps) ? Math.trunc(req.steps) : undefined,
    seed: Number.isFinite(req?.seed) ? Math.trunc(req.seed) : undefined,
    references: Array.isArray(req?.references) ? req.references.filter((p) => typeof p === 'string' && p !== '') : [],
  }
  const outDir = String(cfg.outputDir ?? '.')

  const transport = String(cfg.hipfireTransport ?? 'auto').toLowerCase()

  if (transport === 'cli') {
    return await generateViaCli(cfg, normalized, { signal, log, outDir })
  }

  if (transport === 'http') {
    const online = await probeHipfireHttp(cfg, signal)
    if (!online) {
      return {
        ok: false,
        error:
          `hipfire HTTP 服务不在线（${cfg.hipfireUrl}）。\n`
          + '请先启动它：hipfire serve 127.0.0.1 11580 -d\n'
          + '（注意：serve 前台会阻塞，要用 -d 后台运行；且需 daemon 已安装。）',
      }
    }
    return await generateViaHttp(cfg, normalized, { signal, log, outDir })
  }

  // auto：HTTP 优先，不通则回退 CLI
  const online = await probeHipfireHttp(cfg, signal)
  if (online) return await generateViaHttp(cfg, normalized, { signal, log, outDir })

  log('info', 'hipfire HTTP 服务不在线 → 回退 CLI 通道')
  const cliResult = await generateViaCli(cfg, normalized, { signal, log, outDir })
  if (cliResult.ok) return cliResult

  // CLI 也失败 → 给一条同时含两条通道原因的提示，方便定位
  return {
    ok: false,
    error:
      `hipfire 两条通道都不可用。\n`
      + `· HTTP（${cfg.hipfireUrl}）：服务不在线，未尝试请求。\n`
      + `· CLI：${cliResult.error}\n`
      + '提示：HTTP 通道需先 `hipfire serve 127.0.0.1 11580 -d`；'
      + 'CLI 通道需能自动找到 hipfire（或用 hipfireExe 显式指定）。',
  }
}

/** 给自测用的内部导出。 */
export const __internal = {
  HIPFIRE_DEFAULTS,
  HIPFIRE_SIZE_MULTIPLE,
  alignSize,
  parseSizeString,
  resolveHipfireExe,
  runProcess,
  extractErrorMessage,
  extractJsonPathFromCliOutput,
  buildFilename,
  uniquePath,
  probeHipfireHttp,
  checkModelLocal,
  generateViaCli,
  generateViaHttp,
  toPosix,
}
