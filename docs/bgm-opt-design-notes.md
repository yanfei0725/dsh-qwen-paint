# BGM 优化设计说明（注释外置）

> 由 `lib/bgm-opt.js` 逐字外置，源码只留锚点。外置只为守 `lib/*.js` 2 MB 红线，语义与实现不变。

### bgm-opt-note-header（原 lib/bgm-opt.js 首块注释）

```
/** lib/bgm-opt.js —— BGM / 音乐链路的最小可跑性能优化（2026-11-17，未发布）
 *
 *  ★ 硬边界：本模块只做「插件层能离线跑、能实测」的优化，不假装生成音频。
 *    · 音乐模型（ACE-Step / YuE2）的真生成依赖外部 ComfyUI 节点与权重，
 *      仍走 music-models.js 的发现模式；本模块不下载、不提交、不谎称已生成。
 *    · hyperframes §7 的 candle / embedding / Rust worker 等因模型名与权重未定
 *      （§0.6 全线阻塞），这里只落地「缓存键规范 + ducking 参数 + 断点续推计划」
 *      这类不依赖模型即可实现、且能进生产链的部分，其余如实标 blocked。
 *    · 缓存是增强：任何读写失败都吞掉并降级到真实链路，绝不因缓存让功能失败。
 *    · 本模块纯逻辑 + 依赖注入（fs/path/crypto 由宿主注入），不直接 I/O。
 */
```

### bgm-opt-note-plan-key（原 musicPlanFingerprint JSDoc）

```
/**
 * 音乐生成「参数计划」缓存键（hyperframes §7 缓存键规范的可落地口径）：
 * model + prompt + neg_prompt + bpm + seed + duration + segment_id + loop_allowed + quality + 探测到的节点集合。
 * 节点集合入键：换了可用节点时计划可能不同，必须换 key（与 TTS 参考音频 mtime 入键同理）。
 */
```

### bgm-opt-note-stitch-key（原 stitchFingerprint JSDoc）

```
/**
 * ducking 缝合结果缓存键：BGM + 各旁白条目（文件身份+文本+时长）+ duck 参数 + target 语义。
 * 输入文件用「路径|大小|mtime」身份，任一改动即换 key（与 TTS 参考音频同口径）。
 * target 只取文件名不取绝对路径：同一出图目录内换名即换 key，目录整体搬迁仍可命中。
 */
```

### bgm-opt-note-assembly（原 buildBgmAssemblyPlan JSDoc）

```
/**
 * hyperframes §7 中「不依赖模型即可落地」的装配计划：
 * 缓存键字段、人声闪避 ducking、断点续推（按 segment_id 复用已完成段）、embedding 缓存计划。
 * 需要模型/权重/许可证的部分明确 blocked，不假装已经装上或已实测倍率。
 */
```

## 落地映射（供回归核对）

| 优化 | 生产消费点 | 缓存命中收益 |
|---|---|---|
| 音乐计划缓存 | `creative-extras.js::makeMusicTool.execute` | 省掉重复 `buildMusicPlan` 规划与节点探测 |
| ducking 缝合缓存 | `av-stitch.js::runAvStitch` | 跳过一次完整 ffmpeg 混流编码 |
| §7 装配计划 | `/api/qwen-paint/music/models` 的 `assembly` 字段 | 无耗时语义；把缓存键/ducking/续推/blocked 摆到台面 |


### bgm-opt-space-reference-web（原 lib/reference-web.js 首块注释）

```js
/**
 * lib/reference-web.js —— 联网参考图 provider + 硬同意门。
 *
 * ## 需求约束（用户明确要求）
 *   "可以开一点点网搜参考图什么的但是必须要用户同意"。
 *   所以联网能力 = **默认拒绝 + 每次请求显式同意 + 端点由用户配置（占位符）**。
 *   一次同意只管一次请求，绝非"开着就一直可联网"。
 *
 * ## 三条硬闸（缺一不可，顺序即防线）
 *   ① consent：调用方必须显式传 `consent: true`。没有任何全局开关、环境推断或
 *      "默认允许"。缺 consent 直接抛 ConsentRequired，连 URL 都不解析。
 *   ② endpoint：必须是用户配置的合法**外部 https** 地址。回环 / 内网 / 云元数据
 *      地址一律拒绝（防止把查询打到本机服务或 169.254.169.254 造成 SSRF）。
 *      占位符 `<API_ENDPOINT>` 未替换时也拒绝 —— 不臆造真实搜索 API 地址。
 *   ③ payload：只发**查询词**与条数上限。重新构造白名单对象，而不是从调用方
 *      大对象里删黑名册字段 —— 结构上不可能带上 prompt / seed / 本机路径 / 凭据。
 *
 * ## 只返回 URL，不下载字节
 *   本模块只产出候选参考图的 URL 清单。图片下载 / 上传给 ComfyUI 由调用方在
 *   用户**选定**之后走既有本地流程（uploadReference）。插件不自动抓取远程字节，
 *   不把远程内容直接喂进工作流。
 *
 * ## 可注入 fetch
 *   `fetchReferenceCandidates(query, opts, { fetchFn })` 接受注入的 fetch，便于
 *   离线回归验证"没同意绝不发请求 / 载荷只含查询词 / 响应只取 URL"，不真联网。
 *   本模块不 import net-guard 的全局 allowRemote 开关 —— 那是 ComfyUI 回环约束，
 *   与联网检索是两回事，不复用、不互相放行。
 */
```


### bgm-opt-space-workflow-manifest（原 lib/workflow-manifest.js 首块注释）

```js
/**
 * lib/workflow-manifest.js —— 工作流声明式清单（A1「工作流 JSON 化」第一步）。
 *
 * ## 为什么存在
 * 三条链（生图 / 视频 / TTS）的节点拓扑此前**硬编码在 JS 里**：换模型、节点改名、
 * 多加一条输出链都得改代码 —— 这正是「模型一升级就漂移」的根因。本模块把
 * **拓扑 + 输入槽绑定**搬到 `workflows/*.json`，插件退化为通用 runner。
 *
 * ## 分层：为什么 plan / 对齐不放进清单
 *   · 清单负责：节点拓扑、输入槽绑定、必需节点、条件补丁 —— 最容易漂移的部分。
 *   · JS 侧保留：参数**对齐**（帧数 4n+1、边长 16 倍数）、plan 元信息（秒数、i2v/t2v
 *     判定）、notes。这些是**派生计算**，塞进 JSON 会变成一门自定义小语言，
 *     可读性和可测性都会掉。**清单描述图，代码描述算。**
 *
 * ## 占位符
 *   整个输入值**恰好**写成 `$param.x` / `$asset.x` / `$const.x` 才替换，
 *   **不做内联插值**。理由：`prompt` 是用户输入，内联替换会把 prompt 里的 `$`
 *   也一起吃掉；整串匹配能彻底杜绝这类误伤。
 *   替换**保持原类型** —— `consts` 里的 `true` / `10.0` 不会变成字符串 `"true"`。
 *
 * ## 硬规矩
 *   · 纯函数、零外部依赖（除 `node:fs` 读自己包内的 json）。
 *   · 读路径用 `new URL('../workflows/', import.meta.url)`，与 `lib/asset-route.js` 同口径。
 *   · ⚠ 清单文件必须列进 `package.json` 的 `files` 白名单，否则 npm 包里没有它，
 *     装上就会崩。`scripts/test-workflow-manifest.mjs` 有专门断言锁这一条。
 */
```


### bgm-opt-space-vectorize（原 lib/vectorize.js 首块注释）

```js
/**
 * lib/vectorize.js —— 位图 → SVG 矢量化（两步法执行器，0.35.0）。
 *
 * ## 引擎
 *   · vtracer —— MIT（visioncortex/vtracer，SPDX 实抓），官方 Release 1.0.0-alpha.4：
 *       win32 `vtracer-x86_64-pc-windows-msvc.zip` = 965,231 B；
 *       linux musl `vtracer-x86_64-unknown-linux-musl.tar.gz` = 1,291,110 B。
 *     彩色矢量化（preset bw/poster/photo + clustering/mode 细调）。
 *     只走 GitHub Releases 官方源 —— 可执行文件不加第三方加速镜像（供应链红线）。
 *   · potrace —— GPL-2.0-or-later，黑白线稿专用；官方 windows 分发在 SourceForge
 *     且无固定权威直链 ⇒ 走「用户自备 exe」模式（cfg.potracePath 指向目录或 exe），
 *     不进下载目录、不代下载（供应链 + 许可双谨慎）。
 *
 * ## 诚实边界
 *   未安装 / 未配置 → degraded 如实降级，绝不谎称已矢量化；argv 数组不拼 shell；
 *   输入沿用出图目录围栏（与 manual-upscale 同口径），输出 SVG 必须落在出图目录内；
 *   potrace 只吃黑白位图（bmp/pbm/pgm/ppm）——彩色 PNG 会如实报错并引导改用 vtracer。
 */
```


### bgm-opt-space-style-library（原 lib/style-library.js 首块注释）

```js
/**
 * lib/style-library.js —— 素材库（**不是图片库**）。
 *
 * ## 用户的定义（原话）
 *   「素材库指的是用户需要的**设计风格**、**用户的指令**、以及用户可以**自行装载各种 skill**」
 *   ⇒ 三块，全部是"出图前的输入"，不是一堆图片文件：
 *     ① **设计风格**：命名风格包（提示词前缀/后缀 + 负面词 + 画幅建议）
 *     ② **用户指令**：一段自由文本，每次生成都会带上（"不要卡通""要 35mm 胶片感"）
 *     ③ **可装载 skill**：把本机已装的技能（`~/.dsh/skills/*\/SKILL.md`）挂进来，
 *        取其名字与摘要作为风格指引
 *
 * ## 落盘
 *   `<outputDir>/../千问1素材库/`
 *     · `library.json` —— 当前选中的风格、用户指令、勾选的 skill
 *     · `styles/*.json` —— 用户自定义风格包（一个文件一个风格，可手写、可拷贝分享）
 *   内置风格不走文件，写在代码里（BUILTIN_STYLES），删文件删不掉它们。
 *
 * ## 一条硬规矩
 *   拼进 prompt 的东西**有上限**（见 LIMITS），且**逐段可见**：
 *   `composePrompt()` 返回 `{ text, parts }`，界面上能看清"这次到底加了什么"。
 *   悄悄往用户提示词里塞一长串东西，比不提供这个功能更糟。
 */
```


### bgm-opt-space-vram-budget（原 lib/vram-budget.js 首块注释）

```js
/**
 * lib/vram-budget.js - 按子任务类型解析「显存预算」建议（独立模块、零 I/O）。
 *
 * 概念边界（务必先读）：
 *   · 本模块表示的是「每个子任务各自允许的显存上限档位」，是一个**预算建议**，
 *     不是 ComfyUI 的启动模式开关。它与 lib/vram-strategy.js 的 MODE_LADDER、
 *     lib/perf-presets.js 的 VRAM_CHOICES、lib/config.js 的 VRAM_MODES 是不同维度，
 *     本模块不 import、不修改、不覆盖它们，彼此不冲突。
 *   · 显存上限只能表述为「建议 / 生成的启动参数」。ComfyUI 没有精确的按任务显存
 *     配额开关，所以 launchArgs 只是依据所选档位生成的建议参数字符串，
 *     **绝不保证、绝不承诺实际显存占用**。用户提供的性能倍率数字一律视为 unverified，
 *     不当事实写进注释。
 *   · 无上限用 null 表示，绝不用 Infinity（Infinity 进 JSON 会变成 null / 报错）。
 *   · 0 GB 明确表示纯 CPU / 权重不放进显存。
 *   · 每个 kind 可独立设上限：resolveVramBudget 是纯函数，按传入的 kind 各自结算，
 *     模块不维护跨 kind 的单一全局上限；listVramBudgetKinds 列出各 kind 的独立默认建议。
 *
 * 代码风格：ESM、export function/const、字符串只用 ASCII 直引号。
 */
```
