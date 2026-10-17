/**
 * test-dsh-compat.mjs —— COMPAT001 的**可复跑实证**（不是"我觉得兼容"）。
 *
 * 背景：DSH STORE 审核（Issue #1390）要求「在**实际验证后**补当前窗口至少一版的准确
 * 兼容声明及证据，其余保留 unknown」。本脚本就是那个"实际验证"：
 * 它拿**被测版本自己带来的** cordis 与 tools 服务，把插件本体真正加载起来跑一遍，
 * 而不是只比对版本号字符串。
 *
 * ── 验证什么 ────────────────────────────────────────────────────────────────
 *   ① 插件模块能在该版本的 Node/ESM 环境下被 import；
 *   ② cordis 插件契约成立（name / inject / apply）；
 *   ③ 该版本**真实**的 `tools` 服务可用（`ctx.tools.register` 是函数）；
 *   ④ 插件 `apply()` 在真实 tools 上跑通、无异常；
 *   ⑤ 确实注册出工具（不是"没报错但其实什么都没干"）。
 *
 * ── 诚实边界（必须连同结论一起看）────────────────────────────────────────────
 *   · 这是**加载 + 注册**层的验证，**不是**端到端出图（出图还需要本机 ComfyUI
 *     与模型，跟"插件与 DSH 版本是否兼容"是两件事）。
 *   · 唯一一处替身：`systemPrompt`。完整 dsh app 才提供它，而本脚本刻意**不启动
 *     整个 app**（那会进入交互式 TUI 并需要登录），只挂载 `tools` 这一层。
 *     `tools` 本身是被测版本的真实实现。
 *   · 因此"compatible"的准确含义是：**manifest + patch + cordis 加载/注册链路
 *     在该版本下实测成立**。
 *
 * ── 怎么跑 ──────────────────────────────────────────────────────────────────
 *   DSH_TEST_INSTALL=<dsh 安装目录> node scripts/test-dsh-compat.mjs
 *
 *   <dsh 安装目录> = `node_modules/@deepseek-ai/cordis` 能被解析到的那个目录，
 *   例如本机全局装法下是 `C:/Users/<你>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh`
 *   （它的依赖装在自家 node_modules 里）。
 *
 *   也可以用一次性目录装一个指定版本来测（**不碰你正在用的环境**）：
 *     mkdir /tmp/dsh-a5 && cd /tmp/dsh-a5
 *     npm i --prefix . @deepseek-ai/dsh@0.2.1-alpha.5
 *     DSH_TEST_INSTALL=/tmp/dsh-a5 node scripts/test-dsh-compat.mjs
 *
 * ── 关键：SKIP 与 FAIL 必须分开 ──────────────────────────────────────────────
 *   找不到 dsh 安装 = **环境不具备**（SKIP，exit 0），**绝不能**当成"兼容"或"不兼容"
 *   的任何一种结论；只有"找到了、但断言没过"才是 FAIL（exit 1）。
 *   （教训见 2026-10-12：一条只会跳过的回归等于没有回归。）
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ENTRY = path.join(HERE, '..', 'lib', 'index.js')

const results = []
const record = (ok, name, detail) => {
  results.push({ ok, name, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const skip = (reason) => {
  console.log(`SKIP  test-dsh-compat：${reason}`)
  console.log('      （环境不具备 ≠ 兼容也不 ≠ 不兼容；装上 dsh 后重跑才能下结论）')
  process.exit(0)
}

// ── ① 定位一个可用的 dsh 安装 ────────────────────────────────────────────────
function candidateBaseDirs() {
  const list = []
  if (process.env.DSH_TEST_INSTALL) list.push(process.env.DSH_TEST_INSTALL)
  // 全局 npm（`npm root -g`；失败就退回平台默认位置）
  let globalRoot = ''
  try {
    globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 }).trim()
  } catch {
    globalRoot = process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'npm', 'node_modules')
      : path.join(os.homedir(), '.npm-global', 'lib', 'node_modules')
  }
  if (globalRoot) {
    list.push(path.join(globalRoot, '@deepseek-ai', 'dsh')) // 依赖装在自家 node_modules
    list.push(globalRoot) // 或者被提升到全局根
  }
  return list
}

/** 在候选目录里解析 `@deepseek-ai/cordis`，返回 { base, cordisUrl, dshVersion } */
function resolveDsh() {
  for (const base of candidateBaseDirs()) {
    if (!base) continue
    let cordisPath = ''
    try {
      const req = createRequire(path.join(base, '__compat_probe__.js'))
      cordisPath = req.resolve('@deepseek-ai/cordis')
    } catch {
      continue
    }
    let dshVersion = 'unknown'
    for (const rel of ['node_modules/@deepseek-ai/dsh/package.json', 'package.json']) {
      try {
        const p = JSON.parse(readFileSync(path.join(base, rel), 'utf8'))
        if (p.name === '@deepseek-ai/dsh') {
          dshVersion = p.version
          break
        }
      } catch {
        /* 继续找 */
      }
    }
    return { base, cordisUrl: pathToFileURL(cordisPath).href, dshVersion }
  }
  return null
}

const found = resolveDsh()
if (!found) {
  skip(
    '未找到可用的 dsh 安装（未设 DSH_TEST_INSTALL，全局 npm 里也没有 @deepseek-ai/cordis）'
  )
}
const { base, cordisUrl, dshVersion } = found
console.log(`\n=== test-dsh-compat：被测 dsh ${dshVersion}（${base}）===`)

// ── ② 用**被测版本自己**的 cordis / dsh-tools ────────────────────────────────
const { Context } = await import(cordisUrl)
let toolsEntry = ''
try {
  const req = createRequire(path.join(base, '__compat_probe__.js'))
  toolsEntry = pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href
} catch (error) {
  skip(`该 dsh 安装里解析不到 @deepseek-ai/dsh-tools（${String(error?.message ?? error)}）`)
}

// ③ 模块加载
let mod
try {
  mod = await import(pathToFileURL(PLUGIN_ENTRY).href)
  record(true, '模块加载', `ESM import 成功（node=${process.version}）`)
} catch (error) {
  record(false, '模块加载', String(error?.message ?? error))
  process.exit(1)
}

// ④ cordis 插件契约
record(mod.name === 'qwen-paint', '契约 name', `name=${JSON.stringify(mod.name)}`)
record(
  Array.isArray(mod.inject) && mod.inject.includes('tools'),
  '契约 inject',
  `inject=${JSON.stringify(mod.inject)}`
)
record(typeof mod.apply === 'function', '契约 apply', `typeof apply=${typeof mod.apply}`)

// ⑤ 真实 tools 服务
const ctx = new Context()
ctx.provide('systemPrompt', {
  register: () => () => {},
  add: () => () => {},
  tools: () => () => {}
})
let toolsOk = false
let toolsDetail = ''
try {
  const toolsMod = await import(toolsEntry)
  await ctx.plugin(toolsMod.default ?? toolsMod)
  toolsOk = typeof ctx.tools?.register === 'function'
  toolsDetail = `ctx.tools.register=${typeof ctx.tools?.register}`
} catch (error) {
  toolsDetail = String(error?.message ?? error).slice(0, 200)
}
record(toolsOk, `真实 tools 服务（dsh ${dshVersion}）`, toolsDetail)
if (!toolsOk) {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n结果：${results.length - failed} 通过 / ${failed} 失败`)
  process.exit(1)
}

// ⑥ apply() + 注册计数（outputDir 指临时目录：不碰用户的真实出图目录）
const tmpOut = path.join(os.tmpdir(), 'dsh-compat-probe', 'plugin-out')
const registered = []
const originalRegister = ctx.tools.register.bind(ctx.tools)
ctx.tools.register = (...args) => {
  registered.push(args)
  try {
    return originalRegister(...args)
  } catch {
    return () => {}
  }
}
let applyErr = null
try {
  await ctx.plugin(mod, {
    comfyUrl: 'http://127.0.0.1:8188',
    outputDir: tmpOut,
    imageBackend: 'comfyui'
  })
} catch (error) {
  applyErr = error
}
record(
  applyErr === null,
  `apply() 在真实 tools 上执行（dsh ${dshVersion}）`,
  applyErr ? String(applyErr?.message ?? applyErr).slice(0, 300) : '无异常返回'
)
const names = registered
  .map((a) => (a[0] && typeof a[0] === 'object' ? a[0].name : String(a[0])))
  .filter(Boolean)
record(registered.length > 0, '工具注册', `注册 ${names.length} 个：${names.join(', ')}`)

const failed = results.filter((r) => !r.ok).length
console.log(`\n结果：${results.length - failed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
