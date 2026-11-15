/**
 * lib/runtime-endpoints.js —— 把「显存预算档位」和「配置项矛盾」做成真端点。
 *
 * ★ 2026-11-14 全面排查补齐：
 *   · lib/vram-budget.js 的 0/2/4/8/12/16/24 GB + 无上限 8 档表早就写好了，
 *     但既没有独立端点、没有 UI 入口，也只在 accel/chain 里露过一个字段
 *     （且那个字段还把 MB 当 GB 传，见 accel-chain.js 的修复）。
 *     ⇒ 用户「针对每个子任务提供可选显存上限」实际不可操作。
 *   · lib/config-consistency.js 只在 accel-chain.js 里被当成报告生成器，
 *     生产配置读取路径从未调用它 ⇒ 用户「清理配置项的矛盾」没有可观察入口。
 *     ⇒ 这里给一个**只读**冲突报告端点：只报告、不擅自改用户配置。
 *
 * 诚实边界：
 *   · 显存上限是「预算建议」，ComfyUI 没有精确到子任务的显存配额参数；
 *     launchArgs 只作为生成启动命令时的参考，绝不承诺实际占用。
 *   · 覆盖值只在本进程内存里，重启即清空；不写配置文件、不改 cfg 对象。
 *   · 全部端点只放行本机；异常只回固定文案，不回吐 error.message。
 */
import {
  VRAM_BUDGET_CHOICES, listVramBudgetKinds, resolveVramBudget,
} from './vram-budget.js'
import {
  detectConfigConflicts, summarizeConflicts, resolveWrapperChoice,
} from './config-consistency.js'

export const RUNTIME_ENDPOINTS_VERSION = 1

/** 进程内的「每个子任务各一份上限」覆盖表。纯内存、可注入、零 I/O。 */
export function createBudgetStore(initial = {}) {
  const map = new Map(Object.entries(initial || {}).map(([k, v]) => [String(k), v]))
  const snapshot = () => Object.fromEntries(map)
  return {
    get: (kind) => map.get(String(kind)),
    set: (kind, gb) => { map.set(String(kind), gb); return snapshot() },
    snapshot,
  }
}

const fixedFail = (res, respondJson) =>
  respondJson(res, { ok: false, reason: '请求处理失败（详见插件日志）' }, 500)

export function runtimeRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, readJsonBody, cfg = {}, log } = deps
  const store = deps.budgetStore || createBudgetStore()

  const guard = (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      respondJson(res, { ok: false, reason: 'local requests only' }, 403)
      return false
    }
    return true
  }

  return [
    {
      path: '/api/qwen-paint/vram-budget',
      method: 'GET, POST',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          if (String(req?.method || 'GET').toUpperCase() === 'POST') {
            const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) || {} : {}
            const kind = String(body.kind ?? 'image').trim() || 'image'
            const requested = body.gb === undefined ? null : body.gb
            const r = resolveVramBudget({ requested, kind })
            if (!r.ok) { respondJson(res, { ok: false, reason: r.reason }, 400); return }
            store.set(kind, r.gb)
            respondJson(res, {
              ok: true, kind, gb: r.gb, mb: r.mb, launchArgs: r.launchArgs,
              overrides: store.snapshot(),
              note: '仅本进程内存生效，重启清空；launchArgs 是建议启动参数，不承诺实际显存占用。',
            }, 200)
            return
          }
          const u = new URL(String(req?.url || '/'), 'http://127.0.0.1')
          const kind = u.searchParams.get('kind')
          const gb = u.searchParams.get('gb')
          const kinds = listVramBudgetKinds().map((k) => ({
            ...k, override: store.get(k.kind) ?? null,
          }))
          const resolved = kind !== null
            ? resolveVramBudget({ requested: gb === null ? store.get(kind) ?? undefined : gb, kind })
            : null
          respondJson(res, {
            ok: true,
            version: RUNTIME_ENDPOINTS_VERSION,
            choices: VRAM_BUDGET_CHOICES.map((c) => ({ ...c })),
            kinds,
            overrides: store.snapshot(),
            resolved,
            note: '每个子任务可独立设 0/2/4/8/12/16/24 GB 或无上限；这是预算建议，不是精确配额。',
          }, 200)
        } catch (error) {
          log?.('warn', '显存预算端点异常：' + (error?.message ?? error))
          fixedFail(res, respondJson)
        }
      },
    },
    {
      path: '/api/qwen-paint/config/conflicts',
      method: 'GET',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          respondJson(res, {
            ok: true,
            readonly: true,
            conflicts: detectConfigConflicts(cfg),
            summary: summarizeConflicts(cfg),
            wrapper: resolveWrapperChoice(cfg, 1024, 1024),
            note: '只读报告：列出配置项的矛盾与裁决建议，不自动改用户配置；要改请走 /status.json 的 POST 配置入口。',
          }, 200)
        } catch (error) {
          log?.('warn', '配置冲突端点异常：' + (error?.message ?? error))
          fixedFail(res, respondJson)
        }
      },
    },
  ]
}
