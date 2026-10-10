/**
 * 初始化链路 A/B 测试（DSH 官方模式版）
 * ─────────────────────────────────────────────────────────────
 * 目的：验证「初始化链路」在**宿主 API 不全 / 可选服务缺失**时
 *      会不会被掐死，以及**状态端点是否真的注册了**。
 *
 * ## 背景（为什么要有这个测试）
 *   本插件历史上两次被"初始化被掐死"坑到，界面表现为「一直卡在正在启动中」：
 *     ① `ctx.on` 不是函数 → 裸调用抛 TypeError → 掐死后面所有初始化（含状态端点）
 *     ② 用 `root.inject(['tools'], cb)` 包住全部初始化 → 该回调在本机 DSH 上**从不执行**
 *
 *   ⇒ 现在改成 DSH 官方模式：`export const inject = ['tools']` 声明依赖 +
 *     `apply(ctx)` 里**直接**注册（`ctx` 上保证有 `tools`）。
 *     本测试用 mock ctx 模拟宿主，断言"即使缺 ctx.on，也照样走到状态端点注册"。
 *
 * 用法：node scripts/_init_abort_test.mjs [要测的 index.js 路径]
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

process.env.DSHQP_DIAG = '0' // 别污染真实诊断文件

const target = process.argv[2] ?? path.resolve('lib/index.js')
const mod = await import(pathToFileURL(path.resolve(target)).href)

if (typeof mod.apply !== 'function') {
  console.error('✗ 模块没有导出 apply')
  process.exit(1)
}

const registered = []
const effectCalls = []
const injectCalls = []

// ★ 模拟 DSH 官方模式下的 ctx：**直接带 tools**（不需要 inject 才能拿到）
const ctx = {
  tools: { register: (t) => registered.push(t?.name ?? '(无名)') },
  effect: (fn, name) => {
    effectCalls.push(name ?? '(无名)')
    try { return fn() } catch { return undefined }
  },
  // ★★ 故意**不提供** ctx.on —— 模拟裁剪版/老版本宿主，验证 step 保护是否生效
  get: () => undefined,
  inject: (deps, cb) => {
    const d = Array.isArray(deps) ? deps.join(',') : String(deps)
    injectCalls.push(d)
    // 模拟"可选服务（webServer）已就绪" → 触发回调，让状态端点能注册
    if (d.includes('webServer') && typeof cb === 'function') cb(ctx)
  },
  sessionProjections: { stateOf: () => ({}) },
}

let threw = null
try {
  // ★ DSH 官方模式：ctx 就是 apply 的第一个参数（不再有 root.inject 包一层）
  mod.apply(ctx, {})
} catch (error) {
  threw = error
}

const reachedRoute = effectCalls.some((n) => String(n).includes('status-route'))
const hasInjectDecl = Array.isArray(mod.inject) && mod.inject.includes('tools')

console.log(`目标文件：${target}`)
console.log(`  模块导出 inject      ：${Array.isArray(mod.inject) ? JSON.stringify(mod.inject) : '(缺失)'}  ${hasInjectDecl ? '✅' : '❌'}`)
console.log(`  apply 抛错           ：${threw ? String(threw.message) : '否'}`)
console.log(`  已注册工具           ：${registered.join(', ') || '(无)'}`)
console.log(`  ctx.inject 调用      ：${injectCalls.join(' | ') || '(无)'}`)
console.log(`  ctx.effect 调用      ：${effectCalls.join(' | ') || '(无)'}`)
console.log(`  ⇒ 走到状态端点注册   ：${reachedRoute ? '是 ✅' : '否 ❌'}`)

const ok = reachedRoute && hasInjectDecl && registered.length > 0 && threw === null
console.log(ok ? '\n=== 结果：通过 ===' : '\n=== 结果：失败 ===')
process.exit(ok ? 0 : 1)
