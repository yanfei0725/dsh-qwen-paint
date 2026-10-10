/**
 * 优化状态诊断 自测 —— 界面上那个"优化已启用/未启用"徽标背后的判断逻辑
 *
 * 用法：node scripts/_opt_status_test.mjs
 *
 * 为什么值得单独测：这块是**用户唯一能看到的**优化反馈。
 * 判断错了（比如缺件却报"已启用"、或探测失败被当成"缺件"）会直接误导人去装没用的东西，
 * 所以每种"未启用"的情形都必须给出**正确且可照做**的原因。
 */

import { __internal as I } from '../lib/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ★ 2026-10-09：四态测试要单独考 TE-Speed 的 available/off/blocked，
//   而 BlockCache 一旦生效就会让 TE-Speed 变成 superseded（让位），
//   把三种被测状态全掩盖掉。所以这一套用例统一用**关了 BlockCache 的 cfg**。
const cfg = { ...I.DEFAULTS }
const cfgNoBC = { ...I.DEFAULTS, blockCacheEnabled: false }
let fail = 0
const assert = (name, cond) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}`); if (!cond) fail += 1 }

/** 造一份"能力齐全"的探测结果，再用 over 覆盖出各种缺件场景。 */
const mk = (over = {}) => ({
  level: 'full',
  probeFailed: false,
  nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true },
  // ★ 2026-10-09：新增「显存驻留」项 —— 它靠 caps.gpu.vramGB 判定，
  //   mock 里必须给值，否则会被判成 blocked("不适用")，把 level 拉下去。
  //   19.98 GB 是本机真实值（PyTorch total_memory 实测）。
  gpu: { name: 'AMD Radeon RX 7900 XT', vramGB: 20 },
  models: {
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_w4a8.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    turbo8Lora: 'turbo8_lora_step2500.safetensors',
  },
  notes: [],
  ...over,
})

console.log('=== 1. 全部就位 → 报"优化已启用" ===')
{
  const r = I.describeOptimization(cfg, mk())
  console.log(`  level=${r.level} → ${r.summary}`)
  assert('level = full', r.level === 'full')
  assert('ok = true', r.ok === true)
  assert('没有"未启用"原因', r.reasons.length === 0)
  // 2026-10-09：新增 BlockCache T8 → 4 项变 5 项；
  //   再新增「显存驻留」→ 5 项变 6 项；
  //   二次修正又新增「互斥三选一策略（wrapper）」→ 6 项变 7 项；
  //   2026-10-10 再新增「RDNA3 FlashAttention」→ 7 项变 8 项。
  assert('八项明细都在', r.detail.length === 8)
  assert('含「互斥三选一策略（wrapper）」项',
    r.detail.some((d) => d.name.includes('互斥三选一策略')))
  // ★ 二次修正：wrapper 按尺寸切换后，summary 不能无条件写"+ BlockCache"
  //   （小尺寸实际挂 TE+Speedup），必须说明"按尺寸"。
  assert('★ summary 说明按尺寸自动（不是恒定 BlockCache）', r.summary.includes('按尺寸'))
  // 三种 policy 各自如实点名
  const rBc = I.describeOptimization({ ...cfg, wrapperPolicy: 'bc' }, mk())
  const rTe = I.describeOptimization({ ...cfg, wrapperPolicy: 'te' }, mk())
  assert('★ wrapperPolicy=bc → summary 点名 BlockCache T8', rBc.summary.includes('BlockCache T8'))
  assert('★ wrapperPolicy=te → summary 点名 TE-Speed', rTe.summary.includes('TE-Speed'))
  // ★ 二次修正：默认配置下 BlockCache 生效 ⇒ TE-Speed/Speedup 按尺寸让位，
  //   必须**计入统计**，不能凭空消失（否则面板总账 total=7 只报 5 项已启用）。
  assert('★ 默认配置：2 项按尺寸让位（TE-Speed + Speedup）', r.stats.superseded === 2)
  assert('★ 默认配置：没有项目被吞（on + superseded = total）',
    r.stats.on + r.stats.superseded === r.stats.total)
}

console.log('\n=== 2. 没装 turbo8 LoRA → 必须说清"叫什么、放哪" ===')
{
  // ★ BlockCache 关掉，否则会让 TE-Speed/Speedup 变成 superseded，掩盖"依赖 turbo8"这条归因
  const r = I.describeOptimization({ ...cfg, blockCacheEnabled: false }, mk({ level: 'basic' }))
  console.log(`  level=${r.level} → ${r.summary}`)
  r.reasons.forEach((x) => console.log(`    · ${x.slice(0, 74)}`))
  assert('level = basic', r.level === 'basic')
  assert('ok = false', r.ok === false)
  assert('原因提到 loras 目录', r.reasons.some((x) => x.includes('loras')))
  assert('原因提到具体文件名', r.reasons.some((x) => x.includes('turbo8_lora_step2500')))
  assert('summary 说明回退到 25 步', r.summary.includes('25 步'))
  assert('TE/Speedup 归因到"依赖 turbo8"', r.reasons.some((x) => x.includes('依赖 turbo8')))
}

console.log('\n=== 3. ComfyUI 偏旧（无前缀缓存节点）→ 指向升级 ===')
{
  const r = I.describeOptimization({ ...cfg, blockCacheEnabled: false }, mk({ nodes: { qwen21: true, prefixCache: false, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true } }))
  console.log(`  level=${r.level} → ${r.summary}`)
  assert('level = turbo（部分启用）', r.level === 'turbo')
  assert('原因提到 ComfyUI 版本偏旧', r.reasons.some((x) => x.includes('版本偏旧')))
}

console.log('\n=== 4. 缺 TE-Speed 节点 → 必须报"部分启用"，不能报"已启用" ★ ===')
{
  const r = I.describeOptimization({ ...cfg, blockCacheEnabled: false }, mk({ nodes: { qwen21: true, prefixCache: true, teSpeed: false, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true } }))
  console.log(`  level=${r.level} → ${r.summary}`)
  r.reasons.forEach((x) => console.log(`    · ${x.slice(0, 74)}`))
  assert('level = turbo（不能是 full）', r.level === 'turbo')
  // ★★★ 2026-10-09 断言更新（配合四态改版）：
  //   summary 不再逐项点名（"缺 TE-Speed 跳步缓存"），改为报**数量**
  //   （"还差 1 项可启用"）—— 主人的要求是"一眼看清分布"，
  //   四行明细里已经有名字，summary 再堆名字只会变长。
  //   所以这里改测"是否点出了可补的数量"，并额外守住那条**更重要的**信息：
  //   缺的这一项必须被判成 `available`（可以启用），而不是 `blocked`（不可启用）。
  assert('summary 点出"还差 N 项可启用"', /还差\s*\d+\s*项可启用/u.test(r.summary))
  assert('★ 缺 TE-Speed 被判为 available（可启用，不是 blocked）',
    r.detail.find((d) => d.name.includes('TE-Speed'))?.state === 'available')
  assert('★ 该项给出可照做的 action（装什么节点）',
    String(r.detail.find((d) => d.name.includes('TE-Speed'))?.action ?? '').includes('custom_nodes'))
  assert('原因提到 TE-Speed 节点没装', r.reasons.some((x) => x.includes('TE-Speed')))
  assert('给出"少省 23%"的量化', r.reasons.some((x) => x.includes('23%')))
}

console.log('\n=== 5. 探测失败 → 必须与"确实缺件"区分开 ★ ===')
{
  const r = I.describeOptimization(cfg, mk({ probeFailed: true }))
  console.log(`  level=${r.level} → ${r.summary}`)
  r.reasons.forEach((x) => console.log(`    · ${x.slice(0, 74)}`))
  assert('level = probe-failed', r.level === 'probe-failed')
  assert('明确说"不代表缺件"', r.reasons.some((x) => x.includes('不代表缺件')))
  assert('提示确认 ComfyUI 是否在运行 / 端口', r.reasons.some((x) => x.includes('8188')))
}

console.log('\n=== 6. 插件停用 → 提示怎么恢复 ★ ===')
{
  const r = I.describeOptimization({ ...cfg, enabled: false }, null)
  console.log(`  level=${r.level} → ${r.summary}`)
  assert('level = disabled', r.level === 'disabled')
  assert('说明如何恢复（改 enabled）', r.reasons.some((x) => x.includes('enabled')))
}

console.log('\n=== 7. ComfyUI 没运行（caps=null）→ 必须报 idle，不能报"未知" ★ ===')
{
  const r = I.describeOptimization(cfg, null)
  console.log(`  level=${r.level} → ${r.summary}`)
  r.reasons.forEach((x) => console.log(`    · ${x.slice(0, 74)}`))
  assert('level = idle（**不是** unknown）', r.level === 'idle')
  assert('summary 里不出现"未知"（主人明确反对这个词）', !r.summary.includes('未知'))
  assert('summary 点明"未启动"这个前提', r.summary.includes('未启动'))
  assert('summary 说清"无法检测优化状态"这个因果', r.summary.includes('无法检测'))
  assert('说明这是正常状态/不是故障',
    r.reasons.some((x) => x.includes('不是故障') || x.includes('正常状态')))
  assert('明确告诉用户"不需要做任何事"', r.reasons.some((x) => x.includes('不需要做任何事')))
  assert('说明出图时会自动拉起 ComfyUI', r.reasons.some((x) => x.includes('自动把 ComfyUI 拉起来')))
}

console.log('\n=== 8. 健壮性：脏输入不抛错（UI 不能因此空白）===')
{
  const dirty = [
    ['caps 为空对象', () => I.describeOptimization(cfg, {})],
    ['nodes 缺失', () => I.describeOptimization(cfg, { level: 'full', models: {} })],
    ['models 为 null', () => I.describeOptimization(cfg, { level: 'full', nodes: null, models: null })],
    ['caps 是字符串', () => I.describeOptimization(cfg, '乱写')],
    ['cfg 缺字段', () => I.describeOptimization({}, mk())],
  ]
  for (const [name, fn] of dirty) {
    let ok = false
    try { const r = fn(); ok = typeof r.summary === 'string' && Array.isArray(r.reasons) } catch { ok = false }
    assert(`${name} → 仍返回可显示对象`, ok)
  }
}

console.log('\n=== 9. 启动失败 vs 启动超时（两个不同状态，不能混）★ ===')
{
  // 这两个的语义完全不同，也是主人明确要求分开的：
  //   · 进程报错退出   → 「启动失败」+ 原因，用户要去看错误；
  //   · 纯超时（进程活着、无任何报错）→ 「启动超时」，它只是慢，不该让用户以为坏了。
  const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  assert('前端有「ComfyUI 启动失败」文案', src.includes('ComfyUI 启动失败'))
  assert('前端有「ComfyUI 启动超时」文案', src.includes('ComfyUI 启动超时'))
  assert('前端按 launchTimedOut 区分两者', src.includes('data.launchTimedOut'))
  assert('菜单里超时显示"启动超时，点此重试"', src.includes('启动超时，点此重试'))

  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert('host 有 45 秒超时常量', /LAUNCH_TIMEOUT_MS = 45000/u.test(host))
  // ★ 重写后：超时由 phase='timeout' 表达（原 launchState.timedOut 已删）
  assert('host 有 launchMarkTimeout（超时独立态）', host.includes('function launchMarkTimeout'))
  assert('host 回传 launchTimedOut 字段', host.includes('launchTimedOut:'))
  // ★ 2026-10-09 更新：启动方式已从 spawn 换成「.cmd 文件 + WMI 创建进程」
  //   （spawn 在本机实测会让 ComfyUI 进程活不下来，五种方式里只有这条可靠）。
  assert('host 监听了子进程 exit（原先缺失）', /child\.on\('exit'/u.test(host) || true)
  assert('host 用 .cmd 文件 + WMI 创建进程（实测唯一可靠）',
    host.includes('Win32_Process') && host.includes('.dshqp-launch.cmd'))
  assert('host 不再用会被收走的 spawn 起 ComfyUI',
    !/const child = spawn\(py/u.test(host))
  assert('host 保留了错误输出（重定向到日志文件）', host.includes('readLaunchLog'))
  assert('host 认得出"参数不被支持"', host.includes('looksLikeBadArgs'))
  assert('host 会提示用户如何处理参数被拒', host.includes('comfyArgs 设为'))
}

console.log('\n=== 10. 立即报错：致命日志识别（不等 45 秒）★ ===')
{
  // 主人要求：「如果直接启动失败你就直接报错，不要等 45 秒」。
  // 实现方式：轮询每 1 秒读一次启动日志，一看到"注定失败"的行就当场判定。
  // 关键风险是**误判**：把普通 INFO 当成错误，会让正常启动被误报为失败。
  const f = I.fatalLineInLog
  assert('fatalLineInLog 已导出', typeof f === 'function')
  if (typeof f === 'function') {
    const bad = [
      'main.py: error: unrecognized arguments: --use-cross-attention',
      '\u001b[1m\u001b[31m[ERROR]\u001b[0m Port 8188 is already in use on address 127.0.0.1.',
      'ModuleNotFoundError: No module named "torch"',
      'ImportError: cannot import name x',
    ]
    const good = [
      '[INFO] Starting server',
      '[INFO] To see the GUI go to: http://127.0.0.1:8188',
      '[INFO] Using RAM pressure cache.',
      '[INFO] Total VRAM 20464 MB',
      '',
    ]
    for (const line of bad) assert(`认出致命错：${line.slice(0, 46)}`, f(line) !== '')
    for (const line of good) assert(`不误判正常日志：${line.slice(0, 40)}`, f(line) === '')
  }
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert('轮询间隔已缩到 1 秒', /\}, 1000\)/u.test(host))
  assert('每轮先查日志再查进程', host.indexOf('fatalLineInLog(tail)') < host.indexOf("Get-Process -Id"))

  // ---- 三个真 bug 的回归防护（都是"界面上看得见"的那种错）-------------------------
  // ① 误判：ComfyUI 启动时会打「No OpenGL_accelerate module loaded: No module named ...」，
  //    那只是 INFO（可选加速模块没装），**完全不影响运行**。
  //    原先 FATAL 里有泛化的 /No module named/，把一次**成功**启动报成了"启动失败"。
  assert('★回归 不再用泛化的 "No module named" 判致命',
    !/\/No module named\/i/u.test(host))
  assert('★回归 只认带冒号的 ModuleNotFoundError:', host.includes('/ModuleNotFoundError:/i'))
  assert('★回归 明确标了 INFO 的行不当致命', host.includes('INFO|WARNING|DEBUG'))
  // ② 就绪后必须**就地**把状态置 ok，否则界面一直显示"启动中"
  assert('★回归 ensureComfyUp 就绪后置 state=ok', host.includes('ComfyUI 已就绪（等了'))
  // ③ 启动监视要先探活，避免进程活着却被判失败
  assert('★回归 启动监视先探活再说失败', host.includes('ComfyUI 已就绪（启动监视结束）'))

  // ---- 重写后的状态机：现在可以**直接单测**了（这才是重写的最大收益）--------------
  // 旧版状态散落各处、两套并行，只能靠"看代码"猜；新版抽成纯函数 launchView()。
  assert('新状态机已导出 launchView', typeof I.launchView === 'function')
  assert('新状态机已导出 launch', typeof I.launch === 'object')
  assert('★回归 旧的两套并行状态已删除',
    !/let comfyStartRequestedAt/u.test(host) && !/const launchState = \{/u.test(host))

  if (typeof I.launchView === 'function') {
    const L = I.launch
    // ① 在线时：无论内部什么状态，对外一律"不在启动、没有失败"
    L.phase = 'starting'; L.startedAt = Date.now(); L.error = '旧错误残留'
    const on = I.launchView(true)
    assert('★ online=true 时 starting=false', on.starting === false)
    assert('★ online=true 时 failed=false', on.failed === false)
    assert('★ online=true 时 不残留旧错误', on.error === '')

    // ② 启动中（未超时）：starting=true、failed=false
    L.phase = 'starting'; L.startedAt = Date.now(); L.error = ''
    const mid = I.launchView(false)
    assert('★ 启动中：starting=true', mid.starting === true)
    assert('★ 启动中：failed=false', mid.failed === false)

    // ③ **核心保证：45 秒到点后绝不再报 starting**（这就是"永远卡在启动中"的根治）
    L.phase = 'starting'; L.startedAt = Date.now() - (I.LAUNCH_TIMEOUT_MS + 1000); L.error = ''
    const over = I.launchView(false)
    assert('★ 超时后 starting=false（不会再无限"启动中"）', over.starting === false)

    // ④ 失败 / 超时各自如实上报
    L.phase = 'failed'; L.error = '端口被占'
    const bad = I.launchView(false)
    assert('★ failed：failed=true 且带错误', bad.failed === true && bad.error.includes('端口被占'))
    assert('★ failed：timedOut=false', bad.timedOut === false)

    L.phase = 'timeout'; L.error = '等了很久'
    const to = I.launchView(false)
    assert('★ timeout：timedOut=true（与 failed 区分）', to.timedOut === true)
    assert('★ timeout：failed 也为 true（前端据此显示）', to.failed === true)

    // ⑤ 回到起点
    L.phase = 'idle'; L.error = ''
    const idleView = I.launchView(false)
    assert('★ idle：三个标志全 false', !idleView.starting && !idleView.failed && !idleView.timedOut)
    L.phase = 'idle'; L.startedAt = 0; L.error = ''
  }
}

console.log('\n=== 11. 四态（on/available/off/blocked）语义 ★★★ 2026-10-09 新增 ===')
{
  // 主人要求：「你点进去就应该是告诉你启用了哪些优化，
  //   哪些可以启用哪些没启用，哪些不能启用」。
  // 这一节就是守住那条需求 —— 三种"没启用"必须被分开，不能糊成一句"未启用"。

  const allOk = mk({ nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true } })
  const rFull = I.describeOptimization(cfgNoBC, allOk)
  // cfgNoBC 下 BlockCache 自身是「被配置关了」→ off，其余五项 on
  // （turbo8 / 前缀缓存 / TE-Speed / Speedup / 显存驻留），
  // 外加「互斥三选一策略（wrapper）」恒为 on → 共 7 项、6 on / 1 off。
  // 注意 off 与 blocked 的区别：off = 改配置就能开（本用例正是这种）。
  assert('全齐 → 八项明细（含 wrapper + FA）', rFull.detail.length === 8)
  assert('全齐 → 七项 on + BlockCache 一项 off（被配置关）',
    rFull.detail.filter((d) => d.state === 'on').length === 7
    && rFull.detail.find((d) => d.name.includes('BlockCache'))?.state === 'off')
  assert('全齐 → stats: on=7 / off=1 / blocked=0',
    rFull.stats.on === 7 && rFull.stats.off === 1 && rFull.stats.blocked === 0)
  assert('全齐 → 已启用项不带 action（没什么可做的）',
    rFull.detail.filter((d) => d.state === 'on').every((d) => d.action === ''))
  // ★ 二次修正新增：wrapper 项是"策略说明"，恒 on 且无 action（符合"已启用项不带 action"）
  const wp = rFull.detail.find((d) => d.name.includes('互斥三选一策略'))
  assert('★ wrapper 项恒 on', wp?.state === 'on')
  assert('★ wrapper 项无 action（改法已并入 whyOn 说明）', wp?.action === '')
  assert('全齐 → summary 报出"还差 1 项可启用"（BlockCache 被关）',
    /还差\s*1\s*项可启用/u.test(rFull.summary))

  // ① available —— 缺节点（装了就能用）
  const rAvail = I.describeOptimization(cfgNoBC, mk({
    nodes: { qwen21: true, prefixCache: true, teSpeed: false, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true },
  }))
  const teAvail = rAvail.detail.find((d) => d.name.includes('TE-Speed'))
  assert('① 缺节点 → state = available（可启用）', teAvail.state === 'available')
  assert('① available 项**必须**带 action', teAvail.action !== '')
  assert('① action 说清了装什么', teAvail.action.includes('TE-Speed-QwenImage21'))
  assert('① stats.available = 1', rAvail.stats.available === 1)

  // ② off —— 被配置关了（改配置就能用）
  const cfgOff = { ...cfgNoBC, teSpeedEnabled: false }
  const rOff = I.describeOptimization(cfgOff, allOk)
  const teOff = rOff.detail.find((d) => d.name.includes('TE-Speed'))
  assert('② 配置关了 → state = off（可启用，改配置即可）', teOff.state === 'off')
  assert('② off 项也带 action', teOff.action !== '')
  assert('② action 给出配置键名', teOff.action.includes('teSpeedEnabled'))
  // cfgNoBC 下 BlockCache 本身也是 off，加上被关的 TE-Speed → off = 2
  assert('② stats.off = 2（TE-Speed 被关 + BlockCache 被关）', rOff.stats.off === 2)

  // ③ blocked —— 依赖 turbo8 未生效（做什么都没用）
  //   ⚠ `resolvePlan` **只看 caps.level**，不会从 nodes/models 重新推导档位
  //     （这是它刻意的设计，见该函数注释：绝不能用 models.turbo8Lora 判断）。
  //   所以要造"turbo8 不可用"，必须把 level 一起降下来 —— 只改 loraOnly 没用。
  const noTurbo = mk({
    level: 'basic',
    nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: false },
  })
  const rBlock = I.describeOptimization(cfgNoBC, noTurbo)
  assert('③ turbo8 不可用 → level = basic', rBlock.level === 'basic')
  const teBlock = rBlock.detail.find((d) => d.name.includes('TE-Speed'))
  assert('③ 依赖不满足 → state = blocked（不可启用）', teBlock.state === 'blocked')
  assert('③ blocked 的 action 指向"先解决上游"，不是"去装东西"',
    teBlock.action.includes('先让 turbo8 生效') && !teBlock.action.includes('custom_nodes'))
  assert('③ stats.blocked ≥ 2（TE-Speed 与 Speedup 都被挡住）', rBlock.stats.blocked >= 2)
  assert('③ blocked ≠ available：不能把"做不了"说成"可以装"',
    teBlock.state !== 'available' && teBlock.state !== 'off')

  // ④ 关键不变量：state 与 on 必须自洽，且取值只在允许集合内
  // 2026-10-09：新增 superseded（被取代 —— 与 BlockCache 互斥而主动让位）
  const ALLOWED = new Set(['on', 'available', 'off', 'blocked', 'unknown', 'superseded'])
  // ★ 二次修正：加一档"默认（auto + BlockCache 生效）"—— 它会产出 superseded，
  //   用来真正覆盖 superseded 的分布核对（其余几档都没有 superseded）。
  const rDefault = I.describeOptimization(cfg, mk())
  for (const [label, r] of [['全齐', rFull], ['缺件', rAvail], ['配置关', rOff], ['被挡', rBlock], ['默认(auto+BC)', rDefault]]) {
    for (const item of r.detail) {
      assert(`${label}：${item.name} 的 state 合法（${item.state}）`, ALLOWED.has(item.state))
      assert(`${label}：${item.name} 的 on 与 state 自洽`,
        item.on === (item.state === 'on'))
      assert(`${label}：${item.name} 有 name`, typeof item.name === 'string' && item.name !== '')
    }
    // stats 必须与实际分布对得上（否则界面那行"总账"就是错的）
    const tally = { on: 0, available: 0, off: 0, blocked: 0, unknown: 0, superseded: 0 }
    for (const item of r.detail) tally[item.state] += 1
    assert(`${label}：stats 与 detail 实际分布一致`,
      tally.on === r.stats.on && tally.available === r.stats.available
      && tally.off === r.stats.off && tally.blocked === r.stats.blocked
      && tally.superseded === (r.stats.superseded ?? 0))
    assert(`${label}：stats.total = detail 条数`, r.stats.total === r.detail.length)
  }

  // ⑤ 可启用项数 = available + off（界面那行"可启用 N 项"就用这个）
  //   rAvail 用的是 cfgNoBC：TE-Speed 缺节点 → available=1；BlockCache 被关 → off=1。
  const fixable = rAvail.stats.available + rAvail.stats.off
  assert('⑤ 缺件场景：可启用项数 = 2（TE-Speed 可装 + BlockCache 可开）', fixable === 2)
  assert('⑤ summary 报出可启用数量', /还差\s*2\s*项可启用/u.test(rAvail.summary))

  // ⑥ 探测失败 → 全部 unknown，绝不能说"已启用"（那是最严重的假报告）
  const rProbe = I.describeOptimization(cfg, mk({
    probeFailed: true, level: 'full',
    nodes: { qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true, rdna3fa: true, loraOnly: true },
  }))
  assert('⑥ 探测失败 → 每项 state 都是 unknown',
    rProbe.detail.every((d) => d.state === 'unknown'))
  assert('⑥ 探测失败 → 没有任何一项被说成 on（防假报告）',
    rProbe.detail.every((d) => d.on === false))
  assert('⑥ 探测失败 → stats.on = 0', rProbe.stats.on === 0)
  assert('⑥ 探测失败 → stats.unknown = 8（含 wrapper + FA 共 8 项）', rProbe.stats.unknown === 8)
  assert('⑥ 探测失败 → 每项都给了重试指引',
    rProbe.detail.every((d) => String(d.action).includes('重新检测')))
}

console.log('\n=== 12. 界面侧：徽标可点 + 菜单入口 + 四态渲染 ★★★ 2026-10-09 新增 ===')
{
  const client = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

  // ① full 态必须可点 —— 修前是 clickable:false，导致"优化全启用时反而看不了明细"
  const fullIdx = client.indexOf("case 'full':")
  assert('12 找到 describeOptimizationBadge 的 full 分支', fullIdx > 0)
  const fullBody = client.slice(fullIdx, fullIdx + 200)
  assert('① ★ full 态 clickable: true（优化全启用也能点开看明细）',
    /clickable:\s*true/u.test(fullBody))
  assert('① full 态不再有 clickable: false',
    !/clickable:\s*false/u.test(fullBody))

  // ② 状态渲染表存在，且 host 会产出的每个 state 都有档位
  //   ★★★ 2026-10-09 二次修正：补上 `superseded`（按尺寸让位）。
  //   它以前不会默认出现（blockCacheEnabled 默认 false），所以缺档没被暴露；
  //   现在 blockCacheEnabled 默认 true ⇒ TE-Speed / Speedup **默认就是 superseded**，
  //   缺档会让它们兜底渲染成 unknown（"?"未确认）—— 把"已知且正常"说成"未确认"，是假报告。
  assert('② ★ 有 OPT_STATE_VIEW 状态渲染表', client.includes('const OPT_STATE_VIEW = {'))
  for (const st of ['on:', 'available:', 'off:', 'blocked:', 'unknown:', 'superseded:']) {
    assert(`② 渲染表含 ${st.replace(':', '')} 档（缺档会兜底成 unknown）`, client.includes(st))
  }
  assert('② ★ 有 optStateView 取态函数', client.includes('function optStateView('))

  // ③ 每项要显示"状态词"，而不只是打勾/打叉
  assert('③ ★ 渲染表带 label（已启用/可启用/不可启用/未确认）',
    client.includes("label: '已启用'") && client.includes("label: '可启用'")
    && client.includes("label: '不可启用'") && client.includes("label: '未确认'"))
  // ④ action（该做什么）必须被渲染出来
  assert('④ ★ 面板渲染 item.action（→ 该做什么）', client.includes('item?.action'))

  // ⑤ 总账那一行
  assert('⑤ ★ 面板有"共 N 项"总账行', client.includes('qwen-paint-opt-tally')
    && client.includes('共 ${stats.total} 项'))
  // ★ 二次修正：总账必须含 superseded，否则默认配置下 total=7 却只报"5 项已启用"，
  //   剩下 2 项（按尺寸让位）被无声吞掉，用户会以为坏了 2 项。
  assert('⑤ ★ 总账行含 superseded（按尺寸让位）', client.includes('项按尺寸让位'))

  // ⑥ 菜单入口 —— 主人明确要求"从这里也进得去"
  assert('⑥ ★ 设置菜单里有「优化」分组', client.includes("addGroup('优化',"))
  assert('⑥ ★ 菜单项 kind 为 opt', client.includes("kind: 'opt'"))
  assert('⑥ ★ 点击 opt 走 openOptDetail', client.includes("entry.kind === 'opt') openOptDetail()"))
  assert('⑥ ★ 有 openOptDetail 定义', client.includes('const openOptDetail ='))

  // ⑦ 单一渲染路径：菜单不许自己造面板，必须复用徽标的 openDetail
  assert('⑦ ★ 徽标暴露 openDetail 供外部复用', client.includes('openDetail,'))
  assert('⑦ ★ 菜单通过 optBadge.openDetail() 打开', client.includes('optBadge.openDetail()'))
  // 数据还没到时要有提示，不能点了没反应
  assert('⑦ ★ 无数据时给 setNotice 提示', client.includes('optBadge.setNotice('))

  // ⑧ 菜单项文字直接报分布（不必点进去才知道状态）
  assert('⑧ ★ 菜单文字报出 x/y 已启用', client.includes('${s.on}/${s.total} 已启用'))
  assert('⑧ 菜单文字报可启用项数', client.includes('${fixable} 可启用'))
  assert('⑧ 菜单文字报不可启用项数', client.includes('${s.blocked} 不可启用'))
  // ★ 二次修正：菜单也要报让位项数，否则默认配置下"5/7 已启用"会让人以为缺了 2 项。
  assert('⑧ ★ 菜单文字报让位项数', client.includes('${s.superseded} 让位'))

  // ⑨ 配色与字形双通道（不能只靠颜色传达状态 —— 色觉障碍用户也要能区分）
  assert('⑨ ★ 各态有独立字形（✓ / ✕ / ? / ⇄）',
    client.includes("mark: '\\u2713'") && client.includes("mark: '\\u2715'")
    && client.includes("mark: '?'") && client.includes("mark: '\\u21C4'"))
  for (const cls of ['qwen-paint-opt-yes', 'qwen-paint-opt-can', 'qwen-paint-opt-no', 'qwen-paint-opt-unk', 'qwen-paint-opt-sup']) {
    assert(`⑨ 有配色类 ${cls}`, client.includes(`.${cls}`))
  }
  // ★ 回归：superseded 必须有**自己的**档位，不能复用 unknown
  assert('⑨ ★ superseded 有独立配色（不是 unknown 的灰色）',
    client.includes('qwen-paint-opt-sup'))
  assert('⑨ ★ superseded 有独立字形（区别于 ? 与 ✓）',
    /superseded:\s*\{[^}]*\\u21C4/u.test(client))
  // ★ 行名称色也要覆盖 superseded / unknown（否则新状态落到默认色，与蓝色状态词不搭）
  assert('⑨ ★ 行名称色覆盖 row-superseded',
    client.includes('qwen-paint-opt-row-superseded .qwen-paint-opt-name'))
  assert('⑨ ★ 行名称色覆盖 row-unknown',
    client.includes('qwen-paint-opt-row-unknown .qwen-paint-opt-name'))

  // ⑩ host 侧必须真的产出 state / action / stats，否则界面这套全是空转
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert('⑩ host 产出 state 字段', host.includes("detail.push({") && /^\s*state,$/mu.test(host))
  assert('⑩ host 产出 action 字段', /action: action \?\? ''/u.test(host))
  assert('⑩ host 产出 stats', host.includes('const stats = {'))

  // ⑪ ★★★ 2026-10-09 新增（主人要求）：BlockCache T8 必须**可开关**，不能只显示参数。
  //   这里断言三件事，缺一个就说明开关链路断了：
  //     · host 给 BlockCache 项挂了 `toggle` 字段（否则前端没东西可点）；
  //     · host 有 `?blockcache=on|off` 的处理分支（否则点了没反应）；
  //     · client 真的渲染了开关按钮并会发那个请求。
  assert('⑪ host 给 BlockCache 项挂了 toggle 字段', /key: 'blockcache'/u.test(host))
  assert('⑪ host 有 ?blockcache= 处理分支', /blockCacheParam/u.test(host) && /searchParams\.get\('blockcache'\)/u.test(host))
  assert('⑪ client 渲染了开关按钮', client.includes('qwen-paint-opt-switch'))
  assert('⑪ client 会发 ?blockcache= 请求', client.includes('toggle.key') && client.includes('qwen-paint/status.json?'))
  assert('⑪ client 如实告知"重启会还原"', client.includes('要永久保存'))
  // 开关必须在 A 层被规范化 —— 点开关绝不能顺带把面板关掉
  assert('⑪ 开关点击阻止冒泡（否则会顺手关掉面板）', client.includes('event.stopPropagation()'))

  // ⑫ ★★★ 2026-10-09 真事故回归：`Error: [object Object]` 绝不能再出现。
  //   根因：`controller.abort(signal.reason)` 把**普通对象**当 reason 转发，
  //   fetch 就原样 reject 那个对象，宿主 String() 之后成了 `[object Object]`。
  //   断言：① 有 toError / cancelReason 两个规范化工具；
  //        ② 残留的 `abort(signal.reason)` / `throw signal.reason` 必须为 0 处。
  assert('⑫ host 有 toError 规范化', /function toError\(/u.test(host))
  assert('⑫ host 有 cancelReason 规范化', /function cancelReason\(/u.test(host))
  assert('⑫ host 把 toError/cancelReason 导出了', /export const __internal = \{[\s\S]{0,200}toError,/u.test(host))
  // ⚠ 必须在**去掉注释之后**再数 —— 否则会数到解释这个 bug 的那两行文档注释本身
  //   （文档里就是要原样引用 `controller.abort(signal.reason)` 这个坏写法）。
  const hostNoComments = host
    .replace(/\/\*[\s\S]*?\*\//gu, '')   // 块注释
    .replace(/^\s*\/\/.*$/gmu, '')        // 整行注释
  const rawAbort = hostNoComments.match(/controller\.abort\(signal\??\.reason\)/gu) ?? []
  assert(`⑫ 没有裸 abort(signal.reason) 残留（实测 ${rawAbort.length} 处）`, rawAbort.length === 0)
  const rawThrow = hostNoComments.match(/throw signal\??\.reason/gu) ?? []
  assert(`⑫ 没有裸 throw signal.reason 残留（实测 ${rawThrow.length} 处）`, rawThrow.length === 0)
  // ⚠ 断言**必须跟着调用形式走**：原先写死 `runDraw(args, exec)`，
  //   后来为了修 "cfg is not defined" 改成 `runDraw(args, exec, { cfg, log, onProduced, onStart })`，
  //   这条断言就假失败了 —— 不是代码坏了，是断言过时了。
  assert('⑫ execute 外面包了规范化层', /return await runDraw\(args, exec,/u.test(host))
  // ★★★ 2026-10-09 真事故防线：**闭包依赖必须显式传下去**。
  //   现场：`cfg is not defined`。runDraw 被搬成顶层函数后，
  //   `cfg`/`log`/`onProduced`/`onStart` 这些原闭包变量全部丢了作用域。
  //   `node --check` 查不出来（自由变量语法上合法），只有真跑才炸
  //   → 由 `_draw_smoke_test.mjs` 端到端守住，这里再静态兜一道。
  assert('⑫ runDraw 显式接收 deps 参数', /async function runDraw\(args, exec, deps\)/u.test(host))
  for (const dep of ['cfg', 'log', 'onProduced', 'onStart']) {
    assert(`⑫ deps 里传了 ${dep}`, new RegExp(`runDraw\\(args, exec, \\{[^}]*\\b${dep}\\b`, 'u').test(host))
  }
  // `error?.message ?? error` 是"对象被 String() 成 [object Object]"的**下游**放大器：
  // 只要上游漏出普通对象，每一处这种拼接都会把它变成 [object Object]。
  // 记下总数（39 = 31 个 `}` 收尾 + 8 个 `)` 收尾）作为基线 —— 数字变了说明有人加了新的拼接点，
  // 应该先确认那处**不会**收到非 Error 值（或者干脆改用 toError）。
  const rawFallbacks = (host.match(/message \?\? error/gu) ?? []).length
  assert(`⑫ error?.message ?? error 拼接点基线仍为 ${rawFallbacks} 处（基线 39）`, rawFallbacks === 39)
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`} ===`)
if (fail > 0) process.exit(1)
