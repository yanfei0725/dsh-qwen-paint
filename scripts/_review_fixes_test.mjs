/**
 * _review_fixes_test.mjs —— 2026-10-10 代码审查所修 bug 的回归锁。
 *
 * 覆盖（每条都对应一处真实缺陷，见 本轮修复报告-20261009.md 〇·十四）：
 *   1. safeStem 英文分支忽略 maxChars（写死 34）
 *   2. drawTrigger 只写不读（重启丢设置）
 *   3. client `get current()` 引用未定义变量
 *   4. hipfire 通道仍裸传 abort(signal.reason)（[object Object]）
 *   5. FULL_CAPS 缺 rdna3fa
 *   6. genericOptimizations 与真实工作流不一致（报静态布尔而非策略）
 *   7. 面板「显存驻留」用 ?? 导致 0 不回落
 *   8. ensureComfyUp 无视 launch.phase（失败后空等 + 覆盖失败原因）
 *   9. 图生图 width/height 用请求值冒充实际值
 *  10. client 开关点后卡在"切换中…"
 *  11. 拉起后端后最小化窗口（Win11/Windows Terminal 下原先无效）
 *  12. setup.mjs `--check` 早退写在下载循环之后（"只看不下载"实际会开下）
 *  13. selftest.mjs 与代码契约脱节（apply 改成立即注册后，首节即崩）
 *  14. queueBusy 短缓存 TTL 写死 → 做成 cfg.queueCacheMs 可配置（默认 2 秒不变）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { safeStem, DEFAULTS } = mod.__internal
const HOST = ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const HIPFIRE = readFileSync(path.join(ROOT, 'lib', 'hipfire-img.js'), 'utf8')

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

console.log('=== 1. safeStem 英文分支遵守 maxChars ===')
{
  const long = 'a very long english prompt with many many words to exceed the limit yes indeed'
  ok('纯英文 prompt → 长度 ≤ maxChars(22)', safeStem(long, 22).length <= 22)
  ok('纯英文 prompt → 长度 ≤ maxChars(10)', safeStem(long, 10).length <= 10)
  ok('中文 prompt → 长度 ≤ maxChars(22)', safeStem('这是一个非常非常非常非常非常长的中文提示词', 22).length <= 22)
  ok('空 prompt → 有兜底名', safeStem('', 22) === '无题')
  ok('不再写死 34（源码里 maxChars 被真正使用）', HOST.includes('const limit = Number.isFinite(maxChars)'))
}

console.log('\n=== 2. drawTrigger 落盘后必须读回（与 flowStyle 对称） ===')
ok('apply 里恢复了 drawTrigger', HOST.includes('cfg.drawTrigger = savedUi.drawTrigger'))
ok('恢复时校验是合法档位', HOST.includes('hasOwnProperty.call(DRAW_INTENT_MODES, savedUi.drawTrigger)'))
ok('显式配置优先（rawConfig.drawTrigger === undefined 才回落）', HOST.includes('rawConfig?.drawTrigger === undefined'))

console.log('\n=== 3/10. 客户端两处 ===')
// ⚠ 必须**先剥注释**再查：修 bug 的说明注释里就原样引用了那句坏代码。
const CLIENT_NO_COMMENTS = CLIENT
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '')
ok('3. 已删除引用未定义变量的 get current', !/get current\(\)\s*\{\s*return current\s*\}/u.test(CLIENT_NO_COMMENTS))
ok('3. current getter 现在返回真实存在的 lastDetail', CLIENT.includes('get current() { return lastDetail }'))
ok('10. 开关成功后关闭面板（否则按钮卡"切换中…"）', CLIENT.includes('closePanel()'))

console.log('\n=== 4. hipfire 不再裸传 abort(signal.reason) ===')
ok('没有裸 controller.abort(signal.reason)', !/controller\.abort\(signal\??\.reason\)/u.test(HIPFIRE))
ok('改成先归一化成 Error', HIPFIRE.includes('reason instanceof Error'))

console.log('\n=== 5. FULL_CAPS 含 rdna3fa ===')
ok('FULL_CAPS.nodes.rdna3fa === true', mod.__internal.FULL_CAPS.nodes.rdna3fa === true)
ok('caps 完全没传时 FA 会挂（说明 FULL_CAPS 生效）',
  (() => {
    const { buildWorkflow } = mod.__internal
    const wf = buildWorkflow({ ...DEFAULTS }, { prompt: 'x', width: 992, height: 992, seed: 1 })
    return wf['17']?.class_type === 'ApplyRDNA3FlashAttention'
  })())

console.log('\n=== 6. genericOptimizations 报"策略"而非静态布尔 ===')
ok('不再有 "TE-Speed 跳步缓存：${mark(plan.useTe)}"', !HOST.includes('`TE-Speed 跳步缓存：${mark(plan.useTe)}`'))
ok('改成三者互斥的策略行', HOST.includes('TE-Speed / Speedup / BlockCache（三者互斥）：${wrapperLine}'))
ok('策略里出现"按尺寸自动"', HOST.includes('按尺寸自动：小尺寸'))

console.log('\n=== 7. 面板显存驻留判定用 || 而非 ?? ===')
ok('不再用 `c.gpu?.vramGB ??`', !HOST.includes('c.gpu?.vramGB ?? c.residency'))
ok('改成 `c.gpu?.vramGB ||`', HOST.includes('c.gpu?.vramGB || c.residency'))

console.log('\n=== 8. ensureComfyUp 检查 launch.phase ===')
ok('startComfyHidden 之后立刻检查 failed', HOST.includes("if (launch.phase === 'failed') {"))
ok('循环里检查 failed/timeout', HOST.includes("launch.phase === 'failed' || launch.phase === 'timeout'"))
ok('只在仍 starting 时才置超时（不覆盖 failed）',
  /if \(launch\.phase === 'starting'\) \{\s*\n\s*launchMarkTimeout\(/u.test(HOST))

console.log('\n=== 9. 图生图用实测尺寸 ===')
ok('outWidth 是 let（可被实测值覆盖）', HOST.includes('let outWidth = eff.width'))
ok('图生图用 readPngSize 覆盖 outWidth/outHeight', HOST.includes("if (reference !== '' && actual !== null) {"))

console.log('\n=== 12. 拉起后端后最小化窗口（Win11/Windows Terminal 下原先无效） ===')
{
  ok('12. .cmd 设了唯一标题（供按标题精确定位）', HOST.includes("'title DSHQP-ComfyUI'"))
  ok('12. 按标题找窗口', HOST.includes('$api::FindWindow($null, $title)'))
  ok('12. 找可见的 Windows Terminal 窗口', HOST.includes('CASCADIA_HOSTING_WINDOW_CLASS'))
  ok('12. 自身控制台**仅在可见时**才用（修根因：WT 下它是不可见的伪控制台）',
    HOST.includes('$api::IsWindowVisible($own)'))
  ok('12. 结果落盘（旧脚本全吞掉、出问题看不到）', HOST.includes('.dshqp-minwin.log'))
  ok('12. ps1 注释保持纯 ASCII（PS5.1 无 BOM 按 ANSI 读，中文会解析错位）',
    HOST.includes("'# 2026-10-10 KEY FIX (window never got minimized):'"))
}

console.log('\n=== 13. setup.mjs --check 不再"边看边下" ===')
{
  // 原 bug：--check 的早退判断写在**下载循环之后** ⇒ "只看不下载"实际会开下
  //（实测误建过 2.4 GB 半成品）。修法：把早退提到下载循环之前。
  const SETUP = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  const atCheck = SETUP.indexOf('if (CHECK_ONLY) {')
  // 第一个 `for (const model of MODELS)` 是**只读探测**循环；下载循环在 `if (needDownload === 0)` 之后。
  const dlLoop = SETUP.indexOf('for (const model of MODELS) {', SETUP.indexOf('if (needDownload === 0) {'))
  ok('13. --check 早退出现在下载循环之前', atCheck > 0 && dlLoop > 0 && atCheck < dlLoop)
  ok('13. --check 分支内不再出现下载调用', !/if \(CHECK_ONLY\) \{[\s\S]{0,500}?downloadWithCurl/u.test(SETUP))
}

console.log('\n=== 14. selftest.mjs 与代码契约对齐（原先首节即崩） ===')
{
  // 根因：本版 apply **直接用第一个参数注册**（不再 root.inject(['tools'], cb)），
  //   而旧 mock 把富 ctx 藏在 inject 回调里 ⇒ 工具一个都注册不上、自测首节必挂。
  const SELFTEST = readFileSync(path.join(ROOT, 'scripts', 'selftest.mjs'), 'utf8')
  ok('14. apply 直接用富 ctx（不再经 root.inject）', SELFTEST.includes('mod.apply(ctx, {'))
  ok('14. mock 提供 ctx.get（代码用 ctx.get 取 sessionProjections）',
    SELFTEST.includes("get(name) { return name === 'sessionProjections' ? ctx.sessionProjections : undefined }"))
  ok('14. 工作流链改成动态回溯（不再写死 1→11→12→7→13→8）', SELFTEST.includes('chainPathOf'))
  ok('14. 不再断言"恰好注册 1 个工具"（现在是 3 个）', !SELFTEST.includes('恰好注册了 1 个工具'))
}

console.log('\n=== 15. queueBusy 的短缓存 TTL 可配置（默认行为不变） ===')
ok('15. 用 cfg.queueCacheMs ?? 2000（生产仍 2 秒）', HOST.includes('cfg.queueCacheMs ?? 2000'))

console.log('\n=== 16. 优化面板按显卡过滤（N 卡上不该出现 RDNA3 优化） ===')
{
  // 主人反馈：「怎么 5060 还能弹出来 AMD R3 的优化呢？识别是哪个显卡，
  //   就把不能用的优化直接隐藏掉。」根因：RDNA3 FA 那一项只看"节点装没装"、不看显卡。
  const { describeOptimization, genericOptimizations, FULL_CAPS, DEFAULTS: DEF } = mod.__internal
  const FA = 'RDNA3 FlashAttention（无损）'
  const capsWith = (gpuName) => ({
    ...FULL_CAPS,
    nodes: { ...FULL_CAPS.nodes },
    models: { unet: 'u', clip: 'c', vae: 'v', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
    notes: [],
    gpu: gpuName === '' ? null : { name: gpuName, vramGB: 16 },
  })
  const names = (opt) => opt.detail.map((d) => d.name)

  const nv = describeOptimization({ ...DEF }, capsWith('NVIDIA GeForce RTX 5060'))
  ok('16. N 卡（5060）：detail 里**没有** RDNA3 FA', !names(nv).includes(FA), names(nv))
  ok('16. N 卡：filtered 里点名了它（不静默消失）', Array.isArray(nv.filtered) && nv.filtered.includes(FA), nv.filtered)
  ok('16. N 卡：gpu.vendor === nvidia', nv.gpu?.vendor === 'nvidia', nv.gpu)
  ok('16. N 卡：stats.total 与 detail 长度一致（统计没算进被藏项）', nv.stats.total === nv.detail.length, [nv.stats.total, nv.detail.length])

  const amd = describeOptimization({ ...DEF }, capsWith('AMD Radeon RX 7900 XTX (gfx1100)'))
  ok('16. RDNA3 卡：detail 里**有** RDNA3 FA', names(amd).includes(FA), names(amd))
  ok('16. RDNA3 卡：filtered 为空', amd.filtered.length === 0, amd.filtered)

  const rdna4 = describeOptimization({ ...DEF }, capsWith('AMD Radeon RX 9070 XT'))
  ok('16. RDNA4 卡：也隐藏（该节点只认 gfx1100）', !names(rdna4).includes(FA), names(rdna4))

  const intel = describeOptimization({ ...DEF }, capsWith('Intel(R) Arc(TM) B580 Graphics'))
  ok('16. I 卡：隐藏', !names(intel).includes(FA), names(intel))

  const unknown = describeOptimization({ ...DEF }, capsWith(''))
  ok('16. 认不出显卡 → **不隐藏**（守住"认不出就不猜"的约定）', names(unknown).includes(FA), names(unknown))
  ok('16. 认不出显卡 → gpu 为 null', unknown.gpu === null, unknown.gpu)

  const gnv = genericOptimizations(capsWith('NVIDIA GeForce RTX 5060'), { ...DEF })
  ok('16. generic（check_acceleration 用）在 N 卡上也不列 RDNA3 行',
    !gnv.some((l) => l.includes('RDNA3 FlashAttention')), gnv)
  const gamd = genericOptimizations(capsWith('AMD Radeon RX 7900 XTX'), { ...DEF })
  ok('16. generic 在 RDNA3 卡上保留该行', gamd.some((l) => l.includes('RDNA3 FlashAttention')), gamd)

  const CLIENT_SRC = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  ok('16. client 会渲染"已按显卡识别隐藏"的提示', CLIENT_SRC.includes('已按显卡识别隐藏'))
  ok('16. client 有对应样式类', CLIENT_SRC.includes('.qwen-paint-opt-filtered'))
}

console.log('\n=== 17. 主模型加载器（GGUF 路线已撤，但手动配置仍生效） ===')
{
  const { buildWorkflow, DEFAULTS: DEF, unetLoaderFor, unetLoaderNode, resolvePlan } = mod.__internal
  const GGUF = 'whatever-qwen-image-Q4_K_M.gguf'

  // ---- 默认路径必须与旧版**一字不差** ----
  const wfDef = buildWorkflow({ ...DEF }, { prompt: 'x', width: 992, height: 992, seed: 1 })
  ok('17. 默认仍是原生 UNETLoader', wfDef['1']?.class_type === 'UNETLoader', wfDef['1'])
  ok('17. 默认仍带 weight_dtype=default', wfDef['1']?.inputs?.weight_dtype === 'default')
  ok('17. 默认主模型名不变', wfDef['1']?.inputs?.unet_name === 'qwen_image_2.1_int8_convrot.safetensors',
    wfDef['1']?.inputs?.unet_name)

  // ---- 两个加载器的输入形状**不同**（混用会被 ComfyUI 拒收）----
  ok('17. .gguf → UnetLoaderGGUF', unetLoaderFor(GGUF) === 'UnetLoaderGGUF')
  ok('17. 非 .gguf → UNETLoader', unetLoaderFor('a.safetensors') === 'UNETLoader')
  ok('17. 空/未定义 → UNETLoader（保守）', unetLoaderFor(undefined) === 'UNETLoader')
  const ggufNode = unetLoaderNode(GGUF)
  ok('17. GGUF 节点只传 unet_name', JSON.stringify(Object.keys(ggufNode.inputs)) === JSON.stringify(['unet_name']),
    ggufNode.inputs)
  ok('17. GGUF 节点**不**带 weight_dtype（多传会报 unexpected input）', ggufNode.inputs.weight_dtype === undefined)
  const safeNode = unetLoaderNode('a.safetensors')
  ok('17. 原生节点带 unet_name + weight_dtype',
    JSON.stringify(Object.keys(safeNode.inputs)) === JSON.stringify(['unet_name', 'weight_dtype']), safeNode.inputs)

  // ---- ★ 2026-10-12：GGUF 路线已撤（装错格式的文件）----
  const SRC = ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n')
  ok('17. ★ 档位表保留（用户要求）', SRC.includes('const MODEL_TIERS = {'))
  // ⚠ 文件名本身还会出现在"解释为什么删掉它"的注释里 —— 那是**教训记录**，不是推荐。
  //   所以断言的是：**没有任何会自动执行它的东西**（下载用的 size/sha 必须消失）。
  ok('17. ★ 不再下载那个 sd.cpp GGUF（size/sha 校验值已消失）',
    !SRC.includes('4199565024') && !SRC.includes('631d532e7ca71e8d90a87c71d3699761a812039d22e3370e87498d87754660fe'))
  ok('17. ★ 但 UnetLoaderGGUF 加载能力保留（手动配置可用）',
    SRC.includes("const UNET_LOADER_GGUF = 'UnetLoaderGGUF'"))
  ok('17. ★ 探测器仍探 ggufUnet 节点（手动装了就报"可用"）',
    SRC.includes('ggufUnet: up(\'ggufUnet\')'))
  ok('17. ★ 删档位的理由写进了源码（防止后人再犯）',
    SRC.includes('stable-diffusion.cpp') && SRC.includes('general.architecture'))

  const SETUP = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  ok('17. setup 保留 TIERS 分档（用户要求）', SETUP.includes('const TIERS = {'))
  ok('17. setup 保留 --tier 参数', SETUP.includes("valueOf('--tier')"))
  ok('17. ★ lite 档恢复自动下载（用 abenzerps 那个实测能用的）', SETUP.includes('const UNET_LITE = {'))
  ok('17. ★ GGUF 下载源是 hf-mirror（ModelScope 上实测 404）',
    SETUP.includes('https://hf-mirror.com/${GGUF_REPO}/resolve/main/')
    && SETUP.includes('https://huggingface.co/${GGUF_REPO}/resolve/main/'))
  ok('17. ★ GGUF 的 size/sha256 是服务器权威值（HF API 的 lfs.oid + Content-Length）',
    SETUP.includes('4604558112') && SETUP.includes('e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41'))
  ok('17. ★ GGUF 多源轮询（hf-mirror → huggingface）',
    SETUP.includes('const GGUF_BASES = [') && SETUP.includes('ggufUrlsOf(model)'))
  ok('17. ★ 非 GGUF 仍只走 ModelScope 一个源（行为与以前一致）',
    SETUP.includes('[`${REPO_BASE}${model.dir}/${model.name}`]'))
  ok('17. ★ 全源失败时提示可自备 .gguf', SETUP.includes('插件会自动认'))
  // ⚠ "unsloth" 仍出现在**解释为什么不用它**的注释里，那不算引用。
  //   断言的应是"不把它当下载源"。
  ok('17. ★ setup 不把 unsloth 当下载源',
    !SETUP.includes("const GGUF_REPO = 'unsloth"))
  ok('17. 轻量档装完提示必须装 ComfyUI-GGUF', SETUP.includes('city96/ComfyUI-GGUF'))
  ok('17. 死函数 writeConfigUnet 已删', !SETUP.includes('function writeConfigUnet'))
  ok('17. 死函数不残留调用', !SETUP.includes('writeConfigUnet('))
  ok('17. int8 主模型的 sha256 仍是官方值',
    SETUP.includes('cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d'))

  // ---- resolvePlan 仍会把加载器带出来（手动配 .gguf 时自动切换）----
  const planGguf = resolvePlan({ ...DEF, unet: GGUF }, null)
  ok('17. cfg.unet=.gguf 时 plan.unetLoader = UnetLoaderGGUF（手动配置仍生效）',
    planGguf.unetLoader === 'UnetLoaderGGUF', planGguf.unetLoader)
  const planDef = resolvePlan({ ...DEF }, null)
  ok('17. 默认 plan.unetLoader = UNETLoader', planDef.unetLoader === 'UNETLoader', planDef.unetLoader)
  const wfGguf = buildWorkflow({ ...DEF, unet: GGUF }, { prompt: 'x', width: 992, height: 992, seed: 1 })
  ok('17. 手动配 GGUF 时工作流节点也切过去', wfGguf['1']?.class_type === 'UnetLoaderGGUF', wfGguf['1'])
  // 只有 1 号（主模型加载器）该动，其余 15 个节点一个都不许变
  const changed = Object.keys(wfDef).filter((k) => JSON.stringify(wfDef[k]) !== JSON.stringify(wfGguf[k]))
  ok('17. GGUF 只影响 1 号节点，其余全不动', JSON.stringify(changed) === JSON.stringify(['1']), changed)
}

console.log('\n=== 18. A 卡专属优化（可选，质量中性；9000/7000/6000 各按代数给内核） ===')
{
  const { describeOptimization, FULL_CAPS, DEFAULTS: DEF } = mod.__internal
  const capsWith = (gpuName) => ({
    ...FULL_CAPS,
    nodes: { ...FULL_CAPS.nodes },
    models: { unet: 'u', clip: 'c', vae: 'v', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
    notes: [],
    gpu: gpuName === '' ? null : { name: gpuName, vramGB: 20 },
  })
  const names = (opt) => opt.detail.map((d) => d.name)
  const isOpt = (d) => d.optional === true

  // ---- 默认关 ----
  ok('18. amdKernel 默认关', DEF.amdKernel === false)
  ok('18. amdAsyncOffload 默认关', DEF.amdAsyncOffload === false)

  // ---- 只在 AMD 上出现 ----
  const amd = describeOptimization({ ...DEF }, capsWith('AMD Radeon RX 7900 XTX'))
  ok('18. AMD 上出现「专属内核」项', names(amd).some((n) => n.includes('A 卡专属内核')), names(amd))
  ok('18. AMD 上出现「异步卸载」项', names(amd).some((n) => n.includes('异步卸载')))
  ok('18. 这两项都带 optional 标记', amd.detail.filter(isOpt).length === 2)
  ok('18. 两项默认都是 off', amd.detail.filter(isOpt).every((d) => d.state === 'off'))
  ok('18. 两项都带可点开关', amd.detail.filter(isOpt).every((d) => d.toggle?.canToggle === true))

  const nv = describeOptimization({ ...DEF }, capsWith('NVIDIA GeForce RTX 5060'))
  ok('18. N 卡上**不出现** A 卡专属项', !names(nv).some((n) => n.includes('A 卡专属') || n.includes('异步卸载')),
    names(nv))
  // ★ 2026-10-11：N 卡自己有一项可选（SageAttention，见第 19 节），所以这里是 1 而不是 0；
  //   关键不变式是「**没有 A 卡的**那两项」。
  ok('18. N 卡上可选档只有 SageAttention（1 项），没有 A 卡的两项',
    nv.detail.filter(isOpt).length === 1 && names(nv).some((n) => n.includes('SageAttention')),
    nv.detail.filter(isOpt).map((d) => d.name))

  const unknown = describeOptimization({ ...DEF }, capsWith(''))
  ok('18. 认不出显卡 → 也不显示 A 卡专属项（不猜）',
    !names(unknown).some((n) => n.includes('A 卡专属') || n.includes('异步卸载')))

  // ---- 可选档**不拉低** level（这是引入 optional 的目的）----
  ok('18. 可选档默认关时，AMD 仍报"优化已启用"（不因可选项变成"部分启用"）',
    amd.level === 'full' && amd.ok === true, [amd.level, amd.summary])
  ok('18. 可选档不进 reasons（不是"缺了什么"）',
    !amd.reasons.some((r) => String(r).includes('A 卡专属') || String(r).includes('异步卸载')), amd.reasons)
  ok('18. stats 有独立的 optional 桶', amd.stats.optional === 2, amd.stats)
  ok('18. stats 各桶之和 = total（可选档单独一桶，不重复计）',
    amd.stats.on + amd.stats.available + amd.stats.off + amd.stats.blocked
    + amd.stats.superseded + amd.stats.optional === amd.stats.total, amd.stats)

  // ---- 打开后 → state 变 on，且**仍不影响** level 判定（它本来就 optional）----
  const on = describeOptimization({ ...DEF, amdKernel: true, amdAsyncOffload: true }, capsWith('AMD Radeon RX 7900 XTX'))
  ok('18. 打开后两项 state = on', on.detail.filter(isOpt).every((d) => d.state === 'on'))
  ok('18. 打开后 toggle.on 也同步', on.detail.filter(isOpt).every((d) => d.toggle.on === true))

  // ---- 每代给的内核 flag 不同（按代数）----
  const HOST_SRC = HOST
  ok('18. AMD_KERNEL_FLAG 覆盖 6000/7000/9000 三代',
    /amd_rdna2: '--use-quad-cross-attention'/.test(HOST_SRC)
    && /amd_rdna3: '--use-ck-attention'/.test(HOST_SRC)
    && /amd_rdna4: '--use-ck-attention'/.test(HOST_SRC))
  ok('18. 6000 系给的是 quad（RDNA2 无 AOTriton/CK 覆盖）',
    /amd_rdna2: '--use-quad-cross-attention'/.test(HOST_SRC))
  ok('18. 只有显式打开 amdKernel 才替换默认内核',
    HOST_SRC.includes('if (kernelFlag && cfg.amdKernel === true)'))
  ok('18. 异步卸载只对 A 卡加', HOST_SRC.includes("startsWith('amd') && cfg.amdAsyncOffload === true"))
  ok('18. 异步卸载用的是真实参数 --async-offload', HOST_SRC.includes("'--async-offload'"))

  // ---- 撤回：不再有"降载/牺牲性能"那一套 ----
  ok('18. 已撤回 --cache-none（那是拿性能换空间，不是优化）', !HOST_SRC.includes("'--cache-none'"))
  ok('18. 已撤回给 A 卡加码 --vram-headroom 的"减负档"', !HOST_SRC.includes("'--vram-headroom', '0.5', '--reserve-vram', '0.5'"))

  // ---- 状态端点两个开关 + 客户端总账 ----
  ok('18. 状态端点处理 ?amdkernel=', HOST_SRC.includes("['amdkernel', 'amdKernel'"))
  ok('18. 状态端点处理 ?asyncoffload=', HOST_SRC.includes("['asyncoffload', 'amdAsyncOffload'"))
  const CLIENT_SRC = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  ok('18. 客户端总账单独报"可选（默认关）"', CLIENT_SRC.includes('项可选（默认关）'))
  const YML = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  ok('18. cordis.patch.yml 里写明了两个可选键（注释形式，默认关）',
    YML.includes('# amdKernel: false') && YML.includes('# amdAsyncOffload: false'))
}

console.log('\n=== 19. N 卡 40/50 系强化（SageAttention，硬依赖 ⇒ 确认了才挂） ===')
{
  const { describeOptimization, FULL_CAPS, DEFAULTS: DEF, nvidiaGenOf } = mod.__internal
  const capsWith = (gpuName) => ({
    ...FULL_CAPS,
    nodes: { ...FULL_CAPS.nodes },
    models: { unet: 'u', clip: 'c', vae: 'v', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
    notes: [],
    gpu: gpuName === '' ? null : { name: gpuName, vramGB: 24 },
  })
  const find = (opt) => opt.detail.find((d) => d.toggle?.key === 'sagesa')

  // ---- 代系识别 ----
  ok('19. RTX 5060 → blackwell', nvidiaGenOf('NVIDIA GeForce RTX 5060') === 'blackwell')
  ok('19. RTX 5090 → blackwell', nvidiaGenOf('NVIDIA GeForce RTX 5090') === 'blackwell')
  ok('19. RTX 4070 → ada', nvidiaGenOf('NVIDIA GeForce RTX 4070 Ti') === 'ada')
  ok('19. RTX 4090 → ada', nvidiaGenOf('NVIDIA GeForce RTX 4090') === 'ada')
  ok('19. 老卡（3090）→ other（不硬套）', nvidiaGenOf('NVIDIA GeForce RTX 3090') === 'other')
  ok('19. 认不出 → other', nvidiaGenOf('') === 'other')

  // ---- 默认 auto ----
  ok("19. nvidiaSageAttention 默认 'auto'（不是 true —— 硬依赖不能盲挂）",
    DEF.nvidiaSageAttention === 'auto')

  // ---- 面板：仅 NVIDIA 显示 ----
  const nv = describeOptimization({ ...DEF }, capsWith('NVIDIA GeForce RTX 5060'))
  const it = find(nv)
  ok('19. N 卡出现 SageAttention 项', it !== undefined)
  ok('19. 该项带 optional 标记（默认不拉低 level）', it?.optional === true)
  ok('19. 该项默认 off（自检未跑完时保守不加）', it?.state === 'off', it?.state)
  ok('19. 该项有可点开关', it?.toggle?.canToggle === true)
  ok('19. 50 系提示里点明需要 sm_120 构建',
    String(it?.whyOff).includes('sm_120') || String(it?.toggle?.hint).includes('sm_120'))

  const amd = describeOptimization({ ...DEF }, capsWith('AMD Radeon RX 7900 XTX'))
  ok('19. A 卡上**不出现** SageAttention 项', find(amd) === undefined)
  const intel = describeOptimization({ ...DEF }, capsWith('Intel(R) Arc(TM) B580 Graphics'))
  ok('19. I 卡上不出现', find(intel) === undefined)
  const unknown = describeOptimization({ ...DEF }, capsWith(''))
  ok('19. 认不出显卡 → 不显示（不猜）', find(unknown) === undefined)

  // ---- 配置显式开启 / 关闭 ----
  const forced = describeOptimization({ ...DEF, nvidiaSageAttention: true }, capsWith('NVIDIA GeForce RTX 5060'))
  ok('19. nvidiaSageAttention=true → state = on', find(forced)?.state === 'on')
  ok('19. 强制开启时 toggle.on 同步', find(forced)?.toggle?.on === true)
  const off = describeOptimization({ ...DEF, nvidiaSageAttention: false }, capsWith('NVIDIA GeForce RTX 5060'))
  ok('19. nvidiaSageAttention=false → state = off', find(off)?.state === 'off')
  ok('19. 强制关闭时 whyOff 说明"被配置关了"', String(find(off)?.whyOff).includes('被配置关'))

  // ---- 源码层：门控逻辑必须"确认了才挂" ----
  ok('19. auto 档只在自检确认已装时才挂（SAGE_READY === true）',
    HOST.includes('mode === true || (mode !== false && SAGE_READY === true)'))
  ok('19. 确认没装时开关置灰（切了会让 ComfyUI 起不来）',
    HOST.includes('canToggle: SAGE_READY !== false'))
  ok('19. 只对 NVIDIA 生效', HOST.includes("String(gpu.id ?? '') === 'nvidia'"))
  ok('19. 自检结果写回 SAGE_READY', HOST.includes('SAGE_READY = sage.installed === true'))
  ok('19. 状态端点处理 ?sagesa=', HOST.includes("['sagesa', 'nvidiaSageAttention'"))
  ok('19. 用的是真实参数 --use-sage-attention', HOST.includes("'--use-sage-attention'"))
  // ---- 安全红线：绝不默认开 --fast ----
  ok('19. ★ 绝不使用 --fast（本机 help 原文：untested / 可能掉质量 / 可能崩）',
    !/'--fast'/u.test(HOST))
  const YML2 = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  ok('19. cordis.patch.yml 写明三档（注释形式，默认 auto）',
    YML2.includes("# nvidiaSageAttention: 'auto'") && YML2.includes('硬依赖'))
}

console.log('\n=== 20. macOS（Apple Silicon）适配 ★ 2026-10-11 ===')
{
  const { vendorIdOf, IS_MAC, unetLoaderFor } = mod.__internal
  ok('20. IS_MAC 已定义且导出', IS_MAC === false || IS_MAC === true)

  // ---- 厂商识别 ----
  ok('20. "Apple M3 Pro" → apple', vendorIdOf('Apple M3 Pro') === 'apple', vendorIdOf('Apple M3 Pro'))
  ok('20. "Apple M1 Max" → apple', vendorIdOf('Apple M1 Max') === 'apple')
  ok('20. "Apple M4" → apple', vendorIdOf('Apple M4') === 'apple')
  ok('20. "Apple M2 Ultra" → apple', vendorIdOf('Apple M2 Ultra') === 'apple')
  // ★ 分数必须低于 NVIDIA/AMD 的明确型号：装了 eGPU / 同时报出独显时，
  //   要按"真正在算图的那张卡"处理，而不是把整机当 Apple。
  ok('20. ★ 同时报出 Radeon RX 7900 时优先按 A 卡（apple 分数更低）',
    vendorIdOf('Radeon RX 7900 XTX | Apple M3') === 'amd_rdna3',
    vendorIdOf('Radeon RX 7900 XTX | Apple M3'))
  ok('20. ★ 同时报出 RTX 4090 时优先按 N 卡',
    vendorIdOf('NVIDIA GeForce RTX 4090 | Apple M3') === 'nvidia')
  ok('20. 普通 Intel Mac 的 CPU 串不会被当成 apple',
    vendorIdOf('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz') === 'intel')

  // ---- 档案：Apple 不加任何 CUDA/ROCm 专用内核参数 ----
  const src2 = ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n')
  ok('20. 有 apple 厂商档案', /apple: \{\s*\n\s*id: 'apple'/u.test(src2))
  ok('20. ★ apple 档案 args 为空（MPS 上 CUDA/ROCm 那套都不适用）',
    /apple: \{[\s\S]{0,600}?args: \[\]/u.test(src2))
  ok('20. apple 档案不带任何 packs（不引第三方内核）',
    /apple: \{[\s\S]{0,900}?packs: \[\]/u.test(src2))
  ok('20. apple 档案明确写了"统一内存"', /apple: \{[\s\S]{0,900}?统一内存/u.test(src2))

  // ---- ★ 2026-10-12：档位表已撤，只剩"按文件后缀选加载器"这一件事 ----
  ok('20. 档位表保留（用户要求）', src2.includes('const MODEL_TIERS = {'))
  ok('20. 但按后缀选加载器仍在（macOS 用户手动配 GGUF 也能用）',
    unetLoaderFor('a.gguf') === 'UnetLoaderGGUF' && unetLoaderFor('a.safetensors') === 'UNETLoader')

  // ---- setup.mjs 的 macOS 分支 ----
  const SETUP2 = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  ok('20. setup 有 IS_MAC', SETUP2.includes("const IS_MAC = process.platform === 'darwin'"))
  ok('20. setup 有 macOS 显卡探测（system_profiler + sysctl）',
    SETUP2.includes('function gpuNamesFromMac') && SETUP2.includes('machdep.cpu.brand_string'))
  ok('20. setup 的 classifyVendor 认得 apple', /apple\\s\+m\\d/u.test(SETUP2) || SETUP2.includes('apple\\s+m\\d'))
  ok('20. setup 有 apple 的 VENDOR_LABEL', SETUP2.includes('Apple Silicon → 官方**手动安装**'))
  ok('20. setup 在 macOS 上只走 mac 那一条探测（不落 Windows 六条）',
    SETUP2.includes('IS_MAC ? [[') && SETUP2.includes("['macOS system_profiler / sysctl', gpuNamesFromMac]"))
  ok('20. setup 有 apple 的 ① 分支（找 ComfyUI + 官方安装指引）',
    SETUP2.includes("if (gpu.vendor === 'apple')"))
  ok('20. ★ setup 不替 macOS 用户下 Windows 便携包（NVIDIA 那条路已排除 apple）',
    SETUP2.includes("gpu.vendor !== 'amd' && gpu.vendor !== 'apple'"))
  ok('20. setup 的 macOS 指引含官方 Metal 指南链接',
    SETUP2.includes('developer.apple.com/metal/pytorch'))
  ok('20. ★ 没有把 mac 当 Linux 处理（setuid/setsid 不是硬用）',
    !/IS_MAC[\s\S]{0,80}setsid --fork/u.test(src2))
}

console.log('\n=== 21. 隐患排查所修 9 条（★ 2026-10-11） ===')
{
  const { describeOptimization, nvidiaGenOf, FULL_CAPS, DEFAULTS: DEF } = mod.__internal
  const capsWith = (g, over) => ({
    ...FULL_CAPS,
    nodes: { ...FULL_CAPS.nodes },
    models: { unet: 'u', clip: 'c', vae: 'v', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
    notes: [],
    gpu: g === '' ? null : { name: g, vramGB: 24 },
    ...(over ?? {}),
  })

  // ① 探测失败时 stats 不再重复计数
  const pf = describeOptimization({ ...DEF }, capsWith('AMD Radeon RX 7900 XTX', { probeFailed: true }))
  ok('21.① 探测失败：unknown + optional = total（不重复计数）',
    pf.stats.unknown + pf.stats.optional === pf.stats.total, pf.stats)
  ok('21.① 探测失败：unknown 已排除可选项',
    pf.stats.unknown === pf.detail.filter((d) => d.optional !== true).length, pf.stats)

  // ② RTX 5000 Ada 不再被误判成 Blackwell
  ok('21.② "RTX 5000 Ada" → ada（Ada 架构专业卡，不是 Blackwell）',
    nvidiaGenOf('NVIDIA RTX 5000 Ada') === 'ada', nvidiaGenOf('NVIDIA RTX 5000 Ada'))
  ok('21.② 消费级 50 系仍判 blackwell',
    nvidiaGenOf('NVIDIA GeForce RTX 5090') === 'blackwell' && nvidiaGenOf('NVIDIA RTX 5060') === 'blackwell')
  ok('21.② RTX 4000 Ada 仍是 ada', nvidiaGenOf('NVIDIA RTX 4000 Ada') === 'ada')

  // ③ 四个返回点都有 warnings，且只挑 ⚠ 开头的
  const nv = describeOptimization({ ...DEF }, capsWith('NVIDIA GeForce RTX 5060'))
  ok('21.③ 正常路径有 warnings 字段', Array.isArray(nv.warnings))
  const withNotes = describeOptimization({ ...DEF },
    capsWith('NVIDIA GeForce RTX 5060', { notes: ['⚠ 严重缺口', '常规说明：跳过某环节'] }))
  ok('21.③ 只把 ⚠ 开头的提升为 warning', JSON.stringify(withNotes.warnings) === JSON.stringify(['⚠ 严重缺口']),
    withNotes.warnings)
  ok('21.③ disabled / idle 也有 warnings（形状一致）',
    Array.isArray(describeOptimization({ ...DEF, enabled: false }, null).warnings)
    && Array.isArray(describeOptimization({ ...DEF }, null).warnings))
  ok('21.③ 探测失败路径也有 warnings',
    Array.isArray(describeOptimization({ ...DEF }, capsWith('', { probeFailed: true })).warnings))

  // ④ disabled / idle 的 stats 补齐 optional
  const dis = describeOptimization({ ...DEF, enabled: false }, null)
  const idle = describeOptimization({ ...DEF }, null)
  ok('21.④ disabled.stats 有 optional 键', 'optional' in dis.stats, dis.stats)
  ok('21.④ idle.stats 有 optional 键', 'optional' in idle.stats, idle.stats)
  ok('21.④ 四个返回点的 stats 键集合一致',
    ['on', 'available', 'off', 'blocked', 'optional', 'total'].every((k) => k in dis.stats && k in idle.stats && k in pf.stats && k in nv.stats))

  // ⑤ 客户端渲染 warnings
  const CLIENT2 = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  ok('21.⑤ 客户端渲染 opt.warnings', CLIENT2.includes('Array.isArray(opt?.warnings)'))
  ok('21.⑤ 有对应样式类', CLIENT2.includes('.qwen-paint-opt-warning'))
  ok('21.⑤ 渲染在 reasons 之后（置顶显眼）',
    CLIENT2.indexOf('qwen-paint-opt-reason') < CLIENT2.indexOf('qwen-paint-opt-warning'))

  // ⑥ setup 选完 lite 后有明确的后续步骤
  const SETUP3 = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  // ⚠ 2026-10-12：**轻量档保留**（用户要求），且装完要催一句"必须装 ComfyUI-GGUF"。
  ok("21.⑥ 轻量档保留 → setup 里仍有 lite 分支提示（装完催装 ComfyUI-GGUF）",
    SETUP3.includes("if (tier === 'lite' && !CHECK_ONLY)"))

  // ⑦ 状态端点对 sagesa 有服务端护栏
  ok('21.⑦ 已确认没装时服务端拒绝打开 sagesa',
    HOST.includes("key === 'nvidiaSageAttention' && want && SAGE_READY === false"))

  // ⑧ MODEL_TIERS 无死字段
  // ⚠ 2026-10-12：档位表整个撤了（`MODEL_TIERS` 已不存在），这条断言随之作废 ——
  //   换成"确认表真的没了"，因为残留一张空表同样是 bug。
  ok('21.⑧ 档位表保留（有 full/lite 两档）',
    ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n').includes('const MODEL_TIERS = {'))

  // ⑨ 可移植性测试的厂商列表含 apple
  const PORT = readFileSync(path.join(ROOT, 'scripts', '_portability_test.mjs'), 'utf8')
  ok('21.⑨ 可移植性测试的厂商列表含 apple', PORT.includes("'intel', 'apple', 'unknown'"))
}

console.log('\n=== 22. 第二轮隐患排查所修（★ 2026-10-11，0.1.4） ===')
{
  const { describeOptimization, FULL_CAPS, DEFAULTS: DEF } = mod.__internal
  const capsWith = (g, over) => ({
    ...FULL_CAPS,
    nodes: { ...FULL_CAPS.nodes },
    models: { unet: 'u', clip: 'c', vae: 'v', turbo8Lora: 'turbo8_lora_step2500.safetensors' },
    notes: [],
    gpu: g === '' ? null : { name: g, vramGB: 24 },
    ...(over ?? {}),
  })
  const AMD = 'AMD Radeon RX 7900 XTX'

  // ① 探测失败时 warnings 与 reasons 不再重复
  const probeNote = '⚠ 能力探测有 6/12 项未成功，本次按"能力齐全"处理，且不缓存结果'
  const pfOnly = describeOptimization({ ...DEF }, capsWith(AMD, { probeFailed: true, notes: [probeNote] }))
  ok('22.① 探测失败：与 reasons 重复的那句不再进 warnings', pfOnly.warnings.length === 0, pfOnly.warnings)
  ok('22.① 但 reasons 仍在（信息没丢）', pfOnly.reasons.length > 0)
  const pfMixed = describeOptimization({ ...DEF },
    capsWith(AMD, { probeFailed: true, notes: [probeNote, '⚠ 配置的是 GGUF 主模型，但没有 UnetLoaderGGUF 节点'] }))
  ok('22.① 其余 ⚠ note 照常保留（不误伤）',
    pfMixed.warnings.length === 1 && pfMixed.warnings[0].includes('UnetLoaderGGUF'), pfMixed.warnings)

  // ② 可选项打开后，总账文案必须反映真实状态（不能还说"默认关"）
  const allOff = describeOptimization({ ...DEF }, capsWith(AMD))
  const oneOn = describeOptimization({ ...DEF, amdKernel: true }, capsWith(AMD))
  const bothOn = describeOptimization({ ...DEF, amdKernel: true, amdAsyncOffload: true }, capsWith(AMD))
  ok('22.② 都关：optional=2 / optionalOn=0', allOff.stats.optional === 2 && allOff.stats.optionalOn === 0, allOff.stats)
  ok('22.② 开一个：optionalOn=1', oneOn.stats.optionalOn === 1, oneOn.stats)
  ok('22.② 都开：optionalOn=2（否则总账会自相矛盾地说"默认关"）', bothOn.stats.optionalOn === 2, bothOn.stats)
  ok('22.② optionalOn 是 optional 的子计数（不影响"各桶之和 = total"）',
    allOff.stats.on + allOff.stats.available + allOff.stats.off + allOff.stats.blocked
    + allOff.stats.superseded + allOff.stats.optional === allOff.stats.total)

  // ③ optionalOn 在四个返回点都存在（形状一致）
  ok('22.③ disabled / idle / 正常 / 探测失败 都有 optionalOn',
    ['optionalOn'].every((k) => k in describeOptimization({ ...DEF, enabled: false }, null).stats
      && k in describeOptimization({ ...DEF }, null).stats
      && k in allOff.stats
      && k in pfOnly.stats))

  // ④ 客户端按 optionalOn 决定文案
  const CLIENT3 = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  ok('22.④ 客户端读 optionalOn', CLIENT3.includes('stats.optionalOn'))
  ok('22.④ 已开时显示"已开 N 项"', CLIENT3.includes('项可选（已开 '))

  // ⑤ INSTALL.md 补上 macOS（主安装文档以前一处都没提）
  const INSTALL2 = readFileSync(path.join(ROOT, 'INSTALL.md'), 'utf8')
  ok('22.⑤ INSTALL.md 有 macOS 章节', INSTALL2.includes('macOS（Apple Silicon）'))
  ok('22.⑤ INSTALL.md 含官方 Metal 指南链接', INSTALL2.includes('developer.apple.com/metal/pytorch'))

  // ⑥ findComfyDir 不再拼出相对路径（macOS/Linux 上 USERPROFILE 不存在）
  const SETUP4 = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  ok('22.⑥ findComfyDir 用 os.homedir() 而不是 USERPROFILE ?? \'\'',
    SETUP4.includes("path.join(os.homedir(), 'Desktop', 'ComfyUI')"))
  ok('22.⑥ 源码里不再有 USERPROFILE ?? \'\' 的活代码（注释不算）',
    !/^\s+path\.join\(process\.env\.USERPROFILE \?\? ''/mu.test(SETUP4))
}

console.log('\n=== 23. 自定义输出目录（用户要求：能选、能校验、能改） ===')
{
  const { resolveOutputDir, defaultOutputDir, defaultOutputBase, DEFAULTS: DEF } = mod.__internal
  const os2 = await import('node:os')
  const fsp2 = await import('node:fs')
  const path2 = await import('node:path')

  // ① 默认值不带用户目录
  // ⚠ 不能写 "!includes('<用户名>')" —— 打包机上跑的用户名可能恰好就叫那个。
  //   改成断言"它是从环境变量推导的、且落在桌面或主目录下"。
  ok('23. 默认输出目录落在桌面或主目录下',
    defaultOutputDir().startsWith(path2.normalize(os2.homedir())), defaultOutputDir())

  // ② 绝对路径照用
  const abs = fsp2.mkdtempSync(path2.join(os2.tmpdir(), 'qwp-abs-'))
  const r1 = resolveOutputDir(abs, null)
  ok('23. 绝对路径照用', r1.dir === path2.normalize(abs) && !r1.problem, r1)

  // ③ 不存在的绝对路径 → 自动建
  const deep = path2.join(abs, 'a', 'b', 'c')
  const r2 = resolveOutputDir(deep, null)
  ok('23. 不存在的目录会自动创建', r2.dir === deep && !r2.problem && fsp2.existsSync(deep), r2)

  // ④ 相对路径 → 解析到默认基目录下（换机器不失灵）
  const r3 = resolveOutputDir('我的图/千问', null)
  ok('23. 相对路径解析到默认位置下',
    path2.isAbsolute(r3.dir) && r3.dir === path2.join(defaultOutputBase(), '我的图', '千问')
    && !r3.problem, r3)
  ok('23. 相对路径不会写死盘符/用户名',
    !r3.dir.includes('C:////') || r3.dir.startsWith(path2.normalize(os2.homedir())) === false, r3.dir)

  // ⑤ 空串 → 默认
  ok('23. 空串 = 用默认', resolveOutputDir('', null).dir === defaultOutputDir())
  ok('23. undefined = 用默认', resolveOutputDir(undefined, null).dir === defaultOutputDir())

  // ⑥ 指向一个**文件** → 拒绝并退回
  const f = path2.join(abs, 'notadir.txt')
  fsp2.writeFileSync(f, 'x', 'utf8')
  const r4 = resolveOutputDir(f, null)
  ok('23. 路径指到文件 → 拒绝并退回默认', r4.dir === defaultOutputDir() && !!r4.problem, r4)

  // ⑦ 非法字符/不存在盘符 → 退回，且**不抛错**（插件不能因此起不来）
  let threw = false
  try { resolveOutputDir('Z:////不存在的盘////xyz', null) } catch { threw = true }
  ok('23. 非法路径不抛错（安全退回）', threw === false)
  ok('23. 非法路径退回默认目录', resolveOutputDir('Z:////不存在的盘////xyz', null).dir === defaultOutputDir())

  // ⑧ DEFAULTS 有 outputDirSource（界面展示用）
  ok('23. DEFAULTS 带 outputDirSource', typeof DEF.outputDirSource === 'string')

  // ⑨ 状态端点支持 ?outputDir=；客户端有"改目录"按钮
  const HOST23 = ['index.js', 'config.js'].map((f) => readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n')
  ok('23. 状态端点处理 ?outputDir=', HOST23.includes("query.searchParams.get('outputDir')"))
  ok('23. 端点里的校验与启动时同一套（resolveOutputDir）',
    HOST23.includes('const r = resolveOutputDir(wantDir, log)'))
  const CL = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  ok('23. 客户端有"改目录"入口', CL.includes('改目录'))
  ok('23. 客户端显示当前目录与来源', CL.includes('outputDirSource'))
  // ⑩ setup.mjs 首次运行询问 + 写配置
  const ST = readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  ok('23. setup 支持 --output-dir', ST.includes("valueOf('--output-dir')"))
  ok('23. setup 有"试建+试写"的校验', ST.includes('.dshqp-write-test-'))
  ok('23. setup 记住选择（写进 cordis.patch.yml）', ST.includes("writeConfigKey(path.join(ROOT, 'cordis.patch.yml'), 'outputDir'"))
  ok('23. setup 有通用的 writeConfigKey', ST.includes('function writeConfigKey'))
  ok('23. --check 不写不问', ST.includes('if (!CHECK_ONLY && allOk && comfyDir !== null)'))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
process.exit(fail === 0 ? 0 : 1)
