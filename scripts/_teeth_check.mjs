/**
 * 一次性校验：证明 _intent_test 新加的"事故回归"断言**确实有牙**。
 *
 * 做法：把改动前的备份（index.js.bak-before-intent-tune-20261009-1906）
 *       复制成临时 .js 导入，用同一批断言跑一遍 —— 旧代码必须**失败**。
 *       如果旧代码也能通过，说明断言是摆设。
 *
 * 用法：node scripts/_teeth_check.mjs
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// Windows 上动态 import 绝对路径必须转成 file:// URL，否则报
// ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'
const toUrl = (p) => pathToFileURL(p).href

const here = dirname(fileURLToPath(import.meta.url))
const bak = join(here, '../lib/index.js.bak-before-intent-tune-20261009-1906')
if (!existsSync(bak)) {
  console.log('备份不存在，跳过（说明已经不在同一台机器上）')
  process.exit(0)
}

// ★ 临时副本必须落在 lib/ 下：备份里用的是 './hipfire-img.js' 这类**相对于自身**的
//   导入，放到 scripts/ 会解析成 scripts/hipfire-img.js → ERR_MODULE_NOT_FOUND。
const tmp = join(here, '../lib/_teeth_oldcopy.mjs')
writeFileSync(tmp, readFileSync(bak, 'utf8'), 'utf8')

let fail = 0
const assert = (name, cond, expectFail) => {
  const want = expectFail ? !cond : cond
  console.log(`  ${want ? 'OK  ' : 'FAIL'} ${name}${expectFail ? '（旧代码应当失败）' : ''}`)
  if (!want) fail += 1
}

try {
  const { __internal: OLD } = await import(toUrl(tmp))
  const oldAuto = OLD.buildDrawIntentPrompt('auto')
  const oldEager = OLD.buildDrawIntentPrompt('eager')

  console.log('=== 旧代码（改动前）应当被新断言判死 ===')
  // ① 旧文案确实写了"宁可先问一句" → 新断言 !includes('宁可先问一句') 必须判它失败
  assert('旧 auto 含"宁可先问一句"（这是事故诱因）', oldAuto.includes('宁可先问一句'), false)
  assert('→ 新断言"已删除宁可先问一句"确实能抓住它', !oldAuto.includes('宁可先问一句'), true)

  // ② 旧文案全篇没有禁止自己画 → 新断言必须判它失败
  assert('旧 auto 完全没有"不许自己画"这条', !oldAuto.includes('不许自己'), false)
  assert('→ 新断言"禁止自己出图"确实能抓住它', oldAuto.includes('不许自己') && oldAuto.includes('错误行为'), true)
  assert('→ 新断言"点名禁止 Python/Matplotlib"确实能抓住它', oldAuto.includes('Python/Matplotlib'), true)

  // ③ 旧工具描述里没有"严禁自己写" → 新断言必须判它失败
  const oldTool = OLD.makeDrawTool({}, { timeoutMs: 1000 }, () => {}, () => {}, () => {})
  const od = oldTool?.description ?? ''
  assert('旧工具描述没有任何"严禁自己画"', !od.includes('严禁自己写'), false)
  assert('→ 新断言"描述严禁自己写 Python/Matplotlib/PIL"确实能抓住它', od.includes('严禁自己写 Python/Matplotlib/PIL'), true)
  assert('旧工具描述里写了"先与用户确认"（劝退话）', od.includes('先与用户确认'), false)
  assert('→ 新断言"不含先与用户确认"确实能抓住它', !od.includes('先与用户确认'), true)
  assert('旧 eager 也没有"不许自己画"', !oldEager.includes('不许自己'), false)

  console.log('\n=== 新代码（当前）应当全部通过 ===')
  const { __internal: NOW } = await import(toUrl(join(here, '../lib/index.js')))
  const nowAuto = NOW.buildDrawIntentPrompt('auto')
  assert('新 auto 已无"宁可先问一句"', !nowAuto.includes('宁可先问一句'), false)
  assert('新 auto 有"不许自己画"', nowAuto.includes('不许自己'), false)
  assert('新 auto 有"拿不准就画一张"', nowAuto.includes('拿不准就画一张'), false)
  assert('新工具描述有"严禁自己写"', NOW.makeDrawTool({}, { timeoutMs: 1000 }, () => {}, () => {}, () => {}).description.includes('严禁自己写'), false)
} finally {
  try { unlinkSync(tmp) } catch { /* 忽略 */ }
}

console.log(`\n=== ${fail === 0 ? '断言有牙（旧代码被判死、新代码通过）' : `${fail} 项不成立 —— 断言是摆设`} ===`)
if (fail > 0) process.exit(1)
