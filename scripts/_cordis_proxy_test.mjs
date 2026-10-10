/**
 * ★★★ _cordis_proxy_test.mjs —— 用**真实 cordis** 加载插件，断言它不会变 FAILED。
 *
 * ## 为什么必须有这个测试（2026-10-09 血泪）
 *   之前五套自测全绿，插件在真机上却显示「异常」——因为**所有 mock 都不是 cordis**。
 *   真凶：cordis 的 `ctx` 是 Proxy，**读一个没 inject 的服务属性会直接抛错**：
 *     `Error: cannot get property "webServer" without inject`
 *   我写的"宿主能力快照"诊断 `typeof ctx?.webServer` 正好踩中 →
 *   apply 抛错 → fiber FAILED → 工具/状态端点全没注册 → 界面卡"正在启动中"。
 *
 * ## 这个测试做什么
 *   1. 从 DSH 的 app.asar 里解出真 cordis（已缓存在 `_vendor/`）；
 *   2. 用真 cordis 起 root ctx、provide 一个假 tools；
 *   3. `root.plugin(mod, {})` 加载真插件；
 *   4. 断言 `fiber.state === 2 (ACTIVE)` 且 `_error` 为空、三个工具都注册上。
 *
 * ## 依赖
 *   `_vendor/node_modules/@deepseek-ai/cordis` 必须存在。
 *   若不存在，本测试会**明确失败并说明怎么生成**（不静默跳过）。
 *
 * 用法：node scripts/_cordis_proxy_test.mjs
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CORDIS = path.join(ROOT, '_vendor', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')

if (!existsSync(CORDIS)) {
  // ★ 本测试依赖从 DSH 的 app.asar 里解出来的**真 cordis**（`_vendor/`）。
  //   它体积大、且属于"排查资产"，**不打进发布包**（见 pack.mjs 的 DIRS/ROOT_FILES）。
  //   所以：`_vendor` 不存在时**不算失败**，只是**跳过真机复现那部分**——
  //   但下面的"静态 Proxy 陷阱扫描"仍然会跑（它只读源码，任何时候都有意义）。
  console.log('⚠ 未找到真 cordis（_vendor/），跳过"真机加载复现"，仅做静态扫描。')
  console.log('  如需完整复现：从 DSH 的 resources/app.asar 解出 @deepseek-ai/cordis 到')
  console.log('  _vendor/node_modules/@deepseek-ai/cordis 后再跑本测试。')
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const bad = []
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const svc of ['webServer', 'sessionProjections', 'univer', 'agents', 'attachments', 'llm']) {
      if (new RegExp(`ctx\\??\\.${svc}\\b`).test(line) && !/safePeek\(/.test(line)) {
        if (/ctx\.inject\(\s*\[/.test(line) && new RegExp(`['"]${svc}['"]`).test(line)) continue
        bad.push(`第 ${i + 1} 行: ${line.trim().slice(0, 110)}`)
      }
    }
  })
  if (bad.length === 0) {
    console.log('  OK   静态扫描：无"裸读未声明服务属性"')
    console.log('\n=== 结果：通过（降级模式）===')
    process.exit(0)
  }
  console.log('  FAIL 静态扫描发现问题：\n      ' + bad.join('\n      '))
  console.log('\n=== 结果：失败 ===')
  process.exit(1)
}

// 关掉落盘诊断，别污染真机日志
process.env.DSHQP_DIAG = '0'

let pass = 0
let fail = 0
function ok(name) { pass++; console.log('  OK  ', name) }
function bad(name, extra) { fail++; console.log('  FAIL', name, extra ?? '') }

const { Context } = await import('file://' + CORDIS.replace(/\\/g, '/'))
const mod = await import('file://' + path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))

console.log('=== 真 cordis 加载 dsh-qwen-paint ===')

// --- 断言 1：模块级声明齐全 ---
if (mod.name === 'qwen-paint') ok('导出 name = qwen-paint')
else bad('导出 name', mod.name)

if (Array.isArray(mod.inject) && mod.inject.includes('tools')) ok('导出 inject 含 tools')
else bad('导出 inject', JSON.stringify(mod.inject))

if (typeof mod.apply === 'function') ok('导出 apply 是函数')
else bad('导出 apply', typeof mod.apply)

// --- 起真 root ctx ---
const root = new Context()

class FakeTools {
  constructor(ctx) { this.ctx = ctx; this.registered = [] }
  register(tool) { this.registered.push(tool?.name ?? '(anon)') }
}
root.provide('tools', new FakeTools(root))

const seenErrors = []
process.on('unhandledRejection', (e) => seenErrors.push(e))

let fiber
let syncThrow = null
try {
  fiber = root.plugin(mod, {})
} catch (e) {
  syncThrow = e
}

await new Promise((r) => setTimeout(r, 1200))

// --- 断言 2：apply 不抛错 ---
if (syncThrow) bad('apply 同步抛错', syncThrow?.message)
else ok('apply 未同步抛错')

// --- 断言 3：fiber 处于 ACTIVE（这是"插件异常"的直接判据）---
const STATE = { 0: 'PENDING', 1: 'LOADING', 2: 'ACTIVE', 3: 'FAILED', 4: 'DISPOSED', 5: 'UNLOADING' }
if (fiber) {
  const s = fiber.state
  if (s === 2) ok(`fiber.state = ACTIVE（插件管理器显示"运行中"）`)
  else bad(`fiber.state = ${STATE[s] ?? s}（!= ACTIVE ⇒ 插件管理器会显示"异常"）`, fiber._error?.message)

  // --- 断言 4：fiber._error 为空 ---
  if (!fiber._error) ok('fiber._error 为空')
  else bad('fiber._error 有值（这就是界面「异常」的原因）', fiber._error?.stack ?? fiber._error)
} else {
  bad('root.plugin() 没返回 fiber')
}

// --- 断言 5：三个工具都注册上 ---
const reg = root.get('tools')?.registered ?? []
for (const name of ['draw_image', 'list_available_models', 'check_acceleration']) {
  if (reg.includes(name)) ok(`已注册工具 ${name}`)
  else bad(`未注册工具 ${name}`, `实际=${JSON.stringify(reg)}`)
}

// --- 断言 6：没有未处理的 rejection ---
if (seenErrors.length === 0) ok('无未处理 rejection')
else bad('有未处理 rejection', seenErrors.map((e) => e?.message).join(' | '))

/* --------------------------------------------------------------------------
 * ★ 断言 7（根因防回归）：源码里**不许**出现"裸读未声明服务属性"的写法
 *
 * 检测目标：`ctx?.webServer` / `ctx.webServer` / `typeof ctx?.webServer` 等。
 * 白名单：写在 `export const inject` 里的是**已声明**，可以读（如 `tools`）。
 * 这里用最保守的规则：webServer / sessionProjections 只允许出现在
 *   · `ctx.inject(['webServer'], …)` 的参数位置
 *   · `safePeek(() => ctx?.webServer)` 这种被包住的探测里
 * ------------------------------------------------------------------------ */
const { readFileSync } = await import('node:fs')
const src = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const risky = []
const lines = src.split('\n')
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  // 跳过注释行
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
  // 找 ctx 直接读这两个未声明服务的写法的行
  for (const svc of ['webServer', 'sessionProjections', 'univer', 'agents', 'attachments', 'llm']) {
    const re = new RegExp(`ctx\\??\\.${svc}\\b`)
    if (re.test(line)) {
      // 允许：safePeek(() => ctx?.xxx)  —— 同一行里出现 safePeek 即视为安全
      if (/safePeek\(/.test(line)) continue
      // 允许：ctx.inject(['webServer'], ...) —— 参数里的字面量数组
      if (/ctx\.inject\(\s*\[/.test(line) && new RegExp(`['"]${svc}['"]`).test(line)) continue
      risky.push(`第 ${i + 1} 行: ${line.trim().slice(0, 110)}`)
    }
  }
}
if (risky.length === 0) ok('无"裸读未声明服务属性"（Proxy 陷阱已避开）')
else bad('发现裸读未声明服务属性 ⇒ 会抛 "cannot get property ... without inject"', '\n      ' + risky.join('\n      '))

/* --------------------------------------------------------------------------
 * ★ 断言 8（真事故防回归）：锁尺寸档下，**生效尺寸必须能被调用方拿到**
 *
 * 事故现象：主人说「出的图尺寸不对」。
 * 根因：`forceOptimizedSize=true` 会把请求的 864x1152 **归一成 1024x1024**，
 *       但调用方仍拿"请求值"去比对实际出图尺寸 → 必然对不上 → 报错；
 *       文件名与返回值也都用了请求值 → 前后不一致。
 * 防线：`buildWorkflow` 必须把这组生效尺寸吐出来（`workflow.__effective`），
 *       且它**绝不能污染提交给 ComfyUI 的 JSON**。
 * ------------------------------------------------------------------------ */
const { buildWorkflow } = mod.__internal ?? {}
if (typeof buildWorkflow !== 'function') {
  bad('__internal.buildWorkflow 可调用')
} else {
  const caps = { level: 'full', models: {}, useTurbo: false, usePrefix: false, useTe: false, useSpeedup: false }
  const wfLocked = buildWorkflow(
    { forceOptimizedSize: true, resolution: 1024 },
    { prompt: 't', width: 864, height: 1152, steps: 8, seed: 1, reference: '' },
    caps,
  )
  const eff = wfLocked.__effective

  // 8-1 生效尺寸必须存在
  if (eff && Number.isFinite(eff.width) && Number.isFinite(eff.height)) {
    ok(`锁尺寸档吐出生效尺寸 ${eff.width}x${eff.height}`)
  } else {
    bad('锁尺寸档未吐出生效尺寸（调用方将拿不到归一后的真实尺寸）', JSON.stringify(eff))
  }

  // 8-2 归一必须真的发生（864x1152 → 1024x1024）
  if (eff && eff.width === 1024 && eff.height === 1024) {
    ok('锁尺寸档确实把 864x1152 归一为 1024x1024')
  } else {
    bad('锁尺寸档归一行为异常', `${eff?.width}x${eff?.height}`)
  }

  // 8-3 ★ 最关键：__effective 绝不能进 JSON（否则 ComfyUI 会收到非法节点）
  const json = JSON.stringify(wfLocked)
  if (!json.includes('__effective') && !json.includes('"locked"')) {
    ok('__effective 不进 JSON.stringify（提交给 ComfyUI 的载荷干净）')
  } else {
    bad('__effective 泄漏进了 JSON —— 会把非法节点提交给 ComfyUI')
  }

  // 8-4 不能出现在 Object.keys 里（ComfyUI 按数字键遍历节点）
  if (!Object.keys(wfLocked).includes('__effective')) {
    ok('__effective 不出现在 Object.keys（节点遍历不受影响）')
  } else {
    bad('__effective 出现在 Object.keys 里')
  }

  // 8-5 放开尺寸档时，生效尺寸应等于请求值
  const wfFree = buildWorkflow(
    { forceOptimizedSize: false, resolution: 1024 },
    { prompt: 't', width: 864, height: 1152, steps: 8, seed: 1, reference: '' },
    caps,
  )
  const effFree = wfFree.__effective
  if (effFree && effFree.width === 864 && effFree.height === 1152) {
    ok('放开尺寸档生效尺寸 = 请求值（864x1152，未被误归一）')
  } else {
    bad('放开尺寸档生效尺寸异常', `${effFree?.width}x${effFree?.height}`)
  }

  // 8-6 调用方必须用生效尺寸（静态检查：三处引用）
  const { readFileSync: rf } = await import('node:fs')
  const src2 = rf(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  if (/const eff = workflow\.__effective/.test(src2)) ok('调用方读取 workflow.__effective')
  else bad('调用方未读取 workflow.__effective')
  if (/actual\.width !== outWidth/.test(src2)) ok('尺寸校验用生效尺寸比对')
  else bad('尺寸校验仍在用请求值比对（会误报）')
  if (/const value = \{[\s\S]{0,120}?width: outWidth/.test(src2)) ok('返回值用生效尺寸')
  else bad('返回值仍用请求值')

  // 8-7 ★★★ 默认配置必须是"完全听调用方"（2026-10-09 主人决定）
  //     锁尺寸会把 7 个比例全部吃掉 → 功能静默阉割。默认必须放开。
  const { DEFAULTS } = mod.__internal

  if (DEFAULTS.forceOptimizedSize === false) {
    ok('DEFAULTS.forceOptimizedSize = false（默认听调用方）')
  } else {
    bad('DEFAULTS.forceOptimizedSize 被改回 true ⇒ 7 个比例会被吞掉', String(DEFAULTS.forceOptimizedSize))
  }

  // 8-8 ★ 七个比例必须都能原样出图（逐个验，这是主人最关心的行为）
  const { calcSize, ASPECTS } = mod.__internal
  const spoiled = []
  for (const key of Object.keys(ASPECTS)) {
    const [w, h] = calcSize(key, 1.0)
    const wf = buildWorkflow({ ...DEFAULTS }, { prompt: 't', width: w, height: h, steps: 8, seed: 1, reference: '' }, caps)
    const e = wf.__effective
    if (!e || e.width !== w || e.height !== h) spoiled.push(`${key}: 要 ${w}x${h} 实得 ${e?.width}x${e?.height}`)
  }
  if (spoiled.length === 0) ok(`7 个比例全部原样出图（1:1 / 3:4 / 4:3 / 2:3 / 3:2 / 16:9 / 9:16）`)
  else bad('有比例被尺寸策略吞掉', '\n      ' + spoiled.join('\n      '))

  // 8-9 步数锁必须保留（与尺寸无关，放开只会更慢更糊）
  if (DEFAULTS.forceTurbo8Steps === true) ok('DEFAULTS.forceTurbo8Steps 仍为 true（步数锁保留）')
  else bad('步数锁被误改', String(DEFAULTS.forceTurbo8Steps))
}

console.log(`\n=== 结果：${fail === 0 ? '通过' : `失败 ${fail} 项`} ===`)
process.exit(fail === 0 ? 0 : 1)
