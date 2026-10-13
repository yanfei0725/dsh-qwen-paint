/**
 * _mac_env_test.mjs —— macOS / MPS 环境变量注入 + POSIX 启动命令构造的回归。
 *
 * 守四件事：
 *   ① **引号是对的**（**不依赖外部 shell**）：把生成的命令按 POSIX 单引号规则做一次
 *      "往返解析"，断言解析出的 argv 恰好是 `['sh','-c',<内层脚本>]`，
 *      且内层脚本与预期**逐字相同**；
 *   ② **真跑一遍**（环境允许时）：断言注入的变量**确实出现在子进程的环境里**；
 *   ③ **没有环境变量时命令与从前一致**（不带多余的 export，不引入回归）；
 *   ④ **注入只在 macOS 生效**（其它平台没有 MPS 后端，纯噪音）。
 *
 * ★ 为什么①是主力、②只是"锦上添花"（这是被现实逼出来的设计）
 *   启动命令要穿 `sh -c` → `sh -c` → `exec` **三层引号**，写错一个字符的表现是
 *   "命令返回成功、但什么都没发生"（本项目踩过同类坑）。
 *   最初这一套**只靠"真起一个 sh"**来验 —— 结果沙箱一旦禁止派生进程，整条回归就**全瞎了**：
 *   实测 `spawnSync sh EBUSY`，连 `C:/Windows/System32/cmd.exe` 都起不来。
 *   ⇒ 补上①：一个**纯 JS 的 POSIX 单引号解析器**，不 spawn 任何进程，
 *     却能精确判断"内层脚本有没有被外层引号抹平" —— 而这正是当初那个 bug 的形态。
 *   ② 仍保留（真跑一次是更强的证据），但**环境不允许时大声跳过**，绝不假装通过。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { buildPosixLaunchCommand, DEFAULTS } = mod.__internal
const HOST = ['index.js', 'config.js', 'describe.js']
  .map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8'))
  .join('\n')

let fail = 0
let skipped = 0
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ← ${extra}` : ''}`)
  if (!cond) fail += 1
}
const skip = (name, why) => { skipped += 1; console.log(`  SKIP ${name}  ← ${why}`) }

/**
 * ★ 纯 JS 的 POSIX 单引号解析器（只覆盖本项目命令用到的语法：
 *   单引号串 + `\'` 转义 + 空白分词）。
 *
 * 为什么要自己写：本机沙箱**禁止派生任何子进程**，没法借真 shell 验引号；
 * 而"引号有没有被外层抹平"恰恰是**纯文本层面**的问题，不需要真 shell 就能判定。
 *
 * ⚠ 它**不是**通用 shell 解析器（不处理双引号 / 管道 / 重定向语义）——
 *   只回答一个问题：**这段文本按 POSIX 规则会被切成哪些 argv**。
 */
function shellTokens(src) {
  const out = []
  let cur = ''
  let has = false
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      if (has) { out.push(cur); cur = ''; has = false }
      i += 1
      continue
    }
    if (c === "'") {
      i += 1
      while (i < src.length && src[i] !== "'") { cur += src[i]; i += 1 }
      i += 1 // 跳过收尾的单引号
      has = true
      continue
    }
    if (c === '\\') { cur += src[i + 1] ?? ''; i += 2; has = true; continue }
    cur += c
    has = true
    i += 1
  }
  if (has) out.push(cur)
  return out
}

const tmp = mkdtempSync(path.join(tmpdir(), 'qwen-macenv-'))
const pidFile = path.join(tmp, 'launch.pid')
const logPath = path.join(tmp, 'launch.log')

/** 用 `sh` 当"python"：`sh -c 'printf %s "$K"'` 就能把环境变量打出来，等价于真跑一次启动。 */
const echoVar = (k) => ['-c', `printf '%s' "$${k}"`]

console.log('=== ① 引号往返解析（纯 JS，不 spawn —— 这是主力回归） ===')
const innerArgs = ['-s', '/path/main.py', '--disable-auto-launch']
const env2 = [['PYTORCH_ENABLE_MPS_FALLBACK', '1'], ['PYTORCH_MPS_HIGH_WATERMARK_RATIO', '0.0']]
const c1 = buildPosixLaunchCommand({
  py: '/usr/bin/python3', args: innerArgs, pidFile, logPath, launchEnv: env2, useSetsid: false,
})

const t1 = shellTokens(c1.wrapped)
ok('★ `wrapped` 解析出来恰好 3 个 argv（`sh` / `-c` / 一段脚本）—— 多一个都说明引号被抹平了',
  t1.length === 3, `实际 ${t1.length} 个：${JSON.stringify(t1.map((x) => String(x).slice(0, 40)))}`)
ok('★ argv[0..1] 是 `sh -c`', t1[0] === 'sh' && t1[1] === '-c', JSON.stringify(t1.slice(0, 2)))
// 内层脚本必须**逐字**等于预期（含它自己的引号）—— 这是当初那个 bug 的精确判据
const expectedScript = `echo $$ > '${pidFile}'; export PYTORCH_ENABLE_MPS_FALLBACK='1'; `
  + `export PYTORCH_MPS_HIGH_WATERMARK_RATIO='0.0'; exec '/usr/bin/python3' '-s' '/path/main.py' '--disable-auto-launch'`
ok('★ 内层脚本逐字等于预期（参数各归各位、没有被拆成裸 token）',
  t1[2] === expectedScript, JSON.stringify(String(t1[2] ?? '').slice(0, 200)))
ok('★ 内层脚本里的 `exec` 只有一个（不是被拆成多个语句）',
  shellTokens(t1[2] ?? '').filter((x) => x === 'exec').length === 1)
ok('★ `export` 出现在 `exec` **之前**',
  String(t1[2]).indexOf('export ') > 0 && String(t1[2]).indexOf('export ') < String(t1[2]).indexOf('exec '))
ok('★ 两个 MPS 变量都写进内层脚本',
  String(t1[2]).includes('PYTORCH_ENABLE_MPS_FALLBACK')
  && String(t1[2]).includes('PYTORCH_MPS_HIGH_WATERMARK_RATIO'))
// 含空格 / 含单引号的参数：内层脚本里必须**仍被引号包住**（否则内层 sh 会拆开它）
const c2 = buildPosixLaunchCommand({
  py: '/usr/bin/python3', args: ['-c', 'printf %s "$1"', 'x', 'a b  c', "it's ok"],
  pidFile, logPath, launchEnv: [], useSetsid: false,
})
const t2 = shellTokens(c2.wrapped)
ok('★ 含空格 / 含单引号的参数在内层脚本里**各自仍被引号包住**（不被拆开）',
  t2.length === 3 && String(t2[2]).includes("'a b  c'") && String(t2[2]).includes(`'it'\\''s ok'`),
  JSON.stringify(String(t2[2] ?? '').slice(0, 220)))
ok('★ 不带环境变量时**不出现** export（不引入多余语句）',
  !String(shellTokens(buildPosixLaunchCommand({
    py: '/usr/bin/python3', args: innerArgs, pidFile, logPath, launchEnv: [], useSetsid: false,
  }).wrapped)[2]).includes('export '))
ok('★ 两种包装都在：无 setsid → `nohup ... &`；有 setsid → `setsid --fork`',
  c1.cmd.startsWith('nohup ') && c1.cmd.trimEnd().endsWith('&')
  && buildPosixLaunchCommand({ py: 'x', args: [], pidFile, logPath, useSetsid: true }).cmd.startsWith('setsid --fork sh -c '))
ok('★ 完整命令带日志重定向与脱离终端（`>log 2>&1 < /dev/null &`）',
  c1.full.includes('2>&1 < /dev/null &'))

console.log('\n=== ② 真跑一遍：变量必须出现在**子进程**的环境里（环境不允许则跳过） ===')
/** 找一个可用的 POSIX shell；**环境禁止 spawn 时返回 null**（不假装通过）。 */
function findSh() {
  for (const c of ['sh', 'bash', '/bin/sh', '/usr/bin/sh']) {
    try {
      execFileSync(c, ['-c', 'exit 0'], { stdio: 'ignore' })
      return c
    } catch (e) {
      // ENOENT = 没装；EBUSY / EPERM / EACCES = 本环境禁止派生进程 —— 两种都不是"命令写错了"
      if (e?.code && !['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) return c
    }
  }
  return null
}
const sh = findSh()
if (sh === null) {
  skip('真跑一遍（②整节）',
    '本环境**禁止派生任何子进程**（实测 sh / bash / cmd 全部 EBUSY）'
    + ' —— ① 的纯 JS 往返解析已覆盖引号正确性')
} else {
  // 吞异常返回哨兵：命令引号坏掉时 shell 会非零退出，直接抛会让整个脚本**崩在中途**、
  // 连 `=== 结果 ===` 都不打印（第一版就是这么写的，做牙齿检查时才发现失败模式不可读）。
  const run = (wrapped) => {
    try {
      return execFileSync(sh, ['-c', wrapped], { encoding: 'utf8' })
    } catch (e) {
      return `__RUN_FAILED__:${String(e?.stderr ?? e?.message ?? '').trim().split('\n')[0]}`
    }
  }
  /**
   * ★★★ 关键：**区分"环境不允许"和"命令写错了"**（实测踩到才加的）。
   *   本机沙箱对派生进程的限制是**间歇性的** —— `findSh()` 探测时能起、几毫秒后再起就 EBUSY，
   *   所以"整节守卫"不可靠（第一版就是这么写的，结果 9 条全报 FAIL，看着像代码坏了）。
   *   ⇒ 逐条判断：
   *     · `spawnSync <cmd> EBUSY/ENOENT/EPERM/EACCES` → **Node 连进程都没起来** → 环境问题 → SKIP；
   *     · `sh: -c: line 1: unexpected EOF ...` 之类 → **shell 真在抱怨命令** → 真失败 → FAIL。
   *   ⚠ 绝不能把后者也当跳过 —— 那正是这套回归要抓的形态。
   */
  const isSpawnIssue = (out) => /spawnSync|\bEBUSY\b|\bENOENT\b|\bEPERM\b|\bEACCES\b/u.test(String(out))
  let anyRan = false
  const check = (name, got, want) => {
    if (isSpawnIssue(got)) { skip(name, '环境禁止派生进程（Node 起不来，不是命令写错）'); return }
    anyRan = true
    ok(name, got === want, JSON.stringify(got))
  }
  /** 依赖"真的跑起来了"的断言：跑不起来就跳过（否则会在受限环境里假失败）。 */
  const checkRan = (name, cond) => {
    if (!anyRan) { skip(name, '本环境没能真跑起来，无从验证'); return }
    ok(name, cond)
  }
  const mk = (launchEnv, key) => buildPosixLaunchCommand({
    py: sh, args: echoVar(key), pidFile, logPath, launchEnv, useSetsid: false,
  })
  check('★ PYTORCH_ENABLE_MPS_FALLBACK 真的传到了子进程',
    run(mk([['PYTORCH_ENABLE_MPS_FALLBACK', '1']], 'PYTORCH_ENABLE_MPS_FALLBACK').wrapped), '1')
  check('★ PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 真的传到了子进程',
    run(mk([['PYTORCH_MPS_HIGH_WATERMARK_RATIO', '0.0']], 'PYTORCH_MPS_HIGH_WATERMARK_RATIO').wrapped), '0.0')
  check('★ 不注入时子进程里**确实没有**这个变量（证明上面的"有"不是环境自带的）',
    run(mk([], 'PYTORCH_ENABLE_MPS_FALLBACK').wrapped), '')
  checkRan('★ pid 文件被写出且内容为纯数字',
    existsSync(pidFile) && /^\d+$/u.test(String(readFileSync(pidFile, 'utf8')).trim()))
  const q = (args) => buildPosixLaunchCommand({ py: sh, args, pidFile, logPath, launchEnv: [], useSetsid: false })
  check('★ 含**空格**的单个参数原样到达（修前会被拆成两个）',
    run(q(['-c', 'printf %s "$1"', 'x', 'a b  c']).wrapped), 'a b  c')
  check('★ 含**单引号**的参数原样到达（修前会引号失衡、整条命令语法错）',
    run(q(['-c', 'printf %s "$1"', 'x', "it's ok"]).wrapped), "it's ok")
  check("★ 参数**不被合并**：`-c 'echo hi'` 里 `hi` 不能变成 $0（修前只吐空行）",
    run(q(['-c', 'echo hi']).wrapped), 'hi\n')
  // 含空格的路径：先建出那个带空格的目录，否则 sh 会报 No such file、掩盖真正的结论
  const spacedDir = path.join(tmp, 'a b')
  mkdirSync(spacedDir, { recursive: true })
  const spacedPid = path.join(spacedDir, 'x.pid')
  const r2 = buildPosixLaunchCommand({
    py: sh, args: ['-c', 'echo pathok'], pidFile: spacedPid, logPath, useSetsid: false,
  })
  check('★ 含空格的 pid 路径不会被拆成"重定向 + 多一个参数"', run(r2.wrapped), 'pathok\n')
  checkRan('★ 含空格的 pid 路径**确实写成了那个文件**（不是被截断）',
    existsSync(spacedPid) && /^\d+$/u.test(String(readFileSync(spacedPid, 'utf8')).trim()))
}

console.log('\n=== ③ 注入只在 macOS 生效（其它平台没有 MPS 后端） ===')
ok('★ launchEnv 的构造被 IS_MAC 闸住（非 macOS 直接返回空数组）',
  /const launchEnv = \(\(\) => \{\s*\n\s*if \(!IS_MAC\) return \[\]/u.test(HOST))
ok('★ 两个开关名与端点参数对得上（applempsfallback / applempsunlimited）',
  HOST.includes("['applempsfallback', 'appleMpsFallback'")
  && HOST.includes("['applempsunlimited', 'appleMpsUnlimitedMem'"))
ok('★ 端点对非 macOS **拒绝**改这两个开关（护栏，与 SageAttention 同一条原则）',
  /key === 'appleMpsFallback' \|\| key === 'appleMpsUnlimitedMem'\) && !IS_MAC/u.test(HOST))
ok('★ 默认值：回退兜底开、水位上限关',
  DEFAULTS.appleMpsFallback === true && DEFAULTS.appleMpsUnlimitedMem === false)
ok('★ 注入用的是 `gpu.env`（档案级默认），不是散落的硬编码',
  /Object\.entries\(gpu\.env \?\? \{\}\)/u.test(HOST))

try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }

const tail = skipped > 0 ? `（另有 ${skipped} 节因环境限制跳过，见上方 SKIP 行）` : ''
console.log(`\n=== 结果：${fail === 0 ? `全部通过${tail}` : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
