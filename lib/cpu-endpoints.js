/**
 * lib/cpu-endpoints.js —— CPU 加速档的本机 HTTP 端点（2026-11-13 新增）。
 *
 * 为什么要单独一个文件：`lib/index.js` 只剩约 4.7 KB 就到 DSH Store 单文件上限
 * （262,144 B），再往里面塞端点实现，下次加功能就得先拆文件。所以这里自成一体，
 * index.js 只留 `registerCpuRoutes(...)` 一行。
 *
 * ## 两条端点
 *   `GET  /api/qwen-paint/cpu-profile`  只读：CPU 画像 + 五档说明 + **当前真正会挂的参数**
 *   `POST /api/qwen-paint/cpu-accel`    写档位（落 uiState，重启 ComfyUI 后生效）
 *
 * ## 信任围栏（与 `/api/qwen-paint/inpaint`、`/quick-edit` 完全同一套口径）
 *   1. `isLocalRequest(req)` —— 只认回环来源，防 DNS rebinding / 局域网他人；
 *   2. 方法限制 —— GET 只给画像，写档位必须 POST；
 *   3. `guardWriteRequest(req, res)` —— 校验 Origin / Referer，防跨站表单打本机；
 *   4. `readJsonBody(req)` —— 有界读取（项目里的实现带体积上限），不裸读流。
 *
 * ## 为什么 GET 也要围栏
 *   CPU 型号 + 核心数属于**本机指纹**，不是公开信息。虽然不含路径/用户名，但没必要
 *   让网页里的任意脚本都能读到，所以 GET 一样做回环校验。
 */

import { CPU_ACCEL_MODES, CPU_ACCEL_MODE_INFO, cpuAccelPlan, describeCpuAccel, normalizeCpuAccelMode } from './cpu-profile.js'

export const CPU_PROFILE_PATH = '/api/qwen-paint/cpu-profile'
export const CPU_ACCEL_PATH = '/api/qwen-paint/cpu-accel'

/** 端点目录（供外部集成发现；字段刻意只留"是什么"，不含本机信息）。 */
export const CPU_ROUTES = Object.freeze([
  {
    path: CPU_PROFILE_PATH,
    method: 'GET',
    summary: 'CPU 画像 + 五档说明 + 当前实际生效的启动参数（脱敏，不含本机路径）',
  },
  {
    path: CPU_ACCEL_PATH,
    method: 'POST',
    summary: '设置 CPU 加速档（落 uiState，重启 ComfyUI 后生效）',
    body: { cpuAccel: CPU_ACCEL_MODES.join(' | ') },
  },
])

/**
 * 生成处理器。
 *
 * @param {object} deps
 * @param {() => object} deps.snapshot            返回 { profile, cfg }（profile 由 host 用 detectCpuProfile 算好）
 * @param {Function} deps.isLocalRequest
 * @param {Function} deps.guardWriteRequest
 * @param {Function} deps.readJsonBody
 * @param {Function} deps.respondJson
 * @param {Function} deps.readUiState
 * @param {Function} deps.writeUiState
 * @param {Function} deps.log
 */
export function makeCpuHandlers(deps = {}) {
  const {
    snapshot, isLocalRequest, guardWriteRequest, readJsonBody,
    respondJson, readUiState, writeUiState, log,
  } = deps

  /** 某一档在这台机器上的**真实**计划（含自动降级与跳过原因）。 */
  const planFor = (profile, cfg, mode) => cpuAccelPlan(profile, {
    mode,
    threads: cfg?.cpuThreads,
    oomFallback: cfg?.cpuOomFallback === true,
    bf16: cfg?.cpuBf16,
    cacheOnCpu: cfg?.cpuCacheOnCpu === true,
  })

  const profileHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'GET') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return }
    try {
      const { profile, cfg } = (await snapshot()) ?? {}
      const currentMode = normalizeCpuAccelMode(cfg?.cpuAccel)
      const current = planFor(profile, cfg, currentMode)

      // 五档各自的计划都算一遍：UI 上直接显示"选这档会加什么"，
      // 而不是只给一句文案让用户自己猜。
      const modes = CPU_ACCEL_MODES.map((id) => {
        const plan = planFor(profile, cfg, id)
        const info = CPU_ACCEL_MODE_INFO[id]
        return {
          id,
          label: info.label,
          summary: info.summary,
          changes: info.changes,
          risk: info.risk,
          // 关键：把"这一档在**这台机器**上到底会挂什么"如实给出来（含降级后的结果）
          effectiveMode: plan.effectiveMode,
          args: plan.args,
          env: plan.env.map(([k, v]) => [k, v]),
          threads: plan.threads,
          // 工作流级覆盖（QwenImage21Cache.device 之类）—— 与启动参数分开显示，
          // 因为它的生效时机不同（下次出图，不用重启 ComfyUI）。
          workflowOverrides: { ...(plan.workflowOverrides ?? {}) },
          skipped: plan.skipped,
          selected: id === currentMode,
        }
      })

      respondJson(res, {
        ok: true,
        ...describeCpuAccel(profile, current),
        modes,
        // 参数是**启动期**生效的：改完必须重启 ComfyUI，这条必须写在响应里，
        // 否则用户会以为"点一下就快了"，然后觉得插件在骗人。
        apply: {
          needRestartComfy: current.args.length > 0 || current.env.length > 0,
          note: 'CPU 加速档改的是 ComfyUI 启动参数 / 环境变量 → 必须重启 ComfyUI 才生效。'
            + '重启前请先确认当前没有在跑的任务。',
        },
      })
    } catch (error) {
      // 只记日志、不回吐 error.message —— message 里可能带本机路径（项目硬规矩）。
      log?.('warn', `CPU 画像端点失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: 'CPU 画像暂不可用（详见插件日志）' }, 500)
    }
  }

  const setModeHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method !== 'POST') { respondJson(res, { ok: false, reason: 'POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const raw = body.cpuAccel ?? body.mode
      const mode = normalizeCpuAccelMode(raw)
      // 传了非法值要**明确拒绝**，不能静默落成 off —— 静默会把用户"选了个档"
      // 变成"其实关了"，正是本项目明令禁止的假报告。
      if (raw !== undefined && String(raw).trim() !== '' && mode === 'off'
          && String(raw).trim().toLowerCase() !== 'off') {
        respondJson(res, {
          ok: false,
          reason: `未知档位：${String(raw).slice(0, 40)}`,
          allowed: CPU_ACCEL_MODES,
        }, 400)
        return
      }
      const prev = readUiState()
      const next = { ...prev, cpuAccel: mode }
      const wrote = writeUiState(next, (...args) => log?.(...args))
      log?.('info', `CPU 加速档已设为 ${mode}（重启 ComfyUI 后生效）`)
      respondJson(res, {
        ok: wrote !== false,
        cpuAccel: mode,
        persisted: wrote !== false,
        needRestartComfy: true,
        note: wrote === false
          ? '档位已在本进程生效，但写盘失败（重启 DSH 后会丢）—— 详见插件日志'
          : '已记住该档位。它改的是启动参数，**重启 ComfyUI 后生效**。',
      })
    } catch (error) {
      log?.('warn', `设置 CPU 加速档失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '设置失败（详见插件日志）' }, 400)
    }
  }

  return { profileHandler, setModeHandler }
}

/**
 * 注册两条端点。
 * @param {(route:{kind:string,path:string,handler:Function}) => any} register
 * @param {ReturnType<typeof makeCpuHandlers>} handlers
 */
export function registerCpuRoutes(register, handlers) {
  return [
    register({ kind: 'exact', path: CPU_PROFILE_PATH, handler: handlers.profileHandler }),
    register({ kind: 'exact', path: CPU_ACCEL_PATH, handler: handlers.setModeHandler }),
  ]
}
