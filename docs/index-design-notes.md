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
