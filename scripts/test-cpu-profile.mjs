#!/usr/bin/env node
/**
 * test-cpu-profile.mjs —— CPU 指令集识别 / 加速档的离线回归（2026-11-13 新增）
 *
 * 全程**零联网、零子进程、零硬件探测**：纯函数 + 注入假输入 + 源码级接线锁。
 *
 * 锁住九件事（都是真踩过的坑，不是凑数）：
 *   ① 型号识别：E5 v3/v4 必须命中（第一版正则漏了 `Xeon(R) CPU E5-` 中间那截）；
 *   ② 三态语义：未知 ≠ 不支持（拿 null 当 false 用会静默关掉用户本来能用的加速）；
 *   ③ flags 实测优先于型号推断，且只有实测才敢置 isaVerified；
 *   ④ 五档参数与 off 档零漂移；
 *   ⑤ max 档在无 BF16 硬件上**降级**，且理由不能是"用户显式关掉"（第一版就是这个假报告）；
 *   ⑥ mergeLaunchArgs 的 `--cpu` 裁决：摘显存参数 + 摘 GPU 专属注意力内核；
 *   ⑦ argparse 互斥组"后者胜出"（同时挂两个不是后者生效，是启动直接退出）；
 *   ⑧ 两条端点的信任围栏 + 异常不回吐路径；
 *   ⑨ 源码里绝不出现不存在的旋钮（n_threads / QwenImage21Cache / device/dtype int8）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CPU_ACCEL_MODES, CPU_ACCEL_MODE_INFO, CPU_ACCEL_DEFAULT_MODE,
  detectCpuProfile, cpuAccelPlan, mergeLaunchArgs, normalizeCpuAccelMode,
  describeCpuAccel, threadEnvSummary,
} from '../lib/cpu-profile.js'
import { makeCpuHandlers, registerCpuRoutes, CPU_ROUTES, CPU_PROFILE_PATH, CPU_ACCEL_PATH } from '../lib/cpu-endpoints.js'
import { prefixCacheNode } from '../lib/model-chain.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const sizeOf = (rel) => fs.statSync(path.join(ROOT, rel)).size
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

const P9700 = detectCpuProfile({
  model: 'AMD Ryzen 7 9700X 8-Core Processor',
  logicalCores: 16,
  flags: ['avx2', 'avx512f', 'avx512_bf16', 'avx512bw'],
})
const E5V4 = detectCpuProfile({ model: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', logicalCores: 24 })
const E5V2 = detectCpuProfile({ model: 'Intel(R) Xeon(R) CPU E5-2660 v2 @ 2.20GHz', logicalCores: 20 })
const UNKNOWN = detectCpuProfile({ model: 'Totally Unknown Processor 9000', logicalCores: 8 })

console.log('=== 1. 型号识别（每种都要能说出"凭什么"） ===')
{
  ok('9700X → amd / zen45', P9700.vendor === 'amd' && P9700.family === 'amd-zen45')
  ok('9700X 从型号里读物理核 8（不是逻辑 16）', P9700.physicalCores === 8
    && P9700.physicalCoresSource === 'model')
  ok('★ E5-2680 v4 命中（含 `Xeon(R) CPU E5-` 中间那截）', E5V4.family === 'intel-xeon-e5-v34',
    E5V4.family)
  ok('★ E5 v4 只有 AVX2、无 AVX-512 / BF16', E5V4.isa.avx2 === true
    && E5V4.isa.avx512f === false && E5V4.isa.avx512Bf16 === false)
  ok('★ E5 v2 连 AVX2 都没有', E5V2.family === 'intel-xeon-e5-v12' && E5V2.isa.avx2 === false)
  ok('12/13/14 代酷睿 → 屏蔽 AVX-512',
    detectCpuProfile({ model: '12th Gen Intel(R) Core(TM) i7-12700', logicalCores: 20 }).isa.avx512f === false)
  ok('Core Ultra → 屏蔽 AVX-512',
    detectCpuProfile({ model: 'Intel(R) Core(TM) Ultra 7 155H', logicalCores: 22 }).isa.avx512f === false)
  ok('Ryzen 5 5600X（Zen3）不误判为 Zen4',
    detectCpuProfile({ model: 'AMD Ryzen 5 5600X 6-Core Processor', logicalCores: 12 }).family === 'amd-zen3')
}

console.log('=== 2. 三态语义：未知 ≠ 不支持 ===')
{
  ok('★ 未识别型号：四个指令集全部为 null（不是 false）',
    ['avx2', 'avx512f', 'avx512Bf16', 'amxBf16'].every((k) => UNKNOWN.isa[k] === null))
  ok('未识别型号：isaEvidence=unknown、isaVerified=false',
    UNKNOWN.isaEvidence === 'unknown' && UNKNOWN.isaVerified === false)
  ok('★ 未知能力时 bf16Hardware 必须是 null（三态，"不知道"不压成"不支持"）',
    UNKNOWN.bf16Hardware === null, String(UNKNOWN.bf16Hardware))
  ok('★ 未知能力时要在 notes 里明说"不会据此关闭选项"',
    UNKNOWN.notes.some((n) => n.includes('不会') && n.includes('关闭')))
}

console.log('=== 3. 实测优先于推断 ===')
{
  ok('9700X 带 flags → isaEvidence=flags、isaVerified=true',
    P9700.isaEvidence === 'flags' && P9700.isaVerified === true)
  ok('★ 型号说是 Zen3 但 flags 里有 avx512 → 以 flags 为准', (() => {
    const p = detectCpuProfile({
      model: 'AMD Ryzen 5 5600X 6-Core Processor',
      logicalCores: 12,
      flags: ['avx2', 'avx512f'],
    })
    return p.isa.avx512f === true && p.isaEvidence === 'flags'
  })())
  ok('★ 型号说是 Zen4 但 flags 里没有 avx512 → 以 flags 为准（不吹）', (() => {
    const p = detectCpuProfile({
      model: 'AMD Ryzen 7 9700X 8-Core Processor', logicalCores: 16, flags: ['avx2'],
    })
    return p.isa.avx512f === false && p.isa.avx512Bf16 === false
  })())
  ok('Linux 内核的 avx512_bf16 与 avx512bf16 两种写法都认', (() => {
    const a = detectCpuProfile({ model: 'x', logicalCores: 8, flags: ['avx512_bf16'] })
    const b = detectCpuProfile({ model: 'x', logicalCores: 8, flags: ['avx512bf16'] })
    return a.isa.avx512Bf16 === true && b.isa.avx512Bf16 === true
  })())
  ok('显式 physicalCores 覆盖型号推断', detectCpuProfile({
    model: 'AMD Ryzen 7 9700X 8-Core Processor', logicalCores: 16, physicalCores: 6,
  }).physicalCores === 6)
  ok('没有"-Core"也没显式值 → 按逻辑核 ÷ 2 推断并标注来源', (() => {
    const p = detectCpuProfile({ model: 'Intel(R) Xeon(R) Silver 4310', logicalCores: 24 })
    return p.physicalCores === 12 && p.physicalCoresSource === 'inferred'
      && p.notes.some((n) => n.includes('推断'))
  })())
}

console.log('=== 4. 五档参数 + 零漂移 ===')
{
  ok('★ 默认档是 off', CPU_ACCEL_DEFAULT_MODE === 'off' && CPU_ACCEL_MODES[0] === 'off')
  ok('五档定义齐全且每档都有 label / summary / risk',
    CPU_ACCEL_MODES.every((m) => CPU_ACCEL_MODE_INFO[m]?.label
      && CPU_ACCEL_MODE_INFO[m]?.summary && CPU_ACCEL_MODE_INFO[m]?.risk))
  const off = cpuAccelPlan(P9700, { mode: 'off' })
  ok('★★ off 档：args 与 env 都为 0（零漂移，一个字节都不改）',
    off.args.length === 0 && off.env.length === 0 && off.threads === 0)
  const safe = cpuAccelPlan(P9700, { mode: 'safe' })
  ok('safe 只加 --preview-method none', safe.args.join(' ') === '--preview-method none')
  ok('safe 把线程钉到物理核 8（不是逻辑 16）', safe.threads === 8)
  ok('★ 三个线程环境变量都注入（torch / MKL / OpenBLAS）',
    safe.env.map(([k]) => k).join(',') === 'OMP_NUM_THREADS,MKL_NUM_THREADS,OPENBLAS_NUM_THREADS'
    && safe.env.every(([, v]) => v === '8'))
  const bal = cpuAccelPlan(P9700, { mode: 'balanced' })
  ok('balanced = safe + --use-pytorch-cross-attention',
    bal.args.join(' ') === '--preview-method none --use-pytorch-cross-attention')
  ok('★ balanced 的说明里必须承认"未必更快"（不吹成加速开关）',
    bal.notes.some((n) => n.includes('未必更快')))
  const max = cpuAccelPlan(P9700, { mode: 'max' })
  ok('max 在有 BF16 的机器上真的加 bf16 参数',
    max.args.includes('--bf16-unet') && max.args.includes('--bf16-text-enc'))
  ok('max 在无 BF16 的机器上不加 bf16 参数', !cpuAccelPlan(E5V4, { mode: 'max' }).args
    .includes('--bf16-unet'))
  const fc = cpuAccelPlan(P9700, { mode: 'force-cpu' })
  ok('force-cpu 加 --cpu 且仍关预览', fc.args.includes('--cpu') && fc.args.includes('--preview-method'))
  ok('★ force-cpu + oomFallback 时明确拒绝 --lowvram（纯 CPU 下无意义）',
    !cpuAccelPlan(P9700, { mode: 'force-cpu', oomFallback: true }).args.includes('--lowvram')
    && cpuAccelPlan(P9700, { mode: 'force-cpu', oomFallback: true }).skipped
      .some((s) => s.item === '--lowvram'))
  ok('非 force-cpu 档 + oomFallback 才加 --lowvram',
    cpuAccelPlan(P9700, { mode: 'safe', oomFallback: true }).args.includes('--lowvram'))
  ok('显式 threads 覆盖物理核', cpuAccelPlan(P9700, { mode: 'safe', threads: 12 }).threads === 12)
}

console.log('=== 4b. 前缀 KV 缓存（QwenImage21Cache）的档位覆盖 ===')
{
  ok('★★ off 档不动工作流配置（零漂移）',
    Object.keys(cpuAccelPlan(P9700, { mode: 'off' }).workflowOverrides).length === 0)
  ok('★★ force-cpu 档把 QwenImage21Cache.device 改成 cpu',
    cpuAccelPlan(P9700, { mode: 'force-cpu' }).workflowOverrides.qwenCacheDevice === 'cpu')
  ok('★ force-cpu 不擅自改 dtype（掉精度的事不在"加速档"职责内）',
    cpuAccelPlan(P9700, { mode: 'force-cpu' }).workflowOverrides.qwenCacheDtype === undefined)
  ok('★ 普通档默认不动 device（独显机器上 auto 才是最优）',
    Object.keys(cpuAccelPlan(P9700, { mode: 'balanced' }).workflowOverrides).length === 0)
  ok('★ 显式 cacheOnCpu 才把缓存挪到内存',
    cpuAccelPlan(P9700, { mode: 'balanced', cacheOnCpu: true })
      .workflowOverrides.qwenCacheDevice === 'cpu')
  ok('★ 说明文案要讲清楚"几乎不掉速"的依据，不能只说"改了"',
    cpuAccelPlan(P9700, { mode: 'force-cpu' }).notes
      .some((n) => n.includes('后台预取') && n.includes('几乎不掉速')))
}

console.log('=== 5. BF16 降级必须说真话 ===')
{
  const e5 = cpuAccelPlan(E5V4, { mode: 'max' })
  ok('★ E5 上 max 档降级为 balanced', e5.effectiveMode === 'balanced', e5.effectiveMode)
  ok('★ 降级理由必须是"硬件不支持"，不能是"用户显式关掉"',
    e5.skipped.some((s) => s.item === 'BF16' && s.reason.includes('不支持 AVX512_BF16')))
  ok('★ 降级理由里不能出现"用户显式关掉"（那是第一版的假报告）',
    !e5.skipped.some((s) => s.reason.includes('用户显式关掉')))
  const unk = cpuAccelPlan(UNKNOWN, { mode: 'max' })
  ok('能力未知时同样降级，且理由说"未知"而不是"不支持"',
    unk.effectiveMode === 'balanced'
    && unk.skipped.some((s) => s.reason.includes('未知')))
  const offBf16 = cpuAccelPlan(P9700, { mode: 'max', bf16: false })
  ok('用户显式 bf16:false → 不加 BF16，且理由确实是"用户显式关掉"',
    !offBf16.args.includes('--bf16-unet')
    && offBf16.skipped.some((s) => s.reason.includes('用户显式关掉')))
}

console.log('=== 6. mergeLaunchArgs：--cpu 的裁决 ===')
{
  ok('★★ --cpu 摘掉 --highvram / --lowvram / --novram',
    (() => {
      const r = mergeLaunchArgs({
        autoArgs: [], vramArgs: ['--highvram', '--lowvram', '--novram'], cpuArgs: ['--cpu'],
      })
      return r.length === 1 && r[0] === '--cpu'
    })())
  ok('★★ --cpu 连 --reserve-vram 的值一起摘（不能留下孤儿 "0.5"）',
    (() => {
      const r = mergeLaunchArgs({ vramArgs: ['--highvram', '--reserve-vram', '0.5'], cpuArgs: ['--cpu'] })
      return r.join(' ') === '--cpu'
    })())
  ok('★★ --cpu 摘掉 GPU 专属注意力内核（sage / flash / ck，否则启动即崩）',
    (() => {
      const r = mergeLaunchArgs({
        autoArgs: ['--use-sage-attention', '--use-flash-attention', '--use-ck-attention'],
        cpuArgs: ['--cpu'],
      })
      return r.join(' ') === '--cpu'
    })())
  ok('★ --cpu 保留纯 PyTorch 实现的注意力后端（quad 在 CPU 上合法）',
    mergeLaunchArgs({ autoArgs: ['--use-quad-cross-attention'], cpuArgs: ['--cpu'] })
      .join(' ') === '--use-quad-cross-attention --cpu')
  ok('--cpu 摘 --gpu-only / --disable-smart-memory',
    mergeLaunchArgs({ vramArgs: ['--gpu-only', '--disable-smart-memory'], cpuArgs: ['--cpu'] })
      .join(' ') === '--cpu')
}

console.log('=== 7. mergeLaunchArgs：argparse 互斥组 ===')
{
  ok('★★ 注意力互斥组：后出现的胜出（不是两个都挂）', (() => {
    const r = mergeLaunchArgs({
      autoArgs: ['--use-sage-attention'], cpuArgs: ['--use-pytorch-cross-attention'],
    })
    return r.join(' ') === '--use-pytorch-cross-attention'
  })())
  ok('★★ fp-unet 互斥组：--bf16-unet 覆盖 --fp16-unet',
    (() => {
      const r = mergeLaunchArgs({ autoArgs: ['--fp16-unet'], cpuArgs: ['--bf16-unet'] })
      return r.join(' ') === '--bf16-unet'
    })())
  ok('text-enc 互斥组同样只留一个',
    (() => {
      const r = mergeLaunchArgs({ autoArgs: ['--fp16-text-enc'], cpuArgs: ['--bf16-text-enc'] })
      return r.join(' ') === '--bf16-text-enc'
    })())
  ok('不同组之间可以共存（bf16-unet + bf16-text-enc）',
    mergeLaunchArgs({ cpuArgs: ['--bf16-unet', '--bf16-text-enc'] })
      .join(' ') === '--bf16-unet --bf16-text-enc')
  ok('同名 flag 去重（保留最后一次，不重复挂）',
    (() => {
      const r = mergeLaunchArgs({ autoArgs: ['--lowvram'], vramArgs: ['--lowvram'] })
      return r.join(' ') === '--lowvram'
    })())
  ok('空输入 → 空数组（不会凭空造参数）', mergeLaunchArgs({}).length === 0)
  ok('非数组输入容错（null / undefined 都不炸）',
    mergeLaunchArgs({ autoArgs: null, vramArgs: undefined, cpuArgs: 'x' }).length === 0)
  ok('★ 无 --cpu 时显存参数原样保留（只在 --cpu 下裁决）',
    mergeLaunchArgs({ vramArgs: ['--highvram'] }).join(' ') === '--highvram')
}

console.log('=== 8. 档位归一与 UI 视图 ===')
{
  ok('非法档位回落 off', normalizeCpuAccelMode('bogus') === 'off')
  ok('大小写 / 空格容错', normalizeCpuAccelMode('  FORCE-CPU ') === 'force-cpu')
  ok('null / undefined 回落 off',
    normalizeCpuAccelMode(null) === 'off' && normalizeCpuAccelMode(undefined) === 'off')
  const view = describeCpuAccel(P9700, cpuAccelPlan(P9700, { mode: 'balanced' }))
  ok('视图 schema 正确', view.schema === 'dsh-qwen-paint/cpu-accel@1')
  ok('★ 视图里不含任何盘符路径（脱敏）', !/[A-Za-z]:[\\/]/u.test(JSON.stringify(view)))
  ok('视图带上 CPU 型号与核数（UI 要显示）', view.cpu.model.includes('9700X')
    && view.cpu.physicalCores === 8)
  ok('threadEnvSummary 输出一行可读文本', threadEnvSummary(cpuAccelPlan(P9700, { mode: 'safe' }))
    .includes('OMP_NUM_THREADS=8'))
}

console.log('=== 9. 端点：围栏 + 脱敏 + 真实参数 ===')
{
  const makeDeps = (over = {}) => {
    const calls = { wrote: [], bodies: [], logs: [] }
    const deps = {
      isLocalRequest: (req) => req.local !== false,
      guardWriteRequest: (req) => req.guardOk !== false,
      respondJson: (res, body, code = 200) => { res.out = { body, code } },
      readJsonBody: async (req) => { calls.bodies.push(req.body); return req.body ?? {} },
      readUiState: () => ({ flowStyle: 'meteor' }),
      writeUiState: (state) => { calls.wrote.push(state); return true },
      log: (level, msg) => calls.logs.push({ level, msg }),
      snapshot: async () => ({ profile: P9700, cfg: { cpuAccel: 'balanced', cpuThreads: 0 } }),
      ...over,
    }
    return { deps, calls }
  }
  const run = async (handler, req) => {
    const res = {}
    await handler(req, res)
    return res.out ?? null
  }

  const { deps, calls } = makeDeps()
  const h = makeCpuHandlers(deps)

  const g = await run(h.profileHandler, { method: 'GET' })
  ok('GET 画像：ok + 五档 + 当前档', g?.code === 200 && g.body.ok === true
    && g.body.modes.length === 5 && g.body.mode === 'balanced')
  ok('★ GET 里每档都带"这台机器上真实会挂的参数"',
    g.body.modes.every((m) => Array.isArray(m.args) && Array.isArray(m.skipped)))
  ok('★ GET 里明确写了"改完要重启 ComfyUI"',
    g.body.apply.needRestartComfy === true && g.body.apply.note.includes('重启'))
  ok('★ GET 不含绝对路径', !/[A-Za-z]:[\\/]/u.test(JSON.stringify(g.body)))
  ok('GET 非本机 → 403', (await run(h.profileHandler, { method: 'GET', local: false }))?.code === 403)
  ok('GET 端点 POST → 405', (await run(h.profileHandler, { method: 'POST' }))?.code === 405)

  const p = await run(h.setModeHandler, { method: 'POST', body: { cpuAccel: 'force-cpu' } })
  ok('POST 设档成功并落盘', p?.body?.ok === true && p.body.cpuAccel === 'force-cpu'
    && calls.wrote.some((s) => s.cpuAccel === 'force-cpu'))
  ok('★ 写盘时保留其它 UI 偏好（不整份覆盖掉 flowStyle）',
    calls.wrote.some((s) => s.flowStyle === 'meteor' && s.cpuAccel === 'force-cpu'))
  ok('★ POST 响应必须提示重启', p.body.needRestartComfy === true)
  ok('POST 非法档位 → 400 且不落盘（不能静默变 off）', await (async () => {
    const d2 = makeDeps()
    const r = await run(makeCpuHandlers(d2.deps).setModeHandler,
      { method: 'POST', body: { cpuAccel: 'turbo' } })
    return r?.code === 400 && d2.calls.wrote.length === 0
  })())
  ok('POST 非本机 → 403', (await run(h.setModeHandler, { method: 'POST', local: false }))?.code === 403)
  ok('POST 跨站（guardWriteRequest 拒）→ 不放行', await (async () => {
    const d3 = makeDeps()
    const r = await run(makeCpuHandlers(d3.deps).setModeHandler,
      { method: 'POST', guardOk: false, body: { cpuAccel: 'safe' } })
    return !r && d3.calls.wrote.length === 0
  })())
  ok('POST 端点 GET → 405', (await run(h.setModeHandler, { method: 'GET' }))?.code === 405)
  ok('★ snapshot 抛错：500 且不回吐 error.message（可能带本机路径）', await (async () => {
    const logs = []
    const d4 = makeDeps({
      snapshot: async () => { throw new Error('K:/secret/private/cpu.json 打不开') },
      log: (level, msg) => logs.push({ level, msg }),
    })
    const r = await run(makeCpuHandlers(d4.deps).profileHandler, { method: 'GET' })
    return r?.code === 500 && !JSON.stringify(r.body).includes('K:/secret')
      && logs.some((x) => x.msg.includes('K:/secret'))
  })())
  ok('写盘失败时如实说（ok:false + persisted:false）', await (async () => {
    const d5 = makeDeps({ writeUiState: () => false })
    const r = await run(makeCpuHandlers(d5.deps).setModeHandler,
      { method: 'POST', body: { cpuAccel: 'max' } })
    return r?.body?.ok === false && r.body.persisted === false
  })())
}

console.log('=== 10. 路由注册与目录一致 ===')
{
  const registered = []
  const h = makeCpuHandlers({
    isLocalRequest: () => true, guardWriteRequest: () => true,
    respondJson: () => {}, readJsonBody: async () => ({}),
    readUiState: () => ({}), writeUiState: () => true, log: () => {},
    snapshot: async () => ({ profile: P9700, cfg: {} }),
  })
  registerCpuRoutes((r) => { registered.push(r); return () => {} }, h)
  ok('注册了 2 条端点', registered.length === 2)
  ok('★ 端点目录 ⊆ 真实注册（防"文档写了其实没挂"）',
    CPU_ROUTES.every((r) => registered.some((x) => x.path === r.path)))
  ok('路径常量与目录一致', registered.map((r) => r.path).sort().join(',')
    === [CPU_ACCEL_PATH, CPU_PROFILE_PATH].sort().join(','))
  ok('全部是 exact 匹配（不做前缀匹配，避免误吃别的路由）',
    registered.every((r) => r.kind === 'exact'))
}

console.log('=== 11. 源码锁：不许出现不存在的旋钮 ===')
{
  const cpuSrc = readSrc('lib/cpu-profile.js')
  const launchSrc = readSrc('lib/comfy-launch.js')
  const assetsSrc = readSrc('assets/cpu-accel.js')

  // ⚠ 判据要分清"注释里提到"和"代码里用了"：
  //   cpu-profile.js 的注释专门解释了"为什么不用 n_threads"，所以不能一句
  //   `!src.includes('n_threads')` 了事 —— 那会误伤正经的说明文字。
  //   这里只锁**字符串字面量/参数**形态。
  ok('★★ 代码里不出现 n_threads 参数（ComfyUI-GGUF 没这个输入）',
    !/['"]n_threads['"]/u.test(cpuSrc) && !/['"]n_threads['"]/u.test(assetsSrc))
  ok('★★ 工作流真的接了 QwenImage21Cache（官方节点，不是编的）',
    /class_type:\s*'QwenImage21Cache'/u.test(readSrc('lib/model-chain.js')))
  // ⚠ 2026-11-13 审计修：`prefixCacheNode` 加了取值白名单，写法从 `cfg.qwenCacheDevice`
  //   变成可选链 `cfg?.qwenCacheDevice` —— 旧正则 `/cfg\.qwenCacheDevice/` 因此失配。
  //   这不是放宽：判据本质是「字段来自 cfg」，顺带把新加的白名单行为也锁住。
  const chainSrc = readSrc('lib/model-chain.js')
  ok('★★ 它的 device / dtype 来自 cfg.qwenCacheDevice / qwenCacheDtype',
    /cfg\??\.qwenCacheDevice/u.test(chainSrc) && /cfg\??\.qwenCacheDtype/u.test(chainSrc))
  ok('★★ 非法 device / dtype 会回落到官方合法值（不让节点在队列里报错）', (() => {
    const bad = prefixCacheNode({ qwenCacheDevice: 'BF16', qwenCacheDtype: 'bf16' }, 'M')
    const good = prefixCacheNode({ qwenCacheDevice: 'cpu', qwenCacheDtype: 'int4' }, 'M')
    return bad.inputs.device === 'auto' && bad.inputs.dtype === 'int8'
      && good.inputs.device === 'cpu' && good.inputs.dtype === 'int4'
  })())
  ok('★★ 不出现 dtype:"int8" 硬编码在 CPU 档位里（dtype 归用户配置，档位只动 device）',
    !/qwenCacheDtype\s*[:=]\s*['"]int8['"]/u.test(cpuSrc)
    && !/dtype\s*:\s*['"]int8['"]/u.test(assetsSrc))
  ok('★ 注释里必须写清楚"为什么不用 n_threads"（防止后人又改回去）',
    cpuSrc.includes('n_threads') && cpuSrc.includes('OMP_NUM_THREADS'))
  ok('★ 只输出 cli_args 里真实存在的开关（抽检 5 个）',
    ['--cpu', '--lowvram', '--preview-method', '--use-pytorch-cross-attention', '--bf16-unet']
      .every((f) => cpuSrc.includes(f)))
  ok('★ comfy-launch 真的调用了 mergeLaunchArgs（不是只 import 不用）',
    /mergeLaunchArgs\(\{/u.test(launchSrc))
  ok('★ comfy-launch 把 CPU 线程变量接进 launchEnv（否则钉线程是空话）',
    /CPU_ACCEL\.env/u.test(launchSrc))
  ok('★ launchEnv 不再"非 Mac 恒为空"（注释已更新，行为也改了）',
    !launchSrc.includes('launchEnv` 恒为空'))
  ok('★ UI 只打两条 CPU 端点，不碰安装/重启/下载', (() => {
    const fetches = assetsSrc.match(/fetch\(([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/gu) ?? []
    return fetches.length > 0
      && fetches.every((s) => /PROFILE_PATH|SET_PATH/u.test(s))
  })())
}

console.log('=== 12. 体积红线（DSH Store） ===')
{
  const LIMIT_FILE = 262144
  const LIMIT_TOTAL = 2097152
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const over = libFiles.map((f) => ({ f, b: sizeOf(path.join('lib', f)) })).filter((x) => x.b > LIMIT_FILE)
  const total = libFiles.reduce((a, f) => a + sizeOf(path.join('lib', f)), 0)
  ok('★★ 每个 lib/*.js ≤ 262144 B', over.length === 0, over.map((x) => `${x.f}=${x.b}`).join(','))
  ok(`★ lib 合计 ≤ 2097152 B（实测 ${total}）`, total <= LIMIT_TOTAL)
  ok('★ assets 里的新 UI 不算进 lib 红线（走静态路由）',
    fs.existsSync(path.join(ROOT, 'assets/cpu-accel.js'))
    && fs.existsSync(path.join(ROOT, 'assets/cpu-accel.css')))
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
