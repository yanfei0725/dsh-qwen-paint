/**
 * lib/config-endpoints.js —— 运维/配置类端点：档位清单、恢复默认、缓存摘要。
 *
 *   GET  /api/qwen-paint/config/options       当前档位 + 所有可选档位（含代价）
 *   POST /api/qwen-paint/preferences/reset    G34 一键恢复默认（清偏好覆盖项）
 *   GET  /api/qwen-paint/cache-report?prompt_id=   B9 上一轮的缓存命中与耗时
 *
 * ★★ B7 / B8 为什么**只有只读**、没有 `POST /config/apply`：
 *     本插件的 cfg 来自 DSH 宿主注入，**没有任何持久化写入通道**。
 *     如果提供一个写入端点，用户点一下看到"已保存"，重启后却回到原样 ——
 *     那是彻头彻尾的假功能。所以这里只如实告诉用户「当前是哪档、每档什么代价、
 *     该去 DSH 的插件设置里改哪个键」。
 *
 * G34 则是真能做的：`.qwen-paint-preferences.json` 是磁盘上的真实文件，
 * 清掉它就等于回到代码内置默认值。★ 改名成 .bak 而不是真删 ——
 * 「调坏了想回去」和「手滑点错了」是同一枚硬币的两面。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  CACHE_CHOICES, VRAM_CHOICES, describeCurrent,
} from './perf-presets.js'
import { fetchCacheReport } from './cache-report.js'
import { listManifests, loadManifest } from './workflow-manifest.js'
import { auditLazyNodes } from './lazy-audit.js'
import { PRESET_BINDINGS, presetsForManifest, checkPresetBindings } from './workflow-presets.js'
import { describeParams } from './param-view.js'
import {
  cuesToSrt, cuesToVtt, planSubtitles, subtitleCapability,
} from './subtitle-plan.js'
import { asrVerifyHint, transcribeAudio } from './asr-client.js'
import { fetchCalibration, pickEta } from './eta-calibrate.js'
import { planPost } from './video-post.js'
import { pickVramMode, explainVramPick } from './vram-strategy.js'
import {
  auditGraph, briefAudit, listContracts, loadContract,
} from './graph-audit.js'

/** 偏好文件名，与 `index.js::memoryPaths()` 保持一致（那边是唯一写入口）。 */
export const PREF_FILE = '.qwen-paint-preferences.json'

/** 进度反馈分级。quiet 会连「开始出图」都看不到，所以文案要写明白。 */
export const PROGRESS_MODES = [
  {
    id: 'quiet', label: '安静',
    summary: '只报警告与错误。',
    cost: '连「开始出图 / 模型加载」这类里程碑也看不到，长任务期间界面上会比较静',
  },
  {
    id: 'brief', label: '简要（默认）',
    summary: '报关键节点：开始、加载模型、完成、降级与失败。',
    cost: '无',
  },
  {
    id: 'detailed', label: '详细',
    summary: '连同调试级的中间过程一起输出。',
    cost: '批量扫描或长视频时日志会刷得比较快',
  },
]

export function makeConfigHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, cfg, log,
  } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }

  const localGet = (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return false }
    const m = String(req.method ?? 'GET').toUpperCase()
    if (m !== 'GET' && m !== 'HEAD') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return false }
    return true
  }

  /**
   * 档位清单 + 当前值。
   * `current` 里的空串表示「配置里没写这个东西」，不是「不支持」。
   */
  const configOptionsHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const c = cfg ?? {}
      respondJson(res, {
        ok: true,
        current: describeCurrent({
          vramMode: c.vramMode,
          cacheDevice: c.qwenCacheDevice,
          cacheDtype: c.qwenCacheDtype,
        }),
        vram: VRAM_CHOICES,
        cache: CACHE_CHOICES,
        progress: PROGRESS_MODES,
        progressMode: String(c.progressMode ?? 'brief'),
        // ★ 明确告知「这里改不了」，避免用户以为漏了个开关。
        note: '这些档位由 DSH 宿主注入的插件配置决定，本端点只读。'
          + '要改请在 DSH 的插件设置里调整 vramMode / qwenCacheDevice / qwenCacheDtype / progressMode。'
          + '显存档位改完需要重启 ComfyUI；缓存档位与进度分级下次出图即生效。',
      })
    } catch (error) {
      warn(`档位清单读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '档位清单读取失败（详见插件日志）' }, 500)
    }
  }

  /**
   * G34：一键恢复默认。
   *
   * 只做一件事：把 `.qwen-paint-preferences.json` 改名成 `.bak-<时间戳>`。
   * · **不删** —— 用户手滑点错时还能改回来；
   * · **不动** `.qwen-paint-memory.jsonl` —— 那是历史记忆，不是"调坏的参数"；
   * · 文件本来就不存在时如实回 `existed:false`，不假装清成功。
   */
  const preferencesResetHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (String(req.method ?? '').toUpperCase() !== 'POST') {
      respondJson(res, { ok: false, reason: 'POST only' }, 405); return
    }
    if (!guardWriteRequest(req, res)) return
    const base = String(cfg?.outputDir ?? '').trim()
    if (base === '') {
      respondJson(res, { ok: false, reason: '输出目录未配置，没有偏好文件可清' }, 400)
      return
    }
    const target = path.join(base, PREF_FILE)
    try {
      if (!fs.existsSync(target)) {
        respondJson(res, {
          ok: true, existed: false, backup: '',
          note: '本来就没有偏好覆盖项，当前用的就是代码内置默认值。',
        })
        return
      }
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
      const backup = `${target}.bak-${stamp}`
      fs.renameSync(target, backup)
      respondJson(res, {
        ok: true, existed: true, backup: path.basename(backup),
        note: '偏好覆盖项已清空，下次出图回到内置默认值。'
          + `原文件改名保留为 ${path.basename(backup)}（想恢复就把它改名回 ${PREF_FILE}）。`,
      })
    } catch (error) {
      warn(`偏好重置失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '偏好重置失败（详见插件日志）' }, 500)
    }
  }

  /**
   * B9：上一轮生成到底省了多少。
   * 没有 prompt_id 时返回 ok:false 并说明原因，不编一个好看的数字。
   */
  const cacheReportHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const promptId = u.searchParams.get('prompt_id') ?? u.searchParams.get('id') ?? ''
      if (String(promptId).trim() === '') {
        respondJson(res, {
          ok: false, reason: '需要 prompt_id',
          note: '生成完成后工具返回的 prompt_id 就是这里的键；面板会在每轮结束后自动带上。',
        }, 400)
        return
      }
      const report = await fetchCacheReport({
        cfg, fetchFn: deps.fetchFn, promptId, signal: undefined,
      })
      respondJson(res, report, report.ok ? 200 : 200)
    } catch (error) {
      warn(`缓存摘要读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '缓存摘要读取失败（详见插件日志）' }, 500)
    }
  }

  /**
   * A1 + A3 + D26：工作流清单总览。
   *
   * 一次把「有哪些链、每张图长什么样、哪些加载器是必载的、每条链能绑哪些预设」
   * 全给出去。做了三件同一性质的事：把**只在源码里的结构**变成可核对的数据。
   *
   * ★ 刻意不回传目录绝对路径 —— 这个端点是本机可读的，但没必要把家目录漏出去。
   */
  const workflowsHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const ids = listManifests()
      const manifests = []
      for (const id of ids) {
        try {
          const mf = loadManifest(id)
          const lazy = auditLazyNodes(mf)
          const presets = presetsForManifest(id, mf)
          manifests.push({
            id,
            label: String(mf.label ?? ''),
            kind: String(mf.kind ?? ''),
            // authoritative=runtime 才是"运行时真的按这份图提交"；其余只作契约参考。
            authoritative: String(mf.authoritative ?? 'snapshot') === 'runtime' ? 'runtime' : 'snapshot',
            nodes: Object.keys(mf.graph ?? {}).length,
            requires: Array.isArray(mf.requires?.nodes) ? mf.requires.nodes : [],
            patches: Array.isArray(mf.patches) ? mf.patches.map((p) => String(p.id ?? '')) : [],
            loaders: {
              always: lazy.always.map((x) => x.class_type),
              conditional: lazy.conditional.map((c) => ({ patch: c.patch, nodes: c.loaders.map((x) => x.class_type) })),
              blocker: lazy.blocker,
            },
            presets: Array.isArray(presets.presets) ? presets.presets : [],
            valid: true,
            errors: [],
          })
        } catch (error) {
          manifests.push({
            id, label: '', kind: '', authoritative: 'invalid', nodes: 0,
            requires: [], patches: [], loaders: { always: [], conditional: [], blocker: 'unknown' },
            presets: [], valid: false, errors: [String(error?.message ?? error)],
          })
        }
      }
      respondJson(res, {
        ok: true,
        count: manifests.length,
        manifests,
        preset_errors: checkPresetBindings(ids),
        // ★ 链还没清单化的预设（生图链）无法校验绑定，单独列出而不是当成错误 ——
        //   当成错误会让每次启动都有一堆假红，最后没人再看这个字段。
        preset_unverified: PRESET_BINDINGS.filter((p) => p.pending === true).map((p) => p.id),
        note: '清单描述的是「图长什么样」。当前只有 kind=runtime 的链真正按清单提交；'
          + '其余链的图由代码构建，改动由 scripts/workflow-fingerprints.json 的指纹护栏盯住。',
      })
    } catch (error) {
      warn(`工作流清单读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '工作流清单读取失败（详见插件日志）' }, 500)
    }
  }

  /**
   * D23：某条链的参数表（含来源）。
   * query 里的每个键都会被当作"你指定"，`chain` 用来选清单。
   */
  const paramsHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const chain = String(u.searchParams.get('chain') ?? '').trim()
      if (chain === '') {
        respondJson(res, {
          ok: false, reason: '需要 chain',
          note: `可用 chain：${listManifests().join(' / ') || '(没有清单)'}`,
        }, 400)
        return
      }
      let mf
      try {
        mf = loadManifest(chain)
      } catch (error) {
        respondJson(res, { ok: false, reason: `读不到清单 ${chain}（详见插件日志）` }, 404)
        return
      }
      const values = {}
      for (const [k, v] of u.searchParams.entries()) {
        if (k === 'chain') continue
        const n = Number(v)
        // 数字能转就转（步数/宽高/种子），否则原样当字符串 —— 不猜类型。
        values[k] = v.trim() !== '' && Number.isFinite(n) && String(n) === v.trim() ? n : v
      }
      const view = describeParams(mf, values)
      respondJson(res, { ok: view.ok, reason: view.reason, chain, ...view })
    } catch (error) {
      warn(`参数表生成失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '参数表生成失败（详见插件日志）' }, 500)
    }
  }

  /** 请求里的文案上限：这个端点是 GET，长文案请走工具而不是拼 URL。 */
  const SUBTITLE_TEXT_MAX = 2000

  /**
   * D19：字幕编排。
   * ★ `source=asr` 时**不会**假装能转写：拿不到节点清单就返回缺件清单。
   */
  const subtitleHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const text = String(u.searchParams.get('text') ?? '')
      if (text.length > SUBTITLE_TEXT_MAX) {
        respondJson(res, { ok: false, reason: `文案过长（上限 ${SUBTITLE_TEXT_MAX} 字），请分段处理` }, 400)
        return
      }
      const seconds = Number(u.searchParams.get('seconds') ?? '')
      const format = String(u.searchParams.get('format') ?? 'srt')
      const source = String(u.searchParams.get('source') ?? 'script')

      // ★ D19 真通路：source=asr 且给了 audio 时，**真的去转写**。
      //   不先看 ComfyUI 节点能力 —— 转写本来就不在 ComfyUI 里跑，
      //   拿"本机零 ASR 节点"去否掉一个配好的外部端点，是在拿错的口径拦人。
      if (source === 'asr') {
        const audio = String(u.searchParams.get('audio') ?? '').trim()
        if (audio !== '') {
          const asr = await transcribeAudio({
            audioPath: audio, cfg: deps.cfg ?? {}, fetchFn: deps.fetchFn, seconds,
          })
          if (asr.ok !== true) {
            respondJson(res, {
              ok: false,
              source: 'asr',
              format: format.toLowerCase() === 'vtt' ? 'vtt' : 'srt',
              aligned: false,
              content: '',
              cue_count: 0,
              reason: asr.reason,
              provider: asr.provider ?? '',
              warnings: asr.warnings ?? [],
              // ★ 不吐 key，只吐"配没配、配到哪"——本机围栏内也不需要把凭据回显。
              asr_config: {
                enabled: asr.config?.enabled === true,
                url: asr.config?.url ?? '',
                model: asr.config?.model ?? '',
                has_key: asr.config?.hasKey === true,
              },
              suggestion: '先按 verify 里的步骤确认转写服务是活的；也可以用 source=script 先出脚本字幕。',
              verify: asrVerifyHint(),
            })
            return
          }
          const content = format.toLowerCase() === 'vtt' ? cuesToVtt(asr.cues) : cuesToSrt(asr.cues)
          respondJson(res, {
            ok: content !== '',
            source: 'asr',
            format: format.toLowerCase() === 'vtt' ? 'vtt' : 'srt',
            aligned: asr.aligned === true,
            content,
            cue_count: asr.cues.length,
            cues: asr.cues,
            text: asr.text,
            language: asr.language,
            provider: asr.provider,
            warnings: asr.warnings ?? [],
            note: asr.aligned === true
              ? `时间戳取自 ${asr.provider} 的 verbose_json segments（与语音对齐）。`
              : `时间戳是按句均分的（${(asr.warnings ?? []).join(' ')}），压片前请人工校一遍。`,
            missing: [],
            suggestion: '',
          })
          return
        }
        // 没给 audio：落到下面的缺件清单分支（说明怎么配，不说"做不到"）
      }

      // 本端点不自带节点探测（那要连 ComfyUI）：给 null 表示「不知道」，与三态口径一致。
      const plan = planSubtitles({ text, seconds, format, source, caps: undefined })
      respondJson(res, {
        ok: plan.ok,
        reason: plan.reason,
        source: plan.source,
        format: plan.format,
        aligned: plan.aligned,
        cue_count: Array.isArray(plan.cues) ? plan.cues.length : 0,
        content: plan.content,
        note: plan.note ?? '',
        missing: plan.missing ?? [],
        suggestion: plan.suggestion ?? '',
        cap: subtitleCapability(undefined),
      })
    } catch (error) {
      warn(`字幕编排失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '字幕编排失败（详见插件日志）' }, 500)
    }
  }

  /**
   * A2：视频后处理计划。
   *
   * ★★ 本端点**不探测**本机有没有 ffmpeg（那要起子进程）。
   *   所以由调用方用 `ffmpeg=1/0`、`ffprobe=1/0`、`nodes=1/0` 声明现状，
   *   这里只按声明算「哪几步能跑」。没声明一律按"没有"算，并在 note 里说明 ——
   *   宁可让用户多点一次开关，也不要给出一个"看起来能用"的假计划。
   */
  const videoPostHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const flag = (k) => String(u.searchParams.get(k) ?? '') === '1'
      const plan = planPost({
        ffmpeg: flag('ffmpeg') ? 'ffmpeg' : null,
        ffprobe: flag('ffprobe') ? 'ffprobe' : null,
        nodes: flag('nodes') ? ['VHS_LoadAudio'] : [],
      })
      respondJson(res, {
        ok: plan.ok,
        plan: plan.plan,
        available: plan.available.map((s) => ({ id: s.id, label: s.label, route: s.route })),
        blocked: plan.blocked.map((s) => ({ id: s.id, label: s.label, missing: s.missing, reason: s.reason })),
        notes: plan.notes,
        declared: { ffmpeg: flag('ffmpeg'), ffprobe: flag('ffprobe'), audio_node: flag('nodes') },
      })
    } catch (error) {
      warn(`后处理计划生成失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '后处理计划生成失败（详见插件日志）' }, 500)
    }
  }

  /**
   * B4：显存档位建议。
   * 不给 `free` 时会去 `cfg.comfyUrl` 读 `/system_stats`；读不到就如实 ok:false，
   * 不拿一个猜出来的数字往下算。
   */
  const vramAdviceHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const kind = String(u.searchParams.get('kind') ?? 'image')
      const pixels = Number(u.searchParams.get('pixels') ?? '')
      let freeMB = Number(u.searchParams.get('free') ?? '')
      let totalMB = null
      let source = 'query'
      if (!Number.isFinite(freeMB) || freeMB <= 0) {
        source = 'system_stats'
        freeMB = null
        const base = String(cfg?.comfyUrl ?? '').trim().replace(/\/+$/u, '')
        if (base !== '' && typeof deps.fetchFn === 'function') {
          try {
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 3000)
            const r = await deps.fetchFn(`${base}/system_stats`, { signal: ctl.signal })
            clearTimeout(timer)
            const j = await r.json()
            const dev = Array.isArray(j?.devices) ? j.devices[0] : null
            const free = Number(dev?.vram_free)
            const total = Number(dev?.vram_total)
            if (Number.isFinite(free) && free > 0) freeMB = free / 1024 ** 2
            if (Number.isFinite(total) && total > 0) totalMB = total / 1024 ** 2
          } catch { /* 下面统一按"拿不到"处理 */ }
        }
      }
      const pick = pickVramMode({
        freeMB, totalMB, kind, pixels,
        userMode: String(u.searchParams.get('mode') ?? cfg?.vramMode ?? ''),
      })
      respondJson(res, {
        ok: pick.ok,
        pick,
        summary: explainVramPick(pick),
        source: pick.free_mb === null ? 'unavailable' : source,
        note: '建议不改你的配置：显存档位是启动参数，要改请去 DSH 插件设置改 vramMode 并重启 ComfyUI。'
          + '阈值是经验下限（heuristic），不是本机实测基准。',
      })
    } catch (error) {
      warn(`显存建议生成失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '显存建议生成失败（详见插件日志）' }, 500)
    }
  }

  /**
   * A1：生图链 / TTS 链的**契约**清单与核对。
   *
   * 与 /workflows 的区别要说清：那边是「按清单提交」的运行时清单（只有视频链），
   * 这边是「图由代码构建、但必须满足这些角色与参数约束」的契约。
   * `?build=1` 会用当前 cfg 真构一张图来核对 —— 这是唯一能回答
   * 「是不是哪个字段变了」的地方（指纹只能答「变没变」）。
   */
  const contractsHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const id = String(u.searchParams.get('id') ?? '').trim()
      const wantBuild = String(u.searchParams.get('build') ?? '') === '1'

      if (id === '') {
        const contracts = listContracts().map((cid) => {
          try {
            const c = loadContract(cid)
            return {
              id: cid,
              label: String(c.label ?? ''),
              kind: String(c.kind ?? ''),
              roles: Object.keys(c.roles ?? {}).filter((k) => !k.startsWith('_')).length,
              params: Object.keys(c.params ?? {}).filter((k) => !k.startsWith('_')).length,
              outputs: Array.isArray(c.outputs) ? c.outputs : [],
              valid: true,
              errors: [],
            }
          } catch (error) {
            return {
              id: cid, label: '', kind: '', roles: 0, params: 0, outputs: [],
              valid: false, errors: [String(error?.message ?? error)],
            }
          }
        })
        respondJson(res, {
          ok: true,
          count: contracts.length,
          contracts,
          note: '契约描述的是「哪些角色必须在、参数必须流到哪」。生图链与 TTS 链的图仍由代码构建；'
            + '带 build=1 可对当前配置下的图做一次真核对。',
        })
        return
      }

      let contract
      try {
        contract = loadContract(id)
      } catch (error) {
        respondJson(res, { ok: false, reason: `读不到契约 ${id}（详见插件日志）` }, 404)
        return
      }

      let audit = null
      let auditSkipped = ''
      if (wantBuild) {
        if (String(contract.kind) === 'image') {
          try {
            const { buildWorkflow } = await import('./config.js')
            const args = { prompt: 'contract probe', steps: 25, seed: 1, width: 1024, height: 1024 }
            audit = auditGraph(buildWorkflow(deps.cfg ?? {}, args), contract, args)
          } catch (error) {
            auditSkipped = `构建失败：${error?.message ?? error}`
          }
        } else {
          // TTS 的图要先探到节点能力才能构，端点不做在线探测 —— 别在这里假装核对过。
          auditSkipped = 'TTS 链需要 ComfyUI 节点能力（caps）才能构建，端点不做在线探测；'
            + '请用 node scripts/contract-audit.mjs 做真核对。'
        }
      }

      respondJson(res, {
        ok: true,
        id: String(contract.id ?? id),
        label: String(contract.label ?? ''),
        kind: String(contract.kind ?? ''),
        outputs: Array.isArray(contract.outputs) ? contract.outputs : [],
        roles: contract.roles ?? {},
        params: contract.params ?? {},
        audit,
        audit_skipped: auditSkipped,
        brief: audit === null ? '' : briefAudit(audit),
      })
    } catch (error) {
      warn(`契约读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '契约读取失败（详见插件日志）' }, 500)
    }
  }

  /**
   * E27：本机实测秒数（不是估算）。
   *
   * 数据源是 ComfyUI `/history` 里 `execution_start` → `execution_success` 的真实时间戳。
   * 没有任何样本时**照旧返回 null + unverified** —— 这条端点存在的意义是
   * "别再拿别人的机器猜"，不是"终于有个数字可以显示了"。
   */
  const etaHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const got = await fetchCalibration({ cfg: deps.cfg ?? {}, fetchFn: deps.fetchFn })
      const kind = String(u.searchParams.get('kind') ?? '').trim()
      const hasQuery = kind !== ''
      let predict = null
      if (hasQuery) {
        predict = pickEta(got.calibration, {
          kind,
          width: Number(u.searchParams.get('width') ?? NaN) || undefined,
          height: Number(u.searchParams.get('height') ?? NaN) || undefined,
          steps: Number(u.searchParams.get('steps') ?? NaN) || undefined,
        })
      }
      const groups = Object.keys(got.calibration?.byKey ?? {})
        .sort()
        .map((k) => ({ key: k, ...got.calibration.byKey[k] }))
      respondJson(res, {
        ok: got.ok === true,
        reason: got.reason ?? '',
        source: 'comfy-history',
        samples: Array.isArray(got.samples) ? got.samples.length : 0,
        skipped: got.skipped ?? null,
        groups,
        predict,
        note: got.note
          || '秒数取自本机 ComfyUI 的真实执行记录；样本 ≥3 时会剔除含模型加载的首次。'
            + '没有样本就是 null，不拿别的档位凑数。',
      })
    } catch (error) {
      warn(`秒数校准失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '秒数校准失败（详见插件日志）' }, 500)
    }
  }

  return {
    configOptionsHandler, preferencesResetHandler, cacheReportHandler,
    workflowsHandler, paramsHandler, subtitleHandler, videoPostHandler, vramAdviceHandler,
    contractsHandler, etaHandler,
  }
}

/** 路径 → handler 清单，便于测试逐字核对。 */
export function configRouteTable(handlers) {
  return [
    ['/api/qwen-paint/config/options', handlers.configOptionsHandler],
    ['/api/qwen-paint/preferences/reset', handlers.preferencesResetHandler],
    ['/api/qwen-paint/cache-report', handlers.cacheReportHandler],
    ['/api/qwen-paint/workflows', handlers.workflowsHandler],
    ['/api/qwen-paint/params', handlers.paramsHandler],
    ['/api/qwen-paint/subtitle', handlers.subtitleHandler],
    ['/api/qwen-paint/video/post', handlers.videoPostHandler],
    ['/api/qwen-paint/vram-advice', handlers.vramAdviceHandler],
    ['/api/qwen-paint/contracts', handlers.contractsHandler],
    ['/api/qwen-paint/eta', handlers.etaHandler],
  ]
}
