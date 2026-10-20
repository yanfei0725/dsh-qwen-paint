#!/usr/bin/env node
/**
 * dsh-qwen-paint —— 统一回归入口（`npm test`）
 *
 * ## 为什么要有这个文件
 *
 * 血泪教训的原文：**"不在回归清单里的测试 = 等于没有测试。"**
 *
 * 这条教训是拿真事换来的：`scripts/selftest.mjs` 从 0.1.0 起一路漂移，
 * 因为没人跑它，直到 0.17.10 才发现里面 15 项断言早就红了
 *（AUTH001 把写操作从 GET 迁到 POST 之后，测试没跟着改）。
 * 那 15 项红着的三天里，**没有任何一条命令会自动变红**。
 *
 * 所以这里做的事只有一件：把"该跑的"钉成一份清单，跑一个不漏，
 * 任何一套红了就让整条命令以非零码退出 —— 让它在 push 之前自己叫。
 *
 * ## 判定口径（重要，别改成"看输出里有没有 ✔"）
 *
 *   ① **退出码**是第一依据：非零 = FAIL。
 *   ② 退出码 0 但输出里有以 `✗` 开头的行 = FAIL（有的套件忘了 `process.exit(1)`，
 *      只靠打印，这类"绿着红"必须抓住）。
 *   ③ 派生进程都起不来（沙箱间歇性禁止派生，曾出现 `spawnSync → EBUSY`）= **SKIP**，
 *      不是 FAIL。环境不允许和自己写错是两件事，混在一起就意味着"永远不会修"。
 *
 * ## 用法
 *
 *   node scripts/test-all.mjs              # 跑全部
 *   node scripts/test-all.mjs --only=net   # 只跑名字里含 net 的
 *   node scripts/test-all.mjs --quiet      # 只打结论和失败详情
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * 回归清单。新增测试脚本时**必须**登记到这里，否则等于没写。
 * `heavy: true` 的排在最后（跑得久，失败时不必等它）。
 */
const SUITES = [
  // —— 三大主力（项数最多，覆盖面最广）——
  { file: 'test-net-guard.mjs', note: '网络边界 + URL 规范化（双斜杠坑）' },
  { file: 'test-request-trust.mjs', note: '本机 HTTP 接口的调用方信任判定 + 405/415 守卫' },
  { file: 'test-workflow-contract.mjs', note: 'ComfyUI 工作流节点契约' },
  // —— 契约 / 面板 / 步骤 ——
  { file: '_tool_contract_test.mjs', note: '工具契约' },
  { file: '_step4_dry_test.mjs', note: '4 步干跑' },
  { file: '_client_scope_test.mjs', note: '面板作用域无未声明标识符' },
  { file: '_opt_status_test.mjs', note: '状态机与状态端点' },
  { file: '_portability_test.mjs', note: '可移植性' },
  { file: '_launch_args_test.mjs', note: '启动参数' },
  { file: '_mac_env_test.mjs', note: 'macOS/MPS 环境变量注入' },
  { file: '_perf_tweaks_test.mjs', note: '性能开关' },
  { file: '_vae_spectrum_test.mjs', note: 'VAE 分块 + Spectrum 跳步节点图' },
  { file: '_gpu_vendor_test.mjs', note: '显卡判定 + Mac 面板' },
  { file: '_manifest_test.mjs', note: 'manifest 一致性' },
  // ★ 2026-10-20 新增（0.17.13）：面板圈选重绘三项修复的回归锁
  //   （蒙版泄漏 / 同毫秒覆盖 / 结果图裂图 / 结果图堆叠 / 浮层双开）
  { file: '_inpaint_ui_test.mjs', note: '圈选重绘 UI 修复回归' },
  // ★ 2026-10-19 补进回归：它一直没被 `npm test` 跑过，漂移了 16 项都没人发现
  //   （全是"源码字符串搬家了/写操作改 POST 了"导致的过期断言）。
  { file: '_review_fixes_test.mjs', note: '0.17.6 那批修复的源码级回归' },
  { file: '_no_private_docs_test.mjs', note: '私人/开发文档不进公开仓库（源码目录 SKIP）' },
  { file: 'test-dsh-compat.mjs', note: 'COMPAT001 实测（无 dsh 环境时明确 SKIP）' },
  // —— 最重的一套放最后 ——
  { file: 'selftest.mjs', note: '全量自测（387 项）', heavy: true },
]

const argv = process.argv.slice(2)
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).toLowerCase()
const quiet = argv.includes('--quiet')

const picked = only === '' ? SUITES : SUITES.filter((s) => s.file.toLowerCase().includes(only))

if (picked.length === 0) {
  console.error(`✗ 没有匹配 --only=${only} 的套件`)
  process.exit(2)
}

const STDIO_DENIED = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ENOENT'])
/** 输出里"以 ✗ 开头的行"的条数 —— 用来抓"exit 0 但其实红了"的套件。 */
const crossCount = (text) => text.split('\n').filter((line) => line.trimStart().startsWith('✗')).length
/**
 * ★★★ 2026-10-19 修：**原先只认 `✓`**，于是 12 套用 `OK` / `PASS` / `✅` 的套件被统计成 0 项，
 *   显示成"全部通过"而不是"N 项断言通过"。
 *
 *   更糟的是**假阳性**：某套若因为文件改名 / 路径写错而一条断言都没跑，只要 `exit 0`
 *   且没有 `✗`，这里就会判 PASS —— 等于"没跑"和"跑了全绿"混为一谈。
 *   （这正是本文件开头那条注释说的、selftest 漂移了半年才被发现的老毛病。）
 *
 *   现在：① 认多种成功标记；② **0 项断言且没有成功总结 ⇒ FAIL**（见下面的判定分支）。
 *   要新增一套测试，请让它输出至少一个 `✓` / `OK` / `PASS` / `✅`，
 *   或者在末尾打一行"全部通过"—— 否则会被这里判红。
 */
const OK_MARK = /^(?:✓|OK\b|PASS\b|✅)/u
const tickCount = (text) => text.split('\n').filter((line) => OK_MARK.test(line.trimStart())).length
/** 没有逐条标记的套件（如整体检查型），至少要有一句成功总结，才承认它真的跑了。 */
const declaresSuccess = (text) => /(?:全部通过|结果[：:]\s*通过)/u.test(text)
/** 套件自己在输出里声明了 SKIP（环境不具备）。**不能当 PASS** —— 否则"没跑"和"跑了绿"混为一谈。 */
const declaresSkip = (text) =>
  text.split('\n').some((line) => line.trimStart().startsWith('⤼') || /^SKIP[：:]/u.test(line.trimStart()))

const results = []

console.log(`dsh-qwen-paint 回归 —— 共 ${picked.length} 套${only === '' ? '' : `（筛选：${only}）`}`)
console.log(`工作目录：${ROOT}`)
console.log('')

for (const suite of picked) {
  const script = path.join(HERE, suite.file)
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: suite.heavy ? 300_000 : 180_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const ms = Date.now() - startedAt
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`

  let verdict
  let detail = ''
  if (run.error !== undefined && run.error !== null) {
    const code = String(run.error.code ?? '')
    if (STDIO_DENIED.has(code)) {
      verdict = 'SKIP'
      detail = `环境不允许派生进程（${code}）—— 不是测试写错，换个环境再跑`
    } else {
      verdict = 'FAIL'
      detail = `派生失败：${run.error.message ?? run.error}`
    }
  } else if (run.signal !== null && run.signal !== undefined) {
    verdict = 'FAIL'
    detail = `被信号 ${run.signal} 终止（大概率超时）`
  } else if ((run.status ?? 1) !== 0) {
    verdict = 'FAIL'
    detail = `退出码 ${run.status}`
  } else if (crossCount(out) > 0) {
    verdict = 'FAIL'
    detail = `退出码 0 但输出里有 ${crossCount(out)} 行 ✗（该套件忘了 process.exit(1)）`
  } else if (declaresSkip(out)) {
    verdict = 'SKIP'
    detail = '套件自己声明 SKIP（环境不具备）'
  } else if (tickCount(out) === 0 && !declaresSuccess(out)) {
    // ★★★ 2026-10-19：**一条断言都没有、也没有成功总结** —— 大概率是"根本没跑"，
    //   绝不能因为 exit 0 就当通过。这条是为了堵住假阳性。
    verdict = 'FAIL'
    detail = '没有输出任何断言标记，也没有成功总结 —— 无法确认它真的跑了'
  } else if (tickCount(out) === 0) {
    verdict = 'PASS'
    detail = '通过（该套件无逐条断言输出，仅凭成功总结判定）'
  } else {
    verdict = 'PASS'
    detail = `${tickCount(out)} 项断言通过`
  }

  results.push({ ...suite, verdict, detail, ms, out })

  const mark = verdict === 'PASS' ? '✓' : verdict === 'SKIP' ? '⤼' : '✗'
  console.log(`${mark} ${suite.file.padEnd(30)} ${String(ms).padStart(6)} ms  ${detail}`)
  if (!quiet && verdict !== 'PASS' && suite.note !== '') console.log(`    ${suite.note}`)

  // 失败的套件立刻把它自己的错误行打出来 —— 不然还得再跑一遍才知道红在哪
  if (verdict === 'FAIL') {
    const bad = out.split('\n').filter((line) => line.trimStart().startsWith('✗')).slice(0, 12)
    for (const line of bad) console.log(`      ${line.trim()}`)
    if (bad.length === 0) console.log(`      ${out.trim().split('\n').slice(-3).join('\n      ')}`)
  }
}

const pass = results.filter((r) => r.verdict === 'PASS').length
const fail = results.filter((r) => r.verdict === 'FAIL').length
const skip = results.filter((r) => r.verdict === 'SKIP').length
const ticks = results.reduce((sum, r) => sum + tickCount(r.out), 0)
const totalMs = results.reduce((sum, r) => sum + r.ms, 0)

console.log('')
console.log(`合计：${pass} 通过 / ${fail} 失败 / ${skip} 跳过（断言 ${ticks} 项，耗时 ${(totalMs / 1000).toFixed(1)} s）`)

if (fail > 0) {
  console.log('')
  console.log('失败的套件：')
  for (const r of results.filter((x) => x.verdict === 'FAIL')) console.log(`  · ${r.file} —— ${r.detail}`)
  console.log('')
  console.log('✗ 回归未通过')
  process.exit(1)
}

console.log(skip > 0 ? '✓ 已跑的套件全部通过（有跳过项，见上）' : '✓ 全部通过')
process.exit(0)
