# dsh-qwen-paint · (绘图)千问（优化版）

DSH 插件 / DeepSeek Harness：视频 / 生图 / TTS 全能 · 本机运行（QQ 交流群 454707710）。0.32.1 两轮审计加固：ASR 音频路径围栏（只认出图目录内文件）、按包名安装也能执行引导脚本、草图台四事件点按、错误响应消毒收口；视频链清单化 + 生图/TTS 契约对账（改图自动报差异）；生图/视频/混合三模式界面各不同；批量出图带幂等保护（重试不重出）；Qwen3-TTS 语音克隆与可接 ASR 自动字幕；本机实测秒数；会话级模型驻留、显存建议、参数来源表、预设绑定、加载器盘点等本机端点。文生视频 / 图生视频（Wan 2.2 / XT-5B）与图→音→视频混合、导入音频直接合进成片（音轨合成），文生图与 1–16 张参考图编辑、圈选重绘（羽化 / 边缘融合 / 外扩 / 反选 / 重绘强度可调）/ 元素移除 / 四向扩图 / 高清放大，Qwen3-TTS 语音合成（独立 generate_speech，参考音频可复刻音色），模型无关角色参考；草图台手绘参考；生成记录可检索（菜单最上面「历史」，SQLite 索引、软删除不动磁盘文件）。CPU 也能跑：自动识别 AVX2 / AVX512 / AVX512-BF16 指令集并给五档加速（含 --cpu 强制纯 CPU）、按物理核钉线程，任务结束可选自动卸载模型内存；安装入口是常驻的图形化引导面板。对外提供脱敏状态快照与端点目录供外部集成。提供可选、默认关闭的模型自动下载包：视频模型 --video-models、核显档位 --igpu-download、生图主模型 --tier，按服务器权威 size + sha256 双校验；音频权重不自动下载，缺件给明确清单。经本机 ComfyUI 调用，数据仅走 127.0.0.1 回环（联网参考图检索默认拒绝、须逐次同意），无需 API 密钥、零调用费用。Windows / Linux，NVIDIA / Intel Arc / AMD / 核显共享内存，含 8 GB 低内存档位。

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
| 文生视频 / 图生视频 | `generate_video` | 经本机 ComfyUI 调用 Wan 2.2 / XT-5B 系列视频模型，成品落盘并显示在会话里 |
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

> 使用 `desktop` profile 时须**先完全退出 DSH**。本包**已发布到 npm**（`dsh-qwen-paint`，当前 `0.32.1`），可直接 `dsh plugin add dsh-qwen-paint` 按包名安装；本地目录 / 本地包形式仅用于开发或试用未发布改动。完整步骤、profile 选择与排错见下文「安装」及 `INSTALL.md`。

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
> 现在每张结果图下面都有可见按钮。「首次使用向导」是**环境体检**，不是使用教学。

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

> **原作者**：@奇迹与你　｜　**优化版作者**：@yanfei0725　｜　**许可协议**：MIT　｜　**当前版本**：`0.32.1`　｜　仓库：<https://github.com/yanfei0725/dsh-qwen-paint>

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
