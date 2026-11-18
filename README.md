# dsh-qwen-paint · (绘图)千问（优化版）

DSH 插件 / DeepSeek Harness：视频 / 生图 / TTS 全能 · 本机运行（QQ 交流群 454707710）。★ 1.2.1：许可仍为 BSL 1.1（BUSL-1.1），本版是质量与可诊断性收口补丁——历史库搜索升级 SQLite FTS5 全文索引（1 万条实测 0.023ms vs LIKE 1.012ms，约 44×；短词自动回落 / 旧库自动回填 / 查询注入防护）、doctor 8 项自诊断补齐 4 项真探针（未验证一律标未检测、不谎报 pass）、OOM 建议跟上 ComfyUI v0.37 动态显存与社区 8G 抄作业档、构建期作用域检查升级为零依赖 JS 词法分析器；不改生成链契约与工具名，全量 113 套回归全绿。★ 1.2.0：UI 全折叠 + 双拖拽上传、人物替换（Rust 纯 CPU 底座 + 身份节点发现 / 缺件降级引导）、PPT 讲解图片真写进 OOXML；不捆绑模型、不谎称换脸。★ 0.33.0 起许可改为 BSL 1.1（BUSL-1.1，非 OSI 开源许可）：除托管/代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用，2030-11-15 转 Apache-2.0；0.32.1 及更早仍 MIT、不追溯。★ 1.1.2：全量审计整改——安全围栏与出站守卫收口（矢量化端点补本机围栏、ASR 端点回环校验、路径防链接越界复验），长任务超时透传、队列生命周期加固，媒体路由流式化＋Range 拖动，探测结果缓存提速分镜合成；API 与工具名零变更。★ 1.1.0：全面提速——内置 resvg 光栅 7.02× / 静态帧去重+VFR 合成 6.58× / 分镜缓存 34.2× / 草稿档 2.10×，TE-Speed 生图链真机 −17.3%，编码择优纠错（x264 排 AMF 前）、BGM 三缓存、Qwen3-TTS attention 可选 + 低延迟分块；未实测的一律不吹倍率。★ 1.0.0：选模型「假成功」根治（拒绝时如实回未生效 + 原因，不再无条件报已选）、优化面板与素材库白条同源修复（持久化缓存 + 占位 + 错误态）、历史筛选分页与重复请求收口、所有写参数拒绝统一 choiceResult。★ 0.35.0：口语入口别名（「风格卡」「批量出图」…）解析成真实工具、参考图色调取样写进提示词、建议时间轴 / 资源需求声明 / 数据流摘要 / 「刚才那张」产出短引用全部接进主链路。★ 0.34.0：SageAttention / Comfy-WaveSpeed 并入加速链并按真实 /object_info 探测、卡片常驻显示；GPT-SoVITS v5 / IndexTTS2 可选 TTS、拖音频零样本克隆、ACE-Step 1.5 / YuE2 音乐 BGM、手动超分、Worker 热温冷保活。0.33.0 新增媒体格式转换（图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC，生成物可指定输出格式、动图转视频、自有素材转换，Agent 可直接调用 convert_media）与加速链全景（生图/视频缓存后端 + TTS 加速 + 显存预算 + 配置裁决 + 结构化日志，只列探测到的、未实测不写倍率）、本机能力功能区内嵌进 Comfy 控制面板（展开页恒在悬浮球正上方、边框对齐 DSH 右边框、四事件点按兜底）、GIF 转换 / 运行期自诊断 / 优先级任务队列 / 单图迭代优化 / 自适应 DAG 编排 / 生成历史可删改与冷热分离等本机工具与端点；0.32.1 两轮审计加固：ASR 音频路径围栏（只认出图目录内文件）、按包名安装也能执行引导脚本、草图台四事件点按、错误响应消毒收口；视频链清单化 + 生图/TTS 契约对账（改图自动报差异）；生图/视频/混合三模式界面各不同；批量出图带幂等保护（重试不重出）；Qwen3-TTS 语音克隆与可接 ASR 自动字幕；本机实测秒数；会话级模型驻留、显存建议、参数来源表、预设绑定、加载器盘点等本机端点。文生视频 / 图生视频（Wan 2.2 / XT-5B）与图→音→视频混合、导入音频直接合进成片（音轨合成），文生图与 1–16 张参考图编辑、圈选重绘（羽化 / 边缘融合 / 外扩 / 反选 / 重绘强度可调）/ 元素移除 / 四向扩图 / 高清放大，Qwen3-TTS 语音合成（独立 generate_speech，参考音频可复刻音色），模型无关角色参考；草图台手绘参考；生成记录可检索（菜单最上面「历史」，SQLite 索引、软删除不动磁盘文件）。CPU 也能跑：自动识别 AVX2 / AVX512 / AVX512-BF16 指令集并给五档加速（含 --cpu 强制纯 CPU）、按物理核钉线程，任务结束可选自动卸载模型内存；安装入口是常驻的图形化引导面板。对外提供脱敏状态快照与端点目录供外部集成。提供可选、默认关闭的模型自动下载包：视频模型 --video-models、核显档位 --igpu-download、生图主模型 --tier，按服务器权威 size + sha256 双校验；音频权重不自动下载，缺件给明确清单。经本机 ComfyUI 调用，数据仅走 127.0.0.1 回环（联网参考图检索默认拒绝、须逐次同意），无需 API 密钥、零调用费用。Windows / Linux，NVIDIA / Intel Arc / AMD / 核显共享内存，含 8 GB 低内存档位。

## Features

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 文生图 | `draw_image` | 按提示词出图，成品落盘并直接显示在会话里 |
| 图生图 / 多参考图编辑 | `draw_image` | 1–16 张参考图（0.19.0 起），按序号接入 `images.image_N` |
| 局部重绘 | `inpaint_image` | 蒙版内重绘，裁剪回贴 |
| 元素移除 | `remove_image` | 移除蒙版内物体并补全背景 |
| 四向扩图 | `outpaint_image` | 上 / 下 / 左 / 右按百分比外扩 |
| 高清放大 | `upscale_image` | 与内置放大共用同一套节点图 |
| 角色参考（模型无关） | `draw_image` / `generate_video` | 可选 `referenceStrategy`：按后端 `/object_info` 真实能力协商，协商不到专属适配器自动回落通用兜底 |
| 文生视频 / 图生视频 | `generate_video` | 经本机 ComfyUI 调用 Wan 2.2 / XT-5B 系列视频模型，成品落盘并显示在会话里；支持首帧 I2V（`startImage`）与尾帧参考（`endImage`，仅当本机节点契约有 `end_image` 槽，0.39.0 无 → 如实报错） |
| 语音合成（TTS） | `generate_speech`（独立） / `generate_hybrid`（三段中的一段） | 本机 `ComfyUI-Qwen-TTS` + Qwen3-TTS 权重，产出 mp3 / flac（按 ComfyUI 返回的真实扩展名）；两条路共用同一条 TTS 段，只想配音不必跑完三段，**插件不自动下载音频模型** |
| 图→音→视频混合 | `generate_hybrid` | 一张图配一段语音再合成视频，适合做带旁白的短片 |
| 生成历史（可搜索） | `list_generated_images` | 本机 SQLite 记录每次生成的提示词 / 参数 / 时间 / 路径，支持关键词、类型、日期筛选与分页；界面里可看大图、复制路径、从历史移除（**只划掉记录，不删磁盘文件**） |

- **模型自动下载包（可选）**：`node scripts/setup.mjs --video-models` 提供**视频模型自动下载包** —— 默认不装、需你显式执行，官方仓库文件清单运行时动态列举、由你选档位，多源轮询 + 断点续传 + 服务器权威 size + sha256 双校验，不合格删除；核显档位另有 `--igpu-download`（同样默认关闭）。音频模型权重**不自动下载**，缺件只给清单。
- **本地、免 API**：出图数据（提示词与图片）只发往本机 `127.0.0.1` / `localhost` / `::1` 的 ComfyUI，由 `lib/net-guard.js` 在代码层强制；**无需任何 API 密钥，不产生调用费用**。
- **模型与运行**：经本机 **ComfyUI** 调用 **Qwen-Image 2.1 / 官方 Turbo**（图）、**Wan 2.2 / XT-5B 系列**（视频）与 **Qwen3-TTS**（语音），无需云端模型服务。
- **平台**：Windows / Linux，自动适配 NVIDIA / Intel Arc / AMD 显卡，也支持 Intel / AMD **核显共享内存**（含 8 GB 低内存档位）。
- **CPU 加速档（可选，默认关）**：按 CPU 指令集给五档 `cpuAccel`（`off` / `safe` / `balanced` / `max` / `force-cpu`），安装引导面板里逐档显示「**这台机器上真实会挂什么参数**」；默认 `off` = 一个参数都不加。详见 0.2.0 更新说明。
- **生成历史（0.3.0）**：每次出图 / 视频 / 配音都会写一条到 `<outputDir>/.qwen-paint-history.db`（SQLite，用 Node 内置 `node:sqlite`，零外部依赖）。菜单**最上面**「历史 → 生成历史」可按关键词 / 类型 / 日期翻旧账、看大图、复制路径；「移除」只从列表划掉，**不动磁盘文件**。Agent 侧对应工具 `list_generated_images`，可以「把上周那只柴犬找出来再改」。⚠ 持久化需要 **Node >= 22.5**；更低版本不假装有历史，如实降级为「只读本次会话记忆日志」。
- **DSH 兼容**：`>=0.2.0-rc.2`（见 `package.json` 的 `dsh.compatibility`）。

## Installation

> **不想碰命令行**：双击仓库根目录的 `一键安装.cmd` —— 它会先自报版本与 `setup.mjs` 指纹，检测后问一句再装。

**命令行安装**（`dsh plugin add` 的本地目录形式）：

```bash
dsh plugin --profile desktop add link:<本插件目录的绝对路径>
```

> 使用 `desktop` profile 时须**先完全退出 DSH**。本包在 npm 的包名为 `dsh-qwen-paint`（仓库当前 `1.2.1`），可直接 `dsh plugin add dsh-qwen-paint` 按包名安装；本地目录 / 本地包形式仅用于开发或试用未发布改动。完整步骤、profile 选择与排错见下文「安装」及 `INSTALL.md`。

## Usage

在对话里直接说需求即可，助手会调用对应工具：

```text
画一张雨夜的赛博城市，16:9
把这张图左边扩出去 30%
擦掉画面里的路人
```

## 快速上手 · 功能在哪点（不用记工具名）

装完重启 DSH 后，**输入框右下角的状态点**是总入口；生成的**每张图片下方**也直接摆了按钮。

| 想做的事 | 在哪点 |
| --- | --- |
| 出图 / 图生视频 | 直接说话：「画一只橘猫」「把这张图做成 5 秒视频」 |
| **圈选重绘**：手动涂出要改的地方 | 结果图下方「圈选重绘」，或直接点图片 → 用画笔把要改的地方涂白 → 写一句要改成什么（也可点常用说法） |
| **移除物体** | 结果图下方「更多编辑」→「移除物体」→ 涂出要去掉的东西 → 点「移除并补全」，不用写提示词 |
| **四向扩图 / 高清放大** | 「更多编辑」→ 点预设（四周各 20%、左右各 30%、2/4/8 倍…），不用填参数 |
| 选一张以前的图来编辑 | 菜单**最上面**「常用（点开就能用）」→「图片编辑台」列出最近生成的图；或「圈选重绘最近一张图」懒人直达 |
| **翻旧账**：找上周生成的那张图 | 菜单**最上面**「历史」→「生成历史」 | 按关键词 / 类型 / 日期筛，点缩略图看大图，可复制路径贴到别处；「移除」只从列表划掉，不会删你的文件 |
| **视频选帧去修**：只改中间某一帧 | 菜单「视频（选帧改 → 截一段）」→ 拖进度条或 `←` `→` 逐帧 →「抽这一帧去修」→ 直接进圈选重绘（**不需要 ffmpeg**） |
| **截取视频的一段** | 同一个浮层：按帧数（起始/结束帧）或按时间（`0:01.5`）选 →「截取这一段」；也可「按间隔抽帧」批量取关键帧（这两项需要 ffmpeg） |
| **缩略图轨道 / 把改稿贴回视频** | 同一个浮层：加载后自动生成 10 张缩略图，点一下跳到该处；改完图点「把改好的图贴回这一帧」→ 选最近改好的图 → 产出新 mp4（缩略图零依赖；**贴回需要 ffmpeg**，没装会明确提示） |
| 画幅 / 速度 / 负面词 / CFG / 角色参考 | 「Comfy 控制」浮标面板（可拖动） |

> 圈选重绘一直是"点结果图"触发的，但以前只有一个鼠标悬停提示，很多人以为没这功能 ——
> 现在每张结果图下面都有可见按钮。「就绪清单自检」（菜单「自检与修复」组）是**环境体检**，不是使用教学；图形化的安装引导是另一个独立入口，两者不再共用「向导」这个名字。

完整的 30 秒验证步骤、功能速查表、第一次上手走法和「没反应怎么自查」，见 **`INSTALL.md` 第五节**；
把安装交给 DSH 时用 `给DSH安装的话.md`，里面也补了「装完之后」那段引导。

也可显式调用工具：`draw_image`（`prompt` / `references`）、`generate_video`、`generate_speech`（`text`）、`generate_hybrid`、`inpaint_image`（`image` / `mask` / `prompt`）、`remove_image`、`outpaint_image`、`upscale_image`。完整参数与出图路径见下文「用法」「出图落在哪」。

## 网络边界（请以本节为准）

插件的网络出口有**三类，边界不同**。

**① 出图数据流**（提示词、参考图）—— 只发往 `comfyUrl`（ComfyUI）与 `hipfireUrl`（hipfire serve）。
**默认仅本机回环**（`127.0.0.1` / `localhost` / `::1`），且这一约束**由代码层强制**（`lib/net-guard.js`）：
任一地址被配成本机以外时，**插件会拒绝启动**而不是照发请求。所有出站请求统一走 `guardedFetch`，
强制 `redirect: 'error'`（不跟随任何 HTTP 重定向）。因此**出图全程不依赖外部网络，无需任何 API 密钥，亦不产生调用费用**。

**② 加速包下载**（可选，**默认开启**）—— `accelAutoInstall`（默认 `true`）时，插件会从 **pip 源与 GitHub**
下载厂商专用加速包（`pip install --upgrade` / `git clone`）。**这会访问外部地址**，
但**不发送任何提示词或图片**。设为 `accelAutoInstall: false` 即可完全关闭，出图功能不受影响。
详见下文「权限与已知风险」。

**③ 联网参考图检索**（可选，**默认拒绝**）—— 配置项 `referenceSearchEndpoint` 默认是占位符
`<API_ENDPOINT>`，**未替换时任何检索请求都被同意门直接拒绝**，插件保持纯离线。替换成你自己指定的
外部 `https` 端点后，仍必须**每次检索单独显式同意**（`consent: true`；面板上是「仅本次同意并检索」
按钮，点一次只管一次，没有"记住同意"的常开开关）。出站载荷由白名单重新构造，只有
`query` / `limit` / `media` 三个字段，**不含提示词、seed、本机路径或凭据**；端点与候选 URL
都拒绝回环 / 内网 / 云元数据地址（含 IPv6 形态）以防 SSRF，且不跟随重定向。
插件**只返回候选图片 URL，不自动下载远程字节**；你选定后自行保存，再走既有的本地参考图上传流程。
详见下文「角色参考（模型无关）与联网参考图检索」。

> ⚠ 为如实披露能力：插件提供了 `allowRemoteComfy` 开关（默认 `false`）。用户**显式**设为 `true` 后，
> 才可把 `comfyUrl` / `hipfireUrl` 指向局域网（如 `192.168.1.100`）或远程主机——此时插件会向你指定的地址发送提示词与图片数据。
> 这是**用户主动选择**的行为，不是默认状态。

> **QQ 交流群**：`454707710`　｜　**反馈 / 提问 / 提需求**都走这里，issue 也欢迎：<https://github.com/yanfei0725/dsh-qwen-paint/issues>

> **原作者**：@奇迹与你　｜　**优化版作者**：@yanfei0725　｜　**许可协议**：BSL 1.1（BUSL-1.1）　｜　**当前版本**：`1.2.1`　｜　仓库：<https://github.com/yanfei0725/dsh-qwen-paint>

---

## 角色参考（模型无关）与联网参考图检索

### 它解决什么

同一个角色跨多张图 / 多段视频保持形象一致。这里**没有绑定任何具体模型**：不要求本机装 Qwen、
Wan、ControlNet 或 IP-Adapter，也不要求额外权重。新增模型只需往策略表里加一条数据，
不需要写模型专用分支。

### 三层机制（按运行时能力协商）

| 层 | 机制 | 前提 |
| --- | --- | --- |
| 参数层 | 固定 seed / 锚定关键帧 / 段间 overlap | 无 |
| 节点层 | 按后端 `/object_info` 的**真实节点集合**选策略（`requires` 取 AND、`requiresAny` 取 OR，按优先级排） | 后端在线且装了对应节点 |
| 通用兜底 | 只用任何扩散模型都有的基础节点：生图找带 `latent_image` 输入的节点并接 `VAEEncode`；视频找带 `start_image` 输入的节点接首帧 | 无 |

协商不到专属适配器时**自动回落通用兜底**，并在 `notes` 里如实写明回落，不假装启用了点名的策略。
找节点靠 `/object_info` 自报的输入槽而不是靠类名猜：需要补可选槽时，后端没自报该槽就**不落地**
（`applied: false` + 说明），绝不提交一个 ComfyUI 必拒的节点、也不给节点凭空加输入来假装"通用"。
VAE 优先复用解码节点已有的 `vae` 接线，`denoise` 只改本来就有该输入的节点。

### 零漂移保证

**不启用 = 逐字节不变**。只有同时满足「显式给了 `referenceStrategy`（或面板选了策略）」、
「确实有参考图」、「计划能落地」三个条件时才会改工作流；否则 `adaptReference()` 返回
**原工作流对象引用**，连 `structuredClone` 都不做，`__plan` / `__effective` / `__cnet`
等不可枚举元信息完整保留。真正注入节点后会用 `workflow-meta` 重建这些元信息。
视频侧未启用策略时，参考图不上传、工作流不改动，纯文生视频行为不变。

### 参数与本机端点

- `draw_image` / `generate_video` 新增可选参数 `referenceStrategy`（`'auto'` 或具体策略 id；
  **不在 required 里**）。优先级：**显式工具入参 > 面板选择 > 未启用**。
  面板选择只存进程内存，不写配置、不写记忆，重启回默认。
- `GET /api/comfy-pipeline/reference?mode=image|video`：能力快照（节点数、可用策略清单、
  当前选中策略、视频分段计划、联网同意要求）。
- `POST /api/comfy-pipeline/reference/prefer`：写入面板选中的策略 id（`''` = 关闭）。
- `POST /api/comfy-pipeline/reference/adapt`：纯工作流变换，只返回结果供检视，
  不提交 ComfyUI、不下载任何字节。
- `POST /api/comfy-pipeline/reference/search`：联网候选检索，见下。
- 四个端点都只允许本机请求；三个写端点另过 `guardWriteRequest`（POST + `application/json`）。

### 联网检索：默认拒绝，逐次同意

`referenceSearchEndpoint` 默认为占位符，**不替换就一律拒绝**。即使替换了合法 https 端点，
也必须在**每一次**请求里显式给 `consent: true`；面板上的「仅本次同意并检索」按钮点一次只管一次，
没有常开开关。只返回候选 URL，插件不下载远程图片字节，面板也只以文本方式列出 URL
（渲染 `<img>` 会让浏览器自动下载，等于绕过同意门）。

### 诚实边界

- 视频角色一致性目前只产出**分段计划**（固定 seed / 锚定首帧 / 段间 overlap），
  **未自动接入 RIFE 或时序平滑节点**，计划里会明确标注，不谎称已平滑。
- 专属适配器需要对应权重；没装就回落通用兜底，约束强度取决于后端能力，不承诺跨模型同等效果。
- `/object_info` 不可达时能力清单查不到，但通用兜底仍可用于任何扩散模型。

---

## 生成历史：翻旧账与复用（0.3.1）

每次生成（图 / 视频 / 音频）都会在出图目录下留一条记录，存在 `<outputDir>/.qwen-paint-history.db`：

| 项 | 说明 |
| --- | --- |
| 存什么 | 提示词、工具名、模型、步数 / CFG / seed、尺寸、时间、文件路径。**只存相对 `outputDir` 的路径** —— 整体搬目录也不会失效，也不把本机绝对路径写进库 |
| 怎么查 | 菜单最上面「历史」→「生成历史」：关键词（提示词 / 文件名 / 模型）、类型（图 / 视频 / 音频 / 其它）、日期范围、分页 |
| 怎么用 | 点缩略图看大图；「复制路径」把**绝对路径**贴到别处（比如再交给 `draw_image` 的 `references`） |
| 怎么删 | 「移除」= 软删除（库里 `deleted=1`），**绝不删磁盘上的文件**；真想删自己去文件夹删 |
| Agent 侧 | 工具 `list_generated_images`（`keyword` / `kind` / `date_from` / `date_to` / `limit` / `offset`），纯本地只读、不调 ComfyUI |
| 端点 | `GET /api/qwen-paint/history`、`GET /api/qwen-paint/history/stats`、`POST /api/qwen-paint/history/delete` —— 均仅本机请求；写操作 POST + `application/json` |

### Node 版本与降级口径

`package.json` 的 `engines` 仍是 **`>=18.0.0`** —— 插件本体（出图 / 视频 / 语音 / 编辑）在 Node 18 上照常工作。
只有**历史持久化**依赖 Node 内置的 `node:sqlite`（**Node >= 22.5** 才有）：

| 你的 Node | 历史行为 |
| --- | --- |
| `>= 22.5` | 全量：SQLite 持久化，可搜索 / 分页 / 软删除；`available: true`、`persistent: true` |
| `< 22.5` | 降级：`available: false`、`persistent: false`，只能读既有 `.qwen-paint-memory.jsonl` 做内存过滤；界面与工具都会**明说「未持久化」**，不假装有数据 |

刻意**不**把 `engines` 提到 `>=22.5`：那会把一批能正常出图的用户直接挡在门外，代价只是少一个可搜索的历史库。

## 1.2.1 更新说明

> 从 1.2.0 到 1.2.1：这是一个**质量与可诊断性收口**补丁版本——历史库搜索升级 SQLite FTS5、运行期自诊断补齐真探针、OOM 建议跟上 ComfyUI v0.37、构建期作用域检查换成零依赖 JS 词法分析器。本轮全量回归 **113 套 / 0 失败 / 7,418 项断言**全绿。**不改三大能力的生成链契约，既有工具名与 API 语义不变**；1.2.0 及此前全部能力、速度与许可边界继续有效。诚实边界不变：未经真机自证的能力仍标「未检测 / 待自证」，不把离线回归写成真机通过。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。
- 外部 TTS 服务的合规边界不变：**GSV.CPP**（MIT，只做适配器 + 引导、不捆绑不代下）、**AnifLive-TTS**（原创代码 PolyForm Noncommercial 1.0.0 **禁商用**，只抄公开工程思路、不复制代码与二进制，商用须作者书面授权）。

### ★ 新工具与端点：本版零新增工具名，补齐既有能力
- 历史库关键词检索从全表 LIKE 升到 FTS5 索引（详见「联动护栏与回归」），`list_generated_images` 的参数与返回结构不变；doctor 的 8 项检查项 ID 不变，只把空转探针接成真探针。Agent 与端点调用方式零变更。

### ★ 加速链全景：本版不改任何倍率结论
- 1.1.0 的插件层实测数字继续有效：内置 resvg 光栅 **7.02×**、静态帧去重 + VFR + libx264 **6.58×**、草稿档 **2.10×**、分镜缓存命中 **34.2×**；TE-Speed **−17.3%** 仍为唯一稳定正收益。1.1.2 的探测缓存与 1.2.1 的诊断补齐只省重复开销 / 只说实话，不宣称新倍率。

### ★ 工作流清单层：承接 1.2.0
- `chain-manifest` 与图结构指纹基准继续生效；本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 1.2.0
- `event-log` 落盘 + 生成完成钩子不变；细分耗时口径不变（官方不提供的细分保持 `null`，不编数字），单调时钟口径不变。

### ★ UI 与交互：位置口径不变，`UI_BUILD` 维持 `2026-11-18.2`
- 功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。本版没有改 UI 资产，`UI_BUILD` 不升；真机刷新后 hover 浮标仍显示 `UI 2026-11-18.2`。1.2.0 的卡片折叠 / 双拖拽上传 / 人物替换 / PPT 图片继续有效，真机自证项见桌面验收清单。

### ★ 媒体格式转换：格式矩阵不变
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；媒体路由流式化 + Range 与缓存头口径承接 1.1.2。

### ★ 联动护栏与回归
- 全量回归 **113 套 / 0 失败 / 7,418 项断言**全绿（31.5s）；发布护栏 `test-release-metadata.mjs` 70/0。
- **历史库 FTS5**：`history-store.js` 以外部内容表 + trigram tokenizer + AFTER INSERT 触发器实现全文索引，关键词走 MATCH（1 万条实测 0.023ms vs LIKE 1.012ms，约 44×）；短词（<3 字符）与 FTS 不可用时自动回落 LIKE，旧库首次打开 rebuild 回填，phrase 包裹防查询语法注入。`test-history.mjs` 195/0。
- **doctor 真探针**：`tool-registry.js` 为 comfyOnline / accelPacks / ffmpeg / attentionBackend 接上真实探测；模型完整性与 TTS 权重仍如实标未检测，`attention_backend` 只查到节点存在时不谎报 pass。`test-accel-config.mjs` 79/0。
- **OOM 建议**：`diagnose-error.js` 补社区 8G 抄作业档（INT8 + nvfp4 + 低显存 / GGUF Q4_K_M + 768² 起步）与 ComfyUI v0.37 动态显存策略提示；15× 速度差标为社区量级、不承诺固定倍率。`test-batch-guard.mjs` 119/0。
- **构建期词法分析**：`_client_scope_test.mjs` 改用零依赖 `scripts/js-lexer.mjs` token 流，隔离字符串 / 注释 / 正则 / 模板；新增 `test-js-lexer.mjs` 22/0 并登记，仅构建期脚本、不进包、0 运行时依赖；反向核查注入 `${UNDEFINED_PROBE}` 精确变红、逐字节还原后复绿。
- `lib/index.js` **226,150 B / 上限 262,144 B，余量 35,994 B**。
- 反向核查：本轮所有改动均做过「改坏 → 精确变红 → 逐字节恢复」；未跑真机的项如实标注，不把离线回归写成真机通过。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.2.1，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 当前 **139 个 `lib/*.js`** / 合计 **2,067,668 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径）。

## 1.2.0 更新说明

> 从 1.1.2 到 1.2.0：这是一个**交互与本地能力扩展**版本——UI 卡片全折叠、PPT / 人物替换双拖拽上传、Rust 纯 CPU 人物贴图底座与身份节点发现 / 缺件降级、PPT 讲解图片真写进 OOXML。新增 3 条本机端点与 1 套专项回归；**不改三大能力的生成链契约，既有工具名与 API 语义不变**，1.1.2 及此前全部能力、速度与许可边界继续有效。诚实边界先说清：人物替换的本地 CPU 合成是**贴图预演**，不是像素级换脸；真身份保持重绘依赖本机 ComfyUI 装好身份节点与几 GB 权重，插件**不捆绑、不代下**，只做发现 + 引导 + 降级。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。
- 外部 TTS 服务的合规边界不变：**GSV.CPP**（MIT，只做适配器 + 引导、不捆绑不代下）、**AnifLive-TTS**（原创代码 PolyForm Noncommercial 1.0.0 **禁商用**，只抄公开工程思路、不复制代码与二进制，商用须作者书面授权）。

### ★ 新工具与端点：不新增 Agent 工具名，新增 3 条本机人物替换端点
- `/api/qwen-paint/portrait/capabilities`、`/portrait/register`、`/portrait/compose` 三条本机端点已注册进 `lib/tool-registry.js` 与端点目录；`make_pptx` 扩展 `slides[].images`，工具名零新增，Agent 既有调用方式不变。
- 身份节点发现覆盖 InstantID / PuLID / IP-Adapter FaceID / ReActor：`/object_info` 里发现即给「可跑」，缺件给「缺件 + 安装引导」，不谎称已具备真换脸能力。

### ★ 加速链全景：本版不改任何倍率结论
- 1.1.0 的插件层实测数字继续有效：内置 resvg 光栅 **7.02×**、静态帧去重 + VFR + libx264 **6.58×**、草稿档 **2.10×**、分镜缓存命中 **34.2×**；TE-Speed **−17.3%** 仍为唯一稳定正收益。1.1.2 的探测缓存只省重复开销，不宣称新倍率。本版未新增任何未经实测的倍率。

### ★ 工作流清单层：承接 1.1.2
- `chain-manifest` 与图结构指纹基准继续生效；本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 1.1.2
- `event-log` 落盘 + 生成完成钩子不变；细分耗时口径不变（官方不提供的细分保持 `null`，不编数字），单调时钟口径不变。

### ★ UI 与交互：`UI_BUILD` 升到 `2026-11-18.2` 供刷新自证
- 通用 `foldCard()` / `dropZone()`：混合链、素材库、角色参考、hybrid 四段模型选择改为可折叠卡片；PPT 卡加「讲解图片」多图拖拽区，人物替换卡加「参考图 / 场景图」「选定人物图」双拖拽区。新按钮用独立类名 `cp-pptx-go` / `cp-swap-go`，不与逐次同意检索按钮抢类名。
- 折叠 `toggle` 后调用 `syncPanelPos(nodes.fab, nodes.panel)`，面板高度变化仍保持底缘贴浮标上缘。位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。真机刷新后 hover 浮标应显示 `UI 2026-11-18.2`。
- 诚实边界：真机侧（拖图生成带图 PPT、人物替换双拖拽区、身份节点发现）尚未自证，代码与离线回归已就绪。

### ★ 媒体格式转换：格式矩阵不变
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；媒体路由流式化 + Range 与缓存头口径承接 1.1.2。PPT 输出新增图片类型，body 上限放宽到 48 MB。

### ★ 联动护栏与回归
- 本版新增 `test-local-portrait.mjs`（48/0）并登记进 `scripts/test-all.mjs`；`test-pptx-lite.mjs` 47/0、`test-ui-perf.mjs` 81/0。全量回归 **113 套，各套项全绿**。
- 构建期静态检查升级：`_client_scope_test.mjs` 从「正则 replace 抹字符串」换成零依赖 JS 词法分析器（`scripts/js-lexer.mjs`，token 流隔离字符串/注释/正则/模板）。新增 `test-js-lexer.mjs` 22/0 并登记；仅构建期脚本，不进插件包、不破 0 运行时依赖。反向核查：注入 `${UNDEFINED_PROBE}` 精确变红、逐字节还原后复绿。
- `lib/index.js` **226,150 B / 上限 262,144 B，余量 35,994 B**。
- 反向核查：PPT media 写入、人物路径围栏 / 结果解析 / 节点发现、UI_BUILD 与折叠几何均做过「改坏 → 精确变红 → 逐字节恢复」；PPT / 人物替换按钮因误复用 `.cp-ref-search` 触发真实回归，已改独立类名修好并复测，未改测试迁就。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.2.0，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 当前 **138 个 `lib/*.js`** / 合计 **2,077,512 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径；Windows 工作树受 `core.autocrlf` 影响略高；设计注释外置到 docs 后维持健康余量）。
- Rust CPU 底座源码与锁文件在 `tools-rust/dshqp-portrait/`，产物 `assets/bin/dshqp-portrait.exe` 随 `assets/` 走打包分发；本机 cargo 路径已做等长中性化，不夹带真实用户目录。
- **历史库关键词搜索升级到 SQLite FTS5**（零新依赖）：`history-store.js` 用 FTS5 外部内容表 + trigram tokenizer + AFTER INSERT 触发器，关键词走 MATCH 索引（1 万条实测 0.023ms vs LIKE 全表 1.012ms，44×）。短词（<3 字符）与 FTS 不可用时自动回落 LIKE；旧库首次打开自动 rebuild 回填；phrase 包裹防查询语法注入。`test-history.mjs` 补 16 项（索引同步/旧库迁移/软删除边界/降级）。
- **运行期自诊断与 OOM 建议补齐**（社区调研 A 类）：`doctor.js` 原有 8 项检查里 6 项探针空转，现用现有 deps 真接上 4 项（comfyOnline / accelPacks / ffmpeg / attentionBackend，后两者基于 `/object_info` 与 `mediaExec.probe`），模型完整性与 TTS 权重仍如实标未检测；`attention_backend` 只查到节点存在时不谎报 pass。`diagnose-error.js` 的 OOM 建议补上社区 8G 抄作业档（INT8 + nvfp4 + 低显存 / GGUF Q4_K_M + 768²起步）与 ComfyUI v0.37 动态显存策略提示，15× 速度差标为社区量级、不承诺固定倍率。

## 1.1.2 更新说明

> 从 1.1.1 到 1.1.2：这是一个**质量与安全收口**版本——两轮全量代码审计（文件/进程执行面、网络出站面、端点与隐私面、UI 层、性能面）的全部确认项落地：安全围栏补齐、长任务误杀修复、队列生命周期加固、媒体路由流式化、探测缓存提速。**不改三大能力的生成链契约，API 与工具名零变更，升级只需替换插件目录**；1.1.1 及此前全部能力与加速数字继续有效。审计采用「刻意设计甄别」纪律：每一处改动都先核对作者注释与提交历史，确认是遗漏才修、是设计就留痕不动（共甄别 30+ 项刻意设计，见 `docs/negative-results.md` 负结果清单）。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。
- 外部 TTS 服务的合规边界不变：**GSV.CPP**（MIT，只做适配器 + 引导、不捆绑不代下）、**AnifLive-TTS**（原创代码 PolyForm Noncommercial 1.0.0 **禁商用**，只抄公开工程思路、不复制代码与二进制，商用须作者书面授权）。

### ★ 新工具与端点：本版零新增工具，既有端点补齐安全围栏
- **矢量化端点补本机围栏**：`/api/qwen-paint/vectorize*` 此前是同族路由中唯一缺「仅本机」闸的（同期整改模块均已补、本模块被遗漏），跨站请求可触发外部引擎执行；现 GET/POST 均要求本机来源，与缝合 / PPTX 端点同口径。
- **ASR 端点接入统一出站守卫**：`asrUrl` 是第三个出站端点（本机 faster-whisper 等 OpenAI 兼容服务），此前转写上传与状态探测绕过回环校验；现与 comfyUrl/hipfireUrl 同判据（默认仅回环、`allowRemoteComfy` 显式放行 + 禁跟随重定向 + 启动时校验），「数据仅走 127.0.0.1 回环」的承诺在语音链路同样成立。
- **历史管理端点补媒体类型闸**：写操作（更新 / 恢复 / 清理 / 归档 / 硬删）现要求 `application/json`，堵住旧浏览器跨站简单请求面；硬删端点不再转发请求体里的文件操作参数（默认绝不删磁盘文件的语义保持）。
- **路径防链接越界复验**：媒体读取、音频转写输入、媒体转换输入、手动超分输入四类目录围栏全部增加 realpath 复验（实测可穿透文本比对的目录链接攻击被封堵）；输出侧经评估属纵深分层（植入链接本就需要本机写权限），维持原判据并留痕。

### ★ 加速链全景：本版不改任何倍率结论，只修「误杀」与「重复探测」
- 1.1.0 的插件层实测数字继续有效：内置 resvg 光栅 **7.02×**、静态帧去重 + VFR + libx264 **6.58×**、草稿档 **2.10×**、分镜缓存命中 **34.2×**；TE-Speed **−17.3%** 仍为唯一稳定正收益。
- **长任务超时透传修复**：媒体执行层此前丢弃调用方超时参数（恒 180 秒），5 分钟动画合成 / 30 分钟音频处理会被静默截断并误报「ffmpeg 执行失败」；现如实透传（下限 1 秒防呆）。
- **探测结果缓存**：resvg 可用性此前每帧重探一次（N 帧分镜 = N 次子进程）、硬件编码择优每次合成都重跑（2–6 个探测进程）；现成功结果进程内缓存、失败 30 秒重试——合成路径省 1–2 秒纯探测开销，分镜越多收益越大。诚实边界：这是消除重复开销，**不宣称新的合成倍率**。

### ★ 工作流清单层：承接 1.1.1
- `chain-manifest` 与图结构指纹基准继续生效；本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 1.1.1
- `event-log` 落盘 + 生成完成钩子不变；细分耗时口径不变（官方不提供的细分保持 `null`，不编数字）。另：全库超时 / 期限判断（批量等待、TTS 等音频、启动就绪等待、面板兜底计时）统一切换到单调时钟——系统校时回拨不再会造成「永不超时的挂起」或误判超时。

### ★ UI 与交互：`UI_BUILD` 升到 `2026-11-18.1` 供刷新自证
- **优化面板「假成功」根治补全**：开关与档位切换此前被后端拒绝时静默弹回、不说明原因（同一修复此前只覆盖了生图面板半边）；现如实显示「未生效：原因」。
- **面板自愈**：状态刷新统一走已记住的端点路径，桌面端桥接不覆盖 `/api/` 前缀时不再出现「点开关面板直接关闭」。
- 位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。真机刷新后 hover 浮标应显示 `UI 2026-11-18.1`。
- 本段为 1.1.2 **发布当时快照**；后续 1.2.0 已把 `UI_BUILD` 升到 **2026-11-18.2** 并新增卡片折叠 / 拖拽上传 / 人物替换 / PPT 图片，详见「1.2.0 更新说明」。

### ★ 媒体格式转换：格式矩阵不变，媒体路由流式化
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变。
- **媒体字节路由流式化 + Range**：此前整文件读入内存再回传（上限内的视频也整体进进程内存）、且不支持字节段（拖进度条要等全量传输）；现流式管道 + 单段 Range（206 / 416 语义完整），视频拖动只取所需字节段；已知媒体类型（生成文件名永不复用、内容不可变）改可缓存，历史面板重开不再逐图重传。

### ★ 联动护栏与回归
- 两轮审计全部发现按「确认遗漏才修、刻意设计留痕」处置；新增 / 扩展回归：目录链接穿透回归 4 项、队列生命周期（退避封顶 / 代次号防双执行 / 终态淘汰）6 项、端点围栏与媒体类型闸 8 项、客户端反馈一致性 3 项、媒体路由 Range / 缓存头 8 项等。
- 全量回归 **113 套，各套项全绿**；`lib/index.js` **226,150 B / 上限 262,144 B，余量 35,994 B**。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.1.2，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 新增 **`docs/negative-results.md` 负结果清单**：审计中「试过且被论证否定」的方向与外部工程教训逐条归档，防止重踩（与「未实测不吹倍率」同一条纪律的另一半）。
- 当前 **138 个 `lib/*.js`** / 合计 **2,060,037 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径；Windows 工作树受 `core.autocrlf` 影响略高；设计注释外置到 docs 后维持健康余量）。

## 1.1.1 更新说明

> 从 1.1.0 到 1.1.1：这是一个**只加不改**的小版本——唯一功能变更是 TTS 首段早出声（悬浮面板两段式），默认关闭、对既有用户零行为漂移；1.1.0 及此前全部能力与加速数字继续有效，API 与工具名零变更，升级只需替换插件目录。更新说明按发布护栏要求逐节列全，便于 Agent 与用户核对。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。
- 外部 TTS 服务的合规边界不变：**GSV.CPP**（MIT，只做适配器 + 引导、不捆绑不代下）、**AnifLive-TTS**（原创代码 PolyForm Noncommercial 1.0.0 **禁商用**，只抄公开工程思路、不复制代码与二进制，商用须作者书面授权）。

### ★ 新工具与端点：本版零新增工具，给 `generate_speech` 的 `lowLatencyChunks` 换更优实现
- `lowLatencyChunks`（默认 false）由「N 块逐段提交 + N 段拼接」改为**两段式**：首段短切先落盘并通过 `progress.ttsLive` 推给悬浮面板自动播一次，剩余整段一次提交，最后 ffmpeg concat 拼 m4a——省掉中间 N−2 次往返。诚实边界：**非节点级流式、整段总时长不变**，只是更早听到首段；块间语气可能断裂；缓存键区分 chunks/whole 防串味。
- 首段事件存单例 TTL store，只在面板开着时播放，自动播被浏览器拦则静默不报错；回环围栏不变（只认本机 127.0.0.1）。

### ★ 加速链全景：承接 1.1.0，本版不改任何倍率结论
- 1.1.0 的插件层实测数字继续有效：内置 resvg 光栅 **7.02×**、静态帧去重 + VFR + libx264 **6.58×**、草稿档 **2.10×**、分镜缓存命中 **34.2×**；ComfyUI 生图链 TE-Speed **−17.3%** 仍为唯一稳定正收益。
- 本版 TTS 两段式**不宣称倍率**：目标是「首段更早落盘 + 更早听到」，整段总耗时的真实 A/B 需要模型常驻、固定单档、丢弃首轮后多轮测量，当前未做，不编数字。attention 真机样本离散与回退事实见 1.1.0 章节，不重复结论。

### ★ 工作流清单层：承接 1.1.0
- `chain-manifest` 与图结构指纹基准继续生效，后者只在回归里跑、不参与运行时构图。本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 1.1.0
- `event-log` 落盘 + 生成完成钩子不变；细分耗时 `queue` / `total` 来自 ComfyUI `/history` 真实时间戳，`load/sample/decode` 官方不提供，保持 `null`（不编数字）。

### ★ UI 与交互：`UI_BUILD` 升到 `2026-11-17.2` 供刷新自证
- 悬浮面板新增首段音频自动播放（按 `path@at` 去重、一次事件只播一次）；`generate_speech` 面板开着才听得到首段。
- 位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。真机刷新后 hover 浮标应显示 `UI 2026-11-17.2`。

### ★ 媒体格式转换：承接 1.1.0
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；`file` 路由补 `.m4a/.aac/.ogg/.opus` MIME 以便面板播放首段音频，转码路径不变。

### ★ 联动护栏与回归
- `test-tts-lowlatency.mjs` 扩展两段式规划、首段回调时序、`progress.ttsLive`、面板播放与 file MIME 断言，并做「改坏三处 → 精确变红 → 逐字恢复 md5 一致」反向核查；`test-ui-perf.mjs` 同步 build 断言。
- 全量回归 **110 套，各套项全绿**；`lib/index.js` **226,150 B / 上限 262,144 B，余量 35,994 B**；体积曾因本版超 2,645 B，按纪律外置 4 个文件头注释到 `docs/tts-early-audio-design-notes.md`（逐字留锚点）后守卫恢复通过。2026-11-17 全量审计整改（安全修复 + 测试扩展）后按真实值回填。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.1.1，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 两份 llms 以代码字体点名全部工具与端点；`TOOL_SUMMARIES` / `agent-guide` / 端点目录保持同步。
- 当前 **136 个 `lib/*.js`** / 合计 **2,038,715 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径；Windows 工作树受 `core.autocrlf` 影响略高。2026-11-17 全量审计：config.js / client.js 纯设计注释外置到 docs，余量 550 B → 76 KB；2026-11-18 第二轮整改后余量 57.1 KB）。
- 真机自证清单（如实列为未完成）：DSH 宿主启动后刷新页面 hover 自证 `UI 2026-11-17.2`、开面板跑 `lowLatencyChunks:true` 听首段是否先播、PPT 加速链档位按钮显示、`smoke.mjs --submit` 真出图、layout 中文可见性、8 GB 核显速度。

## 1.1.0 更新说明

> 从 1.0.0 到 1.1.0：这一版**不改三大能力的生成链契约**，专治两件事——① 1.0.0 之后积压的全部工作树改动一次性收口（补缺模块 / hyperframes §13 四项 / UI 整改 / 体积根治）；② 把「说快了却没实测」的加速说法变成可复核的真机数字与诚实边界。1.0.0 及此前全部能力继续有效，API 与工具名零变更，升级只需替换插件目录。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。
- 外部 TTS 服务的合规边界写死在清单里：**GSV.CPP**（MIT，一键包 3.16 GB / g2pw 前端 608 MB，只做适配器 + 引导、不捆绑不代下）；**AnifLive-TTS**（原创代码 PolyForm Noncommercial 1.0.0 **禁商用**，只抄公开工程思路、不复制代码与二进制，商用须作者书面授权）。第三方截图里的 74.6 ms / 2–3× 是作者特定硬件的历史宣称，**本插件未复测、不写进结论**。

### ★ 新工具与端点：承接 1.0.0，本版给已有工具补真实能力
- 四个纯 JS 新工具（`plan_storyboard` / `render_frame` / `compose_video` / `layout_frame`）与补缺模块（队列端点、ControlNet 预处理纯逻辑、段级续跑账本、WS 渐进预览、外部工作流导入）全部接进生产链，非孤儿。
- `generate_speech` 新增 `attention`（`auto / sage_attn / flash_attn / sdpa / eager`，默认不写 = 节点自身 auto 零漂移）与 `lowLatencyChunks`（默认 false：两段式——首段短切先落盘并推给悬浮面板自动播一次、剩余整段一次提交、ffmpeg concat 拼 m4a；**非节点级流式，整段时长不变**，首段先听而已，块间语气可能断裂，缓存键区分 chunks/whole 防串味）。首段事件走 `progress.ttsLive`（单例 TTL 有界），面板开着才播、自动播被浏览器拦则静默不报错。
- `list_tts_backends` 与 `/api/qwen-paint/tts/backends` 新增 `external_services`：对 127.0.0.1 上的外部 TTS 服务真实探活并回传在线状态、失败原因、许可证与引导，只许回环地址、不放行任意 host。

### ★ 加速链全景：从「列节点」升级到「有真机数字与诚实边界」
- **本机实测的插件层优化**：内置 resvg 光栅 **7.02×**（600.50 ms → 85.51 ms）、静态帧去重 + VFR + libx264 **6.58×**（870.49 ms → 132.20 ms）、草稿档合成 **2.10×**、分镜缓存命中 **34.2×**、下拉增量回填 DOM 操作 −99.7%、TTS 旁白缓存命中 0.21 ms。
- **编码择优纠错**：`ENCODE_PRIORITY` 由 NVENC→QSV→AMF→libx264 改为 **NVENC→QSV→libx264→AMF**，消除本机「AMF 可用但慢 12.9%–38.3%」的误选；这是「可用性 + 保守顺序」择优，不是速度基准择优。
- **ComfyUI 加速节点真机对照**（官方 8 步 turbo 链，1024²，每轮换 seed 防 prompt 缓存）：baseline 9,910 ms、TE-Speed **8,197 ms（−17.3%，唯一稳定正收益）**、TE-Speed+sage 8,687 ms（−12.3%）、Speedup +1.1%、BlockCache T8 **+8.9%（更慢）**、FBCache 与该链不兼容。历史 turbo8 −86% / BlockCache +22.7% 来自不同模型 / 分辨率 / 版本，**不可比，不冒充当前值**。
- TTS attention 真机只确认「参数可控、auto 实际选 sage_attn、flash_attn 静默回退 eager、每次切换清缓存重载模型 10–40 s」；样本离散过大，**不宣称任何 attention 更快**。

### ★ 工作流清单层：承接 1.0.0
- `chain-manifest`（运行时清单目录）与图结构指纹基准（回归期逐槽位对账）继续生效，后者只在回归里跑、不参与运行时构图。本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 1.0.0
- `event-log` 落盘 + 生成完成钩子不变；细分耗时 `queue` / `total` 来自 ComfyUI `/history` 真实时间戳，`load/sample/decode` 官方不提供，保持 `null`（不编数字）。

### ★ UI 与交互：档位可见 + 错误可诊断 + build 自证
- 「本机能力 / 加速链」面板并入 Comfy 控制面板：SageAttention / WaveSpeed / 恢复默认三档按钮真存在；实验室独立浮层已删除，只挂 `cp-panel` 的插槽，找不到就不挂。
- 「本机请求失败」一类笼统报错拆成「连不上本机服务：ComfyUI 可能未启动」与「本机服务返回异常（HTTP n）」两种可诊断文案；真宿主未启动导致的 404 由用户侧启动解决，插件不假装已连通。
- 位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。`UI_BUILD` 升到 `2026-11-17.2`（TTS 首段早出声）供刷新自证。

### ★ 媒体格式转换：承接 1.0.0
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；本版不改转码路径。新增 ffmpeg concat 用于低延迟分块的音频顺序拼接。

### ★ 联动护栏与回归
- 新增 `test-bgm-opt.mjs`（30 项，含假 ffmpeg 真链路：首次执行 / 二次跳过 / 关缓存强制重跑）、`test-tts-lowlatency.mjs`（48 项，含回环围栏反向核查）、`test-tts-workflow.mjs` attention 契约 7 条、`test-ui-perf.mjs` 3 条错误文案与 build 断言，全部登记 SUITES。
- BGM 三块优化接进生产链：音乐计划缓存（`generate_music`）、ducking 缝合缓存（`mix_narration` / `av-stitch`，`stitchCache:false` 可关）、§7 装配计划（`/music/models`，模型 / 权重项标 blocked 不谎称）。
- 全量回归 **110 套，各套项全绿**（断言总数刻意不写死；103 套 + 补缺批 `test-gap-fill.mjs` + 动画三件套 `test-animation-kit.mjs` + 动画四项优化 `test-anim-opt.mjs` + 渲染后端 `test-render-backends.mjs` + 版式/VFR/TTS 缓存 `test-layout-vfr-ttscache.mjs` + BGM 优化 `test-bgm-opt.mjs` + 外部 TTS 低延迟编排 `test-tts-lowlatency.mjs`）；`lib/index.js` **224,521 B / 上限 262,144 B，余量 37,623 B**；`lib/client.js` 217,489 B。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.1.0，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 两份 llms 以代码字体点名全部工具与端点；`TOOL_SUMMARIES` / `agent-guide` / 端点目录保持同步。
- 当前 **136 个 `lib/*.js`** / 合计 **2,095,867 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径；Windows 工作树受 `core.autocrlf` 影响略高）。体积根治靠「新功能走独立模块 + 零 index 增长注册 + 纯说明性文件头注释逐字外置到 docs」，逐字可逆；内置 `assets/bin/resvg.exe`（v0.50.0，双许可证随包分发）为默认光栅后端、stdin 送 SVG 收 PNG，探测不到一律降级保留 SVG，中文渲染依赖系统字体、缺字时自检判为不安全并降级。
- 真机自证清单（本版如实列为未完成）：DSH 宿主启动后刷新页面 hover 自证 `UI 2026-11-17.1`、layout 中文可见性、混合四段回显、TTS 后端 / 音色在混合链真生效、ASR 真转写、编辑台 picker 点按、PPT 加速链档位按钮显示、`smoke.mjs --submit` 真出图、8 GB 核显速度。

## 1.0.0 更新说明

> 从 0.35.0 到 1.0.0：这一版不改生成链、不加新工具，专治「界面说生效、实际没生效」这一类**静默谎言**。0.35.0 及此前全部能力继续有效。API 与工具名零变更，升级只需替换插件目录。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。本版没有改动许可文本，也没有新增任何限制。

### ★ 新工具与端点：本版零新增，全部写参数诚实回传
- 工具与端点清单与 0.35.0 **逐字一致**（5 个外置工具 + 3 条端点，合计 29 个工具 / 78 条端点），没有影子工具、没有幽灵端点。
- 但 `POST /status.json` 的响应新增 `choiceResult: { ok, rejections[] }`：**任何写操作被拒都回传 label / value / reason**，顶层 `ok` 仍只表示端点自身健康（三处状态轮询依赖它，没有被拖下水）。

### ★ 加速链全景：承接 0.35.0，本版只补可观测性
- SageAttention / Comfy-WaveSpeed 的探测、工作流补丁、卡片常驻显示全部不变；真机节点名 `ApplyFBCacheOnModel` 与 `residual_diff_threshold=0.08` 的保守默认值不变。
- 新增只读 `objectInfoCacheStatus()`，暴露 `failed` / `ageMs` / `info` —— 探测不到节点时，终于能看出「是没装、还是失败冷却里」。`/object_info` 失败也写时间戳，1 分钟冷却（成功仍走 10 分钟 TTL），ComfyUI 忙时不再每轮白等 30 秒。

### ★ 工作流清单层：承接 0.35.0
- `chain-manifest`（运行时清单目录）与图结构指纹基准（回归期逐槽位对账，`workflow-fingerprint.js` + `scripts/workflow-fingerprints.json`）继续生效，后者**只在回归里跑、不参与运行时构图**。本版不改生成链，默认路径逐字节不变。

### ★ 结构化运行日志：承接 0.35.0
- `event-log` 落盘 + 生成完成钩子不变；细分耗时 `queue` / `total` 来自 ComfyUI `/history` 真实时间戳，`load/sample/decode` 官方不提供，保持 `null`（不编数字）。

### ★ UI 与交互：白条同源 + 假成功根治
- **选模型假成功**：后端白名单拒绝不再只写日志；前端按 `choiceResult` 显示「未生效：\<真实原因\>」，并按 label 认领自己的拒绝原因，不张冠李戴。区分「清单此刻不可用」与「候选是缓存里的旧模型，已删或改名」——后一种是持久化缓存叠加后的隐藏复现路径。
- **两处白条同源**：优化面板权重下拉（主 / LoRA / ControlNet）复用主模型那套持久化缓存 + 禁用占位，命中即同步回填、后台静默刷新，保留 `fileLabels` 干净名与「已失效」标注；素材库设计风格下拉创建时就有禁用占位，失败落错误态，空 `catch` 已删。
- **假就绪 / 首帧空白**：面板候选未到时显示「（候选清单加载中…）」，`Promise.allSettled` 全部落地后再收口；历史面板首帧给读取中占位。
- 位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。

### ★ 媒体格式转换：承接 0.35.0
- 图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；本版不改转码路径。

### ★ 联动护栏与回归
- 新增 `scripts/test-white-bar.mjs`（48 项）：缓存纯函数与失败冷却是**真调用**（vm 拿 client factory / 真跑 mock fetchFn），其余锁关键分支；反向核查「改坏失败时间戳 → 2 项红」「改坏 total 拆分 → 1 项红」，恢复后 md5 一致。
- 历史分页：`store.query()` 的**筛选后**总数与 `store.stats()` 的**全量**总数拆成 `total` / `allTotal`，stats 绝不碰分页基数 —— 修掉「筛选 3 条却显示 100 条、翻页全空白」的竞态。
- 全量回归 **110 套，各套项全绿**（断言总数刻意不写死；103 套 + 补缺批 `test-gap-fill.mjs` + 动画三件套 `test-animation-kit.mjs` + 动画四项优化 `test-anim-opt.mjs` + 渲染后端 `test-render-backends.mjs` + 版式/VFR/TTS 缓存 `test-layout-vfr-ttscache.mjs` + BGM 优化 `test-bgm-opt.mjs` + 外部 TTS 低延迟编排 `test-tts-lowlatency.mjs`）；`lib/index.js` **224,521 B / 上限 262,144 B，余量 37,623 B**（1.0.0 发布时 206,499 B / 余 55,645 B；本轮补缺后经 slim-comments 外置长设计说明，仍走外置注册层）；`lib/client.js` 217,489 B。
- 全项目假绿双向扫描：99 个套件的断言函数签名 vs 调用方式全查，两个方向均无参数颠倒；工作树新增行经隐私预检零命中。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 1.0.0，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 两份 llms 以代码字体点名全部工具与端点；`TOOL_SUMMARIES` / `agent-guide` / 端点目录保持同步。
- 当前 **136 个 `lib/*.js`** / 合计 **2,095,867 B**（按规范化 LF 字节计，与 git blob / CI checkout 同口径；Windows 工作树受 `core.autocrlf` 影响略高）。新增 `lib/anim-opt.js`（动画四项纯 JS 优化：静态帧去重 / 分镜级缓存 / 草稿定稿档 / 时序校验前置，hyperframes 清单 §13 可映射项）、`lib/render-backends.js`（硬件编码择优 + resvg 光栅探测，**内置优先**、未启用绝不谎称）、`lib/anim-cache.js`（静态瓦片缓存 + 可插拔渲染后端接口）；并把 1.0.0 后新增模块的纯设计注释外置到 `docs/added-modules-design-notes.md` 与 `docs/backend-headers-design-notes.md`（逐字可逆自检），根治了 40 改动造成的 lib 合计超 2 MB 红线问题。**★ 内置 resvg 光栅后端**：`assets/bin/resvg.exe`（官方 v0.50.0 Windows x86_64，zip 权威 1,717,055 B 校验、解压 3,994,624 B，随包分发，Apache-2.0 OR MIT 双许可证在 `assets/bin/LICENSE-resvg-*.txt`）为默认光栅后端，`render_frame` 经 stdin 送 SVG/收 PNG（绕开路径编码问题），探测不到或渲染异常一律降级保留 SVG；非 Windows 平台由 `RESVG_PATH`/`PATH` 发现模式兜底。中文渲染依赖系统字体，缺字时自检会判为不安全并降级（不谎称已启用）。本轮（1.0.0 后、未发布）补缺新增 `lib/job-endpoints.js`（队列前台端点）、`lib/cnet-preprocess.js`（ControlNet 预处理纯逻辑）、`lib/resume-store.js`（视频段级续跑账本）、`lib/ws-preview.js`（WS 渐进预览）、`lib/workflow-import.js` + `lib/workflow-import-endpoints.js`（外部工作流导入）、`lib/animation-kit.js`（自研轻量动画三件套）。为腾出体积，`schema-defaults.js` 里 10 段纯设计注释外置到 `docs/schema-design-notes.md`（逐字可逆自检，`scripts/extract-design-notes.mjs`，脚本幂等可重跑），功能零改动。

### 2026-11-17 补缺批次（1.0.0 后工作树，**未发布**）

**本批次三件新功能（诚实边界写在代码里）**
- `lib/layout-lite.js` + `layout_frame` 工具：声明式版式页（title / bullets / split / compare）→ 纯 JS flex 子集算绝对坐标 → SVG。**不是** CSS 或 Taffy 级引擎：单层 row/column、不做 flex-wrap/CSS 解析，文本按字符宽度估算换行（CJK 1em / 其余 0.55em），只保证不溢出；落盘走目录围栏，宿主注入光栅后端（内置 resvg）才顺带出 PNG。
- `compose_video` 新增 `fpsMode=vfr`：走 **concat 清单**按 duration 精确控时，不把去重后的静态段补帧回恒定帧率（实测 4 帧/0.52s/2,505 B vs CFR 7 帧/0.583s/3,145 B）；无 `writeFile` 写不了清单时**如实退回 CFR** 并写进 reason，不假装是 VFR。注意它只省「补出来的重复帧」，动态段仍是一帧一图，不是内容感知抽帧。
- `generate_speech` 旁白内容缓存：`文本 + 后端/音色 + seed + 参考音频身份` 做 sha256 指纹，命中直接复用（连 ComfyUI 探活都省），产物字节数与登记不符/元数据损坏/文件缺失一律按未命中；缓存是增强，写失败绝不影响真实合成。

对照 GitHub Issues 草稿，先补上六项（M1–M5 / H3），随后把五项架构级缺口一并完成：
- **M1 历史 LoRA 落库 + 筛选**：draw 记录 `extra` 增加实际接线的 `loras`（名+强度）/ `unet` / `cfg`（取自构建出的工作流本体，不是面板"当前选择"）；`/history` 增加 `lora` 筛选（SQLite LIKE 带 ESCAPE 防通配注入 + JSONL 降级路径同语义）。
- **M2 参数包导出 / 一键重画**：`GET /api/qwen-paint/history/export?id=`（`draw_args` 可直接交 Agent 重放；reference/controlImage 刻意不入包）；`POST /api/qwen-paint/history/redraw`（走与 `draw_image` **同一条** `runDraw` 内部链路，与批量工具同接法）；历史面板新增「重画」「复制参数」按钮。
- **M3 队列前台操作**：`GET|POST /api/qwen-paint/jobs`（列表/统计 + `cancel|pause|resume`），交给前台的是 `manage_jobs` 工具**同一份队列实例**；lab 队列区从只读升级为可查看/逐条取消/暂停/恢复派发。
- **M4 ControlNet 预处理**：`POST /api/qwen-paint/cnet-preprocess`（Canny/Depth/Pose 候选节点按本机 `/object_info` 探测，0.39.0 核心只有 Canny，缺了如实 409 + 安装提示）；产物按「原图 sha256+类型+参数」缓存到 `.qwen-paint-cnet-previews/`，可直接填 `controlImage`；lab 新增区块带预览。
- **M5 落盘目录模板**：`cfg.filePrefixTemplate` 支持 `{date}` / `{model}`（ComfyUI 前缀 `/` 即子目录）；未配置 = 行为逐字节不变；模板白名单 + 穿越/盘符拒绝。
- **H3 视频尾帧**：`generate_video` 新增 `endImage`；双轨构图（清单 patches + 硬编码）对称接线，双轨逐字节一致测试锁定；**契约门禁**：本机 `Wan22ImageToVideoLatent` 无 `end_image` 槽（0.39.0）→ 如实报错不假装支持；README/llms 同步补写此前缺失的 `startImage` 文档。

### 2026-11-17 架构级补缺批次（1.0.0 后工作树，**未发布**）

前一批留下的五项架构级缺口也已全部完成：

- **H1 多 ControlNet 链式叠加**：`buildWorkflow` 接 `controlStack`（最多 4 路），每路 LoadImage → ControlNetLoader → ControlNetApplyAdvanced，positive/negative 串成 condition 链；单路旧路径逐字节不变（additive 设计，不动默认夹具图指纹）。
- **H2 参考图独立权重 + mask**：`reference-strategy.js` 的 `planReferenceControls` / `applyReferencePlan`，用 `LatentComposite.feather` 表达软权重、mask 走 `VAEEncodeForInpaint`；**不用 `SetLatentNoiseMask`**（0.18 局部重绘架构锁）；无 per-reference 时序门控节点时如实零漂移并记 notes。
- **H4 视频段级续推**：`resume-store.js` 账本，按「index/帧数/seed/prompt/首帧」键缓存已完成段；改任一参数、产物被删、超 2 小时都整条重跑，只复用连续已完成段（不从中间续）。`generate_hybrid.resumeVideo` 默认开启。
- **L1 WebSocket 渐进预览**：`ws-preview.js` 解析 ComfyUI `progress` + 4 字节头二进制预览帧；`GET /api/qwen-paint/preview?enable=1` 按需连本机 WS，Node 20 无全局 WebSocket 时如实 `unavailable` + reason；预览是增强层，没有帧不伪造、不拖累出图。
- **L2 外部工作流 JSON 导入**：`workflow-import.js` + 端点，只接受 ComfyUI **API 格式**（UI 格式明确提示用 Export (API)）；校验节点/引用 → 对照本机 `/object_info` 报覆盖 → 识别可绑定槽位 → 生成 `$param./$asset.` 模板进进程内注册表（重启失效，不写包内 `workflows/` 清单，不触契约指纹）。
- **原生 2K（无需先生成再放大）**：本就是默认路径 —— `forceOptimizedSize:false` 尊重调用方尺寸、`upscaleAfter:0` 不事后放大；`draw_image` 传 `width:2048,height:2048`（或 `megapixels:2`）直达 `EmptyLatentImage`，没有 2048 硬上限（`taskMaxCanvasEdge` 只约束局部重绘的裁剪预缩放）。刻意**不新增**冗余的 `native_resolution` 开关：它只是这两项的别名，反而会引入优先级歧义。

### 2026-11-17 动画四项优化（hyperframes 清单 §13 映射，1.0.0 后工作树，**未发布**）

`hyperframes-底层加速整合总清单.md` 主体针对无头 Chrome 渲染系统，**与本插件无关**（插件是纯 JS SVG 帧 + ffmpeg argv，无 Chrome/GSAP/Lottie/WebGL 对象；§0 的 BGM 模型/权重未定全线阻塞、所有加速倍数未实测不可写成承诺，§11 明确延后 7 项）。只落地其 §13 列出的 4 项纯 JS 可映射项，全部在新模块 `lib/anim-opt.js`、`animation-kit.js` 消费，**零外部依赖、零新端点、index.js 零增长**：
- **① 静态帧去重**：`collapseRepeatedFrames` 把相邻同路径帧折叠为一帧，`buildComposeCommand` 用 `repeats` 把每帧 `-t` 延长为 `repeat/fps`、concat 帧数随之减少 —— 静态画面不再重复落盘。`compose_video` 的 `dedupe` 默认关（旧行为逐字不变）。
- **② 分镜级缓存**：`createFrameCache` 以 `{type,hint,尺寸}` 的 sha256 为 key、sidecar JSON 持久化、FIFO 淘汰 64 条；`render_frame` 命中即逐字复用 SVG 与落盘路径，改一镜只重渲那一镜。file/path 由宿主注入，未注入则不启用（旧测试零影响）。
- **③ 草稿/定稿档**：`ANIM_QUALITY_PRESETS`（draft 480×270/12fps、final 960×540/24fps），显式 width/height/fps 优先于档位；`render_frame`/`compose_video` 新增可选 `quality` 参数。
- **④ 时序校验前置**：`checkTimelineAlignment` 在合成前比对字幕 cue 数 / 末端、配音时长与分镜 `from/to` 时间轴；不齐默认**只告警不拒绝**（`reason` 带 ⚠），`strictTiming:true` 才拒绝；缺数据如实跳过，不编造对齐时间戳（脚本字幕本就 `aligned:false`）。

**公共底座体检**（清单 §2 的插件适用项）：DAG 调度（`dag-planner.js`/`accel-chain.js`/`run_dag`）、全局去重与容量淘汰（`idempotency.js`/`prompt-cache.js`/新分镜缓存）、显存探测与档位（`config.js` 的 VRAM 探测 + `MODEL_TIERS` + `assessLowEndReadiness`）均已存在；「零拷贝流式编码 sink」因插件无 Chrome 截图 readback 链路而不适用，如实记录、不强行造对象。

### 2026-11-17 BGM 链路优化（1.0.0 后工作树，**未发布**）

新增 `lib/bgm-opt.js`（设计注释逐字外置 `docs/bgm-opt-design-notes.md`），三块都是插件层可离线跑、可实测、有生产消费点的优化，非孤儿：
- **① 音乐计划缓存**：`generate_music` 按 `model+prompt+neg+bpm+seed+时长+segment/loop/quality+探测节点集合` 的 sha256 指纹缓存参数计划，命中直接复用、省掉重复 `buildMusicPlan`；信封 JSON 带字节自校验，篡改/截断按未命中，读写失败一律降级真实规划。`deps.musicPlanCache===false` 可关（验证真链路用）。
- **② ducking 缝合缓存**：`mix_narration`/`runAvStitch` 按 `BGM+旁白条目(路径|大小|mtime)+duck 参数+target` 指纹缓存成品，命中跳过整次 ffmpeg 混流编码；产物存在且字节一致才算命中，`stitchCache:false` 可关。真链路回归用假 ffmpeg 计数验证「首次执行 / 二次跳过 / 关缓存强制真跑」。
- **③ hyperframes §7 装配计划**：`/api/qwen-paint/music/models` 新增 `assembly` 字段，透出缓存键七字段、已有 ducking、断点续推（只复用完整段）、embedding 缓存计划；需模型/权重的 candle FP8、预并行、Rust worker 一律标 `blocked` + 原因，**不谎称已实现或实测倍率**。

> 诚实边界：音乐真生成仍依赖外部 ComfyUI 节点（本机实测 `YuE2GenerateMusic` / `SaveAudio*` 可探测）与用户自备权重，本优化不下载、不提交、不生成音频；缓存只加速插件自身的规划与 ffmpeg 缝合。为守 lib 2 MB 红线，另把 `reference-web` / `workflow-manifest` / `vectorize` / `style-library` / `vram-budget` 五个模块的文件头说明逐字外置到 `docs/bgm-opt-design-notes.md`（可逆、语义零改）。专项回归 `scripts/test-bgm-opt.mjs`（30 项）已登记 SUITES。

- **外部 TTS 低延迟编排（1.0.0 后、未发布）**：按用户「抄思路不抄代码」定调，新增 `lib/tts-lowlatency.js`（纯编排：**语义分块降首音延迟** + **本机回环服务探活** + gsv/openai 两种 API 请求适配 + 诚实引导），不复制任何项目代码、不捆绑二进制/权重。`/api/qwen-paint/tts/backends` 与 `list_tts_backends` 工具新增 `external_services` 字段（真实探测 127.0.0.1 上的服务在不在）；lab「语音后端」卡可查看。两个外部服务的合规边界写死在清单里：**GSV.CPP**（真实仓库 `KakaruHayate/GSV.CPP`，MIT，一键包 3.16 GB、g2pw 前端 608 MB，只做适配器+引导、不下载不捆绑）、**AnifLive-TTS**（真实仓库 `Hiruynk/AnifLive-TTS`，原创代码 **PolyForm Noncommercial 1.0.0 禁商用**，商用要作者书面授权，本插件只给引导、不复制其代码）。截图里的 74.6 ms / 2–3× 都是作者在特定硬件的历史宣称，**本插件未复测、不写进结论**。为守 2 MB 红线，`comfy-catalog` / `cpu-endpoints` / `media-convert-tool` / `job-tool` 四个模块的纯说明头注释逐字外置到 `docs/tts-lowlatency-design-notes.md`（可逆、语义零改）。专项回归 `scripts/test-tts-lowlatency.mjs`（含回环围栏反向核查）已登记 SUITES。
- **Qwen3-TTS 注意力后端可选 + 低延迟分块（1.0.0 后、未发布）**：真机 `/object_info` 实测 `FB_Qwen3TTSCustomVoice/VoiceClone/VoiceDesign` 都声明 `attention = auto/sage_attn/flash_attn/sdpa/eager`，但原先 `generate_speech` 写死不传。现新增 `attention` 参数（默认 `auto` 零漂移，仅显式合法枚举才写入生成节点，非法值不污染工作流），透传三条链；`sage_attn/flash_attn` 多为 N 卡优化，本插件**未实测哪个更快**，换值需自行 A/B。`lowLatencyChunks`（默认 false）：按语义切块逐段真提交 ComfyUI、逐块落盘再用 ffmpeg concat 顺序拼成一个音频；**这不是流式播放**，块间语气可能不连贯、整段总耗时可能增加，需本机 ffmpeg、缺件明确报错；缓存键区分分块/整段防串味。为守体积，另把 `tool-registry` / `blockswap` / `model-options` / `accel-profiles` 四个模块头注释逐字外置。`test-tts-workflow.mjs` 加 attention 透传/默认零漂移/非法值防污染断言（含反向核查）。

**红线根治**：接手时发现 1.0.0 后的 40 个未提交改动已把 `lib/*.js` 合计推到 2,100,604 B（超 2,097,152 上限 8,452 B），数据库「105 套全绿」是改动前的假绿。把 7 个新模块 + `describe.js` 的纯设计注释外置到 `docs/added-modules-design-notes.md`（逐字可逆自检，含 GPU_PROFILES 语义注释保护——曾误外置导致 `apple` 档案损坏，已回滚重做），合计降到 2,093,241 B（护栏 LF 口径）/ 余 3,911 B。全量回归见上（106 套）。
- **Alpha / 透明背景（诚实边界，未做）**：没有加 `alpha:true` 假开关。本机 Qwen-Image 2.1 的 latent 格式是 **64 通道**（`comfy/latent_formats.py::QwenImage21`），VAE 解码是 RGB；没有 `zz_rgba2rgb` 节点，也没有 Qwen-Image-Layered 权重。"四通道 VAE 可直接出透明底"在本链路/本机版本上不成立。要做真透明底需另装分层模型与对应节点，或走已有的 `cutout_image` 后处理（纯色底、复杂主体不可靠）——**不是原生 alpha**，不混为一谈。
- **分块重绘 `tile_inpaint`（默认关）**：本机核心节点 `SplitImageToTileList` / `ImageMergeTileList`（正弦羽化）/ `GetImageSize` 齐备；打开 `tileInpaintEnabled` 后，裁剪图被切成 `tileInpaintSize`（默认 1024）方块、重叠 `tileInpaintOverlap`（默认 128，夹到半块以内），逐块走同一条采样链，合并后再 ColorMatch + 回贴。缺任一节点就不接；默认图逐字节不变。⚠ **块间语义连续性未真机 A/B**，多块=多份采样开销，先小图验接缝再长期开。
- **EasyCache 步级复用（默认关）**：按本机 `comfy_extras/nodes_easycache.py` 的真实签名接入核心实验节点 `EasyCache`，参数 `easyCacheEnabled` / `easyCacheReuseThreshold` / `easyCacheStartPercent` / `easyCacheEndPercent` / `easyCacheVerbose`（默认 `false / 0.2 / 0.15 / 0.95 / false`）；面板开关 key `easycache`。节点号 42（20–22/30–41 属 ControlNet），接在模型链末端、注意力后端之前；探测不到节点或不开开关则整段删除，**默认图指纹零漂移**。⚠ 实验节点、本机未做 A/B，与 TE-Speed 互补但**不承诺倍率**，开前请单张对比画质。

新增回归 `scripts/test-gap-fill.mjs`（172 项，已登记 SUITES；含原生 2K 4 项 + EasyCache 12 项 + 分块重绘 11 项）；全量 **105 套 / 各套项全绿**（断言总数刻意不写死，避免随环境漂移；含新增 `test-animation-kit.mjs`）；契约 167/0、manifest 118/0、运行时指纹 168/0；发布护栏与端点目录（`integration-state.js` 新增 `/preview`、`/workflow-import` 共 6 条新路由 + 两份 llms）同步。

### 2026-11-17 自研轻量动画三件套（1.0.0 后工作树，**未发布**）

评估了 manim-mcp / Remotion 等完整引擎后，按用户要求**不接整套重项目**，改为自研三个可独立编排的原子工具（`lib/animation-kit.js`，零新增重依赖）：

- `plan_storyboard`：解说脚本 → 分镜 JSON（按句切分，逐镜给时长/字幕/配音词/画面类型与提示），复用 `subtitle-plan` 切句，时间戳均分未对齐语音。
- `render_frame`：分镜 → SVG 示意图（formula/flow/chart/stick/diagram 纯 JS 生成，示意非 LaTeX 级）；`image` 镜次如实提示改用已有的 `draw_image` 出真实画面。
- `compose_video`：帧序列 + 字幕 + 配音 → ffmpeg argv（concat + SRT 烧录 + 配音混流，H.264）；探测到 ffmpeg 才真出片，否则只回 argv 预览不谎称。

与插件已有的 `subtitle-plan`（字幕）、`generate_speech`（配音）、`draw_image`（真实画面）、`convert_media`（后处理）拼成完整流水线。专项回归 `scripts/test-animation-kit.mjs`（43 项全绿，已登记 SUITES）；无 HTTP 端点（纯工具，Agent 直接调用）。依赖清单见桌面交付文档，**只出清单不安装**。

## 0.35.0 更新说明

> 本版把三个「写了但没接进主链路」的模块接上：`entry-alias`（口语入口别名）、`color-tone`（参考图色调）、`creative-chain`（编排四件）。它们此前只有单测引用、生产链路零入口 —— 用户根本用不到，而当时全部测试是绿的。0.34.0 的全部变更仍然有效。

### ★ 内置最小实现批次（生成之后的处理，纯 ffmpeg 零模型零下载）

- 新增 `lib/media-fx.js`（共享执行器 + 目录围栏，index.js 零增长），三个工具全部接进工具清单 / `/agent-guide` / 内嵌功能区 / selftest：
  - `enhance_audio`：去静音 / 无模型降噪（afftdn）/ 三频段 EQ / 去齿音（deesser，改善 TTS 合成感）/ 压缩 / 响度归一化（语音用 speechnorm、音乐用 loudnorm EBU R128）。
  - `cutout_image`：无模型抠图（chromakey/colorkey 纯色键控 + 可选画笔蒙版 alphamerge），输出保留 alpha 的 PNG/WebP。**只对纯色背景有效**，人物头发 / 半透明需 SAM，如实标注。
  - `split_audio`：声源分离可用部分，ffmpeg `pan` 中置相消得近似人声 + 近似伴奏。**仅对居中人声立体声近似有效**，不是 BS-RoFormer 级，绝不夸大。
- 端点：`GET /api/qwen-paint/media-fx/capabilities` + `POST /api/qwen-paint/enhance/audio`、`/cutout/image`、`/split/audio`；ffmpeg 未探测到时只回参数预览 + 降级原因，不谎称已生成。
- **音频转文字**：`transcribe_audio` 把出图目录内音频经用户自配的 OpenAI 兼容 `/v1/audio/transcriptions`（faster-whisper 等）转成文字 + 时间戳字幕（json/srt/vtt）。插件**不内置、不代装** ASR 运行时；没配 / 连不上就返回缺件清单和自检步骤，不返回空文字冒充成功，API key 只回「配没配」。端点 `GET /api/qwen-paint/audio/transcribe/capabilities`、`POST /api/qwen-paint/audio/transcribe`，已接进工具清单 / Agent 剧本 / 内嵌功能区 / selftest。
- **混合模式三段各自可选**（报障修复）：主模型下拉不再把 hybrid 折叠成生图、也不再用不存在的 `selected.hybrid` 导致回显恒空。生图 UNET（mainmodel）/ TTS 后端（ttsbackend）/ 音色样本（ttsvoice）/ 视频 UNET（unetvideo）四段独立选择、独立回显、独立落盘；TTS 后端与音色真正传进混合链 `speechRunner`（旧代码一个都不传，是假控件）。未知后端 / 路径形态音色令牌一律拒绝。
- 节点级耗时：`cache-report.js` 新增 `timingsFromHistory()`，从 ComfyUI `/history` 真实存在的三个时间戳算出 `queue_ms` / `total_ms`；`load/sample/decode` 官方历史不提供，保持 `null`（Execution Profiler 属外部节点，不内置）。补报的 timings 会落进结构化日志。
- Qwen Image Edit 多图参考：现有 `qwen-edit-plus` 策略增强为多图编辑口径，节点名严格按本机 `/object_info` 协商，不写死未核实的版本号 / 步数。

### ★ 许可证：维持 BSL 1.1（BUSL-1.1），本版不改

- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。
- 本版没有改动许可文本，也没有新增任何限制。

### ★ 新工具与端点：5 个工具 + 3 条端点，全部真接进注册层

- `resolve_entry`：口语入口别名 → 真实工具名 + 预置参数（「风格卡」「批量出图」「历史」「配音」「放大」「有哪些模型」）。别名**只能指向已注册工具**，指错直接报错，不新增影子工具。
- `plan_timeline`：按目标时长切**建议**时间轴（默认 2 秒一段 / 上限 12 段），给出可拼进视频提示词的前缀；有配音时必须改用真实音频时长排轴，两者不可混用。
- `describe_resource_needs`：提交前资源声明（相对档位 / 是否独占模型）；**没有本机同类实测就 `est_seconds=null`**，绝不编秒数。
- `privacy_summary`：本轮数据流摘要；`external_network` 按真实 URL 清单**算出来**，不写死 false。
- `resolve_produce_ref`：「刚才那张」/ `#2` / `last` / 文件名后缀 → 某条产出；`#1` 恒为最新，同名后缀多命中**报歧义**，不替用户挑。
- 端点：`GET /api/qwen-paint/entry/aliases`、`POST /api/qwen-paint/tone/extract`、`GET /api/qwen-paint/run/resources`。

### ★ 加速链全景：承接 0.34.0，本版不改判定

- 承接 0.34.0：`accel_chain.attention` 段继续列 SageAttention / Comfy-WaveSpeed 的探测状态与工作流补丁，来源写在 `probe`；本版没有改动探测逻辑与节点模式。

### ★ 工作流清单层：承接 0.34.0

- 承接 0.34.0：`chain-manifest`（运行时清单目录）与图结构指纹基准（回归期逐槽位对账，`workflow-fingerprint.js` + `scripts/workflow-fingerprints.json`）继续生效，后者**只在回归里跑、不参与运行时构图**。本版新增的工具**都不改生成链**，默认路径逐字节不变。

### ★ 结构化运行日志：承接 0.34.0

- 承接 0.34.0：`event-log` 落盘 + 生成完成钩子不变；本版把 `privacy_summary` 的核对口径与它对齐（都指向 `/history/<prompt_id>`），仍**不含倍率与未实测耗时**。

### ★ UI 与交互：实验室新增「参考图色调」功能区

- 实验室面板加一节「参考图色调 · 取主色写进提示词」：选图 → 浏览器 canvas 缩到 32×32 采样 → `POST /tone/extract` → 回显主色名 / 冷暖 / 饱和 / 明度 + 一句可直接拼进提示词的话，并用返回的 hex 染色块。
- 位置口径不变：功能区仍然**内嵌**进 Comfy 控制面板（不新开浮层），展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**，四事件点按 + `pointerdown` 兜底。
- 只做色调，不猜构图 / 光影 / 材质 —— 那些要靠视觉模型或 IP-Adapter，本插件不引额外权重，也不假装能看懂画面。

### ★ UI 假成功与白条同源修复（P0 / P1 / P2）

- **P0 · 选模型「假成功」（用户直接报障）**：后端在白名单拒绝时不再只写日志，改为把拒绝原因收进 `choiceResult.rejections`，顶层 `ok` 仍表示端点本身正常（三处状态轮询依赖它）；视频主模型 `persistVideoModelChoice()` 返回的 `false` 不再被丢弃。前端按 `j.choiceResult` 显示「未生效：<真实原因>」，不再无条件报「已选 XXX（下次生成生效）」。原因区分「清单此刻不可用」与「候选是缓存里的旧模型，已删或改名」——后一种正是持久化缓存叠加后的隐藏复现路径。
- **P1 · 两处同源白条**：优化面板权重下拉（主 / LoRA / ControlNet）复用主模型那套持久化缓存 + 禁用占位 —— 命中缓存同步回填、后台静默刷新，保留 `fileLabels` 干净名与「已失效」标注；请求失败改为「本机清单暂时取不到（稍后会自动重试）；仍可手动指定模型文件名」，不再误导成「没探测到文件」。素材库设计风格下拉创建时就有禁用占位，请求失败落错误态，空 `catch` 已删。
- **P2 · 四处体验**：`comfy-catalog` 的 `/object_info` 失败也写时间戳（1 分钟冷却，成功仍走 10 分钟 TTL），ComfyUI 忙时不再每轮白等 30 秒；`lab` 的 health 只在成功时锁定，失败显示错误态并延迟重试一次；`history` 首帧给读取中占位，stats 加 60 秒缓存；面板候选未到时不再宣告「就绪」，改为「（候选清单加载中…）」，全部落地后再收口。
- **经核实未做**：清单里的「重复拉取合并」与「三份 `/object_info` 缓存统一」实测后判定为**跨功能按需触发**，不是同一时刻重复请求；要做共享缓存得引入全局请求层、改 4 个以上文件，风险大于收益，本版不动。
- 新增 `scripts/test-white-bar.mjs`（48 项），其中缓存纯函数与失败冷却是**真调用**，其余锁关键分支；已做「改坏失败时间戳 → 2 项变红 → 逐字恢复」反向核查。
- **审计补丁（同日续）**：① `history` 的 stats 返回**全量**条数、list 返回**筛选后**条数，旧代码用前者覆盖分页基数（且 stats 晚于 list 返回时触发竞态）⇒ 拆成 `total`（筛选后，分页用）与 `allTotal`（全量，只进顶栏文案）；② `status.json` 里所有写参数的静默拒绝（`idleminutes` / `flowstyle` / `preset` / `drawtrigger` / `aipickbest` / VAE 分块 / SageAttention 未安装 / MPS 非 Mac / 三条档位）全部接入 `choiceResult`，前端按 label 认领自己的拒绝原因；③ 过期 localStorage 缓存当场清除，不长期残留；`comfy-catalog` 新增只读 `objectInfoCacheStatus()`，`failed` / `ageMs` 可观测。
- 全项目假绿双向扫描：99 个套件的断言函数签名 vs 调用方式全查，两个方向均无参数颠倒；工作树 2,720 行新增经隐私预检零命中。

### ★ 媒体格式转换：承接 0.34.0

- 承接 0.34.0：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转不变；本版不改转码路径。

### ★ 联动护栏与回归

- 新增 `scripts/test-orphan-wiring.mjs`（120 项）：一律从 `createExtras()` 拿**真实工具与真实端点**断言，不接受"函数本身对"当作"接上了"；含像素上限、写守卫、异常不外泄、`undocumented` 为空、UI 入口存在等判据。
- **全量审计补上的两道真护栏**：
  - **lib 全量可达性扫描**（替代原来手写的 `NEW_MODULES` 白名单）：从 `lib/index.js` 出发做真实 import 图遍历，任何 `lib/*.js` 要么可达、要么进白名单并写明理由；白名单还有「已接上却忘了删」「指向已改名的文件」两条反向断言。旧写法列表外的模块永远不被检查 —— `workflow-fingerprint.js` 就是这样一路没人发现只被测试 import。
  - **9 套从未进过回归的历史测试重新登记**（`_abort_fix_test` / `_adapt_test` / `_init_abort_test` / `_wrapper_policy_test` / `_vram_patch_test` / `_toggle_field_check` / `_draw_smoke_test` / `_intent_test` / `_cordis_proxy_test`）：全部纯 JS、零联网、零子进程，各自锁着真实修过的 bug。它们一直绿、但**从没被 `npm test` 跑到过** —— 即用户说的"不在回归清单里的测试 = 等于没有测试"。
- 发布护栏的展开常量解析改成**通用**：`lib/` 里任何 `X_TOOL_NAMES = Object.freeze([...])` 都能解析，解不出来直接判红 —— 否则新模块会重演 0.34.0 那个「展开常量绕过清单检查」的盲区。
- 三处「新增入口必须显式登记」的白名单（selftest 工具集 / lab.js 端点 / 外置端点表）同步登记 5 个工具与 3 条端点。
- 全量回归 **103 套，各套项全绿**（断言总数刻意不在此写死，避免每加一条测试就要改文档）；`lib/index.js` 已用 `scripts/slim-comments.mjs` 把长设计注释外置到 `docs/index-design-notes.md`（84 个锚点可逐字追溯），从 261,907 B 降到 **206,591 B / 上限 262,144 B，余量 55,645 B**（批次 2 权重校验缓存复用，以及 P0「拒绝原因回传」新增约 1.4 KB）。含功能语义/测试依赖的注释（如「看不到用户消息」）自动保留在源码。以后余量偏紧时跑 `node scripts/slim-comments.mjs --plan` 预览、`--apply` 执行（跑完必须全量回归），不必再人工守 256 B 红线。`lib/client.js` 的设计注释同样外置到 `docs/client-design-notes.md`（73 个锚点可逐字追溯），从 261,467 B 降到 **217,246 B**（批次 4/5 编辑台统一入口、P1 权重下拉持久化缓存后小幅回升），仍腾出约 44 KB；原「冻结 261467 B」的哨兵已升级为「未爆 262144 红线 + 关键功能符号仍在 + 锚点可追溯」的语义护栏。

### 文档

- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 0.35.0，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。
- 两份 llms 以代码字体点名全部 5 个新工具与 3 条新端点；`TOOL_SUMMARIES` / `agent-guide` / 端点目录同步补齐。
- 当前 **123 个 `lib/*.js`** / 合计 **2,001,577 B**（含内置最小实现的 `media-fx.js` 与音频转文字的 `transcribe-tool.js`；减压脚本 `slim-comments.mjs` 在 `scripts/`，不计入 lib；client.js 设计注释外置 50 KB 到 `docs/client-design-notes.md` 后 lib 合计相应下降）。
- **极限低显存 Block 交换（UniBlockSwap，MIT，发现层接入）**：检测 ComfyUI 里的 UniBlockSwap 节点（用户显式 git clone 安装，插件不代装），`accel/chain` 的 `blockswap` 段给出机制口径（num block：-1 单块卸载 / 0 关闭 / >0 预缓存 / ≥总块数关闭）与低显存安装提示；ComfyUI ≥0.35 需节点自关 dynamic（已自带处理）；工作流补丁待真机核实槽位（needsSlotMapping 诚实边界）。
- **加速链硬件感知路由（unverified）**：`accel/chain` 的 `hw_route` 段按显卡型号判定架构（Blackwell / Ada / Ampere / Turing / Pascal / RDNA 系 / Intel Arc）并给 SageAttention 内核变体建议（新卡 FP8 / 老卡 INT8 / A 卡与核显 unsupported——CUDA 内核不适用）；量化档「真提速 vs 仅省显存」保守提示（A 卡按 memory-only，N 卡 unverified）；**stable-fast 明确不集成**（停更 / 低显存失效 / 被 Comfy-WaveSpeed 取代）。reset 语义：图内节点按生成插拔（非全局 Monkey Patch），启动级回退由 comfy-launch 处理。
- **本机 ASR + 轻量缝合（纯 ffmpeg，显存 0）**：faster-whisper（MIT，CPU INT8 显存 0；GPU 档 NVIDIA 专属）等 OpenAI 兼容 server 填进 `asrUrl` 即接通既有字幕链路（`GET /api/qwen-paint/asr/status` 探测）；`mix_narration` 把旁白条目铺时间轴 + BGM sidechaincompress 自动压低 + SRT 直出（`GET|POST /api/qwen-paint/av/stitch*`）。
- **轻量档 PPTX（纯 JS 零依赖零 GPU，永远可执行）**：`make_pptx` 生成标题 + 要点列表的大纲级草稿（`POST /api/qwen-paint/pptx`）；Office/WPS 兼容性 unverified；标准/质量档（Presenton / PPTAgent+GGUF）单独立项未做。
- **口型同步（lip sync）暂不支持**：上游轻量方案 Wav2Lip 为非商用研究许可，许可干净替代（SadTalker Apache-2.0 ~8GB / MuseTalk MIT ~12GB）显存超低配档——待用户拍板，未集成。
- **位图 → SVG 矢量化（两步法，内置执行路径）**：`vectorize_image` 工具 + `GET|POST /api/qwen-paint/vectorize*` 端点。引擎 `vtracer`（MIT，visioncortex/vtracer 官方 Release 单源，win 包 965,231 B，默认不装：setup `--vectorize` 或 `node scripts/vectorize-catalog.mjs --download`）做**彩色**矢量化；引擎 `potrace`（GPL-2.0+，黑白线稿专用）为**用户自备 exe**（SourceForge 无权威直链 ⇒ 不代下载，填 `potracePath` 即用）。输入限出图目录、SVG 落出图目录内；未安装引擎如实降级，绝不谎称已矢量化。
- **手动超分新增 Vulkan 直跑引擎（内置执行路径，不经 ComfyUI）**：`realesrgan-ncnn-vulkan`（MIT，windows 包 2,159,606 B）/ `realcugan-ncnn-vulkan`（MIT，45,977,449 B，动漫向）；AMD / NVIDIA / Intel 核显 Vulkan 通吃。引擎二进制**默认不装**：`node scripts/vulkan-upscale-catalog.mjs --list` 查看、setup `--vulkan-upscale` 显式下载（GitHub Releases 官方源、权威字节数校验、系统 tar 解压；Release 无 sha256 ⇒ 只比大小并如实说明；可执行文件不加第三方加速镜像——供应链红线），装好后把目录填进 `vulkanUpscalePath` 配置，`manual_upscale`（engine=引擎 id）即真实执行；未安装时如实降级回草案，绝不谎称已放大。

## 0.34.0 更新说明

> 本版是 0.33.0 之后的**累积版**：把上一批未发布的语音 / 音乐 / Worker / 下载脚本能力，与本轮「加速后端真接线 + 溢出修复」一起发布。0.33.0 的全部变更仍然有效，下面按主题汇总。

### 许可证
- 自 **0.33.0 起**许可为 **BSL 1.1**（`BUSL-1.1`，非 OSI 开源许可）：除托管 / 代管服务与直接竞品捆绑两类「竞争性使用」外免费生产使用；**Change Date 2030-11-15** 自动转 **Apache-2.0**。**0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**。

### 新工具与端点
- 语音：`list_tts_backends`（Qwen3-TTS / GPT-SoVITS v5 原版 dev / 蒸馏版 turbo / IndexTTS2）；`generate_speech` 新增 `backend` 与 `voice_sample`（拖入音频做**零样本音色克隆，不训练、不微调、不产出权重**）。
- 音乐：`generate_music`（ACE-Step 1.5 / YuE2）；图像：`manual_upscale`（4 引擎 / 6 档倍率 / 降噪锐化分块）；进程：`manage_workers`（热 / 温 / 冷分级保活、LRU 驱逐、显存预算准入、优雅终止）。
- 新增 9 条本机端点：`/tts/backends`、`/audio/samples`、`/music/models`、`/music/generate`、`/upscale/manual[/capabilities]`、`/workers[/vram]`、`/accel/backends`（`GET, POST`）。首次安装引导里**只问一次**是否下载音频模型，只展示 / 复制命令，网页绝不触发下载。

### 加速链全景
- **SageAttention（8-bit 注意力）与 Comfy-WaveSpeed（First Block Cache + torch.compile）正式并入加速链**：`accel_chain` 新增 `attention` 段，`all` 为缓存 / TTS / 注意力三段拼接；`check_acceleration` 报告新增 `attentionBackends`。
- **真接线**：`config.js` 与 `turbo-workflow.js` 两条真实工作流构造路径都会把探测到的节点接到模型链末端（节点 id 40）；默认不启用时生成链**逐字节不变**。
- **真实探测**：节点类名只来自本机回环 `/object_info` 全量节点表（60s 缓存 / 2s 超时 / 禁重定向），不再拿插件内部能力名冒充；失败如实标 `probe.source=unavailable` 并降级。真机 1686 节点实测：SageAttention 命中 `QwenImage21SageAttentionT8`，WaveSpeed 无 First Block Cache 节点。
- **防误报**：通用 `TorchCompileModel*` 与 Wavespeed 超分节点不算 WaveSpeed；候选按专用节点优先排序。节点输入槽位仍未核实（`needsSlotMapping`），启用后若节点拒收需按 `/object_info` 补映射。

### 工作流清单层
- 承接 0.33.0：视频链清单化 + 生图 / TTS 契约对账，改图自动报差异；`chain-manifest`（运行时清单目录）与图结构指纹基准（回归期逐槽位对账，不参与运行时）继续生效。

### 结构化运行日志
- 承接 0.33.0：`event-log` 落盘 + 生成完成钩子；本版把加速链快照与 `attention` 段一并记入，仍**不含倍率与未实测耗时**。

### UI 与交互
- 承接 0.33.0：本机能力功能区**内嵌**进 Comfy 控制面板（展开页恒在悬浮球**正上方**、**边框对齐** DSH 右边框、小屏**不变形**、四事件点按 + `pointerdown` 兜底）。
- 本版：加速链卡片新增**常驻状态行**（两个后端 + 当前启用项 + 节点表探测来源）与「启用 SageAttention / 启用 WaveSpeed / 恢复默认」三个按钮。
- 本版修复**横向溢出**：面板 / 滑块 / 进度条 / 卡片统一 `box-sizing` + `min-width:0` + `max-width:100%`，面板收掉 `overflow-x`。

### 媒体格式转换
- 承接 0.33.0：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC 互转，动图转视频，生成物可按预设自动后转码，Agent 可调 `convert_media`。

### 联动护栏与回归
- 全量 **81 套 / 0 失败 / 逐项断言全绿**（6,046 项）；发布护栏 68/0；体积守卫 **112 个 `lib/*.js` / 1,935,128 B**；`lib/index.js` 258,398 B，余量 **3,746 B**。
- 新增 `test-overflow.mjs`（28 项）与 `test-attention-wiring.mjs`（50 项），均登记 `SUITES`，都带「改坏变红」反向核查。
- 诚实边界：音频权重不自动下载、缺件给清单；插件不 `pip install`、不建 venv / conda / Docker、不拉镜像；第三方节点类名与槽位未核实一律降级。

### 文档
- README / 两份 `llms.txt` / `docs/index.html` / `INSTALL.md` / `pyproject.toml` 同步本版变更；端点目录写明 `accel/backends` 为 `GET, POST` 且已并入加速链。

## 0.33.0 更新说明

这一版把 0.32.1 之后的**能力扩展批次、媒体格式转换、四轮 UI 纠正、许可证更换**一次性收口，并按「单个功能完成 ≠ 最终完成」的纪律做了全面联动审查与孤儿扫描。**本版为本地完成、尚未推送到 npm / GitHub 的开发版本**，线上 `latest` 目前仍是 `0.32.1`。

### ★ 许可证：0.33.0 起改用 BSL 1.1（BUSL-1.1）
- **不是 OSI 核准的开源许可证**。Licensor 为单一主体 `@yanfei0725`；`Additional Use Grant` 允许用户中文原文所述的授权：除托管 / 代管服务、直接竞品捆绑这两类「竞争性使用」外，任何个人 / 团队 / 企业可**免费在生产环境使用**；中文原文 governing、英译 non-binding。
- Change Date **2030-11-15** 起转为 **Apache License, Version 2.0**；**转版后「竞争性使用」限制自动消失**（BSL 机制使然，不是额外承诺）。
- **0.32.1 及更早版本仍按 MIT 授权，永久、不可撤销、不追溯**；`LICENSE` 与 README / 两份 llms / 落地页均已写明。
- Covenants 第 4 条「不得改写条款」⇒ `LICENSE` 条款正文与 SPDX 官方 `BUSL-1.1.txt` 逐字一致（SHA-256 `20092e66…2293`），参数区与正文严格分离；`package.json` → `BUSL-1.1`、`pyproject.toml` classifier → `Other/Proprietary License`。
- 第三方许可一律未动：frakd 节点 MIT 描述、Qwen Research License「禁止商用」提示、落地页 license URL、`dist/pkg/` 旧快照。
- 专项护栏 `scripts/test-license-bsl.mjs`（83 项）：锁官方正文逐字 + SHA-256 双保险、五个参数、中文 AUG 逐字、只放宽不收窄、四年日期、旧版本边界、文档一致、第三方不误改、脱敏。

### 新工具与端点（全部走外置注册层，lib/index.js 零增长）
- 新增 6 个工具：`convert_to_gif`（图片序列 / 视频转 GIF）、`manage_jobs`（优先级任务队列管理）、`iterate_image`（单图多轮迭代优化）、`query_history`（生成历史可删改 / 冷热分离 / 参数化查询）、`doctor`（运行期自诊断）、`run_dag`（自适应 DAG 编排，默认 `dry_run`）；本轮再补第 7 个 `convert_media`（见下一节）。
- 0.33.0 新增模块全部独立落在 `lib/` 与 `assets/`（当前 **112 个 `lib/*.js`** / 合计 1,935,128 B，含 0.33 之后未发布的语音 / 音乐 / Worker / 加速后端批次；0.33.0 发布时为 103 个 / 1,829,983 B），经 `lib/tool-registry.js::createExtras()` / `registerExtras()` 注册；`lib/index.js` 只留一行接线。注释外置到 `docs/index-design-notes.md` 后，体积余量由 105 B 放宽到 **3,746 B**（258,398 B / 上限 262,144 B）。
- 新增端点含 `/api/qwen-paint/accel/chain`、`/media/gif`、`/doctor`、`/history/query`、`/events`、`/vram-budget`、`/config/conflicts`、`/contracts`、`/eta`；`lib/integration-state.js` 端点目录同步登记。

### 媒体格式转换（生成物指定格式 / 自有素材 / 动图转视频）
- 新增 `convert_media` 工具与 5 个独立模块，覆盖用户点名的常用格式：图片 **JPG / PNG / WebP**、视频 **MP4 / MKV / MOV / WebM**、音频 **MP3 / AAC / WAV / FLAC**；格式表 `lib/media-formats.js` 是唯一真相源，同类互转、跨类明确拒绝。
- **生成物指定输出格式**：ComfyUI 保存节点格式是固定的（PNG / mp4 / mp3），所以诚实实现是「落盘完成后由生成完成钩子自动补转一份、**原产物保留**」，不是谎称节点能直接吐 WebP。`POST /api/qwen-paint/media/formats` 设 `{kind, format}` 预设（进程内存、重启即清空），也可在单次生成条目里给 `output_format`。
- **自有素材**：`source` 走输入目录围栏（默认出图目录，宿主可注入 `sourceDirs`），不把任意本机路径喂给 ffmpeg；输出同样落在出图目录内，拒绝 `..` 穿越与越界。
- **动图转视频**：GIF / APNG / 动图 WebP → 四种视频容器，统一帧率 + 偶数尺寸 + `yuv420p`，显式 `-an`（动图无音轨），`loop_count` / `duration` / `fps` 可控；诚实说明 GIF 循环次数不会自动变成视频时长。
- **真执行而非只给参数**：`lib/media-exec.js` 用 `execFile` argv 数组探测 `FFMPEG_PATH` / PATH 并真跑 ffmpeg；探测不到、执行器未注入、编码器缺失都返回 `ok:false` + 明确原因 + 完整参数预览，**绝不假装已生成文件**。
- **Agent 可调用**：`convert_media` 已注册进工具清单、`/agent-guide` 的 `TOOL_HINTS` 与 `format_output` 编排剧本、`/media/convert`（POST）与 `/media/formats`（GET/POST）两条端点、内嵌 Comfy 控制面板的功能区，以及 `scripts/test-media-convert.mjs` 专项回归；5 个新模块全部通过孤儿扫描。
- 编码器标识（libx264 / libvpx-vp9 / libwebp / libmp3lame / libopus / flac）是 ffmpeg 标准名，**不承诺本机一定编入**；实际是否可用由真实执行结果决定。

### 加速链全景（TTS 加速进链）
- `lib/accel-chain.js` 把 `cache-backends`（生图 / 视频缓存后端）、`tts-accel`（TTS 加速）、`vram-budget`、`config-consistency`、`structured-log` 汇成 `image` / `tts` / `all` 三段；`check_acceleration` 报告透出 `ttsAccel`，TTS 加速不再是孤儿模块。
- 诚实边界：CUDA Graph / Triton / GGUF / 流式 / 声码器 fp16 只列**探测到的后端**与方向性建议，未实测**不写倍率、RTF 或毫秒数**；`TeaCache` 标 `needs-external-node`，`mrfow` 标 `term-unverified`（候选 MrFlow / arXiv 2607.01642 待用户确认），**永不自动启用**。

### 工作流清单层与契约对账
- `lib/chain-manifest.js` 统一声明式总账登记 4 条链，`/workflows` 吐 `chains` / `chain_summary` / `chain_errors`；`authoritative=runtime` 恰好 1 条（`video-wan22`），其余 3 条为 `contract`。
- 生图 / TTS 链**契约清单化，运行时仍由代码构图** —— 这是为避免 JS/JSON 双轨半迁移的**有意设计**，不是未完成；图结构指纹 `scripts/workflow-fingerprints.json` 锁 5 组夹具，构建后逐槽位对账。
- 预设去掉 `pending:true`，`preset_unverified` 现为 `[]`，并做契约存在性真校验。

### 结构化运行日志
- 每次真实生成由 `history-store.js` 钩子自动落一条 `generation_complete`（本机实测 `total_ms` + 尺寸，prompt 只留 hash、路径不进日志），零 `index.js` 改动。
- 诚实边界：`queue_ms` / `load_ms` / `sample_ms` / `decode_ms` 主链路未打点，日志里为 `null`，需要时由宿主在生成完成时 POST 补报。

### UI 与交互（四轮纠正后的最终口径）
- **删除实验室独立浮层**（`.dshqp-lab-fab` / mask / `findHost()` / `tryRehost()`），功能改为 `mountInto()` 直接内嵌进 `cp-panel` 的插槽；找不到插槽就不挂，**绝不降级挂 `body`**。
- **展开面板恒在悬浮球正上方**，不是左侧 / 右侧 / 下方：面板右缘 = 浮标右缘 = DSH 窗口右边框（**边框对齐边框**），底缘 = 浮标上缘、零空隙；上方放不下只压缩面板高度。
- 浮标贴边**不变形**：圆角 / 内边距 / 最小高度保持 0.32.1 原样，只用 `width:max-content; white-space:nowrap` 锁死内容宽度；`EDGE_GAP = 0` 消除「提前留空」。
- **点按链路**（第五次报障的根因）：DSH 宿主在 `pointerdown` 上 `preventDefault` ⇒ `click` 不派发，兜底是靠 `target.click()` **合成 click**。因此所有按钮自己绑 `click` + `pointerup` / `mouseup` / `touchend` 四事件与手势级冷却；会被 `render()` / `rebuild()` 重建的按钮（如 `×`）**必须在 render 里重绑**；冷却只去同一手势多个抬起事件的重、由 `pointerdown` 重置，不是全局 300 ms 时间窗；拖动开始 / 结束 / 取消都设抑制。
- 浮标带 `UI_BUILD='2026-11-15.5'` 自证标记。**真机验证须刷新 DSH 页面** —— `client.js` 按脚本 id 去重，同一页面不会重拉（`asset-route.js` 是 `no-store`，缓存不是原因）；hover 应见 `Comfy 控制 · UI 2026-11-15.5`。

### 联动护栏与回归
- `scripts/test-accel-chain.mjs` 锁「TTS 加速进链 / 5 个原孤儿模块真实参与 / 端点·工具报告·UI 三处消费 / 16 模块孤儿扫描」；`scripts/test-capability-audit.mjs` 锁 3 个新端点在注册层→端点目录→Agent 指引→UI→回归五处联动。
- 新增登记 `test-chain-manifest.mjs`(31) / `test-generation-log.mjs`(29) / `test-draft-pointer.mjs`(30) / `test-license-bsl.mjs`(83) / `test-ui-tap.mjs`(39)；`test-fab-clamp.mjs` 71 项锁 UI 几何，`test-fab-drag.mjs` 30 项真 DOM 仿真锁点按与 rebuild。
- **全量回归 81 套 / 0 失败 / 逐项断言全绿**（连跑 3 轮一致）；发布护栏 `test-release-metadata.mjs` 全项通过；体积守卫 112 个 `lib/*.js` / 1,935,128 B。回归套数、`lib/` 文件数与体积均由真实值推导/校验，不写死「过一天就过期」的断言数，避免每加一套测试或一个模块就要改文档。关键护栏都做过「故意改坏 → 确认变红 → 逐字恢复」的反向核查。
- 修掉两个真 bug：显存预算 MB→GB 档位错配（`budgetCapFromVramMb`）、`/agent-guide` 端点目录恒空（`deps.routes || INTEGRATION_ROUTES`）。

### 文档
- `package.json` / `meta.description` / README 首段 / 两份 llms 首段 / `pyproject.toml` / `docs/index.html` / `给DSH安装的话.md` 全部同步到 0.33.0，`scripts/test-release-metadata.mjs` 一处改、多处一起校验。

## 0.32.1 更新说明

这一版**不加新功能**，只把 0.32.0 发布后两轮审计查出来的问题一次性收干净（详见桌面《体检报告》第二十七节）。

- **安全**：`/api/qwen-paint/config/subtitle?source=asr&audio=` 原先可越出出图目录读任意媒体文件并 POST 到自配 ASR 端点；现在 `asr-client.js::resolveAudioPath()` 做与文件字节路由同源的 `resolve` + 目录前缀包含检查，拒绝时连 POST 都不发。
- **消毒**：清单 / 契约读取失败的 `errors[]` 与 `audit_skipped` 原会把含本机路径的 `error.message` 塞进 `ok:true` 响应（顶层消毒够不到嵌套字段）；现在细节只进插件日志，响应改固定文案 + `sanitizeReason()`。
- **安装**：npm 发布物补进 `scripts/setup.mjs` 与 `scripts/video-model-catalog.mjs` —— 图形化引导里那些「复制就能跑」的命令，按包名安装的用户现在真的能跑。
- **交互**：新增草图台 `assets/draft.js` 改回与历史浮层同口径的四事件源点按（`click / pointerup / mouseup / touchend` + 300ms 冷却），遮罩关闭一并覆盖，杜绝「点不动 / 关不掉」重演。
- **发布一致性**：`llms.txt` / `docs/llms.txt` 的旧版本号、`docs/index.html` 与 `pyproject.toml` 的旧功能口径全部同步；版本护栏扩到两份 llms。
- **测试纪律**：工作流指纹基准改为只读（缺失 / 损坏直接报红，不再用当前代码自动重建并算通过）；`selftest` 的形状检查从 1 个工具扩到全部 13 个；`TOOL_SUMMARIES` 补齐 3 个新工具；删掉 `loading.gif` 死路由；Markdown 导出转义提示词中的 `](`；`_client_scope_test` 补逐条断言标记。
- **体积**：`lib/index.js` 只剩 19 B 余量，新增 `scripts/check-size.mjs` 并挂到 `prepack`，打包前就拦越界；`lib/client.js` 字节基线冻结在 261467 B。
- 端点目录补上根别名 `/qwen-paint/status.json`，守卫正则同步放宽；对不存在的 `contract-audit.mjs` 提示改指真实脚本。

**经复核不硬改**（改了会坏功能或撑爆体积红线）：`PREF_FILE` 双硬编码与第三份端点清单的合并（要给 `index.js` 加 import，但只剩 19 B）、三份 stable-hash helper 合并（会改指纹值、破坏既有基准）、26 个模块的顶层静态 import（无模块级 I/O，只是解析编译）、`client.js` 挂载清单外置（改用字节基线冻结）、`preview_url` / `/draft` 的绝对路径（前端契约）。

## 0.32.0 更新说明

这一版把「生图 / 视频 / 语音」三条链的**可验证性**和**界面差异化**补齐，并补了一大批顺手能力。

### 工作流：清单化 + 契约对账（A1）
- **视频链已接管生产**：`workflows/video-wan22.json` 用通用加载器 + 条件补丁（`add` 加节点 / `set` 改槽位）声明 10 个节点；`generate_video` / `generate_hybrid` / 面板预览三处都改走清单，损坏时**自动回落**硬编码构建。
- **生图 / TTS 链契约对账**：`lib/graph-audit.js` + `workflows/contracts/` 三份契约，构建后逐槽位核对，diff **点名到具体字段**（如 `8.steps`）；turbo 蒸馏链 8 步走 `alternates` 合规分支不误报。图仍由代码构建，契约是构建后核对。
- 端点：`GET /api/qwen-paint/workflows`（清单总览）、`/contracts?id=&build=1`（真机对账）。

### 三模式界面各不同（用户点名要差异化）
- `MODE_PLANS`（schema v2）驱动：生图模式隐藏视频组（7 项、零 disabled）、视频模式启用帧数/帧率（10 项）、混合模式新增「生图→TTS→视频」三段链说明卡（11 项）；每模式专属标语 + 强调色。旧 schema 回退全显。

### 批量与幂等（C11/C12/C16）
- `batch_draw`：种子×尺寸笛卡尔积、单张失败不中断整批、失败后队列轻量复位、错误可操作化诊断。
- **幂等保护**：同参数 2 分钟内重复提交复用结果，并发请求合并成一次；失败不记账。

### 语音：克隆 + 转写真通路（D21/D19）
- 语音克隆：`FB_Qwen3TTSVoiceClone` 链，参考音频复刻音色（`reference_audio` 可选）。
- 字幕：`source=script` 出 SRT/VTT（时间戳均分、`aligned:false`）；`source=asr` 配了 `cfg.asrUrl`（OpenAI 兼容端点）就**真转写**，segments 时间戳对齐；无 segments 按句均分并标 `aligned:false`。未配置只给缺件清单。

### 本机实测秒数（E27）
- `lib/eta-calibrate.js` 从 ComfyUI `/history` 的真实执行时间戳按「类型+像素档+步数档」取中位数，≥3 样本去首跑；没样本仍 `null`、绝不跨档借用。端点 `GET /api/qwen-paint/eta`。

### 模型驻留与显存（B5/B4）
- **会话级模型驻留全覆盖**：生图 / 视频 / TTS / 超分四类构建入口都记账，切换链时告诉用户首张是否要重载主模型。
- 显存建议只建议不改配置（档位是启动参数）；性能档位 / 缓存档位语义化，缓存摘要口径标 `comfy-node-cache` 不冒充 block 级。

### 参数透明（D23/A3/D26）
- `GET /params?chain=` 逐行标来源（你指定 / 默认值 / 已对齐 / 链路固定 / 未填）。
- 预设绑定 manifest：链不匹配直接拒；未清单化的预设单列 `preset_unverified` 不假装通过。
- 加载器静态盘点：主图必载 vs 条件补丁按需，明说运行时跳过节点做不到（`ExecutionBlocker` 本机不存在）。

### 创作与顺手（D18/D20/D25/F28/F29/F30/F31/G32–G36）
- 产出短引用（`#1`=最新）、时间轴骨架；草图台（Canvas 手绘参考图）；提示词模板 6 套；色调提取；历史导出 Markdown / 结构化 alt / 继续编辑候选；隐私摘要（external 是算出来的）。

### 两个必须写出来的真机事实

- `VHS_LoadAudio.audio_file` 收的是**相对 ComfyUI 根目录**的路径（`input/a.wav`），传裸文件名 `a.wav` 会被 `custom_validation_failed` 直接拒。上传返回的裸 `name` 现在统一规范成 `input/...` 再进工作流。
- `VoiceClone` / `VoiceClonePrompt` 这两个**裸名字在本机并不存在**，真名是 `FB_Qwen3TTSVoiceClone` / `FB_Qwen3TTSVoiceClonePrompt`。同理用户常提到的 `Video Audio Merger` / `Mux Audio` 也不存在，实际能用的合并路径是 `VHS_VideoCombine.audio`（已实测存在并有 `AUDIO` 输入）。

## 0.31.1 更新说明

这一版是**审计修复版**，不加新功能，专门堵上一版留下的安全与一致性问题。

- **修一个真漏洞：历史库路径穿越**。`record()` 此前只挡绝对路径，`../outside.png`、`a/../../outside.png` 会被判成「合法相对路径」直接入库，之后 `/api/qwen-paint/file?path=` 能读到出图目录**之外**的文件。现在相对 / 绝对两种输入走同一道净化（`sanitizeRelPath`）：越界、Windows 盘符相对路径（`C:x.png`）、规范化后仍含 `..` 段的一律拒绝。补了 6 组用例（含已复现过的三种穿越写法）。
- **历史库不再泄漏本机绝对路径**。`/history` 响应里的 `db_file` 原本是完整路径，现在只给文件名 —— 浏览器面板与外部集成都不需要目录结构。
- **多实例写库不再静默失败**。加 `PRAGMA busy_timeout = 3000`：两个 DSH 实例共用一个出图目录时不会立刻 `SQLITE_BUSY` 然后被吞成「写入失败」。刻意不开 WAL（单进程没收益，却会多出 `-wal` / `-shm` 两个容易被当成垃圾误删的文件）。
- **SQLite 句柄会释放了**。插件卸载 / 重载时调 `close()`；此前全仓没有一处调用，Windows 上会一直锁着 `.qwen-paint-history.db`，换出图目录或想删掉它都会撞「文件正被另一个程序使用」。
- **端点目录补齐 5 条**。`/history`、`/history/stats`、`/history/delete`、`/cpu-profile`、`/cpu-accel` 之前没登记进 `/api/qwen-paint/integration/routes`，外部集成照着目录调用会漏掉它们。
- **发布护栏补漏**。`docs/index.html`（落地页 JSON-LD 的 `softwareVersion`、可见版本号、安装说明）此前不在版本号检查清单里；现在 README 中任何「当前 + 版本号」的写法都必须等于 `package.json` 的版本，漏改一处就红。
- **版本号序列理顺**。npm 历史上有个 `0.19.2`，semver 上比 `0.3.x` 大，按版本号判新旧会误判。`0.31.1` 大于 `0.19.2`，从此单调递增。

## 0.3.1 更新说明

- **生成历史（新）**：SQLite 存储（`<outputDir>/.qwen-paint-history.db`，只用 Node 内置 `node:sqlite`，零外部依赖）+ 菜单**最上面**的「历史 → 生成历史」入口 + Agent 工具 `list_generated_images`。关键词 / 类型 / 日期范围 / 分页 / 大图预览 / 复制路径；「移除」是软删除，**绝不删磁盘文件**；Node < 22.5 如实降级为 `available/persistent: false`。⚠ 上一版把它写进了 0.3.0 的更新说明，但 0.3.0 的发布包里**并不包含**这几个文件（当时还在本地未提交），实际是随 0.3.1 首次发布 —— 这里做个更正。
- **回归从 48 套涨到 51 套 / 3,511 项断言**：新增 `test-history.mjs`（真跑 `node:sqlite` 临时库 + 降级路径 + 端点围栏 + vm 假 DOM 真派发事件）、`test-http-errors.mjs`、`test-ui-pointer.mjs`。
- **修掉 4 个问题**（都不是新功能，是既有缺陷）：
  1. 生成历史的「关闭（Esc）」只写在按钮文案里，**根本没绑 keydown** —— 假接线，已补真实监听；
  2. `test-http-errors.mjs` 硬编码「10 条静态资源路由」，加两条就会被挡住。**没有把 10 改成 12**，而是升级成「文件名集合逐字相等 + 文件真实存在」两条更硬的判据；
  3. 顺着上一条发现 `assets/loading.gif` 的**路由在、文件不在**（只会 404，且没有任何前端消费者）—— 属既有遗留，本轮只记账不动它；
  4. 我自己第一版 `test-history.mjs` 把 `ok(name, cond)` 的实参与形参写反，**140 项「全绿」其实全在判「消息串非空」**。修正后立刻暴出 2 处真失败。这条已写进项目记忆当反面教材。
- **文档补齐 Node 降级口径**：`engines` 刻意仍是 `>=18.0.0`（插件本体照常工作），只有历史持久化需要 Node >= 22.5；两档行为逐条列清，不假装低版本也有历史库。
- **修正一处工作流节点白名单**：`QwenImage21Cache` 的 `device`（auto/gpu/cpu/off）与 `dtype`（default/int8/int4）现在做合法值回落，写错词不会把整个 prompt 卡在 ComfyUI 队列里报错。

## 0.3.0 更新说明

- **图形化安装引导（入口不再藏）**：右下角常驻「一键安装引导」大按钮，7 步卡片（环境检查 → ComfyUI → 生图主模型 → 视频模型 → 语音 → 核显档位 → 挂载 DSH）+ 进度条 + 状态灯，每步直接给可复制的命令。⚠ 网页侧**不会**替你 spawn 本机进程（那是安全红线），所以最后一步仍需你把命令粘进终端 —— 这是刻意设计，不是没做完。
- **CPU 指令集识别 + 五档加速**：读 `/proc/cpuinfo` 的 flags（Windows / macOS 退化为型号推断并标注「未实测」），识别 `AVX2 / AVX512F / AVX512-BF16`，给 `off / safe / balanced / max / force-cpu` 五档：`--preview-method none`、`--use-pytorch-cross-attention`、`--bf16-unet + --bf16-text-enc`（仅硬件支持时）、`--cpu`（自动摘掉显存参数与 GPU 专属注意力内核）。`OMP/MKL/OPENBLAS_NUM_THREADS` 按**物理核**注入，全平台可下发。默认 `off` = 一个参数都不加。
- **蒙版精修真接线**：羽化 / 边缘融合 / 外扩 / 重绘强度 / 反选 / 笔刷柔和度全部落到 `InpaintCropImproved` 与 `ManualSigmas`；羽化在浏览器 canvas 上按蒙版分辨率归一后真实模糊（不是摆个没反应的滑块），反选走 `mask_invert`。
- **卸载内存模式**：`off / auto / manual` 三态，`auto` 在任务收尾时向本机 ComfyUI 发 `/free`（只发 `cfg.comfyUrl`，fire-and-forget 不影响出图结果）。
- **外部集成**：`/api/qwen-paint/integration/state` 与 `/integration/routes` 提供脱敏状态快照与端点目录，不含本机绝对路径、用户名、凭据、对话内容。
- **发布口径机制化**：新增 `scripts/test-release-metadata.mjs`，把「简介 / 描述 / 版本号 / 文档」逐字同步变成回归断言 —— 漏改一处就红。
- **审计修复**：反选曾经是假接线（节点写死 `mask_invert: false`）、`QwenImage21Cache` 的 `device`/`dtype` 缺枚举校验、`setupGuideReady` 写死 `true`、静态资源缺 `nosniff`、`/quick-edit` 白带 `maskFx` —— 本轮全部修掉并加了对应断言。

## 0.2.0 更新说明

- **能力版图补齐**：视频生成（文生视频 / 图生视频）、Qwen3-TTS 语音合成、图→音→视频混合模式、模型无关角色参考、图片编辑台（圈选重绘 / 移除 / 扩图 / 放大）全部写进简介与文档；音频能力在界面里可直接选用，**暂不提供音频模型自动下载**。
- **安装**：首次安装问完生图模型档位后，再问是否下载视频模型；官方仓库文件清单运行时动态列举、由用户自己选档位，沿用多源轮询 + 断点续传 + 失败可自备文件。
- **低配**：核显 / 共享显存 / 8 GB 内存档位，自动轻量模型 + 省显存参数 + 分辨率与并发预算；出图速度设了可量化的验收门槛。
- **安全与效率**：轻量安全加固、工具描述与探测复用优化、UI 主题统一与更典雅的视觉层次。
- **工具与回包收口**：新增独立 `generate_speech`（与混合模式共用同一条 TTS 段，不再有两份实现）；10 个工具的 description 集中到 `lib/tool-descriptions.js` 统一口径，注册时统一按 `output.schema` 声明字段收口回包；`lib/index.js` 257085 → 251058 B。
- **时间轴增强**：缩略图轨道（隐藏 `<video>` + `<canvas>` 取帧，零依赖、不上传视频字节、不需要 ffmpeg）与「改完的帧回贴成视频」（新本机端点 `/api/qwen-paint/video/replace-frame`，ffmpeg 走 argv 数组、路径限出图目录内、不拼 shell）。
- **可选核显型号**：`lib/igpu-profiles.js` 收拢 AMD 780M/680M/760M/660M/8060S 与 Intel Iris Xe 96EU/UHD/Arc 140V/140T/B390 共 10 档，`--list-igpu` 列清单、`--igpu <id>` 选型号、`--igpu-download` 才下载（默认关、`--check` 优先、size+sha256 双校验）；型号参考秒数如实标注「社区其它模型、未经实测、不可比」，**不替换** `speedTargetSec`。本轮**未做任何核显硬件实测、未改任何 PyTorch 后端、未实际下载模型**。
- **CPU 指令集识别与加速档（可选，默认关）**：`lib/cpu-profile.js` 识别 CPU 型号 / 物理核心数 / AVX2 / AVX-512 / AVX512-BF16 / AMX-BF16。**实测优先**：Linux 读 `/proc/cpuinfo` 的 `flags`（标 `isaVerified: true`）；Windows / macOS 上 Node 读不到 procfs，退化为型号推断并明确标注「未实测」；型号也认不出来时三项能力给 `null` 而**不是** `false` —— 「不知道」不能当成「不支持」，否则会静默关掉用户本来能用的加速。五档 `cpuAccel`：
  - `off`（默认）：一个启动参数、一个环境变量都不加，与升级前完全一致；
  - `safe`：`--preview-method none`（该值本来就是 ComfyUI 默认，这里是**显式锁死**防预览偷算力）+ 线程钉物理核；
  - `balanced`：`+ --use-pytorch-cross-attention`（**方向上更稳，速度未必更快**，文档里不吹成加速开关）；
  - `max`：`+ --bf16-unet --bf16-text-enc` —— **仅当实测有 AVX512-BF16**；不支持或未知时自动降级到 `balanced` 并在面板里写清降级原因（不会谎称「用户关掉了」）；
  - `force-cpu`：`--cpu`，自动**摘掉** `--highvram/--lowvram/--novram/--reserve-vram` 与 `--use-sage-attention/--use-flash-attention/--use-ck-attention`（后三者要 import CUDA/HIP 扩展，纯 CPU 机器上挂着会启动即崩），并把工作流里 `QwenImage21Cache` 的 `device` 改成 `cpu`（官方说明：KV 缓存放内存、后台预取、几乎不掉速）。
  线程数走 `OMP_NUM_THREADS` / `MKL_NUM_THREADS` / `OPENBLAS_NUM_THREADS` 环境变量（Windows 的 `.cmd` 用 `set`，POSIX 用 `export`）—— **不是** GGUF 加载器的 `n_threads`，ComfyUI-GGUF 的 `UnetLoaderGGUF.INPUT_TYPES` 里根本没有这个字段。合并启动参数时按 argparse **互斥组**裁决（同组只留最后一个），因为同时挂两个不是"后者生效"，是启动直接退出。面板改档位落 `uiState`（重启也记得住），启动参数需重启 ComfyUI 生效、工作流级改动下次出图生效。目标机实测入口：`node scripts/cpu-probe.mjs [--bench] [--dump-config]`（借 ComfyUI 自带 python 问 PyTorch 的 CPU capability，只读）。
- **发布纪律**：版本号与简介同步更新；本版本仅本地改动，npm / GitHub 发布需单独授权。

## 0.19.2 更新说明

- **负面提示词可调**：从"只藏在风格包里"升为面板一级控制项（`画面设置`卡片的「负面提示词」文本框，最长 300 字），与风格包自带的 negative 并存——留空即不覆盖风格包。
- **CFG 可调**：`高级设置`新增「提示词引导 CFG」滑块（1.0–8.0，步长 0.5）。蒸馏链（Turbo8 / 官方 Turbo）强制 1.0（>1 会过曝崩边），原生链默认 2.5，拨了才覆盖。
- **修正发布元数据**：`homepage` / `bugs` / `repository` / `original.repository` 在历史上被误写成占位符，已恢复为真实 GitHub 地址。
- **修复文档链接**：README / INSTALL / 站点页面 / 安装脚本里 68 处公开 URL 曾被同一批占位符误伤，已按发布前的原始文本逐处回填（ComfyUI / ComfyUI-GGUF / ModelScope / AMD ROCm / Comfy Registry 等）。

## 0.19.1 更新说明

- **Comfy 控制浮标可拖动**：Pointer Events 驱动，位移 >5px 才算拖动，位置存 localStorage 并恢复；面板跟随浮标，`grab/grabbing` 光标，键盘 Enter/Space 兜底。
- **视觉精修**：浮标加双层描边 + 顶部锚点边；全局改用系统无衬线字体栈并整体放大字号；滑块轨道 2px → 6px、方钮 10px → 16px。
- **修复开关失效**：切模式（`rebuild`）后旧节点引用导致面板再打不开；开关判定改为读当前节点 + `pointerup` 自行判定点按。

## 0.19.0 新增说明（多参考图批量输入：1–16 张）

### 1. `references` 上限从 3 张提到 16 张

- 依据是 ComfyUI 源码：`TextEncodeQwenImage21` 的 `images` 是 `io.Autogrow.Input`，
  模板名单为 `image_1 … image_16`（`min=0`）。也就是**节点侧本来就有 16 个槽位**，
  旧的 3 张上限只是插件接口层的自我限制（`TextEncodeQwenImageEditPlus` 只有 `image1..3`）。
- 调用方式不变，只是数组可以更长：

  ```json
  { "prompt": "…", "references": ["角色A.png", "角色B.png", "场景.png", "构图.png"] }
  ```

- 接线规则：第 N 张 → `images.image_N`，一个参考图一个 `LoadImage`，按数组顺序。
- **超过 16 张直接报错**（并说明节点只有 16 个槽位），绝不静默截断 —— 传 20 张只用 16 张
  是最坏的失败方式：用户以为生效了，其实后 4 张根本没进链路。

### 2. 编码器按张数分档（旧行为不变）

| 张数 | 编码器 | latent 来源 | sigma |
| --- | --- | --- | --- |
| 0 | `TextEncodeQwenImage21` | `EmptyLatentImage` / `EmptyLatent` | 文生图 8 步 |
| 1–3 | `TextEncodeQwenImageEditPlus`（`image1..3`） | `VAEEncode(第 1 张)` | 编辑 9 步 |
| 4–16 | `TextEncodeQwenImage21`（`images.image_1..16`） | 该节点的第 3 个输出（`LATENT`） | 编辑 9 步 |

1–3 张**继续走 EditPlus**：那是本机真机验证过的编辑链，不为了“统一”去换掉它。
4 张起才切到 2.1 原生编码器，因为 EditPlus 没有第 4 个槽位。

### 3. 同名参考图不再互相覆盖

上一版上传时用 `path.basename(filePath)` 当文件名，`overwrite=true` —— 于是
`refs/1/ref.png` 和 `refs/2/ref.png` 会**静默**变成同一张（后到的赢）。多参考图场景下
这几乎必然发生。现在按序号加前缀：`dshqp-ref-<序号>-<原名>`，一轮内唯一。

### 4. 真机验收（本机 RX 7900 XT / ComfyUI）

- 4 张参考图，旧链路：128 s 出图（`704×704`），槽位 `images.image_1..4` 全部接上。
- 4 张参考图，官方 Turbo：99 s 出图，`latent_image = ["20", 2]`、9 步 sigma 对齐。
- 决定性 A/B：同一 seed / prompt，参考图从全红换全蓝 → 输出平均 RGB 从
  `(219.7, 30.8, 26.7)` 变为 `(26.1, 62.7, 215.3)`，证明 4 个槽位真的被模型吃进去了
  （不是“接上了但没生效”）。

## 0.18.0 新增说明（官方 Turbo 全功能编辑链）

### 1. 官方 Qwen-Image 2.1 Turbo 成为首选链路

- 自动探测 `qwen_image_2.1_turbo_*` 主模型；命中后**不再挂 turbo8 LoRA**。
- 文生图使用官方 **8 步** sigma；编辑/重绘/移除/扩图使用 **9 步** sigma
  （尾部 `0.150000`），CFG 固定 `1.0`。
- 采样改用 `SamplerCustomAdvanced + ManualSigmas`，不再依赖 `simple` scheduler 猜时间步。
- 想回旧链路：`officialTurboEnabled: false`。

### 2. `draw_image` 支持多参考图（0.19.0 起 1–16 张）

- 新参数 `references: [图一, 图二, 图三]`；旧 `reference` 单图写法继续可用。
- 官方链路使用 `TextEncodeQwenImageEditPlus`；图一决定画布，图二/图三用于换装、换头、多图合成。
- 旧 turbo8 链路会自动退化为单图，不静默假装多图生效。

### 3. 局部重绘改为「裁剪 → 采样 → 回贴」

- `InpaintCropImproved → TextEncodeQwenImageEditPlus → SamplerCustomAdvanced → InpaintStitchImproved`
- 采样前可用 `taskMaxCanvasEdge`（默认 `2048`）限制长边；原图回贴尺寸不受影响。
- 上下文扩展默认 `inpaintContextFactor: 1.3`，蒙版外扩 `8px`、羽化 `32px`。
- 回贴前可做 `ColorMatch` 颜色匹配（`taskColorMatch`，默认开）。若 ComfyUI 只有节点、
  却没装 Python 依赖 `color-matcher`，插件会自动摘掉颜色匹配重跑，主任务不失败。
- 修复旧描述过强的问题：**不是“蒙版外每个像素绝对不变”**；羽化/接缝带会有过渡，
  其余区域由原图回贴，不再整图 VAE 往返。

### 4. 新增 `remove_image` / `outpaint_image`

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `inpaint_image` | 按蒙版局部重绘 | `image` / `mask` / `prompt` |
| `remove_image` | 移除蒙版内物体并补全背景 | `image` / `mask` / 可选 `prompt` |
| `outpaint_image` | 四向扩图 | `image` / `left` / `right` / `up` / `down`（百分比） |

### 5. 任务 LoRA 插槽

自动探测并在对应任务里使用：

- `Qwen2.1 一致性无偏移_GH*` → 重绘/多图编辑，默认强度 `0.48`
- `Qwen2.1_万物移除Remove_GH*` → 元素移除，默认 `1.0`
- `Qwen2.1_扩图_GH_3750*` / `*outpaint*` → 扩图，默认 `0.7`

也可用 `consistencyLora` / `removalLora` / `outpaintLora` 手动指定。
**没装任务 LoRA 时任务仍能跑**，返回值和日志会明确写“未使用任务 LoRA”，不会假装已加载。

### 6. DSH 兼容与实测

- 适配 **DSH `0.2.1-rc.5`**（cordis `4.0.5` / Node `24.22.1`），注册 7 个工具。
- 真机验证：官方 Turbo 文生图成功；裁剪回贴局部重绘成功，输出尺寸与原图一致。
- 首次加载约 13–14 GB 主模型可能很慢；这不是采样卡死，后续同模型任务会显著加快。

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

## 0.17.13 新增说明（圈选重绘 UI 三项修复 —— 蒙版不再留垃圾 / 结果图不再裂图）

这一版没有新功能，是**把 0.17.12 刚上的圈选浮层修干净**。三条都是只看代码不跑就可能漏掉的隐患，
新增回归套件 `_inpaint_ui_test.mjs`（19 项断言，已并入 `npm test`）逐条锁住。

### 1. 一次性蒙版不再留在你的出图目录里 ★

改之前的流程：面板圈选 → host 把 base64 蒙版存成 `outputDir/.qwen-paint-mask-<时间戳>.png`
→ 重绘 → **这个文件就留在那儿了**。每圈一次堆一个，还是 dotfile —— 用户自己在目录里
根本看不见，日子久了就是一排隐形垃圾。

现在：`try / finally` 里**用完即删**（ComfyUI 用的是上传时复制过去的副本，删本地这份不影响重绘）。
删除失败也吞掉——它只是个临时文件，绝不能反过来把重绘搞失败。

顺手修掉一个并发隐患：文件名原来**只拼 `Date.now()`**，同一毫秒两次圈选会算出同一个名字，
后写的把先写的覆盖 ⇒ 用户看到"我涂的第二张用了第一张的蒙版"。现在带 6 位随机后缀
（`uiMaskPath()`，纯函数，回归直接断言"连续两次调用不重名"）。

### 2. 结果图不再走"可能裂图"的那条路 ★

内核的 `/api/file?path=…` **只服务"已登记"的文件**（deliverables）。draw_image 的产物走
`tools/result` 钩子登记，所以一向能显示；而**圈选重绘**是 host 直接调
`editToolRef.execute()`，没有任何登记 ⇒ 弹窗里用 `api/file` 看结果，大概率是裂图。

现在插件自己开了一条 `/api/qwen-paint/file`：**直接吐 outputDir 内文件的字节**，边界有三道：

- `isLocalRequest` 只放行本机请求
- 路径**包含检查**：解析后必须仍落在 `outputDir` 之内（`..` 穿越挡掉）
- 只收 `GET / HEAD`，其它方法 405

弹窗内的图片（原图 + 结果图）全部改走这条路由，**预览不再依赖"文件是否登记过"**。

### 3. 连点「再改一次」不再叠罗汉 / 重复点图片不再叠浮层

- 结果图原来每次成功都往卡片里 `append` 一个新 `<img>` ⇒ 连改几次就在弹窗里叠一排，
  越叠越长还把上面的顶出视野。现在固定一个容器，`replaceChildren` **只留最新一张**。
- 圈选浮层原来没有去重 ⇒ 重复点图片会一层层盖上，底层的 pointer / keydown 监听继续挂着
  （监听器泄漏）。现在开新浮层前先把残留的清掉。

## 0.17.12 新增说明（圈选重绘 + 抽卡挑图，两个开关都归用户）

这一版加的是**用户看得见的功能**，不是合规整改。全部默认关闭 ⇒ 升级后行为与 0.17.11 完全一致。

### 1. 圈选局部重绘（点图 → 独立浮层里画）

以前 `inpaint_image` 只能吃**你自己在外部做好的蒙版图**，面板里没有任何圈选能力。
现在：**点结果图 → 弹出一个浮层 → 用画笔把要改的地方涂出来 → 写一句"这块要改成什么" → 开始重绘**。

- 画笔 / 橡皮 / 笔刷粗细 / 清空，白=重绘、黑=保留（ComfyUI 认的就是这个）
- 重绘结果**直接回显在同一个浮层里**，可以连续改
- host 侧新增 `POST /api/qwen-paint/inpaint`，执行的是**同一个** `inpaint_image` 工具
  （校验、节点探测、报错文案全部复用，不存在两套逻辑）

**为什么是独立浮层而不是"在消息里的图上圈"**：那张预览图在 DSH 的**消息树**里，而那棵树由
React 管理 —— 插自己的 DOM 会被下一次渲染重排/清空（这个坑本文件里记着三次失败，最后一次
把界面搞成整片空白）。浮层是自己的 DOM，与消息树完全隔离。

**两个实现细节**（都踩过）：
- 图片要先 `fetch` 取 blob、再用 `blob:` URL 喂 `<img>`：直接画进 canvas 再 `toDataURL`
  会因跨协议被标脏、抛 `SecurityError`。
  （取 blob 的 URL 在 0.17.13 里又从内核的 `api/file?…` 换成了插件自己的
  `/api/qwen-paint/file`——原因见下一节第 2 条。）
- canvas 内部尺寸 = 原图像素，显示时被 CSS 缩放 ⇒ 坐标必须按 `canvas.width / rect.width` 折算。

### 1b. 局部重绘**不再需要任何额外权重**（零下载潜空间重绘）★

⚠ 这是 0.17.12 里的一处**方案替换**：`inpaint_image` 原本要靠
`Qwen-Image-InstantX-ControlNet-Inpainting.safetensors`，但 InstantX 公开的 Qwen ControlNet
是给 **Qwen-Image 1.0** 的（latent 16 通道），本机底模是 **2.1**（64 通道）⇒ 装上也不兼容；
2.1 唯一对得上的官方权重是阿里 `Qwen-Image-2.1-Fun-Controlnet-Union`（7.55 GB，单文件，
8 种控制 + 修复），但它走的是 `ModelPatchLoader` 路径、且官方要求 Comfy-Org 原版底模，
本机是 int8+convrot 量化版，叠加稳定性未验证。**两者都不划算** ⇒ 改为不装任何东西。

现在走 **ComfyUI 自带的潜空间重绘**，原理（`comfy/samplers.py:634-642`）：

- 原图经 `VAEEncode` 成 latent，蒙版挂成它的 `noise_mask`（`SetLatentNoiseMask`）
- 采样**每一步**，蒙版**外**都被强制拉回原图 latent，蒙版**内**按指令重画
- 蒙版内生成时看到的是"周围原图 latent + 按 sigma 加的噪声"，上下文完整 ⇒ 与整体协调
- 蒙版先 `GrowMask` 外扩（默认 8px）再 `FeatherMask` 羽化（默认 16px），用于**缓解接缝**

新增两个可选参数，都填 0 即退回硬边蒙版：

- `feather` 羽化像素 0–64，默认 16（接缝明显就加大）
- `grow` 外扩像素 0–64，默认 8（避免羽化把重绘区吃小）

`denoise` 默认由 1.0 改为 **0.7**：蒙版外**始终**严格保持原样，它只决定蒙版内重画得多彻底 ——
想彻底替换这块用 1.0，轻微改动用 0.4–0.6。

**本机实测**（1024×1024，steps=4，denoise=0.7，21 秒出图）：

| 区域 | 平均绝对差 | 像素变化率 |
| --- | --- | --- |
| 蒙版外（保留区） | 0.48 | **0.00%** |
| 蒙版中心（重绘区） | 12.26 | **98.90%** |
| 羽化边缘带 | 7.27 | 72.88% |

⇒ 保留区逐像素几乎零变化（0.48 的残差是 VAE 编解码往返造成），重绘区 99% 被改掉，
羽化带平滑过渡。**"只改这一块、其余原样"这个承诺是真的。**

### 2. 抽卡「AI 挑图」（开关 `aiPickBest`）

开启后，一次出多张时工具描述会要求模型：

- 用 `read_image` **逐张查看**，挑最好的一张放在最前面推荐并说明理由（构图 / 手部 / 文字 / 贴合度）
- 其余几张也一并列出
- 记住用户对画风的偏好，下次按偏好挑
- **若 `read_image` 不可用，就如实说"这是按参数挑的、没有实际看图"，绝不假装看过**

> 为什么不做"拼图再挑"：4 张缩成 1 张 2×2 会丢细节（手部畸形、文字糊掉正好是缩图后最看不清的），
> 而省下的约 3000 token 在 1M 上下文里只占 0.4%。**用细节换这点 token 不划算。**

### 3. 抽卡「用户自选」（开关 `userPickBest`）

开启后，一次出多张时**并排全部显示**（2 列网格 + 序号），每张都可点开放大/圈选。
关着时仍是"只显示第一张"的旧行为。

> 以前 `presentationMeta` 只带 `path`（第一张），所以出 4 张时界面上**只看得见 1 张** ——
> 这一版把 `files` 也带上，才有得选。

### 4. 两个开关都在面板菜单里，且都落盘

菜单元新增一组「抽卡挑图（重载后生效）」，各两档（开 / 关）。
选择写进 `qwen-paint-ui.json`，重启记得住。

⚠ **为什么要重载才生效**：`aiPickBest` 影响的是**工具描述**，而描述是插件加载时按配置拼的静态文本。
这一点在菜单标题里写明了，免得用户以为选了个坏的。

### 破坏性变更

**无。** 两个开关默认 `off`，行为与 0.17.11 一致；新端点只接受 POST 且过与状态端点**同一套**守卫
（Host / Sec-Fetch-Site / Origin 围栏 + `application/json` + 有界 body + 蒙版限 24 MB）。

---

## 0.17.11 新增说明（AMD 冷启动不再误判超时 + 一套能自己叫的回归）

这一版**没有任何出图行为变更**。改的是"启动宽容度"和"工程护栏"。

### 1. 启动超时：短值 → **120 秒**

真机实测（AMD RX 7900 XT / ROCm）冷启动 ComfyUI 经常要 **60~90 秒**
（要加载 20 GB 显存 + 一堆自定义节点）。原来的超时偏短，会出现
**进程明明还活着、日志里也没有报错，界面却先报"启动超时"** —— 用户只能干等或反复重试。

- 现在判定窗口是 **120 秒**（`LAUNCH_TIMEOUT_MS`，唯一准绳就是这个常量）。
- **不影响**"进程秒退 / 参数被拒"这两条快路径：那些情况一出现就当场判失败，不等超时。
- 代码注释里不再写死具体秒数，一律指向 `LAUNCH_TIMEOUT_MS` ——
  历史上因为"注释和实现不一致"被审核点过两次，这次从根上避免。

### 2. 回归测试：`npm test` 一条命令跑完全部

以前 16 套检查散在 `scripts/` 里，靠人一条条敲。结果就是**有 15 项断言红了三天没人发现**
（它们不在任何清单里，等于没有测试）。现在：

```bash
npm test                 # 全部 16 套，约 4 秒
node scripts/test-all.mjs --only=net    # 只跑名字含 net 的
```

判定口径刻意分成三档，**"跑不了"不算"通过"**：

| 结果 | 含义 |
|---|---|
| 通过 | 退出码 0 且输出没有失败行 |
| 失败 | 退出码非 0，**或**退出码 0 但输出里有 ✗（抓"忘了 exit(1)"的套件） |
| 跳过 | 环境不具备（如沙箱禁止派生进程），如实标注，不冒充通过 |

### 3. 那 15 项红灯的真因：测试过期，不是功能坏了

0.17.8 的 AUTH001 整改把状态端点的写操作从「GET + 查询参数」改成了
「POST + JSON body」，而 `selftest.mjs` 里还在用老写法调用，被新守卫 405 挡住，
于是"改档位没生效"看起来像 bug。

- 实现与前端都是对的，只有测试过期。
- 修法：把测试的调用方式迁到 POST（**一条旧断言都没删改**，`git diff` 里被删的 `check(` 行数 = 0）。
- 另加一条新断言：**GET 带写参数必须被 405 挡住** —— 把"GET 只读"这条约束钉死。

### 4. 仓库整理

- 新增一道闸门：**私人 / 开发报告不允许进公开仓库**（文件名黑名单 + 内容指纹；
  且必须关掉 git 的路径转义，否则中文文件名会扫不到 —— 之前正是这样漏过一次）。
- 移除了仓库里一份不该公开的开发报告。**行为无影响**（插件不读它）。
- 诊断日志每行带上进程号：多个进程共用同一份日志时，不会再分不清哪行是谁写的。

### 破坏性变更

**无。** 已安装的用户升级后行为不变；唯一感知得到的差别是启动判定更宽容了。

---

## 0.17.10 新增说明（修一个阻断级 bug：ComfyUI 请求被拼成 `//xxx` → 404）

这一版**不是**合规整改，是**真机上实测出来的功能性 bug**，而且很严重。

### 现象

在本机把 DSH 更新到 `0.2.1-rc.2` 之后做兼容性验证，插件**加载完全正常**
（5 个工具注册成功、3 条状态端点注册成功、ComfyUI 也被成功拉起），
但状态日志里**从第一条起就是 `online=false`** —— 界面一直停在"未就绪 / 启动超时"。

### 根因

`apply()` 里做回环校验时写的是：

```js
cfg.comfyUrl = assertLocalUrl(cfg.comfyUrl, { … }).toString()
```

而 `new URL('http://127.0.0.1:8188').toString()` 会**把空路径补成 `/`**，结果是
`http://127.0.0.1:8188/`。代码里又有 **15 处** `${cfg.comfyUrl}/xxx` 拼接，于是实际请求变成：

```
http://127.0.0.1:8188//system_stats
```

实测（本机 ComfyUI 正在运行）：

| 请求 | 结果 |
| --- | --- |
| `GET http://127.0.0.1:8188/system_stats` | **200** |
| `GET http://127.0.0.1:8188//system_stats` | **404** |
| `GET http://127.0.0.1:8188//prompt` | **404** |

ComfyUI 用的 aiohttp **不合并重复斜杠**。后果是**整条 ComfyUI 链路全部 404**：
探活（`/system_stats`）、提交（`/prompt`）、取结果（`/history`）、取图（`/view`）、
上传参考图（`/upload/image`）。界面上却只表现为"没反应 / 启动超时"，极难定位。

### 影响范围

**`0.17.2` 起一直存在**（`git show v0.17.2:lib/index.js` 里已有这行规范化）。
也就是说从 0.17.2 到 0.17.9，**ComfyUI 后端实际是不可用的**。

> 顺带说明为什么之前没被发现：`lib/hipfire-img.js` 里**早就自己做了**
> `String(cfg.hipfireUrl).replace(/\/+$/u, '')` —— 说明这个坑在 hipfire 链路上踩过并修了，
> 但 `comfyUrl` 这一侧漏了。而且这条链路的测试一直只测"函数被调用"，
> **没有任何一条断言去检查"拼出来的 URL 长什么样"**。

### 修法

在 `apply()` 里统一去掉**末尾的**斜杠（只去尾部，带路径前缀的地址如
`http://127.0.0.1:8188/comfy` 不受影响）：

```js
const trimTrailingSlashes = (u) => u.replace(/\/+$/, '')
cfg.comfyUrl = trimTrailingSlashes(assertLocalUrl(…).toString())
cfg.hipfireUrl = trimTrailingSlashes(assertLocalUrl(…).toString())
```

### 回归锁（防止再犯）

`scripts/test-net-guard.mjs` 新增 **`[10]` 组 8 项**，既钉住"坑本身"也钉住"修法"：

- `toString()` 确实会补尾斜杠（把坑的事实写进测试）
- 直接拿它拼路径会得到 `//system_stats`
- 去尾斜杠后拼出 `http://127.0.0.1:8188/system_stats`
- 带路径前缀的地址不被误伤
- 源码级：`cfg.comfyUrl` / `cfg.hipfireUrl` 的赋值必须走 `trimTrailingSlashes`，
  且**不许**残留"直接 `toString()` 赋给 comfyUrl"的写法

net-guard 自测因此从 **62 项**增至 **70 项**。

## 0.17.9 新增说明（COMPAT001：兼容声明改为"实测后填写"）

审核上一轮另提出 **COMPAT001**：称官方最新三版为 `0.21-alpha.3 / alpha.4 / alpha.5`，
而本插件 manifest 只声明了 `0.2.0-rc.2`，要求「**在实际验证后**补当前窗口至少一版的准确声明
及证据，其余保留 unknown」。这一条已按原要求做完 —— **先实测，再声明**。

### ① 先厘清版本指代

审核笔下的 `0.21-alpha.x` 是 `@deepseek-ai/dsh`（`dsh` 命令本体）的 **`0.2.1-alpha.x`**。
该包 npm dist-tags 实测为：`latest 0.2.0-rc.2` / `next 0.2.1-rc.2` / `alpha 0.2.1-alpha.5`
（`dsh.compatibility.dsh` 声明的就是它）。
另注：Electron 桌面外壳 `dsh-tui` 是**另一套版本号**（本机 `0.13.0`，npm 最新 `0.15.0`），
与这里的 `dsh` 版本不是同一个东西 —— 0.17.8 的说明里曾把两者混为一谈，此处更正。

### ② 隔离实测（不动正在使用的环境）

用一次性目录装被测版本，并用 `$DSH_HOME` 指向临时目录做 profile 隔离
（DSH 的 profile / 配置 / 日志全部在 `$DSH_HOME` 下，因此**不会碰** `~/.dsh`）：

```
mkdir /tmp/dsh-a5 && cd /tmp/dsh-a5 && npm i --prefix . @deepseek-ai/dsh@0.2.1-alpha.5
DSH_TEST_INSTALL=/tmp/dsh-a5 node scripts/test-dsh-compat.mjs
```

### ③ 实测结论（历史版本各 7 项；0.18 的 rc.5 为 8 项）

| 被测版本 | 来源 | 结果 |
| --- | --- | --- |
| `0.2.1-alpha.5` | 一次性目录安装（审核点名的当前窗口最新 alpha） | 7 / 7 通过 |
| `0.2.1-rc.1` | 本机实际安装 | 7 / 7 通过 |
| `0.2.1-rc.2` | 一次性目录安装（`next` 通道） | 7 / 7 通过 |
| **`0.2.1-rc.5`** | **当前桌面端版本 / 一次性目录安装** | **8 / 8 通过** |

前 7 项：模块能被该版本 import、`name` / `inject` / `apply` 契约成立、
该版本**真实**的 `tools` 服务可用、`apply()` 无异常跑完、确实注册出工具。
第 8 项：0.18 的 7 个工具集合完整
（`draw_image`、`list_available_models`、`check_acceleration`、`upscale_image`、
`inpaint_image`、`remove_image`、`outpaint_image`）。
0.18 另在本机 `0.2.1-rc.5` 桌面上完成官方 Turbo 文生图、裁剪回贴重绘与四向扩图的真机冒烟。

另外在 `0.2.1-alpha.5` 下还跑通了两条"装载链路"证据：
`dsh plugin --profile <name> add <本包>` 安装成功（plugin-manager 把本包登记为 bundle），
`dsh --profile <name> --dump-config` 退出码 0 且合成树里确实出现 `qwen-paint` 条目及其 config。
（该版本 profile 的 app 启动后无输出并常驻；**用不含本插件的对照 profile 做同样启动，行为一致**
⇒ 该现象是基线行为，与本插件无关。）

### ④ 诚实边界（"compatible"在这里的准确含义）

- 验证到的是 **manifest + patch + cordis 加载/注册链路**；**不含**端到端出图
  （出图还需要本机 ComfyUI 与模型权重，是另一件事）。
- 唯一的替身是 `systemPrompt`：完整 dsh app 才提供它，而该脚本刻意**不启动整个 app**
  （那会进入交互式 TUI 并需要登录），只挂载 `tools` 这一层；`tools` 本身是被测版本的真实实现。
- `0.2.1-alpha.3` / `alpha.4` 及其它未实测版本**保持 unknown**，不因为"同系列"就顺手写成兼容。

### ⑤ 声明已写入

`dsh.compatibility.dshReleases` 现为 `0.2.0-rc.2` + 上述三版，并在 `note` 里写明验证范围与日期。
该结论可由 `scripts/test-dsh-compat.mjs` 一键复跑（环境不具备时它明确 **SKIP**、退出 0，
不会把"没测"伪装成"通过"）。

### ⑥ 顺带修掉一个真实存在的发布体积问题

做上面这些事的时候顺手核了一遍体积，发现 **`lib/index.js` 已经涨到 263,997 B，
超过了 DSH Store 的单文件上限 262,144 B**（超限文件会被判"扫描面不完整"，
等于**审不到主文件**——对一个正在接受安全复核的插件，这比"体积大"本身严重得多）。

这不是新问题：`v0.17.5` 是 253,729 B（达标）、`v0.17.7` 已到 260,375 B（勉强达标），
`v0.17.8` 就超了。而仓库里**本来就有**这道护栏（`scripts/selftest.mjs` 的
「发布体积护栏」，逐文件比对 262,144 B），只是它一直没被跑到
（`selftest.mjs` 卡在需要真机 ComfyUI 的端到端段，跑不到护栏那一段）。

处理方式与之前两次一致（`index.js` → `config.js` → `describe.js` 都这么来的）：
把**加速包探测与安装**整块搬到 `lib/comfy-accel.js`，**逻辑一行未改**（只给 `function` 加了
`export`，`lib/index.js` 改为 import）。搬完 `lib/index.js` 降到 **250,350 B**，
新文件 15,346 B，两者都远低于上限。

**这一块的挑选不是随手挑的**：它自洽（依赖全部来自 `./config.js` 与 node 内置模块）、
且没有任何测试按名字引用它，所以搬迁面最小。搬完后 14 套离线回归全部通过
（含用到被搬函数的 `_gpu_vendor_test` / `_mac_env_test` / `_opt_status_test`）。

> ⚠ 如实说一句：`selftest.mjs` 在这台机器上**仍然跑不完整**（卡在需要真机 ComfyUI 的
> 端到端段，那里会一直等）。所以这道体积护栏目前是**靠人工核算 + 上面那次手工核查**
> 保证的，不是靠自动跑。要让护栏真正生效，得把 `selftest` 拆成"离线部分 / 需真机部分"
> 两段——这件事列进后续待办，不在本版范围。

## 0.17.8 新增说明（AUTH001 收尾：写入口的最后边界）

审核复核 `0.17.7` 后确认 **Host 缺失拒绝、cross-site / Origin 围栏、客户端改用 POST 均已通过**
（并明确"不要求所有请求必须带 Origin"），AUTH001 缩小到写入口的三条边界。**三条都属实**：

### ① 状态 POST 不检查 `Content-Type`
原先只校验方法是 POST，没校验媒体类型 —— `text/plain` 的"简单请求"（跨站表单能发、
且**不触发 CORS 预检**）也能把 JSON 塞进来。现在：非 `application/json` ⇒ **415**。

### ② `repair` 端点不限方法、不限媒体类型
审核原话：*"任意方法的 JSON `confirm:true` 都会进入 `runRepair`"* —— 确实如此，
原先连 `GET` 带 body 都能触发修复。现在：非 POST ⇒ **405**；非 JSON ⇒ **415**；
正文统一走**有界**解析（与状态端点、`memory/preference` 同一套）。

### ③ 状态 GET 的故障分支会改配置
审核原话：*"`recoverFromSageCrash` 会把 `cfg.nvidiaSageAttention` 改为 false。
请把配置恢复放到后台生命周期或显式写操作，GET 只展示状态。"*
这也是一处**有副作用的 GET**，与刚改掉的"GET 写配置"同性质。现在：
- 状态 GET 只**标记原因 + 记日志**（`launch.sageSuspect`），**绝不改 cfg**；
- 自动回退**保留**，仍在**后台启动流程**里（`launchComfy` 的失败分支），
  那条路径不依赖任何 HTTP 请求、本来就会生效。

### 统一的写入口守卫

新增 `guardWriteRequest(req, res)`：**任何动作之前**先判方法与媒体类型，
不通过就 **405 / 415** 并直接返回 —— 不读 body、不碰 `cfg`。
状态 POST、`repair`、`memory/preference` 三处全部接入。

回归测试扩到 **48 项**（新增 14 项覆盖 405/415 的各类方法与非 JSON 媒体类型），
三套合计 **184 项**全部通过。

### 关于 COMPAT001（兼容声明）

审核另提出：当前官方最新三版是 `0.21-alpha.3 / alpha.4 / alpha.5`，
而本插件 manifest 只声明了 `0.2.0-rc.2`，要求"**在实际验证后**补当前窗口至少一版的准确声明及证据，
其余保留 unknown"。

**本版（0.17.8）当时的处理**：按"实际验证后才声明"的要求，**没有**写未经验证的兼容声明，
`dshReleases` 仍只列已确认的 `0.2.0-rc.2`，其余保持 unknown。

> ⚠ 这一段的**包名称写错了**，在此更正：本机实际安装的 `dsh` 命令是
> **`@deepseek-ai/dsh` 0.2.1-rc.1**；上文提到的 `dsh-tui 0.13.0` 是 Electron 桌面外壳的
> 版本号，两者不是同一套版本。
>
> ✅ **已在 0.17.9 完成**：搭了一次性隔离环境实测 `0.2.1-alpha.5 / rc.1 / rc.2`（各 7 项全过），
> 声明与证据见上方 [0.17.9 新增说明](#0179-新增说明compat001兼容声明改为实测后填写)。

## 0.17.7 新增说明（AUTH001 整改：本机 HTTP 接口的调用方与写入边界）

审核在 Issue #1390 复核 `0.17.6` 后，确认此前各项整改已通过
（含 Tool-view 归属"已审清，不再作为待审理由"），并给出**唯一**剩余项 **AUTH001**：

> `lib/index.js` 的 `isLocalRequest` 只看 Host 和 socket 的本机地址；**缺失值也放行**，
> 不检查 Origin、Sec-Fetch-Site 或宿主调用方身份。状态 GET 处理器修改运行配置…
> **让状态 GET 保持只读，写配置移到显式 POST JSON。**

**两条都属实。** 这是典型的 confused-deputy 面：**来自其它网页、但目标地址为本机的请求，
Host 和 socket 仍然是本机** —— 单纯"只允许本机连接"并不证明**发起请求的网页**可信
（CORS 也挡不住有副作用的 GET）。

### ① 请求信任判定：与官方 `api-request-trust.ts` 等价

`isLocalRequest` → **`isTrustedRequest`**（旧名保留为兼容别名），判定顺序逐条照官方实现：

1. **Host 围栏**（防 DNS rebinding）：**每个请求都过**。Host 缺失 / 无法解析 / 不是回环 ⇒ **拒绝**。
   理由：Host 是 rebinding **唯一无法伪造**的头 —— 浏览器按"它以为在跟谁说话"填 Host。
   > 原版这里是 `host === '' → 放行`，即审核点名的"缺失值也放行"，已改为**缺失即拒**。
2. **跨站围栏**：`Sec-Fetch-Site: cross-site` ⇒ **拒绝**（不论 Origin）。
3. **Origin 围栏**：带了 Origin 就必须与本机 Host **同源**；`Origin: null`（沙箱 iframe / `file:`）
   是不透明源 ⇒ 拒绝；**没带 Origin 则放行**（官方原文：*"Absent Origin is fine —
   the Host fence above already bound the request."*）。

另外保留 socket 检查（有值时必须是回环）作为附加一层。**不做**"必须有 Origin"的硬性要求 ——
官方实现同样不要求，把它变成硬性条件会误伤非浏览器客户端。

### ② 状态端点：GET 只读，写配置移到 POST JSON

- 原先 `?idleMinutes=` / `?flowStyle=` / `?drawTrigger=` / `?preset=` / `?start=1`（**启动 ComfyUI**）/
  各类开关与档位 / `?outputDir=` 全部是 **GET 带 query 就能改配置**。
- 现在 `queryLc` 这张参数表**只从 POST 的 JSON body 填充**；GET 时它是空的 ⇒
  下面所有写分支**自然全部失效**（无需逐个改，也就不会漏）。
- GET 若携带任何非只读参数（白名单仅 `ping`）⇒ **405 并明确提示改用 POST**，不静默忽略。
- 客户端 `lib/client.js` 同步：新增统一入口 `postStatus(params)`，**9 处写调用全部改走它**。
- **顺手修掉一个真 bug**：客户端"改目录"那处写的是 `` `${API}/status.json` ``，
  而 **`API` 这个标识符在 `client.js` 里从未定义** ⇒ 拼出来是 `undefined/status.json`，
  请求必然失败（此前被 `window.prompt` 被拦后提前 `return` 掩盖了）。

### ③ 回归测试（`scripts/test-request-trust.mjs`，34 项）

覆盖审核的验收条件：本机 Host + `Origin: https://untrusted.example` / `Sec-Fetch-Site: cross-site`
**必须被拒**；同源 Origin 与"无 Origin"正常放行；`Origin: null` / `file:` / 伪装域名
（`localhost.evil.com`）/ Host 缺失 一律拒绝；跨站标记**压过**同源 Origin；
以及源码级回归锁（服务端 GET 只读 + 客户端无 GET 写调用 + 不再引用未定义的 `${API}`）。

> 三套测试合计 **170 项**（net-guard 62 + workflow-contract 74 + request-trust 34），全部通过。

## 0.17.6 新增说明（修正一处"注释与实现不一致"）

审核在 Issue #1390 复核 `0.17.5` 后，确认基础预检与有界文本读取完整、
`lib/net-guard.js` 的回环检查与 `redirect: 'error'` **有源码依据**，
并确认 `ACCEL_SOURCES` / `runInstallSource` 的装包行为**会访问外部供应链**
（因此不能概括成"全部网络只有回环" —— 这一点已在 0.17.3 起如实披露）。

**本版只改一处**：`lib/config.js` 里 `check_acceleration` 工具上方的注释原写
*"默认 `accelAutoInstall: false`，让'装不装'由人决定"*，而**实际默认值是 `true`**
（插件加载后会自动检测并安装白名单内的加速包）—— 属"注释与实现相反"。
已改为与实现一致，并写明"要恢复'只报告、不自动下载'请显式设 `accelAutoInstall: false`"。

同时做了一次**同类问题自查**：扫描 `DEFAULTS` 里全部 25 个布尔配置项，
比对"注释里说的默认值"与"实际默认值"，**未发现其它矛盾**。

> ⚠ 能力本身**保留不变**（审核也说明"保留该能力可以走受审路径"）：
> 自动触发、白名单包与来源、子进程参数与环境、用户关闭路径、Tool-view key 作用域，
> 均已在 README「权限与已知风险」与「0.17.3 / 0.17.5」章节中逐项披露。

## 0.17.5 新增说明（真实用户反馈 → 3 个致命 bug 修复 + 契约测试）

**来源：插件市场的真实用户反馈（A 卡用户）**，不是审核意见。逐条回代码 + 回 ComfyUI 源码核实后，
**3 个致命 bug 全部属实** —— 这也是本项目一直标注的「真机端到端未验证」所付出的实际代价。

### 🔴 三个致命 bug（放大 / 局部重绘在真机上必崩）

| 症状 | 根因 | 位置 |
| --- | --- | --- |
| **放大**（`upscale_image`）必崩 | `LoadImage` 的输入名写成了 `upload`，正确是 **`image`** | `lib/index.js` 3 处 |
| **局部重绘**（`inpaint_image`）必崩 | ① 同上 `upload`；② `LoadImageMask` 漏了必需的 **`channel`**；③ `ControlNetInpaintingAliMamaApply` 漏了 **`strength` / `start_percent` / `end_percent`** | `lib/index.js` |

**判定依据（不是推测，是 ComfyUI 源码）**：
- `nodes.py` 的 `LoadImage.INPUT_TYPES` → `{"required": {"image": ...}}`
- `nodes.py` 的 `LoadImageMask.INPUT_TYPES` → 在父类基础上追加 `"channel": (["alpha","red","green","blue"],)`；
  取值 `'red'` 与官方 blueprint「Image Inpainting (Qwen-image).json」里 `ImageToMask` 的 channel 一致
- `comfy_extras/nodes_controlnet.py` 的 `define_schema()` → 三个 Float.Input；
  取值 `1.0 / 0.0 / 1.0` 与官方 blueprint 里该节点的 widget `[1, 0, 1]` 一致

> ⚠ **为什么只有这两条链崩、主链路却是好的**：同一份工作流代码在 `config.js` 与 `lib/index.js`
> 各写了一遍，`config.js` 那处用的是**正确**的 `image`。这是典型的"复制粘贴时只改了一处"。

### 🟡 其余修复

- **「改目录」按钮点了没反馈**（用户原话）：根因是那段依赖 `window.prompt` / `window.alert` 做交互与回执，
  而 **DSH 桌面端会拦这两个**；更糟的是 `window.prompt` 写在 `try` 外面，一抛错连 `catch` 都进不去。
  ⇒ 改为**面板内联输入**（点一下就地长出输入框，回车/点确定提交，回执显示在同一行），**全程不依赖原生弹窗**。
- **ControlNet 与 2.1 底模不兼容**（用户实测：InstantX 公开权重是给 **Qwen-Image 1.0** 的，
  latent 16ch vs 2.1 的 64ch，执行层 unpack 崩）：`inpaint_image` 的工具描述现在**在动手之前**就写明这一点；
  并新增 `readSafetensorsConvInChannels()` 读权重 header 做**保守**提示 ——
  **只在"只见到 16、没见到 64"时才警告**，其余一律不吭声（宁可漏报，绝不误报）。
- **`steps` 在 turbo8 链是"假控制"**（用户实测）：`forceTurbo8Steps` 默认为 `true`，
  此时用户传的 `steps` 会被丢弃、强制 8 步。这是**设计如此**（turbo8 是 8 步蒸馏 LoRA），
  但 schema 原先没说明 ⇒ 现在 `steps` 的参数描述里写明该条件下无效及如何解除。

### 🟢 新增：节点输入名「契约测试」（这才是能拦住这类错的东西）

三个 bug 之所以能溜到用户手里，是因为**当时所有测试都只验"结构"、从不验"输入名"**。

- `scripts/extract_comfy_schema.py` —— 用 Python `ast` 解析本机 ComfyUI 的
  `nodes.py` / `comfy_extras/*.py`，提取每个节点 `INPUT_TYPES()` 的 `required` / `optional` 键
  （新式 `io.ComfyNode.define_schema()` 也支持），并**正确处理继承** ——
  仅当子类调用了 `super().INPUT_TYPES()` 才合并基类键（`LoadImageMask` 是这种），
  完整重写的（如 `LoraLoaderModelOnly`）**不合并**，否则会污染契约。
  本机实测：扫描 150 个 `.py`、提取 **631 个节点**。
- `scripts/comfy-node-contract.json` —— 上述解析结果，固化成文件。
- `scripts/test-workflow-contract.mjs` —— **74 项断言**，读契约比对 `lib/` 里构建的所有工作流：
  ① 必需输入必须齐全；② 不得出现 ComfyUI 不认识的输入名；③ **回归锁**（三个坑必须保持修好）。
  **纯 JS、不需要 ComfyUI 在跑、不需要联网、不派生任何子进程**。

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
- **区分清楚"不下载什么"**：插件**不自动下载任何模型权重**（提供的是可选、默认关闭、需你显式执行的下载包：`--video-models` / `--igpu-download` / `--tier`），也**不自动安装第三方自定义节点**。
  ⚠ 2026-11-13 订正：早期版本写成「插件不下载模型权重」，容易让人误读成「不支持视频模型下载包」；  实际视频模型自动下载包一直随插件提供，只是从不默认开启。

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
> （Windows / Linux 上的核显是另一回事：那边有 XPU / 共享显存路径，见「核显 / 共享显存」。）
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
- 三个千问模型文件（共约 14.2 GB）：
  - `qwen_image_2.1_turbo_int8_convrot.safetensors`（官方 Turbo UNET，放 `models\diffusion_models\`）
  - `qwen3vl_8b_w4a8.safetensors`（CLIP、`type=qwen_image`，放 `models\text_encoders\`）
  - `qwen_image_2.1_vae_bf16.safetensors`（VAE，放 `models\vae\`）
- 旧安装里的 `qwen_image_2.1_int8_convrot.safetensors` 仍可回退使用；
  只要 Turbo 文件存在，0.18 默认优先官方 Turbo。
- **不需要**任何 Python 环境、不装任何第三方包 —— 插件本体是纯 Node ESM，**零外部依赖**。
- 裁剪回贴需要 `ComfyUI-Inpaint-CropAndStitch`（提供 `InpaintCropImproved / InpaintStitchImproved`）；
  官方采样需要 ComfyUI 自带的 `ManualSigmas / SamplerCustomAdvanced`。

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
node scripts/setup.mjs --comfy 本机 ComfyUI     # 指定 ComfyUI 目录
node scripts/setup.mjs --tier full|lite       # 直接指定主模型档位（见下）
```

它会：① 自动找 ComfyUI；② 把三个模型下到正确目录并**逐个 SHA256 校验**（校验不过的一律删除）；  
③ 调 `install.mjs` 把插件挂进 DSH profile。

### 主模型两个档位（小显存适配）

装的时候会问一句，两个档位：

| 档位 | 主模型 | 体积 | 适合 |
|---|---|---|---|
| **完整档**（默认） | `qwen_image_2.1_turbo_int8_convrot.safetensors`（官方 Turbo） | 6.8 GB | 显存 ≥ 8 GB，官方 8/9 步工作点 |
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
Intel 核显走「共享显存」路线（见下一节），**能出图但明显偏慢**，不再劝退。

### 核显 / 共享显存 / 8 GB 内存（0.2.0 新增）

核显没有独立显存，是拿**系统内存**当显存用。插件对这条路径的做法：

- **识别**：Intel UHD / Iris Xe 等核显会被判成 `intel_igpu`（`sharedMemory: true`），
  不会被误当成"小显存独显"。
- **启动参数**：自动加 `--lowvram`（权重按需换入内存），不挂任何厂商加速包 ——
  核显上装那些包只会拖慢启动、不会变快。
- **精度档**：共享显存**无论报多大显存都强制最轻档**（GGUF Q4），这是核显上最稳的选择。
- **不误下 CUDA 包**：安装脚本对 Intel 分支不会去下 N 卡的便携包，默认推荐轻量档。
- **门槛是量化的**：`check_acceleration` 会给出具体秒数目标与建议档位，
  字段带 `unverified: true` —— 这是**默认目标值，未经真机实测校准**，真机跑一张后替换。

实测口径（请按自己的机器复核，别当承诺）：

| 硬件 | 能否出图 | 默认速度门槛（unverified） |
|---|---|---|
| 核显 + 8 GB 整机内存 | 能，但明显偏慢 | 约 360 s / 张 |
| 核显 + 16 GB 整机内存 | 能，达到可接受区间 | 约 180 s / 张 |
| 独显 8 GB | 能 | 约 120 s / 张 |
| 独显 ≥ 16 GB | 能，舒适 | 约 60 s / 张 |

> ⚠ 上表是**待校准的默认目标值**，不是实测结论。分辨率、步数、并发都会显著改变结果。
> 想让 8 GB 机器更快：选轻量档（GGUF Q4）+ 降 `megapixels`（如 0.5）+ 关掉并发。

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

#### 用户可选的核显型号（0.2.0 追加，2026-11-13）

上面那条是**按内存/显存自动判档**；这里再给一条**按具体核显型号自己选**的路子。
型号档案在 `lib/igpu-profiles.js`，安装脚本里三个开关：

```bash
node scripts/setup.mjs --list-igpu                    # 列出全部可选型号与建议（零联网 / 零下载）
node scripts/setup.mjs --igpu amd-780m --check       # 指定型号看建议，只看不改
node scripts/setup.mjs --igpu amd-780m --igpu-download   # 只有显式加这个开关才会下载
```

| 品牌 | 可选型号 | 建议后端 | 建议量化 | 建议边长 |
|---|---|---|---|---|
| AMD | Radeon **780M** / **680M** / **760M** / **660M** | DirectML | GGUF Q4（弱档建议更轻、自备） | 720（660M 建议 512） |
| AMD | Radeon **8060S**（Ryzen AI Max+ 395） | ROCm 原生（gfx1151） | 可考虑 BF16 / FP8 | 720 |
| Intel | **Iris Xe 96EU** / **UHD** / **Arc 140V** / **140T** / **B390** | OpenVINO | GGUF Q4（UHD 建议更轻、自备） | 720（UHD 建议 512） |

优先级（按用户清单的综合体验口径，非跑分）：`Arc B390 > 780M ≈ Arc 140V > 680M ≈ Iris Xe 96EU`。

> ⚠⚠ **三条必读，别把清单当承诺**
> ① 清单里的秒数（780M 约 15 s、680M 约 120 s、Iris Xe 512² 约 12 s、Arc 140V 约 54 s 等）
> 来自用户提供的机型清单 / 社区公开分享，测的是 **SD 1.5 / SDXL / Z-Image-Turbo 等其它模型**，
> 与本插件的 Qwen-Image 2.1 工作流**不可直接比较**，也**不是本插件实测**；
> 档案里每条都带 `unverified: true` / `comparable: false`，**绝不替换** `speedTargetSec`。
> ② DirectML / OpenVINO 需要**用户自己更换 ComfyUI 的 PyTorch 后端**，插件不自动装、不自动改环境；
> Windows ROCm 官方原生支持的核显目前只有 8060S（gfx1151）这一档。
> ③ **自动下载默认关闭**。下了也是按服务器权威值校验：
> `qwen-image-2.1-UC-Q4_K_M.gguf`，`4604558112 B`，
> sha256 `e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41`；
> 大小或哈希不符一律删除。`--check` 永远不下载。前置条件会如实列出：需装
> `ComfyUI-GGUF`，且节点要认 `general.architecture=qwen_image21`
> （本机这版 `IMG_ARCH_LIST` 只有 `qwen_image`，**严格名不匹配**，可能需要升级节点）。

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
| `references` | 1–16 张参考图路径（按数组顺序接 `image_1…image_16`）；1–3 张走 `TextEncodeQwenImageEditPlus`，4–16 张走 `TextEncodeQwenImage21` 的 `images.image_N`；超过 16 张直接报错 |
| `controlImage` | ControlNet 控制图路径；官方 Turbo 图暂不接 ControlNet，会自动留在旧链路 |

另有两个专用工具：

| 工具 | 说明 |
|---|---|
| `inpaint_image` | 局部重绘：`image` + `mask` + `prompt`；裁剪回贴，9 步 |
| `remove_image` | 元素移除：`image` + `mask`；可选 `prompt` |
| `outpaint_image` | 四向扩图：`image` + `left/right/up/down` 百分比 |

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
  → 所以**绝不会误关你自己打开的、正在本机 ComfyUI 里用的 ComfyUI**。
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
| 报"连不上本机 ComfyUI"            | ComfyUI 没启动。先启动本机 ComfyUI（例如双击你本机 ComfyUI 的启动入口），等引擎起来再画                                        |
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
| `comfyOutputDir`        | `本机 ComfyUI 的 output 目录（自动探测）`      | 先在本地取文件，取不到才走 `/view`          |
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
- **workflow 照抄开发机上已验证的那份**（`<ComfyUI>\app.py` 的  
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
   - **模型权重不在此列**：插件**不会自动下载** Qwen-Image / Wan / Qwen3-TTS 等模型权重，也不自动安装第三方自定义节点 —— 随插件提供的是**可选、默认关闭**的下载脚本（`--video-models` / `--igpu-download` / `--tier`），要不要跑、跑哪一档都由你决定；缺件时插件给明确指引，**不会假装已装上**。
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

**BSL 1.1（Business Source License 1.1，SPDX `BUSL-1.1`）** —— 见 [LICENSE](LICENSE)。  
**BSL 1.1 不是 OSI 核准的开源许可证**。它授权复制、修改、派生、再分发与**非生产使用**；  
本项目的 `Additional Use Grant`（附加使用授权）为：**除下列「竞争性使用」外，任何个人、
团队或企业均可免费在生产环境中使用本作品**。「竞争性使用」仅指两类：

1. 将本作品作为**托管（hosted）或代管（managed）服务**提供给第三方；
2. 将本作品（或其修改版）**嵌入、捆绑或包装为与授权方产品构成直接竞争的商业产品**进行销售或分发。

上述两类用途仍需向 Licensor 取得商业许可，或停止使用。授权以 LICENSE 中的**中文原文为准**，
英文仅为非约束性参考译文。该授权属于 BSL Covenants 第 2(a) 条下的**追加**权利，
**不收窄**条款原本授予的非生产使用权。

| 参数 | 值 |
| --- | --- |
| Licensor | **@yanfei0725**（单一主体） |
| Licensed Work | `dsh-qwen-paint` **0.33.0 及以后版本** |
| Additional Use Grant | 除两类「竞争性使用」外，**生产使用免费**（以 LICENSE 中文原文为准） |
| Change Date | **2030-11-15**（自 2026-11-15 起四年） |
| Change License | **Apache License, Version 2.0** |

按 BSL 条款，实际生效日取 `Change Date` 与「该版本首次公开发布四周年」**两者中较早者**，  
且每个版本各算各的。到生效日，该版本即改按 Apache-2.0 授权，**「竞争性使用」限制随之消失**（该限制只存在于附加使用授权中）。Apache-2.0 与 GPLv3 兼容，  
而 GPLv3 属于条款所说的「GPL Version 2.0 or a later version」，因此满足 Covenants 要求；  
CockroachDB、Moonlink 等 BSL 1.1 项目同样使用 Apache-2.0 作为 Change License。条款还允许  
并列指定额外的 Change License，如需再加 `GPL-2.0-or-later` 可以后补。

⚠ **已发布版本不受影响**：`0.32.1` 及更早版本当初按 MIT 授权，该授权永久、不可撤销，  
**不因本次换证被追溯收回**；从 `0.33.0` 起才适用 BSL 1.1。第三方组件（ComfyUI 及各  
`custom_nodes`）仍各自按其原许可，本仓库中提及第三方 MIT 许可的说明保持不变。BSL 的  
Licensor 自 0.33.0 起为**单一主体** `@yanfei0725`；原作者 `@奇迹与你` 的版权署名仅对应  
MIT 授权的旧版本，见 LICENSE 文末。

条款正文逐字取自 MariaDB 官方 BSL 1.1（未作任何改动），参数区仅填写上述 5 个参数与说明。

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

## 1.2.0 补充实现细节（本版新增能力）

> 以下记录 1.2.0 本版新增能力的实现细节与诚实边界。`UI_BUILD` 已升到 **2026-11-18.2** 供真机刷新自证。本节只记事实与边界；真机侧尚未自证的部分如实标注，不把未验证能力写成已验证。

### ★ 人物替换：Rust 纯 CPU 底座 + 发现即跑 / 缺件降级
- 新增可复现 Rust 工程 `tools-rust/dshqp-portrait/`（`Cargo.toml` / `Cargo.lock` / `src/main.rs`），编译产物 `assets/bin/dshqp-portrait.exe`（703,488 B，SHA256 `1224a665dc1f29ff139c33e4628a779455bd2d5068408ead169c2cb0e6149053`）随 `assets/` 走打包分发。**纯 CPU、无模型、无 GPU、无网络**：stdin 一行 JSON → stdout 一行 JSON，做缩放 / 可选色键抠图 / 边缘羽化 / alpha 贴图，输出 PNG。最终 exe 已把编译期带进来的 64 条本机 cargo 路径做等长中性化，不夹带真实用户目录。
- JS 侧 `lib/local-portrait.js` 做三层围栏：内置 exe 相对解析、输入路径必须在出图目录、Rust 回报路径二次校验；执行器由宿主注入，不自行 spawn。`lib/portrait-endpoints.js` 提供 `/portrait/capabilities`、`/portrait/register`、`/portrait/compose` 三条本机端点，发现 InstantID / PuLID / IP-Adapter FaceID / ReActor 节点后给「已发现可跑」或「缺件 + 安装引导」。
- **诚实边界**：本地 CPU 合成是**贴图预演**，不是像素级换脸；真·身份保持重绘依赖本机 ComfyUI 装好身份保持节点与几 GB 模型权重，插件**不捆绑、不代下**。当前只登记节点发现与引导，不谎称已具备真换脸能力。

### ★ PPT 讲解图片：真写进文件，不是链接占位
- `lib/pptx-lite.js` 扩展 `slides[].images`：支持 `data` / `data_url` / `bytes`，魔数白名单校验后写入 `ppt/media/imageN.ext`，同步补 `p:pic`、`a:blip r:embed`、slide rels 与 `[Content_Types].xml`。出图目录围栏不变，body 上限放宽到 48 MB。
- Agent 可在 slides JSON 里用 `images:[{name,x,y,w,h}]` 精确指定页与位置；未指定时 UI 把拖入图片按顺序轮流分配到各页。**图片必须真进 PPT**，坏图跳过且不伪造成功。

### ★ UI 折叠与拖拽
- `assets/panel.js` 新增通用 `foldCard()` 与 `dropZone()`：混合链、素材库、角色参考、hybrid 四段模型选择改为可折叠卡片；PPT 卡加「讲解图片」多图拖拽区，人物替换卡加「参考图 / 场景图」「选定人物图」双拖拽区。新按钮用独立类名 `cp-pptx-go` / `cp-swap-go`，**不与逐次同意检索按钮 `.cp-ref-search` 抢类名**。
- 折叠 `toggle` 后调用 `syncPanelPos(nodes.fab, nodes.panel)`，面板高度变化仍保持底缘贴浮标上缘，不翻下方、不变形。`UI_BUILD = 2026-11-18.2`。

### ★ 验证口径与未闭环项
- 专项：`test-local-portrait.mjs` 48/0、`test-pptx-lite.mjs` 47/0、`test-ui-perf.mjs` 81/0、`test-js-lexer.mjs` 22/0、`test-history.mjs` 195/0；全量回归 **113 套 / 0 失败 / 7,418 项断言 / 32.0 s**。`check-size` 实采 **138 个 lib / 2,067,256 B（stat）**，规范化 LF 口径 **2,077,512 B**。
- 反向核查：PPT media 写入、人物路径围栏 / 结果解析 / 节点发现、UI_BUILD 与折叠几何均做过「改坏 → 精确变红 → 逐字恢复 md5 一致」。Rust exe 路径中和后复验了进程启动与 JSON 协议层结构化失败；当前沙箱禁止派生 exe 读取本地文件（未中和的原始 exe 同样报 `OS Error 5`），所以合成真跑不在本轮复验内，沿用先前实采，不冒称本轮重新跑通。
- **真机仍未自证**：DSH 页面刷新后 hover 显示 `UI 2026-11-18.2`、PPT 拖图真生成带图 PPT、人物替换双拖拽区真跑登记 + CPU 预演、本机 ComfyUI 是否已有身份保持节点。代码与离线回归已随 1.2.0 交付，上述真机项待用户侧验证。
