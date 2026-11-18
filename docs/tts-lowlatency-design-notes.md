# tts-lowlatency 设计注记

> 对应 `lib/tts-lowlatency.js`（2026-11-17 本地批次，未发布）。设计注释外置以守 2 MB 体积红线。

## 为什么是"抄思路"而不是"内置项目"

- **AnifLive-TTS**：真实仓库 `Hiruynk/AnifLive-TTS`，原创代码 **PolyForm Noncommercial 1.0.0（明确禁止商用）**，商用需作者书面授权。本插件是 BSL 1.1、面向用户生产使用 ⇒ 复制其代码会造成许可证冲突。只实现"语义分块降首音延迟"这类公开工程思路，**不复制任何代码/二进制**。
- **GSV.CPP**：真实仓库 `KakaruHayate/GSV.CPP`（截图里写作 Kakaraya/Gsv.cpp），**MIT**，有 HTTP API（gsv_server 9880 `/tts`，text sidecar 9882）。但 Windows 一键包 **3.16 GB**、g2pw 前端数据 **608 MB**，远超插件 2 MB 红线 ⇒ 只做外部服务适配器 + 引导，不下载、不捆绑。
- 截图里的 74.6 ms / 2-3× 均为**作者在特定硬件上的历史宣称**，本插件未复测、不写进结论。

## 各函数的通用原理（非任何项目专有）

- `planLowLatencyTts`：按句末标点切段，过长按长度兜底；首块再缩短到 `firstChars` —— "分块流式降低首音延迟"是公开工程常识，不涉及任何项目具体算法参数。
- `serviceBase`：**只接受 127.0.0.1 / localhost / ::1 回环**，防止把用户引到外部 URL（符合插件"数据仅走回环"的硬约束）。
- `buildSynthRequest`：兼容两种公开 API 形态 —— GSV 的 `/tts` 平铺参数、OpenAI 兼容的 `/v1/audio/speech` 嵌套参数。两者接口格式是各自 README 公开的调用契约，按契约构造请求不算复制实现。
- `probeExternalTts`：探活失败返回结构化降级，不抛异常、不假装服务在线。
- 缓存**复用** `lib/bgm-opt.js::readPlanCache/writePlanCache`，不重复造轮子（体积考量）。

## 接线边界

- 新模块是纯编排工具，不启动进程、不下载、不联网（除注入的 fetch 探活）。
- 生产消费点：`generate_speech` 的 `backend` 参数新增外部服务选项 + `/api/qwen-paint/tts/services` 端点 + lab 语音后端分区的探测按钮。
- 服务不在线时明确降级并给安装/授权引导，绝不静默回退到 Qwen3-TTS（与 `pickTtsBackend` 的既有纪律一致）。


### tts-lowlatency-space-comfy-catalog（原 lib/comfy-catalog.js 首块注释，逐字）

```js
/**
 * lib/comfy-catalog.js —— 报告 v3 §14，把 A/B 两线与 TTS 探测接到 host 的公共层。
 *
 * 三件事共用一份「ComfyUI 自报的家底」：
 *   ① `loadObjectInfo` 抓一次全量 `/object_info`（带 TTL 缓存、失败返回 null 不阻断）；
 *   ② B 线 `finalizeWorkflow` 拿它做**提交前校验**（`runAstPipeline` 的
 *      `validateAgainstObjectInfo` / `changes[]` / `rollback()` 在这里真正被 host 调用）；
 *   ③ A 线 `slotsForWorkflow` 把 `assets/slots.json`（derive-slots.py 产出）翻译成
 *      `SlotBindPass` 要的 `{ nodeId: { input: valueKey } }`；TTS 探测 `catalogForTts`
 *      把节点名/模型名整理成 `probeTts` 的形状。
 *
 * ## 硬规矩（开发笔记反复踩过的坑）
 * - **默认零漂移**：`finalizeWorkflow` 在 passes 没产生 changes 时**原样返回原 workflow**，
 *   不拿 emitWorkflow 的输出去提交 —— ComfyUI 端执行缓存键必须逐字节一致。
 * - **校验失败不阻断**：object_info 稀疏/节点改名/自定义节点缺 spec 时，
 *   ComfyUI 自己会判；插件只 warn + 回滚原样提交，绝不把"没测出来"变成"出图失败"。
 * - 全零外部依赖：`fetchFn` / `readFn` 由调用方注入，离线可测、不碰 net-guard 边界。
 */
```


### tts-lowlatency-space-cpu-endpoints（原 lib/cpu-endpoints.js 首块注释，逐字）

```js
/**
 * lib/cpu-endpoints.js —— CPU 加速档的本机 HTTP 端点（2026-11-13 新增）。
 *
 * 为什么要单独一个文件：`lib/index.js` 只剩约 4.7 KB 就到 DSH Store 单文件上限
 * （262,144 B），再往里面塞端点实现，下次加功能就得先拆文件。所以这里自成一体，
 * index.js 只留 `registerCpuRoutes(...)` 一行。
 *
 * ## 两条端点
 *   `GET  /api/qwen-paint/cpu-profile`  只读：CPU 画像 + 五档说明 + **当前真正会挂的参数**
 *   `POST /api/qwen-paint/cpu-accel`    写档位（落 uiState，重启 ComfyUI 后生效）
 *
 * ## 信任围栏（与 `/api/qwen-paint/inpaint`、`/quick-edit` 完全同一套口径）
 *   1. `isLocalRequest(req)` —— 只认回环来源，防 DNS rebinding / 局域网他人；
 *   2. 方法限制 —— GET 只给画像，写档位必须 POST；
 *   3. `guardWriteRequest(req, res)` —— 校验 Origin / Referer，防跨站表单打本机；
 *   4. `readJsonBody(req)` —— 有界读取（项目里的实现带体积上限），不裸读流。
 *
 * ## 为什么 GET 也要围栏
 *   CPU 型号 + 核心数属于**本机指纹**，不是公开信息。虽然不含路径/用户名，但没必要
 *   让网页里的任意脚本都能读到，所以 GET 一样做回环校验。
 */
```


### tts-lowlatency-space-media-convert-tool（原 lib/media-convert-tool.js 首块注释，逐字）

```js
/**
 * lib/media-convert-tool.js —— 给 Agent 的 `convert_media` 工具（媒体格式转换）。
 *
 * ## 覆盖的用户需求
 *   · 图片 JPG / PNG / WebP、视频 MP4 / MKV / MOV / WebM、音频 MP3 / AAC / WAV / FLAC；
 *   · 插件生成物、用户自有媒体都能转；
 *   · 动图（GIF / APNG / 动图 WebP）→ 视频；
 *   · 生成时可「指定输出格式」由 lib/media-postconvert.js 的生成完成钩子自动后转码。
 *
 * ## 诚实边界
 *   · 参数构建是纯计算；真执行必须经 lib/media-exec.js 探测到 ffmpeg。
 *     没探测到 / 执行器被禁用 → ok:false + 明确 reason + command 参数预览，
 *     **绝不真起进程、绝不谎称已生成文件**。
 *   · 编码器是否编进本机 ffmpeg 只能由真实执行验证，description 不承诺倍率或成功率。
 *   · 跨类转换（图片↔音频等）明确拒绝，不"尽力而为"地产生垃圾文件。
 *
 * ## 目录围栏（双围栏）
 *   · 输出：必须落在 outputDir 内，拒绝 .. 穿越 / 盘符越界 / 目录本身；
 *   · 输入：必须落在 outputDir 或宿主显式注入的 sourceDirs 内 ——
 *     用户自有素材请放进公布目录（或由宿主配置允许目录），绝不把任意本机路径喂给 ffmpeg。
 *   · 异常只写本机日志、回固定文案，不回吐 error.message（可能夹带本机绝对路径）。
 */
```


### tts-lowlatency-space-job-tool（原 lib/job-tool.js 首块注释，逐字）

```js
/**
 * lib/job-tool.js - 给 Agent 的「管理后台作业」工具（manage_jobs）。
 *
 * 内部持有一个 lib/job-queue.js 的实例。所有真实作业体都由 deps 注入：
 *   · deps.queue        —— 直接注入现成队列（离线测试用，便于确定性断言）
 *   · deps.runners      —— 名字 -> run 函数 的映射；submit 用 kind 选一个
 *   · deps.makeRun      —— (args) => run 的工厂（可选）
 *   · deps.defaultRun   —— 兜底 run（可选）
 *   · args.run          —— 从 JS 直接调用时也可传函数（Agent 走 JSON 时用 kind）
 *
 * 若以上都没给，submit 会用一个**纯内存占位 run**：只记账、不联网、不出图、
 * 不起子进程，并在 description / reason 里如实说明。能力走探测 + 降级，
 * 不把任何第三方节点包或外部能力硬编码成「已安装」。
 *
 * output.schema.properties 必须声明 execute 返回的全部顶层字段：
 * 「漏写一个字段 = Agent 收到空对象」（见 lib/tool-contracts.js 的 slimResult）。
 * 因此每个 action 都回齐 {ok, jobs, job, stats, config, reason} 六个键。
 *
 * 代码风格：ESM、export function/const、字符串只用 ASCII 直引号。
 */
```

### ttsll2-space-blockswap（原 lib/blockswap.js 首块注释，逐字）

```js
/**
 * lib/blockswap.js —— 极限低显存的 Block 交换层（发现 / 报告 / 指引，0.35.0 之后批次）。
 *
 * ## 是什么
 *   UniBlockSwap（MIT，smthemex/ComfyUI_UniBlockSwap）：ComfyUI 原生工作流的通用
 *   block 交换节点，把模型分块卸载到内存，让 4-6GB 显存用户跑大模型
 *   （repo 实测口径：klein9B Q8 ≈ 4.8G VRAM、minimax H3 ≈ 4.5G —— unverified）。
 *
 * ## 机制（README 原文口径）
 *   num block：-1 = 单块卸载；0 = 关闭 swap；>0 = 预缓存对应数量的 block 到 CUDA；
 *   ≥ 总块数 = 关闭（等同 0）。⚠ ComfyUI ≥0.35 需临时关闭 dynamic 机制 swap 才生效
 *   （节点已自带处理）；目的是极限压显存、避免共享显存，推理速度可能不如原生。
 *
 * ## 诚实边界（红线不变）
 *   · 插件**不代装** custom node：安装 = 用户把 repo git clone 进 ComfyUI/custom_nodes；
 *   · 本模块只做「发现 + 报告 + 安装指引」——节点未在本机 /object_info 出现前，
 *     **不写任何工作流槽位**（needsSlotMapping 恒真，直到真机核实）；
 *   · 「自动启用」收窄为：发现节点 + 用户显式选择低显存档后才参与编排，绝不静默挂载；
 *   · 全部收益数字来自 repo 口径，unverified。
 */
```


### ttsll2-space-model-options（原 lib/model-options.js 首块注释，逐字）

```js
/**
 * lib/model-options.js —— 主模型候选端点与界面选择的落盘（host 侧）。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 贴着 262,144 B 单文件上限（selftest.mjs 硬断言），端点处理器
 *   一律外置（先例：lib/reference-endpoints.js）。host 只注入依赖 + 一行注册。
 *
 * ## 语义（面板「主模型」下拉的三模式分工）
 *   · 生图 / 混合 → 写 `?mainmodel=`（既有 C3 机制：**动态白名单校验**后进
 *     cfg.mainModelOverride，resolvePlan 只在它确实在探测清单里时才采纳），
 *     并镜像落盘 uiState.unet —— 重启后 apply() 恢复，文件被删则如实回落。
 *   · 视频 → 写 `?unetvideo=`，落盘 uiState.unetVideo；lib/video-workflow.js 的
 *     activeVideoUnet() 读取它，缺省仍是已验的 WAN_ASSETS.unet。
 *   · 候选清单来自真机 /object_info（unetOptionsFrom，见 comfy-catalog.js）。
 *
 * ## 红线
 *   · 候选拿不到就是拿不到：探测失败回 online:false + 空清单 + 原因，绝不编造。
 *   · 写值必须在本机探测到的模型清单里（与 mainmodel 同款动态白名单），防手拼
 *     URL 把任意路径塞进工作流 —— 这是安全问题，不只是体验。
 */
```


### ttsll2-space-accel-profiles（原 lib/accel-profiles.js 首块注释，逐字）

```js
/**
 * lib/accel-profiles.js —— 加速档的**互斥选择**（未装就退回"不加速"，绝不抛错）。
 *
 * ## 它修的是什么
 *   报告 v2 的写法：
 *     pick({ frames, vendor }) { if (frames > 100) return 'easycache'; ... }
 *     // 而 AccelPass 里：if (!installed.has(profile)) throw new Error('加速节点未安装')
 *   本机 **EasyCache 没装** ⇒ 任何 >100 帧的任务都会**直接抛错失败**，
 *   而不是降级成"不加速、正常跑"。违反 G7「兜底不写死」。
 *   ⇒ 本文件把 `installed` 变成 pick 的**入参**：只返回已装的档，没有就返回 null。
 *
 * ## 三档的适用面（都是第三方自定义节点，没装就是没装，不假装）
 *   · `sage`     SageAttention —— **只对 NVIDIA** 有意义（内核依赖 CUDA）。
 *   · `spectrum` ComfyUI-Spectrum-Qwen-Proper —— 跳步，图/视频都能用。
 *   · `easycache` EasyCache —— 长任务（帧多）收益最大，但本机未装。
 *
 * ## 返回值约定
 *   `pick()` 返回档 id 或 **null**。null 的含义是「这一单不加加速节点，正常跑」——
 *   调用方收到 null 必须**空跑**（跳过 pass），不得抛错。
 */
```


### ttsll2-space-worker-manager（原 lib/worker-manager.js 首块注释，逐字）

```js
/**
 * lib/worker-manager.js —— 主控端 + 独立 Worker 的生命周期管理（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   All-in-One 最大的坑：GPT-SoVITS / IndexTTS2 / ACE-Step 1.5 / YuE2 各自依赖
 *   不同版本的 torch、ffmpeg、CUDA。插件**绝不在自身环境里 pip install**，
 *   而是只做 UI + 调度：每个模型一个独立 Worker，本机回环 HTTP 通信。
 *
 * ## ★ 诚实边界（必须守住）
 *   · 环境隔离（venv / conda / docker）只提供**配置位与编排**；
 *     插件不创建环境、不装依赖、不拉镜像、不下载权重、不执行 pip。
 *   · 进程启动 / 终止 / 健康检查 / 显存探测全部**依赖注入**：
 *     没注入就明确返回「未注入执行器 / 未检测」，绝不假装 Worker 已启动。
 *   · 显存预检的数字只能来自注入的 vramProbe（例如宿主调用 nvidia-smi），
 *     本模块**不编造任何 GB 数**，也不承诺某模型「带得动」。
 *
 * ## 防爆策略
 *   maxConcurrent（默认 1，同一时刻只让一个吃显存的 Worker 跑）、
 *   显存预算上限、空闲 N 分钟自动终止、优雅终止先 TERM 后超时 KILL、
 *   启动失败自动回状态、健康检查失败标 error 而不是静默继续。
 */
```


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### tts-lowlatency-note-001（原 lib/tts-lowlatency.js L66-75）

```js
/**
 * 构造统一合成请求：gsv=/tts 平铺（★ 2026-11-19 真机实测的 GSV.CPP V5 契约）；
 * openai=/v1/audio/speech 嵌套。
 *
 * ★ gsv 契约细节（服务端 400/403 白纸黑字，别再用旧字段）：
 *   · 必填 text / text_lang / ref_audio_path / prompt_text / prompt_lang；
 *   · 原版 GPT-SoVITS API 的 refer_wav_path / text_language 字段名它不认（拒收 400）；
 *   · 开关字段是 streaming_mode，不是 stream；
 *   · ref_audio_path 必须落在服务端 --allow-path 白名单目录里，否则 403。
 */
```

### tts-lowlatency-note-002（原 lib/tts-lowlatency.js L90-93）

```js
/** 服务健康探测：fetch 必须注入；任何失败都返回结构化降级，不抛。
 *  ★ 2026-11-19：healthIncludes 响应体标记校验——两个外部服务默认端口同为 9880，
 *  先跑起来的会把另一个的探活也"喂饱"（本机实录：GSV.CPP 在线后 AnifLive 误报在线）。
 *  配了 healthIncludes 的服务必须响应体含该标记才算在线；没配的维持原状。 */
```
