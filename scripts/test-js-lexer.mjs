/**
 * test-js-lexer.mjs —— js-lexer.mjs 的正式回归（零依赖词法分析器）。
 *
 * 为什么独立成套件：
 *   2026-11-18 把 `_client_scope_test.mjs` 从「正则 replace 抹字符串」升级成
 *   token 流后，扫描正确性全靠这个引擎。引擎一旦被改坏（字符串隔离失效、
 *   模板插值根漏抓、正则误判），scope 测试会「静默变瞎」—— 所以给它配
 *   独立回归，把关键判据钉死。
 *
 * 覆盖：字符串/注释/正则/模板四类隔离，${X} 裸根提取，运算符排除，
 *       箭头参数 token 形态，转义与跨行边界。
 */
import { tokenize, templateInterpolationRoots, selfTest } from '../scripts/js-lexer.mjs'

let passed = 0
let failed = 0
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}`) }
}
const rootsOf = (src) => {
  const t = tokenize(src).find((x) => x.type === 'template')
  return templateInterpolationRoots(t).map((r) => r.root)
}
const refsOf = (src) => {
  const t = tokenize(src)
  return t.filter((x, i) => x.type === 'id' && t[i + 1]?.type === 'punct' && t[i + 1].value === '.')
    .map((x) => x.value)
}

console.log('js-lexer 零依赖词法分析器回归\n')

// ---- 引擎自带自测 ----
const st = selfTest()
ok('引擎 selfTest 通过', st.ok === true)
ok('selfTest 产出注释 token', st.kinds.includes('comment'))
ok('selfTest 产出正则 token', st.kinds.includes('regex'))

// ---- 模板插值 ----
ok('抓 ${API} 裸根（历史真 bug）', rootsOf('`${API}/status.json`').includes('API'))
ok('抓 ${obj.x} 的裸根 obj', rootsOf('`${obj.x}`').includes('obj'))
ok('排除 typeof 运算符', !rootsOf('`${typeof item?.state}`').includes('typeof'))
ok('排除 new 运算符', !rootsOf('`${new Foo()}`').includes('new'))
ok('排除 true/false/null 字面量', rootsOf('`${true}${null}`').length === 0)
ok('无插值的模板串没有根', rootsOf('`plain text`').length === 0)

// ---- 四类隔离：X. 取值根只在代码里抓 ----
ok('字符串内 data. 不算根，代码内算',
  refsOf("const a = 'data.outputDir'; data.outputDir").filter((x) => x === 'data').length === 1)
ok('双引号字符串隔离', refsOf('"foo.bar"').length === 0)
ok('行注释内 X. 不算根', !refsOf('// undefinedRoot.foo\nconst a = 1').includes('undefinedRoot'))
ok('块注释内 X. 不算根', !refsOf('/* a.b */ const c = 1').includes('a'))
ok('正则字面量内 X. 不算根', !refsOf('const re = /foo.bar/').includes('foo'))
ok('正则后可正常识别代码根', refsOf('const re = /foo.bar/; real.thing').includes('real'))

// ---- 转义与跨行 ----
ok('转义引号不截断字符串',
  refsOf("const a = 'it\\'s obj.x'; real.y").filter((x) => x === 'obj').length === 0)
ok('转义反斜杠正确处理', tokenize("const a = 'a\\\\b'").filter((t) => t.type === 'str').length === 1)
ok('块注释跨行行号递增（/* a\\nb\\nc */ 占 3 行，同行 q 在第 3 行）',
  (() => { const t = tokenize('/* a\nb\nc */ const q = 1'); const q = t.find((x) => x.value === 'q'); return q?.line === 3 })())

// ---- token 形态 ----
ok('箭头参数 ev 作为 id token 出现两次',
  tokenize('(ev) => ev.key').filter((t) => t.type === 'id' && t.value === 'ev').length === 2)
ok('=> 是双字符 punct token',
  tokenize('(a) => a').some((t) => t.type === 'punct' && t.value === '=>'))
ok('eof token 收尾', tokenize('const a = 1').at(-1)?.type === 'eof')
ok('数字 token 不与标识符粘连', tokenize('const n = 123').some((t) => t.type === 'num' && t.value === '123'))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
