# dsh-qwen-paint · (绘图)千问（优化版）

面向 **DeepSeek Harness** 的本地图像生成插件。经由本机 **ComfyUI** 调用 **Qwen-Image 2.1** 模型，  
在对话中直接完成文生图与图生图；生成的图像落盘保存，并在会话界面内直接呈现。

插件的全部网络流量限于本机回环地址（`127.0.0.1`），**不依赖外部网络，无需任何 API 密钥，亦不产生调用费用**。

> **原作者**：@奇迹与你（<https://github.com/wonderandyou/dsh-qwen-paint>）  
> **优化版作者**：@yanfei0725（<https://github.com/yanfei0725/dsh-qwen-paint>）　｜　**许可协议**：MIT　｜　**当前版本**：`0.1.4`

---

## 优化版说明

本版在**不改变输出画质**的前提下，围绕推理性能、显卡适配与平台兼容三个方向对插件进行了系统性增强。

### 一、推理链路性能

1. **按输出尺寸自动选择加速方案。**  
   三个加速组件（TE-Speed、Speedup、BlockCache T8）需独占同一组模型包装器，同一时刻仅能启用其一。  
   本版依据本次生成的实际尺寸自动切换：小尺寸（≤1024²）采用 TE-Speed 与 Speedup（实测 **+25.4%**）；  
   大尺寸（如 1408²）改用 BlockCache T8（实测 **+22.7%**，约节省 27.4 秒）。  
   该策略基于实测结论——在 1408² 下 TE-Speed 命中率为 **0%**、Speedup 仅 **12.5%**，却占用互斥资源。
2. **编排阶段并发化。**  
   提交任务前的队列查询、参考图上传与后端能力探测三项操作改为并发执行；  
   结果轮询间隔由 1200 ms 缩短至 **400 ms**；后端就绪后立即预热能力探测。
3. **显存驻留策略自动化。**  
   依据显存总量自动确定启动参数：≥24 GB 全量驻留；16–24 GB 采用 `--highvram` 并保留少量余量；  
   <16 GB 不启用驻留参数以规避显存溢出。此举显著减少约 13.5 GB 模型权重的反复装卸开销。
4. **接入 RDNA3 FlashAttention。**  
   将已安装但未被引用的 RDNA3-Flash-Attention 节点接入模型链末端。该实现为精确注意力，不改变计算语义。
5. **支持单次批量生成。**  
   新增 `count` 参数（1–4），一次提交可生成多张图像，模型权重仅加载一次；默认值仍为 1，原有行为不变。

### 二、显卡厂商适配

插件以**加权评分**方式识别显卡型号与代系（明确型号优先于泛化厂商名，独立显卡优先于核显），  
并为每一类硬件指定相应的注意力后端与可选加速组件：

| 厂商                 | 识别依据                          | 注意力后端                           | 可选加速组件                                    |
| ------------------ | ----------------------------- | ------------------------------- | ----------------------------------------- |
| NVIDIA             | `GeForce` / `RTX` / `A100` 等  | `--use-pytorch-cross-attention` | Triton for Windows、SageAttention、Nunchaku |
| Intel Arc          | `Arc.*B\d{3}` / `Arc.*A\d{3}` | `--use-pytorch-cross-attention` | IPEX                                      |
| AMD RDNA3（RX 7000） | `Radeon RX 7xxx`              | `--use-quad-cross-attention`    | A 卡专属内核（可选）、异步卸载（可选）                      |
| AMD RDNA4（RX 9000） | `Radeon RX 9xxx`              | `--use-pytorch-cross-attention` | A 卡专属内核（可选）、异步卸载（可选）                      |
| AMD RDNA2（RX 6000） | `Radeon RX 6xxx`              | `--use-pytorch-cross-attention` | A 卡专属内核（可选）、异步卸载（可选）                      |
| Apple Silicon ★      | `Apple M1`–`M4`               | 不指定（PyTorch MPS 默认路径）   | 无（MPS 上 CUDA/ROCm 那套都不适用）                       |

各类硬件的参数与加速组件相互独立，不会交叉套用。

#### A 卡专属优化（可选，默认关）★ 2026-10-11 新增

与 N 卡/I 卡的「厂商专属优化」同一套思路：**只在适用的显卡上、在优化面板里出现**，  
**默认关闭**，由你自己决定要不要开。两项都是**质量中性**的 —— 换的是后端 / 加载时机，  
**不改任何计算结果，不牺牲原生画质**。

| 开关          | 作用                | 按代系给什么                                                                                                  |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| **A 卡专属内核** | 换用本代的替代注意力内核      | 6000 → `--use-quad-cross-attention`；7000 / 9000 → `--use-ck-attention`                                  |
| **A 卡异步卸载** | `--async-offload` | ComfyUI 的 help 原文写着它 *"Enabled by default on Nvidia"* —— 即 **N 卡默认开、A 卡默认关**，这里给 A 卡补上（只改权重加载的时机，与计算重叠） |

> ⚠ 两个都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效（面板提示里也写了）。  
> ⚠ 6000 / 9000 我们**没有硬件实测**，所以一律默认关 —— 属可选档，不合适就关回去。  
> ⚠ 也**不会**因为默认关而把面板显示成"优化部分启用"：它们被标记为**可选**，  
> 单独计入总账的「N 项可选（默认关）」。  
> 想永久生效：把 `amdKernel` / `amdAsyncOffload` 写进 `cordis.patch.yml`（面板开关是内存态）。

### 三、操作系统兼容

启动、停止、进程存活查询与显卡探测均按平台分别实现：

- **Windows**：经 WMI 派生进程（宿主重启不会连带终止 ComfyUI），显卡信息取自 PowerShell；
- **Linux**：以 `setsid` / `nohup` 脱离会话，显卡信息取自 `nvidia-smi` / `rocm-smi` / `lspci` 及 `/sys`；
- **macOS（Apple Silicon）★ 2026-10-11 新增**：显卡信息取自 `system_profiler` / `sysctl`，
  进程脱离会话**先探测 `setsid` 是否存在**（**macOS 没有这个命令**），没有就退回 `nohup`。

#### macOS 怎么用

ComfyUI 官方对 Apple Silicon（M1–M4）**只提供手动安装**（没有便携包），所以：

1. 装 **pytorch nightly** —— 按 Apple 的 Metal 加速指南：<https://developer.apple.com/metal/pytorch/>
2. 按 ComfyUI 官方「Manual Installation」装依赖
3. 启动：`python main.py` —— **官方没有 Mac 专属启动参数**，直接跑即可

然后 `node scripts/setup.mjs --comfy <你的 ComfyUI 目录>` 就能继续「下模型 + 挂插件」两步。
（插件**不会**替 macOS 用户去下 Windows 便携包。）

> ⚠ 插件在 Apple Silicon 上**不加任何 CUDA / ROCm 专用内核参数**
> （`--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention` 在 MPS 上都不适用）。
> ⚠ **统一内存没有独立显存** ⇒ `--highvram` / `--reserve-vram` 这套驻留参数**显式跳过**，
> 面板会如实说明"不适用于统一内存"。
> ⚠ 官方文档**没有提 Intel Mac**（老 Intel 机型 + 核显基本跑不动）。

### 四、可运维性

- 面板与工具如实报告每一项优化的真实状态（已启用 / 可启用 / 不可启用 / 按尺寸让位）。
- 随附 **20 套**回归测试，覆盖三厂商判定、**三平台**分支（Windows / Linux / macOS）、工作流接线、取消与超时、可移植性及打包完整性。

---

## 它是什么

一个 **DSH 插件（host + client 两半）**，注册一个工具：

| 工具                      | 作用                                                             |
| ----------------------- | -------------------------------------------------------------- |
| `draw_image`            | 按提示词调本机 ComfyUI 出图，成品落盘到「千问1生图」，并把绝对路径回给助手用于内联显示               |
| `list_available_models` | 列出 ComfyUI 磁盘上真实存在的模型文件（UNET / CLIP / VAE / LoRA / Checkpoint） |
| `check_acceleration`    | 检查加速环境：识别显卡厂商/代系、当前注意力后端、通用优化与厂商专用包的就位情况（`install` 动作可按白名单安装）  |

- **host 半边**（`lib/index.js`）：注册工具、**空闲 5 分钟自动关停 ComfyUI**、挂**只读状态端点**。
- **client 半边**（`lib/client.js`）：给 `draw_image` 一张**自绘卡片**（图直接显示在工具行里）、  
  在 **composer 下方**显示 ComfyUI 在线状态。

不改 DSH 安装目录、不改内核文件。

## 自动适配（大概率你什么都不用配）

1. **ComfyUI 装在哪** —— 自动探测，三级回落：  
   ① 配置里填了就用；② 从**正在运行的** ComfyUI 进程反查；  
   ③ 扫常见位置 + **各盘根目录下名字含 `comfy` 的目录**（覆盖 `ComfyUI-rocm` 这类改名安装）。
2. **显卡厂商 / 代系** —— 自动识别并套用对应优化。用的是**打分制**：  
   明确型号 > 泛化厂商名 > 核显，所以"核显 + 独显"混装也能选对独显。
   | 识别结果                              | 判定依据                | 注意力后端                                          |
   | --------------------------------- | ------------------- | ---------------------------------------------- |
   | AMD RDNA3（RX 7000 系 / gfx11xx）    | `Radeon RX 7xxx`    | `--use-quad-cross-attention`（实测 +15%）          |
   | AMD RDNA4（RX 9000 系 / gfx120x）    | `Radeon RX 9xxx`    | `--use-pytorch-cross-attention`（CK SDPA 专用内核）  |
   | AMD RDNA2（RX 6000 系 / gfx103x）    | `Radeon RX 6xxx`    | `--use-pytorch-cross-attention`（该代无融合内核，走保守路径） |
   | NVIDIA（CUDA，通用）                   | `GeForce` / `RTX` 等 | `--use-pytorch-cross-attention`                |
   | Intel Arc B 系（B580 / B570）        | `Arc.*B\d{3}`       | `--use-pytorch-cross-attention`（XPU + IPEX）    |
   | Intel Arc A 系（A770 / A750 / A580） | `Arc.*A\d{3}`       | `--use-pytorch-cross-attention`（XPU + IPEX）    |
   | 认不出                               | —                   | **不加任何参数**（宁可少点性能，也要保证能起来）                     |
3. **有哪些节点 / 模型文件** —— 出图前探测一次，缺哪个就跳过哪个（结果缓存 10 分钟）。
4. **模型文件名** —— 模糊匹配：int8 / fp8 / bf16 等不同量化版都能认出来。

想看当前判定结果：对助手说「**检查一下加速环境**」，会调 `check_acceleration` 返回  
识别到的显卡、采用的参数、通用优化与厂商专用包的就位情况。

## 界面上的优化状态

装完之后，**ComfyUI 状态点右边**会有一个小徽标，一眼看出优化到底有没有生效：

| 徽标       | 含义                                           |
| -------- | -------------------------------------------- |
| `优化已启用`  | 全部生效（8 步 / CFG 1.0 全栈链路）                     |
| `优化部分启用` | 有 turbo8 但缺某一环 —— **点开看缺了什么**                |
| `未启用优化`  | 没 turbo8，回退 25 步原生链路（慢，但一定能出图）—— **点开看该怎么办** |
| `优化未确认`  | 探测失败（**这不代表缺件**，出图时会重新探测）                    |
| `插件已停用`  | `enabled=false` —— 点开看怎么恢复                   |

橙色/灰色的徽标**可以点**，会弹出逐项明细和**能直接照做的原因**，比如：

> · 未启用：没在 ComfyUI 的 `loras` 目录里找到 turbo8 LoRA（当前回落的文件名是  
> 「turbo8_lora_step2500.safetensors」，看起来并不存在）。把它放进 `models\loras` 即可。  
> · 未启用：ComfyUI 里没有 `QwenImage21Cache` 节点 —— 通常是 **ComfyUI 版本偏旧**，升级即可。

面板里还有三类信息，都值得留意：

- **关键缺口提醒**（橙色块，置顶）—— 例如「配了 GGUF 主模型但没装 ComfyUI-GGUF 节点」。
  这类问题**会让出图直接被 ComfyUI 拒收**，所以**任何时候都会显示**（不像"未启用"只在缺件时出现）。
- **总账**：`共 N 项：… · M 项可选（默认关 / 已开 K 项）` —— **可选档**单独一档，
  不会因为"默认关"而被算成"还差几项没配好"。
- **按显卡隐藏**：识别到你的显卡后，**不适用的优化会直接不显示**，
  并在面板上说明「已按显卡识别隐藏 N 项（显卡名）：…」—— 比如 N 卡上不会出现 AMD RDNA3 的项。

想了解更完整的细节，可以直接让助手调用 `check_acceleration` 工具。

## 生图意图判定与启用开关

### `drawTrigger` —— 模型多主动地判断你想不想画图

| 档位         | 行为                                    | 适合        |
| ---------- | ------------------------------------- | --------- |
| `off`      | 不做主动引导，只在**直接点名**要画图时才画               | 想要个安静工具的人 |
| `strict`   | 只在**明确要求**且**描述具体**时才画；模糊的**先问一句**    | 怕误触发的人    |
| `auto`（默认） | 判断是生图请求就画；但**排除**流程图/表格这类场景，那种**先确认** | 大多数人      |
| `eager`    | 只要沾边就画（最积极）                           | 确定只用它画图的人 |

四档都内置了**边界规则**：像「画个流程图 / 思维导图 / 表格 / 架构图」这种  
看着像生图、实际该用文字或其它工具的请求，会**先确认一句**而不是直接画。  
**判断不准时宁可先问一句，也不要画错。**

> 无论哪一档，都不会在你**没有**生图意图时去调工具 —— 最松的 `eager` 也只是"沾边就画"。

### `enabled` —— 插件总开关

设为 `false` 时，插件对 DSH 相当&#x4E8E;**"不存在"**：不注册 `draw_image`、不注入任何提示词、  
不预热 ComfyUI、不做空闲关停。

但**保留** `check_acceleration` / `list_available_models` 两个**诊断类**工具（只读、不画图）  
—— 否则关掉之后真出了问题，连查都没法查。

## 跨平台与下载兜底

**支持 Windows 与 Linux**。显卡识别、ComfyUI 路径探测、进程查找都各有两套实现，  
按平台自动选用：

|             | Windows                     | Linux                                                        |
| ----------- | --------------------------- | ------------------------------------------------------------ |
| 执行命令        | PowerShell                  | `sh -c`（POSIX，不假设有 bash）                                     |
| 取显卡信息       | WMI `Win32_VideoController` | `nvidia-smi` → `rocm-smi` → `lspci` → `/sys/class/drm`（四级回落） |
| ComfyUI 解释器 | `venv\Scripts\python.exe`   | `venv/bin/python`                                            |

厂商专用加速包是**多源下载**的 —— 每个包 5 套候选，一套不通**自动顶上**下一套：

```
PyPI 官方源 → 清华 TUNA 镜像 → 阿里云镜像 → 腾讯云镜像 → GitHub 源码直装
```

（为防卡住，pip 统一带 `--timeout 15 --retries 1`，让"连不上"快速失败并切源；  
装了哪一套会记在返回值里，方便排查。）

> 包里**只带这套"下载器"，不预置任何已下载的文件** —— 所以本包只有 ~500 KB。

### 内置兜底：下载全失败也能画图

加速件全是**锦上添花**，缺了只会慢，**不会不可用**。把加速全部拿掉后，  
插件产出的工作流会退化成只用 ComfyUI 原生节点：

```
UNETLoader → CLIPLoader → VAELoader → TextEncodeQwenImage21
           → EmptyLatentImage → KSampler(25 步 / CFG 2.5) → VAEDecode → SaveImage
```

**只依赖 ComfyUI 本体 + 千问模型本身**，一个下载来的组件都不需要。

## 依赖

- **ComfyUI** 跑在 `127.0.0.1:8188`（自己手动启动 or 让插件按需后台拉起；安装位置自动探测）
- 三个千问模型文件（共约 13.3 GB）：
  - `qwen_image_2.1_int8_convrot.safetensors`（UNET，放 `models\diffusion_models\`）
  - `qwen3vl_8b_w4a8.safetensors`（CLIP、`type=qwen_image`，放 `models\text_encoders\`）
  - `qwen_image_2.1_vae_bf16.safetensors`（VAE，放 `models\vae\`）
- **不需要**任何 Python 环境、不装任何第三方包 —— 插件本体是纯 Node ESM，**零外部依赖**。

### 默认加速链（★ 2026-10-09 更新：四层叠加，额外三个依赖）

出图**默认**走「turbo8 八步 + TE-Speed 跳步缓存」这条快链，需要额外部件：

| 部件                                 | 放哪                         | 说明                                                                                                                                                            |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turbo8_lora_step2500.safetensors` | `models\loras\`（约 1.36 GB） | 八步蒸馏 LoRA，[chriswritescode/Turbo8-LoRA-Qwen-Image-2.1](https://huggingface.co/chriswritescode/Turbo8-LoRA-Qwen-Image-2.1)                                     |
| `TE-Speed-QwenImage21`             | `custom_nodes\`            | 跳步缓存节点，[tl2012tl/TE-Speed-QwenImage21](https://github.com/tl2012tl/TE-Speed-QwenImage21)（**闭源 `nodes.pyd`**，见下）                                               |
| `ComfyUI-Qwen-Image-2.1-Speedup`   | `custom_nodes\`            | ★ 2026-10-09 新增：步级残差缓存，[frakd/ComfyUI-Qwen-Image-2.1-Speedup](https://github.com/frakd/ComfyUI-Qwen-Image-2.1-Speedup)（**MIT，纯 Python，无闭源件**）。与 TE-Speed 实测可叠 |

另外启动时默认带一个参数：**`--use-quad-cross-attention`**（注意力后端）。  
关掉它见下面「可调项」的 `comfyAttentionBackend`。

**效果**（本机 RX 7900 XT / ComfyUI 0.39.0，1024 档，**每遍换 seed 的稳态值**）：

| 档位                                         | 耗时         | vs 原默认   | 说明                   |
| ------------------------------------------ | ---------- | -------- | -------------------- |
| 原默认：30 步 CFG 2.5                           | 91.6 s     | —        | 基准                   |
| ① turbo8 八步                                | 12.6 s     | −86%     | 大头在这里（采样轴，替换）        |
| ② ① + TE-Speed                             | 10.74 s    | −88%     | 采样层，算子级省 23%         |
| ③ ② + QwenImage21Speedup                   | 9.71 s     | −89.4%   | 采样层第二层，与 TE 实测可叠     |
| **④ 现默认：③ + `--use-quad-cross-attention`** | **8.22 s** | **−91%** | **注意力后端层**，再省 15~17% |

第 ④ 档是 2026-10-09 端到端实测（改动后的默认链路，3 轮丢首轮）：**稳态 8.22 s**。  
`QwenImage21Speedup` 自己的日志会打 `1 cached of 8 model forwards (12.5% skipped)`。

> ⚠ **`--use-quad-cross-attention` 的结论是在本机 RX 7900 XT / gfx1100 / 原生 ROCm 7.2.1 上测的**：  
> 10.739 s → 9.328 s（**+15.1%**，两轮独立复现），满叠栈上 +17.3%，画质无损  
> （同 seed PSNR 39.5/41.4 dB，清晰度 166.3 vs 基线 164.6）。  
> 对照：`--use-pytorch-cross-attention` 是 **−0.3%（无效）**——它本来就是默认路径。  
> 换到 N 卡或别的后端请自己重测，别照抄。

> ⚠ 首张图还要额外 ~12 s 加载模型（20 GB），那是一次性的，不算在这条链的开销里。
>
> ⚠ **测量方法提醒**：上表每遍都换了 seed。若两遍用**完全相同**的 prompt + seed，  
> ComfyUI 会直接回缓存（实测第二遍只花 **0.40 s**），拿那个数字算"加速比"会严重失真  
> —— 我们一度就因此把 TE 的收益误报成 −43%，实际是 **−23%**。
>
> ⚠ TE-Speed 的**整层跳过**在 8 步下其实是 **0 次**（8 步的 t 序列前 3 步被它内置的  
> `window 0.18-1.00` 挡掉，后 5 步的 change 又都超过 0.06 阈值）。它仍然有效是靠  
> 每次调用复用部分 KV/attention 的**算子级**省时。想让它真正"跳步"，得把步数调到  
> 12 步以上（未验证）。

> ✅ **缺件会自动降级，不再"整单硬失败"**（2026-10-09 通用化改造）。  
> 插件出图前会**先探测** ComfyUI 有哪些节点、磁盘上有哪些模型文件，据此自动选一档  
> **可用的最快链路**：LoRA 不在 → 回退 25 步 / CFG 2.5 原生链；TE-Speed / Speedup 没装  
> → 逐个跳过，链子自动接上。**不会再让 ComfyUI 用 `node type not found` 拒收整个任务**。  
> 只有连千问主模型都匹配不到时，才会沿用配置里的文件名去试（那时才看得到 ComfyUI 的原始报错）。  
> 手动退回慢档见「可调项」里的 `turbo8Enabled` / `teSpeedEnabled` / `speedupEnabled`。
>
> 另外，**ComfyUI 装在哪、显卡是哪家、该用哪个注意力后端，都不需要你配置** —— 见下节。

#### prompt 精简（2026-10-09 装上，但先把预期说清楚）

默认会做一次**无损清理**：折叠多余空白/换行、合并连续重复标点、去掉末尾悬挂分隔符。  
语义完全不变，干净 prompt 跑一遍也不变。

**实测上限只有约 4.8%**，而且只对超长 prompt 才有意义（同一条栈只变 prompt）：

| prompt 长度 |      耗时 |
| --------- | ------: |
| 38 字      | 7.821 s |
| 329 字     | 8.088 s |
| 1974 字    | 8.194 s |

即 prompt 从 38 字加到 1974 字（52 倍）也只多花 0.373 s。  
这也顺带证明了：**文本 token 没有被填充到固定长度**（否则长短 prompt 会一样快）。  
交叉复测（clean / dirty 交替各 3 轮）显示差异完全淹没在噪声里 —— **不要指望靠精简 prompt 提速**。

因此 `maxPromptChars`（按字数硬截断）**默认是 0 = 关闭**：它会改变出图，而换来的最多也就那 4.8%。  
真要省时间，去调上面的加速链，别动 prompt。

> **关于闭源 `nodes.pyd`**：TE-Speed 只发 Windows 编译好的 `.pyd`，没有源码。装之前做过静态审查  
> （无网络/exec/子进程/eval/base64 调用，导入期不改任何 ComfyUI 方法；运行时只 monkey-patch  
> `PoseBranchCache.select` 以修 CFG>1 的报错）。**介意闭源就别装它** —— 不装的话 turbo8 单跑  
> 仍有 12.6 s（−86%），只比带 TE 慢 2.9 s。装好之后想临时停用它，见下面 `teSpeedEnabled`。

#### 超分放大 VOSR2（可选，画质/预览层，**默认关**，不进时间账）

VOSR2 是在出图**之后**再插一级 1.4B 单步超分（LightningDiT + 千问 2D VAE + DINOv2-L），  
与上面四层加速链**正交、可叠加**。权重 6.97 GB 已下齐并字节校验通过，部署在  
`ComfyUI\models\vosr2\`。


**2026-10-09 端到端实测（默认加速链 + quad）**：

| 档位    | 做法             |   实测(末轮) | vs 原生       |
| ----- | -------------- | -------: | ----------- |
| 1024² | 原生直出           |   7.74 s | 基准          |
| 1024² | 512² + VOSR2×2 |  45.16 s | 慢 **5.84×** |
| 2048² | 原生直出           |  53.27 s | 基准          |
| 2048² | 512² + VOSR2×4 | 155.05 s | 慢 **2.91×** |

**结论：超分不省时间，反而慢 2.9×–5.8×**。它的价值是「用低分辨率成图成本换更高名义分辨率 / 细节」，  
属于画质 / 预览增强，**不计入成图时间**，因此**保持默认关、按需手动开启**。

> ⚠ 打通它必须先过 `custom_nodes/zz_rgba2rgb` 这个节点：Qwen-Image VAE 解码出的是 **4 通道 RGBA**，  
> 而 `VOSR2Upscale` 只要 3 通道 RGB，直接连会 `ValueError: expects 3-channel RGB, got 4 channels`。  
> 该节点做 `image[..., :3]` 丢 alpha。画质级 A/B 未做（不同分辨率同 seed 构图不同，无法严格比对）。

#### ROCm / 系统开关审计（2026-10-09，速览）

在真实生产启动（仅 `--use-quad-cross-attention`，无 `--reserve-vram`，基线 **7.1s**）上实测：  
`PYTORCH_HIP_ALLOC_CONF=expandable_segments`、`HIP_FORCE_DEV_KERNARG=1`、`MIOPEN_FIND_MODE=FAST`、  
`--fast fp16_accumulation`、`--fp16-vae` 五项波动均落在轮间噪声内（−0.4%~−1.4%），**无可复现收益**；  
`--highvram` 强压全模型进显存反而慢 **67%**，**明确禁用**。  
`hipBLASLt` 运行时已加载（GEMM 调优天花板是开的），下一步可做带持久化缓存的正式 TunableOp 实测（~25 分钟，待确认）。  
Windows 系统层（VBS/Defender 排除/进程优先级/Adrenalin 钩子）需你在宿主机自查——沙箱里 `reg.exe` 被禁读不到。  
详细证据表见两份报告 §11.9 / §M。

## 安装

### 一键部署（推荐）：连 ComfyUI 和模型一起搞定

```powershell
node scripts/setup.mjs                 # 检测 + 缺什么补什么
node scripts/setup.mjs --check         # 只看差什么，绝不动任何东西
node scripts/setup.mjs --verify        # 已存在的模型也重算 SHA256（最稳）
node scripts/setup.mjs --comfy D:\ComfyUI     # 指定 ComfyUI 目录
node scripts/setup.mjs --tier full|lite       # 直接指定主模型档位（见下）
```

它会：① 自动找 ComfyUI；② 把三个模型下到正确目录并**逐个 SHA256 校验**（校验不过的一律删除）；  
③ 调 `install.mjs` 把插件挂进 DSH profile。

### 主模型两个档位（小显存适配）

装的时候会问一句，两个档位：

| 档位 | 主模型 | 体积 | 适合 |
|---|---|---|---|
| **完整档**（默认） | `qwen_image_2.1_int8_convrot.safetensors` | 6.8 GB | 显存 ≥ 8 GB，画质最好 |
| **轻量档** | `qwen-image-2.1-UC-Q4_K_M.gguf`（GGUF Q4_K_M） | 4.3 GB | 8 GB 及以下（如 RTX 5060） |

CLIP 与 VAE 两档共用，**只有主模型不同**。

轻量档有两件事必须知道：

1. **要另装 ComfyUI-GGUF 节点**（`city96/ComfyUI-GGUF`），否则出图会被 ComfyUI 直接拒收：
   ```
   git clone https://github.com/city96/ComfyUI-GGUF "<你的ComfyUI>/custom_nodes/ComfyUI-GGUF"
   ```
2. **该 GGUF 是 Uncensored 系**的 —— 经核实，目前能在 ComfyUI-GGUF 下跑起来的
   Qwen-Image GGUF 只有这一类。介意的话装完自行替换 `models/unet` 里的文件即可，
   插件会自动认你换的那个。

> ⚠ 曾经的坑：这里原先是 `unsloth/Qwen-Image-2.1-GGUF` 的 Q4_K_M，
> 那个是 **stable-diffusion.cpp 格式**的 GGUF（元数据为空、张量名
> `model.diffusion_model.*`），ComfyUI-GGUF 加载不了。2026-10-12 已换成
> 实测能用的 `abenzerps` 系，并保留 ComfyUI-GGUF 的安装提示。

**显存还是紧张？** 降 `megapixels`（如 0.5）立竿见影；出图目录也可以设到固态盘上（见「配置」的 `outputDir`）。

### 显卡：N 卡开箱即用，A 卡走 ROCm（0.1.1 新增）

脚本**先看显卡再决定怎么装**：N 卡用 ComfyUI 官方便携包；**AMD Radeon 走 ROCm 路线**  
（AMD 官方 Windows wheels，装完还是 ComfyUI，**插件本身不用换**，模型也是同一套）；  
Intel 核显基本跑不动。

AMD 用户先 `node scripts/setup.mjs --check` 看计划，确认后 `--yes` 执行。  
⚠ 三条必读：**A 卡可能静默出错**（跑完必须人眼看图）、**别升 ROCm 10.0**  
（HIP 7.15 会破坏权重，脚本锁 7.2.1）、模型**禁止商用**。

完整说明见 [INSTALL.md](INSTALL.md) 的「AMD Radeon 用户」一节。

### 只装插件本体

```powershell
node scripts/install.mjs              # 装进 desktop profile（默认）
node scripts/install.mjs --profile web
node scripts/install.mjs --uninstall
node scripts/install.mjs --dry-run
```

脚本做的事（幂等、改前备份、验证不过自动回滚）：

1. **先 import 一次插件入口**，ESM 语法错或依赖解析失败会当场暴露；
2. 备份 profile 的 `package.json` 到 `profiles\<profile>\_backup-dsh-qwen-paint-<时间戳>\`；
3. 写 `dependencies["dsh-qwen-paint"] = "link:<本目录>"`；
4. 把 `dsh-qwen-paint` 加进 `dsh.profile.bundles`；
5. 建 Junction `profiles\<profile>\node_modules\dsh-qwen-paint → 本目录`；
6. 复核三处都落了，没落就回滚。

> **官方首选路径**是 DSH 自己的 Plugin Manager（`plugin_manager` 的 `install_bundle`，target = 本包绝对目录），  
> 或等价 CLI `dsh plugin --profile desktop add link:<本目录>`（**desktop profile 必须先完全退出 DSH**）。  
> 本脚本是兜底路径，做的是等价的两件事。
>
> ⚠ **若官方 Plugin Manager 因网络装不上** —— 典型报错 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，  
> 或访问 `registry.npmmirror.org` 超时 / 证书不被信任 —— **那不是插件的问题**，  
> 是 pnpm 的供应链校验连不上源。直接用上面的 `scripts/install.mjs` 即可：  
> 与官方等价，且**不依赖任何包管理器网络请求**（本插件零运行时依赖）。

**装完必须彻底退出 DSH 再重新打开** —— 宿主侧工具清单只在启动时装配一次。  
（DSH 是桌面端 Electron 应用，**没有刷新页面这回事**。）

## 用法

装好并重启后，在聊天框直接说：

```
画一只在雪地里的柴犬，逆光，胶片颗粒，电影感
给我画一张 16:9 的赛博朋克雨夜街景，霓虹反射在积水上
用同样的种子再画一遍刚才那张
```

助手会调 `draw_image`。可传的参数：

| 参数           | 说明                                                         |
| ------------ | ---------------------------------------------------------- |
| `prompt`     | **必填**，画面描述（中文可以）。建议写完整一段：主体 + 细节 + 环境 + 光线 + 风格           |
| `size`       | 画幅比例：`1:1`（默认）、`3:4`、`4:3`、`2:3`、`3:2`、`16:9`、`9:16`       |
| `megapixels` | 总像素（百万），默认 `1.0`。要更清楚就调大                                   |
| `steps`      | 采样步数。⚠ **默认被强制钉在 8 步**（turbo8 的工作点），手填别的数会被忽略 —— 详见下面「加速链」 |
| `seed`       | 随机种子。同提示词 + 同种子 = 同一张图；不填则每次不同                             |
| `negative`   | 负面提示词。⚠ 千问模型 `cfg=1`，**负面词基本不生效**，一般别填                     |

尺寸按 **32 的倍数**对齐（`r32(v)=max(32, round(v/32)*32)`），与 `app.py` 的算法一致：  
`1:1@1MP → 992×992`；`16:9@1MP → 1344×736`；`2:3@1MP → 832×1216`。

## 出图落在哪

`C:\Users\<你的用户名>\Desktop\千问1生图\`（遵循工作区约定；也在会话工作区「桌面」之内，  
所以交付卡片和行内图片都能取到这个文件）。

命名：`<提示词前若干字>_Qwen2.1_<宽>x<高>_<序号>.png`，重名自动加 `-2`、`-3`。

## 图片是怎么显示在聊天框里的（原理，改之前务必看）

这一节是 2026-10-07 逐个查内核源码核过的，**不要凭直觉改**：

| 路径                                                | 能用吗           | 原因（都有内核源码依据）                                                                                                                                                |
| ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImageBlock`（工具结果里返 `{type:"image", attachment}`） | ✗             | 客户端 `imageCardModel()` 开头就是 `if (call?.name !== "read_image") return null` —— **只认 `read_image`**；其他工具的 image block 会被 generic 卡片用 `JSON.stringify` 当文本打印出来 |
| `presentCall` / `presentResult`                   | ✗             | ui-tool README 原文："Host `presentCall` and `presentResult` values **never enter the Client**."                                                               |
| `presentationMeta` 让图显示                           | ✗             | 它确实会落到 `tool/result` 的 `data.meta`，但客户端**只有** `read_image` 那张卡片读它、且只当路径标签用                                                                                  |
| `present` 的交付卡片显示图                                | ✗             | `dsh-client-ui-deliverables` 客户端全文**没有任何 `<img>` / `loadImage`**；交付卡片只给「用默认程序打开」的入口                                                                         |
| 助手消息直接带图片                                         | ✗             | 附件子系统文档明说："当前生产适配器声明只输出文本，因此只有用户内容携带图片"                                                                                                                     |
| **① 正文 Markdown 图片 `![](<绝对路径>)`**                | ✓             | 官方设计：客户端 `fileMediaUrl()` 把本地绝对路径重写成 `<base>/api/file?path=…`，打到内核已认证的 `/api/file` 路由取字节，渲染成真 `<img>`。内核自带的 `FILE_REFERENCE_PROMPT` 就是这么教模型的                |
| **② 客户端自定义 toolview**                             | ✓ **100% 确定** | `tool.call.toolview` 是 keyed 槽，文档原文"**Any name is allowed, including tools registered by your package**"；`draw_image` 这个 key 未被占用，注册它不遮蔽任何自带 UI             |

**本插件两条都做，互不依赖**：

- **①** host 侧用 `ctx.systemPrompt.section({ name: 'qwen-paint:inline-generated-image', order: 9100, text: … })`  
  下一条指令，要求模型出图后在正文里内联展示（与内核 `DELIVERABLE_FILE_REFERENCES` 同一机制）。
- **②** `lib/client.js` 注册 `tool.call.toolview` 的 `draw_image` 格子：运行中显示「正在用本机千问画图…」，  
  完成后自己 `<img src="api/file?path=…">` 渲染，失败时显示错误原文。

另外 host 侧仍会 append `deliverables/presented`（与官方 `present` 同一载荷）——  
这不是为了显示图，而是**顺带给一个可点开/用默认程序打开的正式交付入口**，且它能让记录可回放。

## 空闲自动关停（省显存）

要求："不要让 comfyUI 一直跑着，只要五分钟不生图 comfyUI 后端自动关闭。"

- **计时只在插件出过图之后才开始**（`lastActivityAt` 初始为 `null`）。  
  → 所以**绝不会误关你自己打开的、正在「小鲸鱼生图」里用的 ComfyUI**。
- 到点后还要过两关才动手：**ComfyUI 仍在线**，且 **`/queue` 为空**（有任务在跑就续期，绝不打断）。
- **只杀"监听该端口 且 命令行确实含 `comfy` 与 `main.py`"的进程**；认不出来就跳过并记日志——  
  **绝不按端口盲杀**。
- 关掉后计时复位；下次出图需要重新启动 ComfyUI（`draw_image` 会明确提示怎么启动）。

配置：`idleShutdownMs`（默认 `300000` = 5 分钟）、`autoShutdown`（默认 `true`，设 `false` 就永不自动关）。

## ComfyUI 在线状态提示（composer 下方）

在 **composer 卡片下方**（`conversation.composer.dock` 槽）显示一个小指示器：

| 圆点   | 含义                                  |
| ---- | ----------------------------------- |
| 🟢 绿 | ComfyUI 在线；若正在空闲倒计时，会写「空闲 N 分后自动关闭」 |
| 🟡 黄 | ComfyUI 正在出图（`/queue` 非空）           |
| ⚪ 灰  | ComfyUI 未启动 / 状态未知                  |

它每 5 秒读一次 host 的**只读**端点 `GET /api/qwen-paint/status.json`  
（回退 `/qwen-paint/status.json`）。该端点：

- **只放行本机请求**（Host 与远端地址都必须是回环），其余一律 403；
- **只回事实**（`online` / `busy` / `idleShutdownInMs` / `url`），**不含任何本地路径或密钥**；
- 任何意外都回 200 + 可读原因，前端显示"未知"而不是报错。

该槽是 list 槽、`replaceRisk: none`，插件用自己的 id（`qwen-paint-status`）注册，  
**与自带的 `stats` pill 并存，不替换任何自带 UI**。

## 故障排查

| 现象                          | 原因 / 处理                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 说"画个图"，助手说没有这个工具            | 插件没生效 → 确认 profile 的 `dsh.profile.bundles` 里有 `dsh-qwen-paint`，然后**彻底退出 DSH 重开**                             |
| 报"连不上本机 ComfyUI"            | ComfyUI 没启动。双击 `D:\ComfyUI\启动ComfyUI.bat` 或先开「小鲸鱼生图」（它会自动拉起引擎），等它起来再画                                        |
| 报"等 ComfyUI 出图超时"           | 首次出图要加载 7.26 GB UNET + 6.31 GB 文本编码器，**第一次特别慢**；本机实测 25 步 1MP 约 62–124 秒，首次更久                                |
| 报 `ComfyUI 报错：...` + 节点校验详情 | 模型文件名对不上或节点不存在 → 对照上面「依赖」里的三个文件名，以及 ComfyUI 版本需支持 `TextEncodeQwenImage21` / `QwenImage21Cache`（本机 0.37.0 内置） |
| 图出来了但聊天框只有文字                | 交付卡片依赖会话工作区能取到该文件；把 `outputDir` 设在会话工作区内（默认就在桌面「千问1生图」）                                                      |
| 出图报 `value not in list` / 被直接拒收 | **选了轻量档（GGUF）但没装 ComfyUI-GGUF 节点** —— 克隆 [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) 到 `custom_nodes` 后重启 ComfyUI。插件会在优化面板**置顶用橙色块提醒你** |
| 显存不够 / 很慢                   | 三个模型共约 14 GB，8 GB 卡必然换入换出。两个办法：① **装插件时选「轻量档」**（GGUF Q4_K_M，约 4.3 GB，见上面「主模型两个档位」）；② 降低 `megapixels`（如 0.5） |
| 优化面板里点了开关，像"没反应"          | 面板里那几个开关（A 卡专属内核 / 异步卸载 / SageAttention）是**启动参数** ⇒ **改完要重启 ComfyUI** 才生效（面板提示里写了）。另外它们是**内存态**，重载 DSH 会回到 `cordis.patch.yml` 里的值 —— 想永久生效就写进配置 |
| macOS 上找不到 ComfyUI          | 官方对 Apple Silicon **只提供手动安装**（没有便携包）。装好后用 `node scripts/setup.mjs --comfy <你的 ComfyUI 目录>` 指定位置即可（详见 [INSTALL.md](INSTALL.md)） |

## 自测

```powershell
node scripts/selftest.mjs
```

纯 Node，**不联网、不需要真 ComfyUI、不出图、不占显存**：起一个**假 ComfyUI HTTP 服务器**，  
把插件真跑一遍（探活 → 提交 → 轮询 → 取图 → 落盘 → 交付事件），另加尺寸/文件名/workflow  
结构/失败分支/**空闲关停边界**/**状态端点鉴权**/**客户端卡片渲染**的断言（**287 项**，以脚本实际打印为准）。

## 配置

改 `cordis.patch.yml` 里那一行的 `config`（这一层升级插件也不会被覆盖）：

| 字段                      | 默认                               | 说明                             |
| ----------------------- | -------------------------------- | ------------------------------ |
| `comfyUrl`              | `http://127.0.0.1:8188`          | ComfyUI 地址                     |
| `outputDir`             | `C:\Users\<你的用户名>\Desktop\千问1生图` | 成品落盘目录                         |
| `comfyOutputDir`        | `D:\ComfyUI\ComfyUI\output`      | 先在本地取文件，取不到才走 `/view`          |
| `unet` / `clip` / `vae` | 三个千问文件名                          | 换模型时改这里                        |
| `steps` / `resolution`  | `8` / `1024`                     | 默认步数（见下 `turbo8Steps`）与编码分辨率   |
| `timeoutMs`             | `600000`                         | 单任务超时（10 分钟）                   |
| `idleShutdownMs`        | `300000`                         | ★ 出图后多久没再出图就自动关掉 ComfyUI（5 分钟） |
| `autoShutdown`          | `true`                           | 设 `false` 就永不自动关               |
| `idleCheckMs`           | `30000`                          | 空闲检查间隔                         |
| `statusCacheMs`         | `3000`                           | 状态探测缓存（客户端每 5 秒轮询一次）           |

> ⚠ `unet` 除了"用哪个模型"，还**决定用哪个加载器**：文件名以 `.gguf` 结尾 →
> 走 `UnetLoaderGGUF`（需 ComfyUI-GGUF）；否则走原生 `UNETLoader`。

### 厂商专属优化（可选，默认关）★ 2026-10-11 新增

与 N 卡/I 卡的「厂商专属优化」同一套思路：**只在适用的显卡上生效、默认关闭**。
也可以在优化面板里点开关（**内存态**，重载 DSH 会回到这里的值）。

| 字段 | 默认 | 适用 | 说明 |
| --- | --- | --- | --- |
| `amdKernel` | `false` | AMD | 换用本代的替代注意力内核：**6000 → `--use-quad-cross-attention`**，**7000 / 9000 → `--use-ck-attention`** |
| `amdAsyncOffload` | `false` | AMD | `--async-offload`（ComfyUI 在 **N 卡上默认开、A 卡上默认关**，这里给 A 卡补上） |
| `nvidiaSageAttention` | `'auto'` | NVIDIA | `'auto'` = 自检确认 sageattention **已装**才挂 `--use-sage-attention`；`true` 强制挂（**确定装好了再设**，没装会让 ComfyUI 起不来）；`false` 永不挂 |
| `comfyAttentionBackend` | `'auto'` | 全部 | 手动接管注意力后端：`quad` / `pytorch` / `ck` / `default`（`auto` = 按显卡自动选） |

> ⚠ 前三个都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效。
> ⚠ Apple Silicon 上这些**都不会生效**（MPS 没有这些内核），插件也**不会**给统一内存加 `--highvram` 那套。

### 加速链（★ 2026-10-08 新增，默认全开）

| 字段                                          | 默认                                 | 说明                                                                                  |
| ------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `turbo8Lora`                                | `turbo8_lora_step2500.safetensors` | LoRA 文件名；留空 = 用这个内置默认名                                                              |
| `turbo8Strength`                            | `1.0`                              | LoRA 强度。发布方按 1.0 训；调到 `0.65` 更"稳"但会丢风格                                              |
| `turbo8MaxShift` / `turbo8BaseShift`        | `0.6935` / `0.5`                   | `ModelSamplingFlux` 的位移 —— **turbo8 的工作点，别乱改**                                      |
| `turbo8Steps`                               | `0`                                | `0` = 跟随 8 步；写 1–60 用那个数（⚠ 要生效得先关 `forceTurbo8Steps`）                               |
| `forceTurbo8Steps`                          | `true`                             | 是否把步数**强制**钉在 8（连用户手填的 `steps` 也覆盖）                                                 |
| `qwenCacheDevice` / `qwenCacheDtype`        | `auto` / `int8`                    | 官方 `QwenImage21Cache`：int8 折半缓存、约等于 bf16 精度                                         |
| `teSpeedEnabled`                            | `true`                             | ★ TE-Speed 总开关。设 `false` = **整个 TESpeed 节点摘掉**（适合介意闭源 `.pyd` 的人）；turbo8 单跑仍有 12.6 s |
| `teSpeedAttention`                          | `kitchen_int8`                     | TE-Speed 的注意力实现                                                                     |
| `teSpeedStepCache`                          | `te_predictor`                     | 每跳最多 1 步连续跳过；`speed` 是 2 步（更激进、更糊）                                                  |
| `teSpeedThreshold`                          | `0.06`                             | `reuse_threshold`：实测过的档位                                                            |
| `teSpeedStartPercent` / `teSpeedEndPercent` | `0.0` / `1.0`                      | 生效窗口                                                                                |
| `teSpeedErrorLimit`                         | `0.08`                             | `predictor_error_limit`                                                             |
| `teSpeedVerbose`                            | `false`                            | 每步刷日志（排查用）                                                                          |

**想完全退回改动前的老链路**（25 步、无 LoRA、无缓存）：这不是一个开关能切回去的 ——  
LoRA 与缓存节点现在**无条件**接在模型链上。最小可行回退是  
`teSpeedEnabled: false`（摘掉闭源节点）+ `forceTurbo8Steps: false` + `turbo8Steps: 25`；  
要连 LoRA 一起去掉，**建议直接恢复 `lib/index.js` 的备份**（`lib/index.js.bak-before-turbo8-*`）。

## 设计取舍（为什么这么写）

- **零外部依赖**：不 `import @deepseek-ai/dsh-tools`。`tools.register()` 只强校验  
  `output.schema` 是标准 JSON Schema，而 `parameters` 的 spec→JSON Schema 转换是  
  `defineTool()` 做的、`register()` 不校验 —— 既然自己写成标准 JSON Schema 就够，  
  就不引入"装进 profile 后解析不到包"的风险（插件加载失败会让 DSH 起不来）。
- **用局部 `root.inject` 等服务**，不用对象级 `inject`：对象级会把整个 `apply`  
  推迟到服务就绪之后，某个服务在老宿主里不存在时插件会**永远不 apply 且不报错**。
- **workflow 照抄主人机器上已验证的那份**（`D:\ComfyUI\小鲸鱼生图\app.py` 的  
  `build_workflow`），节点与连线一个字不改。
- **启动预热**：插件加载时后台探一次后端，不在线就**隐藏窗口拉起**  
  （不 await、不阻塞 DSH 启动）；出图时还有一次兜底，所以预热失败也不影响出图。
- **空闲关停的计时起点有两个**：预热确认后端在线时、以及你在界面里改档位时。  
  （⚠ 早先只有"出图成功"才算起点，结果**重启 DSH 后一次图都没画就永远不关** —— 已修。）  
  到点还要确认它在线、`/queue` 为空（**有任务就续期，绝不打断**），  
  并且**只杀命令行确实像 ComfyUI 的进程** —— 宁可留着占显存，也不误杀别人的进程。
- **状态端点只放行本机、只回事实**：`{ok, online, busy, idleShutdownInMs, url}`，  
  不含任何本地路径或模型名（自测里有专门一条断言守着这条）。
- **客户端状态指示器用 React 座位 + 纯 DOM**（照 `dsh-reasoning-glow` 的做法）：  
  React 只渲染一个 `<span>` 座位，圆点与文字都在 `useEffect` 里用原生 DOM 挂，  
  并且注册前检查 `React.useRef`/`useEffect` 存在 —— 种子被裁剪过就安静跳过，绝不抛。

## 许可

**MIT** —— 见 [LICENSE](LICENSE)。你可以自由使用、修改、再分发（包括商用），  
**只需保留版权声明与许可声明**。

## 致谢与来源

- **15 种流光的配色抄自「月匠」** —— 原样照搬、一个色标没改，仅作致敬与复用，  
  相关权利归原作者；原作者若有异议，联系即删。
- **模型权重**来自 **Comfy Org 官方在 ModelScope 的仓库**  
  （<https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1>）。  
  本仓库**只记录官方 SHA256**，**不转存、不镜像**任何权重文件。
- **ComfyUI** 是 [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) 的作品，  
  本插件只是通过它的 HTTP API 下任务。

## 作者

**原作者：@奇迹与你**　｜　<https://github.com/wonderandyou/dsh-qwen-paint>  
**优化版：@yanfei0725**　｜　<https://github.com/yanfei0725/dsh-qwen-paint>
