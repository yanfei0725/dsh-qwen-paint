/**
 * lib/diag.js —— 同步落盘诊断（2026-10-19 从 index.js 拆出）。
 * 被 index.js 与 comfy-launch.js 共用；只依赖 config.js 的 DIAG_ON / DIAG_FILE。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DIAG_FILE, DIAG_ON } from './config.js'

/**
 * ★★★ 2026-10-09 **同步落盘诊断**（DSH/Electron 环境下唯一可靠的取证手段）。
 *
 * ## 为什么必须用它
 *   插件跑在 DSH（Electron）主进程里，它的 stdout/stderr 我们**拿不到** ——
 *   `console.log`／宿主 logger 全都看不到。所以"插件到底加载到哪一步、
 *   每次轮询看到什么值"就只能靠它自己写文件。
 *
 * ## 为什么用 `writeFileSync` 而不是 `fsp.writeFile`
 *   异步写需要 await、还可能被事件循环里别的活插队；而我们在排查的就是
 *   "某个 await 之后的代码到底有没有执行"。同步写**在调用点当场落盘**，
 *   不会因为后面抛错/中断而丢失 —— 排查期这点极重要。
 *
 * ## 会不会拖慢/写爆
 *   每次调用只 append 一行、文件上限 400 行（超出自动截断）。
 *   只在**插件加载**与**状态端点每次轮询**时写，开销可忽略。
 *   排查结束后整块删掉即可（已用 `DSHQP_DIAG` 开关收口，见下）。
 */
export function diag(tag, detail) {
  if (!DIAG_ON || DIAG_FILE === '') return
  try {
    // ★★★ 2026-10-17：**每行都带 pid**（原来只有 `[apply]` 那行有）。
    //   原因：`DIAG_FILE` 是**固定路径**，而这里做的是"读全文件 → 写全文件"，
    //   不是原子追加。一旦两个进程同时开诊断（双开 DSH、残留的插件实例、
    //   甚至一个跑测试的 node），日志就会被缝在一起，光看行内容分不清谁写的 ——
    //   实际踩到过：把测试进程临时起的端口误当成本机 `comfyUrl`，白查一轮。
    const line = `${new Date().toISOString()} [${tag}] pid=${process.pid} ${detail ?? ''}\n`
    let prev = ''
    try { prev = readFileSync(DIAG_FILE, 'utf8') } catch { prev = '' }
    const lines = prev.split('\n')
    const kept = lines.length > 400 ? `${lines.slice(-400).join('\n')}\n` : prev
    writeFileSync(DIAG_FILE, kept + line, 'utf8')
  } catch {
    /* 诊断永远不该成为故障源 */
  }
}
