/**
 * dsh-qwen-paint —— 优化面板描述（describeOptimization / genericOptimizations）
 * ============================================================================
 * ★★ 2026-10-13：从 lib/config.js **拆出来**的，原因只有一个 ——
 *
 *   `lib/config.js` 涨到 **264,530 B**，超过了 **DSH Store 的单文件上限
 *   262,144 B**（256 KiB）。这不是"看着不舒服"，是**上架/复检会被机器人拦下**。
 *
 *   而 `describeOptimization` 一个函数就占 52 KB，是文件里最大的一块 ——
 *   抽走它 + `genericOptimizations`，config.js 立刻降到 ~209 KB，留出 ~50 KB 余量。
 *
 * ⚠ 为什么只抽这两块、不抽数据表：
 *   这两块是**纯展示逻辑**（把探测结果翻译成人话），不参与工作流构建，
 *   与其它符号的耦合最少 —— 拆它风险最低。DEFAULTS / GPU_PROFILES 那些表
 *   被 buildWorkflow 等热路径到处引用，拆动它们收益小、风险大。
 *
 * ## 循环 import（与 index.js ↔ config.js **同一套路**，已验证可用）
 *   本文件 import config.js，而 config.js 又 import 本文件的两个函数（为了
 *   保持旧的 import 路径不变）。ESM 的 **live binding** 让这件事成立：
 *   本文件顶层**只在调用时**才读 config 的绑定，不在模块求值期读 ⇒ 不会 TDZ。
 *   ⚠ 前提：本文件顶层**不能**出现"读 config 绑定并求值"的语句（比如
 *     `const X = DEFAULTS.y`）。要加常量请放进函数体内，或放到 config.js。
 */

import {
  AMD_KERNEL_FLAG, DEFAULTS, FULL_CAPS, GPU_PROFILES, IS_MAC, MAC_PROFILE_IDS,
  PARAMETERS, SADA_NODE_DEFAULT, SAGE_READY, SPECTRUM_NODE,
  appleChipOf, importantNotesOf, nvidiaGenOf, resolvePlan, vendorIdOf,
  // ★ 2026-10-13 补：这两个是 `genericOptimizations` 用到的 —— 首轮只扫了
  //   describeOptimization 的函数体，**漏扫了 genericOptimizations**，
  //   结果 `tierLabelOf is not defined` 在测试里当场炸出来。
  //   ⇒ 教训：搬代码时依赖要**逐块**扫，不能只扫最大的那一块。
  shouldProbe, tierLabelOf,
} from './config.js'

function genericOptimizations(caps, cfg) {
  if (!caps) return []
  const plan = resolvePlan(cfg, caps)
  const mark = (ok) => (ok ? '已启用' : '未启用')
  // ★★★ 2026-10-10 修 bug：TE-Speed / Speedup / BlockCache **三者互斥，且由出图尺寸决定谁上**
  //   （见 `pickWrapperSet`）。而 `plan.useTe/useSpeedup` 是"被 BlockCache 挤掉之后"的**静态**结果 ——
  //   直接报它会出现"报告说未启用、实际 1024² 正在用 TE+Speedup"的假报告。
  //   ⇒ 这里报**策略**，不报布尔值（与真正提交的工作流一致）。
  const wpPolicy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'
  const bcUsable = caps.nodes?.blockCache === true && cfg.blockCacheEnabled !== false
  const wrapperLine = wpPolicy === 'bc'
    ? (bcUsable ? 'BlockCache T8（固定，所有尺寸）' : 'BlockCache T8 不可用 → 退回 TE-Speed + Speedup')
    : (wpPolicy === 'te'
      ? 'TE-Speed + Speedup（固定，所有尺寸）'
      : (bcUsable
        ? '按尺寸自动：小尺寸（≤1024²）TE-Speed + Speedup ／ 大尺寸（如 1408²）BlockCache T8'
        : 'TE-Speed + Speedup（未装 BlockCache T8 节点）'))
  // ★★★ 2026-10-11：**按显卡过滤** —— RDNA3 FlashAttention 只对 AMD RDNA3（gfx1100）有意义。
  //   在 N 卡 / I 卡 / RDNA2 / RDNA4 上列出来只会误导（"未安装节点"会让用户去装一个装不了的东西）。
  //   与 `describeOptimization` 用同一套约定：**认不出显卡就不隐藏**。
  const gpuName = String(caps.gpu?.name ?? '').trim()
  const gpuVendor = gpuName === '' ? 'unknown' : vendorIdOf(gpuName)
  const lines = [
    `turbo8 八步蒸馏 LoRA：${mark(plan.useTurbo)}`,
    `官方前缀 KV 缓存 (QwenImage21Cache)：${mark(plan.usePrefix)}`,
    ...(gpuVendor === 'unknown' || gpuVendor === 'amd_rdna3'
      ? [`RDNA3 FlashAttention（无损）：${plan.useRdna3Fa ? '已启用' : (caps.nodes?.rdna3fa ? '未启用（被配置关）' : '未安装节点')}`]
      : []),
    `TE-Speed / Speedup / BlockCache（三者互斥）：${wrapperLine}`,
    `采样档位：${plan.useTurbo ? '8 步 / CFG 1.0（turbo8 工作点）' : `${plan.steps} 步 / CFG ${plan.cfgScale}（千问原生工作点）`}`,
    // ★ 2026-10-11：主模型档位（小显存适配）—— 让用户一眼看到现在用的是哪一档
    `主模型：${tierLabelOf(caps, cfg)}`,
  ]
  // ★★★ 探测没成功时（典型：ComfyUI 没在运行），上面那些"已启用"其实是**按能力齐全做的假设**。
  //   不点明的话，用户会以为加速全都生效了 —— 那是最容易误导人的一种报告。
  if (caps.probeFailed) {
    lines.unshift('⚠ 本次能力探测未成功（ComfyUI 可能没在运行），以下状态是按「能力齐全」假设的，**不代表真实可用**')
  }
  return lines
}

/**
 * 汇总"当前环境该用哪套加速、各部件就位了没"。
 * 这是 `check_acceleration` 工具与启动日志共用的**只读**入口。
 */

// ===== moved from index.js: shouldProbe (was lines 2422-2433) =====

function describeOptimization(cfg, caps, platform = process.platform) {
  // ── 总开关关掉：这是最优先要说清的事 ──────────────────────────────────
  if (cfg.enabled === false) {
    return {
      level: 'disabled',
      ok: false,
      summary: '插件已停用（enabled=false）',
      reasons: ['总开关被设为 false —— 不注册绘图工具、不注入提示词、不预热后端。'
        + '要恢复请把 cordis.patch.yml 里的 enabled 改成 true（或删掉那一行）后重启 DSH。'],
      detail: [],
      // 停用态没有可评估的项 —— 给零值而非 undefined，前端不必到处判空
      // ★ 2026-10-11：补 `optional`（与正常路径**形状一致** —— 否则"按桶求和"的代码会踩）
      stats: { on: 0, available: 0, off: 0, blocked: 0, optional: 0, optionalOn: 0, total: 0 },
      // 停用态不去探显卡（连 ComfyUI 都没打算用）→ 如实给空，前端不显示过滤提示
      gpu: null,
      filtered: [],
      warnings: [],
    }
  }

  // ── ComfyUI 没在运行 ─────────────────────────────────────────────────
  // ★★★ 2026-10-09 修正（主人反馈「为什么我本机都显示优化状态未知啊，这个判断也太傻了吧」）：
  //   原先这里报的是「未检测到 ComfyUI，优化状态未知」。
  //   但"未知"是错的说法 —— 我们**很清楚**发生了什么：优化链本来就跑在 ComfyUI 里，
  //   它没启动，当然无从谈优化。这不是"不知道"，而是"还没轮到检测"。
  //   更关键的是：**插件自己就有能力把 ComfyUI 拉起来**（出图时 ensureComfyUp，
  //   启动时还会预热），所以对用户来说这就是一个"待会儿自然就绪"的正常状态，
  //   完全不需要他做任何事，更不该让他以为哪里坏了。
  if (!caps) {
    return {
      level: 'idle',
      ok: false,
      // ★ 2026-10-09 按主人要求改成**因果明确**的表述：
      //   原来是"优化待检测"，主人指出应该直说"没启动 → 所以检测不了"。
      summary: 'ComfyUI 未启动，无法检测优化状态',
      reasons: [
        '优化链（turbo8、前缀缓存、跳步缓存）都跑在 ComfyUI 里，它现在没运行，所以**检测不了** —— 这是正常状态，不是故障。',
        '你不需要做任何事：出图时插件会自动把 ComfyUI 拉起来，之后这里就会显示真实的优化状态。',
        '想立刻看到结果：点状态点弹出的菜单里选「启动 ComfyUI」，或直接画一张图。',
      ],
      detail: [],
      // ★ 注意是 `total: 0` 而**不是 4** —— 这时候四项一项都没探测过，
      //   报"0/4 已启用"会让人以为全都没开，那是误导。
      // ★ 2026-10-11：补 `optional`（与正常路径形状一致）
      stats: { on: 0, available: 0, off: 0, blocked: 0, optional: 0, optionalOn: 0, total: 0 },
      // 还没探测 → 也还没识别显卡 → 不隐藏任何项
      gpu: null,
      filtered: [],
      warnings: [],
    }
  }

  const plan = resolvePlan(cfg, caps)
  const detail = []
  const reasons = []

  // ★★★ 2026-10-11 新增：**按显卡厂商过滤掉不适用的优化项**。
  //
  //   主人原话：「优化菜单没有动态过滤或者置灰啊。怎么 5060 还能弹出来 AMD R3 的优化呢？
  //     应该识别一下呀，识别是哪个显卡，就把不能用的优化直接隐藏掉。」
  //
  //   根因：`RDNA3 FlashAttention` 那一项原先**只看"节点装没装"、完全不看显卡** ——
  //     在 N 卡（如 RTX 5060）上会显示成「可启用：把 RDNA3-Flash-Attention 装进 custom_nodes」，
  //     而那个节点是 gfx1100（AMD RDNA3）专用的，装了也跑不了 ⇒ 纯误导。
  //
  //   约定（与"caps 缺省 = 能力齐全"一致）：**认不出显卡就不隐藏**。
  //     只有明确认到厂商、且该厂商不是这项要求的厂商时，才把它藏掉。
  //     —— 宁可多显示一项，也不能因为探测不到就把用户真能用的优化藏了。
  //
  //   `caps.gpu.name` 来自 ComfyUI `/system_stats` 的 `devices[0].name`
  //   （**实际用来算图的那张卡**，比 WMI 枚举更准）。拿不到时是空串。
  const gpuName = String(caps.gpu?.name ?? '').trim()
  // ★★★ 2026-10-12：`platform` 作为**第三个参数可注入**（默认仍是真实平台）。
  //   为什么：Mac 专属项、以及"显存驻留该不该列"都要按平台分叉，而 `IS_MAC` 是
  //   **模块加载时写死**的 —— 本机（Windows）就永远跑不到那些分支，
  //   等于这段 UI 从落地起就是"没测过"。注入 platform 后，
  //   非 Mac 机器上也能用 `describeOptimization(cfg, caps, 'darwin')` 完整回归 Mac 面板。
  //   ⚠ 生产调用点（index.js）**不传**第三个参数，行为与从前完全一致。
  //   `isMac` 取「平台是 macOS」**或**「判定结果是 Mac 档」的并集 ——
  //   后者让非 Mac 机器也能用 Mac 显卡名跑回归；前者保证真 Mac 上即使
  //   显卡探测失败（`caps.gpu.name` 为空）也能显示 Mac 专属项。
  const gpuVendor = gpuName === '' ? 'unknown' : vendorIdOf(gpuName, platform)
  const isMac = platform === 'darwin' || MAC_PROFILE_IDS.has(gpuVendor)
  /** 该项是否适用于当前显卡：不指定 vendorId 的项一律适用；认不出显卡时一律适用。 */
  const appliesToGpu = (needVendor) => needVendor === undefined
    || gpuVendor === 'unknown' || gpuVendor === needVendor
  /** 被显卡过滤掉的项名 —— 给前端显示"藏了哪几项、为什么"，不静默消失。 */
  const hiddenByGpu = []

  // ── 逐项列出"打算用什么"以及"能不能用" ──────────────────────────────
  //
  // ★★★ 2026-10-09 升级（主人要求）：**从二元「已启用/未启用」升级为四态**。
  //
  //   主人原话：「你启用优化就应该是启用了哪些优化，这个也肯定要用区分啊
  //     你点进去就应该是告诉你启用了哪些优化，哪些可以启用哪些没启用，哪些不能启用」。
  //
  //   为什么必须分：原来的 whyOff 一句话里其实混着**三种完全不同的处境**，
  //   用户看完不知道该干什么 ——
  //     · 「没装 TE-Speed 节点」→ 装上就能快，**值得动手**；
  //     · 「被配置关了」        → 改一行配置就能快，**最容易修**；
  //     · 「依赖 turbo8 未生效」→ 上游没通，**现在做什么都没用**。
  //   三者显示成同一句灰字，等于把"能做的"和"做不了的"糊在一起，
  //   用户要么白折腾、要么以为插件坏了。
  //
  //   四态定义（`state` 字段，UI 直接照它上色，不再从文案里猜）：
  //     'on'        已启用 —— 正在生效
  //     'available' 可启用 —— 缺外部组件，装了就能生效（给出确切安装目标）
  //     'off'       可启用 —— 被配置关了，改配置即生效（给出确切配置键）
  //     'blocked'   不可启用 —— 依赖不满足 / 平台不支持，当前做什么都没用
  //     'superseded'  被取代 —— 与另一项结构互斥而主动让位（不是故障，也不需修）
  //
  //   `action` 是"该做什么"的一句话 —— 没有可做之事时给空串（UI 不显示那一行）。
  //   `whyOff` 保留：外部（含既有测试）可能还在读它。
  //
  // ★★★ 2026-10-09 新增 `toggle` 字段：**让用户自己开关**。
  //   主人原话：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
  //     TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
  //     请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
  //
  //   有 `toggle` 的项，前端会在那一行渲染一个可点的开关按钮。
  //   形状：{ key, on, canToggle, hint }
  //     · key       —— 开关标识，前端原样回传给 `?<key>=on|off`
  //     · on        —— 当前是开还是关（决定按钮外观）
  //     · canToggle —— false 时按钮置灰（缺节点等，切了也没用）
  //     · hint      —— 鼠标悬停/按钮下方的一句说明
  const item = (name, state, whyOn, whyOff, action, toggle, optional) => {
    detail.push({
      name,
      state,
      on: state === 'on',
      whyOn,
      whyOff,
      action: action ?? '',
      ...(toggle ? { toggle } : {}),
      // ★ 2026-10-11：`optional: true` = **可选实验档**（默认关、不影响"优化是否完整"的判定）。
      //   为什么需要它：像 RDNA4 的 CK 内核这种"厂商专属、默认关"的项，
      //   如果按普通项算，用户一进面板就会看到"优化部分启用（还差 1 项）" —— 纯属噪音。
      ...(optional ? { optional: true } : {}),
    })
  }

  item(
    'turbo8 八步蒸馏',
    plan.useTurbo ? 'on' : (caps.models?.turbo8Lora ? 'off' : 'available'),
    '已生效：LoRA + 采样位移 + 8 步 / CFG 1.0',
    caps.models?.turbo8Lora
      ? `未启用：没在 ComfyUI 的 loras 目录里找到 turbo8 LoRA`
        + `（当前回落的文件名是「${caps.models.turbo8Lora}」，看起来并不存在）。`
        + '把 turbo8_lora_step2500.safetensors 放进 models\\loras 即可。'
      : '未启用：没找到 turbo8 LoRA。放进 models\\loras 后可提速约 7 倍。',
    plan.useTurbo
      ? ''
      : (caps.models?.turbo8Lora
        // 探测到了名字却没用上 → 是配置关的
        ? '把 turbo8Enabled 改回 true（或删掉那一行）后重启 DSH。'
        // 连名字都没探测到 → 需要放文件
        : '把 turbo8_lora_step2500.safetensors 放进 ComfyUI 的 models\\loras 目录，'
          + '重启 ComfyUI 后自动生效（不必改配置）。'),
  )

  // ★★★ 2026-10-12（用户要求）：**极速档（4 步）** 开关。
  //   主人原话：「ui 界面写上一个启用四步时不适用于有文字的情形」。
  //   所以 whyOn / action / hint **三处都要**把"有文字会崩"讲明白 ——
  //   用户打开开关后最容易踩的坑就是这个，不能只写在悬停提示里。
  item(
    '极速档（4 步）',
    plan.useFast4 ? 'on' : (caps.models?.fast4Lora ? 'off' : 'blocked'),
    '已生效：4 步 / CFG 1.0 / 4 步蒸馏位移，实测约 2× 提速（12.1 s → 6~7.5 s）。'
      + '⚠ **不适用于有文字的情形** —— 画面里有中文/英文时文字会崩坏。',
    caps.models?.fast4Lora
      ? '未启用：当前走 8 步（画质更好，文字能正确渲染）。'
      : '不可用：没在 ComfyUI 的 loras 目录里找到 4 步蒸馏 LoRA。',
    caps.models?.fast4Lora
      ? (cfg.fast4Enabled === true
        ? ''
        : '点右边的开关即可启用（即时生效，下次出图走 4 步）。')
      : '把 4 步蒸馏 LoRA（例如 Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors）'
        + '放进 ComfyUI 的 models\\loras 目录，重启 ComfyUI 后这里会自动出现开关。',
    {
      key: 'fast4',
      on: cfg.fast4Enabled === true,
      canToggle: !!caps.models?.fast4Lora,
      // 前端拿这个键写"怎么永久保存"，不再写死 blockCacheEnabled
      persistKey: 'fast4Enabled',
      hint: '⚠ 不适用于有文字的情形：4 步蒸馏牺牲了文字渲染 —— 实测同一 prompt、同一 seed，'
        + '8 步能正确写出「午后」，4 步直接变乱码。画面里需要写字时请关掉它。'
        + '速度：约 2×（实测 12.1 s → 6~7.5 s）。',
    },
    true, // optional：默认关的实验档，不计入"优化是否完整"的判定
  )

  item(
    '前缀 KV 缓存',
    plan.usePrefix ? 'on' : (caps.nodes?.prefixCache ? 'off' : 'available'),
    '已生效：QwenImage21Cache（int8）',
    caps.nodes?.prefixCache
      ? '未启用：被配置关了（qwenCacheEnabled=false）。'
      : '未启用：ComfyUI 里没有 QwenImage21Cache 节点 —— 通常是 ComfyUI 版本偏旧，'
        + '升级到支持 Qwen-Image 2.1 的版本即可。',
    plan.usePrefix
      ? ''
      : (caps.nodes?.prefixCache
        ? '把 qwenCacheEnabled 改回 true（或删掉那一行）后重启 DSH。'
        : '升级 ComfyUI 到带 QwenImage21Cache 节点的版本（Qwen-Image 2.1 支持）。'),
  )

  // TE-Speed / Speedup：**依赖 turbo8 链路**，所以"不可启用"是一个独立状态 ——
  // 这也是主人那句「哪些不能启用」最典型的落点。
  //
  // ★ 2026-10-09：新增 `superseded`（被取代）—— BlockCache 与 TE-Speed/Speedup
  //   三者争抢同一组 DIFFUSION_MODEL wrapper，BlockCache 生效时后两者**主动让位**，
  //   不是"被配置关了"也不是"没装"。显示成 off 会让用户去修一个不该开的开关。
  const depNote = '它依赖 turbo8 链路（阈值是按 8 步调的），turbo8 没生效时不会单独启用。'
  item(
    'TE-Speed 跳步缓存',
    plan.useTe
      ? 'on'
      : (plan.useBlockCache
        ? 'superseded'
        : (!plan.useTurbo ? 'blocked' : (caps.nodes?.teSpeed ? 'off' : 'available'))),
    '已生效',
    plan.useTe
      ? ''
      : (plan.useBlockCache
        // ★ 2026-10-09 二次修正：不再是"无条件让位"，而是**按尺寸让位**。
        ? '按尺寸让位：大尺寸（latent > '
          + `${Number.isFinite(cfg.wrapperAutoTokensThreshold) ? cfg.wrapperAutoTokensThreshold : 16384}`
          + ' tokens，如 1408²=30976）交给 BlockCache T8 —— '
          + '**TE-Speed 在这个尺寸实测 0% 加速**（日志：predicted 0/8 steps），'
          + '白占互斥的 wrapper 坑；小尺寸仍由本项生效（实测 +25.4%）。'
        : (!plan.useTurbo
          ? `未启用：${depNote}`
          : (caps.nodes?.teSpeed
            ? '未启用：被配置关了（teSpeedEnabled=false）。'
            : '未启用：没装 TE-Speed-QwenImage21 自定义节点（少省约 23% 时间）。'))),
    plan.useTe
      ? ''
      : (plan.useBlockCache
        ? '想换回 TE-Speed：把 blockCacheEnabled 改成 false（两者只能二选一）。'
        : (!plan.useTurbo
          // 上游没通 —— 明确告诉用户"先别管这个"
          ? '先让 turbo8 生效（见上一项），本项会自动跟上，无需单独配置。'
          : (caps.nodes?.teSpeed
            ? '把 teSpeedEnabled 改回 true（或删掉那一行）后重启 DSH。'
            : '装 TE-Speed-QwenImage21 自定义节点到 custom_nodes 后重启 ComfyUI。'))),
  )

  // ★ 2026-10-09：新增 `superseded`（被取代）状态 —— Speedup 与 BlockCache 互斥，
  //   BlockCache 生效时 Speedup 是**主动让位**，而不是"被配置关了"或"没装"。
  //   把它显示成 off 会误导用户去"修"一个本来就不该开的开关。
  item(
    'Speedup 步级残差缓存',
    plan.useSpeedup
      ? 'on'
      : (plan.useBlockCache
        ? 'superseded'
        : (!plan.useTurbo ? 'blocked' : (caps.nodes?.speedup ? 'off' : 'available'))),
    '已生效',
    plan.useSpeedup
      ? ''
      : (plan.useBlockCache
        // ★ 2026-10-09 二次修正：同样是**按尺寸让位**，且 Speedup 在大尺寸只有 12.5%。
        ? '按尺寸让位：大尺寸交给 BlockCache T8 —— Speedup 在 1408² 实测只跳过 1/8 步（12.5%），'
          + '而 BlockCache T8 在大尺寸实测 +22.7%；小尺寸仍由本项与 TE-Speed 一起生效。'
        : (!plan.useTurbo
          ? '未启用：同 TE-Speed，依赖 turbo8 链路。'
          : (caps.nodes?.speedup
            ? '未启用：被配置关了（speedupEnabled=false）。'
            : '未启用：没装 ComfyUI-Qwen-Image-2.1-Speedup 自定义节点。'))),
    plan.useSpeedup
      ? ''
      : (plan.useBlockCache
        ? '想让所有尺寸都走 Speedup：把 wrapperPolicy 改成 te（或 blockCacheEnabled 改成 false）。'
        : (!plan.useTurbo
          ? '先让 turbo8 生效（见上一项），本项会自动跟上，无需单独配置。'
          : (caps.nodes?.speedup
            ? '把 speedupEnabled 改回 true（或删掉那一行）后重启 DSH。'
            : '装 ComfyUI-Qwen-Image-2.1-Speedup 自定义节点到 custom_nodes 后重启 ComfyUI。'))),
  )

  // ★ 2026-10-09 新增：BlockCache T8（取代 ToMe 的图生图加速）
  //   它是**插件节点**，没装时整单会被 ComfyUI 拒收 —— 必须靠探测开关兜住，
  //   所以这里也要如实告诉用户"装了就能用"还是"没装"。
  //   ★ 让位关系要说清楚：BlockCache 生效时 TE-Speed / Speedup 是**主动让位**
  //     （superseded），不是故障。用户若想换回去，这里给出确切做法。
  // ★★★ 2026-10-09 二次修正：不再是"要么一直开、要么一直关"，
  //   而是**按出图尺寸自动接管**（wrapperPolicy=auto）。文案必须跟着改，
  //   否则会出现"面板说 BlockCache 关着，但 1408 出图实际在用它"的假报告。
  const wpPolicy = cfg.wrapperPolicy === 'te' || cfg.wrapperPolicy === 'bc' ? cfg.wrapperPolicy : 'auto'
  const wpThreshold = Number.isFinite(cfg.wrapperAutoTokensThreshold) && cfg.wrapperAutoTokensThreshold > 0
    ? cfg.wrapperAutoTokensThreshold : 16384
  item(
    'BlockCache T8 块级缓存',
    plan.useBlockCache ? 'on' : (caps.nodes?.blockCache ? 'off' : 'available'),
    (wpPolicy === 'bc'
      ? '已生效（固定）：wrapperPolicy=bc，所有尺寸都走本项。'
      : `已生效（按尺寸）：latent > ${wpThreshold} tokens（约 1024² 以上，如 1408²=30976）时由本项接管；`
        + '小尺寸让位给 TE-Speed + Speedup。')
      + `｜首块目标残差缓存（threshold ${cfg.blockCacheThreshold ?? 0.03}），`
      + '官方描述保留 Core 的参考图/文本 KV 缓存 ⇒ **与前缀 KV 缓存可叠加**。'
      + '｜大尺寸实测 **+22.7%**（120.75 s → 93.34 s，省 27.4 s）。',
    caps.nodes?.blockCache
      ? '未启用：被配置关了（blockCacheEnabled=false）—— 大尺寸会退回 TE-Speed + Speedup，'
        + '而 TE-Speed 在 1408×1408 实测 **0% 加速**。'
      : '未启用：没装 Comfyui-Qwen-Image-2.1-BlockCache-T8 自定义节点。',
    plan.useBlockCache
      ? '想让所有尺寸都走 TE-Speed + Speedup：把 wrapperPolicy 改成 te（或 blockCacheEnabled 改成 false）。'
      : (caps.nodes?.blockCache
        ? '把 blockCacheEnabled 改回 true（或删掉那一行）后重启 DSH —— 大尺寸就能用上它。'
        : '把 Comfyui-Qwen-Image-2.1-BlockCache-T8 装进 custom_nodes 后重启 ComfyUI。'),
    // ★ 开关（主人要求）：装了节点才能切；没装时置灰，切了也没用。
    {
      key: 'blockcache',
      on: plan.useBlockCache,
      canToggle: caps.nodes?.blockCache === true,
      hint: caps.nodes?.blockCache
        ? (plan.useBlockCache
          ? `当前：开。${wpPolicy === 'auto' ? `按尺寸接管 —— 大于 ${wpThreshold} tokens 时上，小尺寸仍走 TE-Speed + Speedup。` : '所有尺寸都走本项。'}`
          : '当前：关。大尺寸（如 1408²）会退回 TE-Speed + Speedup，'
            + '而 TE-Speed 在那个尺寸实测 0% 加速 —— 建议打开。')
        : '没装 BlockCache T8 节点，开关不可用。',
    },
  )

  // ★ 2026-10-10 新增：RDNA3 FlashAttention（**无损**加速，与上面三者不互斥）。
  //   它已经装在 custom_nodes 里、却一直没接进工作流（等于白装）—— 接上后如实展示。
  // ★★★ 2026-10-11：**按显卡门控** —— 这个节点只认 gfx1100（AMD RDNA3）。
  //   在 N 卡 / I 卡 / RDNA2 / RDNA4 上它既装不了也跑不了，列出来只会让用户白折腾，
  //   所以**直接不显示**（认不出显卡时照旧显示，见 appliesToGpu 的约定）。
  if (appliesToGpu('amd_rdna3')) {
    item(
      'RDNA3 FlashAttention（无损）',
      plan.useRdna3Fa ? 'on' : (caps.nodes?.rdna3fa ? 'off' : 'available'),
      '已生效：注意力走 RDNA3 FlashAttention 内核（**精确注意力**，不改成品）。'
        + '｜1408² 时注意力是采样的大头，这条是纯提速、不掉质量。',
      plan.useRdna3Fa
        ? ''
        : (caps.nodes?.rdna3fa
          ? '未启用：被配置关了（rdna3FlashAttention=false）。'
          : '未启用：没装 RDNA3-Flash-Attention 自定义节点（gfx1100 专用、无损）。'),
      plan.useRdna3Fa
        ? ''
        : (caps.nodes?.rdna3fa
          ? '把 rdna3FlashAttention 改回 true（或删掉那一行）后重启 DSH。'
          : '把 RDNA3-Flash-Attention 装进 custom_nodes 后重启 ComfyUI。'),
    )
  } else {
    hiddenByGpu.push('RDNA3 FlashAttention（无损）')
  }

  // ★★★ 2026-10-11 新增：**A 卡专属优化（可选，仅 AMD 显示）**。
  //   与 N 卡/I 卡的"厂商专属优化"同一套思路：只在适用的显卡上出现、**默认关**、用户自己决定。
  //   两项都**质量中性**（换后端 / 改加载时机，都不改计算结果 ⇒ **不牺牲原生画质**）。
  //   ⚠ 标记为 `optional`：默认关的项**不该**把面板拖成"优化部分启用"（见 item() 的说明）。
  if (String(gpuVendor).startsWith('amd')) {
    const kernelFlag = AMD_KERNEL_FLAG[gpuVendor] ?? null
    if (kernelFlag !== null) {
      const defaultPath = (GPU_PROFILES[gpuVendor]?.args ?? []).join(' ') || '（无额外参数）'
      item(
        `A 卡专属内核（可选）：${kernelFlag}`,
        cfg.amdKernel === true ? 'on' : 'off',
        `已启用：启动参数改用 ${kernelFlag}。⚠ 改这个参数**需要重启 ComfyUI** 才生效。`,
        `未启用：当前走本代默认路径（${defaultPath}）。本项是**可选档**，默认关闭；`
          + '换的是注意力**后端**，不改计算结果、不降画质。',
        cfg.amdKernel === true ? '想回到默认：关掉本项（同样需重启 ComfyUI）。' : '想试：打开本项，然后重启 ComfyUI。',
        {
          key: 'amdkernel',
          on: cfg.amdKernel === true,
          canToggle: true,
          hint: `⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。换成 ${kernelFlag}（质量中性）。`
            + '本项**没在你的卡上实测过**，属可选档；不合适就关回去。',
        },
        true,
      )
    }
    item(
      'A 卡异步卸载（可选）：--async-offload',
      cfg.amdAsyncOffload === true ? 'on' : 'off',
      '已启用：--async-offload（权重加载与计算重叠）。⚠ 需重启 ComfyUI 才生效。',
      '未启用：ComfyUI 的 `--async-offload` **在 N 卡上默认开、在 A 卡上默认关**，本项就是把它补上。'
        + '只改变权重加载的**时机**，不改任何计算结果。',
      cfg.amdAsyncOffload === true ? '想关掉：关掉本项（同样需重启 ComfyUI）。' : '想试：打开本项，然后重启 ComfyUI。',
      {
        key: 'asyncOffload',
        on: cfg.amdAsyncOffload === true,
        canToggle: true,
        hint: '⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。质量中性（只改加载时机）。',
      },
      true,
    )
  }

  // ★★★ 2026-10-11 新增：**N 卡 SageAttention（可选，仅 NVIDIA 显示）**。
  //   40 系（Ada）/ 50 系（Blackwell）的专属注意力加速 —— 与 A 卡的专属优化同一套模式：
  //   只在适用显卡上出现、默认按自检结果、用户可手动接管。
  //   ⚠ 与 A 卡那两项不同：`--use-sage-attention` 是**硬依赖** —— 没装还挂上，ComfyUI 起不来。
  //     所以"确认没装"时**把开关置灰**，而不是让用户点一下就崩。
  if (gpuVendor === 'nvidia') {
    const mode = cfg.nvidiaSageAttention
    const on = mode === true || (mode !== false && SAGE_READY === true)
    const gen = nvidiaGenOf(gpuName)
    const genNote = gen === 'blackwell'
      ? '⚠ 50 系（Blackwell / sm_120）需要**支持 sm_120 的** Triton / SageAttention 构建，老版本不认这代卡。'
      : ''
    // ★★★ 2026-10-13（任务 #62②）：性能 / 兼容模式**中文命名**。
    //   ⚠ 如实说明：ComfyUI 的 `--use-sage-attention` 是全局开关、没有官方子模式参数，
    //     所以本插件**没有**编造"模式"命令行参数 —— 差异全在**崩溃兜底策略**上。
    const sageMode = cfg.nvidiaSageAttentionMode === 'compatibility' ? 'compatibility' : 'performance'
    const sageModeLabel = sageMode === 'compatibility' ? '兼容模式' : '性能模式'
    const crashNote = '崩溃自动回退：若启用 SageAttention 后 ComfyUI 启动失败，'
      + '且日志指向 sage-attention（构造不匹配 / 未装却被强制开启），'
      + '插件会在**本会话内自动关掉它**，不让后端反复崩溃（重试即可恢复）。'
    item(
      `N 卡 SageAttention（可选）：--use-sage-attention｜${sageModeLabel}`,
      on ? 'on' : 'off',
      `已启用：启动参数加上 --use-sage-attention（INT8 量化注意力内核，模式=${sageModeLabel}）。`
        + `⚠ 需重启 ComfyUI 才生效。${genNote}`,
      // ⚠ 顺序很重要：**先看用户是不是显式关了** —— 否则 `nvidiaSageAttention: false`
      //   会被后面"自检还没跑完"的分支盖住，用户明明关了却读到一句无关的话。
      (mode === false
        ? '未启用：被配置关了（nvidiaSageAttention=false）。'
        : (SAGE_READY === false
          ? '未启用：后台自检**没探测到 sageattention** —— 先把它装上，装好后会自动启用（开关当前置灰）。'
          : (SAGE_READY === true
            ? '未启用：被配置关了（nvidiaSageAttention=false）。'
            : '未启用：后台自检还没跑完，状态未知（保守起见先不加）。稍等或出一次图后再回来看。')))
        + ` ${genNote}`,
      SAGE_READY === false
        ? '装法：在对话里说「检查加速环境并安装缺失的包」，或调 check_acceleration 的 install 动作。'
        : '想强制开启：把 nvidiaSageAttention 设成 true（**确定装好了再设** —— 没装会让 ComfyUI 起不来）。'
          + `｜模式：性能模式=标准 INT8 量化；兼容模式=同样参数但对 SageAttention 引发的启动失败始终自动兜底${genNote ? `。${genNote}` : ''}。`,
      {
        key: 'sagesa',
        on,
        // 已确认"没装"时置灰 —— 切了只会让 ComfyUI 起不来（这是硬依赖参数）
        canToggle: SAGE_READY !== false,
        hint: '⚠ 这是启动参数，改完**必须重启 ComfyUI** 才生效。质量中性（只换注意力内核）。'
          + (SAGE_READY === false ? ' 当前**未检测到 sageattention**，开关已置灰 —— 先装它。' : '')
          + (genNote ? ` ${genNote}` : '')
          + ` ${crashNote}`
          + '｜模式在 cordis.patch.yml 里改：nvidiaSageAttentionMode: performance | compatibility。',
      },
      true,
    )
  }

  // ★★★ 2026-10-13（任务 #62③）：**NVFP4 量化模型提示（仅 Blackwell / 50 系）**。
  //   NVFP4 是 Qwen-Image-2.1 在 Blackwell（sm_120）上的低精度权重格式，配合支持的推理栈
  //   可显著提速（社区已有独立 checkpoint：`BennyDaBall/Qwen-Image-2.1-NVFP4`，3 GB 级）。
  //   ⚠ 只**检测 + 提示**，**绝不自动切换模型** —— NVFP4 是单独模型文件，得用户自己下载、
  //      放进 ComfyUI 的 models 目录，并在出图时显式指定该模型名。
  //   ⚠ 本插件开发机是 AMD RX 7900 XT，**NVFP4 路径无法在本机实测** ——
  //      此处如实标注：已验证的是"该 checkpoint 客观存在"，不是"本机跑过"。
  //   ⚠ `optional: true`：它不计入"优化是否完整"的判定（信息项，不是开关）。
  if (gpuVendor === 'nvidia' && nvidiaGenOf(gpuName) === 'blackwell') {
    item(
      'NVFP4 量化模型（Blackwell 专属，可选）',
      'off',
      '当前未启用：NVFP4 是**独立的低精度 checkpoint**（不是开关）—— 需你自行下载 '
        + '`BennyDaBall/Qwen-Image-2.1-NVFP4` 放到 ComfyUI 的 models 目录，'
        + '并在出图时指定该模型名，才会走 NVFP4 路径。',
      '',
      '提示：50 系（Blackwell / sm_120）用 NVFP4 权重通常能明显提速；但它是单独的模型文件，'
        + '本插件**不会**替你切换模型。下载后按你现在选模型的方式指定即可。'
        + '⚠ 此信息项的验证来源是"该 checkpoint 客观存在"，开发机为 AMD，NVFP4 路径**未在本机实测**。',
      // ⚠ **故意不给 toggle** —— 它不是开关：插件不接管模型文件，也没有对应端点。
      //   给它挂个点不动的开关就是"假开关"（面板说一套、实际跑另一套），正是本文件反复踩过的坑。
      undefined,
      true,
    )
  }
  //
  //   这是本轮"苹果端完全没有优化"的正解落点。两件事：
  //     ① `--use-pytorch-cross-attention`（在 apple / mac_amd 档的 args 里）——
  //        ComfyUI 源码里 `ENABLE_PYTORCH_ATTENTION` **没有任何 MPS 分支**，
  //        所以 Mac 默认落到 `attention_sub_quad`（次二次通用实现）；
  //        这个参数才是把它切到 PyTorch SDPA（MPS 上即 Metal 融合内核）的开关。
  //        它由档案自动带上，**不作为开关**（面板只如实说明走了哪条路）。
  //     ② 注入给 ComfyUI 进程的 MPS 环境变量（见 DEFAULTS.appleMpsFallback 的说明）——
  //        这两条**可以关/可以开**，所以列成开关项。
  if (isMac) {
    const profile = GPU_PROFILES[gpuVendor] ?? {}
    const chip = appleChipOf(gpuName)
    const chipNote = chip === '' ? '' : `已识别芯片：Apple ${chip}。`
    const tuning = profile.tuning ?? '默认路径'
    // 统一内存的"够不够装"提示：这条链路的模型约 13.5 GB，
    // 与 MPS 建议工作集一比就知道这台机器会不会 OOM —— 这才是该提醒的事。
    const memGB = Number(caps.gpu?.vramGB ?? 0)
    const memNote = memGB > 0 && memGB < 16
      ? `⚠ 本机 MPS 建议工作集约 ${memGB} GB，而这条链路（UNET+CLIP+VAE）约 13.5 GB ——`
        + '内存偏紧，出图时容易 OOM。可考虑打开下面的「MPS 取消显存水位上限」。'
      : (memGB > 0 ? `本机 MPS 建议工作集约 ${memGB} GB。` : '')
    item(
      'macOS 平台路径（MPS / Metal）',
      'on',
      `${chipNote}走 ${tuning}。macOS 上**没有** CUDA / ROCm / XPU 任何一条厂商计算栈，`
        + '只有 Metal/MPS 或 CPU 两条路 —— 所以插件不会给 Mac 挂任何 CUDA / ROCm 专属参数。'
        + (memNote === '' ? '' : ` ${memNote}`),
      '',
      '',
    )
    item(
      'MPS 算子回退兜底：PYTORCH_ENABLE_MPS_FALLBACK=1',
      cfg.appleMpsFallback === false ? 'off' : 'on',
      '已启用：启动 ComfyUI 时注入 PYTORCH_ENABLE_MPS_FALLBACK=1 —— '
        + 'MPS 后端**未实现**的算子自动回退 CPU 执行，而不是让整次出图直接抛错。'
        + '⚠ 需重启 ComfyUI 才生效。',
      '未启用（被配置关了）：MPS 上碰到未实现的算子会**直接报错**，而不是回退到 CPU。'
        + '除非明确知道自己在做什么，否则建议开着 —— 它不改变任何已支持算子的结果。',
      cfg.appleMpsFallback === false
        ? '想打开：点右边的开关（或把 appleMpsFallback 改回 true），然后重启 ComfyUI。'
        : '想关掉：点右边的开关（同样需重启 ComfyUI）。',
      {
        key: 'applempsfallback',
        on: cfg.appleMpsFallback !== false,
        canToggle: true,
        hint: '⚠ 这是**注入给 ComfyUI 进程的环境变量**，改完必须重启 ComfyUI 才生效。'
          + '质量中性：只影响"本来就会失败"的路径，不改已支持算子的任何数值结果。',
      },
    )
    item(
      'MPS 取消显存水位上限（可选）：PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0',
      cfg.appleMpsUnlimitedMem === true ? 'on' : 'off',
      '已启用：注入 PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 —— **取消 MPS 分配器的硬上限**，'
        + '允许用满统一内存。⚠ 需重启 ComfyUI 才生效。',
      '未启用：沿用 PyTorch 默认水位（官方默认 **1.7**）。本项是**可选档**、默认关闭。'
        + '大模型（如本插件这条约 13.5 GB 的链路）在内存较小的 Mac 上本来会 OOM，'
        + '开了它**可能就能跑**。',
      cfg.appleMpsUnlimitedMem === true
        ? '想关掉：点右边的开关（同样需重启 ComfyUI）。'
        : '想试：点右边的开关，然后重启 ComfyUI。',
      {
        key: 'applempsunlimited',
        on: cfg.appleMpsUnlimitedMem === true,
        canToggle: true,
        hint: '⚠ 这是**环境变量**，改完必须重启 ComfyUI 才生效。'
          + '⚠ 取消硬上限后，一旦系统整体内存耗尽会**把系统一起拖垮**'
          + '（PyTorch 官方原文：may cause system failure）—— 用稳定性换可用性，自己权衡。',
      },
      true,
    )
  }

  // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码**（防 OOM）。
  //   它是"输出侧"的显存保护，与采样链上的加速项互不干扰，所以单独列一项。
  //   状态与文案**必须与 buildWorkflow 的判据同源**（节点在 + 档位 + 显存 + 尺寸），
  //   否则又是"面板说一套、实际跑另一套"。
  {
    const mode = plan.vaeTilingMode ?? 'auto'
    const avail = plan.vaeTiledAvailable === true
    const vramGB2 = Number(caps.gpu?.vramGB || cfg.vramGB || 0)
    const vramNote = vramGB2 > 0
      ? `本机 ${vramGB2} GB ${vramGB2 < 16 ? '**< 16 GB**（显存条件满足，再看尺寸）' : '**≥ 16 GB** → 按判据**不会触发**（想强制开就把 vaeTiling 设为 on）'}。`
      : '（本次没取到显存总量，显存条件暂无法判。）'
    // ★★★ 关键设计：**这台机器会不会用到它？**
    //   只有"显存 < 16 GB"的机器才可能触发分块 ⇒ **只有那些机器上**，"节点缺失"才算真正的缺口。
    //   在 20 GB 这类机器上它根本不会被触发，把"没这个节点"列成缺件纯属噪音 ——
    //   而且会**把一台完全正常的机器报成"优化部分启用"**（这正是本项目反复修的那类假报告）。
    //   ⇒ 用 `optional` 标记（不进"优化是否完整"的判定），只在真可能用到的机器上算必需项。
    const tilingMatters = vramGB2 > 0 && vramGB2 < 16
    item(
      'VAE 大图分块解码（防 OOM）',
      !avail ? 'available' : (mode === 'off' ? 'off' : 'on'),
      (mode === 'on'
        ? '已启用：**所有尺寸**都用 `VAEDecodeTiled` 解码，显存峰值被压到"单块"级别。'
        : '已启用（自动档）：只在**显存 < 16 GB 且出图 > 1024²** 时才分块解码。')
        + `｜依据：Qwen 的 VAE 内部以 **fp32** 跑，大图整图解码的显存峰值会失控`
        + '（第三方源码注释原文：*"Full-image VAE encode/decode of large inputs can OOM"*）。'
        + `｜${vramNote}`
        + `｜分块尺寸 ${Number(cfg.vaeTileSize) || 512}px / 重叠 ${Number(cfg.vaeTileOverlap) || 64}px。`,
      !avail
        ? '不可用：这台 ComfyUI 里**没有 `VAEDecodeTiled` 节点**（版本过旧）—— 它是 ComfyUI **自带**的，'
          + '升级 ComfyUI 即可，插件会自动接上（不需要装任何第三方插件）。'
        : '未启用：被配置关了（`vaeTiling: \'off\'`）。',
      !avail
        ? '升级 ComfyUI 到带 `VAEDecodeTiled` 的版本（界面里叫 "VAE Decode (Tiled)"）后重启 DSH。'
        : (mode === 'off'
          ? '想开：点右边的开关（或把 `vaeTiling` 改成 `auto` / `on`）。'
          : '想强制所有尺寸都分块：把 `vaeTiling` 改成 `on`。'),
      {
        key: 'vaetiling',
        on: mode !== 'off',
        canToggle: avail,
        hint: '⚠ 分块解码带 overlap 重叠，接缝通常无感，但**不是逐位相同** —— '
          + '所以默认只在"显存紧 + 大图"时启用，不在不需要的机器上无条件开。'
          + (avail ? '' : ' 当前**没有这个节点**，开关置灰。'),
      },
      // ★ 只有"显存 < 16 GB 的机器"才把它算成必需项（见上面 tilingMatters 的说明）
      !tilingMatters,
    )
  }

  // ★★★ 2026-10-12 新增（用户反馈）：**Spectrum 跳步加速**（跳过冗余 Qwen 前向）。
  //   与 SADA 同一思路，但**是 Qwen 专用的**；本机已装该节点却从未被插件使用（"白装"）。
  {
    const avail = caps.nodes?.spectrum === true
    const on = cfg.spectrumEnabled === true
    const wu = Number.isFinite(cfg.spectrumWarmupSteps) ? Math.trunc(cfg.spectrumWarmupSteps) : 5
    const tl = Number.isFinite(cfg.spectrumTailActualSteps) ? Math.trunc(cfg.spectrumTailActualSteps) : 2
    const mx = Number.isFinite(cfg.spectrumMaxConsecutiveForecasts) ? Math.trunc(cfg.spectrumMaxConsecutiveForecasts) : 1
    item(
      'Spectrum 跳步加速（可选，默认关）',
      !avail ? 'available' : (on ? 'on' : 'off'),
      `已启用：模型链末端挂 \`${SPECTRUM_NODE}\` —— 在真实步上抓隐状态、`
        + '用岭正则化切比雪夫拟合**预测**后续步的隐状态，从而**跳过部分 Qwen transformer 前向**。'
        + `｜当前参数：warmup ${wu} 步 / 收尾 ${tl} 步真实，最多连跳 ${mx} 步。`
        + `｜⚠ 本链只有 8 步 ⇒ warmup+tail=${wu + tl} 步走真实，**实际可跳 ${Math.max(0, 8 - wu - tl)} 步**。`
        + '⚠ 需重启 ComfyUI 才生效。',
      !avail
        ? '不可用：没装 `ComfyUI-Spectrum-Qwen-Proper`（`QwenSpectrumModelPatcher` 由它提供）。'
        : '未启用：**默认关** —— 本机 1024² turbo8 链**真机实测**（见 `_spectrum_ab.mjs`）：'
          + ' 基线 13.1s vs Spectrum 默认 18.2s（**慢 27.7%**），'
          + '即便把 warmup/tail 调到适合 8 步（2/1）仍慢 23.4%。'
          + '原因：8 步里被吃 7 步，预测器自身开销 > 跳步收益。'
          + '⚠ 节点作者自述 *"not a paper-exact universal Qwen port"*、**不保证通用兼容**；'
          + '⚠ 本次没测 ≥ 20 步原生链，**那边有收益的可能**未排除，但**仍属叠加项**，要先单张对比再开。',
      on
        ? '想关掉：点右边的开关（或把 `spectrumEnabled` 设为 false），然后重启 ComfyUI。'
        : '想试：点右边的开关，然后重启 ComfyUI。⚠ **先单张对比画质再决定长期开不开**。',
      {
        key: 'spectrum',
        on,
        canToggle: avail,
        hint: '⚠ 这是**工作流节点**（不是启动参数），但改了要重启 ComfyUI 让它重新加载节点图。'
          + '⚠ 越激进（warmup/tail 越小、连跳越多）越快、画质风险越高 —— 作者原话：'
          + '"compare results and tune aggression based on your workflow"。',
      },
      true,
    )
  }

  // ★★★ 2026-10-12 新增（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文）。
  //   与 Spectrum 同源（跳过部分 transformer 前向），但走**新的采样分布**。
  //   ⚠ 本机**未装**该节点（`custom_nodes/` 无 sada 痕迹）⇒ 默认关，**不自动下载**。
  //   论文的 "1.2–2.0×" 是基准对比，**不是**本项目的工作点。
  {
    const avail = caps.nodes?.sada === true
    const on = cfg.sadaEnabled === true
    const sadaClass = String(cfg.sadaNodeClass ?? SADA_NODE_DEFAULT)
    const thr = Number.isFinite(cfg.sadaThreshold) ? cfg.sadaThreshold : 0.15
    item(
      'SADA 跳步采样（可选，默认关）',
      !avail ? 'available' : (on ? 'on' : 'off'),
      `已启用：模型链末端挂 \`${sadaClass}\` —— ICML 2025 论文 (arXiv 2507.17135) 提出的`
        + '随机对抗式扩散加速，**跳过部分 Qwen transformer 前向**（与 Spectrum 同源但走新分布）。'
        + `｜当前参数：阈值 ${thr}、${cfg.sadaPatchSampler !== false ? '同时挂 sampler' : '只挂 model'}。`
        + '⚠ 需重启 ComfyUI 才生效。',
      !avail
        ? '不可用：没装 SADA 节点（默认 class_type `' + SADA_NODE_DEFAULT + '`，由 `liming123332/comfyui-sada-icml` 提供）。'
        : '未启用：**默认关** —— ① 论文的 "1.2–2.0×" 是基准对比，**不是**本项目工作点；'
          + '② 本机未做真机 A/B（**开之前必须单张对比画质**）；'
          + '③ 节点作者未给出 Qwen-Image 2.1 画质保证。',
      on
        ? '想关掉：点右边的开关（或把 `sadaEnabled` 设为 false），然后重启 ComfyUI。'
        : '想试：点右边的开关，然后重启 ComfyUI。⚠ **先单张对比画质再决定长期开不开**。',
      {
        key: 'sada',
        on,
        canToggle: avail,
        hint: '⚠ 这是**工作流节点**（不是启动参数），改了要重启 ComfyUI。'
          + '⚠ 节点 class_type 由 `sadaNodeClass` 控制（默认 `' + SADA_NODE_DEFAULT + '`），'
          + '若实际安装的节点 class_type 不同，改这个配置即可，不用动代码。',
      },
      true,
    )
  }

  // ★★★ 2026-10-12 新增（用户要求 + 审计文档）：**OOM 自动回退**。
  //   出图撞 OOM 时**自动**强制 `vaeTiling='on'` 重跑一次；再 OOM 则如实抛错。
  {
    const on = cfg.oomAutoFallback !== false
    item(
      'OOM 自动回退（默认开）',
      on ? 'on' : 'off',
      '已启用：出图撞 OOM（"out of memory" / "OutOfMemoryError" / CUDA / hip / MPS 之一）时，'
        + '**自动**强制 `vaeTiling=\'on\'` 重跑一次（用 ComfyUI 自带 `VAEDecodeTiled` 分块解码，'
        + '零新增依赖、几乎不掉画质）。如果第二次仍 OOM，把错误如实抛出（**绝不静默吞**）。'
        + '｜本机 16GB 显存实测 1408² 撞过 OOM，开启后第二次就出了图。',
      on ? '' : '未启用：**不推荐**关。OOM 是硬约束，回退比失败好。',
      // ⚠ `item()` 是 **7 个参数**：(name, state, whyOn, whyOff, action, toggle, optional)。
      //   约定：**已启用项不带 action**（没什么可做的）—— 关掉它请用面板上的开关。
      //   我第一版在"已启用"时仍给了"想关掉…"，直接违反这条约定（测试当场拦下）。
      on
        ? ''
        : '想开：把 `oomAutoFallback` 设为 true（或留空 = 默认开）。',
      { key: 'oom', on, canToggle: true, hint: '⚠ 关掉后撞 OOM 会直接报错，不再自动重跑。' },
      false,
    )
  }

  // ★ 2026-10-09 二次修正新增：**三选一策略**单独列一项。
  //   这三者互相排斥，用户最需要知道的不是"每一项开没开"，
  //   而是"这次出图到底走哪一套、凭什么"。不列出来就只能靠猜。
  item(
    '互斥三选一策略（wrapper）',
    'on',
    (wpPolicy === 'auto'
      ? `按尺寸自动：latent ≤ ${wpThreshold} tokens → TE-Speed + Speedup（小尺寸实测 +25.4%）；`
        + `> ${wpThreshold} tokens → BlockCache T8（大尺寸实测 +22.7%）。`
      : (wpPolicy === 'te'
        ? '固定 TE-Speed + Speedup（所有尺寸）。⚠ 大尺寸下 TE 实测 0% 加速，等于白占坑。'
        : '固定 BlockCache T8（所有尺寸）。⚠ 小尺寸下 TE+Speedup 更快（+25.4% vs +22.7%）。'))
      + '｜三者争抢同一组 DIFFUSION_MODEL wrapper，绝不会同时上两个（同挂会 ValueError 整单失败）。'
      + `｜改法：cordis.patch.yml 设 wrapperPolicy: auto | te | bc；`
      + `auto 的分界用 wrapperAutoTokensThreshold（当前 ${wpThreshold}）。`,
    '',
  )

  // ★★★ 2026-10-09 新增：**显存驻留**才是整条工作流 90 秒 → 30~40 秒的真正解药。
  //   加速节点只省"采样那 8 步"（8~11 秒）；而整条工作流实测 90~150 秒，
  //   差额几乎全在**模型反复装卸**上（UNET 6.9 + CLIP 6.0 + VAE 0.64 ≈ 13.5 GB
  //   装不进当时可用的 12.09 GB）。所以这一项必须**显式列出来**，
  //   否则用户会以为"优化打了跟没打一样"——正是主人上次的原话。
  //   它由启动参数决定，不在工作流里，所以单独描述。
  //   ★★★ 2026-10-12：**macOS 上不列这一项**。
  //     依据（ComfyUI 源码）：MPS 上 `vram_state` 被强制成 `SHARED`，
  //     驻留档位**根本不参与**（详见 VRAM_ARGS 的 IS_MAC 分支）。
  //     而 `plan.residency` 是按**离散显存**算的 ⇒ Mac 上必然 `applicable: false`
  //     ⇒ 状态是 `blocked`（"不可启用"）⇒ 把一台完全正常的 Mac 报成"优化部分启用"。
  //     所以改成**放进"已隐藏"清单并写明原因**：不静默消失（用户知道为什么没这一项），
  //     也不误报成缺件。
  if (isMac) {
    hiddenByGpu.push('显存驻留（--highvram）：macOS 走 MPS / 统一内存，这组离散显存参数在 MPS 上不参与')
  } else {
    item(
      '显存驻留（--highvram）',
      plan.residency?.on ? 'on' : (plan.residency?.applicable ? 'off' : 'blocked'),
      `已生效：${plan.residency?.note ?? ''}`
        + '｜模型常驻显存，避免每次出图反复装卸（这是整条工作流耗时的大头）。',
      plan.residency?.applicable
        ? `未启用：${plan.residency?.note ?? ''}`
        : `不适用：${plan.residency?.note ?? '未取到显存总量，插件不擅自加驻留参数。'}`,
      plan.residency?.on
        ? ''
        : (plan.residency?.applicable
          ? '把 comfyArgs 里的自定义参数删掉（让它回到自动档），或自行加上 --highvram。'
          : '让 ComfyUI 的 python 可被探测到（通常装好即自动），随后重启 DSH 即会重判。'),
    )
  }

  // 把"没生效"的逐条汇总成 reason（这才是用户真正要看的东西）
  //   ★ 被取代项（superseded）不进 reasons —— 它不是"没生效"，是主动让位，
  //     塞进待办清单会让用户去修一个本来就不该开的开关。
  for (const one of detail) {
    // ★ 2026-10-11：`optional`（A 卡专属可选档）**不进 reasons** ——
    //   它是"默认关、想试再开"的项，不是"缺了什么"，列进待办只会让人去修一个本就不该开的开关。
    if (!one.on && one.state !== 'superseded' && one.optional !== true) reasons.push(one.whyOff)
  }

  // ★ 状态统计 —— summary 与 UI 的「可做之事」都靠它。
  //   2026-10-09：新增 `superseded`（被取代）一态，见上面 Speedup 那段注释。
  // ★ 2026-10-11：`optional`（可选档）**单独一桶**，不再混进 on/available/off/blocked ——
  //   否则"默认关的可选项"会被算成"1 项可启用"，把总账搅浑。各桶之和 = total。
  const countOf = (state) => detail.filter((d) => d.optional !== true && d.state === state).length
  const optionalItems = detail.filter((d) => d.optional === true)
  const stats = {
    on: countOf('on'),
    available: countOf('available'),
    off: countOf('off'),
    blocked: countOf('blocked'),
    superseded: countOf('superseded'),
    optional: optionalItems.length,
    // ★★★ 2026-10-11 补：可选项里**已经打开**的有几个。
    //   没有它的话，用户把可选项打开之后总账仍会写「N 项可选（**默认关**）」—— 自相矛盾。
    //   ⚠ 它是 `optional` 的**子计数**（不是独立一桶），所以"各桶之和 = total"不受影响。
    optionalOn: optionalItems.filter((d) => d.state === 'on').length,
    total: detail.length,
  }

  // ── 探测本身没成功：这跟"确实缺件"是两回事，必须分开说 ────────────────
  if (caps.probeFailed) {
    // ★★★ 关键：这时候上面那四项的 state 是**按"能力齐全"假设**算出来的，
    //   （resolvePlan 在探测失败时会照 FULL_CAPS 的语义走），
    //   直接把它们显示成"已启用"就是骗人 —— 用户会以为加速都生效了。
    //   所以整批改写成 `unknown`，前端显示"未确认"而不是"已启用"。
    const uncertain = detail.map((d) => ({
      ...d,
      state: 'unknown',
      on: false,
      action: '等 ComfyUI 起来后重新检测（通常点一次出图即可）。',
    }))
    for (const one of uncertain) one.whyOff = '未确认：本次探测没成功，无法判断这一项到底能不能用。'
    return {
      level: 'probe-failed',
      ok: false,
      summary: '优化状态未确认（探测失败）',
      reasons: [
        '插件没能从 ComfyUI 读到节点/模型清单（接口无响应或超时），'
        + '所以**无法确认**优化是否可用 —— 这不代表缺件，也不代表优化没生效。',
        '出图时插件会重新探测。若反复出现，请确认 ComfyUI 正在运行、且 8188 端口可达。',
      ],
      detail: uncertain,
      // ★ 未确认时各态一律归零 —— 报"4 项已启用"是假报告，"4 项可用"也是假报告。
      // ★★★ 2026-10-11 修 bug：`unknown` 必须**排除可选项** ——
      //   否则它会与 `optional` **重复计数**（实测 total=10 / unknown=10 / optional=2 ⇒ 求和 12），
      //   客户端总账会出现「共 10 项：10 项未确认 · 2 项可选」这种自相矛盾的显示。
      stats: {
        on: 0,
        available: 0,
        off: 0,
        blocked: 0,
        superseded: 0,
        optional: detail.filter((d) => d.optional === true).length,
        // 探测失败时所有项都是 unknown ⇒ 可选项一个都没开
        optionalOn: 0,
        unknown: detail.filter((d) => d.optional !== true).length,
        total: detail.length,
      },
      // ★ 显卡过滤结果照带（探测失败时 `caps.gpu` 往往也是空的 → 不隐藏，如实反映）
      gpu: gpuName === '' ? null : { name: gpuName, vendor: gpuVendor },
      filtered: hiddenByGpu,
      // ★★★ 2026-10-11 去重：探测失败时 `reasons` 已经把"读不到清单"说清楚了，
      //   而 `caps.notes` 里那句「⚠ 能力探测有 N/M 项未成功…」是**同一件事**——
      //   两条都显示等于让用户在面板上看两遍同样的内容。
      //   所以这里把它排除掉；**其余 ⚠ note（如缺 UnetLoaderGGUF / 缺 TextEncodeQwenImage21）
      //   照常保留** —— 那两条是"机器知道、但用户看不到就白折腾"的硬缺口。
      warnings: importantNotesOf(caps).filter((n) => !String(n).includes('项未成功')),
    }
  }

  // ── ComfyUI 没启动（idle）：上面已经提前 return，这里只会是「真探测过」的情形 ──

  // ── 一切正常 ─────────────────────────────────────────────────────────
  // ★ 各项**全都要算进来**：早先这里只看了 turbo8 + 前缀缓存，于是"没装 TE-Speed"
  //   这种确实少了一层优化的情况，照样报"优化已启用"—— 报告等于骗人。
  //
  //   2026-10-09：改成按「**未解决**项」判定。三种"没生效"要分开看：
  //     · blocked / off / available → 真的没生效，**算未解决** → 不能报 full
  //     · superseded（被取代）      → 是主动让位，**不算未解决** → 不拉低 level
  //   原先用 `plan.useTe` 直接判定是错的 —— 让位后它必然是 false，
  //   会把一条完全健康的链路误报成"部分启用"。
  const unresolved = detail.filter((d) => d.state !== 'on' && d.state !== 'superseded' && d.optional !== true)
  const allOn = unresolved.length === 0

  // ★ summary 升级：不只是"缺了哪几项"，而是**分别点出"能补的"和"补不了的"**。
  //   主人要的正是这个区分 —— 全堆在一起用户不知道从哪下手。
  let summary
  if (allOn) {
    const superNote = stats.superseded > 0 ? `（${stats.superseded} 项按尺寸让位）` : ''
    // ★ 2026-10-09 二次修正：BlockCache 已**不是恒定生效**，而是按出图尺寸与
    //   TE-Speed + Speedup 二选一。所以这里不能无条件写"+ BlockCache" ——
    //   小尺寸实际挂的是 TE+Speedup，写成 BlockCache 就是"面板说一套、实际跑另一套"。
    const chainNote = wpPolicy === 'bc'
      ? ' + BlockCache T8'
      : (wpPolicy === 'te'
        ? ' + TE-Speed + Speedup'
        : ' + wrapper 按尺寸自动（小尺寸 TE+Speedup / 大尺寸 BlockCache T8）')
    summary = `优化已启用（8 步 / CFG 1.0 全栈链路${chainNote}）${superNote}`
  } else if (!plan.useTurbo) {
    summary = '未启用优化：回退到 25 步原生链路（较慢，但一定能出图）'
  } else {
    const fixable = stats.available + stats.off
    const stuck = stats.blocked
    summary = fixable > 0
      ? `优化部分启用（还差 ${fixable} 项可启用）`
      : `优化部分启用（${stuck} 项当前不可启用）`
  }

  return {
    level: allOn ? 'full' : (plan.useTurbo ? 'turbo' : 'basic'),
    ok: allOn,
    summary,
    reasons: allOn ? [] : reasons,
    detail,
    // ★ 状态计数 —— 前端据此决定标题下方那行"可做之事"怎么措辞。
    stats,
    // ★★★ 2026-10-11：**按显卡过滤的结果**（见函数上方 appliesToGpu 的说明）。
    //   `gpu` 让前端能显示"按哪张卡过滤的"；`filtered` 是被藏掉的项名 ——
    //   不静默消失：用户至少知道"藏了哪几项、为什么"。
    gpu: gpuName === '' ? null : { name: gpuName, vendor: gpuVendor },
    filtered: hiddenByGpu,
    // ★★★ 2026-10-11：关键能力缺口（如"缺 UnetLoaderGGUF 节点"）——
    //   以前只在日志里，面板上看不到；现在如实带出去，由前端置顶显示。
    warnings: importantNotesOf(caps),
  }
}

/* ------------------------------------------------------------------ 工具本体 ---- */

/** 参数 schema（标准 JSON Schema；只用官方 present 用过的那几个关键字）。 */

// ===== moved from index.js: PARAMETERS (was lines 4539-4585) =====

export { describeOptimization, genericOptimizations }
