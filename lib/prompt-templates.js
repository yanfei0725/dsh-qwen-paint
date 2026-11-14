/**
 * lib/prompt-templates.js —— F28 提示词模板与扩写。
 *
 * 解决的问题：用户对着空白输入框不知道该写什么，最后只写「一只猫」，
 * 出来一张平庸的图，然后怪模型。模板把「专业 prompt 长什么样」直接摊开，
 * 填几个槽位就得到结构完整的描述。
 *
 * ★ 定位是**结构脚手架**，不是「替你写 prompt」：
 *   我们不做「把一句话扩写成 300 字」那种 LLM 扩写（那要么另调模型、要么是
 *   拼形容词堆砌，对出图质量是负收益）。这里只给结构、只填空，
 *   槽位内容仍然由用户决定 —— 这样出来的图才是他要的。
 *
 * 全部纯数据 + 纯函数，没有任何 IO，方便被回归测试逐槽位断言。
 */

/** Qwen-Image 对中文 prompt 支持很好，模板一律用中文，用户不用翻译。 */
export const TEMPLATE_CATEGORIES = ['商业', '角色', '排版', '场景', '环境']

/**
 * 内置模板。
 *
 * 每个模板的 `template` 里用 `{key}` 占位，`slots` 声明每个 key 的中文名与示例。
 * `required` 为 true 的槽位没填时不会硬编一个默认值糊弄 —— 而是如实报缺，
 * 因为「主体」这种槽位随便填一个反而会毁掉整张图。
 */
export const PROMPT_TEMPLATES = [
  {
    id: 'product',
    name: '产品图',
    category: '商业',
    description: '电商主图 / 详情页用的单品展示，强调材质与干净背景。',
    size: '1024x1024',
    negative: '文字, 水印, 多个主体, 杂乱背景, 过曝, 廉价感',
    template: '{subject}，{material}，{background}，{lighting}，{angle}，商业产品摄影，'
      + '微距细节清晰，边缘锐利，无文字无标识',
    slots: [
      { key: 'subject', label: '主体', required: true, example: '一只磨砂黑色保温杯' },
      { key: 'material', label: '材质', required: false, example: '哑光不锈钢与软木杯盖' },
      { key: 'background', label: '背景', required: false, prefix: '置于', example: '浅灰无缝背景' },
      { key: 'lighting', label: '光线', required: false, example: '柔光箱侧逆光带轻微轮廓光' },
      { key: 'angle', label: '视角', required: false, suffix: '视角', example: '45 度俯视' },
    ],
  },
  {
    id: 'character',
    name: '角色立绘',
    category: '角色',
    description: '游戏 / 小说角色全身或半身立绘，锁定五官、服装与姿态描述。',
    size: '832x1216',
    negative: '多余手指, 肢体扭曲, 脸部崩坏, 文字, 水印, 低分辨率',
    template: '{gender}，{age}，{hair}，{outfit}，{pose}，{expression}，'
      + '{style}，全身立绘，纯色背景，精细五官',
    slots: [
      { key: 'gender', label: '性别', required: true, suffix: '角色', example: '女性' },
      { key: 'age', label: '年龄段', required: false, example: '二十岁出头' },
      { key: 'hair', label: '发型发色', required: false, example: '及腰银白色长发，一侧编辫' },
      { key: 'outfit', label: '服装', required: false, example: '深蓝色立领长外套配皮质腰带' },
      { key: 'pose', label: '姿态', required: false, example: '侧身回望，右手按在剑柄上' },
      { key: 'expression', label: '表情', required: false, example: '冷静而略带警惕' },
      { key: 'style', label: '画风', required: false, suffix: '风格', example: '厚涂半写实' },
    ],
  },
  {
    id: 'cover',
    name: '封面图',
    category: '排版',
    description: '文章 / 视频 / 播客封面，明确留出标题区，避免主体压在文字位上。',
    size: '1280x720',
    negative: '文字, 水印, 主体居中遮挡, 杂乱细节',
    template: '{theme}主题封面，{mood}氛围，{palette}色调，主体位于{subject_side}，'
      + '{blank_side}大面积干净留白用于放置标题，{style}，简洁构图',
    slots: [
      { key: 'theme', label: '主题', required: true, example: '深海探索' },
      { key: 'mood', label: '情绪', required: false, example: '神秘而开阔' },
      { key: 'palette', label: '色调', required: false, example: '深蓝到青绿的冷色渐变' },
      { key: 'subject_side', label: '主体位置', required: false, example: '画面右侧三分之一' },
      { key: 'blank_side', label: '留白区', required: false, example: '画面左侧' },
      { key: 'style', label: '风格', required: false, example: '扁平插画' },
    ],
  },
  {
    id: 'scene',
    name: '场景概念图',
    category: '场景',
    description: '影视 / 游戏场景概念设计，强调空间层次与气氛。',
    size: '1344x768',
    negative: '文字, 水印, 人物过多, 透视错误, 低清晰度',
    template: '{place}，{timeofday}，{weather}，{foreground}作为前景，{midground}居中，'
      + '远处是{background}，{lighting}，{style}，电影级构图，景深层次分明',
    slots: [
      { key: 'place', label: '地点', required: true, example: '废弃的沿海灯塔站' },
      { key: 'timeofday', label: '时间', required: false, example: '黄昏将尽' },
      { key: 'weather', label: '天气', required: false, example: '海雾弥漫，细雨' },
      { key: 'foreground', label: '前景', required: false, example: '生锈的铁栏杆与湿滑礁石' },
      { key: 'midground', label: '中景', required: false, example: '斑驳的白色塔身' },
      { key: 'background', label: '远景', required: false, example: '压低的铅灰色云层与海平线' },
      { key: 'lighting', label: '光线', required: false, example: '塔顶旋转的暖黄光束穿透雾气' },
      { key: 'style', label: '风格', required: false, example: '写实概念设定' },
    ],
  },
  {
    id: 'still-life',
    name: '静物特写',
    category: '商业',
    description: '食物 / 器物特写，强调质感与诱人的细节。',
    size: '1024x1024',
    negative: '文字, 水印, 塑料感, 过饱和, 杂乱背景',
    template: '{subject}，{texture}，{garnish}点缀，{surface}，'
      + '{lighting}，浅景深，热气或水汽细节清晰，美食摄影',
    slots: [
      { key: 'subject', label: '主体', required: true, suffix: '特写', example: '一碗刚出锅的牛肉面' },
      { key: 'texture', label: '质感', required: false, suffix: '质感', example: '汤面油亮、面条弹韧' },
      { key: 'garnish', label: '点缀', required: false, example: '翠绿葱花与半颗溏心蛋' },
      { key: 'surface', label: '台面', required: false, suffix: '台面', example: '深色粗陶' },
      { key: 'lighting', label: '光线', required: false, example: '侧逆光勾出蒸汽轮廓' },
    ],
  },
  {
    id: 'interior',
    name: '室内空间',
    category: '环境',
    description: '家装 / 建筑室内效果，交代材质、采光与家具关系。',
    size: '1344x768',
    negative: '文字, 水印, 透视扭曲, 家具比例失调, 过暗',
    template: '{room}，{style}，{material}为主材，{furniture}，'
      + '{window}采光，{palette}配色，广角建筑摄影，竖平线校正',
    slots: [
      { key: 'room', label: '房间', required: true, example: '朝南的客厅' },
      { key: 'style', label: '风格', required: false, suffix: '风格', example: '日式极简' },
      { key: 'material', label: '主材', required: false, example: '浅色橡木与米色微水泥' },
      { key: 'furniture', label: '家具', required: false, example: '低矮布艺沙发与一张原木长几' },
      { key: 'window', label: '采光', required: false, example: '落地窗引入午后斜射自然光' },
      { key: 'palette', label: '配色', required: false, example: '米白、浅木与一点墨绿' },
    ],
  },
]

/** 极简清单，给工具列表与面板下拉用（不塞完整模板，省 token）。 */
export function listTemplates() {
  return PROMPT_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    size: t.size,
    slots: t.slots.map((s) => ({
      key: s.key,
      label: s.label,
      required: s.required === true,
      example: s.example,
      // prefix / suffix 一并透出：用户才知道填「45 度俯视」会被拼成「45 度俯视视角」，
      // 不用自己再加一遍单位词。
      ...(s.prefix ? { prefix: s.prefix } : {}),
      ...(s.suffix ? { suffix: s.suffix } : {}),
    })),
  }))
}

export function getTemplate(id) {
  const key = String(id ?? '').trim()
  return PROMPT_TEMPLATES.find((t) => t.id === key) ?? null
}

/**
 * 渲染模板。
 *
 * ★ 三个刻意的设计：
 *   ① **必填槽位缺失时返回 missing，不抛错、也不编一个默认值**。
 *      抛错会让调用方只能吞掉；编默认值会让用户拿到一张不是他要的图却不知道原因。
 *   ② 槽位值做长度裁剪与去换行 —— 用户可能把整段话粘进「材质」，
 *      不裁就会把模板结构撑爆。
 *   ③ 未填的可选槽位**整段连同前面的逗号一起去掉**，不留「，，」这种残渣。
 *
 * @returns {{ok:boolean, id:string, prompt:string, negative:string, size:string,
 *   missing:Array<{key:string,label:string}>, used:object}}
 */
export function renderTemplate(id, slots = {}) {
  const t = getTemplate(id)
  if (!t) return { ok: false, id: String(id ?? ''), reason: '没有这个模板', prompt: '', negative: '', size: '', missing: [], used: {} }
  const src = slots && typeof slots === 'object' ? slots : {}
  const used = {}
  const missing = []
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)

  for (const s of t.slots) {
    const v = clean(src[s.key])
    if (v !== '') used[s.key] = v
    else if (s.required === true) missing.push({ key: s.key, label: s.label })
  }

  // ★ 模型是：**正文里只写裸占位符 `{key}`**，prefix/suffix 是渲染时才拼上去的装饰。
  //   这样「填了 → 前缀+值+后缀」「没填 → 连分隔符一起摘空」两条路都只有一种写法，
  //   不会出现「正文自带后缀 + slot 又声明后缀 → 视角视角」这种重复。
  //   第一版把 `{angle}视角` 写在正文里、靠正则去摘，结果留下孤零零的「视角，」——
  //   根因就是正文和声明各存了一份同一个词。
  let prompt = t.template
  for (const s of t.slots) {
    const token = `{${s.key}}`
    const pre = String(s.prefix ?? '')
    const suf = String(s.suffix ?? '')
    const v = used[s.key]
    if (v !== undefined) {
      prompt = prompt.split(token).join(`${pre}${v}${suf}`)
      continue
    }
    // 未填：先把「，token」→「token，」→ 裸 token 依次摘掉，避免留下「，，」或句首逗号。
    for (const pat of [`，${token}`, `${token}，`, token]) {
      if (prompt.includes(pat)) { prompt = prompt.split(pat).join(''); break }
    }
  }
  prompt = prompt.replace(/[，,]{2,}/g, '，').replace(/^[，,]+/u, '').replace(/[，,]+$/u, '').trim()

  return {
    ok: missing.length === 0,
    id: t.id,
    name: t.name,
    prompt,
    negative: t.negative,
    size: t.size,
    missing,
    used,
  }
}
