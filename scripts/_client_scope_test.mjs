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
 * ## 它怎么查（2026-11-18 升级：正则 → 零依赖词法分析）
 *   1. 取出 `openPanel` 的函数体（从定义处到下一个同级 `const update =`）
 *   2. 用 `scripts/js-lexer.mjs` 把函数体切成 token 流（字符串/注释/正则/模板
 *      都是独立 token，不再靠正则 replace 去抹）—— 纯 JS 标准库，零依赖、不进包
 *   3. 基于 token 类型收集声明（const/let/var/function/参数/解构）与引用根（`X.`）
 *   4. 模板插值 `${X}` 的裸根单独从 template token 提取（历史 bug：${API} 未定义）
 *   5. 有漏网的就报 FAIL —— 这类错一旦漏出，代价是整个面板打不开
 *
 * ⚠ 这是**启发式**静态检查（不是完整作用域树）：白名单只放浏览器/宿主已知全局。
 *   新增合法全局时往 GLOBALS 里补，别为了让它变绿而把变量名加进去。
 *
 * 用法：node scripts/_client_scope_test.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tokenize, templateInterpolationRoots } from './js-lexer.mjs'

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

// ---- 3 & 4. 基于 token 流收集声明与引用根 ----
// ★ 2026-11-18 升级：不再用正则在源码字符串上「抹字符串→抹注释→抹模板→抓 X.」，
//   那套做法对转义/嵌套/正则字面量天生脆弱（正则盲区曾炸出 config.js 语法错误）。
//   现在词法分析器先把源码切成带类型 token，这里只做 token 层的模式匹配。
const tokens = tokenize(body)
const DECL_KW = new Set(['const', 'let', 'var'])
const declared = new Set()
const used = new Set()
let interpolationRoots = 0

/** 把形如 `a` / `a = 1` / `...a` / `{k: a}` 的 token 段里的「绑定名」加入 declared。 */
function addBindingName(seq) {
  // 取 `=` 之前、去掉剩余 `:` 右侧…；这里 seq 已是不含分隔符的单段
  const names = seq.filter((t) => t.type === 'id')
  // 跳过属性名：`{ k: a }` 里 k 是属性名、a 才是绑定名；`{ a }` 里 a 是绑定名。
  const colonIdx = seq.findIndex((t) => t.type === 'punct' && t.value === ':')
  const bindTokens = colonIdx >= 0 ? names.filter((t) => t.start > seq[colonIdx].start) : names
  for (const t of bindTokens) declared.add(t.value)
}

/**
 * 消费一个「声明符列表」：const/let/var 之后到语句结束（`;` 或行尾语义）之前的绑定。
 * 支持 `a, b = 1`、`{a, b: c}`、`[a, b]`、`...rest`。
 */
function collectDeclFrom(startIdx) {
  let k = startIdx
  // 跳过 async（function 前缀）等非绑定 token 已在调用处处理
  if (k >= tokens.length) return
  const first = tokens[k]
  const isDestructure = first.type === 'punct' && (first.value === '{' || first.value === '[')
  if (isDestructure) {
    const open = first.value
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let seg = []
    k += 1
    while (k < tokens.length) {
      const t = tokens[k]
      if (t.type === 'punct' && t.value === open) depth += 1
      if (t.type === 'punct' && t.value === close) {
        if (depth === 0) { addBindingName(seg); break }
        depth -= 1
      }
      if ((t.type === 'punct' && (t.value === ',' )) && depth === 0) { addBindingName(seg); seg = []; k += 1; continue }
      seg.push(t)
      k += 1
    }
    return
  }
  // 简单声明：每隔逗号取一个绑定名；遇到 `=` 跳过初始化表达式到下一个顶层逗号
  let depth = 0
  let wantName = true
  while (k < tokens.length) {
    const t = tokens[k]
    if (t.type === 'punct') {
      if (['{', '[', '('].includes(t.value)) depth += 1
      else if (['}', ']', ')'].includes(t.value)) depth -= 1
      else if (t.value === ',' && depth === 0) { wantName = true }
      else if (t.value === '=' && depth === 0) { wantName = false }
      else if ((t.value === ';' || t.value === '}' || t.value === ')') && depth <= 0) break
    }
    if (wantName && t.type === 'id') { declared.add(t.value); wantName = false }
    k += 1
  }
}

/** 收集一对括号内的箭头函数参数（括号已定位到右括号）。 */
function collectParams(fromIdx, toIdx) {
  let depth = 0
  let seg = []
  const flush = () => {
    const names = seg.filter((t) => t.type === 'id')
    const colonIdx = seg.findIndex((t) => t.type === 'punct' && t.value === ':')
    const bind = colonIdx >= 0 ? names.filter((t) => t.start > seg[colonIdx].start) : names
    for (const t of bind) declared.add(t.value)
    seg = []
  }
  for (let k = fromIdx; k < toIdx; k += 1) {
    const t = tokens[k]
    if (t.type === 'punct') {
      if (['{', '[', '('].includes(t.value)) depth += 1
      else if (['}', ']', ')'].includes(t.value)) depth -= 1
      else if (t.value === ',' && depth === 0) { flush(); continue }
    }
    seg.push(t)
  }
  flush()
}

for (let i = 0; i < tokens.length; i += 1) {
  const t = tokens[i]
  if (t.type !== 'id' && t.type !== 'punct') continue

  // ★ 箭头函数参数：`(r) =>` / `(ev) =>` / `(s) =>`。
  //   遇到 '(' 找匹配 ')'，若其后紧跟 '=>' 则括号内是参数表。
  //   （这段必须在 `X.` 取值根判断之前，纯 '(' 不参与下面的引用收集。）
  if (t.type === 'punct' && t.value === '(') {
    let depth = 0
    let q = i
    for (; q < tokens.length; q += 1) {
      if (tokens[q].type === 'punct' && tokens[q].value === '(') depth += 1
      else if (tokens[q].type === 'punct' && tokens[q].value === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (tokens[q + 1]?.type === 'punct' && tokens[q + 1].value === '=>') {
      collectParams(i + 1, q)
    }
    continue
  }

  if (t.type !== 'id') continue

  // 声明关键字
  if (DECL_KW.has(t.value)) { collectDeclFrom(i + 1); continue }
  // function foo(...) / async function foo / class Foo：函数名
  if (t.value === 'function' || t.value === 'class') {
    const nm = tokens[i + 1]
    if (nm?.type === 'id') declared.add(nm.value)
    // function 的参数表：找到函数名后的 '(' 与匹配 ')'
    if (t.value === 'function') {
      let p = i + 1
      if (tokens[p]?.type === 'id') p += 1
      if (tokens[p]?.type === 'punct' && tokens[p].value === '(') {
        let depth = 0
        let q = p
        for (; q < tokens.length; q += 1) {
          if (tokens[q].type === 'punct' && tokens[q].value === '(') depth += 1
          else if (tokens[q].type === 'punct' && tokens[q].value === ')') { depth -= 1; if (depth === 0) break }
        }
        collectParams(p + 1, q)
      }
    }
    continue
  }

  // ★ 单参数无括号箭头：`x => ...`，当前 id 后紧跟 '=>' 即为参数。
  if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '=>') {
    declared.add(t.value)
    continue
  }

  // 引用根：`X.` —— 当前 id 后面紧跟一个 `.` punct，且这个 id 不是属性名（前一个 token 不是 `.`）
  if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.') {
    const prevT = tokens[i - 1]
    if (!(prevT?.type === 'punct' && prevT.value === '.')) used.add(t.value)
  }
}

// 模板插值的裸根：从 template token 的 value 中提取（历史 bug ${API} 未定义）
for (const t of tokens) {
  if (t.type !== 'template') continue
  for (const { root } of templateInterpolationRoots(t)) {
    used.add(root)
    interpolationRoots += 1
  }
}

// ---- 5. 核对 ----
const unknown = [...used].filter((n) => !declared.has(n) && !GLOBALS.has(n)).sort()
console.log(`声明过 ${declared.size} 个名字；用到 ${used.size} 个标识符根（含 ${interpolationRoots} 个模板插值）`)
if (unknown.length === 0) {
  // ★ 0.32.1 审计 B：以前只打「结果：全部通过」，test-all 统计成 0 项断言。
  console.log('  ✓ 面板作用域没有未声明标识符（' + declared.size + ' 个声明 / ' + used.size + ' 个根，其中 ' + interpolationRoots + ' 个模板插值）')
  console.log('\n=== 结果：全部通过（面板作用域没有未声明标识符）===')
  process.exit(0)
}
console.log('\n  FAIL 这些标识符在 openPanel 作用域里**没声明**，运行时必抛 ReferenceError：')
for (const n of unknown) {
  // 同时匹配 `X.` 取值与 `${X}` 插值两种出现形态，报准行号。
  const line = LINES.findIndex((l, i) => i >= startIdx && i < endIdx
    && (new RegExp(`(?<![.\\w$])${n}\\s*\\.`).test(l) || new RegExp(`\\$\\{\\s*${n}\\b`).test(l)))
  console.log(`    - ${n}   首次出现在第 ${line + 1} 行`)
}
console.log('\n=== 结果：1 项失败 ===')
process.exit(1)
