#!/usr/bin/env node
/** 报告 v3 §14.4「C 线」+ §14.2「A 线」：零依赖源码 AST 验证器 / 槽位推导脚本。 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { topLevelBlocks, verifyZeroDrift, splitPlan, selfTest } from './ast-split.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

const FIXTURE = `import x from 'y'\n\nconst A = {\n  k: [1, 2],\n}\n\nfunction B() {\n  return A.k.length\n}\n`
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
const py = (args) => spawnSync('python', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 })

console.log('ast-split / derive-slots 回归')

ok('topLevelBlocks 找到 import / const A / function B，行号闭区间', () => {
  const b = topLevelBlocks(FIXTURE)
  const names = b.map((x) => x.name).filter(Boolean)
  assert.ok(names.includes('A'))
  assert.ok(names.includes('B'))
  assert.ok(b.some((x) => x.kind === 'import'))
  for (const x of b) assert.ok(x.start >= 1 && x.end >= x.start && x.end <= FIXTURE.split('\n').length)
})
ok('verifyZeroDrift(fixture) ok 且真按块重组（不是空操作）', () => {
  const d = verifyZeroDrift(FIXTURE)
  assert.equal(d.ok, true)
  assert.ok(d.blocks >= 3)
  assert.ok(d.totalExtracted > 0)
  assert.equal(src('scripts/ast-split.mjs').includes('块边界重叠或越界'), true)
})
ok('splitPlan(fixture, 10)：needed=true 且挑出可外移的大块', () => {
  const p = splitPlan(FIXTURE, 10)
  assert.equal(p.needed, true)
  assert.ok(p.oversized > 0)
  assert.ok(p.candidates.length >= 1)
  assert.ok(p.savedBytes > 0)
  assert.ok(p.candidates.every((b) => b.kind !== 'import' && b.kind !== 'export'))
})
ok('splitPlan：config.js 已在门禁内（185359 < 262144）⇒ needed=false', () => {
  const p = splitPlan(src('lib/config.js'))
  assert.equal(p.needed, false)
  assert.equal(p.candidates.length, 0)
})
ok('★ verifyZeroDrift 对三个真实 lib 文件全部零漂移、块不重叠', () => {
  for (const f of ['lib/config.js', 'lib/index.js', 'lib/workflow-ast.js', 'lib/comfy-catalog.js']) {
    const d = verifyZeroDrift(src(f))
    assert.equal(d.ok, true, `${f} → ${d.reason}`)
    assert.ok(d.blocks > 0, f)
  }
})
ok('★ ast-split.mjs --self-test 子进程 exit 0 且 ok:true', () => {
  const r = run(['scripts/ast-split.mjs', '--self-test'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"ok"\s*:\s*true/)
})
ok('★ ast-split.mjs lib/config.js 子进程 exit 0 且 zeroDrift:true', () => {
  const r = run(['scripts/ast-split.mjs', 'lib/config.js'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"zeroDrift"\s*:\s*true/)
})
ok('C 线硬约束：零依赖、按整行、明确不碰 client.js', () => {
  const s = src('scripts/ast-split.mjs')
  assert.ok(s.includes('零依赖'))
  assert.ok(s.includes('整行'))
  assert.ok(s.includes('client.js'))
  // 只看真正的 import 行：注释里写「acorn / recast MISSING」不算依赖。
  const imports = [...s.matchAll(/^\s*import\s.+?\sfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.ok(imports.length > 0 && imports.every((m) => m.startsWith('node:')))
})
ok('client.js 保持非 ESM 单入口（C 线没动它）', () => {
  const c = src('lib/client.js')
  assert.ok(!/^[ \t]*import\s/m.test(c) && !/^[ \t]*export\s/m.test(c))
})
ok('selfTest() 直接调用也返回 0', () => {
  assert.equal(selfTest(), 0)
})
ok('★ derive-slots.py --self-test 子进程 exit 0（新老两种 schema 都推得出）', () => {
  const r = py(['scripts/derive-slots.py', '--self-test'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"ok"\s*:\s*true/)
  assert.match(r.stdout, /NewStyleWan/)
})
ok('A 线脚本认新 schema define_schema / 支持 --out / 吃 BOM', () => {
  const s = src('scripts/derive-slots.py')
  assert.ok(s.includes('def schema_input_keys'))
  assert.ok(s.includes('define_schema'))
  assert.ok(s.includes('utf-8-sig'))
  assert.ok(s.includes('--out'))
})
ok('★ assets/slots.json 已生成且是可解析 JSON（A 线产物落盘）', () => {
  assert.equal(existsSync(path.join(ROOT, 'assets/slots.json')), true)
  const j = JSON.parse(src('assets/slots.json'))
  assert.equal(j._source, 'python-ast')
  assert.ok(Object.keys(j.slots).length > 0)
  assert.equal(j._parseErrors, undefined)
})

console.log(`\n✓ 全部通过（${n} 项）`)
