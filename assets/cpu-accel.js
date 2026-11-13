/* assets/cpu-accel.js —— CPU 指令集识别 + 加速档面板（非 ESM，单文件挂载）
 *
 * 为什么在 assets/：lib/client.js 只剩 290 B 就到 DSH Store 256 KB 单文件上限。
 * 为什么挂在安装引导面板里：右下角已经有一个常驻浮标，再开一个只会更乱 ——
 *   用户要的是"能看见选项"，不是"再多一个按钮"。
 *
 * 三条设计红线：
 *   1. **只读 + 选档**，绝不从网页触发安装、重启或下载。选完只写一个档位字段，
 *      真正生效要用户自己重启 ComfyUI（文案里写死了这一点）。
 *   2. **不美化**：每档显示的是后端算出来的**真实参数**（含"这台机器上被自动降级"
 *      和"为什么跳过"），不是一段好看的空话。
 *   3. 指令集三态必须区分「实测 / 型号推断 / 未知」。把"不知道"画成"不支持"
 *      会误导用户关掉本来能用的加速。
 */
(function () {
  'use strict'
  if (window.DshQpCpuAccel && window.DshQpCpuAccel.__cpu === true) return

  var PROFILE_PATH = 'api/qwen-paint/cpu-profile'
  var SET_PATH = 'api/qwen-paint/cpu-accel'
  var SLOT_ID = 'dshqp-cpu-accel-slot'
  var state = null
  var busy = false

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function injectCss() {
    if (document.getElementById('dshqp-cpu-accel-css')) return
    var l = document.createElement('link')
    l.id = 'dshqp-cpu-accel-css'
    l.rel = 'stylesheet'
    l.href = 'qwen-paint/cpu-accel.css'
    document.head.appendChild(l)
  }

  /** 指令集徽章：文字 + data-state（yes/no/unknown），颜色由 CSS 决定。 */
  function isaBadge(label, value, evidence) {
    var b = el('span', 'ca-isa')
    b.setAttribute('data-state', value === true ? 'yes' : (value === false ? 'no' : 'unknown'))
    b.textContent = label
    b.title = value === true
      ? '支持（' + (evidence === 'flags' ? '本机实测' : '按型号家族推断') + '）'
      : (value === false
        ? '不支持（' + (evidence === 'flags' ? '本机实测' : '按型号家族推断') + '）'
        : '未知（型号未识别 / 未实测）—— 插件不会据此关闭任何选项')
    return b
  }

  function evidenceText(ev) {
    return ev === 'flags' ? '本机实测' : (ev === 'model' ? '型号推断（未实测）' : '未知')
  }

  function renderHead(cpu) {
    var box = el('div', 'ca-head')

    var title = el('div', 'ca-title')
    title.appendChild(el('span', 'ca-name', cpu.model || '未识别到 CPU 型号'))
    var ev = el('span', 'ca-ev')
    ev.setAttribute('data-ev', cpu.isaEvidence || 'unknown')
    ev.textContent = evidenceText(cpu.isaEvidence)
    title.appendChild(ev)
    box.appendChild(title)

    var meta = el('div', 'ca-meta')
    var phys = cpu.physicalCores || 0
    var logical = cpu.logicalCores || 0
    var srcLabel = cpu.physicalCoresSource === 'model' ? '型号里写着'
      : (cpu.physicalCoresSource === 'explicit' ? '你指定'
        : (cpu.physicalCoresSource === 'inferred' ? '按逻辑核 ÷ 2 推断' : '未知'))
    meta.textContent = '物理核 ' + (phys || '未知') + '（' + srcLabel + '）'
      + ' · 逻辑核 ' + (logical || '未知')
    box.appendChild(meta)

    var isa = el('div', 'ca-isa-row')
    isa.appendChild(isaBadge('AVX2', cpu.isa && cpu.isa.avx2, cpu.isaEvidence))
    isa.appendChild(isaBadge('AVX-512', cpu.isa && cpu.isa.avx512f, cpu.isaEvidence))
    isa.appendChild(isaBadge('AVX512-BF16', cpu.isa && cpu.isa.avx512Bf16, cpu.isaEvidence))
    isa.appendChild(isaBadge('AMX-BF16', cpu.isa && cpu.isa.amxBf16, cpu.isaEvidence))
    box.appendChild(isa)

    for (var i = 0; i < (cpu.notes || []).length; i += 1) {
      box.appendChild(el('div', 'ca-note', cpu.notes[i]))
    }
    return box
  }

  function renderMode(m, onPick) {
    var card = el('label', 'ca-mode')
    card.setAttribute('data-risk', m.risk || 'low')
    card.setAttribute('data-selected', m.selected ? '1' : '0')

    var head = el('div', 'ca-mode-head')
    var radio = el('input', 'ca-radio')
    radio.type = 'radio'
    radio.name = 'dshqp-cpu-accel'
    radio.value = m.id
    radio.checked = m.selected === true
    radio.addEventListener('change', function () { onPick(m.id) })
    head.appendChild(radio)
    head.appendChild(el('span', 'ca-mode-label', m.label))
    if (m.effectiveMode && m.effectiveMode !== m.id) {
      var deg = el('span', 'ca-deg', '实际降级为 ' + m.effectiveMode)
      head.appendChild(deg)
    }
    card.appendChild(head)

    card.appendChild(el('div', 'ca-mode-sum', m.summary))

    // 真实参数（后端算出来的，不是文案）
    if (m.args && m.args.length) {
      var code = el('code', 'ca-args')
      code.textContent = m.args.join(' ')
      card.appendChild(code)
    } else {
      card.appendChild(el('div', 'ca-args ca-args-empty', '不加任何启动参数'))
    }
    if (m.env && m.env.length) {
      var envLine = []
      for (var i = 0; i < m.env.length; i += 1) envLine.push(m.env[i][0] + '=' + m.env[i][1])
      card.appendChild(el('div', 'ca-env', envLine.join('  ')))
    }
    // 工作流级覆盖单独一行：它改的是节点输入（QwenImage21Cache.device），
    // 下次出图就生效，不用重启 ComfyUI —— 和上面那堆启动参数不是一件事。
    if (m.workflowOverrides) {
      var wfLine = []
      for (var k in m.workflowOverrides) {
        if (Object.prototype.hasOwnProperty.call(m.workflowOverrides, k)) {
          wfLine.push(k + '=' + m.workflowOverrides[k])
        }
      }
      if (wfLine.length) {
        card.appendChild(el('div', 'ca-env ca-env-wf', '工作流（下次出图生效）：' + wfLine.join('  ')))
      }
    }
    for (var j = 0; j < (m.skipped || []).length; j += 1) {
      card.appendChild(el('div', 'ca-skip', '跳过 ' + m.skipped[j].item + '：' + m.skipped[j].reason))
    }
    return card
  }

  function render() {
    var slot = document.getElementById(SLOT_ID)
    if (!slot) return
    injectCss()
    slot.innerHTML = ''

    var box = el('section', 'ca-box')
    var h = el('div', 'ca-h')
    h.appendChild(el('span', 'ca-h-title', 'CPU 指令集与加速档'))
    var reload = el('button', 'ca-mini', '重新检测')
    reload.type = 'button'
    reload.addEventListener('click', load)
    h.appendChild(reload)
    box.appendChild(h)

    if (!state) {
      box.appendChild(el('div', 'ca-note', '正在读取 CPU 信息…（端点不通时会一直停在这里，不影响出图）'))
      slot.appendChild(box)
      return
    }
    if (state.ok !== true) {
      box.appendChild(el('div', 'ca-note', '读不到 CPU 信息：' + (state.reason || '原因未知')))
      slot.appendChild(box)
      return
    }

    box.appendChild(renderHead(state.cpu || {}))

    var modes = el('div', 'ca-modes')
    var picked = state.mode || 'off'
    for (var i = 0; i < (state.modes || []).length; i += 1) {
      modes.appendChild(renderMode(state.modes[i], pick))
    }
    box.appendChild(modes)

    var foot = el('div', 'ca-foot')
    foot.appendChild(el('div', 'ca-warn',
      '这些是 ComfyUI 的**启动参数 / 环境变量** → 选完必须重启 ComfyUI 才生效。'
      + '本面板只写档位，不会替你重启，也不会下载任何东西。'))
    if (state.apply && state.apply.note) {
      foot.appendChild(el('div', 'ca-note', state.apply.note))
    }
    box.appendChild(foot)
    slot.appendChild(box)

    function pick(id) {
      if (busy) return
      busy = true
      fetch(SET_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ cpuAccel: id }),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          busy = false
          if (j && j.ok) {
            reload.textContent = '已保存，重启生效'
            setTimeout(function () { reload.textContent = '重新检测' }, 2600)
            load()
          } else {
            reload.textContent = '保存失败：' + ((j && j.reason) || '未知')
          }
        })
        .catch(function () {
          busy = false
          reload.textContent = '保存失败（端点不通）'
        })
    }
  }

  function load() {
    fetch(PROFILE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { state = j; render() })
      .catch(function () {
        state = { ok: false, reason: '端点不通（插件可能还没挂载）' }
        render()
      })
  }

  function mount(tries) {
    var slot = document.getElementById(SLOT_ID)
    if (!slot) {
      // 安装引导面板还没建好 → 再等一会儿（最多约 3 秒），之后静默放弃。
      if ((tries || 0) < 10) setTimeout(function () { mount((tries || 0) + 1) }, 300)
      return
    }
    injectCss()
    load()
  }

  window.DshQpCpuAccel = {
    __cpu: true,
    reload: load,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(0) })
  } else { mount(0) }
})()
