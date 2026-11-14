/**
 * scripts/test-perf-config.mjs —— 第二批：提示词模板 / 档位语义 / 缓存摘要 / 恢复默认。
 *
 * 覆盖 F28、B7、B8、B9、G34。
 *
 * ⚠ ok() 签名是 (cond, name, extra)，helper 内建防假绿自检。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PROMPT_TEMPLATES, TEMPLATE_CATEGORIES, getTemplate, listTemplates, renderTemplate,
} from '../lib/prompt-templates.js'
import { makePromptTool } from '../lib/prompt-tool.js'
import {
  CACHE_CHOICES, VRAM_CHOICES, describeCurrent, getCacheChoice, getVramChoice, planPerfChange,
} from '../lib/perf-presets.js'
import { CACHE_SCOPE, fetchCacheReport, summarizeCacheRun } from '../lib/cache-report.js'
import {
  PREF_FILE, PROGRESS_MODES, configRouteTable, makeConfigHandlers,
} from '../lib/config-endpoints.js'
import { makeLog } from '../lib/config.js'

let pass = 0
const failures = []
const ok = (cond, name, extra) => {
  if (typeof name !== 'string' || name.trim() === '' || name === 'true' || name === 'false') {
    throw new Error(`ok() 参数顺序可能写反（name=${JSON.stringify(name)}）`)
  }
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-pc-'))
const logs = []
const log = (level, msg) => logs.push({ level, msg })

// ── 1. F28 模板数据自洽 ─────────────────────────────────────────────────────
console.log('\n=== 1. F28 模板数据自洽 ===')
{
  ok(PROMPT_TEMPLATES.length >= 6, `至少 6 个模板（实际 ${PROMPT_TEMPLATES.length}）`)
  const ids = PROMPT_TEMPLATES.map((t) => t.id)
  eq(new Set(ids).size, ids.length, '模板 id 不重复')
  ok(PROMPT_TEMPLATES.every((t) => TEMPLATE_CATEGORIES.includes(t.category)), '每个模板的 category 都在声明清单里')
  ok(PROMPT_TEMPLATES.every((t) => t.negative !== ''), '每个模板都给了推荐负向词')
  ok(PROMPT_TEMPLATES.every((t) => /^\d+x\d+$/u.test(t.size)), '每个模板的 size 都是 WxH 形式')

  // ★ 最容易出的错：template 里写了 {xxx} 但 slots 没声明 xxx（或反之），
  //   渲染时就会漏一个裸占位符进 prompt。
  for (const t of PROMPT_TEMPLATES) {
    const inTpl = new Set([...t.template.matchAll(/\{([a-z_]+)\}/gu)].map((m) => m[1]))
    const inSlots = new Set(t.slots.map((s) => s.key))
    const onlyTpl = [...inTpl].filter((k) => !inSlots.has(k))
    const onlySlots = [...inSlots].filter((k) => !inTpl.has(k))
    eq(onlyTpl.join(','), '', `模板 ${t.id}：占位符都有对应 slot 声明`)
    eq(onlySlots.join(','), '', `模板 ${t.id}：声明的 slot 都在模板里用到`)
    ok(t.slots.some((s) => s.required === true), `模板 ${t.id}：至少一个必填槽位（否则等于没有模板）`)
    ok(t.slots.every((s) => typeof s.example === 'string' && s.example !== ''), `模板 ${t.id}：每个槽位都有示例`)

    // ★ 最容易复发的渲染 bug：模板正文里已经写了「视角」，slot 又声明 suffix:'视角'
    //   填了值就会变成「45 度俯视视角视角」。这里逐槽位守住。
    for (const s of t.slots) {
      const suf = String(s.suffix ?? '')
      const pre = String(s.prefix ?? '')
      if (suf !== '') {
        ok(!t.template.includes(`{${s.key}}${suf}`),
          `模板 ${t.id}/${s.key}：正文里没自带后缀「${suf}」（否则填了会重复一遍）`)
      }
      if (pre !== '') {
        ok(!t.template.includes(`${pre}{${s.key}}`),
          `模板 ${t.id}/${s.key}：正文里没自带前缀「${pre}」`)
      }
    }
  }

  const list = listTemplates()
  eq(list.length, PROMPT_TEMPLATES.length, '清单条数与模板数一致')
  ok(list.every((t) => !('template' in t) && !('negative' in t)), '★ 清单是精简版（不带 template 正文，省 token）')
  ok(list[0].slots.every((s) => typeof s.required === 'boolean'), '清单里 required 归一成布尔')
  const angleSlot = list.find((t) => t.id === 'product').slots.find((s) => s.key === 'angle')
  eq(angleSlot.suffix, '视角', '★ 清单透出 suffix，用户知道不用自己加单位词')
}

// ── 2. F28 渲染 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. F28 渲染 ===')
{
  const r = renderTemplate('product', {
    subject: '一只磨砂黑色保温杯', material: '哑光不锈钢', background: '浅灰无缝背景',
  })
  ok(r.ok, '必填填齐 → ok:true')
  ok(!/\{[a-z_]+\}/u.test(r.prompt), '★ 渲染结果里没有裸占位符残留')
  ok(!/[，,]{2}/u.test(r.prompt), '★ 没有「，，」这种残渣')
  ok(r.prompt.startsWith('一只磨砂黑色保温杯'), '主体在句首')
  ok(r.prompt.includes('哑光不锈钢'), '已填的可选槽位被替换进去')
  ok(!r.prompt.includes('视角'), '未填的「视角」整段被摘掉（连关键词一起）')
  ok(r.negative !== '' && r.size === '1024x1024', '带出推荐负向词与尺寸')
  ok(r.prompt.includes('置于浅灰无缝背景'), '填了 background → 前缀「置于」拼上（这条 fixture 里 background 是填了的）')

  // 填了的话，前缀/后缀要被正确拼上，且不重复
  const withAngle = renderTemplate('product', { subject: '一只保温杯', angle: '45 度俯视' })
  ok(withAngle.prompt.includes('45 度俯视视角'), '★ 填了 angle → 自动拼成「45 度俯视视角」')
  ok(!withAngle.prompt.includes('视角视角'), '★★ 不会重复后缀')
  ok(!withAngle.prompt.includes('置于') && !withAngle.prompt.includes('{background}'),
    '★★ 未填的 background 不留孤立前缀「置于」，也不留裸占位符')
  const withBg = renderTemplate('product', { subject: '一只保温杯', background: '深灰水泥台面' })
  ok(withBg.prompt.includes('置于深灰水泥台面'), '★ 填了 background → 前缀「置于」正确拼回')
  ok(!withBg.prompt.includes('置于置于'), '★★ 不会重复前缀')

  const missing = renderTemplate('product', {})
  eq(missing.ok, false, '必填没填 → ok:false')
  eq(missing.missing.map((m) => m.key).join(','), 'subject', 'missing 精确指出缺哪个槽位')
  ok(missing.missing[0].label === '主体', 'missing 带中文名，方便直接提示用户')
  ok(missing.prompt !== '', '★ 仍然返回当前预览（不是空串），调用方可以展示已填部分')
  ok(String(missing.missing.length) === '1', '未填的可选槽位不算 missing')

  const unknown = renderTemplate('nope', {})
  eq(unknown.ok, false, '不存在的模板 → ok:false')
  ok(unknown.reason.includes('没有这个模板'), '原因说清楚是模板不存在')

  // 槽位值里的脏输入要被收拾干净
  const dirty = renderTemplate('character', { gender: '  女性  \n\n', hair: 'x'.repeat(500) })
  ok(!dirty.prompt.includes('\n'), '★ 槽位里的换行被压成空格（否则 prompt 结构会被撑坏）')
  ok(!/\s{2,}/u.test(dirty.prompt), '没有连续空格')
  ok(dirty.used.hair.length === 200, '超长槽位值被裁到 200 字')

  // 未填可选槽位在句首时的处理
  const edge = renderTemplate('interior', { room: '朝南的客厅' })
  ok(!/^[，,]/u.test(edge.prompt), '★ 句首不会因为摘槽位留下逗号')
  ok(edge.ok, '只填必填也能出结果')

  eq(getTemplate('PRODUCT'), null, '★ id 大小写敏感（不做模糊匹配，避免拼错还静默成功）')
}

// ── 3. F28 工具外壳 ─────────────────────────────────────────────────────────
console.log('\n=== 3. F28 工具外壳 ===')
{
  const tool = makePromptTool({ log })
  eq(tool.name, 'compose_prompt', '工具名固定')
  ok(tool.parameters.additionalProperties === false, 'parameters 关闭 additionalProperties')

  const listed = await tool.execute({})
  ok(listed.ok && listed.templates.length > 0, '不传 template → 返回清单')
  ok(listed.note.includes('required'), 'note 提示要填 required 槽位')

  const bad = await tool.execute({ template: 'nope' })
  eq(bad.ok, false, '不存在的模板 → ok:false')
  ok(bad.templates.length > 0, '★ 失败时也把清单带回去（用户不用再调一次才知道有哪些）')

  const need = await tool.execute({ template: 'product', slots: {} })
  eq(need.ok, false, '缺必填 → ok:false')
  ok(need.note.includes('主体'), 'note 点名缺的是「主体」')
  ok(need.note.includes('不要直接拿去出图'), '★ 明确劝阻用半成品出图')

  const done = await tool.execute({ template: 'product', slots: { subject: '一只白瓷杯' } })
  ok(done.ok && done.prompt.includes('一只白瓷杯'), '填齐后返回可直接用的 prompt')
  ok(String(done.size).includes('x'), '带推荐尺寸')
}

// ── 4. B7 / B8 档位语义 ─────────────────────────────────────────────────────
console.log('\n=== 4. B7 / B8 档位语义 ===')
{
  ok(VRAM_CHOICES.length >= 6, `显存档位至少 6 个（实际 ${VRAM_CHOICES.length}）`)
  ok(VRAM_CHOICES.every((c) => c.restart === true), '★ 显存档位全部标记「需要重启」（都是启动参数）')
  ok(VRAM_CHOICES.some((c) => c.id === 'ram'), '★ B7：--novram 有对应档位（id=ram）')
  ok(VRAM_CHOICES.some((c) => c.id === 'save'), '省显存档（--lowvram）在列')
  ok(VRAM_CHOICES.every((c) => c.cost !== ''), '每个档位都写了代价（不能只写好处）')
  ok(getVramChoice('auto').id === 'auto', 'auto 是有效档位')
  eq(getVramChoice('AUTO'), null, '档位 id 大小写敏感')

  ok(CACHE_CHOICES.length >= 3, `缓存档位至少 3 个（实际 ${CACHE_CHOICES.length}）`)
  ok(CACHE_CHOICES.every((c) => c.restart === false), '★ 缓存档位全部标记「无需重启」（写在工作流里）')
  const save = getCacheChoice('save')
  eq(`${save.device}+${save.dtype}`, 'cpu+int8', '★ B8：省显存 = cpu + int8')
  const bal = getCacheChoice('balanced')
  eq(`${bal.device}+${bal.dtype}`, 'auto+int8', '★ B8：均衡 = auto + int8（当前默认）')
  const ram = getCacheChoice('ram')
  eq(`${ram.device}+${ram.dtype}`, 'gpu+default', '★ B8：省内存 = gpu + default')
  ok(CACHE_CHOICES.some((c) => c.device === 'off'), '有「关闭缓存」档（排查画面异常时要用）')

  const p1 = planPerfChange({ vramMode: 'ram' })
  ok(p1.ok && p1.needsRestart === true, '只改显存档 → 需要重启')
  eq(p1.workflowOverrides.qwenCacheDevice, undefined, '★ 只改显存时不碰 workflowOverrides')
  ok(p1.notes.some((n) => n.includes('必须重启')), 'note 明确说要重启')

  const p2 = planPerfChange({ cacheMode: 'save' })
  ok(p2.ok && p2.needsRestart === false, '只改缓存档 → 不需要重启')
  eq(p2.workflowOverrides.qwenCacheDevice, 'cpu', '★ 缓存档折算成 qwenCacheDevice')
  eq(p2.workflowOverrides.qwenCacheDtype, 'int8', '★ 缓存档折算成 qwenCacheDtype')
  ok(p2.notes.some((n) => n.includes('下次出图即生效')), 'note 明确说不用重启')

  const p3 = planPerfChange({ vramMode: 'save', cacheMode: 'ram' })
  ok(p3.needsRestart === true, '两个都改 → 仍标需要重启')
  eq(p3.cacheDevice, 'gpu', '两个都改时缓存档也生效')

  eq(planPerfChange({}).ok, false, '两个都不给 → ok:false')
  ok(planPerfChange({ vramMode: 'nope' }).reason.includes('没有这个显存档位'), '非法显存档位被拒并点名')
  ok(planPerfChange({ cacheMode: 'nope' }).reason.includes('没有这个缓存档位'), '非法缓存档位被拒并点名')

  const cur = describeCurrent({ vramMode: 'save', cacheDevice: 'auto', cacheDtype: 'int8' })
  eq(cur.vramMode, 'save', 'describeCurrent 认出显存档')
  eq(cur.cacheMode, 'balanced', '★ 从 device+dtype 反推出「均衡」档')
  const unknownCur = describeCurrent({ cacheDevice: 'weird', cacheDtype: 'x' })
  eq(unknownCur.cacheMode, '', '★ 认不出的组合返回空串，不硬套一个最像的档位')

  ok(PROGRESS_MODES.length === 3, 'G35 三档进度分级')
  eq(PROGRESS_MODES.map((m) => m.id).join(','), 'quiet,brief,detailed', '档位 id 与顺序固定')
  ok(PROGRESS_MODES[0].cost.includes('看不到'), '★ quiet 档如实说明会丢失里程碑信息')

  // G35 真的接进了日志层：三档各自放行哪些级别
  const seen = []
  const sink = {
    debug: (s) => seen.push(['debug', s]), info: (s) => seen.push(['info', s]),
    warn: (s) => seen.push(['warn', s]), error: (s) => seen.push(['error', s]),
  }
  const levelsFor = (mode) => {
    seen.length = 0
    const l = makeLog({ logger: sink }, mode)
    for (const lv of ['debug', 'info', 'warn', 'error']) l(lv, lv)
    return seen.map((x) => x[0]).join(',')
  }
  eq(levelsFor('quiet'), 'warn,error', '★ quiet 只放 warn/error')
  eq(levelsFor('brief'), 'info,warn,error', '★ brief 放 info 及以上')
  eq(levelsFor('detailed'), 'debug,info,warn,error', '★ detailed 全放')
  eq(levelsFor(undefined), 'info,warn,error', '★★ 没配 progressMode 时等价 brief —— 改造前后行为完全一致（不破坏既有用户）')
  eq(levelsFor('unknown-mode'), 'info,warn,error', '★ 拼错的档位退回 brief，不静默变哑巴')
  const prefixed = (() => {
    seen.length = 0
    makeLog({ logger: sink }, 'brief')('info', '出图开始')
    return seen[0]?.[1] ?? ''
  })()
  ok(prefixed.startsWith('[qwen-paint] '), '日志前缀保持不变（既有排错习惯不受影响）')
}

// ── 5. B9 缓存摘要 ──────────────────────────────────────────────────────────
console.log('\n=== 5. B9 缓存摘要 ===')
{
  eq(CACHE_SCOPE, 'comfy-node-cache', '★ 口径常量明确是「节点级缓存」')

  // 结构照真机 /history/<id>：prompt = [number, id, nodes, extra, outputIds]
  const rec = {
    prompt: [3, 'pid-1', {
      1: { class_type: 'UNETLoader', inputs: {} },
      2: { class_type: 'QwenImage21Cache', inputs: { device: 'cpu', dtype: 'int8', model: ['1', 0] } },
      3: { class_type: 'KSampler', inputs: {} },
      4: { class_type: 'VAEDecode', inputs: {} },
      5: { class_type: 'SaveImage', inputs: {} },
    }, { client_id: 'x' }, ['5']],
    status: {
      status_str: 'success', completed: true,
      messages: [
        ['execution_start', { prompt_id: 'pid-1', timestamp: 1000000 }],
        ['execution_cached', { nodes: ['1'], prompt_id: 'pid-1', timestamp: 1000001 }],
        ['execution_success', { prompt_id: 'pid-1', timestamp: 1012400 }],
      ],
    },
    outputs: {},
  }
  const s = summarizeCacheRun(rec)
  ok(s.ok, '正常记录 → ok:true')
  eq(s.total_nodes, 5, '数出 5 个节点')
  eq(s.cached_count, 1, '★ 从 execution_cached.nodes 读出命中 1 个')
  eq(s.cached_nodes.join(','), '1', '命中节点 id 保留')
  eq(s.executed_count, 4, '实际重算 4 个节点')
  eq(s.seconds, 12.4, '★ 用 execution_start/success 时间戳算出 12.4 秒')
  ok(s.cache.present, '认出图里有 QwenImage21Cache')
  eq(`${s.cache.device}+${s.cache.dtype}`, 'cpu+int8', '★ 从图里读本轮真实档位（不是从 config 猜）')
  ok(s.note.includes('节点级缓存'), '★ note 明说口径是节点级')
  ok(s.note.includes('不输出命中次数'), '★★ note 明说 QwenImage21Cache 不给 block 级数字（不编数据）')

  const noCache = summarizeCacheRun({ prompt: [1, 'p', { 1: { class_type: 'A', inputs: {} } }, {}, []],
    status: { messages: [['execution_start', { timestamp: 1 }], ['execution_success', { timestamp: 2001 }]] } })
  eq(noCache.cached_count, 0, '没有 execution_cached → 命中 0')
  ok(noCache.note.includes('首次跑这条链时正常'), '★ 0 命中时给出合理说明，不让用户误以为缓存坏了')
  ok(!noCache.cache.present, '图里没有缓存节点 → present:false')

  const dirty = summarizeCacheRun({ prompt: [1, 'p', { 1: { class_type: 'A', inputs: {} } }, {}, []],
    status: { messages: [['execution_cached', { nodes: ['1', '9', '99'] }]] } })
  eq(dirty.executed_count, 0, '★ 脏数据（缓存节点数 > 图上节点数）时 executed 兜到 0，不产出负数')

  const badTime = summarizeCacheRun({ prompt: [1, 'p', { 1: { class_type: 'A', inputs: {} } }, {}, []],
    status: { messages: [['execution_success', { timestamp: 100 }], ['execution_start', { timestamp: 500 }]] } })
  eq(badTime.seconds, null, '★ 时间戳倒挂时 seconds 为 null（不给出负耗时）')

  eq(summarizeCacheRun(null).ok, false, 'null 输入 → ok:false 不抛')
  eq(summarizeCacheRun({}).ok, false, '空对象 → ok:false 不抛')

  // 网络层
  const calls = []
  const fetchFn = (url, opt) => { calls.push({ url, opt }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ 'pid-1': rec }) }) }
  const online = await fetchCacheReport({ cfg: { comfyUrl: 'http://127.0.0.1:8188' }, fetchFn, promptId: 'pid-1' })
  ok(online.ok && online.cached_count === 1, '真拉一次能拿到摘要')
  ok(calls[0].url.endsWith('/history/pid-1'), '★ 打的是 /history/<prompt_id>')
  eq(calls[0].opt.timeoutMs, 5000, '带 5 秒超时（不为锦上添花的数字久等）')

  const noId = await fetchCacheReport({ cfg: { comfyUrl: 'http://x' }, fetchFn, promptId: '' })
  ok(!noId.ok && noId.note.includes('没有 prompt_id'), '没 prompt_id 时如实说明')

  const missingRec = await fetchCacheReport({
    cfg: { comfyUrl: 'http://x' }, promptId: 'other',
    fetchFn: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  })
  ok(!missingRec.ok && missingRec.note.includes('还没写出'), '记录还没落盘时说明是时序问题，不是失败')

  const http500 = await fetchCacheReport({
    cfg: { comfyUrl: 'http://x' }, promptId: 'p',
    fetchFn: () => Promise.resolve({ ok: false, status: 500 }),
  })
  ok(!http500.ok && http500.note.includes('HTTP 500'), 'HTTP 错误如实带状态码')
}

// ── 6. G34 恢复默认 ─────────────────────────────────────────────────────────
console.log('\n=== 6. G34 一键恢复默认 ===')
{
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const prefPath = path.join(outDir, PREF_FILE)
  const memPath = path.join(outDir, '.qwen-paint-memory.jsonl')
  fs.writeFileSync(prefPath, JSON.stringify({ size: '1024x1024', negative: '丑' }))
  fs.writeFileSync(memPath, '{"a":1}\n')

  const makeRes = () => { const r = { out: null }; r.setHeader = () => {}; r.end = () => {}; return r }
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const build = (cfgObj) => makeConfigHandlers({
    isLocalRequest: (req) => req.local !== false,
    guardWriteRequest: (req, res) => {
      if (String(req.method).toUpperCase() !== 'POST') { respondJson(res, { ok: false }, 405); return false }
      if (String(req.headers?.['content-type'] ?? '') !== 'application/json') { respondJson(res, { ok: false }, 415); return false }
      return true
    },
    respondJson, cfg: cfgObj, log,
    fetchFn: () => Promise.resolve({ ok: false, status: 0 }),
  })
  const run = async (h, req) => { const res = makeRes(); await h(req, res); return res.out }
  const h = build({ outputDir: outDir })

  const forbidden = await run(h.preferencesResetHandler,
    { method: 'POST', local: false, headers: { 'content-type': 'application/json' } })
  eq(forbidden.code, 403, '非本机 → 403')

  const getOnly = await run(h.preferencesResetHandler, { method: 'GET', local: true, headers: {} })
  eq(getOnly.code, 405, 'GET → 405')

  const noJson = await run(h.preferencesResetHandler, { method: 'POST', local: true, headers: { 'content-type': 'text/plain' } })
  eq(noJson.code, 415, '非 JSON → 415')

  const done = await run(h.preferencesResetHandler,
    { method: 'POST', local: true, headers: { 'content-type': 'application/json' } })
  eq(done.code, 200, '正常重置 → 200')
  eq(done.body.existed, true, '如实回报原来有偏好文件')
  eq(fs.existsSync(prefPath), false, '★ 偏好文件已从原位置移走')
  const backups = fs.readdirSync(outDir).filter((f) => f.startsWith(`${PREF_FILE}.bak-`))
  eq(backups.length, 1, '★ 备份文件存在（不是真删，手滑还能救回）')
  ok(fs.readFileSync(path.join(outDir, backups[0]), 'utf8').includes('1024x1024'), '备份内容完整')
  ok(fs.existsSync(memPath), '★★ 历史记忆 .jsonl 没被动（那不是"调坏的参数"）')
  ok(done.body.note.includes('改名'), 'note 告诉用户怎么恢复')

  const again = await run(h.preferencesResetHandler,
    { method: 'POST', local: true, headers: { 'content-type': 'application/json' } })
  eq(again.body.existed, false, '★ 第二次调用如实说本来就没有，不假装清成功')

  const noOut = build({ outputDir: '' })
  const noOutRes = await run(noOut.preferencesResetHandler,
    { method: 'POST', local: true, headers: { 'content-type': 'application/json' } })
  eq(noOutRes.code, 400, '没配输出目录 → 400')
  ok(String(noOutRes.body.reason).includes('输出目录未配置'), '原因明确')
}

// ── 7. 档位清单端点 ─────────────────────────────────────────────────────────
console.log('\n=== 7. 档位清单端点 ===')
{
  const respondJson = (res, body, code = 200) => { res.out = { code, body } }
  const h = makeConfigHandlers({
    isLocalRequest: (req) => req.local !== false,
    guardWriteRequest: () => true,
    respondJson, log,
    cfg: { vramMode: 'save', qwenCacheDevice: 'auto', qwenCacheDtype: 'int8', progressMode: 'brief' },
    fetchFn: () => Promise.resolve({ ok: false, status: 0 }),
  })
  const res = { out: null }
  await h.configOptionsHandler({ method: 'GET', url: '/api/qwen-paint/config/options', local: true }, res)
  eq(res.out.code, 200, 'GET 档位清单 → 200')
  eq(res.out.body.current.vramMode, 'save', '带出当前显存档')
  eq(res.out.body.current.cacheMode, 'balanced', '带出当前缓存档')
  ok(res.out.body.vram.length > 0 && res.out.body.cache.length > 0, '带出全部可选档位')
  ok(res.out.body.note.includes('只读'), '★★ note 明说这是只读端点（不假装能写）')
  ok(res.out.body.note.includes('DSH'), 'note 指出该去哪儿改')

  const forbiddenRes = { out: null }
  await h.configOptionsHandler({ method: 'GET', local: false }, forbiddenRes)
  eq(forbiddenRes.out.code, 403, '非本机 → 403')

  const noIdRes = { out: null }
  await h.cacheReportHandler({ method: 'GET', url: '/api/qwen-paint/cache-report', local: true }, noIdRes)
  eq(noIdRes.out.code, 400, '缓存摘要缺 prompt_id → 400')

  const table = configRouteTable(h)
  const paths = table.map(([p]) => p).sort()
  eq(paths.join(' , '), [
    '/api/qwen-paint/cache-report',
    '/api/qwen-paint/config/options',
    '/api/qwen-paint/contracts',
    '/api/qwen-paint/eta',
    // 2026-11-14：清单总览（A1/A3/D26）、参数表（D23）、字幕（D19）、
    // 后处理计划（A2）、显存建议（B4）、契约对账（A1）、实测秒数（E27）挂同一张表。
    '/api/qwen-paint/params',
    '/api/qwen-paint/preferences/reset',
    '/api/qwen-paint/subtitle',
    '/api/qwen-paint/video/post',
    '/api/qwen-paint/vram-advice',
    '/api/qwen-paint/workflows',
  ].sort().join(' , '), '★ 路由表逐字相等（新增端点必须显式登记）')
  ok(table.every(([, fn]) => typeof fn === 'function'), '每条路由都绑了 handler')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\ntest-perf-config: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
