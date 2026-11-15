/**
 * lib/accel-chain.js —— 「加速链」全景：把缓存/跳步后端与 TTS 加速后端
 * 汇成一条**真正被主链路调用**的链，同时接进显存预算、配置裁决、结构化日志。
 *
 * ★ 存在理由（2026-11-14 用户亲订）：单个模块写完 ≠ 最终完成。
 *   cache-backends / tts-accel / vram-budget / config-consistency / structured-log
 *   曾全是「只有测试 import」的孤儿模块；用户在 check_acceleration 与界面里
 *   根本看不到 TTS 加速。本模块把它们接进同一条链，并在三处真实消费：
 *     · tool-registry 注册端点      → index.js 主链路（GET /api/qwen-paint/accel/chain）
 *     · comfy-accel::probeAcceleration → check_acceleration 工具报告（ttsAccel 字段）
 *     · 实验室浮层「加速链」卡片    → 用户界面
 *   三处任一断开都算没接线（回归会抓，见 scripts/test-accel-chain.mjs）。
 *
 * 诚实边界：所有「有没有装」都来自入参 installed（ComfyUI /object_info 探测）。
 *   探测不到一律降级并给理由；未实测的倍率 / 秒数绝不写进结论。
 *   纯函数、零 I/O：不联网、不启动进程、不读文件、不落盘。
 */
import { CACHE_BACKENDS, pickCacheBackends, buildCachePatch, buildAssemblyPlan } from './cache-backends.js'
import { TTS_ACCEL_BACKENDS, pickTtsAccel, ttsAccelToWorkflowPatch } from './tts-accel.js'
import { resolveVramBudget } from './vram-budget.js'
import { detectConfigConflicts, summarizeConflicts, resolveWrapperChoice } from './config-consistency.js'
import { makeStructuredLogger, recordGeneration, summarizeLog, STRUCTURED_LOG_VERSION } from './structured-log.js'
// ★ 2026-11-15：SageAttention / Comfy-WaveSpeed 并进这条已有的加速链，不再只挂在孤立端点上。
import { buildAttentionWorkflowPatch, ATTENTION_WORKFLOW_VERSION } from './attention-workflow.js'

export const ACCEL_CHAIN_VERSION = 1

const MAX_QUERY_ITEMS = 32

function parseList(v, max = MAX_QUERY_ITEMS) {
  const cap = Number.isFinite(max) && max > 0 ? Math.trunc(max) : MAX_QUERY_ITEMS
  if (Array.isArray(v)) return v.slice(0, cap).map(String)
  const s = String(v ?? '').trim()
  if (s === '') return []
  return s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, cap)
}

// ★ 2026-11-14 全面排查修复：vramMb 是「显卡实际显存（MB）」，而
//   resolveVramBudget 的 requested / max 只接受 GB 档位（0/2/4/8/12/16/24）。
//   旧代码把 8192 直接当 requested 传进去，必然返回 ok:false —— 端点里的
//   vram_budget 形同虚设。这里换算成「不超过实际显存的最大可选档位」作为
//   max 上限，让预算真正参与收敛，不把 MB 冒充档位。
const BUDGET_GB_STEPS = [24, 16, 12, 8, 4, 2, 0]
function budgetCapFromVramMb(mb) {
  if (!Number.isFinite(mb) || mb < 0) return null
  const gb = mb / 1024
  for (const s of BUDGET_GB_STEPS) if (gb >= s) return s
  return 0
}

/**
 * 汇总一条完整加速链。TTS 段与生图/视频段并列，用户点名的「TTS 加速不在链里」由此修掉。
 * @returns {object} accel_chain.image / .tts / .all，以及各子系统的探测结果与降级理由
 */
export function buildAccelChain({
  installed = [], gpuVendor = 'unknown', vramMb = null, cfg = {},
  kind = 'image', steps = 8, textLength = 0, wantStreaming = false,
  preferred = [], width = 1024, height = 1024,
  attentionEnabled = '', attentionAcceptedInputs = [], attentionInputs = {},
} = {}) {
  // ★ /object_info 可能几百上千个节点，不能用 query 参数的 32 项上限截断，
  //   否则按字母序排在后面的 SageAttention / WaveSpeed 会被无声漏掉。
  const have = parseList(installed, 4000)
  const cache = pickCacheBackends({ installed: have, kind, steps, preferred: parseList(preferred) })
  const tts = pickTtsAccel({ installed: have, gpuVendor, vramMb, textLength, wantStreaming })
  const cachePatch = buildCachePatch(cache)
  const ttsPatch = ttsAccelToWorkflowPatch(tts)
  // ★ 注意力 / 编译后端与缓存、TTS 并列成第三段；默认未启用 ⇒ 空段，不进 all。
  const attention = buildAttentionWorkflowPatch({
    installed: have, kind, enabled: attentionEnabled,
    acceptedInputs: attentionAcceptedInputs, extraInputs: attentionInputs,
  })
  const attentionPatch = { accel_chain: attention.accel_chain }

  // 三个「建议 / 裁决」类子系统也必须真实参与，而不是只 import 不用。
  const capGb = budgetCapFromVramMb(vramMb)
  const budget = resolveVramBudget({
    ...(capGb !== null ? { max: capGb } : {}),
    kind,
  })
  const conflicts = detectConfigConflicts(cfg)
  const wrapper = resolveWrapperChoice(cfg, width, height)

  // 结构化日志：把这次「加速链快照」记成一条事件（内存收集，不落盘、不含私人内容）。
  const lines = []
  const logger = makeStructuredLogger({ appendLine: (line) => lines.push(line), now: () => 0 })
  recordGeneration(logger, {
    tool: 'accel_chain', kind, steps,
    accel_chain: [...cachePatch.accel_chain, ...ttsPatch.accel_chain, ...attentionPatch.accel_chain],
    degraded: cache.degraded && tts.degraded && attention.degraded,
    degrade_reasons: [...cache.reasons, ...tts.reasons, ...attention.reasons],
    ok: true,
  })
  const logSummary = summarizeLog(lines)

  const accel_chain = {
    image: cachePatch.accel_chain,
    tts: ttsPatch.accel_chain,
    attention: attentionPatch.accel_chain,
    all: [...cachePatch.accel_chain, ...ttsPatch.accel_chain, ...attentionPatch.accel_chain],
  }

  return {
    ok: true,
    version: ACCEL_CHAIN_VERSION,
    accel_chain,
    tts_accel: {
      selected: tts.selected,
      reasons: tts.reasons,
      degraded: tts.degraded,
      hybrid: tts.hybrid,
      fallbackReason: tts.fallbackReason,
      maxSeqLenHint: tts.maxSeqLenHint,
      // 探测不到时也要让用户看见「TTS 加速有哪些后端」，而不是整段消失。
      available: TTS_ACCEL_BACKENDS.map((b) => ({ id: b.id, label: b.label, unverified: b.unverified })),
      patch: ttsPatch.config,
      unverified: true,
    },
    cache_backends: {
      selected: cache.selected,
      reasons: cache.reasons,
      degraded: cache.degraded,
      available: CACHE_BACKENDS.map((b) => ({ id: b.id, label: b.label, group: b.group, unverified: b.unverified })),
      disabled: cachePatch.disabled,
    },
    // ★ 2026-11-15：卡片 / check_acceleration 直接消费这一段，不用再去打孤立端点。
    attention_backends: {
      version: ATTENTION_WORKFLOW_VERSION,
      enabled: attention.enabled,
      selected: attention.selected,
      available: attention.available,
      workflow_nodes: attention.nodes,
      reasons: attention.reasons,
      degraded: attention.degraded,
      needsSlotMapping: attention.needsSlotMapping,
      note: attention.note,
      unverified: true,
    },
    vram_budget: budget,
    vram_detected_mb: Number.isFinite(vramMb) ? Math.round(vramMb) : null,
    // 把「TeaCache / mrfow 等到底还差什么」摆到台面上，而不是只给一个能力名。
    assembly: buildAssemblyPlan(cache),
    config_consistency: {
      conflicts,
      summary: summarizeConflicts(cfg),
      wrapper,
    },
    structured_log: {
      version: STRUCTURED_LOG_VERSION,
      events: logSummary.rows,
      by_chain: logSummary.by_chain,
    },
    reasons: [...cache.reasons, ...tts.reasons, ...attention.reasons],
    unverified: true,
    note: '加速链只记启用了哪条，不记倍率 / 未实测耗时；探测不到的后端一律降级并给理由。'
      + '注意力 / 编译后端的节点类名只来自真实 /object_info 模式发现，槽位未核实。',
  }
}

/** GET /api/qwen-paint/accel/chain —— 只读，本机围栏；异常只回固定文案。 */
export function accelChainRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, cfg, log } = deps
  return [{
    path: '/api/qwen-paint/accel/chain',
    method: 'GET',
    handler: async (req, res) => {
      if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
        respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
      }
      try {
        const u = new URL(String(req?.url || '/'), 'http://127.0.0.1')
        const q = u.searchParams
        const rawVram = q.get('vram_mb')
        // ★ 2026-11-15：UI 不会传 installed；以前因此永远「未探测到」。
        //   现在没传就主动读本机 /object_info 全量节点表（只走回环、60s 缓存），
        //   失败如实降级并把来源写进返回，绝不假装探测成功。
        let installed = parseList(q.get('installed'), 4000)
        let probeInfo = { source: installed.length > 0 ? 'query' : 'none', nodeCount: installed.length, reason: '' }
        if (installed.length === 0 && typeof deps.objectInfoProbe === 'function') {
          const probed = await deps.objectInfoProbe()
          if (probed?.ok && Array.isArray(probed.nodes) && probed.nodes.length > 0) {
            installed = probed.nodes.slice(0, 4000)
            probeInfo = { source: 'object_info', nodeCount: installed.length, reason: '' }
          } else {
            probeInfo = { source: 'unavailable', nodeCount: 0,
              reason: String(probed?.reason || '本机未返回节点表') }
          }
        }
        const report = buildAccelChain({
          installed,
          gpuVendor: q.get('gpu') || cfg?.gpuVendor || 'unknown',
          vramMb: rawVram === null ? null : Number(rawVram),
          cfg: cfg || {},
          kind: q.get('kind') || 'image',
          steps: Number(q.get('steps') || 8),
          textLength: Number(q.get('text_length') || 0),
          wantStreaming: q.get('streaming') === '1',
          preferred: parseList(q.get('preferred')),
          attentionEnabled: q.get('attention') || cfg?.attentionBackend || '',
          attentionAcceptedInputs: cfg?.attentionAcceptedInputs || [],
          attentionInputs: cfg?.attentionInputs || {},
        })
        // ★ 2026-11-14 全面排查补齐：加速链快照真正落盘成一条结构化事件，
        //   不再只写进内存数组。写入失败只记日志，绝不影响端点返回。
        if (deps.eventLog && typeof deps.eventLog.append === 'function') {
          deps.eventLog.append({
            event: 'accel_chain_snapshot', tool: 'accel_chain',
            kind: q.get('kind') || 'image', steps: Number(q.get('steps') || 8),
            accel_chain: report.accel_chain.all,
            degraded: report.tts_accel.degraded && report.cache_backends.degraded,
            degrade_reasons: report.reasons,
            ok: true,
          })
        }
        respondJson(res, { ...report, probe: probeInfo }, 200)
      } catch (error) {
        log?.('warn', '加速链端点异常：' + (error?.message ?? error))
        respondJson(res, { ok: false, reason: '加速链暂不可用（详见插件日志）' }, 500)
      }
    },
  }]
}
