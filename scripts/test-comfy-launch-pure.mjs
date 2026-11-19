#!/usr/bin/env node
/**
 * comfy-launch 纯函数直测（2026-11-20 补覆盖缺口⑤，勘察报告 #14：
 *   launchMark×3/watchLaunchedProcess/summarizeLaunchError/assertComfyUp 全 0 触及——
 *   本文件先收两个零 I/O 纯函数；状态机干跑（timer/hook 注入）量大留后续）。
 *
 * 切片：
 *   summarizeLaunchError —— stderr 摘要（error 行过滤优先，不足尾 3 行兜底）
 *   buildPosixLaunchCommand —— POSIX 启动命令构造（单引号转义 / setsid / nohup / env 导出）
 *
 * 纯离线。
 */
import { summarizeLaunchError, buildPosixLaunchCommand } from '../lib/comfy-launch.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('— summarizeLaunchError')
{
  const stderr = 'Loading model...\nTraceback (most recent call last):\nModuleNotFoundError: No module named torch'
  const r = summarizeLaunchError(stderr, '退出码 1')
  ok('★ error 行过滤：Traceback/ModuleNotFound 被挑出拼接',
    r.includes('ModuleNotFoundError') && r.includes('Traceback') && !r.includes('Loading model'), r)
  ok('exitNote 作前缀', r.startsWith('退出码 1'), r)
  const r2 = summarizeLaunchError('errorA\nerrorB\nerrorC\nplain filler\nerrorD\nerrorE', '')
  ok('多 error 行 → 尾 3 行（最靠近退出的最有诊断价值）',
    r2.includes('errorC') && r2.includes('errorE') && !r2.includes('errorA') && !r2.includes('errorB'), r2)
  const r3 = summarizeLaunchError('plain line 1\nplain line 2', 'exit 2')
  ok('无 error 关键字 → 兜底尾 3 行原文', r3.includes('plain line 1') && r3.includes('plain line 2'), r3)
  ok('空 stderr → 只有 exitNote', summarizeLaunchError('', 'exit 3') === 'exit 3', summarizeLaunchError('', 'exit 3'))
  ok('CRLF 输入容忍（Windows 管道尾巴）',
    summarizeLaunchError('step X\r\nError: boom\r\n', 'e').includes('Error: boom'))
}

console.log('— buildPosixLaunchCommand')
{
  const { wrapped, cmd, full } = buildPosixLaunchCommand({
    py: '/opt/py/bin/python', args: ['-s', 'main.py'], pidFile: '/tmp/p.pid',
    logPath: '/tmp/l.log', launchEnv: [['FOO', "a'b"]], useSetsid: false,
  })
  ok("★ 单引号被 POSIX 转义（出现 \\'\\'' 序列 = 转义发生实锤，双层包裹后形态仍稳定）",
    wrapped.includes("'\\''"), wrapped)
  ok("wrapped 形态：sh -c '<echo $$ > pid; export ...; exec py args>'",
    wrapped.startsWith('sh -c ') && wrapped.includes('echo $$ > ') && wrapped.includes('; export FOO=')
    && wrapped.includes('exec ') && wrapped.includes('/opt/py/bin/python'), wrapped)
  ok('★ 非 setsid → nohup 形态（& 统一由 full 收尾——cmd 尾带 & 会让 full 重定向失效）',
    cmd.includes('nohup') && !cmd.includes('&') && !cmd.includes('setsid'), cmd)
  ok('★ full = cmd + 日志重定向 + stdin 断开 + & 收尾（重定向必须包住 nohup 本体）',
    full.startsWith(cmd) && full.endsWith(`>${'/tmp/l.log'.replace('/tmp/l.log', "'/tmp/l.log'")} 2>&1 < /dev/null &`)
    && full.includes('& >') === false, full)
  const s = buildPosixLaunchCommand({ py: 'p', args: [], pidFile: 'x', logPath: 'l', launchEnv: [], useSetsid: true })
  ok("★ useSetsid → setsid --fork 形态（不残留父进程组）", s.cmd.startsWith('setsid --fork'), s.cmd)
  const n = buildPosixLaunchCommand({ py: 'p', args: [], pidFile: 'x', logPath: 'l', launchEnv: [], useSetsid: false })
  ok("无 env → 无 export 段（拼接不留双空格脏串）", !n.wrapped.includes('export'), n.wrapped)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
