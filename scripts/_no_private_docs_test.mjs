#!/usr/bin/env node
/**
 * `_no_private_docs_test.mjs` —— **私人 / 开发文档绝不能出现在公开仓库里**
 *
 * ## 这条规矩是谁定的
 *
 * 主人（2026-10-17）原话：
 *
 *   「私人对话的报告绝对不能推到 github 上面。任何[私人]性质的都不能贴上去，
 *     能推上去的只有 README、这个包相关的文件、给 DSH 的安装说明 —— 就这三类。」
 *
 * ## 为什么需要一道测试，而不只是"记得别推"
 *
 * 因为**已经漏过一次**：`专业卡版-实施报告-20261014.md`（里面引着主人原话）
 * 在 0.17.0 就被提交进了公开仓库，而且后来还被**手工加进同步脚本的白名单**，
 * 理由写的是"它早就推上去了，属于有意发布"—— 把"已经漏了"当成"应该漏"。
 *
 * 那次漏掉的直接原因是：扫描用了 `git ls-files | grep 报告`，
 * 而 git 默认会把中文路径转义成 `"\344\270\223..."`，**grep 一个字都匹配不到**，
 * 于是"检查通过"。这类假阴性比没有检查更危险。
 *
 * ⇒ 本文件同时钉住两件事：
 *   ① 文件名黑名单（报告 / 核验 / 勘察 / 清单 / 笔记 / 交接 / 私人 / 审计）
 *   ② **必须用 `git -c core.quotepath=false`**，否则中文路径扫不到（上面的假阴性）
 *   ③ 内容指纹（工作区记忆 / 对话历史 / 交接资料）—— 改了名也跑不掉
 *
 * ## 判据
 *   · 仓库里没有 `.git`（比如在源码目录跑）→ **SKIP，exit 0**（不是失败）
 *   · `git` 起不来（沙箱禁止派生）→ **SKIP，exit 0**
 *   · 命中任何一条 → **FAIL，exit 1**
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SELF = path.basename(fileURLToPath(import.meta.url))

/** 文件名里出现这些字样 = 私人 / 开发文档，不许进公开仓库。 */
const DENY_NAME = ['报告', '核验', '勘察', '清单', '笔记', '交接', '私人', '审计']
/** 内容指纹：改了文件名也跑不掉。
 *  ⚠ 只放**交接材料特有**的串。别放"对话历史"这种泛词 —— 它在 `lib/client.js:740`
 *    是正常 UI 注释（"新对话历史本来就短，一藏就滚不动"），加进来就是假阳性，
 *    而假阳性会让人把整道检查关掉，比没有检查更糟。 */
const DENY_CONTENT = ['工作区记忆', '记忆与对话历史', '交接资料', '交接导读', '.workbuddy-ai']

const ok = (msg) => console.log(`  ✓ ${msg}`)
const bad = (msg, detail) => {
  console.log(`  ✗ ${msg}`)
  if (detail !== undefined) console.log(`      ${String(detail).slice(0, 400)}`)
  failures += 1
}
let failures = 0

if (!existsSync(path.join(ROOT, '.git'))) {
  console.log('⤼ SKIP：本目录没有 .git（在源码目录跑属于正常情况）—— 该检查只在发布副本里生效')
  process.exit(0)
}

// ★ 必须关掉 quotepath：否则中文路径会被转义成 "\344\270\223..."，grep 永远匹配不到
const listed = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files'], {
  cwd: ROOT,
  encoding: 'utf8',
})
if (listed.error !== undefined && listed.error !== null) {
  console.log(`⤼ SKIP：git 起不来（${listed.error.code ?? listed.error.message}）—— 环境不允许，不是测试写错`)
  process.exit(0)
}
if ((listed.status ?? 1) !== 0) {
  console.log(`⤼ SKIP：git ls-files 返回 ${listed.status}`)
  process.exit(0)
}

const files = listed.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '')
ok(`拿到 ${files.length} 个被 git 跟踪的文件（已关闭 quotepath，中文路径可见）`)

// ① 文件名黑名单
const byName = files.filter((f) => DENY_NAME.some((pat) => f.includes(pat)))
if (byName.length === 0) {
  ok('没有名字含「报告 / 核验 / 勘察 / 清单 / 笔记 / 交接 / 私人 / 审计」的被跟踪文件')
} else {
  bad(`有 ${byName.length} 个私人 / 开发文档被 git 跟踪，绝不能推上 GitHub`, byName.join('\n      '))
}

// ② 内容指纹（只扫文本文件，二进制跳过）
const exts = new Set(['.md', '.txt', '.json', '.mjs', '.js', '.py', '.yml', '.yaml', '.cmd', '.sh', '.ps1', '.ts'])
const byContent = []
for (const rel of files) {
  if (path.basename(rel) === SELF) continue
  if (!exts.has(path.extname(rel).toLowerCase())) continue
  let text = ''
  try { text = readFileSync(path.join(ROOT, rel), 'utf8') } catch { continue }
  const hit = DENY_CONTENT.find((mark) => text.includes(mark))
  if (hit !== undefined) byContent.push(`${rel}  ← 含「${hit}」`)
}
if (byContent.length === 0) {
  ok(`没有文件含私人内容指纹（${DENY_CONTENT.join(' / ')}）`)
} else {
  bad(`有 ${byContent.length} 个文件含私人内容指纹`, byContent.join('\n      '))
}

// ③ 用户明确允许上 GitHub 的三类，至少得有 README
const hasReadme = files.some((f) => f === 'README.md')
if (hasReadme) ok('README.md 在（这是允许发布的三类之一）')
else bad('缺 README.md —— 发布清单异常')

console.log(failures === 0 ? '\n=== 结果：全部通过 ===' : `\n=== 结果：${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
