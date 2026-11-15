/* assets/lab.js —— 本机能力功能区（非 ESM，`<script defer>` 单文件，与 panel.js 同口径）
 *
 * ★★ 2026-11-15（用户第三次强调）：**不再有「实验室」这个独立 UI**。
 *   旧版会造一个 .dshqp-lab-fab 浮标 + .dshqp-lab-mask fixed 悬浮窗，
 *   即使 DOM 挂在 panel 下，视觉上仍是第二个浮窗、还要自己算 left/top/width。
 *   现在：只造一组普通的功能区 section，由 panel.js 直接 append 进
 *   `cp-panel` 的 `[data-dshqp-lab-slot]` 插槽 —— 它就是 Comfy 控制面板的一部分，
 *   宽度/贴边/主题全由面板决定。**找不到插槽就不挂载，绝不降级挂 body。**
 *
 * ## 硬约束
 *   · 四事件点按 + 300ms 冷却 + **document capture 兜底**：DSH 宿主会吞 click，
 *     还会把节点上的指针事件一起吞掉；只绑 node 就会出现「按键又点不动」。
 *     现在 node 直连与 document capture 委托共用同一个时间戳，无论如何只触发一次。
 *   · 绝不拼接原始 HTML 字符串：结果一律 createElement + textContent，杜绝注入面。
 *   · 不加载任何外部 URL：脚本 / 样式由 panel.js 按 id 去重挂 head 懒加载。
 *   · 所有请求只打本机 api/qwen-paint/... 前缀，异常只回固定文案，不回吐 error.message。
 *
 * ## doctor 观感硬要求
 *   默认只显示一行简略结论（健康检查 ok / 异常 / 未给出结论）；
 *   用户点「展开详情」才去拉 wizard + integration/state 并展开详情容器。
 */
(function () {
  'use strict'
  if (window.DshQpLab && window.DshQpLab.__lab === true) return

  var API = 'api/qwen-paint/'
  var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']
  var COOLDOWN_MS = 300
  var MAX_RESULT_CHARS = 4000
  var tapRegistry = []
  var fallbackInstalled = false

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function findEntry(node) {
    for (var i = 0; i < tapRegistry.length; i += 1) {
      if (tapRegistry[i].node === node) return tapRegistry[i]
    }
    return null
  }

  /** node 直连与 document capture 委托共用同一 entry.last：只触发一次。 */
  function tap(node, fn) {
    if (!node || typeof node.addEventListener !== 'function') return
    if (typeof node.setAttribute === 'function') node.setAttribute('data-dshqp-direct', '1')
    var entry = { node: node, fn: fn, last: 0 }
    tapRegistry.push(entry)
    var run = function (ev) {
      var now = Date.now()
      if (now - entry.last < COOLDOWN_MS) return
      entry.last = now
      fn(ev)
    }
    for (var i = 0; i < TAP_UP.length; i += 1) node.addEventListener(TAP_UP[i], run)
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        entry.last = Date.now()
        fn(ev)
      }
    })
  }

  /** ★ 2026-11-14：DSH 宿主会在 document capture 阶段吞掉指针事件，
   *  只绑 node 会出现「按键点不动」。这里在 capture 上统一委托（沿父链最多 6 层找按钮），
   *  与 node 直连共享 300ms 冷却，绝不会双触发。
   */
  function installTapFallback() {
    if (fallbackInstalled || typeof document.addEventListener !== 'function') return
    fallbackInstalled = true
    for (var k = 0; k < TAP_UP.length; k += 1) {
      (function (type) {
        try {
          document.addEventListener(type, function (ev) {
            var node = ev && ev.target
            var entry = null
            for (var guard = 0; node && guard < 6; guard += 1) {
              entry = findEntry(node)
              if (entry) break
              node = node.parentNode || null
            }
            if (!entry) return
            var now = Date.now()
            if (now - entry.last < COOLDOWN_MS) return
            entry.last = now
            entry.fn(ev)
          }, true)
        } catch (err) { /* 单个事件源不可用不影响其它 */ }
      })(TAP_UP[k])
    }
  }

  /** 只打本机 api/qwen-paint/... ；绝不拼接外部 URL。 */
  function request(pathPart, init) {
    var f = (typeof window !== 'undefined' && typeof window.fetch === 'function')
      ? window.fetch
      : (typeof fetch === 'function' ? fetch : null)
    if (!f) return Promise.resolve({ ok: false, reason: '本机 fetch 不可用' })
    var url = API + pathPart
    return f(url, init || {}).then(function (r) {
      return (r && typeof r.json === 'function') ? r.json() : null
    }).catch(function () {
      return { ok: false, reason: '本机请求失败（详见插件日志）' }
    })
  }

  /** 结果展示：逐行 createElement + textContent，绝不拼原始 HTML 字符串；过长截断。 */
  function renderResult(target, data) {
    if (!target) return
    while (target.firstChild && typeof target.removeChild === 'function') {
      target.removeChild(target.firstChild)
    }
    var text = ''
    try { text = JSON.stringify(data, null, 2) } catch (err) { text = String(data) }
    if (text === undefined || text === null || text === '') text = '（无返回内容）'
    text = String(text)
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n…（已截断）'
    var lines = text.split('\n')
    for (var i = 0; i < lines.length; i += 1) {
      target.appendChild(el('div', 'dshqp-lab-line', lines[i]))
    }
  }

  function emptyResult(target, hint) {
    if (target) target.appendChild(el('div', 'dshqp-lab-line dshqp-lab-empty', hint))
  }

  var els = {}
  var doctorOpen = false
  var doctorLoaded = false

  function doctorBrief(health) {
    if (!health || typeof health !== 'object') return 'doctor：未检测到健康检查结论'
    if (health.ok === true) return 'doctor：本机健康检查正常'
    if (health.ok === false) return 'doctor：本机健康检查异常'
    return 'doctor：健康检查未给出结论'
  }

  function loadDoctorBrief() {
    return request('health').then(function (j) {
      if (els.doctorLine) els.doctorLine.textContent = doctorBrief(j)
    })
  }
  function loadDoctorDetail() {
    return Promise.all([
      request('doctor?detail=1'), request('wizard'), request('integration/state'),
    ]).then(function (trio) {
      renderResult(els.doctorDetail, {
        doctor: trio[0],
        probe_contract: (trio[0] && trio[0].probe_contract) || [],
        wizard: trio[1], state: trio[2],
      })
    })
  }

  function makeSection(titleText) {
    var sec = el('section', 'dshqp-lab-sec')
    sec.appendChild(el('div', 'dshqp-lab-sec-title', titleText))
    var row = el('div', 'dshqp-lab-row')
    var body = el('div', 'dshqp-lab-body')
    var result = el('div', 'dshqp-lab-result')
    // 顺序 appendChild 即可，不依赖 insertBefore（假 DOM / 精简宿主也能挂载）。
    sec.appendChild(row)
    sec.appendChild(body)
    sec.appendChild(result)
    emptyResult(result, '点上面的按钮查看结果。')
    return { sec: sec, row: row, body: body, result: result }
  }

  function button(labelText, ghost, fn) {
    var b = el('button', ghost ? 'dshqp-lab-btn dshqp-lab-btn-ghost' : 'dshqp-lab-btn', labelText)
    b.type = 'button'
    tap(b, fn)
    return b
  }

  function labeledInput(labelText, placeholder) {
    var wrap = el('label', 'dshqp-lab-row')
    wrap.appendChild(el('span', 'dshqp-lab-label', labelText))
    var input = el('input', 'dshqp-lab-input')
    input.type = 'text'
    if (placeholder) input.setAttribute('placeholder', placeholder)
    wrap.appendChild(input)
    return { wrap: wrap, input: input }
  }

  function gifBody() {
    var body = { target: String(els.gifTarget.value || '').trim() }
    var seq = String(els.gifSources.value || '').trim()
    if (seq) {
      body.sources = seq.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    } else {
      body.source = String(els.gifSource.value || '').trim()
    }
    var fps = Number(els.gifFps.value)
    if (Number.isFinite(fps) && fps > 0) body.fps = fps
    return body
  }

  /** ★ 2026-11-15：不再造独立浮层，只造一组可嵌进 cp-panel 插槽的功能区。
   *  无 mask / 无 fab / 无关闭按钮：面板自己的 × 就是唯一关闭入口。 */
  function buildSections() {
    var box = el('div', 'dshqp-lab-sections')
    try { box.setAttribute('data-dshqp-lab-theme', detectDark() ? 'dark' : 'light') } catch (err) { /* 忽略 */ }

    var head = el('div', 'dshqp-lab-head')
    head.appendChild(el('div', 'dshqp-lab-title', '本机能力 · 加速链 / 诊断 / 工具'))
    box.appendChild(head)

    /* ---- doctor：默认一行简略结论，详情默认 hidden ---- */
    var doctor = makeSection('doctor · 健康检查')
    els.doctorLine = el('div', 'dshqp-lab-doctor-line', 'doctor：正在读取简略结论…')
    // 简略结论就是一行；详情容器初始 hidden，点开才展开。
    doctor.body.appendChild(els.doctorLine)
    els.doctorDetail = el('div', 'dshqp-lab-doctor-detail dshqp-lab-result')
    els.doctorDetail.hidden = true
    doctor.body.appendChild(els.doctorDetail)
    els.doctorToggle = button('展开详情', true, function () {
      doctorOpen = !doctorOpen
      els.doctorDetail.hidden = !doctorOpen
      els.doctorToggle.textContent = doctorOpen ? '收起详情' : '展开详情'
      if (doctorOpen && !doctorLoaded) {
        doctorLoaded = true
        emptyResult(els.doctorDetail, '正在读取详情…')
        loadDoctorDetail()
      }
    })
    doctor.row.appendChild(els.doctorToggle)
    doctor.row.appendChild(button('刷新简略', true, function () { loadDoctorBrief() }))
    box.appendChild(doctor.sec)

    /* ---- 加速链：生图/视频缓存后端 + TTS 加速后端（用户点名「TTS 不在加速链里」） ---- */
    var accel = makeSection('加速链 · 生图/视频缓存 + TTS 加速')
    accel.row.appendChild(button('查看加速链', false, function () {
      emptyResult(accel.result, '正在读取加速链…')
      request('accel/chain').then(function (j) { renderResult(accel.result, j) })
    }))
    box.appendChild(accel.sec)

    /* ---- GIF 转换 ---- */
    var gif = makeSection('GIF 转换 · 单图 / 序列 / 视频')
    var srcIn = labeledInput('source', '本机图片或视频路径')
    var seqIn = labeledInput('sources（逗号分隔，填了优先）', 'a.png, b.png')
    var tgtIn = labeledInput('target', 'out.gif')
    var fpsIn = labeledInput('fps', '12')
    els.gifSource = srcIn.input
    els.gifSources = seqIn.input
    els.gifTarget = tgtIn.input
    els.gifFps = fpsIn.input
    gif.body.appendChild(srcIn.wrap)
    gif.body.appendChild(seqIn.wrap)
    gif.body.appendChild(tgtIn.wrap)
    gif.body.appendChild(fpsIn.wrap)
    gif.row.appendChild(button('查看能力', true, function () {
      request('media/gif/capabilities').then(function (j) { renderResult(gif.result, j) })
    }))
    gif.row.appendChild(button('转换', false, function () {
      emptyResult(gif.result, '正在请求转换…')
      request('media/gif', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(gifBody()),
      }).then(function (j) { renderResult(gif.result, j) })
    }))
    box.appendChild(gif.sec)

    /* ---- 媒体格式转换：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC；
       也支持动图转视频与用户自有素材。生成物可用「输出格式预设」让每次生成自动后转码。 ---- */
    var media = makeSection('媒体格式转换 · 生成物 / 自有素材 / 动图转视频')
    var mSrc = labeledInput('source（公布目录内的文件名或路径）', 'a.png')
    var mFmt = labeledInput('format（jpg/png/webp/mp4/mkv/mov/webm/mp3/aac/wav/flac）', 'webp')
    var mTgt = labeledInput('target（可留空自动命名）', 'a_converted.webp')
    var mKind = labeledInput('source_kind（可留空；动图 WebP 填 animated）', '')
    els.mediaSource = mSrc.input
    els.mediaFormat = mFmt.input
    els.mediaTarget = mTgt.input
    els.mediaKind = mKind.input
    media.body.appendChild(mSrc.wrap)
    media.body.appendChild(mFmt.wrap)
    media.body.appendChild(mTgt.wrap)
    media.body.appendChild(mKind.wrap)
    media.row.appendChild(button('查看格式表', true, function () {
      emptyResult(media.result, '正在读取格式表与 ffmpeg 能力…')
      request('media/formats').then(function (j) { renderResult(media.result, j) })
    }))
    media.row.appendChild(button('转换', false, function () {
      var body = {
        source: String(els.mediaSource.value || '').trim(),
        format: String(els.mediaFormat.value || '').trim(),
      }
      var tgt = String(els.mediaTarget.value || '').trim()
      if (tgt) body.target = tgt
      var kind = String(els.mediaKind.value || '').trim()
      if (kind) body.source_kind = kind
      emptyResult(media.result, '正在请求转换…')
      request('media/convert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (j) { renderResult(media.result, j) })
    }))
    media.row.appendChild(button('设为默认输出格式', true, function () {
      var kind = String(els.mediaKind.value || '').trim()
      // 未显式给类别时按目标格式推断，避免把视频格式设到 image 上被端点拒绝。
      if (!kind) {
        var f = String(els.mediaFormat.value || '').trim().toLowerCase()
        if (f === 'jpg' || f === 'jpeg' || f === 'png' || f === 'webp') kind = 'image'
        else if (f === 'mp4' || f === 'mkv' || f === 'mov' || f === 'webm') kind = 'video'
        else kind = 'audio'
      }
      emptyResult(media.result, '正在设置默认输出格式…')
      request('media/formats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind, format: String(els.mediaFormat.value || '').trim() }),
      }).then(function (j) { renderResult(media.result, j) })
    }))
    media.row.appendChild(button('清除预设', true, function () {
      var kind = String(els.mediaKind.value || '').trim() || 'image'
      request('media/formats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind, clear: true }),
      }).then(function (j) { renderResult(media.result, j) })
    }))
    box.appendChild(media.sec)

    /* ---- 队列 ---- */
    var queue = makeSection('队列 · 任务状态')
    queue.row.appendChild(button('刷新队列', false, function () {
      request('status.json').then(function (j) { renderResult(queue.result, j) })
    }))
    box.appendChild(queue.sec)

    /* ---- 显存预算：每个子任务独立可选 0/2/4/8/12/16/24 GB 或无上限 ---- */
    var budget = makeSection('显存预算 · 每个子任务独立上限')
    var kindIn = labeledInput('子任务 kind（image/video/tts/upscale/inpaint/batch）', 'image')
    var gbIn = labeledInput('档位（0 / 2 / 4 / 8 / 12 / 16 / 24 / unlimited）', '8')
    budget.body.appendChild(kindIn.wrap)
    budget.body.appendChild(gbIn.wrap)
    budget.row.appendChild(button('查看档位表', true, function () {
      request('vram-budget').then(function (j) { renderResult(budget.result, j) })
    }))
    budget.row.appendChild(button('设置上限', false, function () {
      var raw = String(gbIn.input.value || '').trim()
      var gb = (raw === '' || raw === 'unlimited' || raw === 'none' || raw === 'null') ? null : Number(raw)
      emptyResult(budget.result, '正在设置…')
      request('vram-budget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: String(kindIn.input.value || 'image').trim(), gb: gb }),
      }).then(function (j) { renderResult(budget.result, j) })
    }))
    budget.row.appendChild(button('探测到的能力', true, function () {
      request('capabilities').then(function (j) { renderResult(budget.result, j) })
    }))
    box.appendChild(budget.sec)

    /* ---- 结构化日志：JSON Lines 落盘、可统计 ---- */
    var events = makeSection('结构化日志 · 生成事件（JSON Lines）')
    events.row.appendChild(button('查看统计与最近事件', false, function () {
      emptyResult(events.result, '正在读取结构化日志…')
      request('events').then(function (j) { renderResult(events.result, j) })
    }))
    box.appendChild(events.sec)

    /* ---- 配置项矛盾：只读报告，不自动改配置 ---- */
    var conflicts = makeSection('配置矛盾 · 只读报告')
    conflicts.row.appendChild(button('检查配置矛盾', false, function () {
      emptyResult(conflicts.result, '正在检查…')
      request('config/conflicts').then(function (j) { renderResult(conflicts.result, j) })
    }))
    box.appendChild(conflicts.sec)

    /* ---- 工作流契约 / ETA：让 /contracts 与 /eta 两个端点有真实前端消费者 ---- */
    var chain = makeSection('链契约与 ETA · 生图 / TTS')
    chain.row.appendChild(button('契约清单', false, function () {
      emptyResult(chain.result, '正在读取契约清单…')
      request('contracts').then(function (j) { renderResult(chain.result, j) })
    }))
    chain.row.appendChild(button('生图链真构图核对', true, function () {
      emptyResult(chain.result, '正在按当前配置构图并逐槽位核对…')
      request('contracts?build=1&id=image-qwen21').then(function (j) { renderResult(chain.result, j) })
    }))
    chain.row.appendChild(button('本机实测 ETA', true, function () {
      emptyResult(chain.result, '正在读取本机实测秒数（没样本会是 null）…')
      request('eta').then(function (j) { renderResult(chain.result, j) })
    }))
    box.appendChild(chain.sec)

    /* ---- DAG ---- */
    var dag = makeSection('DAG · 工作流')
    dag.row.appendChild(button('查看 DAG', false, function () {
      request('workflows').then(function (j) { renderResult(dag.result, j) })
    }))
    box.appendChild(dag.sec)

    return box
  }

  function detectDark() {
    try {
      var t = window.DshQpTheme || (window.ComfyPipelinePanel && window.ComfyPipelinePanel.theme)
      if (t === 'dark') return true
      if (t === 'light') return false
    } catch (err) { /* 忽略 */ }
    return false
  }

  /** 从当前（可能是 rebuild 后的）Comfy 控制面板里找插槽，绝不缓存旧节点。 */
  function findSlot() {
    try {
      var p = window.ComfyPipelinePanel
      if (p && typeof p.getPanelNode === 'function') {
        var panel = p.getPanelNode()
        if (panel && typeof panel.querySelector === 'function') {
          return panel.querySelector('[data-dshqp-lab-slot="1"]')
        }
      }
    } catch (err) { /* 忽略 */ }
    return null
  }

  /** ★ 2026-11-15：把功能区**直接嵌进** cp-panel 的插槽。
   *  没有插槽时返回 false 且什么都不挂 —— 绝不降级到 body 变成第二个浮窗。
   *  rebuild() 换掉 panel 后，panel.js 会再次调用本函数把同一个节点搬过去。
   */
  function mountInto(host) {
    if (!host || typeof host.appendChild !== 'function') return false
    if (!els.sections) els.sections = buildSections()
    try {
      if (els.sections.parentNode !== host) host.appendChild(els.sections)
      els.host = host
      installTapFallback()
      loadDoctorBrief()
      return true
    } catch (err) { return false }
  }

  function mount() {
    if (typeof document === 'undefined') return
    installTapFallback()
    var slot = findSlot()
    if (slot) mountInto(slot)
    // 没有插槽就静默等待：panel.js 的 render() 与 lab.js onload 都会主动 mountInto。
  }

  window.DshQpLab = {
    __lab: true,
    mountInto: mountInto,
    // 兼容旧调用名，但语义已是「嵌进插槽」而非「创建浮层」。
    attach: function (host) { return mountInto(host) },
    refresh: function () { loadDoctorBrief() },
    isDoctorDetailOpen: function () { return doctorOpen === true },
    isAttached: function () { return Boolean(els.sections && els.sections.parentNode) },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
}())
