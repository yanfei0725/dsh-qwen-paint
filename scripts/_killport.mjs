/**
 * 找出监听指定端口的进程并强制结束（含子进程树）。
 *
 * 为什么要单独写一个脚本：
 *   · `netstat | findstr` 的输出列间距不固定，正则必须容忍多空格；
 *   · PowerShell 的 WMI 过滤器里的 `%python%` 会被上层判成 cmd 变量语法而拒执行；
 *   · 在 Bash 里用 heredoc 写含 `$` / 反引号的 Node 代码会被 shell 先吃掉一遍。
 *   所以固定成文件，参数化端口，各处复用。
 *
 * 用法：node scripts/_killport.mjs [端口=8188]
 */
import { execSync } from 'node:child_process'

const port = process.argv[2] ?? '8188'

let out = ''
try {
  out = execSync('netstat -ano -p TCP', { encoding: 'utf8', maxBuffer: 1 << 26 })
} catch (e) {
  out = e.stdout ?? ''
}

const pids = new Set()
for (const line of out.split(/\r?\n/)) {
  // 例：  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       19216
  const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
  if (!m) continue
  if (m[1] !== port) continue
  if (m[2] === '0') continue
  pids.add(m[2])
}

if (pids.size === 0) {
  console.log(`端口 ${port} 上没有监听进程`)
  process.exit(0)
}

for (const pid of pids) {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    console.log(`已结束 pid=${pid}`)
  } catch (e) {
    console.log(`结束 pid=${pid} 失败：${String(e.stderr ?? e.message).slice(0, 160)}`)
  }
}
