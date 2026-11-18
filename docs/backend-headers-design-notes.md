# 后端模块文件头注释外置存档

> 由一次性脚本外置：只含文件定位/历史叙述，不含函数签名与参数契约。
> 源码只留锚点，逐字内容见此，可逐字恢复。


---

### backend-note-hipfire-img（原 lib/hipfire-img.js L1-45）

```js
/**
 * dsh-qwen-paint —— hipfire 出图后端适配器（**通用版**）
 * ============================================================================
 * 定位：让插件除 ComfyUI 之外还能用 **hipfire** 出图。
 *
 * ★ 需求原话是「适用于 A 卡用户」—— 所以本文件**不写死任何本机路径**：
 *   · exe 位置：cfg.hipfireExe → 环境变量 → PATH → 常见位置，逐级探测；
 *   · 模型名 / 后端 / 超时 / 传输方式全部可配；
 *   · 找不到 exe、找不到模型、hipfire 报错 → **一律明确抛错**，
 *     绝不返回一个假的成功（出图是用户可见产物，静默失败比报错更糟）。
 *
 * ★ 本文件**只在 `imageBackend: 'hipfire'` 时被调用**，默认后端仍是 comfyui。
 *   现有 ComfyUI 出图路径一行不改（这是硬约束）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 两条通道都实现，HTTP 优先（都由同一个 daemon 消息 `img_generate` 承载）：
 *
 *   · **HTTP**（推荐）：`hipfire serve` 起常驻服务 →
 *     `POST /v1/images/generations`。daemon 常驻，不必每次重新加载权重。
 *     ⚠ 协议约束（读上游 docs/SERVE.md + crates/hipfire-cli/src/serve/http.rs 核实）：
 *        1. 端点就是 `/v1/images/generations` —— 上游**没有** `/api/generate/image`；
 *        2. `response_format` **必须** `"b64_json"`，`n` **必须** `1`，否则 400；
 *        3. 响应 `{data:[{b64_json,width,height,seed,steps}], model, hipfire:{ms}}`，
 *           **不返回服务端文件路径** → 我们自己 base64 解码落盘。
 *        4. 图生图必须另走 `POST /v1/images/edits`（multipart，仅 FLUX.2 Klein）；
 *           `/v1/images/generations` **拒绝**带 images 字段的请求（回 400）。
 *
 *   · **CLI**（回退）：`hipfire img <MODEL> <PROMPT> … -o <OUT> -j`。
 *     每次调用是 fresh daemon 进程，**首次会慢**（要加载权重），不是卡死。
 *     ⚠ 选项必须全部放在 prompt **之前** —— prompt 是 greedy trailing
 *       positional，会吞掉后面所有内容（上游 --help 里明确警告）。
 *
 * `cfg.hipfireTransport`: 'auto'（默认，HTTP 探活失败就回退 CLI）| 'http' | 'cli'。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★ 明确不支持的功能（**如实报错，绝不假装支持**）
 *
 *   · **negative（负面提示词）**：hipfire 的 img 与 HTTP 两个接口**都没有**这个参数
 *     （`hipfire img --help` 没有，SERVE.md 字段表也没有）。调用方传了 → 明确报错。
 *   · **图生图**：仅 FLUX.2 Klein（arch 45）支持，FLUX.1 会拒绝。
 *   · **模型**：hipfire 只支持 FLUX.1（arch 40）与 FLUX.2 Klein（arch 45）。
 *     ComfyUI 的 Qwen-Image 模型**不能**喂给 hipfire（容器格式与架构都不支持）——
 *     这不是配置问题，是 arch_id / loader / kernel 都没有实现。
 * ============================================================================
 */
```


---

### backend-note-net-guard（原 lib/net-guard.js L1-37）

```js
/**
 * dsh-qwen-paint —— 网络边界守卫（2026-10-15 新增，DSH STORE 合规整改）
 *
 * ## 为什么有这个文件
 *   DSH STORE 自动审核（AI-Scarlett）在 Issue #1390 指出：
 *
 *   > 当前 README 仍将网络能力声明为"仅本机回环、不访问外部地址"，但
 *   > `lib/index.js` 直接合并 `rawConfig`，随后使用可配置的 `comfyUrl`
 *   > 发起请求，未证明回环约束及重定向边界。
 *
 *   也就是说 —— **文档说了"只用 127.0.0.1"，代码里却没有任何一处真的拦住
 *   别的地址**。`comfyUrl` 是个普通配置项，写 `http://192.168.1.100:8188`
 *   或者任何公网地址，插件都会照发请求。这是"声明与实现不符"，也是本轮
 *   被拒的唯一理由。
 *
 *   审核员同时明确了两点：
 *     · **不要删除功能**，也不要"把真实能力声明为 false"来蒙混；
 *     · 请正面解决：**要么落地限制并处理重定向，要么如实披露可配置的外部端点**。
 *
 *   本文件即"落地限制"那一支：把回环约束做成**代码层强制**，并**禁止重定向**，
 *   同时保留一个显式的 opt-in 开关 `allowRemoteComfy`，让确实需要连局域网
 *   ComfyUI 的用户能**主动、明确地**关掉这道闸（而不是靠改文档撒谎）。
 *
 * ## 设计原则
 *   · 默认拒绝：`allowRemoteComfy` 为 false（默认值）时，非回环地址一律抛错。
 *   · 校验在**启动时**做一次（apply() 里），fail-fast，不让配错的地址带着
 *     半边功能跑起来，到出图那一刻才莫名其妙地失败。
 *   · 每个请求发出去之前**再校验一次**（safeFetch），防住"启动后被改配置"或
 *     "URL 在别处被拼接"的漏网。
 *   · 重定向一律 `redirect: 'error'` —— 不跟。回环地址被 302 到公网是最典型的
 *     越界手法，直接让 fetch 抛错，比"跟过去再检查"可靠得多。
 *
 * ## 不放宽的东西
 *   · 不做 DNS 解析后的二次校验 —— 本插件只在**字面量 IP / localhost** 上工作，
 *     连"域名"都不接受（见 isLoopbackUrl）。这样就不存在 DNS rebinding 面：
 *     没有任何名字需要解析，也就没有"解析前是回环、解析后是外部"的窗口。
 */
```


---

### backend-note-cpu-profile（原 lib/cpu-profile.js L1-50）

```js
/**
 * CPU 指令集识别 + CPU 加速档位（**纯逻辑，零 I/O**）。
 *
 * ## 为什么单独一个模块
 *   `lib/index.js` 只剩 4.7 KB 余量、`lib/client.js` 只剩 290 B，而这块逻辑要
 *   能**离线单测**（不需要真 ComfyUI、不需要真 CPU 指令集）。所以全部做成
 *   纯函数：输入是 `os.cpus()` 之类的外部事实，输出是参数数组。
 *
 * ## 三条硬规矩（写死在实现里，不靠自觉）
 *
 * 1. **只输出 ComfyUI 官方 cli_args 里真实存在的开关。**
 *    已逐条核对 `comfy/cli_args.py`（2026-11-13，本机 ROCm 版 ComfyUI）：
 *      `--cpu`（"To use the CPU for everything (slow)"）
 *      `--lowvram` / `--highvram` / `--novram` / `--reserve-vram`
 *      `--use-pytorch-cross-attention` / `--use-quad-cross-attention` / ...
 *      `--preview-method <none|auto|latent2rgb|taesd>`
 *      `--bf16-unet` / `--bf16-text-enc` / `--fp32-unet` / ...
 *    **不存在**的东西一律不进这个文件：`n_threads`（ComfyUI-GGUF 的
 *    `UnetLoaderGGUF.INPUT_TYPES` 只有 `unet_name`）、GGUF 加载器的 `device=` /
 *    `dtype="int8"`（真实字段是 `dequant_dtype` / `patch_dtype` / `patch_on_device`，
 *    取值里没有 int8）。
 *
 *    ⚠⚠ **但 `QwenImage21Cache` 是真实存在的官方节点**，我第一版把它当成"编造的
 *    节点名"写进了这里，是**错的** —— 我当时搜的是第三方 `TE-Speed-QwenImage21`
 *    的 `.pyd`（那里面确实没有这个名字），而它是 ComfyUI 主程序自带的：
 *      `comfy_extras/nodes_qwen.py` 的 `class QwenImage21Cache(io.ComfyNode)`，
 *      输入正是 `device`（auto / gpu / cpu / off）+ `dtype`（default / int8 / int4）。
 *      官方 tooltip 原文：`cpu (RAM) is prefetched behind compute and costs little speed`、
 *      `int8 halves the cache at about bf16 accuracy`。
 *    本项目早就接好了：`cfg.qwenCacheDevice` / `cfg.qwenCacheDtype`
 *    → `lib/model-chain.js` 的 `prefixCacheNode()`。
 *    ⇒ 所以"device=cpu + dtype=int8"这条建议是对的，别和 GGUF 加载器混为一谈。
 *
 * 2. **实测 > 型号推断 > 未知。三者必须可区分。**
 *    有 CPU flags 就标 `isaEvidence: 'flags'`（实测）；
 *    只有型号就标 `'model'`（推断，`isaVerified: false`）；
 *    连型号都不认识就返回 `null` 而不是 `false` ——
 *    **"不知道"不等于"没有"**，拿 null 去当 false 用会静默关掉用户本来能用的加速。
 *
 * 3. **默认零漂移。**
 *    `mode:'off'` 时 `args` / `env` 必须是空数组，一个字节都不改现有启动参数。
 *
 * ## 线程数到底怎么钉
 *   用户资料里说「GGUF 加载器的 `n_threads` 设为物理核心数」—— 该字段**不存在**。
 *   真正控制 PyTorch CPU 线程的是 OpenMP / MKL 的**环境变量**：
 *      `OMP_NUM_THREADS` / `MKL_NUM_THREADS` / `OPENBLAS_NUM_THREADS`
 *   它们在 `startComfyHidden` 里以 `export K=V`（POSIX）/ `set K=V`（Windows .cmd）
 *   注入，两条启动路径都已支持。钉**物理**核心数而不是逻辑线程数，是因为
 *   SMT 兄弟线程争同一份执行端口，超线程跑 GEMM 通常反而慢。
 */
```


---

### backend-note-video-workflow（原 lib/video-workflow.js L1-27）

```js
/**
 * lib/video-workflow.js —— 视频链（Wan 2.2 / Hummingbird-XT-5B DMD）工作流构造。
 *
 * ## 这张图不是猜的
 *   节点拓扑与参数取自本机**已跑通**的图（`xt_4step_test.py` 提交的那份）：
 *     1 CLIPLoader(umt5_xxl_fp8, type=wan) → 4/5 CLIPTextEncode(正/负)
 *     2 UNETLoader(Hummingbird-XT-5B) → 6 ModelSamplingSD3(shift=10) → 8 KSampler
 *     3 VAELoader(Hummingbird-Wan2.2-VAE) → 7 Wan22ImageToVideoLatent → 8
 *     8 → 12 VAEDecodeTiled → 10 VHS_VideoCombine(h264-mp4)
 *   实测基线（开发笔记 2026-11-09 记录）：832×480/25 帧/4 步 = 18.12 s；
 *   1280×720/25 帧 = 85.48 s；81 帧 16 fps = 78.69 s（热机，非黑已验）。
 *
 * ## ⚠ 两条与生图侧一致的语义
 *   ① **速度% 不改蒸馏步数**。XT-5B 是 DMD 蒸馏模型，实测 3/4/5/6 步耗时几乎一样
 *      （每步约 +1 s），步数不是"快慢旋钮"而是"工作点"。所以 steps 固定 4，
 *      速度% 只压 **帧数 / 帧率 / 高度**。`SPEED_MAP.video[*].steps` 列因此**不生效**。
 *   ② `length` 必须是 **4n+1**（Wan latent 的时间维按 4 压缩，+1 才对得齐），
 *      `width/height` 必须是 **16 的倍数**。这两个不合法 ComfyUI 会直接拒收或出黑帧，
 *      所以在这里就对齐并**如实记录改了什么**（不静默改完当没事）。
 *
 * ## 2026-11-14：A1 工作流 JSON 化的样板（双轨并存）
 *   `workflows/video-wan22.json` 是下面这张图的**声明式同构版本**，
 *   `buildVideoWorkflowFromManifest()` 用 `bindGraph()` 从清单造图。
 *   两条路径**共用 `resolveVideoParams()`**（参数归一化只有一份实现），
 *   因此「换清单」不会带来行为差异；`scripts/test-workflow-manifest.mjs`
 *   逐字节比对两者产物，防漂移。**迁移期先并存，验证稳定后再择一切换。**
 */
```


---

### backend-note-tts-workflow（原 lib/tts-workflow.js L1-24）

```js
/**
 * lib/tts-workflow.js —— 混合模式的 TTS 段契约与兜底链（报告 v3 §3/§10）。
 *
 * ## 本机实况（2026-11-10 真机复核，推翻上一轮误判）
 *   · 节点：/object_info 共 1684 个，含 `custom_nodes.ComfyUI-Qwen-TTS` 的
 *     **9 个 FB_Qwen3TTS\* 节点**（CustomVoice / VoiceDesign / DialogueInference /
 *     VoiceClone / VoiceClonePrompt / LoadSpeaker / RoleBank / SaveVoice / Train）；
 *     音频保存节点 `SaveAudio`(flac) / `SaveAudioMP3`(mp3) / `SaveAudioOpus` / `SaveAudioAdvanced`。
 *   · 权重：ComfyUI 安装目录下 `models/qwen-tts/` 中
 *     `Qwen3-TTS-12Hz-1.7B-CustomVoice/`、`Qwen3-TTS-Tokenizer-12Hz/`、`voices/` 已下载。
 *
 * ## 上一轮为什么把「有」判成「没有」（两条都记在这，别再犯）
 *   ① 兜底链写的节点名是猜的：`FB_Qwen3TTS` / `FB_Qwen3TTSGGUF` / `MiniMaxH3TTS`
 *      —— /object_info 里**一个都不存在**，真实名带后缀。
 *   ② 判据要求 `models/` 的加载器下拉里有 `qwen3-tts` 文件名 —— 但该节点包权重由
 *      `download_models.py` 的 `snapshot_download` 落到 `models/qwen-tts/`，
 *      **不进任何节点的下拉候选**。于是节点齐、权重齐，仍恒返回 available=false。
 *   ⇒ 现在只按**真实节点类名**探测；权重可用性交给 ComfyUI 执行时判定（装了节点包 +
 *     权重目录 = 放行），不再拿文件名列表当闸门。
 *
 * ## 保存格式
 *   `SaveAudio` 是 FLAC（deprecated），`SaveAudioMP3` 是 MP3。本模块主链出 mp3；
 *   落盘一律按 ComfyUI 返回的 `filename` 真实扩展名，**不写死 .wav**。
 */
```


---

### backend-note2-reference-strategy（原 lib/reference-strategy.js L1-34）

```js
/**
 * lib/reference-strategy.js —— 模型无关的「角色参考」适配层。
 *
 * ## 它解决什么
 *   用参考图的图像特征约束生成，让角色在生图 / 视频里保持同一外观。难点不是
 *   "某个模型怎么接"，而是**每个模型把参考图接进工作流的方式都不同**：
 *   Qwen 用多图编码器槽位、IP-Adapter 用 CLIP-Vision 特征、Flux 用 Kontext、
 *   ControlNet 用 Reference 权重、Wan 用 start_image / Animate……
 *   写死任何一条都不可能对"所有模型"成立。
 *
 * ## 通用办法 = 两张表 + 一条与模型无关的兜底
 *   ① 策略表（REFERENCE_STRATEGIES）：每条只声明"需要哪些节点类名、支持哪种模式、
 *      最多几张参考图"，是**数据**，不是分支。新增模型 = 加一条数据。
 *   ② 运行时能力协商：拿后端 `/object_info` 的真实节点类名集合去对账，选当前
 *      后端能用的最高优先级策略。探测不到就往下退。
 *   ③ 通用兜底（UNIVERSAL_FALLBACK）：只用**任何 latent diffusion 模型都有**的
 *      基础节点 —— 图：`LoadImage → VAEEncode` 编码成 init latent 接采样器的
 *      `latent_image`；视频：`LoadImage` 接起始帧节点的 `start_image`。
 *      关键是与模型无关的**找法**：采样器按「谁有 latent_image 输入」找，
 *      起始帧节点按「谁有 start_image 输入」找，VAE 按「谁在给解码节点供 vae」找，
 *      不写死任何模型的节点类名；需要补可选槽时以 /object_info 自报的输入槽为准。
 *      找不到就**不落地**（applied:false + 说明），绝不提交一个 ComfyUI 必拒的节点
 *      或给节点凭空加一个输入来假装"通用"。
 *
 * ## 时序漂移（视频侧）
 *   视频相对生图多一个"角色逐帧变脸"的问题。`planCharacterLock` 产出分段计划：
 *   全段固定同一 seed、每段锚定首帧、段间重叠，减少风格跳变。它只产**计划数据**，
 *   不声称已接入帧插值/时序平滑节点（那类节点需单独安装，未装则如实标注）。
 *
 * ## 边界
 *   本模块是纯函数 + 纯数据，不发起网络请求、不读文件、不 import 任何 host 模块，
 *   便于离线回归。`applyReferencePlan` 用 structuredClone，绝不原地改传入的工作流
 *   （保持"不传策略就零漂移"的既有语义）。
 */
```


---

### backend-note2-hipfire-img（原 lib/hipfire-img.js L57-67）

```js
  /**
   * ★★ 出图前预检模型是否已在本地。默认 **true**。
   *
   * 为什么必须默认开（实测踩到的真实事故）：
   *   `hipfire img <缺失的模型>` **不会报错**，而是**静默开始下载**（23.8 GB）——
   *   在插件的 600 秒超时里表现为"一直没动静"，最后报一个语焉不详的超时。
   *   更糟的是：它在 C 盘留下半截 .part 文件，而用户可能根本不想下这个模型。
   *   ✓ 所以先查 `hipfire list`，模型不在本地就**立刻明确报错**，绝不触发下载。
   *
   * 关掉它 = 接受"hipfire 可自动拉模型"的行为（半截文件会留在 hipfire 的模型目录）。
   */
```

<a id="backend-header-igpu-profiles"></a>

### igpu-profiles.js

```
/**
 * dsh-qwen-paint —— 核显（iGPU）型号档案：用户可选档位 + 可选自动下载
 * ============================================================================
 * ★ 2026-11-13 新增。用户明确要求：**把清单里的核显型号做成用户可选的选项**，
 *   并配一套「可选自动下载」；同时明确「不要试本机核显、不用跑实测」。
 *
 * ## 这个文件是什么
 *   · 一份**纯数据 + 纯函数**的型号档案（不联网、不探测硬件、不写文件、不跑模型）。
 *   · 安装脚本 `scripts/setup.mjs` 用它渲染选项列表；
 *   · `lib/config.js` 的 `assessLowEndReadiness()` 在用户指定了型号时透出对应建议；
 *   · 离线回归 `scripts/test-igpu-profiles.mjs` 锁住清单完整性与「默认不下载」。
 *
 * ## ⚠⚠ 三条诚实声明（务必保留，别改成「实测结论」）
 *   ① 下面每个 `reference` 里的秒数，来自用户提供的机型清单 / 社区公开分享，
 *      **本插件从未在任何一台核显机上实测过**（`unverified: true`）。
 *   ② 这些秒数测的是 **SD 1.5 / SDXL / Z-Image-Turbo / OpenVINO 示例**等
 *      **不同模型、不同分辨率、不同步数**，与本插件的 Qwen-Image 2.1 工作流
 *      **不可直接比较**（`comparable: false`）。它们只用来给用户一个量级感觉，
 *      **绝不替换** `assessLowEndReadiness()` 的 `speedTargetSec`。
 *   ③ 后端建议（DirectML / OpenVINO / ROCm）只是**路径说明**：换 PyTorch 后端
 *      要改用户自己的 ComfyUI 环境，插件**不自动改、不自动装**。
 *
 * ## 下载口径
 *   `IGPU_DOWNLOAD_CATALOG` 只描述「下什么、从哪下、按什么校验」，
 *   **默认不下**（`IGPU_AUTO_DOWNLOAD_DEFAULT = false`）。
 *   唯一的触发方式是用户显式给 `--igpu-download`（或交互里明确回答「下」）。
 *   大小与 sha256 取自服务器权威值（HF API 的 lfs.oid / Content-Length），不是估算。
 */
```

<a id="backend-header-gif-tool"></a>

### gif-tool.js

```
/**
 * lib/gif-tool.js —— 给 Agent 的「转 GIF」工具（convert_to_gif）。
 *
 * ## 这个工具做什么 / 不做什么
 *   把「单张图 / 图片序列 / 一段视频」转换成 GIF 所需的 ffmpeg 参数**完整构建出来**，
 *   参数构建是纯计算：不解码媒体、不联网、不依赖任何外部可执行文件。
 *   是否真的落盘由宿主注入的 `runCommand` 决定 —— 注入了才执行（「探测 → 可用才启用」），
 *   没注入就走离线降级：ok:false + 明确 reason，但 command 仍回给调用方参考，
 *   **绝不真起进程、绝不假装已生成文件**。
 *
 * ## 诚实边界
 *   · ffmpeg 是否可用不在这里硬编码，交由 deps.runCommand / gif-endpoints 的探测结果决定；
 *   · 视频 / 单图的 frames 是按 duration×fps 的估算或固定值（未解码源），不是实测帧数；
 *   · 输出路径一律走 resolveGifOutputPath() 的目录围栏，越界 / .. 穿越直接拒绝。
 *
 * ## 参数怎么给（Agent 视角）
 *   · 单张图：{ source: "<本机图片绝对路径>", target: "out.gif" }
 *   · 图片序列：{ sources: ["a.png","b.png","c.png"], target: "seq.gif", fps: 8 }
 *   · 视频转 GIF：{ source: "clip.mp4", target: "clip.gif", duration: 4, fps: 12 }
 *   可配：fps(1-60,默认12) / width(16-4096,默认480) / height(-1=按比例,默认-1) /
 *         duration(0.1-60秒,默认3) / loop(-1不循环,0无限,默认0) /
 *         dither(调色抖动算法,默认sierra2_4a) / maxColors(2-256,默认128)。
 *   什么时候用：用户要「把这张图 / 这几帧 / 这段视频做成动图」时用它；
 *   只在宿主已探测到 ffmpeg 可用（注入 runCommand）时才会真出文件，否则按降级说明如实回复。
 */
```


---

### hdr-note-graph-audit（原 lib/graph-audit.js L1-26）

```js
/**
 * A1 生图链 / TTS 链的**契约对账** + D26 的**提交前图裁剪**。
 *
 * ## 为什么不是"把生图链整图搬进清单"
 * 生图链按 caps 折 basic/full、按参考图/控制图/批量分裂十几条分支，
 * 节点 id 是硬编码 + `delete undefined` 的产物。整图清单化会变成半迁移：
 * 清单和代码两边都能跑、两边都会漂，且视频链那套 `requires.nodes` 双向相等校验
 * 对"分支图"根本不成立（basic 档的图里本来就没有 VAEDecodeTiled）。
 *
 * 所以这里换一种契约：**只锁"哪些角色必须在、参数必须流到哪"**。
 * 图怎么长出来不管，但长完必须满足契约。一旦不满足，报的是
 * `参数 steps 期望 25、实际 12` 这种**能直接定位**的差异 —— 这正是
 * 图结构指纹（workflow-fingerprint.js）答不出的那一半。
 *
 * 两者分工：
 *   · 指纹  —— 图变了没有（整图哈希，防悄悄漂移，答不出哪里变）
 *   · 契约  —— 该在的还在吗、值对不对（角色级，能定位到 slot）
 *
 * ## D26：ComfyUI 本来就是"按执行图懒加载"
 * 它只会执行 output 节点反向可达的那部分，可达不到的节点连模型都不会加载。
 * 所以"运行时跳过"不需要 ExecutionBlocker —— **项目侧的缺口是别把无关节点塞进提交载荷**。
 * `pruneGraph()` 就是从输出节点反向裁剪，把不可达的节点摘掉再提交。
 *
 * ⚠ 如实说明：裁剪的收益是**缩小 /prompt 的校验面与载荷**，不是"省显存"。
 *   ComfyUI 对不可达节点本来就不加载。别把这条吹成性能优化。
 */
```


---

### hdr-note-pipeline-controls（原 lib/pipeline-controls.js L1-25）

```js
/**
 * lib/pipeline-controls.js —— 通用 Comfy 控制层的**控制项持久化 + 生效映射**（host 侧 ESM）。
 *
 * ## 它解决什么
 *   `lib/mode-schema.js` 是契约（有哪些模式、哪些滑块、取值范围）；本文件是**落地层**：
 *   把用户在前端面板拨的滑块值安全地落盘、并在出图时变成**真的会生效**的参数。
 *
 * ## 三层优先级（继承既有铁律，别改）
 *   **显式工具入参 > 面板控制项 > 记忆偏好 > cfg.preset > 内置默认**
 *   —— 面板是"用户自己拨的"，可以盖住记忆；但模型当场显式传的 args 永远赢。
 *   实现走 `resolveDrawParams(args, cfg, pref)` 既有的 pref 通道（见 index.js 的
 *   `controlsToPref()` 调用点），**不改那边的判据**，只多喂一层兜底。
 *
 * ## 为什么"速度%"只动尺寸、不动步数
 *   Qwen-Image 2.1 的官方 Turbo 链是**步蒸馏**模型：8 步 / 9 步是训练时固定的工作点，
 *   换个步数不是"快一点"，是**掉画质**（sigmas 与蒸馏对齐被破坏）。
 *   用户的硬约束是"不掉质量" ⇒ 速度% 只能压缩**画幅像素预算**（1024→896→768→640）
 *   与参考图张数，绝不改进蒸馏步数。
 *   4 步极速档（fast4）是**另一条带自己 LoRA/shift 的链**，由 `fast4Enabled` 决定，
 *   不在本文件的滑块语义里 —— 别把两者混成一个"速度"。
 *
 * ## 落盘位置
 *   `<outputDir>/.comfy-pipeline-controls.json`（与 `.qwen-paint-memory.jsonl` 同目录）。
 *   写失败**一律吞掉**：控制项存不下顶多下次回到默认值，绝不该把出图拖成失败。
 */
```


---

### hdr-note-vulkan-upscale（原 lib/vulkan-upscale.js L1-24）

```js
/**
 * lib/vulkan-upscale.js —— 手动超分的 Vulkan 直跑引擎（0.35.0 内置执行路径）。
 *
 * ## 是什么
 *   两个 ncnn-vulkan 系超分引擎作为 `manual_upscale` 的**真实执行器**：
 *     · realesrgan-ncnn-vulkan（MIT，xinntao/Real-ESRGAN-ncnn-vulkan，windows 包约 2.06 MB）
 *     · realcugan-ncnn-vulkan（MIT，nihui/realcugan-ncnn-vulkan，动漫向，windows 包约 43.9 MB）
 *   不经 ComfyUI、不需要任何 Python 环境；AMD / NVIDIA / Intel（含核显）只要有 Vulkan
 *   即可直跑 —— 这正是低配 / 核显目标机没有 ROCm 时的超分出路。
 *
 * ## 诚实边界
 *   · 引擎二进制**默认不装**：由 scripts/vulkan-upscale-catalog.mjs / setup --vulkan-upscale
 *     经用户显式下载（只走 GitHub Releases 官方源——可执行文件不加第三方加速镜像，服务器权威字节数校验；
 *     Release 不提供 sha256 ⇒ 只比大小并如实说明，绝不谎称已校验哈希）。
 *   · 未安装 / 未配置 vulkanUpscalePath 时：detect 返回 available:false + 理由，
 *     计划层如实降级回草案，绝不谎称已放大或已落盘。
 *   · 模型清单**动态探测**（<安装目录>/models/*.param），不硬编码任何模型名。
 *   · denoise / sharpen 是 ComfyUI 侧概念，Vulkan 引擎不支持 ⇒ 显式 ignored，不静默丢弃。
 *
 * ## 安全
 *   · exe 只从 cfg.vulkanUpscalePath（用户显式配置的安装目录）解析，请求体不给路径；
 *   · argv 一律数组、不拼 shell；model 名拒绝路径分隔符与 ..；
 *   · 输入 / 输出沿用 manual-upscale 的出图目录围栏；失败回固定文案，详情只进本机日志。
 */
```


---

### hdr-note-prompt-cache（原 lib/prompt-cache.js L1-23）

```js
/**
 * lib/prompt-cache.js —— **两层缓存，必须分开算**。
 *
 * ## 为什么写这个文件（历史教训）
 *   报告 v2 把两件事混成一个指纹函数：
 *     `.update(JSON.stringify(stableSort(workflow)))   // 去掉 client_id / filename_prefix`
 *   然后指望"归一化指纹 → 提交体一致 → ComfyUI 命中缓存"。
 *   **方向是反的**：ComfyUI 的执行缓存键是**提交体的逐字节哈希**。
 *   你把 `client_id` / `filename_prefix` 剔掉再提交，提交体就和上次不一样 ⇒ 缓存键不同 ⇒
 *   ComfyUI 照样重跑。剔字段**只能**用来判断"这个任务我本地做过没有"。
 *
 * ## 所以分成两层
 *   · **本地层（本文件）**：语义指纹（剔 `client_id` / `filename_prefix`，**保留 `seed`**）。
 *     命中 ⇒ **根本不提交**，直接复用上次落盘的文件。省的是整段排队+采样。
 *   · **ComfyUI 层（插件侧零代码）**：提交体一个字都不改（`submitPrompt` 只拼
 *     `{ prompt, client_id }`，`client_id` 固定为进程号）。要 ComfyUI 命中就**别归一化**；
 *     想验证命中，去看它 `/history` 里该 prompt 的 `status` 有没有走执行。
 *
 * ## 边界
 *   · 指纹含 `seed` ⇒ 随机 seed（每次不同）自然永不命中，不会出现"我要重画，它给我旧图"。
 *   · 命中后**每个文件都要真实存在**才复用；任一丢失 ⇒ 视为未命中，照常提交。
 *   · 写盘失败一律吞掉：缓存只是省时间，不该把出图拖成失败。
 */
```


---

### hdr-note-chain-manifest（原 lib/chain-manifest.js L1-22）

```js
/**
 * lib/chain-manifest.js —— 三条链的**统一声明式清单目录**（A1 收口，2026-11-15）。
 *
 * ## 要解决的问题
 *   此前 /workflows 只列 `workflows/*.json` 里的运行时清单（只有 video-wan22），
 *   生图链 / TTS 链虽然各自有 `workflows/contracts/*.contract.json` 与图结构指纹，
 *   却在总览里**只字未提** —— 看起来像「这两条链没清单化」，实际是清单散在
 *   三处、没有统一目录。本模块把它们合成一张可查询、可校验的总账。
 *
 * ## 为什么生图 / TTS 不做运行时清单提交（重要，别在后续改动里抹掉）
 *   生图链按 caps 折 basic/full、按参考图 / 控制图 / 批量分裂十几条分支；
 *   TTS 链的节点名要由 /object_info 在线探测决定。若再造一份 JSON 去「提交」，
 *   就会变成 JS 和 JSON 两边都能跑、两边都会悄悄漂的**半迁移** —— 比不做更糟。
 *   ⇒ 这两条链保持「代码构图 + 契约逐槽位对账 + 指纹锁漂移」，并在本目录里
 *     显式登记为 authoritative=contract。**这是有意的设计决策，不是未完成。**
 *
 * ## 硬规矩
 *   · 纯函数 + 只读 `workflow-manifest.js` / `graph-audit.js` 的目录枚举；
 *   · 不读 npm 包外的 `scripts/` 目录（发布白名单里没有它）；
 *   · 指纹夹具 id 在本模块重复一份，由 scripts/test-chain-manifest.mjs 锁
 *     「与 scripts/workflow-fingerprints.json 逐字相等」（允许重复、强制同步）。
 */
```


---

### hdr-note-hw-route（原 lib/hw-route.js L1-21）

```js
/**
 * lib/hw-route.js —— 加速链的「硬件感知路由」段（0.35.0 之后批次，纯函数零 I/O）。
 *
 * ## 能力（对应落地优先级清单的第 1/3/4 条）
 *   ① GPU 架构判定：从设备名解析 Blackwell(sm_120)/Ada(sm_89)/Ampere(sm_86)/Turing/
 *      Pascal（NVIDIA）与 RDNA3(gfx1100)/RDNA2(gfx1030)/核显（AMD）、Intel Arc。
 *   ② SageAttention 内核变体建议：新卡 FP8 / 老卡 INT8 / A 卡与核显 unsupported
 *      （CUDA 内核不适用）——**建议层**，实际写入仍走 attention-workflow 的
 *      「宿主声明优先 + 已核实槽位」纪律，未核实槽位绝不写。
 *   ③ 量化内核感知提示：量化档位（GGUF/INT8/FP8）在本机是「真提速」还是
 *      「仅省显存」——保守默认：A 卡（ROCm）按 memory-only 提示，N 卡 unverified
 *      （内核在位与否无法经 HTTP 探测，绝不承诺提速）。
 *   ④ stable-fast 明确跳过声明（停更 / 低显存失效 / 被 Comfy-WaveSpeed 取代）。
 *
 * ## 与既有实现的边界
 *   · comfy-launch 有自己的启动代际判定（nvidiaGenOf，决定 --use-sage-attention 与
 *     崩溃回退）——本模块是**报告层**，不改启动行为、不改节点写入策略。
 *   · reset 语义：图内节点按每次生成插拔（非全局 Monkey Patch），关闭后下一次
 *     生成自然不带；启动级开关的回退已由 comfy-launch 自动禁用处理。
 *   · 所有建议 unverified（未在本机实测），绝不写倍率。
 */
```


---

### hdr-note-config-consistency（原 lib/config-consistency.js L1-20）

```js
/**
 * lib/config-consistency.js —— 配置项矛盾的「唯一裁决 + 可检测」层。
 *
 * 0.32.1 之后审计确认的几处易误解点（都是实读源码得到的，不是猜测）：
 *   ① schema-defaults.js 里 teSpeedEnabled / speedupEnabled / blockCacheEnabled
 *      三个默认全 true，但 config.js::pickWrapperSet 按尺寸/策略**只选一组**。
 *      ⇒ 三个开关是「候选允许位」，不是「三个同时生效」。
 *   ② 显存档集合不一：config.js::VRAM_MODES 与 perf-presets.js::VRAM_CHOICES 是六档，
 *      vram-strategy.js::MODE_LADDER 只有四档，pickVramMode 也不产出 standard/cpu。
 *      ⇒ 六档是**完整枚举**，四档是**降级阶梯**，两者不是同一概念，但过去没写清。
 *   ③ 同名 `ram` 语义相反：CACHE_CHOICES.ram 指「缓存驻留显存(GPU 侧)」，
 *      VRAM_CHOICES.ram / MODE_LADDER.ram 指「权重放内存(CPU 侧)」。
 *      ⇒ 键名保留以兼容既有配置与前端，语义用本文件显式区分。
 *   ④ steps 默认 8（蒸馏链）与 25（原生回退）语境不同，不是同一个默认值。
 *   ⑤ TTS 落盘前缀在不同文件里出现三套写法；本文件给出 canonical 口径，
 *      但**不强行改写既有落盘目录**（改了会让历史产物路径失效）。
 *
 * 本模块不改任何既有函数行为，只提供裁决、归一与人类可读的冲突清单，
 * 供 doctor / 端点 / Agent 读取。
 */
```


---

### hdr-note-event-log（原 lib/event-log.js L1-26）

```js
/**
 * lib/event-log.js —— 结构化事件日志（JSON Lines）的落盘层 + 本机端点。
 *
 * ★ 2026-11-14 全面排查补齐：lib/structured-log.js 原本只在 accel-chain.js
 *   里往**内存数组**写一条加速链快照，既没落盘、也没接真实生成事件，
 *   用户要求的「记录每次生成的尺寸 / 加速链 / 降级原因 / 耗时分解」等于没实现。
 *   本模块补上：落盘到出图目录、可按本机端点查询与统计、有大小轮转。
 *
 * 隐私红线（继承 structured-log.js）：
 *   · 所有字符串过 sanitizeReason；prompt 只留 sha256 前 12 位；
 *   · 文件路径绝不进日志、也绝不进任何响应（响应只给相对文件名都不给）；
 *   · 不写用户提供的加速倍率 / RTF / 毫秒数（那些是 unverified 资料）。
 *
 * 落盘策略：
 *   · 文件固定在出图目录内：.qwen-paint-events.jsonl；
 *   · 超过上限只轮转成 .1（重命名自己的文件，不删用户任何文件）；
 *   · 写入失败只记本机日志并回固定文案，绝不影响出图主链路。
 *
 * 诚实边界（★ 2026-11-15 已推进一档）：
 *   插件侧现在**自动写入两类事件** —— 「加速链快照」+「每次生成完成」。
 *   后者由 lib/history-store.js 的生成完成钩子上报，覆盖 draw 详细版与
 *   onProduced 兜底版全部生成路径，带**本机实测总耗时**与尺寸 / 工具 / 种子。
 *   但 queue / load / sample / decode 四段细分耗时主链路没有打点，日志里保持
 *   null（绝不编造）；要补细分只能由宿主在生成完成时 POST /api/qwen-paint/events
 *   上报，或将来在生成主链路里加计时点。
 */
```


---

### hdr-note-media-formats（原 lib/media-formats.js L1-24）

```js
/**
 * lib/media-formats.js —— 媒体格式登记表（唯一真相源）+ ffmpeg 参数构建 + 输出格式预设。
 *
 * ## 用户需求（2026-11-15）
 *   「图片常用 JPG/PNG/WebP；视频常用 MP4/MKV/MOV/WebM；音频常用 MP3/AAC/WAV/FLAC。
 *     生成的图片视频音频可以指定或转换成我上面所说的格式，也支持动图转视频，
 *     也支持用户自己的各种图片以及视频音频转换格式；这些功能也要支持 agent 调用。」
 *
 * ## 诚实边界（★ 不许越线）
 *   · 这里只做**纯参数构建**：不解码媒体、不联网、不派生子进程、不碰磁盘。
 *     是否真的落盘由宿主注入的执行器决定（见 lib/media-exec.js）。
 *   · 编码器名（libx264 / libvpx-vp9 / libwebp / libmp3lame / libopus / flac …）是
 *     ffmpeg 的**标准编码器标识**，并不意味着本机 ffmpeg 一定编进去了；
 *     能力端点不许把它们写成「已验证可用」，执行失败要如实回报。
 *   · 有损/无损、透明通道、容器兼容性都标在表里，避免把 PNG→JPG 说成无损。
 *   · 跨媒体类别转换一律拒绝（图片不能转音频、音频不能转视频）；
 *     **唯一例外**是用户点名的「动图 → 视频」，以及动图取首帧 → 静态图。
 *   · 动图转视频：GIF 的循环次数不会自动变成视频时长，默认只转一遍；
 *     想更长时间由 fps / duration / loop_count 显式控制，绝不假装"自动保留循环"。
 *
 * ## 与既有 GIF 能力的分工
 *   `convert_to_gif` 是「图片/视频 → GIF」单向工具，保持不动；
 *   `convert_media` 负责 12 种常用格式之间互转 + 动图 → 视频，两者共用 ffmpeg 执行器。
 */
```


---

### hdr-note-media-fx（原 lib/media-fx.js L1-21）

```js
/**
 * lib/media-fx.js —— 内置最小实现批次（2026-11-16）：三个"生成之后"的本机媒体工具。
 *
 * 设计红线（与 convert_media / av-stitch / pptx-lite 同口径）：
 *   · 全部落本文件一个模块，经 tool-registry.js 单点注册，lib/index.js 零增长；
 *   · 复用 media-exec.js 的 execFile(argv) 执行器与 media-convert-tool.js 的目录围栏，
 *     输入只允许出图目录 / 宿主注入 sourceDirs，输出只允许出图目录，拒绝 .. 穿越；
 *   · 命令是 argv 数组，绝不拼 shell 字符串；数值全部 clamp；
 *   · ffmpeg 未探测到 / 执行失败 → 如实降级，回参数预览 + 固定文案，不回吐 error.message
 *     （可能含本机绝对路径），不谎称已生成；
 *   · 诚实边界写进 description 与端点 note，插件层不做模型级能力。
 *
 * 三个工具：
 *   ① enhance_audio —— 音频后处理：响度归一化(speechnorm/loudnorm) / EQ(equalizer) /
 *      去齿音(deesser) / 去静音(silenceremove) / 降噪(afftdn) / 压缩(compand)。
 *      本机实测 ffmpeg 9.0.2 全部具备；零模型、零外部节点。
 *   ② cutout_image —— 无模型抠图：纯色键控(chromakey/colorkey) + 蒙版合成(alphamerge)。
 *      复杂主体（头发/半透明）仍需 SAM —— 本工具只做纯色背景，如实标注。
 *   ③ split_audio —— 声源分离"可用部分"：ffmpeg pan 中置相消（人声多在中间声道），
 *      得近似伴奏 / 近似人声。零模型；不是 BS-RoFormer 级分离，如实标注。
 */
```


---

### hdr-note-media-postconvert（原 lib/media-postconvert.js L1-23）

```js
/**
 * lib/media-postconvert.js —— 「生成时指定输出格式」的真实接线层。
 *
 * ## 为什么是「生成完成后自动补一次转码」
 *   ComfyUI 的保存节点格式是固定的：SaveImage → PNG、VHS_VideoCombine → mp4/gif、
 *   SaveAudioMP3 → mp3。插件不能让这些节点直接吐 WebP / MKV / FLAC。
 *   所以用户说的「生成的图片视频音频可以指定格式」，诚实的实现是：
 *     生成物落盘 → 生成完成钩子接住 → 按预设自动转一份目标格式（**原产物保留**）。
 *   绝不写成「生成时直接指定格式」来误导。
 *
 * ## 接线方式（零 index.js 改动）
 *   lib/history-store.js::record() 是**所有生成路径的统一出口**，会调一次
 *   模块级 generationLogHook。lib/event-log.js 已经用它写结构化日志（单实例钩子）。
 *   这里不覆盖、不替换，而是用 composeGenerationHook 把「日志消费」与
 *   「自动后转码消费」组合成一个钩子，两者互不干扰、任一抛错都不影响出图。
 *
 * ## 硬边界
 *   · 没有设置任何输出格式预设时，本层**零 I/O、零分配**（不改变既有行为）；
 *   · 后转码 fire-and-forget：绝不 await、绝不阻塞生成主链路；
 *   · 探测不到 ffmpeg / 转换失败 → 如实写一条降级事件，不假装成功、不删原产物；
 *   · 输出名带 _converted 且不会写回历史库，避免生成 → 转换 → 再记录的循环；
 *   · 路径绝不进结构化日志（沿用 structured-log.js 的消毒闸门）。
 */
```


---

### hdr-note-attention-workflow（原 lib/attention-workflow.js L1-22）

```js
/**
 * lib/attention-workflow.js —— 把注意力 / 编译加速后端**接进真实工作流**。
 *
 * ★ 用户要求（2026-11-15）：SageAttention / Comfy-WaveSpeed 不做成孤立端点，
 *   要并进 0.33.0 已有的加速链，并且在生成工作流里真的用上。
 *
 * ## 诚实边界（不要在后续改动里抹掉）
 *   · 节点类名**只来自**入参 installed（真实 /object_info 节点表）经 nodePattern
 *     模式发现得到的候选项；绝不硬编码任何第三方节点类名。
 *   · 节点输入槽位：**优先**用宿主显式声明的 `acceptedInputs`；宿主没声明时
 *     回退到后端注册表里**经真机 /object_info 核实过**的槽位（`slotsVerified`），
 *     再叠加后端的保守默认值（如 WaveSpeed 的 `residual_diff_threshold`）。
 *     ⚠ 为什么必须有这个回退：`ApplyFBCacheOnModel` 的 `residual_diff_threshold`
 *     默认是 0，而节点自己注明「0 = 关闭缓存」⇒ 只写 model 会插进一个**静默无效**
 *     的节点，用户以为开了加速其实没有。槽位真的一个都没有时才标
 *     `needsSlotMapping: true` + `unverified: true`，绝不假装参数已核实。
 *   · **默认零节点**：`enabled` 为空时返回 nodes:[]，调用方的模型链逐字节不变。
 *     只有宿主显式指定后端 id、且该后端在节点表里被探测到，才会插入节点。
 *   · 用户资料里的相对倍率一律 unverified，不进代码、不进结论。
 *
 * 纯函数、零 I/O：不联网、不读文件、不派生进程、不改入参。
 */
```


---

### hdr-note-orphan-extras（原 lib/orphan-extras.js L1-23）

```js
/**
 * lib/orphan-extras.js —— 把三个"写了但没接进主链路"的模块接上。
 *
 *   ① entry-alias.js     口语入口别名（「风格卡」「批量出图」…）→ 真实工具名 + 预置参数
 *   ② color-tone.js      参考图主色调提取（纯像素 → 可写进提示词的一句话）
 *   ③ creative-chain.js  创作编排四件：产出短引用 / 时间轴骨架 / 资源需求声明 / 数据流摘要
 *
 * ## 为什么单独一个文件
 *   lib/index.js 贴着 DSH Store 的 262144 B 单文件上限（余量 3,746 B），
 *   所以一律走 lib/tool-registry.js 的外置注册层，index.js 零增长。
 *
 * ## 诚实边界（每条都有断言）
 *   · 色调只做**色调**，不猜构图 / 光影 / 材质 —— 那些需要视觉模型或 IP-Adapter，
 *     本插件不引额外权重，也不假装能从像素里"看懂"画面。
 *   · 时间轴是**建议结构**不是硬约束；有配音时必须改用真实音频时长排轴，两者不可混用。
 *   · 资源需求**不给编造的秒数**：没有本机同类实测就返回 null 并说明原因。
 *   · 数据流摘要的 external_network 是**算出来的**，不是写死的 false。
 *   · 别名只能指向已注册工具，指错必须报错，不新增"影子工具"。
 *
 * ## 安全
 *   端点只放行本机请求；写操作要求 POST + guardWriteRequest；像素数组有界；
 *   异常只写本机日志、回固定文案，绝不回吐 error.message。
 */
```


---

### hdr-note-file-route（原 lib/file-route.js L1-23）

```js
/**
 * lib/file-route.js —— 插件自己的**媒体字节路由** `/api/qwen-paint/file`。
 *
 * ## 为什么需要它
 *   内核 `/api/file?path=…` 只服务"**已登记**"的文件（deliverables）。
 *   `draw_image` 的产物走 `tools/result` 钩子登记，所以能显示；
 *   而**面板圈选重绘 / 图片编辑台 / 视频选帧**都是直接 `execute()` 出来的、没有登记
 *   ⇒ 用 `api/file?path=` 看结果，大概率是裂图（"图片无法预览"）。
 *   ✓ 正解：插件自己吐字节 —— 只服务 **outputDir 之内**的文件（路径包含检查），
 *     不依赖登记，也绕开了内核那道门。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 已贴着 DSH Store 的 256 KB 单文件上限（selftest.mjs 有硬断言）。
 *   这段是**自包含**的（只要 isLocalRequest / respondJson / cfg），外置零风险。
 *
 * ## 安全边界
 *   · 只收 GET / HEAD；只服务本机请求；
 *   · 路径解析后**必须仍落在 outputDir 内**（挡掉 `..` 穿越）；
 *   · 先 `stat` 再读：不是文件 → 404；超过 512 MB → 413（不再无脑 readFile 把内存吃光）；
 *   · `x-content-type-options: nosniff` + 未知扩展名回落 octet-stream：
 *     出图目录里万一混进 `.html` / `.svg`，也只会被**下载**，不会被当页面执行；
 *   · `content-security-policy: default-src 'none'; sandbox` 再兜一层。
 */
```


---

### hdr-note-ui-edit-endpoints（原 lib/ui-edit-endpoints.js L1-22）

```js
/**
 * lib/ui-edit-endpoints.js —— 「图片编辑台」的本机 HTTP 端点。
 *
 * ## 为什么存在
 *   插件早就有 inpaint_image / remove_image / outpaint_image / upscale_image 四个工具，
 *   也有完整的圈选蒙版浮层，但**只有局部重绘**接到了 UI 端点；其余三个只能靠用户在
 *   对话里让 AI 调工具 —— 用户根本不知道有这些功能，更不知道参数怎么填。
 *   本模块把「移除 / 扩图 / 放大」也接成 UI 可直接调用的端点，并给出「最近生成的图」
 *   列表，让「选中一张图」这一步不依赖猜路径。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 已逼近 DSH Store 的 256 KB 单文件上限（selftest.mjs 有硬断言），
 *   新端点一律外置，host 只负责注入依赖与注册。
 *
 * ## 安全边界（与既有 /api/qwen-paint/inpaint 完全一致，不引入更宽松的口径）
 *   · 顶层 isLocalRequest 可信围栏在任何动作之前；POST only + guardWriteRequest；
 *   · body 走有界 readJsonBody；
 *   · 蒙版只接受 data:image/png;base64, 且 ≤ 24 MB，防「任意文件写入」；
 *   · 一次性蒙版用完即删（finally），不在出图目录堆垃圾；
 *   · 工具未注册返回 503；百分比 / 倍数一律 clamp，不接受任意数值；
 *   · 只调本机工具 execute()，不自行下载任何东西、不发起外部请求。
 */
```


---

### hdr-note-workflow-fingerprint（原 lib/workflow-fingerprint.js L1-23）

```js
/**
 * lib/workflow-fingerprint.js —— A1 的最后一层护栏：图结构指纹。
 *
 * ★★ 为什么生图链 / TTS 链**没有**像视频链那样改成运行时清单：
 *   视频链是单分支的（一个 `Wan22ImageToVideoLatent` + 若干条件补丁），
 *   清单能一比一表达。
 *   生图链不是这样：它按 caps 折成 basic/full，按「有没有参考图/控制图/批量」
 *   分裂出十几条分支，还夹着 turbo LoRA、TE-Speed、前缀缓存的可选节点。
 *   硬把它塞进当前这套「主图 + 条件补丁」的 schema，要么表达不了，
 *   要么得给 schema 加一层"脚本"，那清单就不再是清单了。
 *   **半迁移比不迁移更危险**：两边都能跑，两边都会漂。
 *
 *   所以这里换一道更便宜、也更硬的护栏：**图结构指纹**。
 *   每次跑固定夹具，把产出的节点图做稳定序列化再算 sha256，与仓库里
 *   记录下来的一串指纹比对。图只要变了（多一个节点、改一个常量、少一个连线）
 *   就当场红，并指出第一个差异路径。
 *
 *   这抓住了清单化真正想要的东西 —— **图不是悄悄变的**，
 *   而没有付出"把复杂分支硬塞进 schema"的代价。
 *
 * ★ 指纹只存哈希，不存整张图：既不会把本机路径/权重名带进仓库，
 *   也不会因为格式化差异产生噪音。
 */
```


---

### hdr-note-cache-backends（原 lib/cache-backends.js L1-18）

```js
/**
 * lib/cache-backends.js —— 生图 / 视频链路的缓存与跳步后端统一注册表。
 *
 * ★ 诚实边界（很重要，别在后续改动里抹掉）：
 *   · `kv_prefix` 是项目**已有实现**（lib/model-chain.js 的 prefixCacheNode / QwenImage21Cache）；
 *   · teacache / fbcache / magcache / easycache 目前只是「能力名称」，
 *     是否可用**必须**由调用方传入的 installed 集合（来自 ComfyUI /object_info 探测）决定；
 *     TeaCache 到现在只出现在 lib/workflow-ast.js 的识别正则里，没有装配实现；
 *   · `mrfow` 是用户提到的术语。2026-11-15 公开检索的**唯一高相关命中**是
 *     MrFlow（Multi-Resolution Flow Matching，多分辨率流匹配，arXiv 2607.01642），
 *     面向 Qwen-Image / FLUX.1-dev 的免训练多分辨率加速，与「为生图/视频加速」语境吻合；
 *     `mrfow` 与 `MrFlow` 仅字母换位。**但这只是候选，未经用户确认**，故仍标
 *     `term-unverified` 且**永不自动启用**。社区给出的倍率一律是「其它模型、未经
 *     本机实测、不可比」，本模块不引用、不写入任何结论（见 TERM_CANDIDATES）。
 *   · 用户资料里的加速倍率一概是 unverified，本模块不引用、不写入任何结论。
 *
 * 纯函数、零 I/O：所有「有没有装」的判断都来自入参。
 */
```


---

### hdr-note-video-frames-endpoints（原 lib/video-frames-endpoints.js L1-23）

```js
/**
 * lib/video-frames-endpoints.js —— 视频选帧 / 时间段截取的**本机 HTTP 端点**。
 *
 * ## 为什么存在
 *   用户要的是"像剪辑软件那样，自己选帧去改 / 自己选一段时间截出来"。
 *   插件原来只有 `generate_video`，产物是一整个 mp4，用户既改不了中间某一帧，
 *   也切不出其中一段。
 *
 * ## 两条路，优先走**不需要 ffmpeg** 的那条
 *   · `POST /frame-save`：浏览器 `<video>` + `<canvas>` 已经把帧画出来了，
 *     这里只负责把 PNG 落盘。**零外部依赖**，用户机器上没有 ffmpeg 也能用。
 *   · `POST /frame` / `POST /clip` / `POST /replace-frame` / `GET /probe`：需要 ffmpeg / ffprobe。
 *     找不到就**如实返回 `needFfmpeg: true`**，绝不假装成功。
 *
 * ## 安全边界（与其它本机端点同一口径）
 *   · 顶层 `isLocalRequest` 可信围栏；POST only + `guardWriteRequest`；
 *   · body 走有界 `readJsonBody`；
 *   · **所有**输入视频路径必须是 `outputDir` 内的文件（`assertInsideOutput`），
 *     防止把任意本机文件当视频喂给 ffmpeg；
 *   · 只用 `execFile` 传 argv 数组，**不拼 shell 字符串**（无注入面）；
 *   · 产物一律写进 `outputDir`，文件名由时间戳生成，不含原视频名；
 *   · 不发起任何网络请求、不下载任何东西。
 */
```


---

### hdr-note-workflow-passes（原 lib/workflow-passes.js L1-25）

```js
/**
 * lib/workflow-passes.js —— 工作流 AST 的 pass 管线（**入口深拷贝，原 AST 不动**）。
 *
 * ## 它修的是什么
 *   报告 v2 的 `runPasses` 写着：
 *     export function runPasses(ast, passes, ctx) {
 *       let cur = ast                     // ← 直接拿原引用
 *       for (const pass of passes) { const r = pass(cur, ctx); cur = r.ast }
 *     }
 *   注释却写「不改原对象，便于 diff 与回滚」。实际上 `SlotBindPass` 里 `n.inputs[k] = v`
 *   改的就是传进来的那个 AST ⇒ **原 AST 已经被改脏**，等 emit 前再想 diff 原始版，
 *   拿到的两边都是改后的，"回滚"无从谈起。
 *   ⇒ 这里 `runPasses` 入口先 `structuredClone`，并**同时**留一份 `rawAst` 快照：
 *     pass 只改副本，`rawAst` 只读，回滚/对比都基于它。
 *
 * ## pass 契约
 *   `pass(ast, ctx) → { ast, changes }`
 *   · 必须返回 `ast`（可以是同一个对象，也可以是新对象）；
 *   · `changes` 是**声明式**的改动清单：`{ node, input, before, after }`，
 *     由 runPasses 统一加上 `pass` 名 —— 这样"谁改了哪一格"永远可追溯。
 *
 * ## 为什么不在 pass 里自己深拷贝
 *   每个 pass 都拷一次 = N 副本、N 倍内存，且"哪个才是原文"更糊涂。
 *   只在**入口**拷一次，语义清楚。
 */
```

## backend-note-tts-workflow-dialogue（多角色对话链，2026-11-19）

### 节点事实（本机 custom_nodes/ComfyUI-Qwen-TTS/nodes.py 白纸黑字，非猜）
- `FB_Qwen3TTSVoiceClonePrompt`：required `ref_audio(AUDIO)`+`ref_text`+`model_choice(0.6B/1.7B)`+
  `device`+`precision`+`attention`，optional `x_vector_only`/`unload_model_after_generate`
  → `VOICE_CLONE_PROMPT`。
- `FB_Qwen3TTSRoleBank`：optional `role_name_1..8` + `prompt_1..8` → `QWEN3_ROLE_BANK`
  （**上限 8 角色**；名字非空且有 prompt 才入银行）。
- `FB_Qwen3TTSDialogueInference`：required `script`（`角色名: 台词` 每行）+ `role_bank` +
  五个停顿旋钮（linebreak/period/comma/question/hyphen）+ `merge_outputs`/`batch_size`
  → `AUDIO`（接 SaveAudioMP3/SaveAudio）。**脚本行解析先试半角 `:` 再试全角 `：`**
  （nodes.py:1241-1243）；**角色名对不上 bank 的行被静默跳过**，全跳光时报
  "No valid dialogue lines found matching Role Bank"。

### 为什么刻意不放进 TTS_FALLBACK_CHAINS
与 VoiceClone 同理：必须先上传各角色参考音频才能构造，混进自动兜底会在
「用户没给参考音频」时被选中 → 探测放行、构造失败。

### buildDialogueWorkflow 的先验纪律
- 角色表先验：非空、唯一、都带 referenceFile（uploadRefAudio 产物），1..8 个；
- **脚本行角色名提前对账**：对不上的行在插件侧明确报错（列出错行+已知角色），绝不放进
  ComfyUI 让它静默跳过；
- 每个角色一条 VoiceClonePrompt：referenceText 给了就精确对齐（x_vector_only=false），
  没给只取说话人嵌入（x_vector_only=true，同克隆链纪律——空 ref_text 对齐会静默塌质量）；
- attention 只在显式合法值（TTS_ATTENTION_CHOICES）时写入，默认不写 ⇒ 节点 auto（零漂移）；
- batch_size 钳制 1..32（节点上限）；pauses 未覆盖的键保持节点默认值；
- 驻留记账与克隆链同款（ttsResidency）。
