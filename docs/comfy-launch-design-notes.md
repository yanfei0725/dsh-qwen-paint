# lib/comfy-launch.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### comfy-launch-note-001（原 lib/comfy-launch.js L66-93）

```js
/**
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-09 **完全重写**：启动状态机（单一真相源）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要推倒重来
 *   之前是三轮补丁叠出来的，结果**两套状态并行**：
 *     · `launchState`（我在 2026-10-09 加的）
 *     · `comfyStartRequestedAt`（更早的"90 秒内算启动中"时间戳）
 *   两者都在决定 `starting`，互相覆盖，谁也说不清最终值。用户反复看到
 *   "一直卡在启动中"就是这么来的 —— 那是**状态机本身坏了**，不是某个判断写错。
 *
 * ## 现在的设计（就三条规则，没有例外）
 *   ① **只有一个事实来源**：`probe()` 探活的结果 + `phase`。
 *      `starting` 只由 `phase === 'starting'` 决定，**没有第二套时间戳**。
 *   ② **在线就是在线**：任何时刻探到通，phase 立刻变 `ready`，
 *      启动窗口、失败原因、计时全部清空 —— 不允许残留状态把界面卡住。
 *   ③ **窗口必然收口**：`starting` 有个硬性截止时间（`LAUNCH_TIMEOUT_MS`，现为 120 秒）。
 *      到点还没通 → 变 `failed`（带原因）。**绝不会无限停在 starting。**
 *
 * ## 状态流转（穷举，没有别的可能）
 *   idle ──start()──▶ starting ──探到通──▶ ready
 *                        │
 *                        ├─ 日志出现致命错 ──▶ failed
 *                        ├─ 进程消失 ────────▶ failed
 *                        └─ 超过 LAUNCH_TIMEOUT_MS ─▶ timeout
 *   ready ──探到不通──▶ idle（回到起点，下次可再启动）
 */
```

### comfy-launch-note-002（原 lib/comfy-launch.js L138-151）

```js
/**
 * ★★★ 2026-10-13（任务 #62②「SageAttention 崩溃自动回退」）：判断这次启动失败
 * **是否由 `--use-sage-attention` 引起**。
 *
 * ## 为什么需要它
 *   启动失败的原因很多（端口被占、依赖缺失、显存不够…），**不能**一概归咎于 SageAttention。
 *   只有日志**明确指向 sage-attention** 时才认 —— 否则会误关用户想要的功能。
 *
 * ## 判据（宁可漏判、不可误判）
 *   · `unrecognized arguments` + 提到 sage-attention —— argparse 不认这个参数（版本太老）
 *   · `No module named 'sageattention'` —— 硬依赖没装却强制开了（auto 档永远不会走到这）
 *   · 提到 sage_attn / sageattention + 编译 / sm_120 / build 失败 —— Blackwell 构建不匹配
 *   · 日志里 sage-attention 与 ImportError / ModuleNotFoundError / Traceback 同时出现
 */
```

### comfy-launch-note-003（原 lib/comfy-launch.js L161-166）

```js
/**
 * 归咎于 SageAttention 时，在本会话内自动关掉它，避免崩溃循环。
 * ⚠ **只改内存中的 cfg**（与界面开关的持久化策略一致：面板开关也只改内存、不写盘）。
 *   要永久关闭，需在 cordis.patch.yml 把 `nvidiaSageAttention` 设成 false。
 * @returns {boolean} 是否真的做了禁用（已关则返 false，避免重复日志）。
 */
```

### comfy-launch-note-004（原 lib/comfy-launch.js L223-251）

```js
/**
 * ★★★ 2026-10-12 抽出：**构造 POSIX（Linux / macOS）下的 ComfyUI 启动命令**。
 *
 * ## 为什么要抽成纯函数
 *   这段逻辑（尤其是**引号转义**）此前内联在 `ensureComfyUp` 里，
 *   于是它**永远没法被单测** —— 而它恰恰是最容易写坏的一处：
 *   启动命令要穿 `sh -c` → `sh -c` → `exec` 三层引号，写错一个字符就是
 *   "命令返回成功、但什么都没发生"（本项目已踩过一次同类坑）。
 *   本轮给它加了**环境变量注入**（macOS 的 MPS 两个变量），风险更高 ⇒ 必须能测。
 *   抽成纯函数后由 `_mac_env_test.mjs` **真起一个 sh 跑一遍**，
 *   断言变量确实传到了子进程里。
 *
 * ## 引号约定（照原样保留，别改）
 *   `q()` 用单引号包裹，内部单引号转义成 `'\''`。
 *   外层 `sh -c ${q(wrapped)}` 会把 `wrapped` 里的引号再转义一层 ——
 *   最终由**最内层**的 sh 解析出正确命令。这是本项目已验证的写法。
 *
 * ## 环境变量为什么用 `export K=V; exec ...`
 *   POSIX 下 `exec` 是**特殊内建**：`exec K=V cmd` 里的 `K=V` 会被当成 exec 的
 *   **第一个操作数（命令名）**，语义不明确。先 export 再 exec 是无歧义的写法。
 *
 * @param {object} o
 * @param {string} o.py        python 解释器路径
 * @param {string[]} o.args    传给 python 的参数（含 main.py）
 * @param {string} o.pidFile   写 pid 的文件（`$$` 即真正执行者的 pid，exec 不换 pid）
 * @param {string} o.logPath   启动日志路径（stderr/stdout 重定向目标）
 * @param {Array<[string,string]>} [o.launchEnv] 要注入的环境变量
 * @param {boolean} [o.useSetsid] 有 setsid 时用 `setsid --fork`，否则退回 `nohup ... &`
 */
```

### comfy-launch-note-005（原 lib/comfy-launch.js L256-270）

```js
  // ★★★ 2026-10-12 **修 bug（真事故，且 macOS 上必然踩到）**：
  //   原写法是 `sh -c 'echo $$ > ${q(pidFile)}; exec ${inner}'` —— 用**手写引号**
  //   去包内层脚本。问题在于：内层脚本里那些 `q()` 产生的单引号，会和手写的
  //   外层引号**互相配对**，被外层 shell"抹平"（引号只做分组、不进最终文本），
  //   于是内层 sh 收到的是**没有引号的裸命令**。
  //   实测（Git Bash 的 sh，本机复现）：
  //     `exec 'sh' '-c' 'echo hi'` → 内层变成 `exec sh -c echo hi`
  //     ⇒ `sh -c echo`（`hi` 成了 $0）⇒ 什么都没跑、只吐一个空行；
  //     含空格的路径 `> '/tmp/a b/x.pid'` → 内层变成 `> /tmp/a b/x.pid`
  //     ⇒ 重定向到 `/tmp/a`、多出一个参数 ⇒ **路径带空格就彻底失效**。
  //   ⇒ 修法：**不要手写外层引号**，整段内层脚本用 `q()` 正规转义一层。
  //     这样外层 shell 把脚本**原样**交给内层 sh，内层再按它自己的引号解析 —— 两层的
  //     引号各自独立、互不干扰。`q()` 的 `'\''` 转义会让这段文本安全穿过两层。
  //   ⚠ 这一条对 macOS 尤其重要：Mac 上 ComfyUI 常装在
  //     `/Users/<名字>/My ComfyUI` 这类**带空格**的路径下。
```

### comfy-launch-note-006（原 lib/comfy-launch.js L277-291）

```js
/**
 * ★★★ 2026-10-09 新增：由**父进程 pid** 找出真正在跑 ComfyUI 的子进程 pid。
 *
 * ## 为什么必须这么做（Windows / Linux 踩到了同一个坑）
 *   启动 ComfyUI 时中间隔了一层"壳"：
 *     · Windows：`Win32_Process.Create` 起的是 **cmd.exe**，python 是它的子进程；
 *     · Linux  ：`setsid` 起的是 **sh / setsid**，python 也是子进程。
 *   拿这层壳的 pid 去做"进程还在不在"的存活检查是**错的** ——
 *   壳的死活跟 ComfyUI 的死活不是一回事。
 *   后果：进程明明活着却被判"已退出"（或反之），
 *   界面表现正是用户反复看到的**"一直卡在启动中"**。
 *
 * ✓ 正解：按**父子关系**找出真正的 python。查不到就返回 0 ——
 *   调用方会退化成"只靠探活判断"，那也远比盯错一个进程靠谱。
 */
```

### comfy-launch-note-007（原 lib/comfy-launch.js L295-299）

```js
    // ★ 关键：**不能只查一层子进程**。
    //   实测链路是 `WMI → cmd.exe → (可能还有一层) → python`，
    //   只查直接子进程经常扑空（日志里就记着"定位子进程失败（父 8980）"）。
    //   所以改成**按命令行全表搜**：谁的命令行含 main.py 且 pid 命中，
    //   就取谁 —— 这比顺着父子关系爬更稳，也省掉"中间隔了几层"的不确定性。
```

### comfy-launch-note-008（原 lib/comfy-launch.js L335-349）

```js
/**
 * 解析本轮要挂的 CPU 加速档。
 *
 * 抽成独立函数的理由：`startComfyHidden` 已经 400+ 行，再内联一段探测 + 打印
 * 会让它彻底读不动。这里只做"配置 → 纯函数 → 计划"的转接，不含业务判断
 * （判断全在 `lib/cpu-profile.js`，那边可离线单测）。
 *
 * 配置项（都可选，默认全 off / 自动）：
 *   `cpuAccel`          'off' | 'safe' | 'balanced' | 'max' | 'force-cpu'
 *   `cpuThreads`        显式线程数（覆盖物理核心数）
 *   `cpuPhysicalCores`  显式物理核心数（Windows 拿不到准确值时用）
 *   `cpuFlags`          显式指令集（如 "avx2 avx512f avx512_bf16"）
 *   `cpuBf16`           true/false 强制开关 BF16（不填 = 跟硬件能力走）
 *   `cpuOomFallback`    true → 允许追加 `--lowvram`（`--cpu` 下会被自动拒绝）
 */
```

### comfy-launch-note-009（原 lib/comfy-launch.js L378-383）

```js
  // ★★ 2026-10-07 实测修正：**绝对不能用 pythonw.exe**！
  //    它没有控制台、sys.stdout 是 None，而 ComfyUI 启动时会大量 print ——
  //    一打印就抛异常、进程立刻退出。现象是出图报「240 秒内没就绪」，实际上
  //    python.exe 11 秒就能起（实测：pythonw 那次 8188 不在听、python 进程一个都没有）。
  //    正确组合 = python.exe + -WindowStyle Hidden：窗口藏住、输出流仍在。
  // ★ 2026-10-09（通用化）：路径不再写死 —— 先看配置，再自动探测。
```

### comfy-launch-note-010（原 lib/comfy-launch.js L421-425）

```js
    // ★★★ 2026-10-11：**A 卡专属优化（可选，默认关）** —— 与"厂商专属优化"同一套思路。
    //   两项都是**质量中性**的（换后端 / 改加载时机，都不改计算结果）：
    //     · `amdKernel`        —— 换本代的替代注意力内核（按代数挑 flag，见 AMD_KERNEL_FLAG）
    //     · `amdAsyncOffload`  —— `--async-offload`（N 卡默认开、A 卡默认关，这里补上）
    //   ⚠ 默认**一个都不加** —— 没实测过的卡上绝不擅自改默认路径。
```

### comfy-launch-note-011（原 lib/comfy-launch.js L437-442）

```js
  // ★★★ 2026-10-11 新增：**N 卡 SageAttention**（40 系 Ada / 50 系 Blackwell 的专属加速）。
  //   ⚠ `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，ComfyUI 直接起不来。
  //   ⇒ 三档（见 DEFAULTS.nvidiaSageAttention）：
  //        true  → 强制挂（用户确认装了）
  //        false → 永不挂
  //        auto / 未设 → **只在后台自检确认已装时**才挂；状态未知时**不加**（保守）
```

### comfy-launch-note-012（原 lib/comfy-launch.js L473-483）

```js
  // ★★★★ 2026-10-09：**显存驻留参数** —— 整条工作流 90 秒的真正解药。
  //   实测（6 笔出图逐笔拆解）：**非采样开销平均 36.99 s，占总耗时 40.7%**。
  //   时间不是花在"画画"（采样仅 8~11 s），而是把 13.58 GB 模型
  //   （TE 6019 + UNET 6920 + VAE 644）反复搬进显存；ComfyUI 全程只启动过 1 次，
  //   所以这不是冷启动问题，是模型被反复卸载又加载。
  //   对照：模型已在显存的那笔采样只要 15 s，需要全量加载的要 45~124 s（差 3~8 倍）。
  //   ⇒ 按显存总量选档：≥24 GB 用 `--highvram`；≥16 GB 用 `--highvram` + 极少保留；
  //     <16 GB 不加（强行 highvram 会 OOM，退化成更糟的换页）。
  //   ★ 保留量 1.5 GB → 0.5 GB：19.98 GB 里 13.58 GB 是模型，再扣 1.5 GB 后激活装不下，
  //     ComfyUI 会把模型切成 150+ 块换页，采样从 15 s 涨到 45 s。
  //   ⚠ 这是**权衡值**（取决于本机桌面占多少显存），且仅在未显式配 comfyArgs 时介入。
```

### comfy-launch-note-013（原 lib/comfy-launch.js L490-497）

```js
  // ★★★ 2026-11-13 新增：**CPU 加速档**（用户可选，默认 `off` → 参数与环境变量都为空）。
  //
  //   为什么单独一档而不是塞进 GPU_PROFILES：
  //     GPU 档案是"按显卡厂商选内核"，CPU 档是"按 CPU 指令集选运行方式"，
  //     两者维度和生命周期都不同（同一张卡可以今天用 GPU、明天强制 --cpu）。
  //   为什么合并要用 mergeLaunchArgs 而不是简单 concat：
  //     ComfyUI 的 attn / fp 参数是 argparse **互斥组**，同时挂两个不是"后者生效"
  //     而是**启动直接退出**；`--cpu` 与 `--highvram/--lowvram/--reserve-vram` 也冲突。
```

### comfy-launch-note-014（原 lib/comfy-launch.js L522-541）

```js
  // ★★★ 2026-10-12 新增：**给 ComfyUI 进程注入环境变量**（此前插件**一个都不注入**）。
  //
  // ## 为什么需要（这是 macOS 端"零优化"的第二块拼图）
  //   PyTorch 的 MPS 行为**没有命令行开关**，只能通过环境变量调
  //   （官方文档 "MPS Environment Variables"）。最要紧的一个是
  //   `PYTORCH_ENABLE_MPS_FALLBACK`：MPS 后端未实现的算子自动回退 CPU。
  //   没有它时，链路里碰到一个未实现的算子，**整次出图直接抛错**（不是慢一点，是失败）。
  //
  // ## 两个变量的来源与取舍
  //   · 档案级默认（`gpu.env`）—— 目前只有 Mac 三档带，值是 PYTORCH_ENABLE_MPS_FALLBACK=1；
  //   · 用户开关（见 DEFAULTS.appleMpsFallback / appleMpsUnlimitedMem）——
  //     前者能**关掉**档案默认，后者能**加上** `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
  //     （取消 MPS 分配器的硬上限，让大模型能在小内存 Mac 上跑；默认关，因为
  //      取消上限后系统级 OOM 会连系统一起拖垮 —— 那是"用稳定性换可用性"的取舍）。
  //
  // ⚠ MPS 那几项**只在 macOS** 注入：其它平台没有 MPS 后端，注入了只是噪音。
  //   ★ 2026-11-13 变更：这里不再是"非 Mac 恒为空" —— CPU 加速档的线程变量
  //     （OMP_NUM_THREADS / MKL_NUM_THREADS / OPENBLAS_NUM_THREADS）是**全平台**有效的：
  //     torch 只认变量名，跟操作系统无关。Windows 走 .cmd 里的 `set K=V` 分支
  //     （那条分支当初就是为这种情况留的，注释写着"为将来留的"，现在用上了）。
```

### comfy-launch-note-015（原 lib/comfy-launch.js L566-588）

```js
  // ★★★★ 2026-10-09 重大修正：**把 spawn 换回"平台原生派生进程"**。
  //
  // ## 为什么（实测结论，不是推测）
  //   我上一轮为了"修复 Linux 上没有 Start-Process"而改成 Node 的 `spawn`，
  //   结果**把 Windows 上也搞坏了** —— 本机实测三种方式启动同一个 ComfyUI：
  //     · PowerShell `Start-Process`            → ✅ 进程存活、8188 正常监听
  //     · `spawn(detached: true)` + unref()     → ❌ 进程随即消失
  //     · `spawn()`（普通、不 detached）         → ❌ 进程随即消失
  //   端口空着、无并发冲突，两种 spawn 都是"起来了又没了"。
  //   而 DSH 宿主（Electron）不是控制台进程，Node 在这种宿主里派生的子进程
  //   很容易随宿主的活动/作业对象被回收 —— 这正是用户遇到的"后端拉不起来"。
  //
  // ## 现在的做法：各平台用各自的"脱离式启动"
  //   · Windows：`Start-Process -WindowStyle Hidden` —— 它是**独立进程**，
  //     不属于 DSH 的作业对象，宿主重启也不会把它带走（这正是 2026-10-08 那条
  //     "DSH 重启后 ComfyUI 被连带杀死"的教训所指向的正解）。
  //   · Linux：`setsid ... &` —— 新会话（new session）里跑，
  //     同样脱离父进程的进程组，且 `setsid` 是 util-linux 标准组件，普遍都有。
  //
  // ## stderr 怎么办（这才是真正的难点）
  //   进程由 shell 派生，Node 拿不到它的 stderr 流了。所以改成
  //   **把 stderr 重定向到临时文件**，失败时回头读那个文件 —— 见下面的 readLaunchLog。
  //   不能像以前那样用 spawn 的 'pipe'：那个方案正是让进程活不下来的原因。
```

### comfy-launch-note-016（原 lib/comfy-launch.js L593-605）

```js
      // ★★★★ 2026-10-09 实测：**唯一可靠的拉起方式**（试了五种）。
      //   ① Start-Process（会话内）✅　② 再包一层 shell ❌ 进程被父 shell 收走
      //   ③ Node spawn(detached) ❌　④ WMI + 内联长命令 ❌ 引号被吃、没跑
      //   ⑤ **写 .cmd 文件 + WMI 创建该文件** ✅ 存活、8188 正常监听 ← 采用这个
      //   为什么：WMI 由服务端直接派生，不属于任何 shell / DSH 作业对象，父 shell 退出与
      //   DSH 重启都不会带走它（顺带解决"重启后 ComfyUI 被连带杀死"）；走 .cmd 文件则绕开
      //   **多层引号嵌套**（内联写法里路径带空格/反斜杠时，引号会被各层 shell 各吃一层
      //   → 表现为"返回成功但什么都没发生、日志也不生成"）。
      //   stderr 仍保留：.cmd 里用 `>` 重定向写日志，失败时由 readLaunchLog 读回来。
      //
      // ★ 另一个修正：**pid 不能拿 WMI 返回的那个** —— 那是 cmd.exe 的 pid，真正跑
      //   ComfyUI 的是它启动的 python（子进程）。用 cmd 的 pid 做存活检查会直接失真。
      //   ⇒ 靠**父子关系**反查真实 python pid（见 resolveChildPid）。
```

### comfy-launch-note-017（原 lib/comfy-launch.js L607-611）

```js
      // ★ 2026-10-12：环境变量（若有）以独立 `set` 行写在启动命令**之前**。
      //   后面的 `> "${launchLog}" 2>&1` 重定向只作用于最后一行（即真正的启动命令），
      //   这正是我们要的 —— set 行本身不需要重定向。
      //   ⚠ 目前 Windows 上 launchEnv 恒为空（见上面的 IS_MAC 闸），这条是**为将来留的**：
      //     真要在 Windows 上注入变量时不必再改这里。
```

### comfy-launch-note-018（原 lib/comfy-launch.js L616-636）

```js
      // ★★★★ 2026-10-09 新增（需求方要求「每次拉起后端时自动最小化窗口，别让人再手动点掉」）：
      //   `cmd.exe /c` 会在桌面弹一个控制台黑窗，且**不会自己消失**
      //   （python 一直在前台跑，cmd 得等着它）→ 每次启动后端都要人手动点掉。
      //
      // ## 做法：启动 python **之前**，用 powershell 把控制台窗口最小化
      //   时序是关键：必须在 `line`（启动 python）之前。放到后面的话，
      //   python 已占住前台，那条命令要等 ComfyUI 退出才执行 —— 等于没用。
      //
      // ## 为什么把 PowerShell 脚本放**独立文件**而不是内联
      //   内联 `.cmd` 里嵌 PowerShell 要穿四五层引号（cmd → powershell → C# 签名），
      //   实测极易被吃坏。改成独立 .ps1 后 **零引号嵌套**，只需 `-File` 一个参数。
      //
      // ## ⚠⚠ 写 .ps1 的硬性约束（四次实测才搞明白，务必保留）
      //   **.ps1 必须是纯 ASCII！** PowerShell 5.1 在没有 BOM 时按 ANSI 读 .ps1，
      //   中文注释会被解成乱码 → 解析错位 → 报**完全不相干的行**上
      //   `表达式或语句中包含意外的标记"}"`（ParserError: UnexpectedToken）。
      //   我为此白折腾了三轮。所以下面用 fsp.writeFile 写**英文注释**的 ps1。
      //
      // ## 为什么选 SW_MINIMIZE(6) 而不是 SW_HIDE(0)
      //   隐藏后用户在任务栏找不到入口，ComfyUI 万一卡住他想看日志都看不到；
      //   最小化只是收进任务栏 —— 不碍事，但需要时点一下就能看。
```

### comfy-launch-note-019（原 lib/comfy-launch.js L735-750）

```js
      // ══ Linux / macOS ══
      // ★★★ 2026-10-09 修正（**真 bug**）：原先写的是
      //     `setsid nohup <cmd> & echo $!` —— 那样拿到的 `$!` 是 **setsid 的 pid**，
      //     而 setsid 会立刻 exec 成目标进程……**大多数情况下没问题，但并不总是**：
      //     setsid 若是 fork 后再 exec（util-linux 在某些场景下会），
      //     真正跑 ComfyUI 的是**它的子进程**，用 setsid 的 pid 去做存活检查就会查错对象
      //     → 进程明明活着却被判"已退出" → 界面报"启动失败"。
      //
      //   ✓ 现在改用 `--fork` 明确的语义 + **用 pid 文件**回报真实 pid：
      //     `setsid --fork` 让 setsid 直接返回、目标进程独立成会话首进程；
      //     再加 `sh -c 'echo $$ > pidfile'` 把**真正执行者的 pid** 写出来。
      //     这样无论 setsid 怎么实现，我们盯的都是那个真正在跑的 shell（及其子进程）。
      //
      //   ⚠ `--fork` 是 util-linux 的写法；macOS 的 setsid 没有这个选项（其实 macOS
      //     根本没有 setsid 命令），所以下面做了**能力探测**，没有 setsid 时退回
      //     `nohup ... &`（macOS 上够用：nohup 已能免疫挂断信号）。
```

### comfy-launch-note-020（原 lib/comfy-launch.js L792-801）

```js
/**
 * 看着刚拉起的进程：它要是**提前死了**，就判失败并把日志里的原因摘出来。
 *
 * ★ 为什么不能用 `child.on('exit')`：改用 Start-Process / setsid 之后，
 *   进程由 shell 派生，Node 这边**没有它的句柄**，自然会收不到 exit 事件。
 *   所以退回到"定时看它还在不在" —— 简单、跨平台、且不依赖任何句柄。
 *
 * ⚠ 只在 state === 'starting' 期间工作，一旦就绪（或超时）立刻自行退出，
 *   不会变成常驻轮询、也不会和状态端点重复请求 ComfyUI 接口。
 */
```

### comfy-launch-note-021（原 lib/comfy-launch.js L808-813）

```js
  // ★★★ 2026-11-19 修复「启动半天都识别不出来」：原收摊上限硬编码 46，而 LAUNCH_TIMEOUT_MS
  //   早已提到 120s——46 秒后监视器**静默蒸发**，慢加载（本机 40+ 节点包 + ROCm 初始化，
  //   超过 46s 是家常便饭）再也没人探活翻 ready，只剩状态端点被轮询时才由规则②兜底。
  //   现在：快段（LAUNCH_TIMEOUT_MS 内）每秒探，之后降到每 5 秒**一直探**——只要还是
  //   starting 就不收摊；探到通立即 ready。超时/失败的收口仍归 ensureComfyUp（240s）与
  //   规则③，监视器绝不提前抢判（抢判会把 240s 窗口缩成 120s）。
```

### comfy-launch-note-022（原 lib/comfy-launch.js L825-829）

```js
    // ★★★ 2026-10-09 竞态防护：**先确认它真的还没就绪**，再谈失败。
    //   实测踩到过：ComfyUI 明明 9 秒就绪了，但日志里那句
    //   「No OpenGL_accelerate module loaded」被误判成致命错 → 状态被设成 failed，
    //   而进程其实活得好好的、端口也通了。用户看到的就是"报错了但明明能用"。
    //   所以每轮先探一次活；**只要在线就立刻收摊并置为 ok**，根本不给误判机会。
```

### comfy-launch-note-023（原 lib/comfy-launch.js L843-847）

```js
    // ★★★ 2026-10-09（需求方要求：「如果直接启动失败你就直接报错，不要干等超时」）：
    //   **先查日志**再查进程 —— 日志里一旦出现致命错误，立刻报错并收摊，
    //   根本不用等进程真的死掉、更不用干等到超时。
    //   典型：`unrecognized arguments`（参数被拒）、`Port 8188 is already in use`
    //   （端口被占）、`ModuleNotFoundError`（依赖缺失）—— 这些一出现就注定失败。
```

### comfy-launch-note-024（原 lib/comfy-launch.js L866-873）

```js
    // ★★★ 再看进程还在不在。
    //   ⚠⚠ 这里有个**必须守住的前提**：pid 无效时**绝不能**做存活判断。
    //   实测踩到：`resolveChildPid` 没定位到时 pid=0，而 `Get-Process -Id 0`
    //   必然失败 → `alive=false` → **立刻被判成"进程已退出"** →
    //   界面报"启动失败"，可 ComfyUI 其实正在正常加载。
    //   （这正是用户反复看到"卡在启动中/启动失败"的直接原因之一。）
    //   ✓ 拿不到可靠 pid 时**跳过存活判断**，把结论完全交给"探活 + 日志"——
    //     探活才是唯一权威的事实来源。
```

### comfy-launch-note-025（原 lib/comfy-launch.js L912-921）

```js
/**
 * ★ 2026-10-09 新增：从日志里找出「注定失败」的那一行，找到就立刻报错、不等超时。
 *
 * 为什么需要它：有些失败**压根不会让进程立刻退出**（例如端口被占时，
 * 有的版本是先打印 ERROR 再自己退），也可能进程挂着不动。
 * 与其干等到超时，不如一看到这些关键字就当场判定 ——
 * 需求方明确要求「如果直接启动失败你就直接报错，不要干等超时」（超时值见 LAUNCH_TIMEOUT_MS）。
 *
 * ⚠ 关键字只挑**确定致命**的，不能把普通 WARN 也算进来（否则会误报失败）。
 */
```

### comfy-launch-note-026（原 lib/comfy-launch.js L924-932）

```js
    // ⚠ 只放**真正致命**的。每条都是踩坑后收进来的：
    //   · `unrecognized arguments` —— argparse 拒绝参数，进程当场退
    //   · `is already in use`      —— 端口被占，起不来
    //   · `ModuleNotFoundError:`   —— **必须带冒号**
    //   · `ImportError:`           —— **必须带冒号**
    //   ⚠⚠ 绝不能写成泛化的 /No module named/ —— ComfyUI 正常启动时会打
    //      「No OpenGL_accelerate module loaded: No module named 'OpenGL_accelerate'」，
    //      那只是一句 INFO（可选加速模块没装），**完全不影响运行**。
    //      实测：这行误判把一次**成功**的启动报成了"启动失败"，是本文件最阴的坑。
```

### comfy-launch-note-027（原 lib/comfy-launch.js L964-970）

```js
/**
 * ★ 2026-11-19（用户问「为什么加载这么慢」）：解析启动日志里 ComfyUI 自带的
 * 「Import times for custom nodes」逐包耗时报告（本机实测格式，含 ANSI 色码：
 * `   1.6 seconds: K:\...\custom_nodes\Xxx` / `0.0 seconds (IMPORT FAILED): ...`）。
 * 返回最慢 topN + 失败导入数；没有该块（旧版 ComfyUI / 日志被轮转）返回 null。
 * 纯解析不 IO —— 读日志由调用方 readLaunchLog 完成，诊断绝不成为故障源。
 */
```

### comfy-launch-note-028（原 lib/comfy-launch.js L1007-1015）

```js
/**
 * ★ 2026-10-09：**不再需要 `startComfyHiddenWith`（spawn 版的重试入口）**。
 *
 * 它当初是为"参数被拒就降级重试"抽出来的，但用的是 `spawn` —— 而实测已证明
 * spawn 在本机（DSH/Electron 宿主里）起的 ComfyUI 会立刻消失。
 * 参数降级的能力**并没有丢**：现在由状态端点里的超时/退出判定 + 菜单里的
 * 「点此重试」按钮承担 —— 用户去掉注意力参数（`comfyArgs: []`）或点重试即可，
 * 比自动重试更可控，也不会在后台悄悄多起一个进程。
 */
```

### comfy-launch-note-029（原 lib/comfy-launch.js L1040-1043）

```js
  // ★★★ 2026-10-10 修 bug：`startComfyHidden` 在 spawn 失败时是 **`launchMarkFailed()` + `return`**
  //   （**不抛错**），原代码无法区分"已拉起"与"拉起即失败"，于是照样进等待循环、空等满 240 秒，
  //   到点还会把已经明确的 `failed` **覆盖成 `timeout`**（用户看到的失败原因被抹掉）。
  //   ⇒ 补一道：启动已判失败就当场抛，保留原因。
```
