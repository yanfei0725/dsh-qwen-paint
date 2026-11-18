/**
 * js-lexer.mjs —— 零依赖 JavaScript 词法分析器（仅服务构建期静态检查，不进插件包）。
 *
 * 为什么存在：
 *   `_client_scope_test.mjs` 原先用一堆正则 + `.replace()` 抹掉字符串/注释/模板串，
 *   再抓 `X.` 取值根。正则对嵌套/转义/正则字面量天生无能为力 —— 曾有正则盲区
 *   炸出 config.js 语法错误的教训（见 slim-comments.mjs 头注）。本模块把源码
 *   切成带类型的 token 流，让上层基于 token 类型判断，而不是在字符串上玩打地鼠。
 *
 * 硬约束：
 *   - 纯 JS 标准库，零第三方依赖（本机 acorn/espree/babel/tree-sitter 全 MISSING）。
 *   - 只做词法（token 化），不做完整语法/作用域树 —— 那是编译器的事，这里够用即止。
 *   - token 带 1-based 行号，便于精确报错。
 *
 * token 形状：{ type, value, line, start }
 *   type ∈ id | num | str | template | regex | comment | punct | eof
 *   · template：整条模板串（含插值）作为一个 token，插值内容由上层另行处理
 *   · comment：行注释与块注释都归此类，上层直接跳过
 *   · punct：单字符标点/运算符（=> 拆成 '=' '>'，上层按需识别）
 */
const ID_START = /[A-Za-z_$]/
const ID_PART = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

/** 这些关键字后面跟 `/` 时，`/` 一定正则而非除号。 */
const REGEX_PRECEDERS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof',
  'in', 'of', 'new', 'yield', 'await', 'else', 'do',
])
/** `(`/`,`/`=`/`:` 等之后也可跟正则；这里用「上一个有效 token」判断。 */
const REGEX_PUNCT_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>',
  '+', '-', '*', '%', '~', '^', '=>', '&&', '||', '??', '!==', '===', '!=', '==',
])

/**
 * 把源码切成 token 流。
 * @param {string} src 源码
 * @returns {Array<{type:string,value:string,line:number,start:number}>}
 */
export function tokenize(src) {
  const s = String(src)
  const n = s.length
  const out = []
  let i = 0
  let line = 1

  const push = (type, value, start) => out.push({ type, value, line, start })

  /** 上一个非注释、非空白 token（正则/除号歧义判断用）。 */
  const prev = () => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      if (out[k].type !== 'comment') return out[k]
    }
    return null
  }
  const slashIsRegex = () => {
    const p = prev()
    if (p === null) return true
    if (p.type === 'id') return REGEX_PRECEDERS.has(p.value)
    if (p.type === 'num' || p.type === 'str' || p.type === 'template' || p.type === 'regex') return false
    if (p.type === 'punct') return REGEX_PUNCT_PRECEDERS.has(p.value)
    return false
  }

  while (i < n) {
    const c = s[i]
    const c2 = s[i + 1]

    // 换行（先记行号再推进）
    if (c === '\n') { line += 1; i += 1; continue }
    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i += 1; continue }

    // 行注释
    if (c === '/' && c2 === '/') {
      const st = i
      while (i < n && s[i] !== '\n') i += 1
      push('comment', s.slice(st, i), st)
      continue
    }
    // 块注释（支持跨行）
    if (c === '/' && c2 === '*') {
      const st = i
      i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] === '\n') line += 1
        i += 1
      }
      if (i < n) i += 2
      push('comment', s.slice(st, i), st)
      continue
    }

    // 字符串（单/双引号，含转义）
    if (c === "'" || c === '"') {
      const st = i
      const q = c
      i += 1
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue }
        if (s[i] === q) { i += 1; break }
        if (s[i] === '\n') line += 1
        i += 1
      }
      push('str', s.slice(st, i), st)
      continue
    }

    // 模板串：整体作为一个 token，但要正确跨过 `${...}` 里的引号/嵌套模板/注释，
    // 且插值里的换行也要计入行号。插值内容不作为独立 token 发出 —— 上层若需要
    // 插值根（如 ${API}）另行从 value 里提取，避免污染主 token 流的作用域判断。
    if (c === '`') {
      const st = i
      i += 1
      let braceDepth = 0
      while (i < n) {
        const ch = s[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '\n') { line += 1; i += 1; continue }
        if (ch === '$' && s[i + 1] === '{') { braceDepth += 1; i += 2; continue }
        if (ch === '}' && braceDepth > 0) { braceDepth -= 1; i += 1; continue }
        if (ch === '`' && braceDepth === 0) { i += 1; break }
        // 插值里的字符串字面量：整体跳过，避免其中引号/花括号干扰
        if (braceDepth > 0 && (ch === "'" || ch === '"')) {
          const q = ch
          i += 1
          while (i < n) {
            if (s[i] === '\\') { i += 2; continue }
            if (s[i] === q) { i += 1; break }
            if (s[i] === '\n') line += 1
            i += 1
          }
          continue
        }
        i += 1
      }
      push('template', s.slice(st, i), st)
      continue
    }

    // 正则字面量 vs 除号：靠上一个有效 token 判断
    if (c === '/' && slashIsRegex()) {
      const st = i
      i += 1
      let inClass = false
      while (i < n) {
        const ch = s[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '\n') break
        if (ch === '[') { inClass = true; i += 1; continue }
        if (ch === ']') { inClass = false; i += 1; continue }
        if (ch === '/' && !inClass) {
          i += 1
          while (i < n && ID_PART.test(s[i])) i += 1
          break
        }
        i += 1
      }
      push('regex', s.slice(st, i), st)
      continue
    }

    // 数字
    if (DIGIT.test(c)) {
      const st = i
      while (i < n && (ID_PART.test(s[i]) || s[i] === '.')) i += 1
      push('num', s.slice(st, i), st)
      continue
    }

    // 标识符 / 关键字
    if (ID_START.test(c)) {
      const st = i
      i += 1
      while (i < n && ID_PART.test(s[i])) i += 1
      push('id', s.slice(st, i), st)
      continue
    }

    // 双字符运算符（=> ... === && 等），单字符兜底
    const two = s.slice(i, i + 2)
    if (['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
      '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>'].includes(two)) {
      push('punct', two, i)
      i += 2
      continue
    }
    push('punct', c, i)
    i += 1
  }
  out.push({ type: 'eof', value: '', line, start: n })
  return out
}

/**
 * 从模板串 token 的 value 里提取顶层插值表达式文本 `${...}` 的简单形式。
 * 只取形如 `${标识符}` / `${标识符.xxx}` 的直接标识符根；复杂表达式（函数调用、
 * 嵌套模板）跳过 —— scope 检查只需抓「裸根」这类最易漏网的未定义变量。
 * 运算符（typeof/new/void…）不是变量，必须排除，否则 `typeof x` 会误报 typeof 未定义。
 * @returns {Array<{root:string}>}
 */
const TEMPLATE_OPS = new Set([
  'typeof', 'new', 'void', 'delete', 'await', 'yield',
  'in', 'of', 'instanceof', 'true', 'false', 'null', 'undefined',
])
export function templateInterpolationRoots(token) {
  const v = token?.value ?? ''
  const roots = []
  let k = 0
  while (k < v.length) {
    if (v[k] === '$' && v[k + 1] === '{') {
      let j = k + 2
      while (j < v.length && /\s/u.test(v[j])) j += 1
      const m = /^([A-Za-z_$][\w$]*)/u.exec(v.slice(j))
      if (m && !TEMPLATE_OPS.has(m[1])) roots.push({ root: m[1] })
      // 跳到匹配的 }（简单括号计数，字符串内容已在词法层无关紧要）
      let depth = 1
      k = j
      while (k < v.length && depth > 0) {
        if (v[k] === '{') depth += 1
        else if (v[k] === '}') depth -= 1
        k += 1
      }
      continue
    }
    k += 1
  }
  return roots
}

/** 自测：覆盖字符串/注释/正则/模板插值/转义等关键路径。 */
export function selfTest() {
  const t = tokenize("const a='x.y'; // u.f\nlet u = /a\\/b/.test(a); `p${u.x}q`")
  const ids = t.filter((x) => x.type === 'id').map((x) => x.value)
  const kinds = new Set(t.map((x) => x.type))
  const tmpl = t.find((x) => x.type === 'template')
  const ok = ids.includes('const') && ids.includes('a') && ids.includes('u')
    && kinds.has('comment') && kinds.has('regex') && kinds.has('template')
    && tmpl !== undefined && templateInterpolationRoots(tmpl)[0]?.root === 'u'
  return { ok, count: t.length, ids, kinds: [...kinds] }
}

// 精确判断是否主程序：不能用 endsWith('js-lexer.mjs')——
// 回归脚本 test-js-lexer.mjs 也以此结尾，会被误判成主程序提前 exit。
const isMain = process.argv[1] && /[\\/]js-lexer\.mjs$/u.test(process.argv[1])
  && !/[\\/]test-js-lexer\.mjs$/u.test(process.argv[1])
if (isMain) {
  const r = selfTest()
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}
