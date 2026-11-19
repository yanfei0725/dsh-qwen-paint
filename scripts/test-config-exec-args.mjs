/**
 * 断言风格：ok(名称, 条件)。全离线静态护栏，零子进程。
 * 锁住 2026-11-19 的修法：VRAM 探针在 Windows 上直接 argv 调 python，
 * 不再把 py 路径 / 探针代码拼进命令外壳字符串（引号与注入面）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond) => { if (cond) pass++; else failures.push(name) }
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

ok('存在独立 runPython 探针入口', /async function runPython\(py, code/u.test(src))
ok('python 以数组 argv 直接执行', /execFileAsync\(py, \['-c', code\]/u.test(src))
ok('仍传 filteredEnv（不继承代理与凭据变量）', /env: filteredEnv\(\)/u.test(src))
ok('Windows 隐藏子进程窗口', /windowsHide: IS_WINDOWS/u.test(src))
ok('保留统一超时', /timeout: timeoutMs/u.test(src))
ok('VRAM 探针改走 runPython', /await runPython\(py, pyProbe, 30000\)/u.test(src))
ok('旧的 py 路径 / 代码双引号拼接已移除', !/& "\$\{py\}" -c/u.test(src))
ok('Unix 分支仍走 shq + runShell', /runShell\(`\$\{shq\(py\)\} -c \$\{shq\(pyProbe\)\}`, 30000\)/u.test(src))
ok('其它系统探测仍复用 runShell', /await runShell\(probeCmd, 20000\)/u.test(src))
ok('shq 单行结构未被编辑破坏', src.includes("const shq = (s) => `'"))

console.log('\n=== 结果 ===')
console.log(`通过 ${pass}，失败 ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  FAIL', f); process.exit(1) }
console.log('全部通过')
