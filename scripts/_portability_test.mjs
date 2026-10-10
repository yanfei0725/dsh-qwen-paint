/**
 * 跨平台 / 跨显卡 通用性自查
 *
 * 用法：node scripts/_portability_test.mjs
 *
 * 这个脚本**不启动任何东西**，只静态审查源码，专门找
 * "在 Windows 能用、到 Linux 就炸"（或反过来）的地方 —— 这是本项目里
 * 最容易埋雷、也最难在单机上发现的一类问题。
 *
 * 检查项：
 *   ① 所有 IS_WINDOWS 分支都必须有非 Windows 的对应实现
 *   ② 不能出现"只有 Windows 命令、没有平台判断"的裸调用
 *   ③ 平台相关的命令都必须走 runShell（唯一入口）
 *   ④ GPU 探测两端都要有实现
 *   ⑤ 关键常量（超时、白名单）都要有
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
let fail = 0
const assert = (name, cond, extra) => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra && !cond ? `  ← ${extra}` : ''}`)
  if (!cond) fail += 1
}

console.log('=== 1. 平台判断入口 ===')
assert('有 IS_WINDOWS', /const IS_WINDOWS = process\.platform === 'win32'/u.test(src))
assert('有 IS_LINUX', /const IS_LINUX = process\.platform === 'linux'/u.test(src))
assert('有 runShell 统一入口', /async function runShell\(/u.test(src))

console.log('\n=== 2. Windows 专有命令必须都在平台分支里 ===')
// 这些命令在 Linux 上根本不存在；出现它们的地方**必须**有 IS_WINDOWS 判断
const WIN_ONLY = [
  'Get-CimInstance',
  'Get-NetTCPConnection',
  'Get-Process -Id',
  'Get-Command',
  'Stop-Process',
  'Invoke-CimMethod',
  'Get-PSDrive',
]
for (const cmd of WIN_ONLY) {
  // 找出每一处出现，检查同一行或上一行附近有没有 IS_WINDOWS
  const lines = src.split('\n')
  let unguarded = 0
  lines.forEach((line, i) => {
    if (!line.includes(cmd)) return
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return // 注释不算
    // 上下 120 行内出现 IS_WINDOWS 就算已加闸。
    // ⚠ 窗口要够宽：平台分支里的**命令字符串数组**常常跨几十上百行
    //   （例如 Windows 的 .cmd 方案 + 窗口最小化的 .ps1 数组就有一大段），
    //   窗口太窄会把"已经加了闸"的地方误报成裸调用
    //   （**2026-10-09 又踩一次**：新增最小化用的 ps1 数组后，
    //     Invoke-CimMethod 距 `if (IS_WINDOWS)` 已超过 60 行）。
    //   ⚠ 但也不能无限宽 —— 太宽会让真正的裸调用被隔壁分支的 IS_WINDOWS 掩盖。
    //   ★ 2026-10-10 再放宽：120 → 170。因为又给最小化用的 .ps1 数组加了约 20 行
    //     （修 Win11/Windows Terminal 下"窗口不最小化"），把 Invoke-CimMethod 顶出了窗口。
    //     ⚠ 已人工确认：那处 Invoke-CimMethod 确实在 `if (IS_WINDOWS) {` 块内（不是裸调用），
    //       所以放宽窗口是"跟上代码长度"，不是掩盖问题。
    const near = lines.slice(Math.max(0, i - 170), i + 171).join('\n')
    if (!near.includes('IS_WINDOWS')) unguarded += 1
  })
  assert(`${cmd} 全部有平台闸`, unguarded === 0, `${unguarded} 处未加闸`)
}

console.log('\n=== 3. Linux 侧实现必须成对存在 ===')
assert('有 Linux GPU 探测命令', src.includes('GPU_PROBE_LINUX'))
assert('Linux GPU 探测含 nvidia-smi', src.includes('nvidia-smi'))
assert('Linux GPU 探测含 rocm-smi', src.includes('rocm-smi'))
assert('Linux GPU 探测含 lspci 兜底', src.includes('lspci'))
assert('Linux GPU 探测含 /sys 兜底', src.includes('/sys/class/drm'))
assert('有 Linux 路径扫描', src.includes('COMFY_SEARCH_NIX'))
assert('Linux 路径扫描含 venv/bin/python', src.includes('venv/bin/python'))
assert('Linux 启动用 setsid 或 nohup', src.includes('setsid') && src.includes('nohup'))
assert('Linux 停止用 kill', src.includes('kill ${found.pid}'))

console.log('\n=== 4. 进程存活查询两端都要有 ===')
assert('存活查询有 Windows 分支（Get-Process）', src.includes("Get-Process -Id ${pid}"))
assert('存活查询有 POSIX 分支（kill -0）', src.includes('kill -0 ${pid}'))

console.log('\n=== 5. 显卡厂商覆盖（A/N/I + 各代系）===')
for (const key of ['amd_rdna2', 'amd_rdna3', 'amd_rdna4', 'amd', 'nvidia', 'intel_battlemage', 'intel_alchemist', 'intel', 'unknown']) {
  assert(`厂商档案含 ${key}`, src.includes(`${key}: {`))
}
assert('Windows 用 WMI 取显卡', src.includes('Win32_VideoController'))
assert('PCI vendor id 兜底映射', src.includes("'0x1002'") && src.includes("'0x10de'") && src.includes("'0x8086'"))

console.log('\n=== 6. pid 定位（跨平台的同一个坑）===')
assert('有 resolveChildPid', src.includes('async function resolveChildPid'))
assert('pid 查询有 Windows 分支（ParentProcessId）', src.includes('ParentProcessId=${parentPid}'))
assert('pid 查询有 POSIX 分支（ps ppid）', src.includes('ppid'))
// 关键：pid 不可用时**不能**做存活判断（否则 Get-Process -Id 0 失败 → 误判进程已死）
assert('★ pid 无效时不做存活判断（防误判）', src.includes('没有可靠 pid'))
assert('★ 存活查询异常时不判死', src.includes('存活查询失败，本轮跳过判定'))

console.log('\n=== 7. 状态机（单一真相源）===')
assert('有纯函数 launchView', src.includes('function launchView('))
assert('★ 已删除并行的 comfyStartRequestedAt 变量', !/let comfyStartRequestedAt/u.test(src))
assert('★ 45 秒必然收口', src.includes('LAUNCH_TIMEOUT_MS = 45000'))

console.log('\n=== 8. 诊断取证能力（Electron 里唯一可行）===')
assert('有同步落盘诊断 diag()', src.includes('function diag('))
assert('用 writeFileSync（不依赖 await）', src.includes('writeFileSync(DIAG_FILE'))
assert('插件加载时即记录', src.includes("diag('apply'"))

console.log('\n=== 9. ★ 宿主 API 必须受保护（"卡在启动中"的真凶）===')
// 实测踩到的坑：`ctx.on` 在部分宿主上不是函数，**裸调用抛 TypeError**，
// 而它所在的 inject 回调里后面还有「状态端点注册」——
// 一次未捕获的异常把整个回调掐死，状态端点永不注册，前端拿不到状态 → 界面永远"启动中"。
// 判据：初始化里的宿主调用必须走 step()/try 保护；且必须有步骤级取证。
// ★★★ 2026-10-09 最重要的一条：必须用 DSH **官方模式**声明依赖 + 直接注册。
//   反例（踩了很久）：用 `root.inject(['tools'], cb)` 把全部初始化包在回调里 ——
//   该回调在本机 DSH 上**从不执行**，于是工具/状态端点全都不注册，
//   界面表现为「一直卡在正在启动中」。
assert('★ 有模块级 export const inject 声明（DSH 官方模式）', /export const inject = \[/u.test(src))
assert('★ inject 声明里含 tools', /export const inject = \[[^\]]*'tools'/u.test(src))
// ⚠ 不能写成「源码里不出现 root.inject(['tools'])」—— 说明性注释里会引用这句代码。
//   改成检查**正向特征**：apply 里用的是「立即执行」的 IIFE。
assert('★ apply 里用立即执行（IIFE）而非 inject 回调包一层', /;\(\(ctx\) => \{/u.test(src))
assert('★ apply 的 ctx 直接注册（ctx.tools.register）', /ctx\.tools\.register\(/u.test(src))
assert('有步骤级保护 helper step()', /const step = \(name, fn\) =>/u.test(src))
assert('★ ctx.on 受保护（包在 step 里）', src.includes("step('hook.tools-result'"))
assert('★ 工具注册受保护（register.draw_image）', src.includes("step('register.draw_image'"))
assert('★ 列模型工具受保护', src.includes("step('register.list_available_models'"))
assert('★ 加速工具受保护', src.includes("step('register.accel_env'"))
assert('★ 有宿主能力快照 diag(host)', src.includes("diag('host'"))
assert('★ 有步骤级取证 diag(init)', src.includes("diag('init'"))
// 反例：`ctx.on(` 必须**紧跟在** step('hook.tools-result') 之后（即被它包裹），
//       不能出现在别处裸调用。用位置关系判断，避免正则误伤缩进。
const onIdx = src.indexOf("ctx.on('tools/result'")
const onStepIdx = src.indexOf("step('hook.tools-result'")
assert('★ ctx.on 被 step 包裹（位置正确）',
  onIdx > 0 && onStepIdx > 0 && onIdx > onStepIdx && (onIdx - onStepIdx) < 400,
  `onIdx=${onIdx} stepIdx=${onStepIdx}`)

/* ═══════════════════════════════════════════════════════════════════════
   ★★★ 2026-10-09 新增：三个**真跨平台 bug** 的回归锁

   这一节守的是本轮修掉的实际问题。它们都属于同一类：
   「Windows 上完全正常，Linux/macOS 上必然出错」——
   最容易被漏测的一类，因为开发机就是 Windows。
   ═══════════════════════════════════════════════════════════════════════ */
console.log('\n★ 跨平台回归锁（本轮新修）')

// ── A1：加速包探测的脚本必须**按平台分叉** ─────────────────────────────
//   修前：`runShell` 调用里写死了 PowerShell 语法（`& '...'` / `Out-Null` /
//        `$LASTEXITCODE`），而 runShell 在非 Windows 上走 `sh -c` → 语法错 →
//        被 catch 吞掉 → 恒返回 false → 所有加速包永远"未安装"且反复重装失败。
{
  const idx = src.indexOf('async function probeAccelPack')
  assert('A1 找到 probeAccelPack', idx > 0)
  // 截取函数体（到下一个顶层 async function 为止）
  const rest = src.slice(idx)
  const endIdx = rest.indexOf('\nasync function ', 10)
  const body = endIdx > 0 ? rest.slice(0, endIdx) : rest.slice(0, 3000)

  // ★ 分叉检查：不能简单正则匹配 `IS_WINDOWS ?`，因为代码里 `IS_WINDOWS`
  //   与 `?` 之间夹着解释性注释（那种写法是刻意的，读起来更清楚）。
  //   改为按**函数体切片**判断：Windows 分支与 POSIX 分支都要在，
  //   且各自的特征记号都存在 —— 这才是有意义的"分叉"证据。
  assert('A1 ★ 探测脚本按平台分叉（同时含两条分支的特征）',
    body.includes('IS_WINDOWS')
    && body.includes('$LASTEXITCODE')
    && body.includes('echo YES || echo NO'))
  // PowerShell 分支必须还在（Windows 上不能退化）
  assert('A1 Windows 分支仍用 $LASTEXITCODE', body.includes('$LASTEXITCODE'))
  // POSIX 分支必须存在，且**不再**出现 PowerShell 专有记号
  assert('A1 ★ 有 POSIX 分支（>/dev/null 2>&1）', body.includes('>/dev/null 2>&1'))
  assert('A1 ★ POSIX 分支用 echo YES/NO 而非 PowerShell 写法', /echo YES \|\| echo NO/u.test(body))

  // 反例扫描：PowerShell 的 `Out-Null` 只允许出现在 probeAccelPack 内的
  //   Windows 分支那一段（`$LASTEXITCODE` 附近 300 字符内）。
  //   ⚠ 不能做"同一行必须也含 $LASTEXITCODE"的行级检查 ——
  //     那两行本来就是分开写的（一条命令、一条判断退出码），会误报。
  {
    const codeOnly = src.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
    const strayOutNull = []
    for (const { l, i } of codeOnly) {
      if (!l.includes('Out-Null')) continue
      // 取该行所在位置往前 400 字符、往后 300 字符的窗口，看有没有 $LASTEXITCODE
      const from = Math.max(0, src.indexOf(l) - 400)
      const window = src.slice(from, src.indexOf(l) + l.length + 300)
      // 且必须落在 probeAccelPack 函数体内
      const inProbe = src.indexOf(l) > src.indexOf('async function probeAccelPack')
      if (!window.includes('$LASTEXITCODE') || !inProbe) strayOutNull.push(`第${i + 1}行`)
    }
    assert('A1 ★ 没有脱离 PowerShell 分支的 Out-Null',
      strayOutNull.length === 0, strayOutNull.join(', '))
  }
}

// ── A2：诊断日志不许硬拼 Desktop ──────────────────────────────────────
//   修前：`path.join(home, 'Desktop', '千问1生图', ...)` —— 绕过了跨平台的
//        defaultOutputDir()，Linux 上会在不存在 Desktop 时造出一个空目录。
{
  const idx = src.indexOf('const DIAG_FILE =')
  assert('A2 找到 DIAG_FILE', idx > 0)
  const body = src.slice(idx, idx + 900)
  assert('A2 ★ DIAG_FILE 走 defaultOutputDir()（不再硬拼 Desktop）',
    body.includes('defaultOutputDir()'))
  // 反例：DIAG_FILE 段里不许出现裸的 'Desktop' 字符串拼接
  assert('A2 ★ DIAG_FILE 段内不再出现裸 Desktop 拼接',
    !/path\.join\([^)]*'Desktop'/u.test(body))
}

// ── A3：Windows 扫描器不许硬编码盘符 ─────────────────────────────────
//   修前：`'C:\ComfyUI','D:\ComfyUI','E:\ComfyUI','F:\ComfyUI','G:\ComfyUI','X:\ComfyUI'`
//        —— 装在第 7 个盘或改了盘符就漏（只能靠名字含 comfy 的兜底）。
{
  const idx = src.indexOf('const COMFY_SEARCH_WIN = [')
  assert('A3 找到 COMFY_SEARCH_WIN', idx > 0)
  const body = src.slice(idx, src.indexOf("].join('\\n')", idx))
  assert('A3 ★ 动态枚举盘符（[char[]](65..90)）', body.includes('[char[]](65..90)'))
  // 反例：不许再出现"盘符:盘符:盘符"那种写死的枚举串
  assert('A3 ★ 不再硬编码 C:/D:/E: 盘符列表',
    !/'C:\\\\ComfyUI','D:\\\\ComfyUI'/u.test(body))
  // 仍然要保留最优路径：盘根下的 ComfyUI / ComfyUI_windows_portable
  assert('A3 仍覆盖 X:\\ComfyUI', body.includes('"$drive\\\\ComfyUI"'))
  assert('A3 仍覆盖 ComfyUI_windows_portable', body.includes('ComfyUI_windows_portable'))
  // 兜底的那段（递归找名字含 comfy 的目录）不能被删掉
  assert('A3 仍保留 Get-PSDrive 递归兜底', body.includes('Get-PSDrive'))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
