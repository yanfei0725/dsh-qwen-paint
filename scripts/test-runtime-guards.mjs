/**
 * scripts/test-runtime-guards.mjs —— 运行期护栏（B4/B5/C16/A1 指纹/D25 草稿）离线回归。
 *
 * 覆盖：
 *   · B4 显存动态策略：按可用显存挑档，用户手选优先，**只建议不改配置**
 *   · B5 会话级模型驻留：命中不重载、换模型先腾位、TTL 过期即失效
 *   · C16 幂等保护：同键 TTL 内不重跑、并发的两个请求只跑一次、失败不记账
 *   · A1 图结构指纹：生图链 / TTS 链 / 视频链的图形状不能悄悄变
 *   · D25 草稿端点：三道闸 + 落盘位置 + 不进历史库
 *
 * ⚠ ok() 签名 (cond, name, extra)；写反当场抛。
 * ⚠ 指纹文件用 `--update` 重写：**改图必须是有意的**，先看 diff 再更新。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pickVramMode, explainVramPick, KIND_FLOORS_MB, MODE_LADDER } from '../lib/vram-strategy.js'
import { createResidency, DEFAULT_RESIDENCY_LIMIT } from '../lib/model-residency.js'
import {
  makeIdempotency, hashArgs, shortHash, stableStringify,
} from '../lib/idempotency.js'
import { fingerprint, stableJson, firstDiff } from '../lib/workflow-fingerprint.js'
import { makeConfigHandlers, configRouteTable } from '../lib/config-endpoints.js'
import {
  makeHistoryHandlers, historyRouteTable, DRAFT_MAX_BYTES, DRAFT_DIR_NAME,
} from '../lib/history-endpoints.js'
import { buildWorkflow } from '../lib/config.js'
import { buildVideoWorkflow, REQUIRED_NODES } from '../lib/video-workflow.js'
import { buildTtsWorkflow } from '../lib/tts-workflow.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FP_FILE = path.join(ROOT, 'scripts', 'workflow-fingerprints.json')
const UPDATE = process.argv.includes('--update')

let pass = 0
const failures = []
const ok = (cond, name, extra) => {
  if (typeof name !== 'string' || name.trim() === '' || name === 'true' || name === 'false') {
    throw new Error(`ok() 参数顺序可能写反（name=${JSON.stringify(name)}）；签名是 (cond, name, extra)`)
  }
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)
const sec = (t) => console.log(`\n── ${t} ──`)

/* ============================================================ B4 ==== */
sec('B4 显存动态策略')

ok(KIND_FLOORS_MB.video > KIND_FLOORS_MB.image, '视频的显存下限高于生图（帧数更吃显存）')
eq(MODE_LADDER.join(','), 'save,auto,ram,resident', '档位阶梯由省到费')

const pImgAuto = pickVramMode({ freeMB: 4000, kind: 'image' })
eq(pImgAuto.mode, 'auto', '4000MB 跑生图（需 3400）→ auto')
eq(pImgAuto.mode_from, 'computed', '来源标 computed')
eq(pImgAuto.need_mb, 3400, '需求值 = 生图下限')
eq(pImgAuto.heuristic, true, '★ 标 heuristic：阈值是经验值不是实测')
eq(pImgAuto.restart_required, true, '★★ 标 restart_required：改档必须重启 ComfyUI')

eq(pickVramMode({ freeMB: 2000, kind: 'image' }).mode, 'save', '2000MB 不够 → save')
eq(pickVramMode({ freeMB: 5000, kind: 'image' }).mode, 'ram', '5000MB（>=1.4 倍）→ ram')
eq(pickVramMode({ freeMB: 8000, kind: 'image' }).mode, 'resident', '8000MB（>=2.2 倍）→ resident')
eq(pickVramMode({ freeMB: 7000, kind: 'video' }).mode, 'auto', '视频 7000MB（需 6400）→ auto')
eq(pickVramMode({ freeMB: 9000, kind: 'video' }).mode, 'ram', '视频 9000MB → ram')

// 大图抬高下限
const bigPx = pickVramMode({ freeMB: 4000, kind: 'image', pixels: 3_000_000 })
eq(bigPx.need_mb, 5100, '超 1080p 量级时下限 ×1.5')
eq(bigPx.mode, 'save', '同样的 4000MB 在超大图上就变成 save')
eq(pickVramMode({ freeMB: 4000, kind: 'image', pixels: 2_000_000 }).need_mb, 3400, '未超阈值时不放大')

// 用户手选优先
const user = pickVramMode({ freeMB: 1000, kind: 'video', userMode: 'resident' })
eq(user.mode, 'resident', '★★ 用户手选优先，不被建议覆盖')
eq(user.mode_from, 'user', '来源标 user')
ok(String(user.warning).includes('OOM'), '不够时只提醒，不改用户的选择')
eq(pickVramMode({ freeMB: 8000, kind: 'image', userMode: 'save' }).warning, '', '手选且够用时不再唠叨')
ok(pickVramMode({ freeMB: 1000, kind: 'image', userMode: 'save' }).warning.includes('最省的 save 档'),
  '★ 已经在 save 时不再劝「降到 save」（不写废话）')

// 拿不到显存
const unknown = pickVramMode({ freeMB: null, kind: 'image' })
eq(unknown.ok, false, '★ 没拿到显存 → ok:false')
eq(unknown.mode, 'auto', '不知道就保持 auto（不乱建议）')
ok(unknown.reason.includes('没拿到可用显存'), '原因说清是拿不到数据')
eq(pickVramMode({}).free_mb, null, '完全不给参数也不抛错')
eq(pickVramMode({ kind: 'nope' }).need_mb, KIND_FLOORS_MB.image, '未知任务类型回落生图下限')

const line = explainVramPick(pImgAuto)
ok(line.includes('建议 auto 档'), '摘要里带建议档位')
ok(line.includes('3400MB'), '摘要里带需求值')
ok(line.includes('重启'), '摘要里提醒要重启')
eq(explainVramPick(null), '', 'null 返回空串')

/* ============================================================ B5 ==== */
sec('B5 会话级模型驻留')

eq(DEFAULT_RESIDENCY_LIMIT, 1, '默认只驻留 1 个（小显存不许双载）')

const r1 = createResidency()
eq(r1.current().length, 0, '初始为空')
const first = r1.plan('unet-a')
eq(first.load, true, '第一次必然要载')
eq(first.hit, false, '不是命中')
eq(first.unload.length, 0, '没有要先卸的')

eq(r1.touch('unet-a').join(','), 'unet-a', 'touch 后账本里有它')
const again = r1.plan('unet-a')
eq(again.hit, true, '★ 再要同一个模型 → 命中')
eq(again.load, false, '不用重新加载')
eq(again.keep, true, '保持驻留')

const swap = r1.plan('unet-b')
eq(swap.load, true, '换模型要载')
eq(swap.unload.join(','), 'unet-a', '★ 换模型前先卸下旧的（cap=1）')
ok(swap.reason.includes('unet-a'), '原因里点名卸了谁')

r1.touch('unet-b')
eq(r1.current().join(','), 'unet-b', '账本换成新模型')
eq(r1.stats().hits, 1, '命中计数 1')
eq(r1.stats().misses, 2, '未命中计数 2（首次 a 与 b）')
ok(Math.abs(r1.stats().hit_rate - 0.333) < 1e-9, '命中率 = 0.333（保留三位小数）')
eq(r1.evict('unet-b').length, 0, 'evict 后账本空')
r1.reset()
eq(r1.stats().hits, 0, 'reset 清零')

// limit 2：可以并存
const r2 = createResidency({ limit: 2 })
r2.touch('a')
r2.touch('b')
eq(r2.current().join(','), 'b,a', '最新在前')
eq(r2.plan('a').hit, true, '★ limit=2 时 a 仍在显存 → 命中（不用重载）')
eq(r2.plan('c').unload.join(','), 'a', '要腾位时卸最老的那个（留 b）')
eq(r2.plan('').load, false, '空 key 不动账本')

// TTL
let clock = 1000
const r3 = createResidency({ ttlMs: 50, now: () => clock })
r3.touch('x')
eq(r3.plan('x').hit, true, 'TTL 内命中')
clock += 60
eq(r3.plan('x').hit, false, '★ 超过 TTL 视为已被挤掉')
eq(r3.current().length, 0, '过期后账本为空')

/* ============================================================ C16 ==== */
sec('C16 幂等保护')

eq(shortHash('abc').length, 8, '短哈希是 8 位十六进制')
eq(shortHash('abc'), shortHash('abc'), '同输入同哈希')
eq(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }), '★ 键顺序不影响序列化（否则去重静默失效）')
eq(stableStringify({ a: undefined, b: 1 }), stableStringify({ b: 1 }), 'undefined 字段被忽略')
eq(hashArgs('draw', { a: 1, b: 2 }), hashArgs('draw', { b: 2, a: 1 }), '参数顺序变了但键相同 → 同一个去重键')
ok(hashArgs('draw', { a: 1 }) !== hashArgs('batch', { a: 1 }), '不同动作前缀 → 不同键')

let clock2 = 5000
const idem = makeIdempotency({ ttlMs: 100, max: 4, now: () => clock2 })
let runs = 0
const step1 = await idem.run('k1', async () => { runs += 1; return 'v1' })
eq(step1.hit, false, '第一次执行')
eq(step1.value, 'v1', '返回值原样')
const step2 = await idem.run('k1', async () => { runs += 1; return 'v2' })
eq(step2.hit, true, '★ 同键 TTL 内第二次 → 命中，不重跑')
eq(step2.value, 'v1', '返回的是上次的结果')
eq(runs, 1, '★★ 函数只执行了一次（这就是省钱的地方）')

// 并发只跑一次
let concurrentRuns = 0
const [c1, c2] = await Promise.all([
  idem.run('k2', async () => { concurrentRuns += 1; await new Promise((r) => setTimeout(r, 10)); return 'once' }),
  idem.run('k2', async () => { concurrentRuns += 1; return 'twice' }),
])
eq(concurrentRuns, 1, '★★ 同一键并发两次 → 只执行一次')
ok(c1.value === 'once' && c2.value === 'once', '两个调用拿到同一个结果')
eq(c2.coalesced, true, '第二个标记为合并（coalesced）')

// 失败不记账
let threw = false
try { await idem.run('k3', async () => { throw new Error('boom') }) } catch { threw = true }
ok(threw, '失败的调用把异常抛回去（不吞）')
eq(idem.peek('k3').hit, false, '★ 失败不入账，下次还能重试')
const retry = await idem.run('k3', async () => 'recovered')
eq(retry.hit, false, '重试是真执行')
eq(retry.value, 'recovered', '重试成功')

// TTL 过期后可重跑
clock2 += 200
eq(idem.peek('k1').hit, false, '过期后不再命中')
const afterTtl = await idem.run('k1', async () => 'v-new')
eq(afterTtl.hit, false, '★ 过了 TTL 允许再跑（用户故意要重跑时不会被永久拦住）')
eq(afterTtl.value, 'v-new', '拿到新结果')

// 容量上限
const small = makeIdempotency({ max: 2 })
small.put('a', 1); small.put('b', 2); small.put('c', 3)
eq(small.size(), 2, '超过容量丢最老的')
eq(small.peek('a').hit, false, '最老的被淘汰')
eq(small.peek('c').hit, true, '最新的还在')

const empty = makeIdempotency()
let keyErr = false
try { await empty.run('', async () => 1) } catch { keyErr = true }
ok(keyErr, '空键直接报错（不静默记账）')
empty.clear()
eq(empty.stats().size, 0, 'clear 清空')

/* ============================================================ A1 ==== */
sec('A1 图结构指纹')

eq(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }), '稳定序列化对键排序')
eq(fingerprint({ a: 1 }), fingerprint({ a: 1 }), '同结构同指纹')
ok(fingerprint({ a: 1 }) !== fingerprint({ a: 2 }), '差一个值指纹就变')
eq(stableJson(new Set(['b', 'a'])), '["a","b"]', 'Set 排序后参与序列化（caps.nodes 有时是 Set）')
const d = firstDiff({ a: 1, b: 2 }, { a: 1, b: 3 })
eq(d.path, '$.b', 'firstDiff 报出第一处差异路径')

// —— 夹具：固定 cfg / caps / 参数，只看图结构 ——
const imageNodes = {
  KSampler: true, CLIPTextEncode: true, VAELoader: true, UNETLoader: true,
  VAEDecode: true, EmptyLatentImage: true, SaveImage: true,
  LoraLoaderModelOnly: true, QwenImage21Cache: true, ModelSamplingAuraFlow: true,
}
const IMAGE_MODELS = new Set(['qwen-image-2.1-UC-Q4_K_M.gguf'])

const fixtures = {
  'image-basic': () => buildWorkflow({}, { prompt: 'a red fox', width: 512, height: 512, steps: 25, seed: 1 },
    { level: 'basic', nodes: new Set(Object.keys(imageNodes)), models: IMAGE_MODELS }),
  'image-full': () => buildWorkflow({}, { prompt: 'a red fox', width: 512, height: 512, steps: 25, seed: 1 },
    { level: 'full', nodes: new Set(Object.keys(imageNodes)), models: IMAGE_MODELS }),
  'image-img2img': () => buildWorkflow({}, { prompt: 'a red fox', width: 512, height: 512, steps: 12, seed: 7, reference: '/tmp/ref.png' },
    { level: 'basic', nodes: new Set(Object.keys(imageNodes)), models: IMAGE_MODELS }),
  'video-dmd': () => buildVideoWorkflow(
    { nodes: Object.fromEntries(REQUIRED_NODES.map((n) => [n, true])), gpu: { vendor: 'amd' } },
    { prompt: 'a red fox in snow', frames: 25, fps: 24, height: 480, seed: 3 },
  ).workflow,
  'tts-custom-mp3': () => buildTtsWorkflow(
    { nodes: new Set(['FB_Qwen3TTSCustomVoice', 'SaveAudioMP3']) },
    { text: '你好世界', prefix: 'qwen-paint/tts' },
  ).workflow,
}

const current = {}
for (const [name, build] of Object.entries(fixtures)) {
  let out
  try { out = build() } catch (e) { failures.push(`夹具 ${name} 构建失败`); console.log('  FAIL', `夹具 ${name} 构建失败：${e.message}`); continue }
  const types = Object.keys(out).map((id) => String(out[id]?.class_type ?? '')).sort()
  current[name] = { hash: fingerprint(out), nodes: Object.keys(out).length, types }
}

const stored = (() => {
  try { return JSON.parse(fs.readFileSync(FP_FILE, 'utf8')) } catch { return null }
})()

// ★ 0.32.1 审计 A7：基准缺失 / 损坏时**绝不**用当前代码自动重建并算通过，
//   否则「把图改坏 → 删基准 → 全绿」就能绕过整条护栏（当场成功 ≠ 最终留存）。
if (UPDATE) {
  const payload = {
    _comment: 'A1：工作流图结构指纹（scripts/test-runtime-guards.mjs 维护）。图变了先看 diff 再 --update。',
    _why: '生图链/TTS 链分支多，暂不做运行时清单接管；用指纹锁住"图不会悄悄变"。',
    fixtures: current,
  }
  fs.writeFileSync(FP_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  ok(true, `已显式重建指纹文件 ${path.basename(FP_FILE)}（请复核 diff 后重跑）`)
} else if (stored === null || !stored.fixtures) {
  ok(false, '★★ 指纹基准缺失或损坏：禁止自动重建，请显式 --update 并复核 diff')
} else {
  for (const name of Object.keys(fixtures)) {
    const now = current[name]
    const was = stored.fixtures[name]
    if (!now) continue
    if (!was) { ok(false, `指纹里缺 ${name}（新增夹具后请 --update）`); continue }
    const same = now.hash === was.hash
    const detail = same ? '' : `（${now.nodes} 节点 vs ${was.nodes}；差在 ${JSON.stringify(firstDiff(was.types, now.types) ?? '常量或连线')}）`
    ok(same, `★ ${name} 的图结构与基准一致${detail}`)
  }
  for (const name of Object.keys(stored.fixtures ?? {})) {
    ok(name in fixtures, `指纹里的 ${name} 仍然有对应夹具（删夹具要同步删指纹）`)
  }
}

/* ============================================================ D25 ==== */
sec('D25 草稿端点')

eq(DRAFT_MAX_BYTES, 160 * 1024, '草稿上限 160 KB（base64 后仍在 readJsonBody 的 256 KB 内）')
eq(DRAFT_DIR_NAME, 'qwen-paint-drafts', '草稿目录名固定')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-draft-'))
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-cfg-'))
const respondJson = (res, body, code = 200) => { res.out = { body, code } }
const mkHandlers = (deps = {}) => makeHistoryHandlers({
  isLocalRequest: () => true,
  guardWriteRequest: () => true,
  respondJson,
  readJsonBody: async (req) => req.body ?? {},
  store: null,
  log: () => {},
  outputDir: tmp,
  ...deps,
})
const call = async (h, req) => { const res = { out: null }; await h(req, res); return res.out }
const pngB64 = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 3),
]).toString('base64')}`

const routes = historyRouteTable(mkHandlers())
ok(routes.some(([p]) => p === '/api/qwen-paint/draft'), '★ /api/qwen-paint/draft 已登记进路由表')

const good = await call(mkHandlers().draftSaveHandler, {
  method: 'POST', url: '/', headers: { 'content-type': 'application/json' }, body: { data_url: pngB64 },
})
eq(good.code, 200, '正常草稿返回 200')
eq(good.body.ok, true, 'ok:true')
ok(String(good.body.path).startsWith(tmp), '返回的是输出目录下的绝对路径')
ok(fs.existsSync(good.body.path), '★ 文件真的落盘了')
ok(path.basename(good.body.path).startsWith('draft-'), '文件名由服务端生成（draft- 前缀）')
ok(path.basename(good.body.path).endsWith('.png'), '扩展名跟着 mime 走')
ok(String(good.body.rel_path).startsWith(DRAFT_DIR_NAME), '相对路径在草稿目录下')
ok(String(good.body.hint).includes('reference'), 'hint 告诉用户路径往哪填')

const badType = await call(mkHandlers().draftSaveHandler, {
  method: 'POST', url: '/', headers: {}, body: { data_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
})
eq(badType.code, 400, '★ SVG 被拒')
ok(String(badType.body.reason).includes('不支持的图片类型'), '理由是「不支持的类型」而不是笼统的格式错误')

const fakeMagic = await call(mkHandlers().draftSaveHandler, {
  method: 'POST', url: '/', headers: {}, body: { data_url: `data:image/png;base64,${Buffer.from('notapng!').toString('base64')}` },
})
eq(fakeMagic.code, 400, '★ 魔数不符被拒（不能只信 data: 前缀）')

const noBody = await call(mkHandlers().draftSaveHandler, { method: 'POST', url: '/', headers: {}, body: {} })
eq(noBody.code, 400, '缺 data_url → 400')

const noDir = await call(mkHandlers({ outputDir: '' }).draftSaveHandler, {
  method: 'POST', url: '/', headers: {}, body: { data_url: pngB64 },
})
eq(noDir.code, 400, '没配输出目录 → 400')
ok(String(noDir.body.reason).includes('输出目录未配置'), '原因写的是「输出目录未配置」')

const notLocal = await call(mkHandlers({ isLocalRequest: () => false }).draftSaveHandler, {
  method: 'POST', url: '/', headers: {}, body: { data_url: pngB64 },
})
eq(notLocal.code, 403, '★ 非本机请求 → 403')

const getOnly = await call(mkHandlers().draftSaveHandler, {
  method: 'GET', url: '/', headers: {}, body: { data_url: pngB64 },
})
eq(getOnly.code, 405, 'GET → 405（写端点只收 POST）')

const csrf = await call(mkHandlers({ guardWriteRequest: () => false }).draftSaveHandler, {
  method: 'POST', url: '/', headers: {}, body: { data_url: pngB64 },
})
eq(csrf, null, '★ 写请求守卫拦下时直接 return，处理器不再产生任何响应（由守卫自己回）')

const files = fs.readdirSync(path.join(tmp, DRAFT_DIR_NAME))
ok(files.length >= 1, '草稿目录里至少有一个文件')
ok(files.every((f) => /^draft-\d{14}-[a-z0-9]{4}\.(png|jpeg|webp)$/u.test(f)),
  '★ 文件名格式统一：draft-<时间戳>-<随机>.<白名单扩展名>')
fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(tmp2, { recursive: true, force: true })

/* ================================================== 新增端点行为 ==== */
sec('新端点行为（A1/A2/A3/D19/D23/D26/B4）')

const cfgHandlers = makeConfigHandlers({
  isLocalRequest: () => true,
  guardWriteRequest: () => true,
  respondJson,
  cfg: { comfyUrl: 'http://127.0.0.1:8188', outputDir: tmp2, vramMode: 'auto' },
  log: () => {},
  // 不给 fetchFn：模拟 ComfyUI 不可达，验证"拿不到就如实说"
})
const hit = async (fn, url) => { const res = { out: null }; await fn({ method: 'GET', url, headers: {} }, res); return res.out }

const rt = configRouteTable(cfgHandlers)
eq(rt.length, 10, '配置端点表共 10 条（新增 contracts 与 eta）')
ok(rt.every(([, fn]) => typeof fn === 'function'), '每条路由都绑了 handler')

// —— A1/A3/D26：清单总览 ——
const wf = await hit(cfgHandlers.workflowsHandler, '/api/qwen-paint/workflows')
eq(wf.code, 200, '清单总览 200')
eq(wf.body.ok, true, '清单总览 ok')
ok(wf.body.count >= 1, `至少一条清单（实际 ${wf.body.count}）`)
const vid = wf.body.manifests.find((m) => m.id === 'video-wan22')
ok(vid !== undefined, '清单里有 video-wan22')
eq(vid.authoritative, 'runtime', '★ 视频链标 runtime（真的按清单提交）')
eq(vid.valid, true, '清单校验通过')
ok(vid.loaders.always.includes('UNETLoader'), '必载加载器清单里有 UNETLoader')
ok(Array.isArray(vid.patches) && vid.patches.includes('audio-track'), '★ 清单把条件补丁 id 一并列出（audio-track）')
ok(vid.presets.length >= 1 && vid.presets.every((x) => typeof x.ok === 'boolean'), '每个预设都带可落地判定')
eq(wf.body.preset_unverified.length, 2, '★ 生图链的预设标为"待校验"而不是假装通过')
ok(Array.isArray(vid.presets) && vid.presets.length >= 1, '清单带出可绑预设')
eq(wf.body.preset_errors.length, 0, '预设绑定无漂移')
const wfText = JSON.stringify(wf.body)
ok(!wfText.includes('K:'), '★★ 清单总览不泄漏本机绝对路径')
ok(!wfText.includes(ROOT.replace(/\\\\/g, '/')), '★ 清单总览不含仓库根路径')

// —— D23：参数表 ——
const noChain = await hit(cfgHandlers.paramsHandler, '/api/qwen-paint/params')
eq(noChain.code, 400, '没给 chain → 400')
ok(String(noChain.body.note).includes('video-wan22'), '提示里列出可用 chain')
const pv2 = await hit(cfgHandlers.paramsHandler, '/api/qwen-paint/params?chain=video-wan22&width=830&steps=6')
eq(pv2.code, 200, '参数表 200')
eq(pv2.body.ok, true, '参数表 ok')
eq(pv2.body.chain, 'video-wan22', 'chain 原样回显')
const wRow = pv2.body.rows.find((r) => r.key === 'width')
eq(wRow.origin, 'aligned', '★ 830 被标为已对齐')
eq(wRow.value, 832, '实际值 832')
const sRow = pv2.body.rows.find((r) => r.key === 'steps')
eq(sRow.origin, 'user', 'steps 是你指定的')
ok(String(pv2.body.summary).includes('你指定了'), '摘要统计你指定的项')
const badChain = await hit(cfgHandlers.paramsHandler, '/api/qwen-paint/params?chain=../etc/passwd')
eq(badChain.code, 404, '★ 穿越式 chain 被拒（404，不读外部文件）')

// —— D19：字幕 ——
const sub = await hit(cfgHandlers.subtitleHandler, '/api/qwen-paint/subtitle?text=%E4%BD%A0%E5%A5%BD%E3%80%82&seconds=2')
eq(sub.code, 200, '字幕 200')
eq(sub.body.ok, true, '脚本字幕 ok')
eq(sub.body.aligned, false, '★★ 脚本字幕 aligned:false')
ok(String(sub.body.content).startsWith('1'), '返回可直接落盘的 SRT')
eq(sub.body.cap.available, null, '端点不自带探测 → 能力标 unknown（不谎称不支持）')
const subAsr = await hit(cfgHandlers.subtitleHandler, '/api/qwen-paint/subtitle?source=asr&text=x&seconds=2')
eq(subAsr.body.ok, false, 'asr 路径在端点里也必须失败')
eq(subAsr.body.missing.length, 3, '并给出缺件清单')
const subLong = await hit(cfgHandlers.subtitleHandler, `/api/qwen-paint/subtitle?text=${'a'.repeat(2001)}&seconds=2`)
eq(subLong.code, 400, '★ 超长文案被拒（GET 不能当上传通道）')

// —— A2：后处理计划 ——
const post0 = await hit(cfgHandlers.videoPostHandler, '/api/qwen-paint/video/post')
eq(post0.body.ok, true, '后处理计划 ok')
eq(post0.body.declared.ffmpeg, false, '没声明就是 false（不替用户假定有 ffmpeg）')
ok(post0.body.blocked.length > 0, '没声明 ffmpeg 时有多步被挡')
const post1 = await hit(cfgHandlers.videoPostHandler, '/api/qwen-paint/video/post?ffmpeg=1&ffprobe=1&nodes=1')
eq(post1.body.blocked.length, 0, '全部声明可用时没有阻塞项')
eq(post1.body.plan.length, 7, '七步全部可跑')

// —— B4：显存建议 ——
const va = await hit(cfgHandlers.vramAdviceHandler, '/api/qwen-paint/vram-advice?kind=image&free=8000')
eq(va.body.ok, true, '给了 free 就能算')
eq(va.body.pick.mode, 'resident', '8000MB → resident')
eq(va.body.pick.restart_required, true, '仍然标明要重启')
ok(String(va.body.note).includes('不改你的配置'), '★ 明确说只建议不改配置')
const vaNo = await hit(cfgHandlers.vramAdviceHandler, '/api/qwen-paint/vram-advice?kind=image')
eq(vaNo.body.ok, false, '没有 free 且没有 fetchFn → 如实 ok:false')
eq(vaNo.body.source, 'unavailable', '来源标 unavailable')

// —— 端点围栏 ——
const denied = { out: null }
await cfgHandlers.workflowsHandler({ method: 'GET', url: '/', headers: {} }, denied)
ok(denied.out.code === 200, '（本机请求正常通过）')
const nonLocal = makeConfigHandlers({
  isLocalRequest: () => false, guardWriteRequest: () => true, respondJson,
  cfg: {}, log: () => {},
})
const nl = { out: null }
await nonLocal.workflowsHandler({ method: 'GET', url: '/', headers: {} }, nl)
eq(nl.out.code, 403, '★ 非本机 → 403')


console.log(`\ntest-runtime-guards: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
