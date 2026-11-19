// 设计说明 → docs/index-design-notes.md#index-note-089（原 lib/index.js L3192-3297、L3505-3545 一带）
// misc 只读/轻写端点工厂（2026-11-20 节点⑧第二刀·轻量变体自 index.js 外置）：
//   repair / wizard / health / capabilities / presets / memory.recent / memory.preference 七件。
//   路径字面量与 reg() 注册**留在 index.js**（test-gap-fill 意图锁形态不变）；
//   handler 体逐字搬迁，deps 注入 index.js 本地函数（runRepair/buildWizardReport/
//   readMemoryRecent/readPreferences/writePreferences），其余自 import。
//   锁面依据：勘察报告 #20（这七条路径零直接锁，仅 product-round 双向对账覆盖——
//   同 lib 内搬迁不破）。
import { failBody } from './http-errors.js'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { probeCapabilities } from './config.js'
import { preprocessFileLabels } from './model-label.js'

/**
 * @param {object} deps
 * @param {object} deps.cfg  deps.log
 * @param {object} deps.status  probe() 探活（wizard/health 用）
 * @param {Function} deps.isLocalRequest  deps.guardWriteRequest  deps.respondJson  deps.readJsonBody
 * @param {Function} deps.runRepair  deps.buildWizardReport  （index.js 本地函数注入）
 * @param {Function} deps.readMemoryRecent  deps.readPreferences  deps.writePreferences
 */
export function makeMiscEndpoints(deps) {
  const {
    cfg, log, status,
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody,
    runRepair, buildWizardReport,
    readMemoryRecent, readPreferences, writePreferences,
  } = deps

  // ★★★ 2026-10-12（确认式一键修复）：一个 POST 端点，前端"一键修复"按钮调它。
  //   默认返回预览（将要做什么）；带 {confirm:true} 才真正执行（只做可逆/无害动作）。
  const repairHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (!guardWriteRequest(req, res)) return
    const body = await readJsonBody(req)
    try {
      const result = await runRepair(cfg, log, { confirm: body?.confirm === true })
      respondJson(res, { ok: true, ...result })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  // ★★★ 2026-10-12（首次使用向导）：独立端点，前端"首次使用向导"按钮按需拉取。
  //   故意**不**进状态体 —— 避免把模型名/路径带进每 5 秒轮询、会被日志/宿主带走的契约里。
  const wizardHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    try {
      const online = await status.probe().catch(() => false)
      let caps = null
      if (online) caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
      const wizard = await buildWizardReport(cfg, log, undefined, { online, caps })
      respondJson(res, { ok: true, ...wizard })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  const healthHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    try {
      const online = await status.probe().catch(() => false)
      // 读自身 package.json 取版本（ESM 下用 import.meta.url 反推根目录）
      let version = 'unknown'
      let name = 'dsh-qwen-paint'
      try {
        const pkgPath = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..', 'package.json',
        )
        const pkgRaw = await fsp.readFile(pkgPath, 'utf8')
        const pkg = JSON.parse(pkgRaw)
        version = pkg.version ?? version
        name = pkg.name ?? name
      } catch { /* 取不到版本也不影响 health 返回 */ }
      respondJson(res, {
        ok: true,
        version,
        name,
        comfyOnline: online === true,
        time: new Date().toISOString(),
      })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  // ★ /api/qwen-paint/capabilities —— 探测结果（供前端按能力切换 UI / 供 dsh-auto-memory 判断）
  const capsHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    try {
      const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
      const caps = await probeCapabilities(cfg, log, undefined, { force })
      // ★ 模型名的「干净展示名 / 右侧参数」由 host 端统一算好下发，前端不自己发明规则
      respondJson(res, { ok: true, caps, fileLabels: preprocessFileLabels(caps?.files) })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  // ★ /api/qwen-paint/presets —— 当前可用的预设列表（含 ASPECTS / FLOW_STYLES）
  //   从 config.js 动态导入，避免与 config.js 循环依赖踩坑
  //   （config.js 反向 import index.js 的 ensureComfyUp / getNodeSchema）。
  const presetsHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    try {
      const m = await import('./config.js')
      respondJson(res, { ok: true, aspects: m.ASPECTS, flowStyles: m.FLOW_STYLES })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  // ★ /api/qwen-paint/memory/recent —— dsh-auto-memory 拉取最近出图记忆
  const memoryRecentHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    try {
      const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 10) || 10
      const items = await readMemoryRecent(cfg, log, { limit })
      respondJson(res, { ok: true, items, count: items.length })
    } catch (error) {
      respondJson(res, failBody(error))
    }
  }

  // ★ /api/qwen-paint/memory/preference —— GET 读 / POST 写偏好
  const memoryPrefHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (req.method === 'GET') {
      try {
        const value = await readPreferences(cfg, log)
        respondJson(res, { ok: true, value })
      } catch (error) {
        respondJson(res, failBody(error))
      }
      return
    }
    if (req.method === 'POST') {
      // ★ 2026-10-17（AUTH001 收尾）：与状态 / repair 用**同一套**守卫与有界解析。
      if (!guardWriteRequest(req, res)) return
      try {
        const body = (await readJsonBody(req)) ?? {}
        const result = await writePreferences(cfg, log, body)
        if (!result.ok) respondJson(res, { ok: false, reason: result.reason }, 400)
        else respondJson(res, { ok: true, value: result.value })
      } catch (error) {
        respondJson(res, failBody(error), 400)
      }
      return
    }
    respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
  }

  return {
    repairHandler, wizardHandler, healthHandler, capsHandler,
    presetsHandler, memoryRecentHandler, memoryPrefHandler,
  }
}
