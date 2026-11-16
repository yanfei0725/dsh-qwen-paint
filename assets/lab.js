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

  // ★ 2026-11-16 UI 收敛：22 个 section 按职责归入四组折叠，避免一屏糊成一片。
  //   分组只按标题关键词判定（纯函数，可离线测），不改任何端点/业务代码。
  var LAB_GROUPS = [
    { id: 'diag', label: '诊断 · 本机状态', open: true },
    { id: 'tool', label: '工具 · 转换与编辑', open: true },
    { id: 'ops', label: '运维 · 队列与资源', open: false },
    { id: 'voice', label: '语音 · 后端与音色', open: false },
  ]
  // 顺序敏感：先匹配到的组胜出。未命中一律落 tool（兜底，不丢 section）。
  var GROUP_RULES = [
    ['voice', /音色|TTS|语音|ASR|字幕|BGM|缝合|旁白/u],
    ['ops', /队列|显存|Worker|DAG|工作流/u],
    ['diag', /doctor|健康检查|加速链|配置矛盾|契约|ETA|结构化日志|诊断/u],
  ]
  function labGroupOf(title) {
    var t = String(title ?? '')
    for (var i = 0; i < GROUP_RULES.length; i += 1) {
      if (GROUP_RULES[i][1].test(t)) return GROUP_RULES[i][0]
    }
    return 'tool'
  }

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
  // ★ 2026-11-16 性能：panel.js 切模式 rebuild() 会反复 mountInto()，
  //   旧代码每次都拉 /health ⇒ 一次切模式多次请求。简短结论首次挂载拉一次即可，
  //   用户点「刷新简略」或 window.DshQpLab.refresh() 仍可显式重拉。
  var briefLoaded = false

  function doctorBrief(health) {
    if (!health || typeof health !== 'object') return 'doctor：未检测到健康检查结论'
    if (health.ok === true) return 'doctor：本机健康检查正常'
    if (health.ok === false) return 'doctor：本机健康检查异常'
    return 'doctor：健康检查未给出结论'
  }

  var briefRetryTimer = null
  function loadDoctorBrief(force) {
    // ★ 2026-11-16 P2：旧代码请求前就置 briefLoaded=true，失败后永不重试；
    //   改成只在成功时锁定，失败显示错误态并延迟自动重试一次。
    if (briefLoaded && force !== true && force !== 'retry') return Promise.resolve(null)
    if (briefRetryTimer !== null) { clearTimeout(briefRetryTimer); briefRetryTimer = null }
    return request('health').then(function (j) {
      briefLoaded = true
      if (els.doctorLine) els.doctorLine.textContent = doctorBrief(j)
      return j
    }).catch(function () {
      if (els.doctorLine) els.doctorLine.textContent = 'doctor：本机健康检查暂时取不到（稍后自动重试）'
      if (force !== 'retry') {
        briefRetryTimer = setTimeout(function () {
          briefRetryTimer = null
          loadDoctorBrief('retry')
        }, 3000)
      }
      return null
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

  /**
   * 把 box 直属的 section 移进四组 <details>。纯 DOM 移动：createElement + appendChild，
   * 不拼原始 HTML 串、不新建/复制任何业务节点 ⇒ 端点字面量与事件绑定逐字不变。
   * 幂等：重复调用时若已有分组容器，直接返回（mountInto 可能被多次触发）。
   */
  function groupSections(box) {
    if (!box || box.__labGrouped === true) return box
    var secs = []
    for (var i = 0; i < box.children.length; i += 1) {
      var node = box.children[i]
      if (node.className && String(node.className).indexOf('dshqp-lab-sec') >= 0) secs.push(node)
    }
    if (secs.length === 0) return box
    var buckets = {}
    LAB_GROUPS.forEach(function (g) { buckets[g.id] = [] })
    secs.forEach(function (sec) {
      var titleNode = sec.querySelector ? sec.querySelector('.dshqp-lab-sec-title') : null
      var title = titleNode ? titleNode.textContent : ''
      var g = labGroupOf(title)
      sec.setAttribute('data-lab-group', g)
      buckets[g].push(sec)
    })
    LAB_GROUPS.forEach(function (g) {
      var wrap = el('details', 'dshqp-lab-group')
      wrap.setAttribute('data-lab-group', g.id)
      if (g.open) wrap.setAttribute('open', '')
      var sum = el('summary', 'dshqp-lab-group-title', g.label + '（' + buckets[g.id].length + '）')
      wrap.appendChild(sum)
      buckets[g.id].forEach(function (sec) { wrap.appendChild(sec) })
      box.appendChild(wrap)
    })
    box.__labGrouped = true
    return box
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
    doctor.row.appendChild(button('刷新简略', true, function () { loadDoctorBrief(true) }))
    box.appendChild(doctor.sec)

    /* ---- 加速链：缓存 + TTS + 注意力/编译后端（★ 卡片常驻显示两个后端，不再藏在按钮后面） ---- */
    var accel = makeSection('加速链 · 缓存 / TTS / SageAttention / WaveSpeed')
    var accelLine = el('div', 'dshqp-lab-line dshqp-lab-empty', '正在读取加速链…')
    accel.body.appendChild(accelLine)
    function paintAccelLine(j) {
      var ab = j && j.attention_backends
      if (!ab) {
        accelLine.textContent = '加速链暂不可用（本机未返回后端状态）'
        accelLine.className = 'dshqp-lab-line'
        return
      }
      var rows = (ab.available || []).map(function (b) {
        return (b.label || b.id) + '：' + (b.available ? '已探测到节点' : '未探测到节点')
      })
      var probeText = j.probe && j.probe.source === 'object_info'
        ? '已真实探测 ' + j.probe.nodeCount + ' 个节点'
        : '未做真实探测（' + ((j.probe && j.probe.reason) || '本机未返回节点表') + '）'
      accelLine.textContent = rows.join(' ｜ ')
        + ' ｜ 当前启用：' + (ab.enabled || '无（默认不启用，生成链不变）')
        + ' ｜ 节点表：' + probeText
        + (ab.needsSlotMapping ? ' ｜ 节点槽位未核实' : '')
      accelLine.className = 'dshqp-lab-line'
    }
    function refreshAccelLine() {
      request('accel/chain').then(paintAccelLine)
    }
    refreshAccelLine()

    accel.row.appendChild(button('查看加速链', false, function () {
      emptyResult(accel.result, '正在读取加速链…')
      request('accel/chain').then(function (j) {
        renderResult(accel.result, j)
        paintAccelLine(j)
      })
    }))
    accel.row.appendChild(button('后端详情 / 工作流补丁', true, function () {
      emptyResult(accel.result, '正在探测 SageAttention / Comfy-WaveSpeed…')
      request('accel/backends').then(function (j) { renderResult(accel.result, j) })
    }))
    function setAttention(id) {
      emptyResult(accel.result, '正在切换加速后端…')
      request('accel/backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: id })
      }).then(function (j) {
        renderResult(accel.result, j)
        refreshAccelLine()
      })
    }
    accel.row.appendChild(button('启用 SageAttention', true, function () { setAttention('sage_attention') }))
    accel.row.appendChild(button('启用 WaveSpeed', true, function () { setAttention('wavespeed') }))
    accel.row.appendChild(button('恢复默认（不启用）', true, function () { setAttention('') }))
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

    /* ---- 媒体后处理（2026-11-16 内置最小实现）：音频后处理 / 无模型抠图 / 中置相消声源分离。
       纯 ffmpeg 零模型零下载；未探测到 ffmpeg 时端点如实回参数预览与降级原因。 ---- */
    var fx = makeSection('媒体后处理 · 音频增强 / 抠图 / 声源分离')
    var fxTool = labeledInput('工具（enhance_audio / cutout_image / split_audio）', 'enhance_audio')
    var fxSrc = labeledInput('source（公布目录内的文件名或路径）', 'a.mp3')
    var fxTgt = labeledInput('target / 抠图也可填（可留空自动命名）', 'a_enhanced.m4a')
    var fxPreset = labeledInput('preset（voice/music/podcast；抠图填 key_color）', 'voice')
    fx.body.appendChild(fxTool.wrap)
    fx.body.appendChild(fxSrc.wrap)
    fx.body.appendChild(fxTgt.wrap)
    fx.body.appendChild(fxPreset.wrap)
    fx.row.appendChild(button('查看能力', true, function () {
      emptyResult(fx.result, '正在读取媒体后处理能力…')
      request('media-fx/capabilities').then(function (j) { renderResult(fx.result, j) })
    }))
    fx.row.appendChild(button('执行', false, function () {
      var tool = String(fxTool.input.value || '').trim()
      var opt = String(fxPreset.input.value || '').trim()
      var body = { source: String(fxSrc.input.value || '').trim() }
      var tgt = String(fxTgt.input.value || '').trim()
      var reqOpt = { method: 'POST', headers: { 'content-type': 'application/json' } }
      // 三个端点写成字面量调用（不拼变量）：test-gif 的端点白名单能静态逐字看到，判据不放宽。
      if (tool === 'cutout_image') {
        if (tgt) body.target = tgt
        if (opt) body.key_color = opt
        reqOpt.body = JSON.stringify(body)
        emptyResult(fx.result, '正在请求' + tool + '…')
        request('cutout/image', reqOpt).then(function (j) { renderResult(fx.result, j) })
      } else if (tool === 'split_audio') {
        if (tgt) body.vocals_target = tgt
        reqOpt.body = JSON.stringify(body)
        emptyResult(fx.result, '正在请求' + tool + '…')
        request('split/audio', reqOpt).then(function (j) { renderResult(fx.result, j) })
      } else {
        if (tgt) body.target = tgt
        if (opt) body.preset = opt
        reqOpt.body = JSON.stringify(body)
        emptyResult(fx.result, '正在请求' + tool + '…')
        request('enhance/audio', reqOpt).then(function (j) { renderResult(fx.result, j) })
      }
    }))
    box.appendChild(fx.sec)

    /* ---- 音频转文字（2026-11-16）：复用 asr-client 的 transcribeAudio。
       插件不内置/不代装 ASR 运行时；没配 asrUrl 就回自检步骤，不假装能转。 ---- */
    var tr = makeSection('音频转文字 · ASR 字幕')
    var trAudio = labeledInput('audio（出图目录内音频文件名或路径）', 'narration.mp3')
    var trFmt = labeledInput('format（json / srt / vtt）', 'json')
    tr.body.appendChild(trAudio.wrap)
    tr.body.appendChild(trFmt.wrap)
    tr.row.appendChild(button('查看 ASR 能力', true, function () {
      emptyResult(tr.result, '正在读取 ASR 配置…')
      request('audio/transcribe/capabilities').then(function (j) { renderResult(tr.result, j) })
    }))
    tr.row.appendChild(button('转文字', false, function () {
      var body = {
        audio: String(trAudio.input.value || '').trim(),
        format: String(trFmt.input.value || 'json').trim() || 'json',
      }
      emptyResult(tr.result, '正在转写…')
      // 字面量端点（test-gif 静态白名单可逐字审计）。
      request('audio/transcribe', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).then(function (j) { renderResult(tr.result, j) })
    }))
    box.appendChild(tr.sec)

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

    /* ---- 语音后端：用户选模型（第三方节点只探测，不假装已装） ---- */
    var ttsB = makeSection('语音后端 · Qwen3-TTS / GPT-SoVITS v5 / IndexTTS2')
    ttsB.body.appendChild(el('div', 'dshqp-lab-note',
      'GPT-SoVITS v5 分「原版 dev」与「蒸馏版 turbo」；第三方节点需自行安装。未探测到会明确标不可用，插件不自动下载权重。'))
    ttsB.row.appendChild(button('查看后端与探测状态', false, function () {
      emptyResult(ttsB.result, '正在读取后端清单…')
      request('tts/backends').then(function (j) { renderResult(ttsB.result, j) })
    }))
    box.appendChild(ttsB.sec)

    /* ---- 音色样本：拖入 MP3 等音频 → 零样本参考克隆（不训练权重） ---- */
    var vs = makeSection('音色样本 · 拖入音频做新音色')
    vs.body.appendChild(el('div', 'dshqp-lab-note',
      '拖入 MP3 / WAV / FLAC 等音频作为参考样本，交给 TTS 复刻音色。这是零样本参考克隆，不训练、不微调、不产出权重文件；样本只落在出图目录内。'))
    var vsDrop = el('div', 'dshqp-lab-drop', '把音频拖到这里，或点「选择文件」')
    var vsFile = el('input', 'dshqp-lab-file')
    try {
      vsFile.setAttribute('type', 'file')
      vsFile.setAttribute('accept', '.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.webm,.mp4,.aiff')
    } catch (err) { /* 忽略 */ }
    var vsId = labeledInput('样本 id（删除时填）', 'vs-...')
    vs.body.appendChild(vsDrop)
    vs.body.appendChild(vsFile)
    vs.body.appendChild(vsId.wrap)
    function loadSamples() {
      request('audio/samples').then(function (j) { renderResult(vs.result, j) })
    }
    function uploadSample(file) {
      if (!file) return
      try {
        var reader = new FileReader()
        reader.onload = function () {
          var dataUrl = String(reader.result || '')
          var b64 = dataUrl.indexOf(',') >= 0 ? dataUrl.split(',')[1] : ''
          emptyResult(vs.result, '正在登记音频样本…')
          request('audio/samples', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'register', name: file.name, size: file.size, data_base64: b64 }),
          }).then(function (j) { renderResult(vs.result, j); loadSamples() })
        }
        reader.readAsDataURL(file)
      } catch (err) { emptyResult(vs.result, '读取音频失败（详见插件日志）') }
    }
    try {
      ;['dragenter', 'dragover'].forEach(function (evt) {
        vsDrop.addEventListener(evt, function (e) { try { e.preventDefault() } catch (err) { /* 忽略 */ } })
      })
      vsDrop.addEventListener('drop', function (e) {
        try { e.preventDefault() } catch (err) { /* 忽略 */ }
        var f = e && e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null
        uploadSample(f)
      })
      vsFile.addEventListener('change', function () { uploadSample(vsFile.files && vsFile.files[0]) })
    } catch (err) { /* 忽略 */ }
    vs.row.appendChild(button('列出样本', true, loadSamples))
    vs.row.appendChild(button('删除样本', true, function () {
      var id = String(vsId.input.value || '').trim()
      if (!id) { emptyResult(vs.result, '请先填样本 id'); return }
      emptyResult(vs.result, '正在删除样本…')
      request('audio/samples', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: id }),
      }).then(function (j) { renderResult(vs.result, j); loadSamples() })
    }))
    box.appendChild(vs.sec)

    /* ---- 参考图色调：浏览器 canvas 采样 32×32 → 主色 / 冷暖 / 一句可拼进提示词的话 ---- */
    var tn = makeSection('参考图色调 · 取主色写进提示词')
    tn.body.appendChild(el('div', 'dshqp-lab-note',
      '选一张参考图，浏览器把它缩到 32×32 采样，只算色调（主色名 / 冷暖 / 饱和 / 明度）并给一句可直接拼进提示词的话。'
      + '只做色调，不猜构图、光影、材质 —— 那些要靠视觉模型或 IP-Adapter，本插件不引额外权重，也不假装能看懂画面。'))
    var tnFile = el('input', 'dshqp-lab-file')
    try {
      tnFile.setAttribute('type', 'file')
      tnFile.setAttribute('accept', 'image/*')
    } catch (err) { /* 忽略 */ }
    var tnSwatch = el('div', 'dshqp-lab-swatch')
    tn.body.appendChild(tnFile)
    tn.body.appendChild(tnSwatch)

    function sampleTone(file) {
      if (!file) return
      emptyResult(tn.result, '正在采样色调…')
      var win = (typeof window !== 'undefined') ? window : null
      if (!win || typeof win.Image !== 'function' || !win.URL || typeof win.URL.createObjectURL !== 'function') {
        emptyResult(tn.result, '当前环境不支持本地图片采样（需要浏览器 canvas）')
        return
      }
      var objUrl = ''
      try { objUrl = win.URL.createObjectURL(file) } catch (err) {
        emptyResult(tn.result, '读取图片失败')
        return
      }
      var img = new win.Image()
      img.onload = function () {
        try {
          var cv = win.document.createElement('canvas')
          cv.width = 32
          cv.height = 32
          var ctx = cv.getContext && cv.getContext('2d')
          if (!ctx) throw new Error('no ctx')
          ctx.drawImage(img, 0, 0, 32, 32)
          var data = ctx.getImageData(0, 0, 32, 32).data
          var px = []
          for (var i = 0; i < data.length; i += 1) px.push(data[i])
          request('tone/extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixels: px }),
          }).then(function (j) {
            renderResult(tn.result, j)
            try {
              tnSwatch.style.background = (j && j.hex) ? j.hex : ''
              tnSwatch.setAttribute('data-hex', (j && j.hex) || '')
            } catch (err2) { /* 忽略 */ }
          })
        } catch (err3) {
          emptyResult(tn.result, '采样失败（画布不可用或被跨域限制）')
        }
        try { win.URL.revokeObjectURL(objUrl) } catch (err4) { /* 忽略 */ }
      }
      img.onerror = function () {
        emptyResult(tn.result, '这张图读不出来（格式不支持或已损坏）')
        try { win.URL.revokeObjectURL(objUrl) } catch (err5) { /* 忽略 */ }
      }
      img.src = objUrl
    }

    try {
      tnFile.addEventListener('change', function () {
        sampleTone(tnFile.files && tnFile.files[0])
      })
    } catch (err) { /* 忽略 */ }
    tn.row.appendChild(button('清空色块', true, function () {
      try {
        tnSwatch.style.background = ''
        tnSwatch.setAttribute('data-hex', '')
      } catch (err) { /* 忽略 */ }
      emptyResult(tn.result, '已清空。重新选图即可再采样。')
    }))
    box.appendChild(tn.sec)

    /* ---- 音乐 BGM：ACE-Step 1.5 / YuE2 ---- */
    var bgm = makeSection('音乐 BGM · ACE-Step 1.5 / YuE2')
    bgm.body.appendChild(el('div', 'dshqp-lab-note',
      '统一输入 prompt + 时长 + 歌词 / 风格，默认只回可审阅的参数计划；不真生成音频、不自动下载权重。'))
    var bgmModel = labeledInput('model（ace_step_15 / yue2）', 'ace_step_15')
    var bgmPrompt = labeledInput('prompt（音乐描述）', '轻快的钢琴与弦乐，适合开场')
    var bgmDur = labeledInput('duration_sec（5-600）', '60')
    var bgmStyle = labeledInput('style / preset（可留空）', 'upbeat')
    bgm.body.appendChild(bgmModel.wrap)
    bgm.body.appendChild(bgmPrompt.wrap)
    bgm.body.appendChild(bgmDur.wrap)
    bgm.body.appendChild(bgmStyle.wrap)
    bgm.row.appendChild(button('查看模型与预设', true, function () {
      emptyResult(bgm.result, '正在读取音乐模型…')
      request('music/models').then(function (j) { renderResult(bgm.result, j) })
    }))
    bgm.row.appendChild(button('生成参数计划', false, function () {
      emptyResult(bgm.result, '正在生成计划…')
      request('music/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: String(bgmModel.input.value || '').trim(),
          prompt: String(bgmPrompt.input.value || '').trim(),
          duration_sec: Number(bgmDur.input.value || 60),
          preset: String(bgmStyle.input.value || '').trim(),
        }),
      }).then(function (j) { renderResult(bgm.result, j) })
    }))
    box.appendChild(bgm.sec)

    /* ---- 手动超分：全部参数由用户显式给出 ---- */
    var mu = makeSection('手动超分 · 引擎 / 倍率 / 降噪 / 锐化')
    var muSrc = labeledInput('source（出图目录内的图片）', 'a.png')
    var muTgt = labeledInput('target（输出文件名）', 'a_upscaled.png')
    var muEngine = labeledInput('engine（auto/vosr2/realesrgan/custom/realesrgan-ncnn-vulkan/realcugan-ncnn-vulkan）', 'auto')
    var muScale = labeledInput('scale（2/3/4/6/8/16）', '4')
    var muDenoise = labeledInput('denoise（0-1）', '0')
    var muSharpen = labeledInput('sharpen（0-1）', '0')
    mu.body.appendChild(muSrc.wrap)
    mu.body.appendChild(muTgt.wrap)
    mu.body.appendChild(muEngine.wrap)
    mu.body.appendChild(muScale.wrap)
    mu.body.appendChild(muDenoise.wrap)
    mu.body.appendChild(muSharpen.wrap)
    mu.row.appendChild(button('查看能力', true, function () {
      emptyResult(mu.result, '正在读取超分能力…')
      request('upscale/manual/capabilities').then(function (j) { renderResult(mu.result, j) })
    }))
    mu.row.appendChild(button('生成草案', false, function () {
      emptyResult(mu.result, '正在构建参数草案…')
      request('upscale/manual', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: String(muSrc.input.value || '').trim(),
          target: String(muTgt.input.value || '').trim(),
          engine: String(muEngine.input.value || '').trim(),
          scale: Number(muScale.input.value || 4),
          denoise: Number(muDenoise.input.value || 0),
          sharpen: Number(muSharpen.input.value || 0),
        }),
      }).then(function (j) { renderResult(mu.result, j) })
    }))
    box.appendChild(mu.sec)

    /* ---- 位图 → SVG 矢量化（0.35.0）：vtracer 彩色 / potrace 黑白 ---- */
    var vz = makeSection('矢量化 · 位图 → SVG（vtracer 彩色 / potrace 黑白）')
    var vzSrc = labeledInput('source（出图目录内的图片）', 'a.png')
    var vzTgt = labeledInput('target（输出 SVG 文件名）', 'a.svg')
    var vzEngine = labeledInput('engine（vtracer/potrace）', 'vtracer')
    var vzPreset = labeledInput('preset（vtracer：bw/poster/photo，可空）', '')
    vz.body.appendChild(vzSrc.wrap)
    vz.body.appendChild(vzTgt.wrap)
    vz.body.appendChild(vzEngine.wrap)
    vz.body.appendChild(vzPreset.wrap)
    vz.row.appendChild(button('查看能力', true, function () {
      emptyResult(vz.result, '正在读取矢量化能力…')
      request('vectorize/capabilities').then(function (j) { renderResult(vz.result, j) })
    }))
    vz.row.appendChild(button('转 SVG', false, function () {
      emptyResult(vz.result, '正在矢量化…')
      request('vectorize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: String(vzSrc.input.value || '').trim(),
          target: String(vzTgt.input.value || '').trim(),
          engine: String(vzEngine.input.value || '').trim(),
          preset: String(vzPreset.input.value || '').trim(),
        }),
      }).then(function (j) { renderResult(vz.result, j) })
    }))
    box.appendChild(vz.sec)

    /* ---- 本机 ASR 状态（faster-whisper 等，零新路径） ---- */
    var as = makeSection('本机 ASR · faster-whisper 等（asrUrl 指过来即接通字幕链路）')
    as.row.appendChild(button('查看 ASR 状态', true, function () {
      emptyResult(as.result, '正在探测本机 ASR…')
      request('asr/status').then(function (j) { renderResult(as.result, j) })
    }))
    box.appendChild(as.sec)

    /* ---- 轻量缝合：旁白 + BGM ducking + SRT（纯 ffmpeg，显存 0） ---- */
    var st = makeSection('轻量缝合 · 旁白时间轴 + BGM ducking + SRT')
    var stItem = labeledInput('旁白 JSON [{file,text?,duration_ms?}]', '[{"file":"a.wav","text":"你好"}]')
    var stBgm = labeledInput('bgm（可空）', 'bgm.wav')
    var stTgt = labeledInput('target（输出音频）', 'mix.m4a')
    var stSrt = labeledInput('srt_target（可空）', 'mix.srt')
    st.body.appendChild(stItem.wrap)
    st.body.appendChild(stBgm.wrap)
    st.body.appendChild(stTgt.wrap)
    st.body.appendChild(stSrt.wrap)
    st.row.appendChild(button('查看能力', true, function () {
      emptyResult(st.result, '正在读取缝合能力…')
      request('av/stitch/capabilities').then(function (j) { renderResult(st.result, j) })
    }))
    st.row.appendChild(button('执行缝合', false, function () {
      emptyResult(st.result, '正在缝合（ffmpeg 纯 CPU）…')
      var items = []
      try { items = JSON.parse(String(stItem.input.value || '[]')) } catch (e) { items = [] }
      request('av/stitch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: items,
          bgm: String(stBgm.input.value || '').trim(),
          target: String(stTgt.input.value || '').trim(),
          srt_target: String(stSrt.input.value || '').trim(),
        }),
      }).then(function (j) { renderResult(st.result, j) })
    }))
    box.appendChild(st.sec)

    /* ---- 轻量档 PPTX 已升为面板第四模式（panel.js 的 PPT 卡），实验室不再重复放一份 ---- */

    /* ---- Worker：环境隔离 / 启停 / 空闲回收 / 显存预检 ---- */
    var wk = makeSection('独立 Worker · 环境隔离 / 显存预检')
    wk.body.appendChild(el('div', 'dshqp-lab-note',
      '每个模型一个独立 Worker，本机 127.0.0.1 回环通信。venv / conda / Docker 只给配置位：插件不 pip install、不拉镜像、不下载权重。空闲自动终止释放显存；显存数字只来自注入探针，未注入就标未检测。'))
    var wkId = labeledInput('id（gpt_sovits_v5 / indextts2 / ace_step_15 / yue2）', 'ace_step_15')
    var wkAction = labeledInput('action（list/preflight/start/stop/configure/sweep/protocol）', 'preflight')
    var wkCmd = labeledInput('command（启动命令，用户自备）', '')
    var wkEnv = labeledInput('env_path（venv / conda 路径，用户自备）', '')
    wk.body.appendChild(wkId.wrap)
    wk.body.appendChild(wkAction.wrap)
    wk.body.appendChild(wkCmd.wrap)
    wk.body.appendChild(wkEnv.wrap)
    wk.row.appendChild(button('Worker 清单 / 协议', true, function () {
      emptyResult(wk.result, '正在读取 Worker 清单…')
      request('workers').then(function (j) { renderResult(wk.result, j) })
    }))
    wk.row.appendChild(button('显存预检', true, function () {
      emptyResult(wk.result, '正在读取显存探针…')
      request('workers/vram').then(function (j) { renderResult(wk.result, j) })
    }))
    wk.row.appendChild(button('执行动作', false, function () {
      emptyResult(wk.result, '正在执行 Worker 动作…')
      request('workers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: String(wkAction.input.value || 'list').trim(),
          id: String(wkId.input.value || '').trim(),
          command: String(wkCmd.input.value || '').trim(),
          env_path: String(wkEnv.input.value || '').trim(),
        }),
      }).then(function (j) { renderResult(wk.result, j) })
    }))
    box.appendChild(wk.sec)

    // ★ 2026-11-16：全部 section 建好后按职责分组折叠（纯 DOM 移动，不动业务逻辑）。
    groupSections(box)
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
    api: {
      labGroupOf: labGroupOf,
      groupSections: groupSections,
      LAB_GROUPS: LAB_GROUPS,
    },
    mountInto: mountInto,
    // 兼容旧调用名，但语义已是「嵌进插槽」而非「创建浮层」。
    attach: function (host) { return mountInto(host) },
    refresh: function () { return loadDoctorBrief(true) },
    isDoctorDetailOpen: function () { return doctorOpen === true },
    isAttached: function () { return Boolean(els.sections && els.sections.parentNode) },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
}())
