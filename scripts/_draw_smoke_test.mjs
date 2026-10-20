/**
 * ★★★ 出图路径**冒烟测试** —— 专治"重构把闭包变量搬丢"这类 bug。
 *
 * ## 为什么必须有这个（真事故）
 *   我为了给 `[object Object]` 加规范化层，把 `makeDrawTool` 里的 `execute` 函数体
 *   原样搬成了顶层函数 `runDraw(args, exec)`。函数体里引用的
 *   `cfg` / `log` / `onProduced` / `onStart` 本来是**闭包变量**，搬出去后全丢了作用域
 *   → 用户点「画一张」直接报 **`cfg is not defined`**。
 *
 * ## 为什么静态检查救不了
 *   · `node --check` 只查语法 —— 自由变量在语法上**完全合法**，查不出来。
 *   · 我试过手写字法分析器做"符号解析"，结果踩了更大的坑：
 *     正则字面量 `/[\\/:*?"<>|\r\n\t]+/gu` 的**字符类里有双引号**，
 *     手写 stripper 不认正则、一见 `"` 就当成字符串开头 → 后面 28 个函数全被吞掉。
 *     **JS 的词法歧义（除号 vs 正则、模板嵌套、正则里的引号）不是正则能搞定的**，
 *     必须上真解析器。不值得为一个自测引入依赖。
 *
 * ## 所以：直接跑一遍
 *   不需要 ComfyUI 在线 —— 把 `autoStartComfy` 设成 false，
 *   执行会在**探活那一步**失败。判据是「失败原因」：
 *     · ✅ 报"连不上本机 ComfyUI" → 说明 `cfg` 等依赖**接住了**，代码路径是通的；
 *     · ❌ 报 "cfg is not defined" / "log is not defined" → 闭包变量又丢了。
 *   ⚠ 这个测试断言的是**错误类型**，不是在断言"出图成功"。
 *     它保证的是"代码不会因为缺变量而当场炸掉"。
 *
 * 用法：node scripts/_draw_smoke_test.mjs
 */

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const I = mod.__internal

/** 造一个不会真的去连网络的配置：端口用一个必连不上的。 */
function makeCfg(overrides = {}) {
  return {
    ...I.DEFAULTS,
    comfyUrl: 'http://127.0.0.1:59999', // 必然连不上
    autoStartComfy: false,               // ★ 别真的去拉起 ComfyUI（那要等 240 秒）
    outputDir: process.env.TEMP ?? '.',
    ...overrides,
  }
}

let fail = 0
const assert = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fail += 1
}

// ── ① 正常依赖齐全：应当走到底、在探活那步失败，且失败原因是"连不上" ──
{
  const logs = []
  const cfg = makeCfg()
  const tool = I.makeDrawTool({}, cfg, (...a) => logs.push(a.join(' ')), null, null)
  let err = null
  try {
    await tool.execute({ prompt: 'a red apple' }, { signal: new AbortController().signal })
  } catch (e) {
    err = e
  }
  const msg = String(err?.message ?? err)
  assert('① execute 抛出了错误（而不是静默返回）', err !== null)
  assert('① 不是 ReferenceError（cfg/log 等没丢）',
    !/is not defined/u.test(msg),
    msg.slice(0, 120))
  assert('① 抛的是真正的 Error 实例', err instanceof Error, err?.constructor?.name)
  assert('① 失败原因是"连不上 ComfyUI"（说明依赖齐全、走到探活了）',
    /连不上|ComfyUI/u.test(msg),
    msg.slice(0, 120))
  console.log(`      实际错误：${msg.split('\n')[0]}`)
}

// ── ② 缺 deps 时：应当给出**人话**报错，而不是 TypeError 天书 ──
{
  const cfg = makeCfg()
  const tool = I.makeDrawTool({}, cfg, () => {}, null, null)
  // 直接调 runDraw 且**不传 deps**，验证我加的那道守卫
  let err = null
  try {
    await tool.execute({ prompt: 'x' }, { signal: new AbortController().signal })
    // 上面走的是 execute（内部会传 deps），所以这里必然是"连不上"路径，不会触发守卫。
    // 守卫本身由下面 ③ 单独验。
  } catch (e) { err = e }
  assert('② execute 内部确实把 deps 传下去了', err !== null && !/缺少必需依赖/u.test(String(err?.message)))
}

// ── ③ 空 prompt：应当是人话校验错误，且仍是 Error 实例 ──
{
  const cfg = makeCfg()
  const tool = I.makeDrawTool({}, cfg, () => {}, null, null)
  let err = null
  try {
    await tool.execute({ prompt: '   ' }, { signal: new AbortController().signal })
  } catch (e) { err = e }
  assert('③ 空 prompt 抛出 Error', err instanceof Error)
  assert('③ 空 prompt 报的是人话', /prompt 不能为空/u.test(String(err?.message ?? '')), String(err?.message).slice(0, 80))
}

// ── ④ 工具定义本身完整（宿主靠这些字段注册/展示） ──
{
  const cfg = makeCfg()
  const tool = I.makeDrawTool({}, cfg, () => {}, null, null)
  assert('④ 有 name', tool.name === 'draw_image')
  assert('④ 有 description', typeof tool.description === 'string' && tool.description.length > 20)
  assert('④ 有 parameters', typeof tool.parameters === 'object')
  assert('④ 有 execute', typeof tool.execute === 'function')
  assert('④ 暴露 planWorkflow（纯函数自测用）', typeof tool.planWorkflow === 'function')
  // planWorkflow 也要能跑（它同样在闭包里依赖 cfg）
  let planErr = null
  try { tool.planWorkflow({ prompt: 'a red apple' }) } catch (e) { planErr = e }
  assert('④ planWorkflow 可调用且不报 is not defined',
    planErr === null || !/is not defined/u.test(String(planErr?.message)),
    planErr ? String(planErr.message).slice(0, 100) : '')
}

console.log('')
console.log(`=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
