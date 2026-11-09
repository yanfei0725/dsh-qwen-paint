/**
 * dsh-qwen-paint — 自测用的假 ComfyUI HTTP 服务器
 * ============================================================================
 * 从 `scripts/selftest.mjs` 里拆出来的：它是一段**自带状态、不依赖被测代码**的
 * 独立桩件，跟断言逻辑没有耦合，留在测试主文件里只是把主文件撑大。
 *
 * 三个状态位原先靠模块级 `let` 共享，Bash 侧的断言直接读写它们 —— 那种"跨文件
 * 可变闭包"正是拆分最容易拆坏的东西。这里改成**显式 state 对象**：
 *
 *   const comfy = createFakeComfyUI()
 *   await comfy.listen()                     // 随机本地端口
 *   comfy.port                              // 拿端口拼 comfyUrl
 *   comfy.state.submittedBody               // /prompt 收到的那份载荷
 *   comfy.state.historyCalls                // /history 被轮询的次数
 *   comfy.state.queue = { queue_running: [[0, 'x']], queue_pending: [] }  // 忙/闲
 *   await comfy.close()
 *
 * 行为与拆分前逐字节一致：同样的四条路由、同样的 404 兜底、同样的 history 载荷。
 * ============================================================================
 */

import http from 'node:http'

/** 固定的 prompt_id —— 断言里会直接拿它拼 `/history/selftest-pid`。 */
export const FAKE_PROMPT_ID = 'selftest-pid'

/**
 * 造一个假 ComfyUI。**不自动 listen**（调用方要能先建临时目录、写假的出图文件）。
 * @returns {{ server: import('node:http').Server, state: object, port: number, listen: () => Promise<number>, close: () => Promise<void> }}
 */
export function createFakeComfyUI() {
  const state = {
    /** `/prompt` 收到的解析后载荷；没提交过就是 null。 */
    submittedBody: null,
    /** `/history` 被轮询的次数（断言"轮询确实发生了"）。 */
    historyCalls: 0,
    /** 空闲关停判定"忙不忙"要读它；默认空队列 = 不忙。 */
    queue: { queue_running: [], queue_pending: [] },
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url.pathname === '/system_stats') return send(200, { system: { comfyui_version: 'selftest' } })
    if (url.pathname === '/queue') return send(200, state.queue)
    if (url.pathname === '/prompt') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        state.submittedBody = JSON.parse(body)
        send(200, { prompt_id: FAKE_PROMPT_ID })
      })
      return
    }
    if (url.pathname === `/history/${FAKE_PROMPT_ID}`) {
      state.historyCalls += 1
      return send(200, {
        [FAKE_PROMPT_ID]: {
          status: { status_str: 'success', completed: true },
          outputs: { 10: { images: [{ filename: 'fake_out.png', subfolder: '', type: 'output' }] } },
        },
      })
    }
    send(404, {})
  })

  let port = 0

  const listen = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    return port
  }
  const close = () => new Promise((resolve) => server.close(resolve))

  return {
    server,
    state,
    /** 监听之后才有值（启动前是 0）。 */
    get port() { return port },
    listen,
    close,
  }
}
