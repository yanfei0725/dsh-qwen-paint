# dsh-qwen-paint · (绘图)千问（优化版）

面向 **DeepSeek Harness** 的本地图像生成插件。经由本机 **ComfyUI** 调用 **Qwen-Image 2.1** 模型，  
在对话中直接完成文生图与图生图；生成的图像落盘保存，并在会话界面内直接呈现。

**网络边界（请以本节为准）**：插件的网络出口有**两类，边界不同**。

**① 出图数据流**（提示词、参考图）—— 只发往 `comfyUrl`（ComfyUI）与 `hipfireUrl`（hipfire serve）。
**默认仅本机回环**（`127.0.0.1` / `localhost` / `::1`），且这一约束**由代码层强制**（`lib/net-guard.js`）：
任一地址被配成本机以外时，**插件会拒绝启动**而不是照发请求。所有出站请求统一走 `guardedFetch`，
强制 `redirect: 'error'`（不跟随任何 HTTP 重定向）。因此**出图全程不依赖外部网络，无需任何 API 密钥，亦不产生调用费用**。

**② 加速包下载**（可选，**默认开启**）—— `accelAutoInstall`（默认 `true`）时，插件会从 **pip 源与 GitHub**
下载厂商专用加速包（`pip install --upgrade` / `git clone`）。**这会访问外部地址**，
但**不发送任何提示词或图片**。设为 `accelAutoInstall: false` 即可完全关闭，出图功能不受影响。
详见下文「权限与已知风险」。

> ⚠ 为如实披露能力：插件提供了 `allowRemoteComfy` 开关（默认 `false`）。用户**显式**设为 `true` 后，
> 才可把 `comfyUrl` / `hipfireUrl` 指向局域网（如 `192.168.1.100`）或远程主机——此时插件会向你指定的地址发送提示词与图片数据。
> 这是**用户主动选择**的行为，不是默认状态。

> **原作者**：@奇迹与你（<https://github.com/wonderandyou/dsh-qwen-paint>）  
> **优化版作者**：@yanfei0725（<https://github.com/yanfei0725/dsh-qwen-paint>）　｜　**许可协议**：MIT　｜　**当前版本**：`0.17.3`

---

## 0.16.0 新增说明

- **OOM 自动回退**：生图遇到显存不足时，自动将 VAE 解码切换为分块模式并重试一次；二次失败会保留错误原因并给出排查建议。需当前 ComfyUI 提供内置 `VAEDecodeTiled` 节点。
- **SADA 探索性接入（默认关闭）**：先探测可选节点，只有节点存在且用户显式开启才加入工作流；本项目尚未安装该第三方节点，节点类型/输入及画质和速度收益未做真机验证，不自动下载。
- **本机扩展 API**：新增 `/api/qwen-paint/health`、`/capabilities`、`/presets`、`/memory/recent`、`/memory/preference`，供本地工具集成；端点仅接受本机请求。
- **记忆联动基础**：每次成功出图追加一条 JSONL 到输出目录 `.qwen-paint-memory.jsonl`，`dsh-auto-memory` 可从 recent 端点读取；偏好 GET/POST 目前只持久化，不自动改变生图参数。
- **ComfyUI Registry 元数据**：加入 `pyproject.toml` 以供 Registry 索引发现。此仓库仍是 DSH 插件而非 ComfyUI Python custom node；元数据不代表已发布或已获 Registry 收录。

## 0.16.1 新增说明（串行抽卡 / 一键出大图）

- **串行抽卡（排队模式）**：显存不足时（默认 < 16 GB 自动判定）一次要出多张会改成「提交 1 张 → 等结果 → 落盘 → 再提交下一张」，显存里始终只有一份 latent，适合挂机批量生成。可用 `serialBatch` 设为 `auto`（默认）/ `on` / `off` 手动控制。
  - ⚠ 重要：串行**不会**卸载主模型。若真的每轮卸载，下一张就要重新加载约 13.5 GB 模型，反而更慢；串行省的是「不同时持有多份 latent」。
- **生成后自动放大（一键出大图）**：设置 `upscaleAfter`（如 2，即 1024² → 2048）后，生图完成会自动接着做分块放大。放大失败不影响已生成的原图（原图已落盘，只记录警告）。
  - 放大逻辑与 `upscale_image` 工具**共用同一套节点图**，不存在两套实现。

## 0.17.1 新增说明（DSH STORE 合规整改 / Registry 元数据）

**本版没有改动出图逻辑** —— 全是"让别人能正确收录我们"的元数据与文档整改。

- **权限与已知风险披露**（README 新增「权限与已知风险」章节）：按 DSH STORE 的口径逐项写明
  `files=write` / `network=默认仅 127.0.0.1（代码强制，另有 allowRemoteComfy opt-in）` / `commands=restricted` / `credentials=none`，
  以及 6 条已知风险 —— **不再让用户靠猜**。
- **`.comfyignore`**：把开发脚本、构建产物、内部报告排除出发布归档。
- **`.github/workflows/publish_action.yml`**：推送到 `main` 且改动涉及 `pyproject.toml` 时自动发版。
- **`pyproject.toml` 按 ComfyUI Registry 官方规范重写**：
  `PublisherId` / `DisplayName` 字段名大小写、`[project.urls].Repository`、移除非规范字段。
  ⚠ 记录一个踩过的坑：**Publisher ID 不等于 GitHub 用户名**，
  写错时报的是 `Failed to validate token`（**完全没提 publisher**），极具误导性。
- ⚠ **修正一处会导致收录被拒的问题**：仓库里曾放着两个构建产物 zip（各约 0.8 MB），
  它们**同时**撞穿 DSH STORE 的「单文件 262,144 B」与「总体积 2,097,152 B」两条上限，
  使源码扫描被判为"**扫描面不完整**"。**已全部移除**（安装包改由 Release 分发）。

> ⚠ 关于 DSH STORE 的如实说明：本插件**必然**具备文件 / 网络 / 命令能力，
> 因此**不满足其"自动准入"要求**（`automaticApproval.permissionSignals` 必须全为 `false`），
> 只能走 **`user-reviewed`** 人工通道。这是**功能决定**的，不是缺陷，也不打算为此阉割功能。

## 0.17.3 新增说明（第二轮复核整改：补上第二个端点 + 装包/Shell 披露对齐）

DSH STORE 自动审核在 Issue #1390 的**第二轮**反馈中确认：0.17.2 的整改**已被读到并采信** ——
*"ComfyUI 的启动校验、三处 HTTP helper 的 `redirect: 'error'` 和子进程环境过滤均已读到，
旧的'完全没有拦截 comfyUrl'结论已撤换"*。

但它同时指出**两处我上一轮漏掉的**，且都属实。本版逐条修复：

### ① `hipfireUrl` —— 独立于 `comfyUrl` 的**第二个外部端点**（已接入守卫）

审核原文：
> `lib/hipfire-img.js` 的 `probeHipfireHttp` / `generateViaHttp` 直接使用可配置 `cfg.hipfireUrl`，
> 没有调用回环校验，也不受 `allowRemoteComfy` 控制；`guardedFetch` 目前只有定义、没有调用。

**完全属实。** 上一轮我只收口了 `comfyUrl`，而 hipfire 出图后端有**自己的一条 HTTP 链路**。
本版：

- `guardedFetch` **从"只有定义"变成"所有出站的唯一出口"**：`config.js` 的 `fetchWithTimeout`、
  `hipfire-img.js` 的 `fetchJson`、`index.js` 的参考图上传，**全部改走它** ——
  回环校验与禁重定向收口在一处，不会再有"某条链路只做了一半"。
- `apply()` 启动校验**扩成两个端点**：`comfyUrl` 与 `hipfireUrl` 都过 `assertLocalUrl`。
  - `imageBackend: 'hipfire'` 时 `hipfireUrl` 非回环 → **拒绝启动**；
  - 当前用 comfyui 后端时**不阻断**（避免误伤），但如实记 `warn` 告知"切到 hipfire 就会被拦"。
- `generateWithHipfire` 在**进入 HTTP 路径前**显式校验并返回**结构化可读错误** ——
  否则错误会被 `probeHipfireHttp` 的 `catch` 吞成 `online=false`，用户看到的是
  *"hipfire HTTP 服务不在线，请先启动它"*，**报错指错方向**（会去反复重启一个根本不该连的地址）。
- 新增**全局开关** `setAllowRemote()`：`allowRemoteComfy` 是启动时确定的全局配置，
  而 `fetchWithTimeout` 在 `config.js` 内有 8 处调用 —— 逐处传参**漏一处就是一个未受控出口**，
  故由 `apply()` 设置一次、所有守卫自动继承（显式传参仍可覆盖，收紧优先）。

### ② 装包与 Shell 能力 —— 披露与实现对齐（**不改功能**）

审核原文：
> README 权限表仍写"不装包"，但 `lib/index.js` 的 `runInstallSource` 会经 `runShell` 执行
> `pip install --upgrade`；`lib/config.js` 使用 PowerShell / `sh -c`。请对齐网络、装包与 Shell
> 能力的披露和实际确认边界，无需删掉正常功能或把真实信号标为 false。

**也属实，而且比"措辞不准"更严重**：`accelAutoInstall` **默认为 `true`**，
插件加载后会自动 `pip install --upgrade` / `git clone` 从 **pip 源与 GitHub** 下载厂商加速包。
这意味着 README 里"默认仅本机回环"的说法**本身也不完整** —— 装包是一条真实的**外部网络出口**。

本版按"如实披露 + 明确边界"处理（**不删功能**）：

- **权限表重写**：网络拆成**两类出口**（出图数据流 / 加速包下载），命令行如实写明
  `runShell` 走 PowerShell 或 `sh -c`、且默认会 `pip install` / `git clone`。
- **新增已知风险第 4 条**：明确 `accelAutoInstall: true`（默认）会装包、会出网、
  **不发送提示词或图片**，并给出**关闭方法**（`accelAutoInstall: false`，关掉后出图不受影响）。
- **顶部「网络边界」段落重写**为两类出口，不再用"不依赖外部网络"这种绝对化说法。
- **区分清楚"不下载什么"**：插件**不下载模型权重**、**不自动安装第三方自定义节点**
  （这两条原本就是事实，保留并写明确）。

### 回归测试

`scripts/test-net-guard.mjs` 从 48 项扩到 **62 项**，新增覆盖：
全局开关语义（含"显式传参收紧优先"）、`hipfireUrl` 作为第二端点被拒/放行、
`guardedFetch` 在非回环时**底层 fetch 调用次数为 0**（证明确实没发出去）。

## 0.17.2 新增说明（网络边界代码层强制 + 文档对齐）

**本版修复的是"文档声明与代码行为不符"** —— 这是 DSH STORE 自动审核在 Issue #1390 给出的
**本轮唯一拒绝理由**（原文：*"当前 README 仍将网络能力声明为'仅本机回环、不访问外部地址'，
但 `lib/index.js` 直接合并 `rawConfig`，随后使用可配置的 `comfyUrl` 发起请求，
未证明回环约束及重定向边界"*）。

审核员同时明确：**不要删除功能，也不要把真实能力声明为 false**；请正面解决 —— 
要么**落地限制并处理重定向**，要么**如实披露可配置的外部端点**。本版**两条都做了**。

- **新增 `lib/net-guard.js`（网络边界守卫，代码层强制）**：
  - `isLoopbackUrl(url)` / `assertLocalUrl(url)`：只认字面量 `127.0.0.0/8`、`localhost`、`::1`、`0.0.0.0`；
    **不接受任何域名**（含 `localhost.evil.com` 这类伪装），从根上消除 DNS rebinding 面。
  - **启动即校验**（`lib/index.js` 的 `apply()`，合并 `rawConfig` 之后第一件事）：
    `comfyUrl` 非回环 → **抛出错误、拒绝启动**（fail-fast，不静默回退 —— 静默回退会让用户
    以为远端生效了、实际连的是本机，那更糟）。
  - **所有出站请求强制 `redirect: 'error'`**：不跟随任何 302/301。回环被重定向到公网是
    最典型的越界手法，直接抛错比"跟过去再检查"可靠（那时数据已经发出去了）。
    覆盖 `config.js` 的 `fetchWithTimeout`、`index.js` 的参考图上传、`hipfire-img.js` 的 HTTP 调用。
- **如实披露可配置的外部端点**：新增 `allowRemoteComfy`（默认 `false`）。
  用户**显式**开启后才允许 `comfyUrl` 指向局域网/远程地址，且放行时**记 warn 日志**。
  这是"如实披露"，不是"撒谎说不支持"。
- **子进程环境变量白名单化**（`net-guard.js` 的 `filteredEnv`）：
  `hipfire-img.js` 的 `spawn` 与 `config.js` 的 `runShell` 不再直接继承宿主环境，
  剔除 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等代理变量（避免子进程网络去向与声明不一致）
  与 `*TOKEN*` / `*KEY*` / `*SECRET*` / `*PASSWORD*` / `*CREDENTIAL*` 类变量；
  保留 `PATH` / `SystemRoot` / `HOME` / `TEMP` 等运行必需项。
  > 审核员原话：*"spawn 未显式设置 env 会继承宿主环境 —— 这**不构成**拒绝理由"*。
  > 我们仍然做了，是为了防患于未然。
- **README 措辞对齐**：顶部「网络边界」段落与「权限与已知风险」表格改为准确描述
  （默认本机回环 + **代码层强制** + opt-in 开关），**删掉"不访问任何外部地址"这类过度承诺**。
- **新增回归测试 `scripts/test-net-guard.mjs`（48 项断言，全部通过）**：
  覆盖回环放行 / 局域网·域名·伪装域名拒绝 / `allowRemote` 语义 / 重定向强制 `error` /
  代理与凭据环境变量剔除。**纯 JS，不依赖网络与子进程派生**（沙箱会间歇性禁止 spawn）。

## 0.17.0 新增说明（专业卡版：档位 / 精度 / 权重可调 / ControlNet）

面向**专业卡**（显存 ≥ 24 GB 且系统内存 ≥ 64 GB，如 L20 / RTX Pro 6000 / W7900 / Arc Pro B70）做了成体系的增强；
**轻量版同样能用**（档位可选，只是范围受显存限制）。

- **显存 / 内存档位**（`vramMode`）：`auto` / `resident`（全驻留）/ `standard` / `save`（省显存）/ **`ram`（权重放内存）** / `cpu`。
  - 「**权重放内存**」= `--novram`：权重常驻内存、按需换入显存 —— **显存不够也能跑**，代价是慢。
  - ⚠ 这是 **ComfyUI 启动参数**，改完**必须重启 ComfyUI**；macOS 上这组参数不参与（MPS 统一内存）。
- **模型精度档**（`precisionTier`）：`auto` / **BF16 全精度（24G+）** / `FP8（12G+）` / `int8` / `GGUF`。
  - 按**文件名标记**从你已装的文件里挑；**挑不到就如实回落并报缺失**，绝不假装已用上。
- **文本控制档**（`textControl`）：`auto` / `turbo`（8 步 / CFG 1.0）/ **`native`（千问原生工作点 25 步 / CFG 2.5）**。
  - turbo8 是为速度牺牲文字渲染的；**要更精细的文字就该走原生工作点**（约 3 倍采样时间）。
- **权重可调**：面板里直接切换**主模型 / LoRA / ControlNet 权重**。
  - 选项**只能来自 ComfyUI 真实存在的文件**（没有手填文件名的口子 ⇒ 无路径注入）；
    选了但文件不在时会**如实提示"未采纳"**，不静默换别的。
- **通用 ControlNet**：新增 `controlImage` 参数（控制图路径），配合面板选中的 ControlNet 权重即可按
  结构（边缘 / 深度 / 姿态）约束生成。
  - ⚠ **三个条件缺一不可**：探测到 `ControlNetLoader` + `ControlNetApplyAdvanced` 节点、选了权重、传了控制图；
    缺任一条都**不会接进工作流**，并在返回值里**如实说明原因**。
  - ⚠ 与「局部重绘」**完全独立**（后者走 `ControlNetInpaintingMamaApply` + 独立工具）。
- **面板**：新增「档位」与「权重」两栏下拉；档位/权重**不进优化总账**（它们是配置选择，不是优化点开关）。
- ⚠ **未实测声明**：开发机是 **AMD RX 7900 XT 20 GB** —— **BF16 / FP8 / ControlNet 的真机效果未在本机验证**，
  请在你的 24 GB+ 卡上自行验证。Intel（B70，IPEX/XPU）本轮**未**做专属支持。

## 0.16.2 新增说明（记忆消费 / SageAttention 模式 / NVFP4 提示）

- **偏好记忆自动消费**：输出目录下的 `.qwen-paint-preferences.json`（由 `dsh-auto-memory` 或本机工具写入）现在会被真正用起来 —— 当你**没有显式传参**时，按记忆补上画幅、像素档位（MP）、采样步数、每轮张数与负向词。
  - ⚠ 优先级铁律：**显式参数 > 记忆偏好 > 界面预设 > 插件默认**。你显式传了 `size` / `steps` 就绝不会被记忆覆盖；每次补齐都会在日志里**如实列出补了哪些**，不静默改你的意图。
  - ⚠ **随机种子不从记忆读** —— 默认每次随机出图；想复现必须自己传 `seed`（否则会每次出同一张）。
  - 偏好接口不变：`GET/POST /api/qwen-paint/memory/preference`。
- **SageAttention：性能 / 兼容模式 + 崩溃自动回退**（仅 N 卡）
  - 新增 `nvidiaSageAttentionMode: 'performance' | 'compatibility'`，面板标题直接标注「性能模式 / 兼容模式」。
    ⚠ 如实说明：ComfyUI 的 `--use-sage-attention` 是**全局开关、没有官方子模式参数**，所以这两档的差别**只在崩溃兜底策略**，插件没有、也不会编造一个"模式"命令行参数。
  - **崩溃自动回退**：若启用 SageAttention 后 ComfyUI 启动失败，且启动日志**明确指向 sage-attention**（参数不被当前版本识别、`sageattention` 没装却被强制开启、或 Blackwell / sm_120 构建不匹配），插件会在**当前会话内自动关掉它**，避免反复重启反复崩；同时告知原因与恢复方式。
    - 判据**宁漏不误**：端口占用、显存不足、普通报错**绝不会**被误判成 SageAttention 的锅，也不会因此关掉你想要的功能。
- **NVFP4 检测与提示**（仅 50 系 / Blackwell 出现）
  - 面板会多一条信息项「NVFP4 量化模型（Blackwell 专属，可选）」，指出社区已有 Qwen-Image 2.1 的 NVFP4 checkpoint（`BennyDaBall/Qwen-Image-2.1-NVFP4`），供你在 50 系卡上自行下载、自行选择模型。
  - ⚠ 只**检测 + 提示**，插件**不会**替你切换模型、也**不下载模型权重**（NVFP4 checkpoint 等一律由你自行下载）；它不是开关。**该路径未在开发机（AMD）上实测**，实际提速请以你的 5060 机器为准。
- **稳定性修正**：修好了一处"面板说已生效、端点其实不认"的假开关白名单遗漏（SADA / OOM 两个开关）；`lib/config.js` 拆出 `lib/describe.js` 以符合发布体积上限。

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
| AMD RDNA1（RX 5000）★ | `Radeon RX 5xxx`              | `--use-pytorch-cross-attention` | A 卡专属内核（可选）、异步卸载（可选）                      |
| Apple Silicon ★      | `Apple M1`–`M5`               | `--use-pytorch-cross-attention` | MPS 算子回退（默认开）、取消显存水位上限（可选）                 |
| Intel Mac + AMD 独显 ★ | `Radeon Pro 5xxxM` 等         | `--use-pytorch-cross-attention` | 同上（macOS 上 AMD 显卡**走 Metal，不走 ROCm**）        |
| Intel Mac（核显）★     | `Intel Iris` / `UHD Graphics` | 不指定                             | MPS 算子回退（默认开）                             |

各类硬件的参数与加速组件相互独立，不会交叉套用。

> ★ **平台闸（2026-10-12 新增）**：显卡判定在**平台**这一维上再收一次口。
> 同一个型号名在不同平台能用的计算栈完全不同 ——
> Windows/Linux 上的 `Radeon RX 7900 XT` 走 ROCm（quad / CK 那套），
> 而 **macOS 上的 AMD 显卡只有 Metal/MPS 一条路**（Apple 不提供 ROCm）；
> Windows/Linux 上的 `Intel Arc` 走 XPU + IPEX，而 **macOS 上根本没有 XPU 后端**。
> 不收口就会出现"Intel Mac 被建议装 IPEX"这类**照着做必然失败**的建议。

#### A 卡专属优化（可选，默认关）★ 2026-10-11 新增

与 N 卡/I 卡的「厂商专属优化」同一套思路：**只在适用的显卡上、在优化面板里出现**，  
**默认关闭**，由你自己决定要不要开。两项都是**质量中性**的 —— 换的是后端 / 加载时机，  
**不改任何计算结果，不牺牲原生画质**。

| 开关          | 作用                | 按代系给什么                                                                                                  |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| **A 卡专属内核** | 换用本代的替代注意力内核      | 5000 / 6000 → `--use-quad-cross-attention`；7000 / 9000 → `--use-ck-attention`                            |
| **A 卡异步卸载** | `--async-offload` | ComfyUI 的 help 原文写着它 *"Enabled by default on Nvidia"* —— 即 **N 卡默认开、A 卡默认关**，这里给 A 卡补上（只改权重加载的时机，与计算重叠） |

> ⚠ 两个都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效（面板提示里也写了）。  
> ⚠ 5000 / 6000 / 9000 我们**没有硬件实测**，所以一律默认关 —— 属可选档，不合适就关回去。  
> ⚠ 也**不会**因为默认关而把面板显示成"优化部分启用"：它们被标记为**可选**，  
> 单独计入总账的「N 项可选（默认关）」。  
> 想永久生效：把 `amdKernel` / `amdAsyncOffload` 写进 `cordis.patch.yml`（面板开关是内存态）。

### 三、操作系统兼容

启动、停止、进程存活查询与显卡探测均按平台分别实现：

- **Windows**：经 WMI 派生进程（宿主重启不会连带终止 ComfyUI），显卡信息取自 PowerShell；
- **Linux**：以 `setsid` / `nohup` 脱离会话，显卡信息取自 `nvidia-smi` / `rocm-smi` / `lspci` 及 `/sys`；
- **macOS（Apple Silicon / Intel Mac）★ 2026-10-11 新增，2026-10-12 补上真正的优化**：
  显卡信息取自 `system_profiler` / `sysctl`，
  进程脱离会话**先探测 `setsid` 是否存在**（**macOS 没有这个命令**），没有就退回 `nohup`。

#### macOS 怎么用

ComfyUI 官方对 Apple Silicon（M1–M5）**只提供手动安装**（没有便携包），所以：

1. 装 **pytorch nightly** —— 按 Apple 的 Metal 加速指南：<https://developer.apple.com/metal/pytorch/>
2. 按 ComfyUI 官方「Manual Installation」装依赖
3. 启动：`python main.py`（插件会自动补上下面那条参数，你**不需要**手写）

然后 `node scripts/setup.mjs --comfy <你的 ComfyUI 目录>` 就能继续「下模型 + 挂插件」两步。
（插件**不会**替 macOS 用户去下 Windows 便携包。）

#### macOS 上插件到底做了什么（★ 2026-10-12）

先说清**为什么之前是"零优化"**：ComfyUI 在 MPS 上**不会自动**启用 PyTorch SDPA ——
它的 `ENABLE_PYTORCH_ATTENTION` 自动开启条件里只有 NVIDIA / Intel XPU / Ascend / MLU
和一批 AMD gfx 代号，**没有任何一条与 MPS 相关**。于是 Mac 上会落到
`attention_sub_quad`（那个给 CPU / 低显存场景准备的次二次实现），
**根本没走 Metal 的融合内核**。

现在插件会做两件事：

| 做什么 | 怎么做的 | 依据 |
| --- | --- | --- |
| **切到 Metal 融合 SDPA** | 启动参数加 `--use-pytorch-cross-attention` | ComfyUI 源码 `comfy/model_management.py` 里 `ENABLE_PYTORCH_ATTENTION` 无 MPS 分支（可自行复核） |
| **兜住未实现的算子** | 注入环境变量 `PYTORCH_ENABLE_MPS_FALLBACK=1` | PyTorch 官方 "MPS Environment Variables" 文档 |

另有**一个可选档**（默认关）：`PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` ——
取消 MPS 分配器的硬上限（官方默认 **1.7**），让大模型在小内存 Mac 上**可能跑得起来**。
默认关是因为官方明确写了：取消硬上限后若发生系统级 OOM，*"may cause system failure"* ——
那是"用稳定性换可用性"的取舍，得你自己权衡。

> ⚠ 插件在 Mac 上**不加任何 CUDA / ROCm 专用内核参数**
> （`--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention` 在 MPS 上都不适用）。
> ⚠ **统一内存没有独立显存** ⇒ `--highvram` / `--reserve-vram` 这套驻留参数**显式跳过**
> （ComfyUI 源码里 MPS 的 `vram_state` 被强制成 `SHARED`，这组参数根本不参与），
> 面板会如实说明"为什么没有这一项"。
> ⚠ `--force-fp16` / `--force-non-blocking` **也不加** —— ComfyUI 对 MPS 本来就是 fp16、
> 且源码里 `device_supports_non_blocking()` 对 MPS 恒为 False（原注释：*"mps doesn't support non blocking"*）。
> ⚠ **Intel Mac**：没有 CUDA / ROCm / XPU 任何一条厂商计算栈。
> 带 AMD 独显的机型走 MPS（识别为「Intel Mac + AMD 独显」）；
> 只有 Intel 核显的机型实际上只能跑 CPU，**出图会非常慢** —— 这是硬件事实，不粉饰。
> ⚠ 上述 Mac 优化**没有真机实测**（开发机是 Windows + ROCm）。
> 依据是 ComfyUI 与 PyTorch 的源码/官方文档（都可复核），但"能快多少"给不出数字。
> 想回到"一个参数都不加"：把 `comfyAttentionBackend` 设为 `default`。

### 四、可运维性

- 面板与工具如实报告每一项优化的真实状态（已启用 / 可启用 / 不可启用 / 按尺寸让位）。
- 随附 **22 套**回归测试，覆盖四厂商判定、**三平台**分支（Windows / Linux / macOS）、
  工作流接线、取消与超时、可移植性及打包完整性。
  其中 `_mac_env_test.mjs` 会**真起一个 `sh` 跑一遍**启动命令，
  验证 macOS 的环境变量确实注入到了子进程（而不是"看起来像"）。

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

> ⚠ **重要限制（2026-10-12 排查）**：Qwen-Image **2.1** 的 GGUF 目前只有
> `abenzerps` 一家提供，且**只在 HuggingFace**。脚本会依次试
> `hf-mirror.com` → `huggingface.co`，但 **hf-mirror 对 LFS 大文件只返回 308
> 跳转、等于没镜像**，所以**国内网络下很可能下不动**。
> `city96`（ComfyUI-GGUF 作者）确实有一份在 ModelScope 上，但他转的是
> **初代 Qwen-Image（20B，Q4_K_M 12.17 GB）**，与 2.1（7B）**不能混用**。
> ⇒ **下不动是预期内的**：自己弄一个可用的 `.gguf` 放进 `models/unet`
> 即可，插件会按文件名自动挑最优的那个。

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

> ★ **RX 5000 系列（RDNA1 / gfx101x）单独说一句**：这一代**不在 ROCm 官方支持矩阵内** ——
> PyTorch 官方 ROCm 轮子没有编译 gfx101x，通常需要 `HSA_OVERRIDE_GFX_VERSION`
> （或自行按 gfx1010 / gfx1012 重新编译 PyTorch）才能让 PyTorch 认卡。
> 这属于**环境搭建**层面的事，插件不改也不该改（改驱动/编译轮子的风险远大于收益），
> 只在识别到这一代时把这件事写进面板提示，免得你"装完发现认不到卡"。
> 注意力后端上它与 RDNA2 同样走保守的 `--use-pytorch-cross-attention`
> （ROCm 的 AOTriton 融合内核只覆盖 RDNA3 / 3.5 / 4，CK SDPA 也不覆盖 gfx101x）。

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
| `comfyUrl`              | `http://127.0.0.1:8188`          | ComfyUI 地址。**非本机地址会被拒绝启动**（除非同时设 `allowRemoteComfy: true`） |
| `hipfireUrl`            | `http://127.0.0.1:11580`         | hipfire serve 地址（`imageBackend: 'hipfire'` 时使用）。**独立于 `comfyUrl` 的第二个端点，同样受回环校验** |
| `allowRemoteComfy`      | `false`                          | 是否允许 `comfyUrl` / `hipfireUrl` 指向非本机地址。默认 `false`（仅本机回环，代码层强制）。设为 `true` 后可连局域网/远程服务，请自行确认那是你信任的机器 |
| `accelAutoInstall`      | `true`                           | 是否自动安装厂商加速包。**`true` 时会执行 `pip install` / `git clone` 并从 pip 源与 GitHub 下载（访问外部网络，但不发送提示词或图片）**。设为 `false` 完全关闭，出图不受影响 |
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
| `amdKernel` | `false` | AMD | 换用本代的替代注意力内核：**5000 / 6000 → `--use-quad-cross-attention`**，**7000 / 9000 → `--use-ck-attention`** |
| `amdAsyncOffload` | `false` | AMD | `--async-offload`（ComfyUI 在 **N 卡上默认开、A 卡上默认关**，这里给 A 卡补上） |
| `nvidiaSageAttention` | `'auto'` | NVIDIA | `'auto'` = 自检确认 sageattention **已装**才挂 `--use-sage-attention`；`true` 强制挂（**确定装好了再设**，没装会让 ComfyUI 起不来）；`false` 永不挂 |
| `nvidiaSageAttentionMode` | `'performance'` | NVIDIA | ★ 2026-10-13 新增。`'performance'` 性能模式 / `'compatibility'` 兼容模式。⚠ ComfyUI 的 `--use-sage-attention` **没有官方子模式参数**，所以两档差别**只在崩溃兜底策略**（兼容模式对 SageAttention 引发的启动失败始终自动兜底），**不新增任何命令行 flag** |
| `appleMpsFallback` | `true` | macOS | 注入 `PYTORCH_ENABLE_MPS_FALLBACK=1`：MPS 未实现的算子自动回退 CPU，而不是让整次出图抛错（**质量中性**，只影响"本来就会失败"的路径） |
| `appleMpsUnlimitedMem` | `false` | macOS | 注入 `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`：取消 MPS 分配器硬上限（官方默认 1.7），大模型在小内存 Mac 上**可能就能跑**。⚠ 系统级 OOM 会连系统一起拖垮，官方原文 *"may cause system failure"* |
| `comfyAttentionBackend` | `'auto'` | 全部 | 手动接管注意力后端：`quad` / `pytorch` / `ck` / `default`（`auto` = 按显卡自动选） |

> ⚠ 上面 A/N 卡那几项（`amdKernel` / `amdAsyncOffload` / `nvidiaSageAttention` / `nvidiaSageAttentionMode`）
> 都是**启动参数** ⇒ 改完**必须重启 ComfyUI** 才生效。
> ⚠ 两个 `appleMps*` 是**注入给 ComfyUI 进程的环境变量**（不是命令行参数）⇒ 同样需重启 ComfyUI；
> 且**只在 macOS 生效** —— 其它平台改它们会被服务端直接拒绝（没有 MPS 后端，改了也不会发生什么）。
> ⚠ Mac 上**不会**挂 `--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention`
> （MPS 没有这些内核），也**不会**给统一内存加 `--highvram` 那套（MPS 的 `vram_state` 恒为 `SHARED`，加了不参与）。

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

## 上架 ComfyUI Registry（元数据）

> ⚠⚠ **先读这条**：本插件是 **DSH（DeepSeek Harness）插件**，**不是 ComfyUI 节点**。
> 仓库里**没有任何 Python 节点文件**（无 `__init__.py` / `NODE_CLASS_MAPPINGS`），
> 它是通过 HTTP 与本机 ComfyUI 对话的。
> ⇒ **把它装进 ComfyUI 的 `custom_nodes` 不会有任何效果**。
> 在 Registry 上架**只为元数据可被发现**；实际安装请走 DSH 的 `install_bundle`
> （见 `cordis.patch.yml` 与 `一键安装.cmd`）。

**已完成的配置**

| 文件 | 作用 |
| --- | --- |
| `pyproject.toml` | Registry 元数据。按[官方规范](https://docs.comfy.org/registry/specifications)填写：`[project]` 的 `name`/`version`/`license`/`dependencies` + `[project.urls].Repository`，`[tool.comfy]` 的 `PublisherId`/`DisplayName`（**字段名大小写敏感**） |
| `.comfyignore` | 排除开发脚本、构建产物与内部报告，让 Registry 归档更干净（语法同 `.gitignore`） |
| `.github/workflows/publish_action.yml` | 推送到 `main` 且改动涉及 `pyproject.toml` 时**自动发布**（官方模板） |

**还需你手动做两步**（只有仓库所有者能做）

1. **确认 `PublisherId`**：`pyproject.toml` 里现在写的是 `yanfei0725`。
   请核对 Registry 个人页 `@` 后面那串 —— **必须完全一致，且创建后不可更改**。
   若不同，改 `pyproject.toml` 的 `PublisherId` 再推一次。
2. **配置 API Key**（二选一）：
   - **自动发布**：仓库 `Settings → Secrets and variables → Actions → Repository secrets`
     新建名为 **`REGISTRY_ACCESS_TOKEN`** 的 Secret，值为 Registry 的 API Key。
     之后改 `pyproject.toml` 的 `version` 并推送即会自动发布。
   - **手动发布**：本地 `pip install comfy-cli`，在仓库根目录跑 `comfy node publish`，按提示粘贴 API Key。

> ⚠ 版本号规则：`version` 每次发布必须**递增**，且**旧版本号不可复用**。
> 本仓库的 `pyproject.toml` 与 `package.json` 保持**同一个版本号**，避免两处打架。

## 权限与已知风险（安装前请读）

本插件**不是**纯只读插件 —— 它要调本机 ComfyUI 出图，因此**必然**需要文件、网络与子进程能力。
下面按 DSH 商城的口径逐项如实披露，**不隐瞒、不淡化**。

| 能力 | 本插件的实际情况 | 等级 |
| --- | --- | --- |
| **文件（files）** | **读写**：读你给的参考图 / 控制图；把生成的图**写到你指定的目录**（默认桌面「千问1生图」）；读 ComfyUI 的模型清单与日志 | `write` |
| **网络（network）** | **两类出口，边界不同** —— ① **出图数据流**（提示词 / 图片）：发往 `comfyUrl`（ComfyUI）与 `hipfireUrl`（hipfire serve），**默认仅本机回环、由代码层强制**（`lib/net-guard.js`：非回环地址拒绝启动），可用 `allowRemoteComfy` 显式放开；② **加速包下载**（见下行「命令」）：`accelAutoInstall`（**默认 `true`**）时插件会从 **pip 源与 GitHub** 下载第三方加速包 —— **会访问外部地址**，但**不发送任何提示词或图片**，设为 `false` 可完全关闭。**无遥测、无上报** | `specified-services` |
| **命令（commands）** | **受限调用，但不止"只读探测"**：① 启动 / 探测本机 ComfyUI（`python main.py`）与 `nvidia-smi` / `rocm-smi` 只读探测；② **`runShell` 是系统命令的唯一入口**，Windows 走 `powershell -NoProfile -NonInteractive -Command`、Linux/macOS 走 `sh -c`；③ **`accelAutoInstall: true`（默认）时会执行 `pip install --upgrade` 与 `git clone` 安装白名单内的加速包**（见下）。子进程**传入过滤后的环境变量**（剔除代理与凭据类）。**不执行从网络下载后立刻运行的脚本**（下载的包由 ComfyUI 在重启后加载） | `restricted` |
| **凭据（credentials）** | **无**。不需要 API 密钥、不需要登录、不读写系统钥匙串 | `none` |
| **生命周期脚本** | **无** —— manifest 里没有 `preinstall` / `install` / `postinstall` / `prepare` | — |
| **运行依赖** | **零** —— 不 `import` 任何第三方包，纯 Node ESM | — |

综合等级：**medium**（能力范围明确，出图数据流**默认**限于本机，但确实会写文件、起进程、并在默认配置下装包）。

### 已知风险（如实列出）

1. **会写文件**：出图落盘到 `outputDir`（默认桌面）。**请自行确认该目录符合你的预期**，
   插件不会写到别处。
2. **会起进程**：为省显存，插件可启动 / 关停本机 ComfyUI。它会**先探测**再启动，
   但如果你已手动开着 ComfyUI，请确认 `comfyUrl` 指向的是你想要的那个实例。
   > 子进程（ComfyUI / 探测命令 / 装包）使用**过滤后的环境变量**：`HTTP_PROXY` / `HTTPS_PROXY` /
   > `ALL_PROXY` 等代理变量，以及 `*TOKEN*` / `*KEY*` / `*SECRET*` / `*PASSWORD*` /
   > `*CREDENTIAL*` 类变量**不会**传给子进程（`lib/net-guard.js` 的 `filteredEnv`）。
3. **会调用本机 Python**：① 只读探测显卡显存；② **装加速包时会 `pip install`**（见第 4 条）。
4. **⚠ 会装包（默认开启，可关）**：`accelAutoInstall` 默认为 `true` —— 插件加载后会检测本机缺哪个
   **厂商专用加速包**（NVIDIA / Intel / AMD 各自的加速件），缺就**自动执行 `pip install --upgrade` 或 `git clone`**
   从 pip 源 / GitHub 下载安装。**这是真实的、会改动你环境的操作**，且**会访问外部网络**（不发送提示词或图片）。
   - **关闭方法**：配置 `accelAutoInstall: false`。关掉后出图功能**不受任何影响**，只是少了厂商专用加速；
     需要时可手动调用 `check_acceleration(action:'install')`。
   - **模型权重不在此列**：插件**不下载** Qwen-Image 等模型权重，也不自动安装第三方自定义节点 ——
     这些必须你自己准备（缺失时插件会给明确指引，**不会假装已装上**）。
5. **`--novram` / `--lowvram` 等档位是拿速度换空间**：显存不够时能跑，但**会明显变慢**，
   这不是 bug（见上文「显存 / 内存档位」）。
6. **`comfyUrl` / `hipfireUrl` 可被用户改成外部地址**（必须显式开启 `allowRemoteComfy`）：
   一旦开启，提示词与图片数据会发送到该地址。**默认关闭**，且关闭时由代码强制拦截
   （两个端点都受同一开关控制）。
7. **本插件的开发机是 AMD RX 7900 XT 20 GB**：N 卡（L20 / RTX Pro 6000）、
   Intel（Arc Pro B70）与 macOS 上的**效果未经本机实测**，请以你自己的机器为准。

> 本插件**出图数据流**默认不做任何外部传输、不收集使用数据、不需要账号。
> 唯一默认开启的外部访问是**加速包下载**（第 4 条，可用 `accelAutoInstall: false` 关闭）。
> 如果你发现任何与上表不符的行为，请开 Issue —— 这份披露的准确性本身也是承诺。
>
> **网络边界的实现与自测**：`lib/net-guard.js` 提供 `isLoopbackUrl` / `assertLocalUrl` /
> `guardedFetch` / `filteredEnv` / `setAllowRemote`。**所有 Node 侧出站请求统一走 `guardedFetch`**
> （`config.js` 的 `fetchWithTimeout`、`hipfire-img.js` 的 `fetchJson`、`index.js` 的参考图上传），
> 出站前校验回环 + 强制 `redirect: 'error'`。
> 客户端 `lib/client.js` 只向**同源相对路径**（`api/qwen-paint/…`）发请求，不含任何可配置的绝对地址。
> 回归用例在 `scripts/test-net-guard.mjs`（**62 项断言**，覆盖 127.0.0.1/localhost/::1 放行、
> 192.168.x / 10.x / 域名与 `localhost.evil.com` 式伪装拒绝、两个端点各自受控、
> 全局开关与显式传参的优先级、重定向强制 `error`、非回环地址**根本不发起请求**、
> 代理与凭据环境变量剔除）。

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
