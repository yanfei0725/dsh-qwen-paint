/** cpu-endpoints —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#tts-lowlatency-space-cpu-endpoints */
// 端点样板已收敛到 lib/route-factory.js（优化接力节点②，2026-11-20）：本机门 / 方法门 /
// 写守卫 / body 解析 / catch 收口由工厂收口（failText 钉回原文案）。

import { CPU_ACCEL_MODES, CPU_ACCEL_MODE_INFO, cpuAccelPlan, describeCpuAccel, normalizeCpuAccelMode } from './cpu-profile.js'
import { makeRouteFactory } from './route-factory.js'

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
  const route = makeRouteFactory({ isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log })

  /** 某一档在这台机器上的**真实**计划（含自动降级与跳过原因）。 */
  const planFor = (profile, cfg, mode) => cpuAccelPlan(profile, {
    mode,
    threads: cfg?.cpuThreads,
    oomFallback: cfg?.cpuOomFallback === true,
    bf16: cfg?.cpuBf16,
    cacheOnCpu: cfg?.cpuCacheOnCpu === true,
  })

  const profileHandler = route({
    path: CPU_PROFILE_PATH, method: 'GET', onlyText: 'GET only',
    failText: 'CPU 画像暂不可用（详见插件日志）',
    handler: async ({ res }) => {
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
    },
  }).handler

  const setModeHandler = route({
    path: CPU_ACCEL_PATH, method: 'POST', guard: true, parse: true,
    // 原样板 catch 回 400；无测试锁定该状态，统一为工厂口径 500（文案逐字保留）。
    failText: '设置失败（详见插件日志）',
    handler: async ({ res, body }) => {
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
    },
  }).handler

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
