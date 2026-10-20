/**
 * _tool_contract_test.mjs —— 所有工具都必须满足 DSH 的 `output` 契约。
 *
 * ## 为什么需要（2026-10-12 真事故）
 *   DSH 的 `tools.register()` 强校验 `output`：
 *     `tool "<name>" must declare output { schema, render, presentationMeta? }`
 *   而 `makeListModelsTool` / `makeAccelTool` **两个诊断工具都没有 output**
 *   ⇒ 重载后它们注册失败（诊断日志 `[init] register.xxx 失败：…`），
 *     面板里那句"可让助手调用 check_acceleration 查看"就成了空指引。
 *   `makeDrawTool` 一直有 —— 所以问题只出在"新加工具时忘了补 output"。
 *
 * ## 它查什么
 *   把三个工具工厂都造出来，逐个断言：
 *     ① `output` 是对象
 *     ② `output.schema` 是对象（标准 JSON Schema）
 *     ③ `output.render` 是**函数**（DSH 真正强校验的就是这条）
 *     ④ `presentationMeta` 若存在必须是函数
 *     ⑤ `name` / `description` / `parameters` 齐全
 *
 * 用法：node scripts/_tool_contract_test.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { DEFAULTS, makeDrawTool, makeListModelsTool, makeAccelTool, makeUpscaleTool, makeEditTool } = idx.__internal

const noop = () => {}
const log = () => {}
const ctx = {
  logger: { info: noop, warn: noop, error: noop },
  get: () => undefined, effect: () => noop, inject: () => noop, tools: { register: noop },
}
const cfg = { ...DEFAULTS, outputDir: path.join(ROOT, '.tmp-tool-contract') }

let pass = 0, fail = 0
const ok = (n, c, x) => { c ? (pass++, console.log('  OK  ', n)) : (fail++, console.log('  FAIL', n, x ?? '')) }

const tools = [
  ['draw_image', makeDrawTool(ctx, cfg, log, null, noop)],
  ['list_available_models', makeListModelsTool(cfg, log)],
  ['check_acceleration', makeAccelTool(cfg, log)],
  ['upscale_image', makeUpscaleTool(cfg, log)],
  ['inpaint_image', makeEditTool(cfg, log)],
]

for (const [label, tool] of tools) {
  console.log(`\n=== ${label} ===`)
  ok(`${label} 是对象且带 name`, !!tool && typeof tool === 'object' && typeof tool.name === 'string', typeof tool?.name)
  ok(`${label} 有 description`, typeof tool?.description === 'string' && tool.description.length > 10)
  ok(`${label} 有 parameters（JSON Schema）`, !!tool?.parameters && typeof tool.parameters === 'object')
  ok(`${label} 有 execute 函数`, typeof tool?.execute === 'function')

  // ---- DSH 强校验的三条 ----
  const out = tool?.output
  ok(`${label} 声明了 output（DSH 强制）`, !!out && typeof out === 'object', JSON.stringify(out)?.slice(0, 80))
  ok(`${label} output.schema 是对象`, !!out?.schema && typeof out.schema === 'object')
  ok(`${label} output.render 是**函数**（DSH 强校验这条）`, typeof out?.render === 'function', typeof out?.render)
  if (out && out.presentationMeta !== undefined) {
    ok(`${label} presentationMeta 是函数`, typeof out.presentationMeta === 'function', typeof out.presentationMeta)
  }
  // render 必须真的能跑（有的实现会在 render 里读 value.xxx，value 为空就崩）
  try {
    const rendered = out.render({}, { path: 'p', width: 1, height: 1, seed: 1, seconds: 1, files: ['p'] })
    ok(`${label} output.render 空值下也能跑`, Array.isArray(rendered) && rendered.length > 0)
  } catch (error) {
    ok(`${label} output.render 空值下也能跑`, false, String(error?.message ?? error))
  }
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}） ===`)
process.exit(fail === 0 ? 0 : 1)
