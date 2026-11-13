/* assets/setup-guide.js —— 图形化傻瓜式安装引导（非 ESM，<script defer> 单文件）
 *
 * 为什么在 assets/：lib/client.js 贴着 DSH Store 256 KB 单文件上限，新 UI 一律外置。
 * 为什么不用 import：DSH 客户端是 window.__ModuleLoader__ 单入口纯脚本，lib/ 不经 web 暴露。
 *
 * 设计要点（用户要求「入口藏得太隐蔽，改明显一点，图形化傻瓜式」）：
 *   · 一个**常驻可见**的大按钮（不是收在二级菜单里），带进度环与状态色；
 *   · 点开是分步卡片向导：状态灯 / 进度条 / 大白话 / 一键复制命令 / 明确的联网与同意提示；
 *   · 首次进入自动弹一次（可关，localStorage 记住），缺件时按钮变琥珀色提示；
 *   · 只展示与复制命令，**绝不从网页触发本机安装进程**（安全红线，端点也写死了）。
 *
 * 所有文案与状态来自 GET api/qwen-paint/setup-guide；端点不通时降级为静态步骤清单。
 */
(function () {
  'use strict'
  if (window.DshQpSetupGuide && window.DshQpSetupGuide.__guide === true) return

  var GUIDE_PATH = 'api/qwen-paint/setup-guide'
  var STORE_KEY = 'dshqp.setupGuide.seen'
  var state = null
  var els = {}
  var opened = false

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function statusText(s) {
    return s === 'done' ? '已就绪' : s === 'todo' ? '待处理'
      : s === 'optional' ? '可选' : '检测中'
  }

  function copy(text, btn) {
    var done = function (ok) {
      var old = btn.textContent
      btn.textContent = ok ? '已复制 ✓' : '复制失败，请手动选中'
      setTimeout(function () { btn.textContent = old }, 1800)
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true) }, function () { done(false) })
      } else {
        var ta = el('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta)
        ta.select()
        var ok = document.execCommand('copy')
        ta.remove()
        done(ok)
      }
    } catch (e) { done(false) }
  }

  function stepCard(step, index) {
    var card = el('div', 'sg-card')
    card.setAttribute('data-status', step.status)
    var head = el('div', 'sg-card-head')
    var no = el('span', 'sg-no', String(index + 1).padStart(2, '0'))
    var titleBox = el('div', 'sg-title-box')
    titleBox.appendChild(el('div', 'sg-title', step.title))
    var tags = el('div', 'sg-tags')
    if (step.optional) tags.appendChild(el('span', 'sg-tag sg-tag-opt', '可选'))
    if (step.network) tags.appendChild(el('span', 'sg-tag sg-tag-net', '会联网下载'))
    if (step.consent) tags.appendChild(el('span', 'sg-tag sg-tag-ask', '需你确认'))
    if (tags.children.length) titleBox.appendChild(tags)
    head.appendChild(no)
    head.appendChild(titleBox)
    head.appendChild(el('span', 'sg-status', statusText(step.status)))
    card.appendChild(head)
    card.appendChild(el('p', 'sg-hint', step.hint))
    if (step.choices && step.choices.length) {
      var choices = el('div', 'sg-choices')
      step.choices.forEach(function (c) {
        var b = el('button', 'sg-btn sg-btn-ghost', c.label)
        b.type = 'button'
        b.addEventListener('click', function () { copy(c.command, b) })
        b.title = c.command
        choices.appendChild(b)
      })
      card.appendChild(choices)
    }
    if (step.command) {
      var row = el('div', 'sg-cmdrow')
      var code = el('code', 'sg-cmd', step.command)
      row.appendChild(code)
      var cp = el('button', 'sg-btn sg-btn-copy', '复制命令')
      cp.type = 'button'
      cp.addEventListener('click', function () { copy(step.command, cp) })
      row.appendChild(cp)
      card.appendChild(row)
    }
    if (step.extra) card.appendChild(el('p', 'sg-extra', step.extra))
    return card
  }

  function render() {
    if (!els.list) return
    els.list.textContent = ''
    var steps = (state && state.steps) || []
    steps.forEach(function (s, i) { els.list.appendChild(stepCard(s, i)) })
    var done = state ? state.done : 0
    var total = state ? state.total : 0
    var pct = total ? Math.round(done / total * 100) : 0
    els.bar.style.width = pct + '%'
    els.progress.textContent = state && state.probed
      ? (done + ' / ' + total + ' 步已就绪')
      : '状态未探测 · 步骤仍可照做'
    els.fab.textContent = state && state.ready ? '安装引导 · 已就绪'
      : (state && state.probed ? '一键安装引导 · ' + done + '/' + total : '一键安装引导')
    els.fab.setAttribute('data-ready', state && state.ready ? '1' : '0')
    els.headline.textContent = (state && state.headline) || '视频 / 生图 / TTS 全能 · 本机运行'
    if (els.pack) {
      els.pack.textContent = state && state.videoDownloadPack && state.videoDownloadPack.available
        ? '✓ 视频模型自动下载包：已提供（--video-models，默认不装、需你同意、按权威 size+sha256 校验）'
        : '视频模型自动下载包：状态未知'
    }
  }

  function load() {
    return fetch(GUIDE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) { if (j && j.ok) { state = j; render() } })
      .catch(function () { /* 端点不通就用内置静态清单，不弹错 */ })
  }

  function open() {
    if (!els.panel) return
    els.panel.hidden = false
    opened = true
    loadCpuAccel()
    load()
  }
  function close() {
    if (!els.panel) return
    els.panel.hidden = true
    opened = false
    try { localStorage.setItem(STORE_KEY, '1') } catch (e) { /* 隐私模式忽略 */ }
  }

  function injectCss() {
    if (document.getElementById('dshqp-setup-guide-css')) return
    var l = document.createElement('link')
    l.id = 'dshqp-setup-guide-css'
    l.rel = 'stylesheet'
    l.href = 'qwen-paint/setup-guide.css'
    document.head.appendChild(l)
  }

  /**
   * 懒加载 CPU 加速档面板。
   * 为什么不直接写成第二个 <script> 标签：它只在用户真打开引导面板时才需要，
   * 平时不该多一次静态资源请求；而且它是独立文件，坏了也不会拖垮引导本身。
   */
  function loadCpuAccel() {
    if (window.DshQpCpuAccel && window.DshQpCpuAccel.__cpu === true) return
    if (document.getElementById('dshqp-cpu-accel-js')) return
    var s = document.createElement('script')
    s.id = 'dshqp-cpu-accel-js'
    s.src = 'qwen-paint/cpu-accel.js'
    s.defer = true
    document.head.appendChild(s)
  }

  function mount() {
    injectCss()
    if (document.getElementById('dshqp-setup-guide-fab')) return
    // 常驻显眼入口：右下角大按钮，避开通用面板的左下浮标。
    var fab = el('button', 'sg-fab')
    fab.id = 'dshqp-setup-guide-fab'
    fab.type = 'button'
    fab.textContent = '一键安装引导'
    fab.title = '图形化安装引导：ComfyUI / 生图 / 视频 / 语音 / DSH 挂载'
    fab.addEventListener('click', function () { opened ? close() : open() })
    els.fab = fab

    var panel = el('div', 'sg-panel')
    panel.hidden = true
    var head = el('div', 'sg-head')
    var hb = el('div', 'sg-head-box')
    hb.appendChild(el('h3', 'sg-h3', '装好这个插件，只要 7 步'))
    var headline = el('div', 'sg-headline', '视频 / 生图 / TTS 全能 · 本机运行')
    hb.appendChild(headline)
    els.headline = headline
    head.appendChild(hb)
    var x = el('button', 'sg-x', '×')
    x.type = 'button'
    x.addEventListener('click', close)
    head.appendChild(x)
    panel.appendChild(head)

    var barWrap = el('div', 'sg-barwrap')
    var bar = el('div', 'sg-bar')
    barWrap.appendChild(bar)
    els.bar = bar
    panel.appendChild(barWrap)
    var progress = el('div', 'sg-progress', '状态未探测 · 步骤仍可照做')
    els.progress = progress
    panel.appendChild(progress)

    var pack = el('div', 'sg-pack', '')
    els.pack = pack
    panel.appendChild(pack)

    // ★ 2026-11-13：CPU 指令集 / 加速档的插槽。内容由 cpu-accel.js 渲染 ——
    //   不为它单开浮标（右下角已经有一个，再加只会更乱），就长在引导面板里。
    var cpuSlot = el('div', 'sg-cpu-slot')
    cpuSlot.id = 'dshqp-cpu-accel-slot'
    panel.appendChild(cpuSlot)

    var safety = el('div', 'sg-safety',
      '这个引导只展示和复制命令，绝不会从网页偷偷在你电脑上跑安装。所有联网下载都要你在终端里亲自执行。')
    panel.appendChild(safety)

    var list = el('div', 'sg-list')
    els.list = list
    panel.appendChild(list)

    var foot = el('div', 'sg-foot')
    var again = el('button', 'sg-btn sg-btn-ghost', '重新检测')
    again.type = 'button'
    again.addEventListener('click', load)
    foot.appendChild(again)
    var toCap = el('button', 'sg-btn sg-btn-ghost', '查看能力状态')
    toCap.type = 'button'
    toCap.addEventListener('click', function () {
      fetch('api/qwen-paint/integration/state', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var d = el('pre', 'sg-json', JSON.stringify(j, null, 2))
          els.list.insertBefore(d, els.list.firstChild)
        })
        .catch(function () { /* 忽略 */ })
    })
    foot.appendChild(toCap)
    panel.appendChild(foot)

    document.body.appendChild(fab)
    document.body.appendChild(panel)
    els.panel = panel
    render()
    load()
    // 首次自动弹一次，之后只在用户点按钮时开；绝不强推。
    try {
      if (localStorage.getItem(STORE_KEY) !== '1') setTimeout(open, 1200)
    } catch (e) { /* 隐私模式忽略 */ }
  }

  window.DshQpSetupGuide = {
    __guide: true, open: open, close: close, reload: load,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else { mount() }
})()
