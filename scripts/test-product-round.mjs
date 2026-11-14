#!/usr/bin/env node
/**
 * test-product-round.mjs —— 2026-11-13 产品化改造离线回归
 *
 * 全程零联网、零硬件探测、零媒体生成、零进程派生：纯函数 + 注入假 deps + 源码级接线锁。
 *
 * 锁住七件事：
 *   ① 图形化安装引导：7 步 / 联网步骤必须需同意 / 网页绝不触发本机安装 / 视频包默认不装；
 *   ② 蒙版增强是真接线：羽化与边缘融合落到 InpaintCropImproved，默认零漂移；
 *   ③ 卸载内存模式：off / auto / manual 三态，action=unload 只调 /free 一次；
 *   ④ 外部集成状态：白名单脱敏，绝对路径 / 用户名 / 凭据一律不进输出；
 *   ⑤ 四个新端点信任围栏（本地判定 / GET only / POST+JSON / 有界 body）；
 *   ⑥ 端点目录 ⊆ 真实注册（防"文档写了端点其实没挂"）；
 *   ⑦ host 接线无幽灵变量 + 体积红线（client.js 贴 256 KB，尤其要盯）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SETUP_STEPS, SETUP_STEP_STATUS, publicSteps, buildSetupGuideReport,
} from '../lib/setup-guide.js'
import {
  MASK_FX_LIMITS, MASK_FX_DEFAULTS, MEMORY_MODES, normalizeMaskFx,
  maskWorkflowPatch, sigmasForDenoise, describeMaskFx, normalizeMemoryMode,
  workflowOverridesForMaskFx,
} from '../lib/mask-fx.js'
import {
  INTEGRATION_ROUTES, HEADLINE_CAPABILITIES, buildIntegrationState, buildRouteCatalog,
} from '../lib/integration-state.js'
import { makeIntegrationHandlers, registerIntegrationRoutes } from '../lib/integration-endpoints.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sizeOf = (rel) => fs.statSync(path.join(ROOT, rel)).size
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}
const OFFICIAL_9 = '1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000, 0'

console.log('=== 1. 图形化傻瓜式安装引导（纯数据 / 纯函数） ===')
{
  ok('7 个步骤', SETUP_STEPS.length === 7, SETUP_STEPS.length)
  ok('步骤 id 唯一且非空', new Set(SETUP_STEPS.map((s) => s.id)).size === 7
    && SETUP_STEPS.every((s) => typeof s.id === 'string' && s.id.length > 0))
  ok('每步都有大白话提示', SETUP_STEPS.every((s) => typeof s.hint === 'string' && s.hint.length > 8))
  ok('network / consent 都是显式布尔', SETUP_STEPS.every((s) => typeof s.network === 'boolean' && typeof s.consent === 'boolean'))
  ok('★ 联网下载的每一步都必须显式同意', SETUP_STEPS.filter((s) => s.network).every((s) => s.consent === true))
  ok('★ 视频模型自动下载包在引导里如实列出', SETUP_STEPS.some((s) => s.id === 'video'
    && s.command.includes('--video-models') && s.optional === true))
  ok('★ 语音模型口径：支持但不自动下载权重', SETUP_STEPS.some((s) => s.id === 'tts'
    && !s.network && s.hint.includes('不自动下载')))
  ok('★ 核显档位只列清单、不默认下载', SETUP_STEPS.some((s) => s.id === 'igpu'
    && !s.network && s.command.includes('--list-igpu')))
  ok('命令里没有本机绝对路径（只有占位符）', !SETUP_STEPS.some((s) => /[A-Za-z]:[\\/]|Users[\\/]Administrator|K:[\\/]/u.test(s.command)))
  ok('插件挂载步骤用占位符而不是写死路径', SETUP_STEPS.some((s) => s.id === 'plugin' && s.command.includes('<本插件目录的绝对路径>')))
  ok('publicSteps 不含 host 才有的 status 字段', publicSteps().every((s) => s.status === undefined))
  ok('publicSteps 字段集合稳定', Object.keys(publicSteps()[0]).sort().join(',')
    === 'choices,command,consent,extra,hint,id,network,optional,title')

  const empty = buildSetupGuideReport({})
  ok('★ 没探测到状态时全部 checking，绝不假装完成', empty.probed === false
    && empty.steps.every((s) => s.status === SETUP_STEP_STATUS.CHECKING) && empty.ready === false)
  ok('引导主推「视频 / 生图 / TTS 全能」', empty.headline.includes('视频') && empty.headline.includes('生图') && empty.headline.includes('TTS'))
  ok('★ 视频自动下载包：有、默认不装、需显式 flag', empty.videoDownloadPack.available === true
    && empty.videoDownloadPack.defaultOff === true && empty.videoDownloadPack.flag === '--video-models')
  ok('★ 网页绝不触发本机安装进程', empty.safety.webCannotInstall === true)
  const probed = buildSetupGuideReport({ checked: true, online: true, mainModel: true, plugin: true })
  ok('真实状态合并：done 计数如实增加', probed.probed === true && probed.done >= 3 && probed.requiredDone >= 3)
  ok('未探测到的可选步骤不冒充 done', probed.steps.find((s) => s.id === 'video').status !== SETUP_STEP_STATUS.DONE)
  ok('异常入参不抛错', buildSetupGuideReport(null).ok === true && buildSetupGuideReport('x').ok === true)
}

console.log('\n=== 2. 蒙版精修：规范化 / 真接线 / 零漂移 ===')
{
  const d = normalizeMaskFx({})
  ok('默认参数与 MASK_FX_DEFAULTS 完全一致', Object.keys(MASK_FX_DEFAULTS).every((k) => d[k] === MASK_FX_DEFAULTS[k]))
  ok('乱输入一律 clamp 到合法区间', (() => {
    const v = normalizeMaskFx({ feather: 1e9, edgeBlend: -50, grow: 999, denoise: -3, softness: 1e9 })
    return v.feather === 256 && v.edgeBlend === 0 && v.grow === 64 && v.denoise === 0.3 && v.softness === 100
  })())
  ok('布尔字段兼容 true/false/字符串/0/1', normalizeMaskFx({ invert: 'true', preview: 'false', unloadMemory: 1 }).invert === true
    && normalizeMaskFx({ invert: 'true', preview: 'false', unloadMemory: 1 }).preview === false
    && normalizeMaskFx({ invert: 'true', preview: 'false', unloadMemory: 1 }).unloadMemory === true)
  ok('非法入参（数组 / 字符串 / null）不抛错且回落默认', normalizeMaskFx([]).feather === 32 && normalizeMaskFx('x').invert === false && normalizeMaskFx(null).grow === 8)
  ok('未知字段一律丢弃', !('evil' in normalizeMaskFx({ evil: 'x' })))

  const p0 = maskWorkflowPatch(d)
  ok('★ 默认 patch 与既有工作流零漂移（grow=8 / blend=32）',
    p0.mask_expand_pixels === 8 && p0.mask_blend_pixels === 32 && p0.mask_invert === false)
  const p1 = maskWorkflowPatch({ feather: 100, edgeBlend: 50, grow: 24, invert: true })
  ok('边缘融合按百分比叠加羽化（100 + 50%×64 = 132）', p1.mask_blend_pixels === 132)
  ok('外扩与反选如实下发', p1.mask_expand_pixels === 24 && p1.mask_invert === true)
  ok('混合像素封顶 256', maskWorkflowPatch({ feather: 256, edgeBlend: 100 }).mask_blend_pixels === 256)
  ok('describeMaskFx 给出人话摘要', describeMaskFx(d).includes('羽化') && describeMaskFx(d).includes('外扩'))

  ok('★ 默认重绘强度 0.7 时 sigma 逐字不变（既有回归锁）', sigmasForDenoise(OFFICIAL_9, 0.7) === OFFICIAL_9)
  const short = sigmasForDenoise(OFFICIAL_9, 0.3)
  ok('低重绘强度裁短 sigma 序列', short.split(',').length < OFFICIAL_9.split(',').length)
  ok('★ 裁剪后仍以 0 收尾（ManualSigmas 要求）', Number(short.split(',').pop().trim()) === 0)
  ok('过短输入原样返回不伪造', sigmasForDenoise('1,0', 0.3) === '1,0')

  const cfg = { inpaintMaskGrow: 8, inpaintMaskBlend: 32, officialEditSigmas: OFFICIAL_9, outputDir: 'KEEP' }
  ok('★★ 没传 maskFx 时返回同一个 cfg 引用（默认零漂移）', workflowOverridesForMaskFx(undefined, cfg) === cfg
    && workflowOverridesForMaskFx(null, cfg) === cfg)
  const ov = workflowOverridesForMaskFx({ feather: 100, edgeBlend: 50, grow: 24, denoise: 0.35 }, cfg, OFFICIAL_9)
  ok('★ 覆盖真的落到 grow/blend 两个节点参数', ov.inpaintMaskGrow === 24 && ov.inpaintMaskBlend === 132)
  ok('★ 重绘强度落到 officialEditSigmas', ov.officialEditSigmas !== OFFICIAL_9)
  ok('其余 cfg 字段原样保留', ov.outputDir === 'KEEP' && ov.inpaintMaskGrow === 24)
  ok('★ 不原地改原 cfg（无副作用）', cfg.inpaintMaskGrow === 8 && cfg.inpaintMaskBlend === 32 && cfg.officialEditSigmas === OFFICIAL_9)
  ok('默认参数覆盖后仍等于旧的默认节点值', (() => {
    const x = workflowOverridesForMaskFx(d, cfg, OFFICIAL_9)
    return x.inpaintMaskGrow === 8 && x.inpaintMaskBlend === 32 && x.officialEditSigmas === OFFICIAL_9
      && x.inpaintMaskInvert === false
  })())
  // ★ 2026-11-13 审计阻断 #1：反选以前只算出来就被丢掉 —— turbo-workflow 把
  //   mask_invert 写死 false，「反选蒙版」开关纯装饰。这条锁住两端都不许回退。
  ok('★★ 反选真的从 UI 走到 cfg（inpaintMaskInvert）',
    workflowOverridesForMaskFx({ invert: true }, cfg, OFFICIAL_9).inpaintMaskInvert === true)
  ok('★★ 工作流节点真的读 cfg.inpaintMaskInvert（不再硬编码 false）',
    /mask_invert:\s*cfg\.inpaintMaskInvert === true/u.test(readSrc('lib/turbo-workflow.js')))
  ok('★★ 不勾反选时仍是 false（零漂移）',
    workflowOverridesForMaskFx({ invert: false }, cfg, OFFICIAL_9).inpaintMaskInvert === false)
  ok('前端滑块范围与后端 MASK_FX_LIMITS 一一对应', (() => {
    const src = readSrc('assets/mask-fx.js')
    return Object.entries(MASK_FX_LIMITS).every(([k, v]) => {
      const re = new RegExp(k + ':\\s*\\{\\s*min:\\s*' + v.min + ',\\s*max:\\s*' + v.max + ',\\s*def:\\s*' + v.def, 'u')
      return re.test(src)
    })
  })())
}

console.log('\n=== 3. 卸载内存模式 ===')
{
  ok('只有 off / auto / manual 三态', MEMORY_MODES.length === 3 && MEMORY_MODES.join(',') === 'off,auto,manual')
  ok('非法值一律回落 off（不静默开启）', normalizeMemoryMode('AUTO') === 'auto'
    && normalizeMemoryMode('yes') === 'off' && normalizeMemoryMode(null) === 'off')
  const src = readSrc('assets/mask-fx.js')
  ok('UI 三态下拉 + 立即卸载按钮都在', src.includes("'auto'") && src.includes("'manual'") && src.includes("action: 'unload'"))
}

console.log('\n=== 4. 外部集成状态：白名单脱敏 ===')
{
  ok('主推三大能力与简介口径一致', HEADLINE_CAPABILITIES.map((c) => c.id).join(',') === 'video,image,tts')
  const dirty = {
    version: '9.9.9', online: true, tools: ['draw_image', 'BAD NAME', 'x'.repeat(200), 'inpaint_image'],
    active: 2, completed: 5, failed: -3, queueRunning: 1,
    memoryMode: 'auto', unloadCount: 4, lastUnloadOk: true,
    maskFx: { feather: 44, edgeBlend: 12, grow: 9, invert: true, unloadMemory: true },
    imageBackend: 'hipfire', enabled: true, tier: 'gguf', speedTargetSec: 180,
    // 下面这些是**故意塞进来的脏数据**，一个都不许出现在输出里
    homeDir: 'C:/Users/Administrator/secret/token.txt',
    apiKey: 'sk-THIS-MUST-NOT-LEAK', dialog: '用户私人对话原文',
  }
  const s = buildIntegrationState(dirty)
  const text = JSON.stringify(s)
  ok('★ 绝对路径 / 用户名 / 凭据 / 对话内容一个都不进输出',
    !text.includes('Administrator') && !text.includes('sk-THIS-MUST-NOT-LEAK')
    && !text.includes('token.txt') && !text.includes('用户私人对话原文'))
  ok('只留白名单工具名（非法名与超长名被过滤）', s.tools.count === 2
    && s.tools.registered.join(',') === 'draw_image,inpaint_image')
  ok('任务计数不为负', s.tasks.failed === 0 && s.tasks.active === 2 && s.tasks.queueRunning === 1)
  ok('服务与内存状态如实透出', s.service.online === true && s.service.imageBackend === 'hipfire'
    && s.memory.mode === 'auto' && s.memory.unloadCount === 4)
  ok('蒙版参数只透出白名单数值', s.maskFx.feather === 44 && s.maskFx.invert === true && !('softness' in s.maskFx))
  ok('隐私声明 + 全能标题', s.privacy.sanitized === true && s.headline.includes('视频 / 生图 / TTS'))
  ok('★ 自动下载包口径：视频/核显 opt-in、音频 manual', s.packs.videoModels.autoDownload === 'opt-in'
    && s.packs.igpuModels.autoDownload === 'opt-in' && s.packs.audioModels.available === false)
  ok('异常入参不抛错', buildIntegrationState('x').ok === true && buildIntegrationState(null).ok === true)
  // ★ 2026-11-13 审计修复：以前写死 true；用户显式 allowRemoteComfy 时插件确实能连远端，
  //   快照必须如实反映配置，不能靠声明蒙混。默认仍为 true（向后兼容）。
  ok('★ comfyLocalOnly 不再写死，如实反映当前配置',
    buildIntegrationState({}).service.comfyLocalOnly === true
    && buildIntegrationState({ comfyLocalOnly: false }).service.comfyLocalOnly === false
    && buildIntegrationState({ comfyLocalOnly: true }).service.comfyLocalOnly === true)
  const cat = buildRouteCatalog()
  ok('端点目录机器可读且条数一致', cat.count === INTEGRATION_ROUTES.length && cat.routes.length === cat.count && cat.localOnly === true)
  ok('目录项不可被外部改坏（每次返回副本）', (() => { cat.routes[0].path = 'HACK'; return INTEGRATION_ROUTES[0].path !== 'HACK' })())
}

console.log('\n=== 5. 四个新端点：围栏 / 参数 / 卸载（注入假 deps，零联网） ===')
{
  const makeDeps = (over = {}) => {
    const calls = { unload: [], probe: 0, bodies: [] }
    const runtime = {
      maskFx: normalizeMaskFx({}), memoryMode: 'off', unloadCount: 0, lastUnloadOk: false,
    }
    const deps = {
      isLocalRequest: (req) => req.local !== false,
      guardWriteRequest: (req) => req.guardOk !== false,
      respondJson: (res, body, code = 200) => { res.out = { body, code } },
      readJsonBody: async (req) => { calls.bodies.push(req.body); return req.body ?? {} },
      cfg: { comfyUrl: 'http://127.0.0.1:8188' },
      log: () => {},
      runtime,
      probeGuideState: async () => { calls.probe += 1; return { checked: true, online: true, mainModel: true, plugin: true } },
      snapshot: async () => ({ version: '0.2.0', online: true, tools: ['draw_image'], tier: 'gguf' }),
      unloadModels: async (body) => { calls.unload.push(body); return true },
      ...over,
    }
    return { deps, calls, runtime }
  }
  const run = async (handler, req) => {
    const res = {}
    await handler(req, res)
    return res.out ?? null
  }

  const { deps, calls, runtime } = makeDeps()
  const h = makeIntegrationHandlers(deps)

  const g = await run(h.setupGuideHandler, { method: 'GET' })
  ok('GET 安装引导：真实状态合并 + 主推标题', g?.code === 200 && g.body.ok === true
    && g.body.done >= 3 && g.body.headline.includes('视频 / 生图 / TTS'))
  ok('非本机请求 403，且没有触发探测', (await run(h.setupGuideHandler, { method: 'GET', local: false }))?.code === 403
    && calls.probe === 1)
  ok('引导端点 GET only（POST 405）', (await run(h.setupGuideHandler, { method: 'POST' }))?.code === 405)
  ok('★ 探测抛错也返回完整步骤清单，且异常细节不回吐浏览器', await (async () => {
    const logs = []
    const d2 = makeDeps({
      probeGuideState: async () => { throw new Error('K:/secret/private-path.txt') },
      log: (level, msg) => logs.push({ level, msg }),
    })
    const r = await run(makeIntegrationHandlers(d2.deps).setupGuideHandler, { method: 'GET' })
    return r?.body?.ok === true && r.body.steps.length === 7
      && r.body.note.includes('状态探测暂不可用')
      && !JSON.stringify(r.body).includes('K:/secret')
      && logs.some((x) => x.msg.includes('K:/secret'))
  })())

  const mf = await run(h.maskFxHandler, { method: 'GET' })
  ok('GET 蒙版参数：默认值 / 范围 / 三态 / patch 都在', mf?.body?.ok === true
    && mf.body.current.feather === 32 && mf.body.limits.feather.max === 256
    && mf.body.memoryModes.join(',') === 'off,auto,manual'
    && mf.body.workflowPatch.mask_expand_pixels === 8)
  ok('蒙版端点非本机 403', (await run(h.maskFxHandler, { method: 'GET', local: false }))?.code === 403)
  ok('蒙版端点只收 GET/POST（PUT 405）', (await run(h.maskFxHandler, { method: 'PUT' }))?.code === 405)
  const blocked = await run(h.maskFxHandler, { method: 'POST', guardOk: false, body: { maskFx: { feather: 999 } } })
  ok('★ 写操作被 guard 拦下时绝不改运行态', blocked === null && runtime.maskFx.feather === 32)
  const badBody = await run(h.maskFxHandler, { method: 'POST', body: ['not', 'object'] })
  ok('★ body 必须是 JSON 对象（数组 400）', badBody?.code === 400)
  const set = await run(h.maskFxHandler, { method: 'POST', body: { maskFx: { feather: 9999, denoise: -1 }, memoryMode: 'auto' } })
  ok('★ POST 设置：非法值 clamp、模式只认白名单', set?.code === 200
    && set.body.current.feather === 256 && set.body.current.denoise === 0.3 && set.body.memoryMode === 'auto')
  ok('设置后运行态同步更新', runtime.maskFx.feather === 256 && runtime.memoryMode === 'auto')
  const un = await run(h.maskFxHandler, { method: 'POST', body: { action: 'unload' } })
  ok('★ action=unload 只调一次 /free 且载荷固定', un?.body?.ok === true && calls.unload.length === 1
    && calls.unload[0].unload_models === true && calls.unload[0].free_memory === true && runtime.unloadCount === 1)
  ok('卸载失败如实记账', await (async () => {
    const d3 = makeDeps({ unloadModels: async () => false })
    const r = await run(makeIntegrationHandlers(d3.deps).maskFxHandler, { method: 'POST', body: { action: 'unload' } })
    return r.body.ok === false && d3.runtime.lastUnloadOk === false
  })())

  const st = await run(h.integrationStateHandler, { method: 'GET' })
  ok('GET 聚合状态：异步 snapshot 合并 + 脱敏', st?.code === 200 && st.body.ok === true
    && st.body.version === '0.2.0' && st.body.tools.count === 1 && st.body.privacy.sanitized === true)
  ok('状态端点 GET only（POST 405）', (await run(h.integrationStateHandler, { method: 'POST' }))?.code === 405)
  ok('状态端点非本机 403', (await run(h.integrationStateHandler, { method: 'GET', local: false }))?.code === 403)
  ok('★ snapshot 抛错 500，异常细节只进本地日志不进响应', await (async () => {
    const logs = []
    const d4 = makeDeps({
      snapshot: async () => { throw new Error('C:/Users/Administrator/SECRET-STACK') },
      log: (level, msg) => logs.push({ level, msg }),
    })
    const r = await run(makeIntegrationHandlers(d4.deps).integrationStateHandler, { method: 'GET' })
    return r.code === 500 && !JSON.stringify(r.body).includes('SECRET-STACK')
      && !JSON.stringify(r.body).includes('Administrator')
      && logs.some((x) => x.msg.includes('SECRET-STACK'))
  })())
  const rt = await run(h.integrationRoutesHandler, { method: 'GET' })
  ok('GET 端点目录：条数一致 + 仅本机', rt?.body?.count === INTEGRATION_ROUTES.length && rt.body.localOnly === true)

  const routes = []
  registerIntegrationRoutes((r) => { routes.push(r); return () => {} }, h).forEach((d) => d())
  ok('★ 四个新端点全部真实注册', routes.length === 4 && routes.every((r) => r.kind === 'exact' && typeof r.handler === 'function'))
  const paths = routes.map((r) => r.path).sort()
  ok('路径与公开目录一致', paths.join(',') === [
    '/api/qwen-paint/integration/routes', '/api/qwen-paint/integration/state',
    '/api/qwen-paint/mask-fx', '/api/qwen-paint/setup-guide',
  ].sort().join(','))
}

console.log('\n=== 6. host 接线静态锁 + 端点目录 ⊆ 真实注册 ===')
{
  const idx = readSrc('lib/index.js')
  const cli = readSrc('lib/client.js')
  const runner = readSrc('lib/task-runner.js')
  // ★★ 2026-11-14：改成**自动扫描 lib/ 下全部模块**，不再维护硬编码文件清单。
  //   上一版的清单手工列了 9 个文件，本轮新增 lib/config-endpoints.js 注册了 3 个端点，
  //   而它不在清单里 ⇒ 这条断言只看到 history/thumb 一条，「注册 ⊆ 目录」直接红。
  //   这类"扫描范围本身就是漏点"的问题，靠往清单里再加一行治不好，只能改成自动发现。
  //   （实测：自动扫描与硬编码清单算出的集合完全一致，只是多了新模块的端点，不误报注释里的路径。）
  const endpointFiles = fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => readSrc('lib/' + f))
    .join('\n')

  ok('★ 端点处理器已挂到 host', idx.includes('makeIntegrationHandlers({') && idx.includes('registerIntegrationRoutes('))
  // ★ 2026-11-13：assetRoute 已外置成 lib/asset-route.js 的表驱动注册（index.js 瘦身 4 KB）。
  //   行为没变，但源码字面量搬了家 ⇒ 断言改指新落点，且覆盖面从 4 个扩到全部 10 个。
  const assetMod = readSrc('lib/asset-route.js')
  ok('★ 静态资源路由已外置成表驱动并由 host 注册',
    idx.includes('registerAssetRoutes(webCtx.webServer')
    && ['loading.webp', 'loading.gif', 'panel.js', 'panel.css', 'setup-guide.js',
      'setup-guide.css', 'mask-fx.js', 'mask-fx.css', 'cpu-accel.js', 'cpu-accel.css']
      .every((n) => assetMod.includes(`'${n}'`)))
  ok('★ client.js 挂载两个新脚本', cli.includes('loadQpExtras()') && cli.includes('function loadQpExtras()')
    && cli.includes('qwen-paint/setup-guide.js') && cli.includes('qwen-paint/mask-fx.js'))
  ok('★ 蒙版导出与参数下发都接上', cli.includes('window.DshQpMaskFx.exportMask(maskCanvas)') && cli.includes('maskFx: fx'))
  ok('★ 圈选重绘端点把 maskFx 传进 execute', idx.includes('{ image, prompt, mask: maskPath, maskFx: fx }'))
  ok('★ 任务编排用了覆盖后的 cfg', runner.includes('workflowOverridesForMaskFx(args?.maskFx, cfg, sigmaText)')
    && runner.includes('deps.buildTaskWorkflow(workflowCfg, taskArgs, caps)'))
  ok('★ ColorMatch 重跑也沿用同一份覆盖', runner.includes('{ ...workflowCfg, taskColorMatch: false }'))
  ok('★ 任务收尾会按所选模式卸载内存', idx.includes('function maybeAutoUnload()') && idx.includes('maybeAutoUnload()')
    && idx.includes('finally {') && idx.includes("integrationRuntime.maskFx?.unloadMemory !== true"))
  ok('★ host 快照是 async 且只读真值', idx.includes('snapshot: async () =>') && idx.includes('await status.probe()')
    && idx.includes('detectGpuProfile(cfg, log)') && idx.includes('registeredToolNames.slice()'))
  // 注意：healthHandler 里的局部 `pkg.version` 是合法写法（fsp 读自身 package.json），
  // 只锁旧接线脚本那种「在 snapshot 里凭空引用 pkg」的形态。
  ok('★★ 上一版脚本的幽灵变量一个都没混进来', !idx.includes('status.lastOnline')
    && !idx.includes('registeredTools.map') && !idx.includes('readiness?.')
    && !idx.includes('version: pkg.version') && !idx.includes('setupGuideReady: false'))
  ok('★ 端点目录 ⊆ 真实注册（防「写了没挂」）', INTEGRATION_ROUTES.every((r) => endpointFiles.includes(r.path)),
    INTEGRATION_ROUTES.filter((r) => !endpointFiles.includes(r.path)).map((r) => r.path).join(','))
  // ★★ 2026-11-13 审计（第一轮）：原来只查上面那一个方向，所以「真注册了但没写进目录」
  //    完全抓不到 —— 实测漏了 10 条（library / skills / reference 四件套 / file /
  //    memory/* / recent-images / repair）。补上反向断言，以后加端点忘了同步就红。
  const cataloged = new Set(INTEGRATION_ROUTES.map((r) => r.path))
  const registered = [...new Set([...endpointFiles
    .matchAll(/['"](\/api\/(?:qwen-paint|comfy-pipeline)\/[A-Za-z0-9_./-]*)['"]/gu)]
    .map((m) => m[1]))].sort()
  ok('★★ 真实注册 ⊆ 端点目录（防「挂了没写」）',
    registered.every((p) => cataloged.has(p)), registered.filter((p) => !cataloged.has(p)).join(','))
  ok('端点目录条数与实际注册逐条相等', registered.length === INTEGRATION_ROUTES.length,
    `目录 ${INTEGRATION_ROUTES.length} / 实际 ${registered.length}：`
    + registered.filter((p) => !cataloged.has(p)).concat(
      INTEGRATION_ROUTES.map((r) => r.path).filter((p) => !registered.includes(p))).join(','))
  ok('端点目录里没有重复路径', cataloged.size === INTEGRATION_ROUTES.length)
  ok('端点目录每条都有 method / access / desc', INTEGRATION_ROUTES.every((r) =>
    typeof r.method === 'string' && r.method !== '' && r.access === 'local'
    && typeof r.desc === 'string' && r.desc !== ''))
  ok('★ 体积红线：单文件 ≤ 262144 B', sizeOf('lib/index.js') <= 262144 && sizeOf('lib/client.js') <= 262144,
    'client.js=' + sizeOf('lib/client.js'))
  ok('★ lib 合计 ≤ 2097152 B', (() => {
    let t = 0
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) t += sizeOf('lib/' + f)
    return t <= 2097152
  })())
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓')
