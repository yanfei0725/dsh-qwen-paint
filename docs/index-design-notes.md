# lib/index.js 设计说明（外置归档）

> 2026-11-15：`lib/index.js` 贴着 DSH Store 单文件 **262,144 B** 上限（一度只余 105 B），
> 两段最长的块注释从源码搬到这里保存。**这里只归档原文，不是运行时文档**；
> 源码里保留一行索引，改工作流 / 节点前请回来读，别凭感觉改。
>
> 归档时未改动任何实现逻辑，也未删除任何信息。

---

## 一、文件头设计要点 ①–⑦（原 `lib/index.js:1-36`）

```
/**
 * dsh-qwen-paint —— 让 DeepSeek Harness 在对话里直接调用本机 ComfyUI，用千问
 * （Qwen-Image 2.1）模型画图。
 * ============================================================================
 * 设计要点（都是照官方内核实现与用户的既有环境核过的，别凭感觉改）：
 *
 * ① **零外部依赖**：不 import `@deepseek-ai/dsh-tools` 之类 dsh 自带的包。
 *    理由 —— `tools.register()` 只强校验 `output.schema` 必须是标准 JSON Schema
 *    （`assertSupportedJsonSchema`），而 `parameters` 的 spec→JSON Schema 转换是
 *    `defineTool()` 干的、`register()` 根本不校验。既然我们自己写成标准
 *    JSON Schema，就不需要 defineTool，也就没有"装进 profile 后解析不到包"的
 *    风险（插件解析失败会让 DSH 起不来，代价太大）。
 *    只用官方 present 工具也用过的关键字子集：type / properties / required /
 *    items / additionalProperties / description。
 *
 * ② **workflow 照抄 `<ComfyUI>\app.py` 的 build_workflow()** ——
 *    那是开发机上**已经在用、已验证**的那份千问文生图工作流，节点与连线
 *    一个字都不改，只把提示词/尺寸/步数/种子做成参数。
 *
 * ③ **纯本地**：只连 127.0.0.1 的 ComfyUI，不出网、不需要任何 API Key。
 *
 * ④ **落盘位置**：默认桌面「千问1生图」，遵循工作区约定。
 *
 * ⑤ **图片怎么显示在聊天框**：真正有效的只有两条 —— 正文 Markdown 图片
 *    （靠 systemPrompt 段落保证）与客户端自定义 toolview（lib/client.js）。
 *    ImageBlock / presentCall / presentationMeta / present 卡片**都不行**。
 *
 * ⑥ 空闲自动关停 ComfyUI：设计要点原文已搬到 lib/tool-registry.js 文件头保存
 *    （index.js 贴着 DSH Store 单文件上限，长注释外置以减压）。
 *
 * ⑦ **只读状态端点**（给客户端的状态指示器用）：
 *    `GET /api/qwen-paint/status.json`（另注册一个根路径同内容作回退）。
 *    只回 {online, busy, idleShutdownInMs, ...} 这类事实，**不含任何路径/密钥**；
 *    并且只放行本机请求。
 * ============================================================================
 */
```

---

## 二、局部重绘「零下载潜空间重绘」原理（原 `lib/index.js:2689-2719`）

```
/**
 * ★★★ 2026-10-12（用户要求「局部重绘」）+ ★★★ 2026-10-19 **改为零下载的潜空间重绘**。
 *
 * ## 2026-10-19 为什么不再用 ControlNet（用户拍板走零下载方案）
 *   · 旧实现要 `Qwen-Image-InstantX-ControlNet-Inpainting.safetensors`，而 InstantX 公开的
 *     Qwen ControlNet 是给 **1.0** 的（latent 16 通道），本机底模是 **2.1**（64 通道）⇒ 不兼容。
 *   · 2.1 唯一对得上的官方权重是 `alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union`
 *     （7.55 GB，单文件、8 种控制 + 修复），但它走的是 **MODEL_PATCH** 路径
 *     （`ModelPatchLoader` + `QwenImageDiffsynthControlnet`），不是 `ControlNetLoader`；
 *     且官方要求 Comfy-Org 原版底模，本机是 int8+convrot 量化版，叠加稳定性未验证。
 *   · ⇒ 改用 ComfyUI **自带的 inpaint 机制**，不需要任何额外权重。
 *
 * ## 零下载方案的原理（依据本机 ComfyUI 源码，不是猜的）
 *   `comfy/samplers.py:634-642`，采样每一步：
 *     `latent_mask = 1 - denoise_mask`
 *     `x   = x * denoise_mask + scale_latent_inpaint(原图 latent) * latent_mask`（步内）
 *     `out = out * denoise_mask + self.latent_image * latent_mask`（步末硬拉回）
 *   ⇒ **未蒙版区域每一步都被强制拉回原图 latent**，最终严格等于原图；蒙版区域正常采样。
 *   这个机制**不依赖模型是不是 inpaint 专用**，对 DiT / flow-matching 一样成立。
 *   ⇒ 蒙版区生成时，模型看到的是"周围原图 latent + 按 sigma 加的噪声"，
 *     上下文完整 —— 这就是"必须符合整体"的来源。
 *
 * ## 参数
 *   · **复用主模型本身**（UNET/CLIP/VAE 吃主链路的文件），不调 freeComfyModels，不额外占大模型。
 *   · `denoise` 默认 **0.7**：只影响蒙版区的重绘程度（保留区由 noise_mask 硬保护，
 *     denoise 再高也不会破坏）。要"彻底替换这块"就传 1.0，要"轻微改动"就传 0.4~0.6。
 *   · `grow`（默认 8px）先外扩蒙版，`feather`（默认 16px）再把边缘羽化 ——
 *     这对是为了**缓解接缝**：外扩避免羽化吃掉重绘区，羽化让噪声注入边缘渐变过渡。
 *     两者都给 0 即退回"硬边蒙版"。
 *   · 蒙版（mask）必填：白=要重绘、黑=保留。
 */
```

紧随其后的 `/** 0.18 通用任务工具：局部重绘 / 元素移除 / 四向扩图 … */`
仍留在 `lib/index.js`（描述的是 `makeTaskTool` 的 `InpaintCropImproved` 链，
与上一段 `SetLatentNoiseMask` 零下载重绘是**两条不同实现**，不要合并）。


---

<!-- 由 scripts 离线脚本自动外置；源码只留锚点，逐字内容见此。 -->

### index-note-001（原 lib/index.js L33-43）

```js
/**
 * ★★ 2026-10-08：「正在生成图片」的呼吸动图 —— 路径与准备。
 *
 * 为什么这么做（需求方给的正解，原话）：
 *   「你直接把这个动画当成一张图片发出来不就完美了吗」
 * 在此之前我三次尝试往消息树里插 DOM，最后一次把界面搞成整片空白 —— 那棵树由 React 管理，
 * 插自己的节点会被下一次渲染重排/清空（MEMO 里记过的红线：**只加属性、不改结构**）。
 * 改成动图后：位置就是正文图片的位置、随消息滚动、且完全不碰内核结构。
 *
 * 路径**动态算**（outputDir 已是按当前用户桌面推算的），复制到那儿供正文引用。
 */
```

### index-note-002（原 lib/index.js L67-93）

```js
/**
 * ★★★ 2026-10-09 **关键修复**：模块级声明依赖 —— 这是 DSH 的**官方模式**。
 *
 * ## 为什么必须这么写（踩了很久的坑）
 *   本插件原先在 `apply()` 里用 `root.inject(['tools'], (ctx) => { …整个初始化… })`，
 *   把**所有初始化都塞进那个回调**。实测日志反复出现：
 *     `[apply] 插件开始加载` → `[inject] 准备注册` → **然后什么都没有**
 *   即：`root.inject` 的回调**从未执行**（cordis 的 scoped inject 在依赖解析上
 *   不可靠 / 静默挂起），于是工具、状态端点、提示词全都注册不上，
 *   界面上就是「一直卡在正在启动中」。
 *
 * ## 官方模式长什么样（对照两个正常工作的一线插件）
 *   · `@liustack/modlens`：`export const inject = ['tools','agents','attachments','llm']`，
 *     然后 `apply(ctx, config)` 里**直接** `ctx.tools.register(...)`
 *   · `dsh-univer-office`：`inject = ['univer','tools']`，同样直接 `ctx.tools.register(...)`
 *
 *   ⇒ **`export const inject` 是"声明"**：DSH 会等这些服务就绪后**才调用 `apply`**，
 *     而 `apply` 的 `ctx` 上**直接就有** `tools`，**根本不需要再 inject 一次**。
 *
 * ## 改法
 *   ① 这里声明 `inject = ['tools']`；
 *   ② `apply` 里把原来的 `root.inject(['tools'], cb)` 改成**立即执行**（IIFE），
 *      `ctx` 就是 `apply` 的第一个参数本身。
 *
 *   ⚠ `webServer` 是**可选**服务，仍走 `ctx.inject(['webServer'], …)`
 *     （modlens 也是这么用的：**必需**服务靠 export 声明，**可选**服务靠 inject 等它出现）。
 */
```

### index-note-003（原 lib/index.js L365-368）

```js
      // ★ 2026-10-11：TTL 做成**可配置**（默认 2000ms，生产行为一字不变）。
      //   起因：TTL 原先是写死的 2000 —— 自测里连续断言"忙/闲"两种状态时，
      //   第二次调用必然命中缓存、测不出变化（自测只能靠 sleep 绕过，又慢又不稳）。
      //   现在 `cfg.queueCacheMs` 可覆盖：生产不配 = 沿用 2 秒；自测置 0 = 每次真查。
```

### index-note-004（原 lib/index.js L393-400）

```js
/**
 * ★★ 找出"确实是 ComfyUI"的进程。两道闸：
 *   ① 它必须正监听 ComfyUI 的端口；
 *   ② 它的命令行必须同时含 `comfy` 与 `main.py`（本机启动命令是
 *      `…\python_embeded\python.exe -s .\ComfyUI\main.py --windows-standalone-build`）。
 * 只要有一条不满足就返回 null —— **绝不动手**。宁可留着占显存，也不误杀别人的进程。
 * @returns {{pid:number, commandLine:string}|null}
 */
```

### index-note-005（原 lib/index.js L562-590）

```js
/**
 * ★★★ 2026-10-16（DSH STORE AUTH001 整改）**请求信任判定**。
 *
 * ## 原版为什么不够（审核原话）
 *   原来的 `isLocalRequest` *"只看 Host 和 socket 的本机地址；**缺失值也放行**，
 *   不检查 Origin、Sec-Fetch-Site 或宿主调用方身份"*。
 *   ⇒ **来自其它网页、但目标地址为本机的请求，Host 和 socket 仍然是本机** ——
 *     单纯"只允许本机连接"**并不证明发起请求的网页可信**（CORS 也挡不住有副作用的 GET）。
 *     这是典型的 confused-deputy 面。
 *
 * ## 实现：与官方 `api-request-trust.ts` 等价
 *   官方（`packages/client/connection/src/api-request-trust.ts`）的判定顺序，逐条照做：
 *   ① **Host 围栏**（防 DNS rebinding）：**每个请求都过**。Host 缺失 / 无法解析 /
 *      不是回环 ⇒ **拒绝**。理由：Host 是 rebinding **唯一无法伪造**的头 ——
 *      浏览器按"它以为在跟谁说话"填 Host，所以被 rebind 的页面会把攻击者域名带进来。
 *   ② **跨站围栏**：`Sec-Fetch-Site: cross-site` ⇒ **拒绝**（不论 Origin）。
 *   ③ **Origin 围栏**：带了 Origin 就必须与本机 Host **同源**；`Origin: null`
 *      （沙箱 iframe / file: 页面）是不透明源 ⇒ 拒绝；
 *      **没带 Origin 则放行** —— 此时 Host 围栏已经约束住了。官方原文：
 *      *"Absent Origin is fine — the Host fence above already bound the request."*
 *
 * ⚠ "没带 Origin 放行"**不是漏洞**：能过 Host 围栏说明请求方认为自己在跟本机说话；
 *   而能伪造 Host 的只有非浏览器客户端 —— 那已是本机进程，不在本模块的威胁模型内
 *   （威胁模型是**浏览器发起的跨站 / rebinding 请求**）。
 *
 * ⚠ 另外保留原来的 socket 检查（有值时必须是回环）作为**附加**一层。
 *   `remoteAddress` 缺失时**不**据此拒绝 —— 官方实现同样不检查该项，主要防线是 Host 围栏；
 *   把它变成硬性要求会误伤非 TCP 场景。
 */
```

### index-note-006（原 lib/index.js L669-683）

```js
/**
 * ★★★ 2026-10-17（AUTH001 收尾，审核指出"写入口最后边界"）：
 *   **写操作的前置守卫 —— 方法 + 媒体类型**。
 *
 * 审核原话：*"`lib/index.js:3869` 的状态 POST 尚未检查 `application/json`；
 * 4355 的 `repair` 没有限制方法/内容类型，任意方法的 JSON `confirm:true` 都会进入 `runRepair`。
 * 请让错误方法/媒体类型在**任何动作前**返回 405/415，并统一有界正文解析。"*
 *
 * 确实如此。本函数必须在**读 body 之前、碰 cfg 之前**调用：
 *   · 非 POST        → **405 Method Not Allowed**
 *   · 非 JSON 媒体类型 → **415 Unsupported Media Type**
 * 这样 `text/plain` 的"简单请求"（浏览器跨站表单能发、且不触发预检）根本进不到业务逻辑。
 *
 * @returns {boolean} true = 通过，可以继续；false = 已写响应，调用方应立即 return
 */
```

### index-note-007（原 lib/index.js L720-724）

```js
  // ★ 2026-11-09（issue #1）：不同目录下的**同名图片**会互相覆盖。
  //   ComfyUI 的 /upload/image 按文件名落盘，`overwrite=true` 就等于"后到的赢"，
  //   于是 a.png（角色 A）和 a.png（角色 B）最后都变成同一张 —— 而且是**静默**的。
  //   多参考图场景下这几乎必然发生（模型/用户常给 refs/1/ref.png、refs/2/ref.png）。
  //   所以按序号加前缀：序号在一轮内唯一 ⇒ 同名也不会撞，且保留原名便于在 ComfyUI 里认。
```

### index-note-008（原 lib/index.js L751-773）

```js
/** 提交任务，拿 prompt_id。 */
/**
 * ★★★ 2026-10-09 新增：**一次请求摸清后端"能不能马上接活"**。
 *
 * ## 为什么需要它（需求原文：「调用再聪明一点，不要那么傻」）
 *   原先进 execute 后是**串行**打三枪：
 *     ① `ensureComfyUp` → `/system_stats`（探活）
 *     ② `probeCapabilities` → 10 次 `object_info`（能力）
 *     ③ `submitPrompt` → `/prompt`
 *   其中 ② 有 10 分钟缓存、实际多半是命中的，但 ① 每次都要真发一次；
 *   更要命的是**它不知道后端忙不忙** —— 后端正在跑别人的任务时，它照样提交，
 *   于是任务排进队列，`waitForResult` 傻等，用户看到的是"卡住不动"。
 *
 * ## 这个函数做什么
 *   用 `/queue` 一次拿到三件事：
 *     · `online` —— 通了就说明后端活着（省掉一次 `/system_stats`）
 *     · `busy`   —— 有 running 就说明正在跑（据此决定"先等一下"而不是硬塞）
 *     · `pending`—— 排了多少（据此给用户一句**诚实**的预估，而不是假装马上出）
 *   失败不抛错：拿不到就当"未知"，走老路径（探测失败绝不能变成出图失败）。
 *
 * @returns {Promise<{online:boolean, busy:boolean, running:number, pending:number}>}
 */
// A 线推导结果只读一次（12 KB，随插件发布）。缺文件/坏 JSON 由 readSlotsCatalog 兜成空目录。
```

### index-note-009（原 lib/index.js L789-792）

```js
  // ★ 报告 v3 §14.3：B 线提交前管线（validateAgainstObjectInfo / changes[] / rollback()）。
  //   A 线把 assets/slots.json 的槽位声明喂进 SlotBindPass 上下文。
  //   ⚠ 默认零漂移：passes 没产生 changes 就**原样提交原 workflow** —— ComfyUI 端执行
  //     缓存键必须逐字节一致（报告 13.4 ②）；object_info 探测失败也一律不阻断提交。
```

### index-note-010（原 lib/index.js L832-846）

```js
/**
 * 轮询等结果。每 tick 回调一次进度，方便用户看到"在动"。
 *
 * ★★★ 2026-10-09 改造（用户：「调用再聪明一点，不要那么傻」）：
 *   原先这个循环只会说「排队/加载模型中…」「运行中… 已等 Ns」——
 *   用户根本分不清"在排队"和"在算"，更不知道还要多久，观感就是"卡死"。
 *   现在改成**看得懂的三段状态**：
 *     · 队列里还没轮到   → 报「排在队列第 N 位」
 *     · 正在跑但不吐进度 → 报「ComfyUI 正在执行（已 Ns）」
 *     · 有真实进度       → 直接报百分比 + 当前步数
 *   进度从 `/prompt` 的 websocket 太麻烦，改用 `/history` 里 ComfyUI 自己
 *   写回的时间戳/状态 —— 拿不到就退化成上面的粗粒度文案，**绝不编数字**。
 *
 * @returns 输出图片描述数组 [{filename, subfolder, type}]
 */
```

### index-note-011（原 lib/index.js L911-926）

```js
/**
 * 取图片字节。
 *
 * ★★ 0.1.2 修正（真事故，一眼看出来的）：
 *   **先走 ComfyUI 官方的 `/view`，本地目录只当兜底。**
 *
 * 原来顺序是反的（先读本地 `comfyOutputDir`），结果踩了个大坑：
 *   ComfyUI 的 output 目录**未必是配置里那个** —— 插件自己拉起 ComfyUI 时会带
 *   `--output-directory <别处>`，或者机器上跑的是另一个实例。而两个实例的
 *   SaveImage 编号**都从 00001 重新开始**，于是**旧目录里恰好躺着一个同名文件** ✗
 *   → `readFile` 成功 → **根本走不到兜底** → 把昨天的旧图当成这次的成果，
 *     还按新 prompt 命名、报新请求的尺寸。用户看到的就是"画得完全不对"。
 *
 *   `/view` 是**问 ComfyUI 要它自己那次产出的文件**，不存在这个问题 ✓
 *   （代价只是多一次本地回环 HTTP，几 MB 而已。）
 */
```

### index-note-012（原 lib/index.js L975-985）

```js
/**
 * ★★ 2026-10-09 新增：列出本机 ComfyUI 当前可用的模型文件。
 *
 * 直接问 ComfyUI 本人（`/object_info/<节点类型>` 子路径，只回该节点 schema，远比全量
 * 1.97MB 的 `/object_info` 轻），取各加载器输入项的 `OPTIONS`（下拉候选 = 磁盘上的模型文件名）。
 * 纯本地、不出网；用来正面回应"查看可用的模型"——宿主顶部的 LLM 模型下拉若卡住，
 * 这一条能直接把 ComfyUI 这边的模型清单拉出来看。
 *
 * ⚠ 子路径 `/object_info/<Type>` 在 ComfyUI 上是稳定的；若某个加载器节点不存在
 *   （如未装某自定义节点），对应项返回 null 而非报错，绝不拖垮整次查询。
 */
```

### index-note-013（原 lib/index.js L999-1005）

```js
    // ★★★ 2026-10-12 修 bug：DSH 的 `tools.register()` **强校验 `output`** ——
    //   必须同时有 `schema`(object) 与 `render`(function)，否则整条工具注册被拒：
    //     `tool "check_acceleration" must declare output { schema, render, presentationMeta? }`
    //   `makeDrawTool` 一直有；这两个**诊断类**工具漏了 ⇒ 重载后它们注册失败，
    //   面板里那句"可让助手调用 check_acceleration 查看"就成了空指引。
    //   用宽松 schema（`additionalProperties: true`）：这两个工具的返回结构是动态的，
    //   写死 properties 会在 DSH 校验返回值时把真实结果判为不合法。
```

### index-note-014（原 lib/index.js L1045-1070）

```js
/**
 * ★★★ 2026-10-09（通用化改造）：**从"写死优化链路"改为"探测后自适应"**。
 *
 * ## 为什么必须改
 * 优化链上的每一环都是**可选依赖**，别人机器上未必有：
 *   · `turbo8_lora_step2500.safetensors`（1.36 GB，要自己下）
 *   · `TE-Speed-QwenImage21` 自定义节点（闭源 `nodes.pyd`）
 *   · `ComfyUI-Qwen-Image-2.1-Speedup` 自定义节点
 *   · 官方前缀缓存节点 `QwenImage21Cache`（要足够新的 ComfyUI）
 * 而 ComfyUI 遇到"引用了不存在的节点类型"或"模型名不在候选列表里"是**整单拒收**
 * （`node type not found` / `value not in list`），**不会静默降级**。
 * 所以老版本一旦发出去，凡是不满足条件的人一画图就报错 —— 包等于是坏的。
 *
 * ## 现在怎么做
 * 出图前先**问 ComfyUI 本人**（`/object_info/<节点类型>`）：摸清"有哪些节点、
 * 磁盘上模型文件的真实名字叫什么"，再据此选一档**可用的最高链路**。
 * 探测结果按 ComfyUI 地址缓存（默认 10 分钟），不会每次出图都重查。
 *
 * ## 三档链路（自动取可用的最高档）
 *   `full`  turbo8 + 前缀缓存 + 跳步缓存 → 8 步 / CFG 1.0（最快；作者本机 8.2s）
 *   `turbo` turbo8（缺跳步缓存也可以）  → 8 步 / CFG 1.0
 *   `basic` 没有 turbo8 LoRA            → 25 步 / CFG 2.5（慢，但任何千问环境都能出图）
 *
 * ⚠ 探测**失败**（ComfyUI 连不上等）**不拦截出图**：一律当 `full` 处理，
 *   让 ComfyUI 自己抛原始错误 —— 比插件"猜"出一个含糊结论要诚实。
 */
```

### index-note-015（原 lib/index.js L1072-1082）

```js
/**
 * 模型文件名的**模糊匹配表**（按优先级打分，从高到低）。
 *
 * 为什么必须模糊匹配：作者本机用的是 int8 量化版（`..._int8_convrot` / `..._w4a8`），
 * 但别人下的可能是 bf16 版、fp8 版，文件名并不相同。**写死文件名 = 换台机器就拒收**。
 * 这里按关键字从"磁盘上真实存在的"列表里挑一个最合适的；一个都匹配不上则返回 null，
 * 交给上层降级处理。
 *
 * ⚠ 正则都**不带 `g` 标志** —— 带 g 的 `test()` 有 `lastIndex` 状态，会漏匹配。
 */
/* ★ 2026-10-19：getNodeSchema / nodeFileList 已下移到 lib/config.js。 */
```

### index-note-016（原 lib/index.js L1133-1146）

```js
/**
 * 建工具定义。注意这里**不用 defineTool**：register 要的就是这么个对象。
 * @param ctx - 已注入 tools 的上下文
 * @param cfg - 合并后的配置
 * @param log - 记日志
 * @param onProduced - 出图成功后回调（用来 append 交付事件 + 记活动时间）
 */
/* ==========================================================================
 * 视频链（Wan 2.2 / Hummingbird-XT-5B DMD）
 *
 * 拓扑与参数来自本机**已跑通**的图（见 lib/video-workflow.js 头注）。
 * 这里只做三件事：提交 → 等结果 → 落盘并登记交付，全部复用既有链路
 * （submitPrompt / fetchWithTimeout / uniquePath / onProduced）。
 * ========================================================================== */
```

### index-note-017（原 lib/index.js L1148-1155）

```js
/** 从 ComfyUI 的 /view 取任意产物字节（视频/动图都走它，图片另有 fetchImageBytes）。 */
/**
 * 在飞任务表：prompt_id → { startedAt, key }。
 * 供 `GET /api/comfy-pipeline/progress` 回答"我排第几、已等多久"。
 * ⚠ 它只是**进度提示**用的，任何异常都不能影响出图（读写全吃错）。
 */
/** ★ 2026-11-13：图形化引导 / 蒙版精修 / 卸载内存 / 外部集成的共享运行态。
 *  放模块级而非 apply 闭包内：端点处理器与任务收尾读到的是同一份真相。 */
```

### index-note-018（原 lib/index.js L1305-1308）

```js
  // ★ 角色参考图（模型无关适配用）：与生图侧同一套 /upload/image 上传 + 核对逻辑。
  //   既有的 startImage 首帧路径一行不动；这里只服务显式启用 referenceStrategy 的情形。
  //   ⚠ 必须先判策略再上传：视频侧的 reference/references 只被本功能消费，不启用时
  //     无条件上传会白跑 N 次 /upload/image，还可能因路径不存在直接把一次纯文生视频搞挂。
```

### index-note-019（原 lib/index.js L1682-1685）

```js
      // 落到 tool/result 的 data.meta，供客户端自己的 draw_image 卡片取图片路径。
      // （注意：客户端只对 read_image 读 meta 当标签，我们自己读是为了自绘卡片。）
      // ★ 2026-10-19（用户要求「多张都给我看」）：把**全部**文件路径也带上。
      //   以前只带 path（第一张），所以一次出 4 张时界面上只看得见 1 张。
```

### index-note-020（原 lib/index.js L1696-1703）

```js
    /**
     * ★★★ 2026-10-09：**最后一道防线**。
     *
     * 在真正的 `execute` 外面套一层 try/catch，把"任何形态的错误"都规范化成 `Error`。
     * 为什么非要有这一层：宿主把 `execute` 的 reject 值直接 `String()` 了 ——
     * 只要有一处漏网地抛了个普通对象，用户看到的就是 `Error: [object Object]`
     * （真事故，已实测复现）。这一层保证**无论哪里漏出来**，用户看到的都是人话。
     */
```

### index-note-021（原 lib/index.js L1706-1716）

```js
        // ★★★ 2026-10-09 **真事故修复**：必须把这四个**闭包变量**显式传进去！
        //
        //   现场：用户点「画一张」报 `cfg is not defined`。
        //   根因：我为了给 [object Object] 加一层规范化，把原来的 execute 函数体
        //         原样搬成了外层的 `runDraw` —— 但函数体里引用的 `cfg` / `log` /
        //         `onProduced` / `onStart` **本来就是 `makeDrawTool` 的闭包变量**，
        //         搬出去之后**全丢了作用域**。`runDraw` 体里 `cfg` 被引用 17 次、
        //         `log` 10 次，一执行必炸。
        //   ⚠ 这正是"重构时最容易漏"的一类错：`node --check` 只查语法，
        //     自由变量在语法上是合法的，**只有真跑一遍才会暴露**。
        //     ⇒ 所以下面 `_draw_symbol_test.mjs` 专门做"符号解析"静态检查兜底。
```

### index-note-022（原 lib/index.js L1772-1797）

```js
/**
 * ★★★ 2026-10-13（任务 #62①「记忆消费」）：把「工具入参 + 记忆偏好 + 运行时默认」
 * 折算成实际生效的画参。
 *
 * ## 为什么提成纯函数
 *   这是本轮**最容易出错的一环** —— 铁律是"绝不拿记忆覆盖用户显式意图"。
 *   抽成纯函数就能对它单独回归（真喂 `args` / `cfg` / `pref` 断言优先级），
 *   不必为验一条优先级把整个 ComfyUI HTTP 后端都搭起来。
 *
 * ## 优先级（从高到低）
 *   显式入参 > 记忆偏好 > 运行时 `cfg.preset` > 插件默认（1:1 / 1.0MP / 1 张）。
 *   ⚠ 对 `negative` 缺省：记忆有才用，没有就如实给 undefined（不编一个默认负向词）。
 *
 * ## ⚠ seed 故意不在返回值里
 *   它由调用方按"显式就取、否则随机"决定。记忆里的 seed 会让每次出图都一模一样 ——
 *   那不是用户想要的行为，所以**不从记忆读**。
 *
 * @returns {{preset: string|null, aspect: string, megapixels: number,
 *            steps: number|undefined, count: number, negative: string|undefined,
 *            memFilled: string[]}}  `memFilled` = 本次由**记忆**补上的项（给日志如实说明用）。
 */
/**
 * 面板选中的角色参考策略（'' = 未启用）。显式工具入参 referenceStrategy 优先于它；
 * 只存在进程内存里，重启 DSH 后回到默认（面板 mount 时会 GET 回来显示，不会显示错的值）。
 * ⚠ 这是**用户主动在面板上拨过**的选择，不是记忆推断 —— 不从记忆读、也不写进配置。
 */
```

### index-note-023（原 lib/index.js L1818-1835）

```js
/**
 * 提交前把「角色参考」适配应用到工作流（模型无关）。
 *
 * ## 为什么放在 host 层而不是塞进 buildWorkflow / buildVideoWorkflow
 *   适配层只认工作流里的 class_type 与槽位名，与「这张图是谁造的」无关 ——
 *   这正是「适配所有模型」的含义：任何工作流对象（本插件造的、别处来的）都能变换。
 *   两个构造函数一行不动，也就不会动到既有的工作流契约回归。
 *
 * ## 零漂移
 *   只有调用方显式指定 referenceStrategy 且真有参考图时才调用本函数（见 runDraw /
 *   runVideo 的 wantReferenceAdapt 判定）。adaptReference 在计划未落地时原样返回
 *   传入对象引用；只有真注入了节点才返回新对象，此时重建不可枚举元信息。
 *
 * ## 能力协商的数据源
 *   真实 /object_info（loadObjectInfo 有 10 分钟 TTL 缓存，submitPrompt 已抓过一次，
 *   这里多半直接命中，不额外发请求）。探测失败返回 null ⇒ 协商退到通用兜底，
 *   而通用兜底不依赖任何节点探测，对任意后端依然成立。
 */
```

### index-note-024（原 lib/index.js L1947-1950）

```js
      // ★★★ 2026-10-13（任务 #62①：记忆消费）：读 dsh-auto-memory 写进来的「偏好」
      //   （.qwen-paint-preferences.json），用它给**用户本次没显式传**的画参做兜底。
      //   ⚠ 铁律：显式参数 > 记忆 > 运行时 cfg.preset > 默认。**绝不**拿记忆覆盖用户当场的意图。
      //   ⚠ 读取失败按 {} 处理（内部已吞错），绝不影响出图。
```

### index-note-025（原 lib/index.js L1952-1955）

```js
      // ★★ 2026-11-10（控制层落地层）：面板控制项作为**兜底层**插进来，优先级
      //   显式 args > 面板控制项 > 记忆偏好 > cfg.preset > 内置默认。
      //   做法是把它压进既有的 `pref` 通道（resolveDrawParams 的判据一行没改）——
      //   面板是用户自己拨的，盖住记忆是对的；模型当场显式传的 args 仍然赢。
```

### index-note-026（原 lib/index.js L1982-1993）

```js
      // ★★★ 2026-10-09 新增：**提交前先看一眼队列**，别把任务硬塞进一个正忙的后端。
      //   老行为是闭着眼 submit —— 后端在跑别人的活儿时，这次任务就排在后面，
      //   而 waitForResult 只会说"排队/加载模型中"，用户观感是"卡住了"。
      //   现在：能提前告知就提前告知（一句 honest 的话，胜过三十秒的沉默）。
      //   ⚠ 只"告知"，**不取消、不拒单** —— 用户要的是图，不是被教育。
      // ★★★ 2026-10-10（提速 M6）：这三步**互不依赖**，原先却串行 await ——
      //   · probeReadiness   看队列忙不忙（1 次 /queue）
      //   · uploadReference  传参考图（仅图生图）
      //   · probeCapabilities 探测后端能力（结果按地址缓存 10 分钟）
      //   三者都是对**已就绪** ComfyUI 的独立请求 ⇒ 并发发出，省下两段往返。
      //   ⚠ 必须在 ensureComfyUp 之后（后端得先在线，否则上传/探测都会失败）。
      //   ⚠ 用 Promise.all：任一真失败就整体失败（与原先串行的语义一致）。
```

### index-note-027（原 lib/index.js L2050-2056）

```js
      // ★★★ 2026-10-12（用户要求 + 审计文档）：**OOM 自动回退**。
      //   出图撞 OOM（"out of memory" / "OutOfMemoryError" / CUDA / hip / MPS 之一）时，
      //   自动强制 `vaeTiling='on'` 重跑一次（ComfyUI 自带 VAEDecodeTiled，零新增依赖）。
      //   再 OOM 则把两次错误如实抛出（**绝不静默吞**）。
      //   判据必须**宽**到覆盖各家后端（NVIDIA / AMD ROCm / Apple MPS），但**窄**到不误伤
      //   普通错误（"prompt too long" 等）—— 用单词边界 + 几个特定后端前缀。
      // ★ buildWf：三件事都靠它 —— ① OOM 重跑换 cfg；② 串行换 seed；③ 每次的张数
```

### index-note-028（原 lib/index.js L2088-2091）

```js
      // ★★★ 2026-10-09 **以"生效尺寸"为准**（修「出的图尺寸不对」那个误报）。
      //   锁尺寸档（forceOptimizedSize=true）下，buildWorkflow 会把 864x1152 这类
      //   请求**改写成 1024x1024**。之后的"尺寸校验 / 文件名 / 返回值"必须都用
      //   **实际生效的那个**，否则就是在拿请求值跟实际值对账 —— 必然对不上。
```

### index-note-029（原 lib/index.js L2095-2100）

```js
      // 旧 turbo8 链没有多图编码器：只用第一张，必须明说，不能让用户以为三张都进了。
      // ★ 2026-11-09（issue #1）：两条链路都支持多图了 ——
      //   官方 Turbo：1-3 张走 EditPlus、4-16 张走 2.1 原生编码器；
      //   旧链路：TextEncodeQwenImage21 的 images.image_1..16。
      //   所以不再有"只使用第 1 张"这种降级，真出问题会由张数闸门直接报错。
      // ★ 2026-10-10 修 bug：改成 `let` —— 图生图的真实输出尺寸要**用实测值覆盖**（见下）。
```

### index-note-030（原 lib/index.js L2119-2122）

```js
        // ★★ 两层缓存之①：**本地任务去重**。命中就**根本不提交** —— 省的是整段排队+采样；
        //   指纹 = 提交体剔掉 client_id/filename_prefix（保留 seed），只用于"本地做过没有"。
        //   ⚠ ComfyUI 那一层不在这里：提交体一个字都不改（见 lib/prompt-cache.js 头注）。
        //   ⚠ 随机 seed 自然不会命中（指纹含 seed），所以不会出现"我要重画它给我旧图"。
```

### index-note-031（原 lib/index.js L2166-2169）

```js
          // ⚠⚠ 2026-10-13 修 bug（我自己上一轮引入的）：这里**不能**写死 1。
          //   非串行批量时 perIterCount = count（比如 4），写死 1 会让"OOM 重跑"
          //   只出 1 张 —— 用户要 4 张却静默只拿到 1 张，属于**静默少出图**。
          //   串行时 perIterCount 本来就是 1，所以两种模式用同一个值都正确。
```

### index-note-032（原 lib/index.js L2204-2220）

```js
          // ★★ 尺寸校验（2026-10-08 真事故的防线）：
          //   ComfyUI 的 output 目录被 `--output-directory` 改过，而两个实例的
          //   SaveImage 编号**都从 00001 开始** → 旧目录里恰好躺着同名的旧文件
          //   → 老代码先读本地、读到了 → 把**昨天的图**当成这次的成果，
          //     还按新 prompt 命名、报新请求的尺寸。一眼看出"画得完全不对"。
          //   ✓ 现在：取图先走 /view（顺序已反转），这里再加一道 —— 尺寸不符**当场报错**，
          //     绝不静默产出错图。机器"知道"的事，就该拦住。
          //   ⚠ 只对**文生图**校验：图生图的输出尺寸由 resolution=sqrt(W*H) 决定，
          //     和请求的 width/height 本来就不是一回事，校验会误报。
          //   ★★★ 2026-10-09 修正：比对基准从"请求尺寸"改成**"生效尺寸"(outWidth/outHeight)**。
          //     锁尺寸档会把 864x1152 归一到 1024x1024，拿请求值比对必然误报
          //     （实测就是这样把一张正常图拦下来报"尺寸不对"的）。
          //   ★★★ 2026-10-10 修 bug（图生图尺寸）：图生图的输出尺寸由
          //     `resolution = round(sqrt(effWidth*effHeight))` **直接决定**（≈正方形），
          //     与请求的 width/height **本来就不是一回事**。原代码只跳过校验、却仍拿请求值
          //     当"实际尺寸"写进文件名与返回值 —— 属于数据错误（比如请求 864x1152、实际 ~998²）。
          //     ⇒ 这里用**实测 PNG 尺寸**覆盖 outWidth/outHeight，文件名与返回值都跟着变对。
```

### index-note-033（原 lib/index.js L2262-2273）

```js
      // ★★★ 2026-10-13（用户反馈）：**生成后自动放大**（一键出大图 / 2K）。
      //
      //   ## 为什么需要
      //   8 GB 卡想出 2K，唯一现实路径 = 先在 1024² 生成，再**分块放大**。
      //   放大工具 `upscale_image` 本来就有，但用户要手动跑两步 —— 这里串起来。
      //
      //   ## ⚠ 两条硬规矩
      //   ① 两段时间**分开记**：`seconds` 仍是"生图耗时"（与 0.16 语义一致，不擅自改），
      //      放大耗时单独放 `upscaleSeconds`。
      //   ② 放大**失败不影响**已经生成的那张图 —— 原图**已落盘**，只 warn 不抛错。
      //      （放大依赖 VOSR2/RealESRGAN，机器上未必装了；不能让"可选的后处理"
      //       把已经成功的主流程拖成失败。）
```

### index-note-034（原 lib/index.js L2365-2374）

```js
/**
 * ★★★ 2026-10-12（用户明确要求）：**分阶段卸载主模型**。
 *
 * 放大引擎（VOSR2 ~7GB）与主千问模型（~13–20GB）同时占显存会直接 OOM。
 * 所以跑辅助任务前，先向 ComfyUI 发 `/free`（unload_models + free_memory）
 * 把主模型从显存卸下；放大/重绘结束后再由下次出图自动重新加载。
 * 这是"小模型别和主模型同时加载"这条硬约束的服务端实现。
 * 局部重绘复用主模型本身、**不**调它（见 makeEditTool 注释）。
 * 失败只返回 false，绝不拖垮调用方。
 */
```

### index-note-035（原 lib/index.js L2390-2406）

```js
/**
 * ★★★ 2026-10-12（用户要求）：**dsh-auto-memory 联动**。
 *
 * 本插件不依赖 dsh-auto-memory 存在 —— 但**主动**把每次成功出图写一条 JSONL，
 * 任何外部"记忆"插件（dsh-auto-memory、第三方知识库…）都可以通过
 *   GET /api/qwen-paint/memory/recent?limit=10
 * 拉走，按 ts / prompt / seed 做去重 / 召回。
 *
 * 同时提供一个"偏好"通道：GET/POST `/api/qwen-paint/memory/preference`，
 * 让 dsh-auto-memory 把"用户常用的预设/负向词/尺寸"等塞进来，
 * 下次 runDraw 时可以读到（★ 2026-10-13 已**自动消费**：仅当本次调用没显式传该参时
 * 才用记忆补默认，优先级「显式参数 > 记忆」；并会在日志里如实说明补了哪些。
 * ⚠ seed **不**从记忆读 —— 默认每次随机才对，要复现必须自己传 seed）。
 *
 * 文件位置：`<outputDir>/.qwen-paint-memory.jsonl` 与 `.qwen-paint-preferences.json`。
 * 全部失败都吞掉，**绝不影响出图**。
 */
```

### index-note-036（原 lib/index.js L2416-2425）

```js
/**
 * ★ 2026-10-20（0.17.13）：面板「圈选局部重绘」的一次性蒙版路径。
 *
 * 为什么单独一个函数：它同时承载两个修复点 ——
 *   ① **随机后缀**：只靠 `Date.now()` 的话，同一毫秒并发的两次圈选会拿到同一个
 *      文件名，后写的把先写的覆盖（表现为"蒙版不是我涂的那张"）；
 *   ② **位置固定在 outputDir**：与成品同目录，路由 `/api/qwen-paint/file` 的
 *      路径包含检查认的就是这个基准。
 * ⚠ 用完即删（见 inpaintHandler 的 finally），不会在用户目录里留垃圾。
 */
```

### index-note-037（原 lib/index.js L2526-2545）

```js
/**
 * ★★★ 2026-10-12（用户要求「分块放大」）：把已有图片超分。
 *
 * · 默认引擎 **VOSR2**（一步 1.4B，已随插件装好，本地 `models/vosr2/VOSR2`）。
 * · 也可选 **RealESRGAN**（需自己在 `models/upscale_models` 放 .pth）。
 * · 跑之前先 `freeComfyModels` 把主千问卸下（避免双占显存）。
 * · 引擎/权重缺失 → 返回**明确的可照做指引**，绝不自动下载大模型。
 * ⚠ 只处理"放大"这一件事，不动主模型链路；纯本地、不出网。
 */
/**
 * ★★★ 2026-10-13（用户反馈）：把**放大逻辑**抽成可复用函数。
 *
 * 两条调用路径共用它：
 *   ① `upscale_image` 工具（用户手动放大）
 *   ② 「生成后自动放大」（`upscaleAfter`，一键出 2K）
 *
 * ⚠ 为什么必须抽出来而不是抄第二份：两份节点图会分叉 ——
 *   出现"工具能放大、串联却报节点缺失"这种最难查的 bug。
 *   共用一条路径，串联能用 == 工具能用。
 */
```

### index-note-038（原 lib/index.js L2734-2747）

```js
/**
 * ★★★ 2026-10-12（用户要求「确认式一键修复」）：只做**可逆 / 无害**的修复动作。
 *
 * ## 为什么"确认式"
 *   第一阶段（confirm≠true）只返回**将要做什么的清单**，不动任何东西；
 *   第二阶段（confirm=true）才真正执行。避免"一键"把环境改坏。
 *
 * ## 为什么只列这几项
 *   都是**可逆 / 无害**的：卸载显存（随时可重载）、补输出目录（创建空目录）、清探测缓存
 *   （下次出图重新探测）。**绝不**自动下载驱动/模型、绝不删文件、绝不改配置 ——
 *   那类"重活"仍由人决定（与本项目"不擅自下大模型"的一贯原则一致）。
 *
 * @returns 预览阶段返回 { needsConfirm:true, plan }；执行阶段返回 { done, summary }
 */
```

### index-note-039（原 lib/index.js L2849-2871）

```js
/**
 * ★★★ 2026-10-09 **安全探测宿主可选服务**（血泪教训换来的工具函数）。
 *
 * ## 为什么不能用 `typeof ctx?.xxx` 探测
 *   cordis 的 `ctx` 是 **Proxy**（见 `cordis/lib/index.js` 的 `ReflectService.handler.get`）。
 *   访问一个"**没有写在 `inject` 里、当前也未就绪**"的服务属性时，它**直接 throw**：
 *     `Error: cannot get property "<name>" without inject`
 *   ⇒ 所以 `typeof ctx?.webServer` 不是"安全的存在性检查"，它等于**真去读那个属性**。
 *
 * ## 实际踩到的后果（用 DSH 自带 cordis 真实复现）
 *   `diag('host', … webServer=${typeof ctx?.webServer} …)` 这一行本身抛错
 *   → `apply` 抛错 → fiber 进入 `FAILED`
 *   → 插件管理器显示「**异常**」、工具注册数 = 0、状态端点根本没注册
 *   → 界面表现：**一直卡在"正在启动中"**。
 *
 * ## 正确姿势
 *   · 探测服务是否存在：`ctx.get?.(name)` —— 不存在时返回 `undefined`，**不抛错**
 *     （`ctx.get` 本身是混入在 ctx 上的方法，属于安全属性）。
 *   · 非要读属性：包在 try 里（就是本函数）。
 *
 * @param read 一个惰性读取器；抛错则视为"该服务不可用"
 * @returns 读到的值的 `typeof` 字符串，读不到返回 `'absent'`
 */
```

### index-note-040（原 lib/index.js L2935-2938）

```js
  // ★ 2026-11-16：主模型界面选择恢复（面板「主模型」下拉写 POST status.json {mainmodel}
  //   时镜像落盘 uiState.unet）。**显式配置优先** —— cordis.patch.yml 写了 mainModelOverride
  //   就以它为准。恢复进 cfg.mainModelOverride（不直接改 cfg.unet）：探测清单里没有该文件时
  //   resolvePlan 的 overrideState 会如实判「不采纳」并回落，不会拿已删掉的文件名去交工作流。
```

### index-note-041（原 lib/index.js L2967-2970）

```js
  // ★★★ 2026-10-12（用户要求：允许自选输出目录）**启动时就校验并定死** outputDir。
  //   原来直接拿去用 —— 配错（盘符不存在 / 没写权限 / 路径指到文件）要到**出图那一刻**
  //   才失败，报的还是"写文件失败"这种看不出原因的错。现在启动时校验、明确告知、安全退回。
  //   校验后的绝对路径写回 cfg.outputDir，后面所有用它的地方（落盘、读回、面板显示）就都一致了。
```

### index-note-042（原 lib/index.js L2982-2997）

```js
  // ★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）**启动时强制校验 comfyUrl**。
  //
  //   审核机器人指出的核心问题：README 声明"网络仅限 127.0.0.1、不访问外部地址"，
  //   但 apply() 直接把 rawConfig 合并进 cfg，comfyUrl 是个普通可配置项，
  //   代码里**没有任何一处**校验它到底是不是本机 —— 声明与实现不符。
  //
  //   现在：默认只允许回环地址（127.0.0.1 / localhost / ::1 / 0.0.0.0）；
  //   配成局域网/公网地址会**直接拒绝启动**并说明怎么改（fail-fast，
  //   不让配错的地址带着半边功能跑起来、到出图那一刻才莫名失败）。
  //   确实要连远程 ComfyUI 的用户可显式设置 `allowRemoteComfy: true` ——
  //   这是"如实披露可配置的外部端点"，而不是靠改文档掩盖。
  //
  // ★★★ 2026-10-16（第二轮复核整改）：这里扩成**两个独立外部端点**都校验。
  //   审核机器人指出：`hipfireUrl` 是**独立于 comfyUrl 的第二个外部端点**，
  //   上一轮只收口了 comfyUrl，hipfire 那条链路（probeHipfireHttp / generateViaHttp）
  //   仍在直接用可配置地址、不受 allowRemoteComfy 控制。
```

### index-note-043（原 lib/index.js L3005-3017）

```js
    // ② 抛错即拒绝启动。这里刻意**不 try/catch 吞掉** —— 静默回退到 127.0.0.1
    //    会让用户以为"配的远端生效了"，实际连的是本机，属于更坏的行为。
    // ★★★ 2026-10-17 修 bug（真机实测发现；**0.17.2 起一直存在**，影响是阻断级的）：
    //   `assertLocalUrl(...).toString()` 会把 `http://127.0.0.1:8188` 规范化成
    //   **带尾斜杠**的 `http://127.0.0.1:8188/`（`new URL()` 把空路径补成 `/`）。
    //   而全代码有 **15 处** `${cfg.comfyUrl}/xxx` 拼接 ⇒ 实际请求变成 `//xxx`。
    //   实测：`GET http://127.0.0.1:8188/system_stats` → **200**，
    //         `GET http://127.0.0.1:8188//system_stats` → **404**（ComfyUI 的 aiohttp 不做合并）。
    //   后果：探活永远失败（界面一直停在"未就绪"）、提交 /prompt、取图 /view 也全 404 ——
    //   等于**整个 ComfyUI 后端不可用**，而界面上只表现为"启动超时 / 没反应"。
    //   ⇒ 这里统一去掉尾斜杠，让 cfg.comfyUrl 保持"可直接拼路径"的形态。
    //   注意只去掉**末尾的** `/`：用户若配了带路径前缀的地址（如 `http://127.0.0.1:8188/comfy`），
    //   `toString()` 本就不会补斜杠，这段替换对它无影响。
```

### index-note-044（原 lib/index.js L3045-3062）

```js
  // ★ 2026-10-09 取证：确认 apply 真的走到了"注册 inject"这一步。
  //   有了本行 + 回调里的 [host]，就能一刀切开两种完全不同的故障：
  //     · 只有本行、**没有** [host] → 依赖服务（tools / sessionProjections）未就绪，
  //       回调被 cordis 挂起（不报错、不执行）—— 工具和状态端点都不会注册；
  //     · **连本行都没有** → apply 在更早的地方就中断了。
  //   实测踩到过：某次重启后日志只有 [apply] 一行，靠这两行才能立刻分辨是哪一种。
  // ★★★ 2026-10-09 **关键修正**：依赖从 `['tools','sessionProjections']` 收窄为 `['tools']`。
  //
  //   为什么必须改：实测日志反复出现「有 [inject]、**没有 [host]**」——
  //   即 `root.inject` 被调用了、但**回调从未执行**。cordis 的 inject 在依赖未满足时
  //   是**静默挂起**（不报错、不执行），于是工具、状态端点、提示词全都注册不上，
  //   界面上就是"一直卡在正在启动中"。
  //
  //   `sessionProjections` 在本插件里**只用于一个 try/catch 内的可选查询**
  //   （取 turn boundary，取不到就跳过）—— 它根本不配当"必需依赖"。
  //   把它列为必需，等于赌"这个服务一定在插件加载前就绪"；赌输一次，整个插件哑火。
  //   ⇒ 现在改成**可选获取**（见下面 onProduced 里的 `sp`），并把它记录进 [host] 快照。
  /** 初始化回调是否真的执行了 —— 供下面的兜底定时器判断（见 8 秒回看）。 */
```

### index-note-045（原 lib/index.js L3074-3078）

```js
  // ★★★ 2026-10-09：改成**立即执行**（原先是 `root.inject(['tools'], cb)` —— 那个回调
  //   在本机 DSH 上**从不执行**，日志里就是"[inject] 准备注册"之后再无下文。
  //   见文件上方 `export const inject = ['tools']` 的详细说明。）
  //   `ctx` 就是 apply 的第一个参数：DSH 已按 `inject = ['tools']` 等 tools 就绪后才调 apply，
  //   所以这里**直接注册即可**，不需要再 inject 一次。
```

### index-note-046（原 lib/index.js L3081-3096）

```js
    // ★★★ 2026-10-09 **宿主能力快照**（终结猜测用）。
    //   为什么值得单独记一行：本插件历史上被"宿主到底提供了什么"坑过多次 ——
    //   实测踩到 `ctx.on is not a function`（裸调用抛错 → 掐死后续所有初始化
    //   → 状态端点注册不上 → 界面"一直卡在启动中"）。
    //   这一行把宿主给的全部关键 API 一次性列出来，下次出问题**不用再猜**。
    //   ★★★ 2026-10-09 **灾难级修正**：这一行原来写的是
    //       `webServer=${typeof ctx?.webServer}`
    //     —— 结果它自己成了故障源。**cordis 的 ctx 是 Proxy，
    //     访问一个"没写在 inject 里、当前也没就绪"的服务属性会【直接抛错】**：
    //       Error: cannot get property "webServer" without inject
    //       at lib/index.js (ctx.tools.register 之前)
    //     实测（用 DSH 自带 cordis 真实复现）：
    //       fiber.state = 3 (FAILED)  ← 插件管理器显示「异常」就是它
    //       工具注册数 = 0、状态端点根本没注册 → 界面卡在"正在启动中"
    //     教训：**`typeof ctx?.xxx` 不是"安全的探测"，在 Proxy 上它等于"读取"**。
    //     探测可选服务只能走 `ctx.get?.(name)`（下面这种），或包在 try 里。
```

### index-note-047（原 lib/index.js L3130-3135）

```js
        // ★ 2026-10-09：`sessionProjections` 改成**可选获取** —— 它已不是 inject 的必需依赖，
        //   所以这里必须自己兜底（宿主没这个服务时静默跳过"登记 turn"即可，不影响出图）。
        //   ⚠⚠ **顺序很重要**：ctx 是 Proxy，`ctx.sessionProjections` 在未 inject 时**会抛错**。
        //     如果写成 `ctx?.sessionProjections ?? ctx?.get?.(...)`，
        //     左侧一抛错就**直接跳进 catch**，右侧那条**永远没机会执行** ——
        //     等于这个服务永远取不到。所以必须**先走安全的 `ctx.get`**。
```

### index-note-048（原 lib/index.js L3170-3187）

```js
    // ★★★ 2026-10-09 **步骤级保护 + 取证**（这次「卡在启动中」的真正修法）。
    //
    //   ## 为什么必须这么改（实测证据）
    //   诊断日志里永远只有 `[apply]` 和 `[tools]` 两行，**之后再无任何记录** ——
    //   包括我上一轮新加的 `[route] 准备注册` 也没出现。而 `[tools]`(原 3693) 与
    //   route 注册(原 3847) 同在**同一个 inject 回调**内、中间没有提前 return，
    //   这说明：**回调执行到中途抛了未捕获的异常，整个回调被中断**，
    //   后面的「状态端点注册」压根没跑到 —— 前端于是永远拿不到状态，卡在"启动中"。
    //
    //   ## 之前的问题
    //   这段初始化里有若干**裸调用宿主 API**的地方（`ctx.tools.register` / `ctx.on` …），
    //   任何一处因宿主版本差异或服务缺失而抛错，都会**连带掐死后面所有初始化**
    //   （包括状态端点）。而项目自己的约定写得很清楚（见下方空闲关停处注释）：
    //   「宿主若缺 XX，也不许把插件加载拖垮」—— 这里以前漏了。
    //
    //   ## 现在
    //   每一步都**单独 try/catch**，失败只 warn + 落盘 diag，**绝不再阻断后续步骤**；
    //   并且每步都写一行 `[init]` 诊断 —— 下次一眼就能看出卡在哪一步。
```

### index-note-049（原 lib/index.js L3289-3293）

```js
    // ★★★ 2026-10-09：**自动加速环境配置**。
    //   检测到本机缺哪个厂商专用加速包 → 自动运行下载脚本装上。
    //   包内只带下载器、不预置已下载的文件，所以这里是真的去网上取。
    //   延迟 20 秒 + unref：避开插件加载与首次出图的路径，绝不拖慢任何正常操作；
    //   整个过程失败也只写日志，出图功能完全不受影响。
```

### index-note-050（原 lib/index.js L3302-3306）

```js
    // 让"出图后必须在正文里内联展示"成为插件的固有行为，而不是靠模型自觉。
    // 走的是官方那条路（与内核自带的 FILE_REFERENCE_PROMPT 同一机制）：
    // 正文里的 Markdown 图片 → 客户端 fileMediaUrl() 重写成 /api/file?path=… → 真 <img>。
    // ⚠ 不要改用 ImageBlock / presentCall / presentationMeta —— 客户端对非 read_image
    //   工具返回的 image block 只会 JSON.stringify 成文本，present 卡片里也根本没有 <img>。
```

### index-note-051（原 lib/index.js L3310-3314）

```js
        // ★★★ 2026-10-08 十五次修正 —— **删掉"出图前先发动图"这条指令**。
        //   早就明确过「不用图片了」（改成 DOM 动画块），但我一直没把这条摘掉，
        //   结果出图时**动图和动画块同时出现**，看起来就像"重复发了一遍动画"。
        //   ✓ 现在动画只由客户端的 DOM 块承担 —— 那才是"位置正确、随消息滚动"的正解。
        //     本地副本与图片路由保留，仅作备用，**不再进正文**。
```

### index-note-052（原 lib/index.js L3347-3356）

```js
    // ★★★ 2026-10-08 十七次修正 —— **DSH 启动时预热后端**。
    //
    //   用户反馈「怎么我重启就关闭了」：ComfyUI 是 DSH 的子进程，
    //   DSH 重启时整棵进程树被终止（Windows 默认行为），它被连带带走。
    //   而原来只在"出图时"才拉起 —— 于是每次重启后第一次出图都要冷启动等 30 多秒。
    //
    //   ✓ 修法：插件加载后**立刻在后台探一次**，不在线就异步拉起。
    //     这样重启 DSH 之后不用等出图，后端已经在跑了。
    //     ⚠ 完全异步：不 await、不阻塞插件加载，更不阻塞 DSH 启动；
    //       失败只 warn（出图时还有一次自动启动兜底，不会因为预热失败而画不了图）。
```

### index-note-053（原 lib/index.js L3365-3372）

```js
            // ★★★ 2026-10-08 修「自动关闭失效」（用户实测）：
            //   原来空闲计时**只在出图成功之后**才开启（lastActivityAt 初始为 null），
            //   而 tick() 的第一道判断就是 `if (state.lastActivityAt === null) return false`
            //   —— 于是"重启 DSH 之后一次图都没画"的场景里，**它永远不关**，
            //   用户在菜单里选「1 分钟后关闭」也没用（状态显示为"在线"，不是"空闲 N 分"）。
            //   ✓ 现在：预热这一趟只要**确认后端在线**（原本就在线、或刚被拉起来），
            //     就把计时起点定在此刻。之后 N 分钟没有新活动，照样会关。
            //     （出图开始时 / 出图成功后依然会 touch 续期，原有语义不变。）
```

### index-note-054（原 lib/index.js L3391-3394）

```js
    // 官方 present 就是这么干的：工具**成功**之后才 append 交付事件。
    // ★ 2026-10-09：**必须用 step 包住**。`ctx.on` 属于宿主 API，裁剪版/老版本宿主上
    //   可能不存在；裸调用一旦抛 TypeError，就会**掐死同一个回调里后面所有初始化**
    //   （包括状态端点注册）—— 这正是「界面卡在启动中」的中断点。
```

### index-note-055（原 lib/index.js L3432-3435）

```js
      // ★ 2026-10-10（提速 M5）：抽成函数，并在宿主**没有 ctx.effect** 时用裸定时器兜底。
      //   原先直接 `ctx.effect(cb)`：若该宿主不执行 effect 回调（本机历史上 inject 回调
      //   就出现过"注册了但从不执行"），空闲关停会**整个不启动**，只在 catch 里留一句 warn
      //   —— 功能等于没有，却很难被发现。现在：effect 不可用就自己起定时器。
```

### index-note-056（原 lib/index.js L3470-3475）

```js
    // ★ 2026-10-09 补：登记"我开始尝试了"。若之后日志里**没有**下面那条
    //   「webServer 已就绪」，就说明 inject 回调从未执行 —— 即当前 profile
    //   根本没有 webServer 服务（官方插件 modlens 的注释明确写了：
    //   webServer 只在 web profile 下存在，不存在时闭包永不运行）。
    //   ⚠ 这里**绝不能**写 `ctx?.webServer ? '有' : '无'` —— ctx 是 Proxy，
    //     读未 inject 的 webServer 会直接抛错（详见 safePeek 的注释）。
```

### index-note-057（原 lib/index.js L3481-3484）

```js
      // ★ 命中计数：用来**从外部**判断客户端的状态指示器到底加载了没有 ——
      //   它每 5 秒轮询一次、且优先打 /api/ 那条路径；api 计数一直涨就说明
      //   客户端半边确实加载并在运行（哪怕界面上暂时没看见）。
      //   我自己用 PowerShell 探测走的是不带 /api/ 的根路径，两者互不混淆。
```

### index-note-058（原 lib/index.js L3486-3492）

```js
      // ★★★ 2026-10-09：原来这里有个 `comfyStartRequestedAt` 时间戳，用来表达
      //   "最近点过启动、所以算启动中"。**已整个删除** ——
      //   它和 `launch.phase` 是**两套并行状态**，互相覆盖，谁也说不清最终值，
      //   这正是用户反复看到"一直卡在启动中"的根源。
      //   现在 `starting` 只有一个来源：`launch.phase`（见文件上方的重写说明）。
      // ★ 2026-11-08（P1 重构）：状态端点 handler 抽到模块级 makeStatusHandler，
      //   apply 只负责注入 5 个局部；handler 体与拆分前逐字一致。
```

### index-note-059（原 lib/index.js L3512-3518）

```js
            // ★★★ 2026-10-17（AUTH001 收尾）：**任何动作之前**先过方法与媒体类型守卫。
            //
            //   审核原话：*"4355 的 `repair` 没有限制方法/内容类型，任意方法的 JSON
            //   `confirm:true` 都会进入 `runRepair`"* —— 确实如此：
            //   原先这里既不查 method 也不查 Content-Type，正文还是**无上限**内联读的。
            //   现在：非 POST → **405**；非 `application/json` → **415**；
            //   正文统一走**有界**的 `readJsonBody`（与状态端点、memory/preference 同一套）。
```

### index-note-060（原 lib/index.js L3545-3548）

```js
          // ★★★ 2026-10-12（用户要求）：**更丰富的 API** —— 在状态/向导/修复之外，
          //   再开 5 个端点：health / capabilities / presets / memory.recent / memory.preference。
          //   全部只走本机回环（`isLocalRequest`），不对外暴露。
          // ★ /api/qwen-paint/health —— 极简存活探针（CI / 监控 / dsh-auto-memory 健康检查）
```

### index-note-061（原 lib/index.js L3621-3624）

```js
          // ★ /api/comfy-pipeline/controls —— 控制项（GET 读 / POST 写）
          //   面板拨的滑块落到 `<outputDir>/.comfy-pipeline-controls.json`；出图时由 runDraw
          //   读回，作为**低于显式入参、高于记忆偏好**的兜底层（优先级见 pipeline-controls.js 头注）。
          //   ⚠ 校验只有一处：`sanitizeControls()`。外来的未知键一律丢弃，绝不透传进 cfg。
```

### index-note-062（原 lib/index.js L3869-3883）

```js
          // ★★★ 2026-10-19（用户要求）：**面板里圈选局部重绘**。
          //   面板（client.js）在独立弹窗里画好蒙版，把 base64 PNG POST 到这里；
          //   这里存成文件、交给**同一个** editTool 执行 —— 校验/ControlNet/报错全部复用。
          //
          //   ⚠ 安全边界与其它写端点完全一致：
          //     · ★ 2026-11-11（AUTH002 收录复核整改）：**顶层可信请求围栏** ——
          //       `isLocalRequest(req)`（Host 回环 / socket.remoteAddress / Sec-Fetch-Site /
          //       Origin 同源四层判定），与 status / controls / file 等所有其它端点同一套。
          //       本端点会直接触发 editToolRef.execute()（本地 ComfyUI 出图 + 写盘），
          //       缺了它就成了 confused deputy：任意跨站页面可绕过宿主工具入口调用。
          //     · 只收 POST（GET 直接 405）；
          //     · 过 guardWriteRequest（**只**查 POST 方法 + application/json 媒体类型，
          //       不检查来源/授权，不能替代上面那道围栏）；
          //     · body 有界解析（readJsonBody 自带上限）；
          //     · 蒙版只接受 `data:image/png;base64,` 且限 24 MB —— 防止拿它当"任意文件写入"。
```

### index-note-063（原 lib/index.js L3934-3938）

```js
                // ★★★ 2026-10-20（0.17.13 修 bug）：**删掉这一次性蒙版**。
                //   改版前它写完就留在 outputDir 里 —— 每圈一次重绘堆一个 PNG，
                //   日子久了用户的出图目录里躺一排隐形垃圾（还是 dotfile，更难发现）。
                //   ComfyUI 那边用的是 uploadReference 复制过去的副本，删本地这份不影响重绘。
                //   删除失败（没写成功 / 已被删）无所谓，吞掉即可。
```

### index-note-064（原 lib/index.js L4038-4041）

```js
          // ★ 2026-11-13「CPU 指令集识别 + 加速档」：两条端点，处理器外置。
          //   GET  读取画像 + 五档各自在这台机器上**真正**会挂的参数（含自动降级）；
          //   POST 选档 → 写 uiState（与 flowStyle 同一套持久化），重启 ComfyUI 后生效。
          //   ⚠ 这里不做任何"替用户重启"的动作：重启会打断正在跑的任务。
```

### index-note-065（原 lib/index.js L4066-4069）

```js
          // ★★★ 2026-10-20（0.17.13）：插件自己的**媒体字节路由** `/api/qwen-paint/file`。
          //   ⚠ 2026-11-12：处理器已外置到 lib/file-route.js —— lib/index.js 贴着
          //   DSH Store 的 256 KB 单文件上限，这段自包含代码搬出去零风险。
          //   行为一字未改（路径包含检查 / 大小上限 / MIME 白名单 / nosniff 全在那边）。
```

### index-note-066（原 lib/index.js L4097-4105）

```js
      // ★★★ 2026-10-09 补：**延时回看** —— 状态端点到底注册上没有，只靠看代码永远说不清。
      //
      //   为什么必须有这一行：`ctx.inject(['webServer'], cb)` 在依赖不满足时是**静默挂起**，
      //   既不报错也不回调。于是"插件加载了、工具也注册了、但状态端点从未注册"
      //   这种状态在外界完全看不出来 —— 排查时只能猜。
      //   6 秒后回看 `routeMounted`，就能把结论直接写进诊断文件：
      //     · 已注册 → 界面状态应该正常，若还异常那是前端/请求问题；
      //     · 未注册 → 当前 profile 没有 webServer（插件装错 profile），
      //       界面状态必然拿不到，**但不影响出图**。
```

### index-note-067（原 lib/index.js L4299-4305）

```js
/**
 * ★ 2026-11-08（P1 重构）：状态端点 handler，从 apply() 的巨型函数里抽出。
 * 仅注入 apply 的 5 个局部（cfg/log/status/idle/visits）；其余依赖都是模块级
 * 符号（respondJson / diag / probeCapabilities / launch* / path / fsp / os 等），
 * 在本模块作用域直接可见。handler 体与拆分前逐字一致 —— 行为不变，源码级
 * 断言（对 lib/index.js 全文做 includes / 局部正则）仍照常命中。
 */
```

### index-note-068（原 lib/index.js L4336-4345）

```js
          // ★★★ 2026-10-16（DSH STORE AUTH001 整改）：**GET 只读、写参数一律走 POST JSON**。
          //
          //   审核原话：*"同文件 3715-3777 的状态 GET 处理器修改运行配置，部分选项还写 UI 状态。
          //   …让状态 GET 保持只读，写配置移到显式 POST JSON。"*
          //   确实如此 —— 之前所有开关/档位/目录/启动都是**GET 带 query** 就能改配置，
          //   而"有副作用的 GET"正是 CSRF 的经典载体（CORS 挡不住它）。
          //
          //   现在：`queryLc` 这张表**只从 POST 的 JSON body 填充**；
          //   GET 时它是空的 ⇒ 下面所有写分支自然全部失效（**无需逐个改**）。
          //   GET 若携带任何非只读参数，直接 405 并提示改用 POST —— 明确拒绝，不静默忽略。
```

### index-note-069（原 lib/index.js L4380-4383）

```js
              // ★★★ 2026-10-08 修「自动关闭失效」：**选完档位就从此刻开始计时**。
              //   原来这里只改数字、不碰计时起点，于是"重启后从没出过图（起点为 null）"
              //   时，用户选了「1 分钟后关闭」也不会关 —— 他实测报的就是这个。
              //   选 0（不自动关闭）时不留起点，保持"不关"的语义干净。
```

### index-note-070（原 lib/index.js L4406-4416）

```js
          // ★★★ 2026-10-09 新增：`?drawTrigger=xxx` —— 界面上切换「生图判断」档位。
          //
          //   需求原文：「不是你这个档位写是写进去的，但是你倒是给人家在界面上一个选择的按键呀」。
          //   确实——四档策略只存在于配置文件和提示词里，用户在界面上根本够不着。
          //
          //   ⚠ 生效时机：档位最终是**写进 systemPrompt 段落**的（模型靠它判断要不要画），
          //     而 systemPrompt 是在插件**加载时**注册的静态文本。所以：
          //       · 配置**立刻落盘**（重启也记得住）；
          //       · 但提示词要**重载插件 / 重启 DSH** 才会换成新档位。
          //     这一点必须让用户知道，否则他会以为"选了没用"——所以界面上那组标题
          //     直接写明了"重载后生效"，而不是藏着不说。
```

### index-note-071（原 lib/index.js L4442-4446）

```js
          // ★★★ 2026-10-19（用户要求）：抽卡「挑图」的两个开关 —— **都由用户自己决定是否启用**。
          //   与 flowStyle / drawTrigger 同一套：白名单校验 → 立刻落盘 → 重启也记得住。
          //   ⚠ 与 drawTrigger 不同的是：这两个开关**不需要重载插件** ——
          //     aiPickBest 影响的是"工具描述"，而描述是在 apply() 时按 cfg 拼的……
          //     所以严格说也要重载才换。为免误解，界面上写清"重载后生效"。
```

### index-note-072（原 lib/index.js L4462-4469）

```js
          // ★★★ 2026-10-09 诊断落盘：把每次状态轮询看到的**真实值**写进文件。
          //
          //   为什么需要它：用户反复反馈"界面卡在启动中"，但我在外面查什么都正常
          //   （8188 通、进程在、代理无影响）。**猜是猜不出结论的** ——
          //   必须让插件把"它自己看到了什么"写下来，才能定位。
          //   写的是最关键的几个量：探活结果、launchState、以及探测用的 URL。
          //
          //   ⚠ 只保留最近 200 行，避免长跑把磁盘写满。
```

### index-note-073（原 lib/index.js L4485-4492）

```js
          // ★★★ 2026-10-09 新增：`?start=1` —— 界面上的「启动 ComfyUI」按钮。
          //
          //   为什么需要它：菜单里早就能设"多久后自动关闭"，却**没有"现在打开"** ——
          //   用户想立刻用，只能等到下次出图才触发拉起，或者自己跑去手动开。
          //
          //   ⚠ 刻意**不 await**：真正拉起要几十秒（首次加载模型 20GB 更久），
          //     让状态接口立刻返回，前端好马上显示"启动中…"；
          //     下一次轮询（5 秒后）自然就能看到进展。await 会把轮询拖死。
```

### index-note-074（原 lib/index.js L4508-4522）

```js
          // ★★★ 2026-10-09 新增：`?blockcache=on|off` —— 界面上的「BlockCache T8」开关。
          //
          //   需求方要求原话：「BlockCache T8 块缓存只显示怎么调，但没提供开关，
          //   TE-Speed / Speedup / BlockCache 三者只能二选一却不让人自己切换。
          //   请把 BlockCache T8 也改成可以让用户自行开启或关闭的选项。」
          //
          //   实现方式（**运行时覆盖**，不是改配置文件）：
          //     · `cfg.blockCacheEnabled` 在插件启动时就从 cordis.patch.yml 读进来了，
          //       改它**当场生效**（下次出图就走新链路），不需要重启 ComfyUI；
          //     · 但它是**内存态** —— DSH 重载后会被配置文件里的值盖回去。
          //       这点必须在界面上**如实告诉用户**，并给出"怎么永久保存"的指引，
          //       否则就成了"我调了、重启又变回去"的假开关（正是最需避免的那种）。
          //   ⚠ 为什么不去改 yml 文件：插件拿不到自己配置文件的**可靠路径**
          //     （DSH 的 profile 路径因安装方式而异），盲写文件风险远大于收益。
          //     让用户改一行配置，比插件猜路径写坏配置安全得多。
```

### index-note-075（原 lib/index.js L4538-4546）

```js
          // ★★★ 2026-10-12（用户要求）：`?fast4=on|off` —— 界面上的「极速档（4 步）」开关。
          //   与 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //
          //   ⚠ 护栏：**探测不到 4 步 LoRA 时，在服务端就拒绝打开** ——
          //     面板虽然会把开关置灰，但端点自己也必须有护栏：否则一个手拼的 URL
          //     就能把链路切成 4 步，而机器上根本没有那个权重 ⇒ 每次出图都被
          //     ComfyUI 以 `value not in list` 拒收。这与 SageAttention 那条同一条原则。
          //   ⚠ 这里再调一次 probeCapabilities 是**便宜**的：它有 10 分钟缓存，
          //     而且只在真的带了 fast4 参数时才走到（普通轮询不受影响）。
```

### index-note-076（原 lib/index.js L4587-4599）

```js
          // ★★★ 2026-10-11 新增：**A 卡专属优化（可选）的两个开关** ——
          //   `?amdkernel=on|off` / `?asyncoffload=on|off`。
          //   与上面的 blockcache 同一套机制（改内存里的 cfg、不写配置文件）。
          //   ⚠ 但这两个是**启动参数** ⇒ 要等**下次启动 ComfyUI** 才真正起作用 ——
          //     面板的 hint 里已经写明，用户不会以为是"点了没反应"。
          // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码**的开关。
          //   ⚠ 它是**三态枚举**（`auto` / `on` / `off`），**不是布尔** —— 不能走下面那条
          //     `cfg[key] = want` 的通用分支（那会把它写成 `true`/`false`，判据直接废掉）。
          //   语义（面板开关只有两态，所以在这里映射）：
          //     开 → 回到**推荐档** `auto`（只在"显存 < 16 GB 且出图 > 1024²"时分块）；
          //     关 → `off`。
          //   ⚠ 想"所有尺寸都强制分块"请**显式写配置** `vaeTiling: 'on'` —— 面板不提供这一档，
          //     因为它不是常用选择，而误开会让小图也走分块（多花时间、无收益）。
```

### index-note-077（原 lib/index.js L4623-4627）

```js
            // ★★★ 2026-10-13 补（**真 bug**：面板有开关、端点不认 = 假开关）：
            //   describeOptimization 里已经给了 `key:'sada'` / `key:'oom'` 两个可点开关，
            //   但端点这份**白名单**里没有它们 ⇒ 点了之后 URL 参数被静默忽略，
            //   界面刷新又弹回原值 —— 典型的"面板说一套、实际跑另一套"。
            //   ⇒ 面板每加一个开关，端点白名单**必须同步加一行**。
```

### index-note-078（原 lib/index.js L4658-4661）

```js
          // ★★★ 2026-10-14（C1/C2/C5「专业卡版」）：**枚举型档位**参数。
          //   ⚠ 为什么单独一段：开关是 on/off 二值，而档位是**多选一** ——
          //     塞进上面的布尔循环会被静默忽略（"面板有下拉、端点不认"= 假控件）。
          //   ⚠ 服务端**必须校验取值**（白名单），否则手拼 URL 就能把 cfg 写成任意值。
```

### index-note-079（原 lib/index.js L4681-4684）

```js
          // ★★★ 2026-10-14（C3「专业卡版」）：**权重可调**（主模型 / LoRA / ControlNet）。
          //   ⚠ 校验是**动态白名单** —— 值必须出现在 ComfyUI **实时探测到的**模型清单里。
          //     否则一个手拼的 URL 就能把任意路径塞进工作流（这是**安全**问题，不只是体验）。
          //   ⚠ 空串是合法值 = 清除覆写（回到插件自动挑）。
```

### index-note-080（原 lib/index.js L4730-4736）

```js
          // ★★★ 2026-10-09 **重写后的状态机**（旧的 launchState + comfyStartRequestedAt
          //   两套并行状态已删除 —— 它们互相覆盖，正是"永远卡在启动中"的根源）。
          //
          //   现在只有三条规则（见文件上方 launch 的注释）：
          //     ① 单一真相源：starting 只看 launch.phase
          //     ② 在线就是在线：探到通立刻清空一切过期状态
          //     ③ 必然收口：LAUNCH_TIMEOUT_MS 到点必判超时，不会无限 starting
```

### index-note-081（原 lib/index.js L4750-4759）

```js
              // ★★★ 2026-10-17（AUTH001 收尾）：**状态 GET 不得改配置**。
              //
              //   审核原话：*"4242 的状态 GET 故障分支仍调用 `recoverFromSageCrash`，
              //   642-644 会把 `cfg.nvidiaSageAttention` 改为 false。请把配置恢复放到
              //   **后台生命周期或显式写操作**，GET 只展示状态。"*
              //
              //   确实如此 —— 这和刚改掉的"GET 写配置"是同一性质：**有副作用的 GET**。
              //   自动回退本身**保留**，仍在后台启动流程里（`launchComfy` 的失败分支），
              //   那条路径不依赖任何 HTTP 请求、本来就会生效。
              //   这里只**标记原因 + 记日志**供前端展示与用户决策，**绝不改 cfg**。
```

### index-note-082（原 lib/index.js L4785-4788）

```js
          // ★★★ 2026-10-09：把「优化到底有没有生效、没生效为什么」一并给前端。
          //   以前这些只写在日志里，用户在界面上完全看不到。
          //   ⚠ 这里**只在在线时**才去探测（否则会白等一次超时，拖慢每 5 秒一次的轮询）。
          // ★★ 2026-11-10：视频加速档结论交给优化面板（不再只写日志）
```

### index-note-083（原 lib/index.js L4821-4824）

```js
          // ★★★ 2026-10-12 修正：首次使用向导（含模型名/路径的就绪清单）**不再**随状态体下发。
          //   原因：状态体是每 5 秒轮询、会被日志/宿主带走的契约，硬底线是"不含本地路径/模型名"；
          //   而向导本就需要告诉用户"哪个模型缺了"，两者冲突。
          //   ⇒ 改为独立端点 `/api/qwen-paint/wizard`，由前端"首次使用向导"按钮按需拉取。
```

### index-note-084（原 lib/index.js L4854-4860）

```js
          // ★★★ 2026-10-09 **关键修复**：这里以前只回 `ok:false`，
          //   **没有 online / starting 字段** —— 而前端 `startingNow` 只在
          //   `typeof data.starting === 'boolean'` 时才更新（见 client.js）。
          //   于是 handler 一旦抛错，前端就**永远收不到状态**，
          //   `startingNow` 卡在 true，界面永久停在「正在启动…」。
          //   ⇒ 现在：① 如实落盘原因（以前完全静默）；② **必须带上状态字段**，
          //      让前端能把"启动中"收掉（宁可显示"未就绪"，也不能假装在启动）。
```


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### index-note-085（原 lib/index.js L1401-1404）

```js
          // ★ 2026-11-13 B3：与独立的 generate_speech 共用同一条 TTS 段，不再有两份实现。
          // ★ 2026-11-16 报障修复：读界面三段选择里的 TTS 后端 / 音色，真正传给
          //   runSpeechStage（backend / voiceSample）。旧代码一个都不传 ⇒ UI 选了不生效，
          //   是假控件。配置缺失时回落默认（'' = Qwen3-TTS / 默认音色），行为不变。
```


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### index-note-086（原 lib/index.js L2033-2037）

```js
      // ★ 2026-11-13：写生成历史（SQLite）。与上面的 JSONL 并列，互不替代：
      //   JSONL 是 dsh-auto-memory 的既有通道，SQLite 是可搜索/分页/血缘的正式历史层。
      // ★ 2026-11-17（M1/M2）：把**实际接线**的 LoRA / 主模型 / CFG 值落进 extra ——
      //   支撑按 LoRA 检索与参数包导出。数据取自构建出的工作流本体：
      //   记录的是真的进了图的东西，不是面板的"当前选择"（并发下两者可能不一致）。
```

### index-note-087（原 lib/index.js L3003-3007）

```js
          // M4：ControlNet 预处理（Canny / Depth / OpenPose）+ 产物缓存。
          //   纯逻辑（候选节点表 / 构图 / 缓存键 / 账本）在 lib/cnet-preprocess.js，
          //   这里的处理器只做 IO 串接：上传 → 提交 → 等待 → 下载产物 → 落缓存。
          //   缺节点时如实 409 + 安装提示，绝不假装能跑（契约 0.39.0 只有 Canny）。
          //   ⚠ 本文件 fs 是具名导入（无默认 fs 对象）：这里传 {readFileSync,...} 面给缓存账本。
```
