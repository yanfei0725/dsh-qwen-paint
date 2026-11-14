/**
 * lib/diagnose-error.js —— C17 错误信息可操作化。
 *
 * 解决的问题：ComfyUI 的报错原文对使用者几乎没有信息量 ——
 *   `Prompt outputs failed validation: Return type mismatch between linked nodes`
 * 这句话说了三件事（提交被拒、是校验问题、跟连线类型有关），但没有一件告诉
 * 使用者「我该做什么」。本模块把常见失败翻译成**结构化诊断**：
 * 缺哪个节点 / 是不是显存 / 该退到哪一档 / 补齐之后大概能好多少。
 *
 * ★★ 一条自我约束：`gain`（预估收益）只在**有把握**时给，且写成量级或条件式
 *   （「从不可用变为可用」「预计快 1.5–2 倍」），绝不编出「快 37%」这种精确数字。
 *   没把握就写空串 —— 编一个好看的数字比不给更坏。
 *
 * 纯函数，无 IO，可逐条断言。
 */

/** 诊断类别。外部集成可以按 code 分支，不用解析中文文案。 */
export const DIAG_CODES = [
  'missing_node', 'missing_model', 'oom', 'validation', 'missing_file', 'offline', 'interrupted', 'unknown',
]

const RULES = [
  {
    code: 'offline',
    test: /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|连不上 ComfyUI|ComfyUI.*没在跑/iu,
    title: '连不上 ComfyUI',
    detail: '插件要调的本机 ComfyUI 服务没有响应。',
    fixes: [
      { action: '确认 ComfyUI 已经启动（默认 127.0.0.1:8188）', why: '本插件不自带推理后端，只是它的调用方' },
      { action: '在左下角状态点菜单里点「启动 ComfyUI」让插件帮你拉起来', why: '首次启动要加载十几 GB 模型，可能需要几分钟', gain: '从不可用变为可用' },
      { action: '如果改了端口，确认插件配置里的 comfyUrl 与之一致', why: '端口不一致时两边都"看起来正常"但就是连不上' },
    ],
    retryable: true,
  },
  {
    code: 'missing_node',
    test: /Cannot execute because node .* does not exist|node .* does not exist|No class_type|class_type .* not (?:found|registered)|IMPORT FAILED/iu,
    title: '缺 ComfyUI 节点（插件包没装全）',
    detail: '工作流里用到的某个节点在你的 ComfyUI 里不存在，整条链无法执行。',
    fixes: [
      { action: '看下面 node 字段点名的是哪个节点，装对应的 ComfyUI 插件包', why: '节点属于各自的第三方包，本插件不代为安装', gain: '从不可用变为可用' },
      { action: '装完重启 ComfyUI 再重试', why: 'ComfyUI 只在启动时扫描 custom_nodes' },
      { action: '先跑 list_available_models 看当前到底认到了哪些能力', why: '能区分"包没装"和"装了但加载失败（IMPORT FAILED）"' },
    ],
    retryable: true,
  },
  {
    code: 'oom',
    test: /out of memory|OutOfMemory|allocation on device|HIP out of memory|CUDA out of memory|CUBLAS_STATUS_ALLOC_FAILED|failed to allocate/iu,
    title: '显存不够（OOM）',
    detail: '推理过程中显存被用尽。常见于分辨率/帧数偏高，或同时有别的任务在占显存。',
    fixes: [
      { action: '把显存档位改到「省显存」（--lowvram）；极端情况用「最省显存」（--novram）', why: '权重按需换入内存，显著降低显存峰值', gain: '通常能从 OOM 变成可跑，代价是变慢' },
      { action: '降低出图边长或视频帧数', why: '显存占用大致随像素数增长；边长砍到 3/4 大约省一半', gain: '显存需求降幅最大的一档' },
      { action: '先查一下是不是别的任务/插件正占着显存（GET /api/qwen-paint/config/options 之外可看 /queue）', why: '别人的任务占满显存时，自己怎么调都会 OOM' },
      { action: '前缀缓存档位改「省显存」（cpu+int8）', why: '把前缀 KV 缓存放进系统内存，不跟权重抢显存' },
    ],
    retryable: true,
  },
  {
    code: 'missing_model',
    test: /Value not in list|not in \[|model.*not found|CheckpointLoader.*(?:not found|invalid)|unet_name|clip_name|vae_name/iu,
    title: '模型文件不在 ComfyUI 的候选列表里',
    detail: '工作流写的模型名，在 ComfyUI 扫到的文件里找不到 —— 通常是没下载，或放错了目录。',
    fixes: [
      { action: '确认模型文件放在 ComfyUI 对应的 models 子目录（unet / clip / vae / loras）', why: 'ComfyUI 按目录类型扫描，放错目录等于没放' },
      { action: '用 list_available_models 看当前识别到的模型清单', why: '能立刻确认是"没下"还是"命名不一致"' },
      { action: '需要的话用插件的可选下载能力补齐（默认关闭，需显式开）', why: '本插件不擅自下载大权重', gain: '从不可用变为可用' },
    ],
    retryable: true,
  },
  {
    code: 'validation',
    test: /failed validation|custom_validation_failed|Return type mismatch|Required input is missing|Invalid input|Prompt outputs failed/iu,
    title: '参数校验没过（提交被拒）',
    detail: 'ComfyUI 在执行前就拒绝了这份工作流：某个输入缺失、类型不匹配、或值不在允许范围内。',
    fixes: [
      { action: '看 detail 里点名的字段，对照该节点的真实槽位', why: '多半是可选槽位给了空值，或枚举值拼错' },
      { action: '若是文件类输入，确认传的是 ComfyUI 侧能看到的相对路径（如 input/a.wav）而不是本机绝对路径', why: '跨进程时本机绝对路径对方看不见；本项目实测过 VHS_LoadAudio 必须带 input/ 前缀' },
      { action: '重跑一次；参数是随机生成时，换个种子可能就过了', why: '极少数情况是极端参数组合触发边界' },
    ],
    retryable: true,
  },
  {
    code: 'missing_file',
    test: /ENOENT|no such file or directory|读不到|找不到文件/iu,
    title: '文件不存在或读不到',
    detail: '要读的参考图 / 音轨 / 蒙版在磁盘上找不到，或没有读权限。',
    fixes: [
      { action: '确认路径拼写与文件确实存在', why: '中文路径、盘符大小写在跨工具传递时容易出问题' },
      { action: '如果文件刚被移动/删除，从生成历史里重新取一次路径', why: 'list_generated_images 记的是入库时的相对路径' },
      { action: '确认扩展名与实际格式一致（改后缀不改内容会解码失败）', why: '按扩展名选解码器是最常见的坑' },
    ],
    retryable: false,
  },
  {
    code: 'interrupted',
    test: /interrupted|cancel|aborted|已取消|已中断/iu,
    title: '任务被中断',
    detail: '任务没有跑完就结束了 —— 通常是主动取消，或 ComfyUI 侧被中断。',
    fixes: [
      { action: '确认不是自己点了取消', why: '取消是正常路径，不需要排查' },
      { action: '如果没人取消，检查 ComfyUI 是否崩溃重启过', why: '进程崩溃会让所有在飞任务变成中断' },
    ],
    retryable: true,
  },
]

/** 从错误文本里抠出最可能的节点名。抓不到就返回空串（不猜）。 */
export function extractNodeName(text) {
  const s = String(text ?? '')
  const pats = [
    /Cannot execute because node\s+([A-Za-z0-9_]+)\s+does not exist/iu,
    /node\s+([A-Za-z0-9_]+)\s+does not exist/iu,
    /class_type\s*['"]?([A-Za-z0-9_]+)['"]?\s*(?:not found|does not exist)/iu,
    // node_errors 的 JSON 里通常是 {"5": {"class_type": "XXX", ...}}
    /"class_type"\s*:\s*"([A-Za-z0-9_]+)"/u,
  ]
  for (const p of pats) {
    const m = p.exec(s)
    if (m && m[1]) return m[1]
  }
  return ''
}

const textOf = (input) => {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  if (typeof input?.message === 'string') return input.message
  try { return JSON.stringify(input) } catch { return String(input) }
}

/**
 * 把任意错误翻译成结构化诊断。
 *
 * @param {Error|string|object} input
 * @returns {{code:string, title:string, detail:string, node:string,
 *   fixes:Array<{action:string, why:string, gain:string}>, retryable:boolean,
 *   raw:string, matched:boolean}}
 */
export function diagnoseError(input) {
  const raw = textOf(input).replace(/\s+/g, ' ').trim()
  const node = extractNodeName(raw)
  const rule = RULES.find((r) => r.test.test(raw))
  if (!rule) {
    return {
      code: 'unknown',
      title: '未识别的失败',
      detail: raw === '' ? '没有拿到错误信息。' : raw.slice(0, 300),
      node,
      fixes: [
        { action: '看插件日志里这一轮的完整记录', why: '结构化诊断只覆盖常见模式，少见错误需要原文', gain: '' },
        { action: '把这段错误原文发给插件作者', why: '未知模式值得补进诊断表', gain: '' },
      ],
      retryable: true,
      raw: raw.slice(0, 600),
      matched: false,
    }
  }
  return {
    code: rule.code,
    title: rule.title,
    // 原文摘要仍然带上：诊断是辅助，不该把现场证据吞掉。
    detail: `${rule.detail}${raw === '' ? '' : `｜原始报错：${raw.slice(0, 200)}`}`,
    node: rule.code === 'missing_node' ? node : node,
    fixes: rule.fixes.map((f) => ({ action: f.action, why: f.why, gain: String(f.gain ?? '') })),
    retryable: rule.retryable,
    raw: raw.slice(0, 600),
    matched: true,
  }
}

/** 一行摘要，给日志/结果列表用（不展开 fixes）。 */
export function briefDiagnosis(input) {
  const d = diagnoseError(input)
  const tail = d.node !== '' ? `（节点 ${d.node}）` : ''
  return `${d.title}${tail}。首要处理：${d.fixes[0]?.action ?? '看插件日志'}`.slice(0, 200)
}
