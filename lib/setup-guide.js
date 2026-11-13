/**
 * lib/setup-guide.js —— 图形化傻瓜式安装引导的**唯一数据源**（纯数据 / 纯函数）。
 *
 * ## 为什么单独一个文件
 *   `lib/client.js` 贴着 DSH Store 的 256 KB 单文件上限，UI 一律放 assets/；
 *   步骤清单、命令、状态判定则必须是**可离线测试的纯逻辑**，不能塞进 UI 脚本里。
 *
 * ## 安全口径（不妥协）
 *   · 本模块**不执行任何命令**、不联网、不落盘、不派生子进程；
 *   · 每条命令都标注 `network`（是否联网下载）与 `consent`（是否需要用户显式同意）；
 *   · 网页引导**只负责展示与复制命令**，绝不从 host 端 spawn 本地安装进程 ——
 *     从网页直接启动安装等于把「本机任意命令执行」暴露给页面，不这么做。
 *   · 视频模型包（--video-models）与核显包（--igpu-download）都是**可选且默认关闭**，
 *     这里只如实列出，不替用户勾选。
 */

/** 步骤状态。checking 用于端点还没返回真实状态时，绝不假装完成。 */
export const SETUP_STEP_STATUS = Object.freeze({
  DONE: 'done',
  TODO: 'todo',
  OPTIONAL: 'optional',
  CHECKING: 'checking',
})

/**
 * 傻瓜式引导的七个步骤。顺序即 UI 上的卡片顺序。
 * `command` 是可直接复制的一行命令；`hint` 是大白话；`risk` 只做如实标注。
 */
export const SETUP_STEPS = Object.freeze([
  {
    id: 'check',
    title: '先看看这台机器差什么',
    hint: '只读检查，什么都不装、什么都不改。先看清楚再动手。',
    command: 'node scripts/setup.mjs --check',
    network: false,
    consent: false,
    optional: false,
    seconds: 10,
  },
  {
    id: 'comfy',
    title: '装 ComfyUI 本体',
    hint: '没有 ComfyUI 就什么都画不了。官方便携包不公布哈希，所以脚本默认不自动下它 —— 这一步要你明确同意。',
    command: 'node scripts/setup.mjs --download-comfy',
    network: true,
    consent: true,
    optional: false,
    seconds: 600,
    extra: '不想用命令行：直接双击仓库根目录的「一键安装.cmd」，它会自报版本和文件指纹再问一句。',
  },
  {
    id: 'main',
    title: '装生图主模型',
    hint: '千问 Qwen-Image 2.1。显存够选 full（画质最好），显存小选 lite（GGUF Q4_K_M，约 4.6 GB）。',
    command: 'node scripts/setup.mjs --tier full',
    network: true,
    consent: true,
    optional: false,
    seconds: 900,
    choices: [
      { label: '画质优先（full / int8）', command: 'node scripts/setup.mjs --tier full' },
      { label: '小显存（lite / GGUF Q4_K_M）', command: 'node scripts/setup.mjs --tier lite' },
    ],
  },
  {
    id: 'video',
    title: '装视频模型（可选 · 主推能力）',
    hint: '文生视频 / 图生视频靠它。插件**提供自动视频模型下载包**：从官方仓库动态拉清单，按服务器权威大小与 SHA256 校验，多源自动切换。权重 9–32 GB，所以默认不装，要你说了算。',
    command: 'node scripts/setup.mjs --video-models',
    network: true,
    consent: true,
    optional: true,
    seconds: 1800,
    extra: '无人值守可加 --video-pick <编号>；装完重启一次 ComfyUI 让新权重进模型列表。',
  },
  {
    id: 'tts',
    title: '装语音模型（可选 · 主推能力）',
    hint: 'Qwen3-TTS 语音合成。界面里可以直接选，但**插件不自动下载音频模型权重** —— 按你定的规矩，缺件时给明确清单，不替你下。',
    command: '',
    network: false,
    consent: false,
    optional: true,
    seconds: 0,
    extra: '放到 ComfyUI 的 models/qwen-tts/；节点装 custom_nodes/ComfyUI-Qwen-TTS。可在界面里用「能力体检」查缺件。',
  },
  {
    id: 'igpu',
    title: '核显 / 小内存档位（可选）',
    hint: '核显机能跑：先列型号、选一档，脚本会给出分辨率、量化与后端建议。只有显式加 --igpu-download 才真下模型。',
    command: 'node scripts/setup.mjs --list-igpu',
    network: false,
    consent: false,
    optional: true,
    seconds: 5,
    extra: '型号清单里的秒数是社区其它模型数据，非本插件实测，不可与速度门槛直接比较。',
  },
  {
    id: 'plugin',
    title: '把插件挂进 DSH 并验收',
    hint: '最后一步：挂进 DSH，然后回对话里说一句「画一只猫」，30 秒内应该直接看到图。',
    command: 'dsh plugin --profile desktop add link:<本插件目录的绝对路径>',
    network: false,
    consent: false,
    optional: false,
    seconds: 60,
    extra: '用 desktop profile 前先完全退出 DSH。挂好后：生图 / 视频 / TTS 三条能力都能在界面里点。',
  },
])

/** 只暴露会被 UI 用到的字段，避免把内部注释也塞进 JSON。 */
export function publicSteps() {
  return SETUP_STEPS.map((s) => ({
    id: s.id, title: s.title, hint: s.hint, command: s.command,
    network: s.network, consent: s.consent, optional: s.optional,
    extra: s.extra ?? '', choices: s.choices ?? [],
  }))
}

/**
 * 把 host 采集到的真实状态合并进步骤清单。
 * 拿不到某个字段时一律是 `checking`，**绝不默认成 done**。
 * @param {object} [state] { online, mainModel, videoModels, tts, plugin }
 */
export function buildSetupGuideReport(state = {}) {
  if (state === null || typeof state !== 'object') state = {}
  const known = {
    check: state.checked === true,
    comfy: state.online === true,
    main: state.mainModel === true,
    video: state.videoModels === true,
    tts: state.tts === true,
    igpu: state.igpu === true,
    plugin: state.plugin === true,
  }
  const hasProbe = Object.keys(known).some((k) => state[k] !== undefined)
  const steps = publicSteps().map((s) => {
    let status = SETUP_STEP_STATUS.CHECKING
    if (known[s.id]) status = SETUP_STEP_STATUS.DONE
    else if (hasProbe || state.online !== undefined) status = s.optional
      ? SETUP_STEP_STATUS.OPTIONAL
      : SETUP_STEP_STATUS.TODO
    return { ...s, status }
  })
  const required = steps.filter((s) => !s.optional)
  return {
    ok: true,
    schema: 'dsh-qwen-paint/setup-guide@1',
    probed: hasProbe,
    steps,
    total: steps.length,
    done: steps.filter((s) => s.status === SETUP_STEP_STATUS.DONE).length,
    requiredTotal: required.length,
    requiredDone: required.filter((s) => s.status === SETUP_STEP_STATUS.DONE).length,
    ready: required.every((s) => s.status === SETUP_STEP_STATUS.DONE),
    headline: '视频 / 生图 / TTS 全能 · 本机运行',
    videoDownloadPack: {
      available: true,
      flag: '--video-models',
      defaultOff: true,
      note: '自动视频模型下载包已随插件提供；默认不装、需显式同意、按服务器权威 size+sha256 校验。',
    },
    safety: {
      webCannotInstall: true,
      note: '网页引导只展示与复制命令，不从浏览器触发本机安装进程；所有联网下载都需要你在终端里明确执行。',
    },
  }
}
