/**
 * _client_scope_test.mjs —— 客户端「面板作用域未声明标识符」静态回归。
 *
 * ## 为什么需要（2026-10-12 真事故）
 *   `openPanel(opt)` 里把 `opt.outputDir` 误写成 `data.outputDir`，而本函数里
 *   **没有 `data`**。`node --check` 完全查不出来（语法合法），只有运行时才抛
 *   `ReferenceError: data is not defined` —— 而面板是**最后才 appendChild** 的，
 *   于是**整个优化面板永远打不开**（用户看到的就是"点了没反应"）。
 *   崩溃日志：`client.js:1813 Uncaught ReferenceError: data is not defined`。
 *
 * ## 它怎么查
 *   1. 取出 `openPanel` 的函数体（从定义处到下一个同级 `const update =`）
 *   2. 收集该范围内**声明过**的标识符（const/let/var/function/参数）
 *   3. 收集所有 `X.` 形式的**取值根**，逐个核对是否声明过或在已知全局白名单里
 *   4. 有漏网的就报 FAIL —— 这类错一旦漏出，代价是整个面板打不开
 *
 * ⚠ 这是**启发式**静态检查（不是完整作用域分析）：白名单只放浏览器/宿主已知全局。
 *   新增合法全局时往 GLOBALS 里补，别为了让它变绿而把变量名加进去。
 *
 * 用法：node scripts/_client_scope_test.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const LINES = SRC.split('\n')

// ---- 1. 取 openPanel 函数体 ----
const startIdx = LINES.findIndex((l) => l.includes('const openPanel = (opt) =>'))
if (startIdx < 0) {
  console.log('  FAIL 没找到 openPanel 定义（客户端结构变了？）')
  process.exit(1)
}
const endIdx = LINES.findIndex((l, i) => i > startIdx && l.includes('const update = (opt) =>'))
const body = LINES.slice(startIdx, endIdx < 0 ? undefined : endIdx).join('\n')
console.log(`openPanel 函数体：第 ${startIdx + 1} ~ ${endIdx} 行（共 ${endIdx - startIdx} 行）`)

// ---- 2. 已知全局白名单（浏览器 + 宿主 + 该闭包里的外层变量）----
const GLOBALS = new Set([
  // 浏览器
  'document', 'window', 'console', 'navigator', 'location', 'localStorage', 'fetch',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Promise',
  'Error', 'TypeError', 'RegExp', 'Map', 'Set', 'Intl', 'URL', 'URLSearchParams',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'AbortController', 'AbortSignal', 'structuredClone', 'getComputedStyle', 'matchMedia',
  // 本闭包/文件里定义的外层变量与函数
  'opt', 'panel', 'el', 'host', 'lastDetail', 'panelScroll', 'outsideHandler',
  'closePanel', 'placePanel', 'openDetail', 'update', 'view', 'lastCls', 'lastText',
  'describeOptimizationBadge', 'OPT_ID', 'seat', 'render', 'state', 'mount', 'dispose',
  'qwenPaint', 'api', 'ctx',
  // ★ 2026-10-12：`payloadNow` 声明在 openPanel **外面**（同一个闭包里、紧邻其上方），
  //   用来存"最近一次状态接口的完整 payload"（面板要读顶层的 outputDir）。
  //   本测试只扫 openPanel 函数体，扫不到它 —— 属于**已知的假阳性**，故列入白名单。
  'payloadNow',
])

// ---- 3. 收集声明过的名字 ----
const declared = new Set()
const declRe = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g
// 参数：`(a, b) =>` / `function f(a, b)` / `async (a) =>`
const paramRe = /(?:\(([^()]*)\)\s*=>|function\s*[A-Za-z_$]*\s*\(([^()]*)\))/g
// 解构：`const { a, b } = ` / `const [a, b] = `
const destructRe = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g

for (const m of body.matchAll(declRe)) declared.add(m[1])
for (const m of body.matchAll(paramRe)) {
  for (const grp of [m[1], m[2]]) {
    if (!grp) continue
    for (const p of grp.split(',')) {
      const name = p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }
}
for (const m of body.matchAll(destructRe)) {
  for (const p of m[1].split(',')) {
    const name = p.trim().split(/[=:]/)[0].trim().replace(/^\.\.\./, '')
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}

// ---- 4. 收集所有 `X.` 取值根（排除属性链中段与字符串/注释里的）----
const codeOnly = body
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  .replace(/^\s*\/\/.*$/gm, '')          // 整行注释
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")   // 单引号串
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')   // 双引号串
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')   // 模板串
const used = new Set()
for (const m of codeOnly.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\./g)) used.add(m[1])

// ---- 5. 核对 ----
const unknown = [...used].filter((n) => !declared.has(n) && !GLOBALS.has(n)).sort()
console.log(`声明过 ${declared.size} 个名字；用到 ${used.size} 个取值根`)
if (unknown.length === 0) {
  console.log('\n=== 结果：全部通过（面板作用域没有未声明标识符）===')
  process.exit(0)
}
console.log('\n  FAIL 这些标识符在 openPanel 作用域里**没声明**，运行时必抛 ReferenceError：')
for (const n of unknown) {
  const line = LINES.findIndex((l, i) => i >= startIdx && i < endIdx && new RegExp(`(?<![.\\w$])${n}\\s*\\.`).test(l))
  console.log(`    - ${n}   首次出现在第 ${line + 1} 行`)
}
console.log('\n=== 结果：1 项失败 ===')
process.exit(1)
