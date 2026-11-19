// 设计说明已外置 → docs/index-design-notes.md#index-note-067（原 lib/index.js L3966-4486）
// 状态端点处理器工厂（2026-11-20 节点⑧第一刀自 index.js 外置，函数体逐字未改）：
// 状态 JSON 的全部行为 —— visits/ping 计数、只读 GET 白名单、POST 写闸、11 个写键、
// choiceRejections 假成功根治、launch 状态机收口、优化面板装配。
// 依赖面分两层：本文件直接 import（config/model-options/accel-profiles/diag 的可导入项）
// 与 deps 注入（index.js 本地 helper + comfy-launch 生命周期组 + 模块级可变量的 getter）。
import { resolveOutputDir, DEFAULTS, VRAM_MODES, PRECISION_TIERS, TEXT_CONTROL_MODES } from './config.js'
import { DRAW_INTENT_MODES } from './schema-defaults.js'
import { pick as pickAccelProfile, describePick } from './accel-profiles.js'
import { persistVideoModelChoice, persistTtsChoice } from './model-options.js'
import { diag } from './diag.js'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'

/**
 * @param {object} deps
 * @param {object} deps.cfg  log  status(comfy-status)  idle(idle-shutdown)  visits(计数器)
 * @param {Function} deps.respondJson  deps.isLocalRequest  deps.guardWriteRequest  deps.readJsonBody
 *   （index.js 本地五段样板件）
 * @param {object} deps.launch  comfy-launch 生命周期组（phase/startedAt/startedMono/logPath/sageAttempted…）
 * @param {Function} deps.launchView  launchMarkStarting  launchMarkReady  launchMarkFailed  launchMarkTimeout
 *   readLaunchLog  fatalLineInLog  launchFailedDueToSage
 * @param {number} deps.LAUNCH_TIMEOUT_MS
 * @param {Function} deps.ensureComfyUp  deps.probeCapabilities
 * @param {Function} deps.sageReady  ★ getter：SAGE_READY 是模块级可变量（自检后变化），
 *   ESM import 活引用直接传值会变快照 —— 必须 () => SAGE_READY 保持活性
 * @param {boolean} deps.isMac  deps.flowStyles（FLOW_STYLES 白名单）  deps.drawIntentModes（DRAW_INTENT_MODES）
 * @param {Function} deps.writeUiState  deps.readUiState
 *   persistVideoModelChoice / persistTtsChoice / weightFilesFromObjectInfo / loadObjectInfoFor
 * @param {Function} deps.readControls  deps.videoParamsForSpeed
 * @param {object} deps.speedMap（SPEED_MAP）  deps.speedTiers（SPEED_TIERS）
 * @param {Function} deps.describeOptimization  deps.diag  deps.defaultOutputDir
 */
export function makeStatusHandler(deps) {
  // 原 5 项（cfg/log/status/idle/visits）由下方原解构行提供（逐字保留）
  const {
    respondJson, isLocalRequest, guardWriteRequest, readJsonBody,
    launch, launchView, launchMarkStarting, launchMarkReady, launchMarkFailed, launchMarkTimeout,
    readLaunchLog, fatalLineInLog, launchFailedDueToSage, LAUNCH_TIMEOUT_MS,
    ensureComfyUp, probeCapabilities,
    sageReady, isMac, flowStyles, drawIntentModes,
    writeUiState, readUiState,
    persistVideoModelChoice, persistTtsChoice, weightFilesFromObjectInfo, loadObjectInfoFor,
    readControls, videoParamsForSpeed, speedMap, speedTiers,
    describeOptimization, diag, defaultOutputDir,
  } = deps

  const { cfg, log, status, idle, visits } = deps
  return async (req, res) => {
        try {
          const hit = String(req?.url ?? '')
          if (hit.startsWith('/api/')) visits.api += 1
          else visits.plain += 1
          // 客户端会在 apply 的每个分支自报一次（?ping=apply / no-react / no-slots / registered），
          // 去重记下来 —— 这是判断"客户端到底加载到哪一步"的唯一外部依据。
          const ping = /[?&]ping=([^&]*)/u.exec(hit)
          if (ping !== null) {
            let reason = ping[1]
            try { reason = decodeURIComponent(reason) } catch { /* 原样用 */ }
            // ★ 2026-11-17 审计：pings 来自 URL 参数且此前无上限 —— 跨站请求虽被 403 拒，
            //   计数在本围栏之前执行，唯一字符串可无限撑大数组（内存膨胀口）。封顶双保险：
            //   值长 ≤128、条数 ≤32；取值仍来自本机面板自报（apply/no-react/no-slots/registered）。
            if (reason !== '' && reason.length <= 128
              && !visits.pings.includes(reason) && visits.pings.length < 32) {
              visits.pings.push(reason)
            }
          }
          if (visits.firstAt === null) visits.firstAt = Date.now()
          visits.lastAt = Date.now()
        } catch {
          /* 计数失败不影响状态返回 */
        }
        if (!isLocalRequest(req)) {
          respondJson(res, { ok: false, reason: 'local requests only' }, 403)
          return
        }
        try {
          const online = await status.probe()
          // ★★ 2026-10-07 新增：`?idleMinutes=N` 现场改「多久没出图就自动关掉后端」。
          //   N = 0 表示**不自动关闭**。安全性：这个端点只放行本机请求（isLocalRequest 在更上面挡住），
          //   而且只改一个数字，不碰任何路径或命令；越界值直接忽略。
          const query = new URL(req.url ?? '/', 'http://127.0.0.1')
// 设计说明已外置 → docs/index-design-notes.md#index-note-068（原 L4336-4345）
          const method = String(req.method ?? 'GET').toUpperCase()
          const isWriteReq = method === 'POST'
          /** GET 允许携带的**只读**参数（其余任何参数一律拒绝，强制走 POST）。 */
          const READ_ONLY_PARAMS = new Set(['ping'])
          const queryLc = new Map()
          if (isWriteReq) {
            // ★★★ 2026-10-17（AUTH001 收尾）：**先过方法与媒体类型守卫**，再读 body。
            //   审核指出状态 POST 原先不检查 `application/json` —— 那样 `text/plain` 的
            //   "简单请求"（跨站表单能发、不触发预检）也能把 JSON 塞进来。现在不通过就 415。
            if (!guardWriteRequest(req, res)) return
            const body = await readJsonBody(req)
            if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
              for (const [bk, bv] of Object.entries(body)) {
                queryLc.set(String(bk).toLowerCase(), String(bv))
              }
            }
          } else {
            const offending = [...query.searchParams.keys()]
              .filter((qk) => !READ_ONLY_PARAMS.has(qk.toLowerCase()))
            if (offending.length > 0) {
              respondJson(res, {
                ok: false,
                reason: '写操作必须用 POST + JSON body（状态 GET 已改为只读）',
                offending,
                hint: 'POST /api/qwen-paint/status.json  {"<参数名>": "<值>"}',
              }, 405)
              return
            }
          }
          // ★ 2026-11-16 假成功根治：把「被拒的界面选择」从日志搬到响应里。
          //   顶层 ok 仍表示**端点本身正常**（三处状态轮询依赖它），
          //   本次选择是否真生效只看 choiceResult.ok —— 避免修 UI 谎言时把监控一起带崩。
          const choiceRejections = []
          const rejectChoice = (label, value, reason) => {
            choiceRejections.push({
              label: String(label ?? ''),
              value: String(value ?? ''),
              reason: String(reason ?? ''),
            })
            log('warn', `界面想选「${label}」=「${value}」→ 已拒绝：${reason}`)
          }

          const rawMinutes = queryLc.get('idleminutes')
          if (rawMinutes !== undefined) {
            const minutes = Number(rawMinutes)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) {
              cfg.idleShutdownMs = Math.round(minutes) * 60000
// 设计说明已外置 → docs/index-design-notes.md#index-note-069（原 L4380-4383）
              if (minutes > 0) idle.touch()
              log('info', minutes <= 0
                ? '空闲关停：已按界面选择关闭（不再自动关后端）'
                : `空闲关停：已按界面选择改为 ${Math.round(minutes)} 分钟`)
            } else {
              rejectChoice('空闲关停分钟数', rawMinutes, '必须是 0–1440 之间的数字（0 = 关闭）')
            }
          }

          // ★★ 2026-10-08 新增：`?flowStyle=xxx` 现场改「生图过程的动画」。
          //   界面（composer 状态点的菜单）点一下就调这里；合法值**立刻落盘**，
          //   重启 DSH 之后照样记得住。非法值只记一行日志、绝不写进样式名。
          const rawStyle = queryLc.get('flowstyle')
          if (rawStyle !== undefined) {
            if (flowStyles.includes(rawStyle)) {
              cfg.flowStyle = rawStyle
              // 合并写：别把文件里以后可能新增的其它偏好字段冲掉
              writeUiState({ ...readUiState(), flowStyle: rawStyle }, log)
              log('info', `生图动画已改为 ${rawStyle}`)
            } else {
              rejectChoice('生图动画', rawStyle, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-070（原 L4406-4416）
          const rawTrigger = queryLc.get('drawtrigger')
          if (rawTrigger !== undefined) {
            if (Object.prototype.hasOwnProperty.call(drawIntentModes, rawTrigger)) {
              cfg.drawTrigger = rawTrigger
              writeUiState({ ...readUiState(), drawTrigger: rawTrigger }, log)
              log('info', `生图判断策略已改为 ${rawTrigger}（需重载插件后生效）`)
            } else {
              rejectChoice('生图判断策略', rawTrigger, '取值不在白名单里，未生效')
            }
          }

          // ★★★ 2026-10-12（用户要求「预设工作流」）：界面菜单点一下设默认预设。
          //   与 flowStyle 同一套：写进 uiState（重启也记得住），但真正生效是"下次出图"
          //   经 draw_image 的 preset 参数 / cfg.preset 接管（不覆盖用户显式 size/megapixels）。
          const rawPreset = queryLc.get('preset')
          if (rawPreset !== undefined) {
            if (['default', 'portrait', 'anime', 'wallpaper'].includes(rawPreset)) {
              cfg.preset = rawPreset
              writeUiState({ ...readUiState(), preset: rawPreset }, log)
              log('info', `出图预设已改为 ${rawPreset}`)
            } else {
              rejectChoice('出图预设', rawPreset, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-071（原 L4442-4446）
          for (const [key, field, label] of [
            ['aipickbest', 'aiPickBest', 'AI 挑图'],
            ['userpickbest', 'userPickBest', '用户自选'],
          ]) {
            const raw = queryLc.get(key)
            if (raw === undefined) continue
            if (raw === 'on' || raw === 'off') {
              cfg[field] = raw
              writeUiState({ ...readUiState(), [field]: raw }, log)
              log('info', `${label}已${raw === 'on' ? '开启' : '关闭'}（重载插件后生效）`)
            } else {
              rejectChoice(label, raw, '取值不在白名单里，未生效')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-072（原 L4462-4469）
          try {
            const v = launchView(online)
            const line = `${new Date().toISOString()} online=${online} phase=${launch.phase}`
              + ` starting=${v.starting} failed=${v.failed} timedOut=${v.timedOut}`
              + ` err=${launch.error ? launch.error.slice(0, 80) : '-'}`
              + ` url=${cfg.comfyUrl}\n`
            const diagPath = path.join(cfg.outputDir ?? os.tmpdir(), 'qwen-paint-status.log')
            const prevLines = await fsp.readFile(diagPath, 'utf8').catch(() => '')
            const kept = prevLines.split('\n').slice(-200).join('\n')
            await fsp.mkdir(path.dirname(diagPath), { recursive: true }).catch(() => {})
            await fsp.writeFile(diagPath, `${kept}${kept === '' ? '' : '\n'}${line}`, 'utf8')
          } catch {
            /* 诊断写不进去绝不能影响状态返回 */
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-073（原 L4485-4492）
          if (queryLc.get('start') === '1') {
            // ★ 重写后：**立刻**把状态标成启动中（单一真相源），
            //   这样紧接着这次响应里的 launchView() 就会给出 starting=true，
            //   界面无需等到下一次轮询才有反馈。
            launchMarkStarting()
            log('info', '界面点击了「启动 ComfyUI」，开始后台拉起')
            ensureComfyUp(cfg, log, null).catch((error) => {
              log('warn', `界面触发的启动失败：${error?.message ?? error}`)
              // 失败就用**准确的类型**收口（超时 or 失败），不再让状态悬着
              if (launch.phase === 'starting') {
                launchMarkFailed(`启动失败：${error?.message ?? error}`)
              }
            })
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-074（原 L4508-4522）
          const blockCacheParam = String(queryLc.get('blockcache') ?? '').toLowerCase()
          if (blockCacheParam === 'on' || blockCacheParam === 'off') {
            const want = blockCacheParam === 'on'
            if (cfg.blockCacheEnabled !== want) {
              cfg.blockCacheEnabled = want
              log('info', `界面把 BlockCache T8 切成了 ${want ? '开' : '关'}`)
            }
            // 切成"开"时要提醒用户：TE-Speed / Speedup 会自动让位，这是结构互斥的必然结果
            if (want) {
              log('info', 'BlockCache T8 已开启 → TE-Speed / Speedup 会让位（三者结构互斥，不能共存）')
            } else {
              log('info', 'BlockCache T8 已关闭 → TE-Speed / Speedup 回到链路（实测这一组更快）')
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-075（原 L4538-4546）
          const fast4Param = String(queryLc.get('fast4') ?? '').toLowerCase()
          if (fast4Param === 'on' || fast4Param === 'off') {
            const want = fast4Param === 'on'
            if (want) {
              const capsNow = await probeCapabilities(cfg, log, undefined).catch(() => null)
              if (!capsNow?.models?.fast4Lora) {
                log('warn', '界面想打开「极速档（4 步）」，但 loras 目录里没找到 4 步蒸馏 LoRA → 已拒绝。'
                  + '把 4 步 LoRA 放进 models\\loras 后开关才可用。')
              } else if (cfg.fast4Enabled !== true) {
                cfg.fast4Enabled = true
                log('info', `界面打开了「极速档（4 步）」→ 下次出图走 4 步 / CFG 1.0 / 位移 ln3`
                  + `（LoRA=${capsNow.models.fast4Lora}）。`
                  + '⚠ 不适用于有文字的情形：画面里有中文/英文时文字会崩坏。')
              }
            } else if (cfg.fast4Enabled !== false) {
              cfg.fast4Enabled = false
              log('info', '界面关闭了「极速档（4 步）」→ 回到 8 步（画质更好，文字能正常渲染）')
            }
          }

          // ★★★ 2026-10-12（用户要求）：**在界面上直接改输出目录**。
          //   `?outputDir=<url编码的路径>` —— 空值 = 恢复默认。
          //   ⚠ 校验与 apply() 那一步**完全同一套**（resolveOutputDir），
          //     避免"端点收下、下次启动又判非法"的两套标准。
          const wantDir = queryLc.get('outputdir')
          if (wantDir !== undefined) {
            const r = resolveOutputDir(wantDir, log)
            if (r.problem) {
              log('warn', `界面想把输出目录改成「${wantDir}」，但不可用（${r.problem}）→ 未采用`)
            } else if (r.dir === cfg.outputDir) {
              log('info', `界面设置输出目录：与当前一致（${r.dir}）`)
            } else {
              cfg.outputDir = r.dir
              cfg.outputDirSource = r.source
              log('info', `界面把输出目录改成了：${r.dir}（${r.source}）`)
            }
          }

          const busy = online ? await status.queueBusy() : false

// 设计说明已外置 → docs/index-design-notes.md#index-note-076（原 L4587-4599）
          {
            const v = String(queryLc.get('vaetiling') ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const next = v === 'on' ? (cfg.vaeTiling === 'on' ? 'on' : 'auto') : 'off'
              if (cfg.vaeTiling !== next) {
                cfg.vaeTiling = next
                log('info', `界面把「VAE 大图分块解码」切成了 ${next}`
                  + '（工作流节点，**下次出图**即生效，不用重启 ComfyUI）')
              }
            } else if (v !== '') {
              rejectChoice('VAE 大图分块解码', v, '只能填 on / off')
            }
          }

          for (const [param, key, label] of [
            ['amdkernel', 'amdKernel', 'A 卡专属内核'],
            ['asyncoffload', 'amdAsyncOffload', 'A 卡异步卸载'],
            // ★ 2026-10-11：N 卡 SageAttention（三档，这里是 true/false 两档）
            ['sagesa', 'nvidiaSageAttention', 'N 卡 SageAttention'],
            // ★★★ 2026-10-12：macOS / MPS 的两个开关（见 DEFAULTS 的说明）。
            //   ⚠ 它们也是**启动期生效**（注入给 ComfyUI 进程的环境变量）⇒ 需重启 ComfyUI。
            ['applempsfallback', 'appleMpsFallback', 'MPS 算子回退兜底'],
            ['applempsunlimited', 'appleMpsUnlimitedMem', 'MPS 取消显存水位上限'],
            // ★★★ 2026-10-12（用户反馈）：Spectrum 跳步加速（**布尔**，走通用分支即可）
            ['spectrum', 'spectrumEnabled', 'Spectrum 跳步加速'],
// 设计说明已外置 → docs/index-design-notes.md#index-note-077（原 L4623-4627）
            ['sada', 'sadaEnabled', 'SADA 跳步采样'],
            ['easycache', 'easyCacheEnabled', 'EasyCache 步级复用'],
            ['tileinpaint', 'tileInpaintEnabled', '分块重绘'],
            ['oom', 'oomAutoFallback', 'OOM 自动回退'],
          ]) {
            const v = String(queryLc.get(param.toLowerCase()) ?? '').toLowerCase()
            if (v === 'on' || v === 'off') {
              const want = v === 'on'
              // ★★★ 2026-10-11 加固：`--use-sage-attention` 是**硬依赖**参数 ——
              //   已确认"没装"时**在服务端就拒绝打开**。
              //   面板虽然把开关置灰了，但端点本身也必须有护栏 ——
              //   否则一个手拼的 URL 就能把 ComfyUI 弄成起不来。
              if (key === 'nvidiaSageAttention' && want && sageReady() === false) {
                rejectChoice(label, v, '自检确认 sageattention 未安装；这是硬依赖参数，打开会让 ComfyUI 起不来')
                continue
              }
              // ★★★ 2026-10-12 加固：MPS 的两个开关**只在 macOS 上有意义**
              //   （PyTorch 的 MPS 后端在其它平台根本不存在）。
              //   非 Mac 上直接拒绝，而不是"改了个什么都不会发生的值"。
              if ((key === 'appleMpsFallback' || key === 'appleMpsUnlimitedMem') && !isMac) {
                rejectChoice(label, v, 'MPS 只在 macOS 有意义，当前平台没有对应后端')
                continue
              }
              if (cfg[key] !== want) {
                cfg[key] = want
                log('info', `界面把「${label}」切成了 ${want ? '开' : '关'}（启动期生效，重启 ComfyUI 后生效）`)
              }
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-078（原 L4658-4661）
          for (const [param, key, label, allowed] of [
            ['vrammode', 'vramMode', '显存/内存档位', VRAM_MODES],
            ['precision', 'precisionTier', '模型精度档', PRECISION_TIERS],
            ['textctl', 'textControl', '文本控制档', TEXT_CONTROL_MODES],
          ]) {
            const raw = String(queryLc.get(param.toLowerCase()) ?? '').toLowerCase()
            if (raw === '') continue
            if (!allowed.includes(raw)) {
              rejectChoice(label, raw, `取值不在白名单内（可用：${allowed.join(' / ')}）`)
              continue
            }
            if (cfg[key] !== raw) {
              cfg[key] = raw
              log('info', `界面把「${label}」切成了 ${raw}`
                + (key === 'vramMode' ? '（启动参数，**重启 ComfyUI** 后生效）'
                  : '（工作流参数，**下次出图**即生效）'))
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-079（原 L4681-4684）
          if (['unet', 'lora', 'controlnet', 'unetvideo'].some((p) => queryLc.has(p))) {
            let wf = null
            try {
              // ★ 2026-11-16 性能：优先复用 comfy-catalog 的全量 /object_info 缓存
              //   （model-options 端点与提交前校验都已拉过它）—— 命中即零网络请求。
              //   拿不到才回退 probeCapabilities（冷启动时那串单节点探测），语义不变。
              const info = await loadObjectInfoFor(cfg, null)
              wf = weightFilesFromObjectInfo(info)
              if (wf === null) {
                const caps = await probeCapabilities(cfg, log, null)
                wf = caps?.files ?? null
              }
            } catch (error) {
              log('warn', `权重清单探测失败 → 本次拒绝改权重：${error?.message ?? error}`)
            }
            for (const [param, key, label, listsOf] of [
              // ⚠ 参数名必须与面板里 weights 的 `key` **逐字一致**（mainmodel / lorapick / cnetpick），
              //   否则下拉发了 `?lorapick=` 而这里等的是 `lora` ⇒ 被静默忽略 = 假控件。
              //   （这一条正是 `_opt_status_test` 的"每个开关 key 端点都认"抓出来的。）
              ['mainmodel', 'mainModelOverride', '主模型', () => [wf?.unet, wf?.unetGguf]],
              ['lorapick', 'loraOverride', 'LoRA', () => [wf?.lora]],
              ['cnetpick', 'controlnetOverride', 'ControlNet', () => [wf?.controlnet]],
            ]) {
              if (!queryLc.has(param)) continue
              const val = String(queryLc.get(param) ?? '')
              if (val === '') {
                if (cfg[key] !== '') {
                  cfg[key] = ''
                  log('info', `界面清除了「${label}」覆写（回到自动挑）`)
                }
                // ★ 2026-11-16 主模型选择镜像落盘 uiState.unet（重启后 apply() 恢复）。
                if (key === 'mainModelOverride') writeUiState({ ...readUiState(), unet: '' }, log)
                continue
              }
              const allowed = (listsOf() ?? []).filter((l) => Array.isArray(l)).flat()
              if (wf === null || allowed.length === 0 || !allowed.includes(val)) {
                const why = wf === null || allowed.length === 0
                  ? '本机模型清单此刻不可用，无法校验这次选择（请稍后重试）'
                  : '不在 ComfyUI 的模型清单里（可能是缓存里的旧候选，模型已被删或改名）'
                rejectChoice(label, val, why)
                continue
              }
              if (cfg[key] !== val) {
                cfg[key] = val
                log('info', `界面把「${label}」切成了 ${val}（工作流参数，**下次出图**即生效）`)
                if (key === 'mainModelOverride') writeUiState({ ...readUiState(), unet: val }, log)
              }
            }
            // ★ 2026-11-16 视频主模型（unetvideo）：校验 + 落盘 uiState.unetVideo，
            //   lib/video-workflow.js 的 activeVideoUnet() 读取；处理器在 model-options.js。
            if (queryLc.has('unetvideo')) {
              const wanted = String(queryLc.get('unetvideo') ?? '')
              if (persistVideoModelChoice({ val: wanted, wf, log }) === false) {
                rejectChoice('视频主模型', wanted, '不在视频模型清单里（模型已被删或改名）')
              }
            }
            // ★ 2026-11-16 报障修复：混合链 TTS 后端 / 音色落盘。两者都不依赖 wf
            //   （不是 UNET 权重），单独白名单校验；值由混合链 speechRunner 消费。
            if (queryLc.has('ttsbackend') || queryLc.has('ttsvoice')) {
              persistTtsChoice({
                backend: queryLc.has('ttsbackend') ? queryLc.get('ttsbackend') : undefined,
                voiceSample: queryLc.has('ttsvoice') ? queryLc.get('ttsvoice') : undefined,
                log,
              })
            }
          }

// 设计说明已外置 → docs/index-design-notes.md#index-note-080（原 L4730-4736）
          if (online) {
            // 规则②：在线即 ready，顺带把失败/超时痕迹清干净
            if (launch.phase !== 'ready') {
              launchMarkReady()
              log('info', 'ComfyUI 已就绪（状态端点确认）')
            }
          } else if (launch.phase === 'starting'
            && performance.now() - (launch.startedMono ?? 0) > LAUNCH_TIMEOUT_MS) {
            // 规则③：到点收口。先看日志有没有致命错 —— 有就是**失败**，
            // 没有才是**超时**（两者对用户含义不同：一个要去查错误，一个只是慢）。
            const tail = await readLaunchLog(launch.logPath)
            const fatal = fatalLineInLog(tail)
            if (fatal !== '') {
// 设计说明已外置 → docs/index-design-notes.md#index-note-081（原 L4750-4759）
              if (launch.sageAttempted === true && launchFailedDueToSage(tail)) {
                launch.sageSuspect = true
                log('warn', '⚠ 启动日志指向 SageAttention 疑似导致失败。'
                  + '自动回退由后台启动流程负责；状态接口只报告、不改配置。')
              }
              launchMarkFailed(`${fatal}（进程仍挂着但已注定失败，未等满超时）`)
              log('error', `ComfyUI 启动失败（日志报错）：${launch.error}`)
            } else {
              launchMarkTimeout(
                `启动超过 ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒仍未就绪`
                + '（进程没退出、日志里也没有报错，多半卡在加载模型或某个自定义节点上）',
              )
              log('warn', `ComfyUI 启动超时：${launch.error}`)
            }
          }

          // 折算成给前端的字段（纯函数，可单测）
          const view = launchView(online)
          // ★ 诊断：把"这次轮询看到了什么"如实落盘。
          //   这一行就是定位"界面卡住"的决定性证据 ——
          //   online 与 phase 一摆出来，立刻能分清是"探活失败"还是"状态机没收口"。
          diag('poll', `online=${online} phase=${launch.phase}`
            + ` starting=${view.starting} failed=${view.failed} timedOut=${view.timedOut}`
            + ` err=${view.error ? view.error.slice(0, 70) : '-'}`)

// 设计说明已外置 → docs/index-design-notes.md#index-note-082（原 L4785-4788）
          const optControls = readControls(cfg.outputDir)
          const optMode = optControls.mode
          const videoAccelOf = (probeCaps) => {
            if (optMode !== 'video' && optMode !== 'hybrid') return { id: null, note: '当前不是视频模式' }
            const installed = []
            const nodes = probeCaps?.nodes ?? {}
            if (nodes.EasyCache === true) installed.push('easycache')
            if (nodes.SpectrumQwenPatch === true) installed.push('spectrum')
            if (nodes.PatchSageAttentionKJ === true || nodes.SageAttention === true) installed.push('sage')
            const frames = videoParamsForSpeed(optControls.speedPercent, speedMap, speedTiers).frames
            const id = pickAccelProfile({ frames, vendor: String(probeCaps?.gpu?.vendor ?? ''), installed })
            return { id, note: describePick(id) }
          }
          let optimization = null
          if (online) {
            try {
              const caps = await probeCapabilities(cfg, log, undefined).catch(() => null)
              // ★ 2026-10-09：把显存总量一并喂给面板 —— 「显存驻留」那一项要靠它判定。
              //   ComfyUI 在线时 /system_stats 是权威值（probeCapabilities 里已取到）。
              optimization = describeOptimization(cfg, caps, process.platform, { mode: optMode, videoAccel: videoAccelOf(caps) })
            } catch (error) {
              optimization = {
                level: 'unknown',
                ok: false,
                summary: '优化状态未获取',
                reasons: [`探测过程出错：${error?.message ?? error}`],
                detail: [],
              }
            }
          } else {
            optimization = describeOptimization(cfg, null, process.platform, { mode: optMode, videoAccel: videoAccelOf(null) })
          }
// 设计说明已外置 → docs/index-design-notes.md#index-note-083（原 L4821-4824）
          respondJson(res, {
            ok: true,
            // ★ 选择类写操作是否真的生效：与端点自身的 ok 分开。
            //   前端据此决定显示「已选」还是明确的拒绝原因，杜绝假成功。
            choiceResult: {
              ok: choiceRejections.length === 0,
              rejections: choiceRejections,
            },
            online,
            busy,
            // ★ 启动状态：全部来自 launchView(online) 这一个纯函数。
            //   前端只认这几个字段，不再需要理解后端有几套状态。
            starting: view.starting,
            launchFailed: view.failed,
            launchTimedOut: view.timedOut,
            launchError: view.error,
            launchElapsedMs: view.starting ? Date.now() - launch.startedAt : 0,
            url: cfg.comfyUrl,
            visits,
            flowStyle: cfg.flowStyle,
            enabled: cfg.enabled !== false,
            drawTrigger: cfg.drawTrigger,
            // ★★★ 2026-10-12（用户要求）：输出目录 + 它是怎么来的 ——
            //   前端据此显示"当前出图存到哪"，并给出修改入口。
            outputDir: cfg.outputDir,
            outputDirSource: cfg.outputDirSource ?? '默认桌面目录',
            outputDirDefault: defaultOutputDir(),
            optimization,
            preset: cfg.preset ?? 'default',
            // ★ 2026-10-19（用户要求）：抽卡「挑图」两个开关的当前值，面板据此高亮。
            aiPickBest: cfg.aiPickBest ?? 'off',
            userPickBest: cfg.userPickBest ?? 'off',
            ...idle.snapshot(),
          })
        } catch (error) {
// 设计说明已外置 → docs/index-design-notes.md#index-note-084（原 L4854-4860）
          const msg = String(error?.message ?? error)
          diag('status', `状态接口抛错：${msg}`)
          log('warn', `状态接口抛错（已回退为"未就绪"，不再让界面卡住）：${msg}`)
          respondJson(res, {
            ok: false,
            reason: msg,
            // ★ 状态字段（前端据此收口，避免永久"启动中"）
            online: false,
            starting: false,
            launchFailed: false,
            launchTimedOut: false,
            launchError: `状态接口出错：${msg}`,
            optimization: {
              level: 'unknown',
              ok: false,
              summary: '优化状态未获取（状态接口出错）',
              reasons: [
                `状态接口本身抛错了：${msg}`,
                '这属于插件后端的问题，不是 ComfyUI 或优化的配置问题。可先重载插件再试。',
              ],
              detail: [],
            },
          })
        }
  }
}
