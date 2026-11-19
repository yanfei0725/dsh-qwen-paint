# lib/config.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### config-note-001（原 lib/config.js L1-10）

```js
/**
 * dsh-qwen-paint —— 配置常量与纯工具函数（2026-10-12 从 lib/index.js 拆出）。
 *
 * ## 为什么拆
 *   DSH STORE 自动检查要求仓库内**单文件 ≤ 262144 字节**，而 lib/index.js 曾达
 *   364197 字节。本文件收拢"配置常量 / 纯工具函数"这一类**不依赖平台探测**的代码。
 *
 * ⚠ 这里**只放**不需要 GPU 探测、不需要 ComfyUI 目录搜索、不需要 ComfyUI 客户端
 *   的代码 —— 否则拆了等于没拆（index.js 还得把它 import 回去）。
 */
```

### config-note-002（原 lib/config.js L79-102）

```js
/**
 * ★★★ 2026-10-12 新增：**把用户配的 `outputDir` 变成一个真正可用的绝对路径**。
 *
 * ## 为什么要这一步（用户要求）
 *   原来 `outputDir` 直接拿去用，没有校验 —— 用户配错（盘符不存在、没写权限、
 *   路径指到一个文件）时，要到**出图那一刻才失败**，而且报的是"写文件失败"
 *   这种看不出原因的错。现在启动时就校验、就明确告知。
 *
 * ## 支持两种写法
 *   · **绝对路径**（`D:\我的图\千问`）→ 照用，用户完全自己说了算；
 *   · **相对路径**（`千问1生图` / `图片/千问`）→ 解析到"默认基目录"之下，
 *     即 `<桌面>/<相对路径>`。好处是**换机器不会失灵**（不写死盘符和用户名）。
 *
 * ## 校验（两步都要过）
 *   ① `mkdir -p` 能建成（或本来就存在）；
 *   ② 往里写一个临时文件再删掉 —— 这才是"真正有写权限"的判据
 *      （只判断"目录存在"是不够的：Windows 上见过目录在但 ACL 拒写的情况）。
 *
 * ## 失败怎么办
 *   **绝不中断插件**。退回默认目录，并把失败原因 `warn` 出来 ——
 *   用户改了路径就能恢复，不改成也能正常出图。
 *
 * @returns {{ dir: string, source: string, problem?: string }}
 */
```

### config-note-003（原 lib/config.js L139-145）

```js
/**
 * 允许的动画 id 白名单 —— **host 端只需要 id，渲染全在客户端**（见 client.js 的 FLOW_GRADS）。
 * meteor + 15 种流光（色值照搬一套参考配色来源里的「跑马灯」流光，一个字没改）。
 *
 * ⚠ 这里必须**白名单校验**：`?flowStyle=` 是外部输入，直接塞进样式名会变成注入面。
 * ⚠ 客户端那份表要和这里对齐 —— 自测里有一条专门比对两边 id 集合，改名时两边一起改。
 */
```

### config-note-004（原 lib/config.js L192-204）

```js
/** 写日志：宿主 logger 存在就写，不存在就吞掉（绝不让日志把功能搞崩）。 */
/**
 * G35 进度反馈分级：quiet / brief / detailed。
 *
 * ★ 映射到**日志级别下限**，不是按消息内容分类 —— 因为本项目的进度信息
 *   （开始出图 / 加载模型 / 完成）都用 `info`，而诊断细节用 `debug`。
 *   按内容猜"这句算不算进度"必然误判（第一版想过用关键词匹配，放弃了：
 *   中文日志里"加载模型"既可能是进度也可能是错误）。
 *
 *   quiet    → 只放 warn/error（代价：连里程碑也看不到，文案里已如实说明）
 *   brief    → info 及以上（默认，即改造前的行为）
 *   detailed → 全放，含 debug
 */
```

### config-note-005（原 lib/config.js L236-244）

```js
/**
 * ★★★ 2026-10-12（用户要求「预设工作流」）：预设 → 画幅比例。
 *
 * 只在用户**没显式传 size** 时生效；megapixels 永远尊重用户显式值（不覆盖）。
 *   · portrait / anime → 3:4（人像 / 动漫插画竖版）
 *   · wallpaper        → 16:9（壁纸横版）
 *   · 其它             → null（交给下层回落到 1:1）
 * 这是纯映射，不碰任何出图链路。
 */
```

### config-note-006（原 lib/config.js L307-333）

```js
/**
 * ★★★ 2026-10-09 **真事故修复**：把"任何形态的错误"变成真正的 `Error`。
 *
 * ## 事故现场
 *   用户点"画一张"，DSH 只回报一句：
 *     `画图失败：Error: [object Object]`
 *   信息量为零 —— 既不知道哪一步失败，也不知道为什么。
 *
 * ## 根因（已用 `scripts/_abort_reason_test.mjs` 实测复现）
 *   `AbortController.abort(reason)` 会把 `reason` **原样**变成 fetch 的 reject 值。
 *   实测四种 reason 的落地形态：
 *     · `new Error('x')`  → reject 值是同一个 Error      → `String(e)` = `Error: x`      ✅
 *     · 普通对象 `{...}`  → reject 值是**同一个普通对象** → `String(e)` = `[object Object]` ❌
 *     · 字符串 `'x'`      → reject 值是同一个字符串       → `String(e)` = `x`             ⚠
 *     · `undefined`       → reject 值是 DOMException      → `String(e)` = `AbortError: …` ✅
 *
 *   而 DSH 宿主传进来的 `exec.signal.reason` **是个普通对象**（不是 Error）。
 *   老代码 `controller.abort(signal.reason)` 把它当 reason 转发 →
 *   `[object Object]` 就一路飘到用户眼前，把真实原因（取消？超时？哪一步？）全糊掉了。
 *
 * ## 修法
 *   ① 新增 `toError()`：**任何**输入都能得到一个带可读 message 的 Error；
 *   ② 新增 `cancelReason()`：把外来 signal.reason **翻译成人话**，绝不原样转发；
 *   ③ 所有 `throw signal.reason` / `controller.abort(signal.reason)` / `?? error` 全部改用它。
 *
 *   这样即使宿主再换一种 reason 形态，用户看到的也永远是"人话"，不是 `[object Object]`。
 */
```

### config-note-007（原 lib/config.js L401-405）

```js
    // ★★★ 2026-10-16（DSH STORE 第二轮复核整改）：改用 `guardedFetch` ——
    //   它内部**同时**做两件事：① 出站前回环校验（非回环且未 opt-in 直接抛错）；
    //   ② 强制 `redirect: 'error'`。这样"校验"与"禁重定向"收口在一处，
    //   不会出现"某条链路只做了其中一半"（上一轮的教训）。
    //   开关读 net-guard 的全局值，由 apply() 按 cfg.allowRemoteComfy 设置。
```

### config-note-008（原 lib/config.js L411-416）

```js
      // ★★ 2026-10-08：**别让系统代理劫持 localhost**。
      //   本机环境里有 HTTP_PROXY/HTTPS_PROXY（实测 http://127.0.0.1:54536），
      //   Node 的 fetch 默认**会**把带显式端口的 127.0.0.1 也塞给代理 ——
      //   结果是连本机 ComfyUI 都报「连不上」，误导性极强。
      //   这里显式 `proxy: undefined`：对 http:// 目标等于直连（HTTPS 目标不受影响，
      //   因为 ComfyUI 走的是 http）。
```

### config-note-009（原 lib/config.js L425-446）

```js
/**
 * ★★ 把 ComfyUI 后端**隐身**启动：无控制台、不弹浏览器、不抢焦点。
 *
 * 用户先后两次要求：①「comfyUI 及其所有后端全部隐藏不要显示出来」；
 * ②（2026-10-07）「生图时依旧有弹窗出来，想办法隐藏掉」。
 * 那个弹窗就是**浏览器**，来源有两处，都已查实：
 *   · 启动 bat 的「已在运行」分支里有一句 `start "" http://127.0.0.1:8188`；
 *   · ComfyUI 自身的 `--auto-launch`（`--windows-standalone-build` 下可能被带上）。
 * 所以这里**绕过 bat**，直接调 python.exe + `-WindowStyle Hidden`（窗口藏住、输出流仍在），
 * 并显式加 `--disable-auto-launch`。两个参数名都用 `main.py --help` 核实过确实存在。
 */
/**
 * ★★ 2026-10-09（通用化）：**自动找出 ComfyUI 装在哪**。
 *
 * 通用包**绝不能写死安装路径** —— 每个人装的盘符、目录名都不同（有人是官方
 * Windows 便携包 `ComfyUI_windows_portable\python_embeded\python.exe`，有人是
 * 源码 + venv，有人装在 K 盘、E 盘……）。所以：
 *   ① 配置里显式给了 python + main.py → 直接用（尊重用户）
 *   ② 否则扫常见位置 + **各盘根目录下名字含 comfy 的目录**，找"python + main.py"齐活的组合
 * 都找不到返回 null，由调用方给出可照做的提示（而不是抛一个莫名其妙的 ENOENT）。
 */
/* ---------------------------------------------------------------- 平台抽象 ---- */
```

### config-note-010（原 lib/config.js L461-474）

```js
// ★ 2026-10-09 新增：**显存总量探测（最可靠的一条）**。
//
//   为什么必须单独探：启动参数里的「显存驻留档位」需要**显存总量**才能决定，
//   而启动流程用的是 skipOnline（ComfyUI 还没起来），拿不到 /system_stats。
//
//   三条来源的可靠性（本机实测）：
//     ① ComfyUI `/system_stats`               → ✅ 准（但未启动时拿不到）
//     ② Windows WMI AdapterRAM                → ❌ **不可信**：本机 RX 7900 XT
//        实际 19.98 GB，WMI 却报 4293918720 bytes = **4.0 GB**（32 位字段截断）
//     ③ PyTorch `get_device_properties(0).total_memory` → ✅ **最准**（实测 19.98 GB）
//
//   ⇒ 所以这条放在 WMI 之前用。它就是用 ComfyUI 自己的 Python 跑一句，
//     既不需要 ComfyUI 运行，也不受 WMI 那个 4 GB 截断的影响。
//   注意：这里**只取总显存这个静态值**，不会加载任何模型、不占显存。
```

### config-note-011（原 lib/config.js L481-492）

```js
/**
 * ★★★ 2026-10-11 新增：**macOS（Apple Silicon）** 的显存探测。
 *
 * ⚠ 上面那个写死了 `torch.cuda.get_device_properties(0)` —— macOS 上**没有 CUDA**，
 *   那一句直接抛错（被 catch 吞掉）⇒ macOS 上 vramGB 恒为 0。
 * 改用 PyTorch 官方的 MPS API `torch.mps.recommended_max_memory()`（返回字节数）。
 *
 * ⚠ 它给的是**建议的最大工作集**，在统一内存上**不等于物理总量**（PyTorch 会按总内存
 *   留出余量）。所以这个值只用于**展示**；Apple 上不会据此加任何驻留参数
 *   （见 VRAM_ARGS 里的显式跳过）。
 * 用 `getattr(..., lambda: 0)` 兜底：老版本 PyTorch 没有这个 API 时打 0，而不是抛错。
 */
```

### config-note-012（原 lib/config.js L518-529）

```js
/**
 * ★★★ 2026-10-11 新增：**macOS** 的显卡探测。
 *
 * ⚠ macOS **没有** nvidia-smi / rocm-smi / lspci —— 所以绝不能沿用 Linux 那条
 *   （沿用的结果就是"探测永远为空 → 一律 unknown"，这正是之前 macOS 上的实际表现）。
 *
 *   · `system_profiler SPDisplaysDataType` —— 最稳的一条，输出里就有我们要的那行
 *     `Chipset Model: Apple M3 Pro`；
 *   · 兜底 `sysctl -n machdep.cpu.brand_string` —— Apple Silicon 上直接给出
 *     `Apple M3 Pro`（`system_profiler` 偶发很慢/被沙箱限制时还有它）。
 *   两条都 `2>/dev/null`：拿不到是常态，不该产生噪音。
 */
```

### config-note-013（原 lib/config.js L561-566）

```js
  // ★★★ 2026-10-09 修复（通用性）：原来这里写死了 `C:\ D:\ E:\ F:\ G:\ X:\` 六个盘。
  //   装在第 7 个盘（H:、I:…）或盘符被改过的机器上，这一行**完全覆盖不到**，
  //   只能靠下面 `Get-PSDrive` 那段兜底 —— 而兜底只找**目录名含 comfy** 的。
  //   所以"盘符不在表里 + 目录名不含 comfy"（例如自定义命名 `Qwen`）就会漏掉。
  //   改成**动态枚举所有本地盘符**，一个都不预设；目录名字面量另列在最上面，
  //   保证 `X:\ComfyUI` 这种最常见的安装即使不做递归也能命中。
```

### config-note-014（原 lib/config.js L587-596）

```js
/**
 * ComfyUI 路径扫描 —— Linux / macOS 版。
 *
 * 与 Windows 版的差别（都是平台事实，不是随意写的）：
 *   · 解释器在 `venv/bin/python`（不是 `Scripts\python.exe`）；
 *   · 安装位置习惯不同：`~/ComfyUI`、`/opt/ComfyUI`、`~/comfy/...` 更常见；
 *   · 没有"盘符"概念，改为扫 `/mnt`、`/media`、`/opt`、`/srv` 与家目录下
 *     名字含 comfy 的目录（同样覆盖改名安装，如 `ComfyUI-rocm`）。
 * `-maxdepth 3` 是刻意的：再深就会变成全盘遍历，慢到不可接受。
 */
```

### config-note-015（原 lib/config.js L620-631）

```js
/**
 * ★★★ 2026-10-09：**跨平台**执行一段脚本，拿 stdout（超时保护）。
 *
 *   Windows        → PowerShell（并把控制台输出编码钉成 UTF-8，
 *                    否则 Windows PowerShell 5.1 按 ANSI 代码页输出、这里按 utf8 解析，
 *                    遇到中文（如「Microsoft 基本显示适配器」）会变成乱码）
 *   Linux / macOS  → `sh -c`（POSIX，**不假设有 bash** —— 精简发行版里可能只有 dash）
 *
 * ⚠ 所以叫 `runShell` 而不是 `runPowerShell`：它是**所有系统命令的唯一入口**
 *   （探测 GPU、找 comfy 进程、装加速包…），任何绕过它的 Windows 专有命令
 *   都会在 Linux 上直接崩掉。
 */
```

### config-note-016（原 lib/config.js L680-685）

```js
        // ★★ 2026-10-09 修正（**真 bug**）：workdir 必须是 **main.py 所在目录**，
        //   而不是扫描脚本回传的 `$root`。
        //   扫描脚本的 `$root` 是"候选根目录"（例如 `X:\ComfyUI-rocm`），
        //   而 main.py 其实在 `$root\ComfyUI\main.py` —— 两者差一层。
        //   拿 `$root` 当工作目录会让 ComfyUI 的相对路径解析全错。
        //   `path.dirname(mainPy)` 永远等于"main.py 所在目录"，这才是对的那个。
```

### config-note-017（原 lib/config.js L700-720）

```js
/**
 * ★★★ 2026-10-09（三厂商自适应）：把"按显卡厂商选优化方案"做成一张表。
 *
 * ## 两层优化，别混为一谈
 *   ① **通用优化**（与显卡无关，所有厂商都吃）：turbo8 八步链、官方前缀 KV 缓存、
 *      TE-Speed / Speedup 跳步缓存 —— 这些是"算法层"的省时，已在 buildWorkflow 里按
 *      能力探测自动接上。**任何卡都受益**。
 *   ② **专用优化**（跟厂商强绑定）：注意力后端启动参数 + 厂商专属的高性能 attention 内核。
 *      三家的硬件特性、可用内核、PyTorch 后端完全不同，**一刀切必然翻车**：
 *        · AMD/ROCm：`--use-quad-cross-attention` 实测 +15%；且 RDNA3 缺少生产级融合
 *          内核（PyTorch 在 gfx11 上退回"非融合 math"路径，会实打实展开 seqlen² 矩阵）。
 *        · NVIDIA/CUDA：PyTorch SDPA 本身就走 flash / mem-efficient 内核，再挂 quad
 *          没有收益；真正的大头是 **SageAttention**（INT8 量化注意力）这类第三方内核。
 *        · Intel/XPU：只能靠 PyTorch 的 xpu 后端 + IPEX，插件不该乱加内核参数。
 *   ③ 识别不出厂商 → **一个参数都不加**（最保守，先保证能起来）。
 *
 * ## 匹配规则为什么要打分
 * 一台机器可能同时报出核显 + 独显（例如 Intel 核显 + NVIDIA 独显、AMD 核显 + RTX）。
 * 若按数组顺序匹配，"AMD Radeon Graphics | NVIDIA RTX 4090"会先命中 AMD 核显而判错。
 * 所以按**得分最高**者胜：明确型号（RTX / Radeon RX / Arc）> 泛化的厂商名 > 核显。
 */
```

### config-note-018（原 lib/config.js L738-746）

```js
  /**
   * ★★★ RDNA4（RX 9000 系列）—— **唯一需要换内核的 AMD 分支**。
   *
   * 为什么必须区别对待：RDNA4 走的是 PyTorch 的 **CK SDPA（Composable Kernel）** flash
   * attention 路径，而它在 gfx1200/gfx1201 上**长期是坏的**（内核断言失败，
   * 见 pytorch#188113），后来的 PR #188114 / #193585 才修好并放开。
   * 所以 9000 系不能沿用 RDNA3 的 quad，而要显式走 `--use-pytorch-cross-attention`
   * 去用那个 CK 内核 —— **前提是 PyTorch 足够新**。
   */
```

### config-note-019（原 lib/config.js L756-764）

```js
  /**
   * ★ RDNA2（RX 6000 系列）—— 保守路径。
   *
   * 为什么单独一档：ROCm 的融合注意力路径（AOTriton）**只覆盖 RDNA3 / RDNA3.5 / RDNA4**，
   * RDNA2（gfx103x）不在其列，CK SDPA 同样不覆盖它。也就是说这代卡上**没有可用的
   * 厂商级融合 attention 内核**，挂 quad / 强行指定内核都只是碰运气。
   * 所以这里走 `--use-pytorch-cross-attention`，把内核选择权交回 PyTorch
   * （它会自行落到可用的 mem-efficient / math 路径），先保证**能跑、不崩**。
   */
```

### config-note-020（原 lib/config.js L774-792）

```js
  /**
   * ★★★ 2026-10-12 新增：**RDNA1（RX 5000 系列 / gfx101x）**。
   *
   * ## 之前错在哪
   *   RX 5000 系没有规则 ⇒ 落到下面的泛化 `amd` 档（quad + "未识别具体架构"）。
   *   两处都不对：
   *     ① 它其实**认得出代数** —— RX 5500/5600/5700 = Navi 10/14 = gfx1010/gfx1012；
   *     ② 更要紧的是它**和 RDNA2 一样没有厂商级融合注意力内核**：
   *        ROCm 的 AOTriton 只覆盖 RDNA3 / RDNA3.5 / RDNA4，CK SDPA 也不覆盖 gfx101x
   *        ⇒ 给它挂 quad（或强行指定内核）只是碰运气。
   *   ⇒ 与 RDNA2 同样走保守的 `--use-pytorch-cross-attention`，把内核选择交回 PyTorch。
   *
   * ## ⚠ 必须如实告知的一件事：RDNA1 不在 ROCm 官方支持矩阵内
   *   PyTorch 官方 ROCm 轮子**没有编译 gfx101x**。社区的两条路：
   *     (a) `HSA_OVERRIDE_GFX_VERSION` 让运行时把这张卡"当成"别的 gfx 代号；
   *     (b) 自己按 gfx1010 / gfx1012 重新编译 PyTorch。
   *   这属于**环境搭建**层面的事 —— 插件不改也不该改（改驱动/编译轮子风险远大于收益），
   *   只把这件事写在 note 里，让用户不至于"装完发现认不到卡"。
   */
```

### config-note-021（原 lib/config.js L823-830）

```js
  /**
   * ★ Intel Arc —— 只把**两张主力消费卡**单独拉出来（B580 / A770），其余 Arc 落到泛化分支。
   *
   * 两代卡的共同点：都靠 PyTorch 的 **XPU 后端 + IPEX**，插件不额外指定内核参数
   * （Intel 上没有任何值得手动挂的 attention 后端轴）。
   * 差别在**所需软件栈的代数**：A770 = Alchemist(Xe HPG)，B580 = Battlemage(Xe2)，
   * 后者更新，需要更新的 torch-xpu / IPEX。
   */
```

### config-note-022（原 lib/config.js L848-893）

```js
  /**
   * ★★★ 2026-10-11 新增；**2026-10-12 补上真正的优化**：**Apple Silicon（MPS，M1–M5）**。
   *
   * ## 原先为什么是空的（以及为什么那是错的）
   *   原注释写的是「ComfyUI 官方没给任何 Mac 专属启动参数 ⇒ args: []」。
   *   那句话本身没错，但**漏掉了一个关键事实**。去 ComfyUI 源码里核对：
   *
   *   `comfy/model_management.py` 里 `ENABLE_PYTORCH_ATTENTION` 的自动开启条件只有：
   *     · 显式 `--use-pytorch-cross-attention`
   *     · `is_nvidia()`（torch ≥ 2）
   *     · `is_intel_xpu() / is_ascend_npu() / is_mlu() / is_ixuca()`
   *     · AMD 且 aotriton 且 arch ∈ {gfx90a, gfx942, gfx950, gfx1100, gfx1101,
   *       gfx1150, gfx1151, gfx1170, gfx1171}（或 ROCm≥7 且 gfx1200/1201）
   *   —— **没有任何一条与 MPS 相关** ⇒ Mac 上它**恒为 False**
   *   ⇒ `comfy/ldm/modules/attention.py` 落到 `optimized_attention = attention_sub_quad`
   *     （日志原文 "Using sub quadratic optimization for attention, ..."）。
   *
   *   也就是说：**Mac 上默认根本没走 Metal 的融合 SDPA 内核**，走的是那个
   *   给 CPU / 低显存场景准备的次二次通用实现。
   *   ⇒ `--use-pytorch-cross-attention` 在 Mac 上**不是多余的显式声明**，
   *     而是**真正把它切到 PyTorch SDPA（MPS 上即 Metal 融合内核）**的开关。
   *     这正是"苹果端完全没有优化"的根因所在。
   *
   * ## 另一件 Mac 专属的事：`PYTORCH_ENABLE_MPS_FALLBACK`
   *   PyTorch 官方 MPS 环境变量（见官方 "MPS Environment Variables" 文档）。
   *   MPS 后端**未实现**的算子会自动回退到 CPU 执行，而不是直接抛错。
   *   默认 **开**：它只影响"本来就会失败"的路径，对已支持的算子**不改变任何数值结果**，
   *   属纯健壮性兜底（没有它时，链路里碰到一个未实现的算子整次出图就崩了）。
   *
   * ## ⚠ 几件**明确不加**的东西（都是查过源码/文档才敢不写的）
   *   · `--force-fp16` —— `should_use_fp16()` 对 MPS 直接 `return True`，
   *     Mac 上本来就是 fp16，加了等于没加。
   *   · `--force-non-blocking` —— `device_supports_non_blocking()` 对 MPS 恒 False
   *     （源码注释原文 "pytorch bug? mps doesn't support non blocking"）。
   *   · `--highvram` / `--lowvram` / `--novram` / `--reserve-vram` —— ComfyUI 里
   *     `if cpu_state == CPUState.MPS: vram_state = VRAMState.SHARED`，
   *     驻留档位在 MPS 上**根本不参与**；插件也已显式跳过（见 VRAM_ARGS 的 IS_MAC 分支）。
   *   · `--use-sage-attention` / `--use-quad-cross-attention` / `--use-ck-attention`
   *     —— 都是 CUDA / ROCm 专属内核，MPS 上不存在。
   *
   * ## ⚠ 诚实边界
   *   本机（Windows + ROCm）**没有 Mac 硬件** ⇒ 上面这条参数**没在真机实测过**。
   *   它的依据是 ComfyUI 与 PyTorch 的源码/官方文档（可复核），不是猜的；
   *   但"能跑多快"我给不出数字。想回到"一个参数都不加"：
   *   把 `comfyAttentionBackend` 设为 `default`。
   */
```

### config-note-023（原 lib/config.js L908-917）

```js
  /**
   * ★★★ 2026-10-12 新增：**Intel Mac + AMD 独显**（2016–2020 的 MacBook Pro / iMac 等）。
   *
   * ⚠ 关键事实：**macOS 上的 AMD 显卡不走 ROCm** —— Apple 只提供 Metal / MPS 这一条路
   *   （既没有 ROCm，也没有 HIP，更没有 CUDA）。
   *   所以这些机型**绝不能**套用 Windows/Linux 上 A 卡那套
   *   （`--use-ck-attention` / quad / `HSA_OVERRIDE_GFX_VERSION`）——照做只会起不来。
   * ⇒ 本档与 apple 档走**同一套**（SDPA + MPS 回退），差别只在**标签与说明**：
   *   用户拿的是 Intel 机器，面板上却显示"Apple Silicon"会让人以为探测错了。
   */
```

### config-note-024（原 lib/config.js L928-940）

```js
  /**
   * ★★★ 2026-10-12 新增：**macOS 但芯片型号认不出来**（只知道 MPS 可用）。
   *
   * 为什么需要这一档：ComfyUI 在 Mac 上通过 `/system_stats` 报的设备名**只是 "mps"**
   *   （源码 `get_torch_device_name()` 对非 CUDA/XPU 设备只返回 `device.type`）。
   *   若 `system_profiler` 也被挡住（沙箱 / 超时），就只剩这一个词可用 ——
   *   那时既判不出 Apple Silicon，也判不出 Intel Mac。
   * ⇒ 与其含糊地落进 `unknown`（面板会显示"不指定任何参数"，
   *   与实际挂上的 `--use-pytorch-cross-attention` **自相矛盾**），
   *   不如给一个诚实的第四档：**按 MPS 同款处理，并明说型号未识别**。
   *   （`apple` / `mac_amd` / `mac_mps` 三档的 args 与 env **刻意保持一致** ——
   *     macOS 上能走的路只有 Metal/MPS 一条，与具体是哪块芯片无关。）
   */
```

### config-note-025（原 lib/config.js L952-963）

```js
  /**
   * ★★★ 2026-10-12 新增：**Intel Mac（无 Apple 芯片、也没有可用独显）**。
   *
   * ⚠ 这是一个**真误判**的修复：原先 Intel Mac 会落到 `intel` 档，而那个档是给
   *   **Windows/Linux 上的 Intel Arc（XPU + IPEX）** 准备的 ——
   *   标签写着"Intel（XPU，未识别具体型号）"、挂 `--use-pytorch-cross-attention`、
   *   还带 `packs: ['ipex']`。可 **macOS 上根本没有 XPU 这条后端**
   *   （IPEX 的 os 白名单也只写了 win32/linux），用户照着做只会白折腾。
   * ⇒ 单独一档：**不指定任何厂商内核参数**，并把"Intel Mac 到底能怎么跑"讲清楚。
   *   带 AMD 独显的机型会走上面的 `mac_amd`（MPS）；只有 Intel 核显的机型
   *   实际上只能跑 CPU —— 出图会非常慢。这是硬件事实，不该粉饰。
   */
```

### config-note-026（原 lib/config.js L984-995）

```js
  /**
   * ★★★ 2026-11-12 新增：**Intel 核显 / 共享显存（UHD / Iris Xe / 集成显卡）**。
   *
   * ⚠ 这不是 Intel Arc（dGPU / XPU）—— Arc 走上面的 `intel` 档（IPEX + XPU）。
   *   核显**没有独立显存**，靠 BIOS / 驱动把一部分系统内存划成显存
   *   （Windows 在「显卡属性 → 共享 GPU 内存」里可调，新驱动最高可划到约 87% 系统内存）。
   *   所以这条档的核心策略是：
   *     · `--lowvram` —— 权重按需换入系统内存，不把本就紧张的内存一次性占满；
   *     · 不挂任何厂商加速包（核显上 SageAttention / quad / IPEX 大多无效或反而拖慢）；
   *     · 默认走最轻的 GGUF q4 主模型（见 assessLowEndReadiness / tierForVram）。
   *   8 GB 整机内存偏紧，实测门槛未校准（标 unverified）；建议 ≥16 GB 才谈得上"可接受速度"。
   */
```

### config-note-027（原 lib/config.js L1016-1029）

```js
/**
 * ★★★ 2026-10-11 新增：**A 卡"专属内核"候选表**（可选优化，默认关）。
 *
 * 与上面 `GPU_PROFILES` 的**默认** `args` 是两回事：
 *   · `GPU_PROFILES[x].args`  = **默认路径**（经过验证、不动）；
 *   · 本表                    = 用户**主动打开** `amdKernel` 时才替换成的**替代内核**。
 *
 * 为什么按代数给不同 flag：
 *   · 6000（RDNA2）没有 AOTriton / CK 融合内核覆盖（见 GPU_PROFILES.amd_rdna2），
 *     所以给它的是 `--use-quad-cross-attention`（子二次交叉注意力，换掉默认的 pytorch-cross）；
 *   · 7000 / 9000 给 `--use-ck-attention`（ComfyUI 自带的 "Comfy Kitchen attention"）。
 * ⚠ 全部是**换后端**、不改计算结果 —— 不是降精度，也就**不牺牲原生画质**。
 * ⚠ 本机只有 RDNA3，6000/9000 **没硬件实测** ⇒ 一律默认关，由用户自行尝试。
 */
```

### config-note-028（原 lib/config.js L1052-1058）

```js
  // ★★★ 2026-10-12 新增：**RDNA1（RX 5000 系列 / gfx101x）**。
  //   之前这一代**没有规则** ⇒ 落到泛化的 `amd`（score 60）⇒ 档案显示"未识别具体架构"
  //   且被套上 quad。它其实认得出（RX 5500/5600/5700 = Navi 10/14 = gfx1010/gfx1012），
  //   而且**和 RDNA2 一样没有厂商级融合注意力内核**（AOTriton 只覆盖 RDNA3/3.5/4）
  //   ⇒ 该走保守路径，见 GPU_PROFILES.amd_rdna1。
  //   ⚠ 分数**低于** RDNA2(93)：`5\d{3}` 的匹配面比 `6\d{3}` 更容易误伤
  //     （例如某些厂商名/型号里带 5 开头四位数字），宁可让它被更明确的规则压住。
```

### config-note-029（原 lib/config.js L1071-1076）

```js
  // ★★★ 2026-11-12 新增：**Intel 核显 / 共享显存**（UHD / Iris Xe / 集成显卡）。
  //   分数介于泛化 `intel`(50) 与 Intel Arc(88+) 之间：
  //     · 具体核显名（Iris / UHD / Xe Graphics）命中本条(70)，不会落进泛化 intel；
  //     · 若一台机器同时报出 "Intel Arc A770" 与 "Intel UHD Graphics"，
  //       打分系统会取最高分 ⇒ Arc(91/92) 胜出，dGPU 优先，符合预期。
  //   ⚠ 只认**具体核显关键字**，不要写成 /intel/i —— 否则会把 Arc 也吞进来。
```

### config-note-030（原 lib/config.js L1081-1087）

```js
/**
 * 按 VENDOR_RULES **打分**判定厂商/代数，返回最匹配的 profile id（识别不出 = 'unknown'）。
 *
 * ★ 2026-10-10 抽出：`detectGpuProfile` 与 `resolvePlan` 共用同一套判定 ——
 *   后者要靠它**门控厂商专用节点**（如 RDNA3 FlashAttention 只认 gfx1100），
 *   两处若各写一份，改一处忘另一处就会"探测说 A、接线按 B"。
 */
```

### config-note-031（原 lib/config.js L1089-1107）

```js
// ===== moved from index.js: vendorIdOf (was lines 635-653) =====
/**
 * ★★★ 2026-10-12 新增：**macOS 平台闸** —— 把 Mac 上的判定收进 Mac 自己的三档。
 *
 * ## 为什么必须在"平台"这一维上再收一次口
 *   `VENDOR_RULES` 是**按显卡名字**判的，而**同一个名字在不同平台上能用的计算栈完全不同**：
 *     · Windows/Linux 上的 "AMD Radeon RX 7900 XT" → ROCm/HIP → quad / CK 那套；
 *     · macOS 上的 AMD 显卡 → **只有 Metal / MPS**（Apple 不提供 ROCm）⇒ 上面那套全错；
 *     · Windows/Linux 上的 "Intel Arc" → XPU + IPEX；macOS 上**根本没有 XPU 后端**。
 *   不收口就会出现"Intel Mac 被建议装 IPEX"、"Mac 上的 A 卡被建议挂 --use-ck-attention"
 *   这类**照着做必然失败**的建议 —— 这正是之前 Mac 端"零适配"的另一种表现。
 *
 * ## 为什么写成**纯函数 + 可注入 platform**
 *   本机是 Windows，没有 Mac 硬件。把 platform 做成参数后，
 *   非 Mac 机器上也能直接回归 Mac 的三条分支（见 `_gpu_vendor_test.mjs`），
 *   不必等真机 —— 否则这段逻辑永远处于"没测过"的状态。
 *
 * ⚠ 认不出就不猜：文本为空或既不像 Apple / 也不像 AMD / Intel → `unknown`。
 */
```

### config-note-032（原 lib/config.js L1117-1124）

```js
  // ★★★ 2026-10-12：**只有 "mps" 一个词**的情形（真实且常见，不是臆想）。
  //   依据（ComfyUI 源码）：`get_torch_device_name()` 对**非 CUDA / XPU** 设备
  //   只返回 `device.type` ⇒ macOS 上 `/system_stats` 的 `devices[0].name` 就是 **"mps"**，
  //   **不含芯片型号**。这时既不能判成 Apple Silicon、也不能判成 Intel Mac。
  //   ⇒ 给一个明确的第四档，而不是含糊地落进 `unknown`（那会让面板显示
  //     "不指定任何参数"，与实际挂上的 --use-pytorch-cross-attention 自相矛盾）。
  //   ⚠ 顺序必须在 apple / amd / intel **之后**：Mac 的显卡报告里普遍带
  //     "Metal Support: Metal 3" 这类字样，提前匹配会把型号明确的机型也吞掉。
```

### config-note-033（原 lib/config.js L1129-1138）

```js
/**
 * Mac 四档的 id 集合 —— 面板据此决定要不要显示 Apple / macOS 专属优化项。
 *
 * ★ 为什么用「`IS_MAC` **或** 判定结果是 Mac 档」而不是只看 `IS_MAC`：
 *   · 只看 `IS_MAC`：真 Mac 上万一**显卡探测失败**（`system_profiler` 被沙箱拦、
 *     超时等），判定会落到 `unknown` ⇒ Mac 专属项**一项都不显示**，
 *     用户看到的就是"这台 Mac 上插件什么都没做" —— 正是本轮要修的那个观感；
 *   · 只看判定结果：在非 Mac 机器上无法回归这段 UI（本机就没有 Mac）。
 *   两者取或：真 Mac 上一定显示；同时**非 Mac 机器上也能用 Mac 显卡名跑回归**。
 */
```

### config-note-034（原 lib/config.js L1153-1165）

```js
/**
 * ★★★ 2026-10-12 新增：从探测文本里抠出 **Apple 芯片代次**（M1–M5，含 Pro/Max/Ultra）。
 *
 * 只用于**展示与说明** —— 插件**不做**按代次的差异化调参，理由如实说明：
 *   M1 到 M5 在插件这一层走的是**同一条路**（Metal / MPS + PyTorch SDPA），
 *   ComfyUI 与 PyTorch 里也**没有**按 M 代次分支的逻辑。
 *   真正影响该怎么调的是**统一内存容量**（8 GB 的 M1 与 128 GB 的 M4 Max 完全两回事），
 *   而那由 MPS 探测出来的工作集大小体现（见 describeOptimization 里的提示），
 *   不是芯片型号本身。⇒ 与其编一套"按代次调参"的假优化，不如把型号显示出来让用户确认探测正确。
 *
 * `m\d` 覆盖 M1–M9：**M5 及之后的新代次无需改代码即可识别**。
 * 认不出返回 ''（不猜）。
 */
```

### config-note-035（原 lib/config.js L1173-1181）

```js
/**
 * 识别用户机器的 GPU 厂商。
 *
 * 探测顺序（**先权威、后兜底**）：
 *   ① ComfyUI `/system_stats` 的 `devices[0].name` —— 这是**实际用来算图的那张卡**，最准；
 *   ② 没在跑就查 Windows WMI 的 `Win32_VideoController`（会列出所有显卡）。
 * 两条路都拿不到 → 返回 unknown，**不加任何参数**（绝不猜）。
 */
/** GPU 判定结果缓存（显卡不会中途换，没必要每次启动 ComfyUI 都重查）。 */
```

### config-note-036（原 lib/config.js L1186-1197）

```js
/**
 * ★★★ 2026-10-11 新增：**N 卡 SageAttention 的就绪状态**（`null` = 还不知道）。
 *
 * ## 为什么要有这个缓存
 *   `--use-sage-attention` 是**硬依赖**参数：sageattention 没装还挂上，
 *   ComfyUI 会**直接起不来**。所以"挂不挂"必须先确认"装没装"。
 *   而确认要起一次 Python 去 `import sageattention`（冷启动可能好几秒）——
 *   那是**每次启动 ComfyUI 都要付**的成本，绝不能放在启动关键路径上。
 *   ⇒ 由**后台**的加速环境自检（见 `autoSetupAcceleration`）顺手记下来，启动时直接读。
 *
 * 三态：`null` 未知（本次不加，保守）/ `true` 已装 / `false` 确认没装。
 */
```

### config-note-037（原 lib/config.js L1202-1209）

```js
/**
 * ★ 2026-10-11：NVIDIA **代系**识别 —— 只用于**提示**，不改默认启动路径。
 *
 * 为什么要分：50 系（Blackwell / sm_120）比 40 系（Ada）新，
 * 老版本的 Triton / SageAttention 构建**不认 sm_120**，硬挂会报错。
 * 所以 50 系上要把"需要支持 Blackwell 的构建"这件事**明确写出来**，
 * 而不是让用户撞一次错才知道。
 */
```

### config-note-038（原 lib/config.js L1261-1270）

```js
  // ★★★ 2026-10-12 新增：**macOS 上 `/system_stats` 给的名字不够用，要再探一次**。
  //
  //   实测依据（ComfyUI 源码 `server.py` + `model_management.py`）：
  //     `get_torch_device_name()` 对**非 CUDA / XPU** 设备只返回 `device.type`，
  //     所以 Mac 上报的是 **"mps"** 这一个词 —— 里面**没有芯片型号**。
  //   照它判会得到 `mac_mps`（型号未识别），能走对路径但**面板说不清是哪台机器**；
  //   而如果 system_profiler 还能用，就能拿到 "Apple M3 Pro" / "AMD Radeon Pro 5500M"。
  //   ⇒ 在 macOS 上：**只有当 ComfyUI 给的名字认不出具体机型时**，才补跑一次平台探测，
  //     把两份文本合并后再判。**只在 macOS 且名字无信息时探**，不增加其它平台的成本，
  //     也不会在"ComfyUI 已经给了权威答案"时多此一举。
```

### config-note-039（原 lib/config.js L1291-1296）

```js
  // ★ 2026-10-09：补上**显存总量** —— 启动参数里的「驻留档位」要靠它决定。
  //   来源优先级（按可靠性，本机实测结论）：
  //     ① ComfyUI /system_stats            → 运行时真实值（未启动时拿不到）
  //     ② PyTorch total_memory             → ✅ 最准，且不需要 ComfyUI 运行
  //     ③ Windows WMI AdapterRAM           → ⚠ 本机报 4.0 GB（实际 19.98 GB，32 位截断）
  //   都拿不到 → 留 0，调用方见到 0 会**选择不加驻留参数**，绝不瞎猜。
```

### config-note-040（原 lib/config.js L1313-1322）

```js
  // ★ PyTorch 兜底：用 ComfyUI 自己的 python 跑一句取总显存。
  //   它不加载模型、不占显存，只读设备属性 —— 实测 19.98 GB，比 WMI 可靠得多。
  //   ★★ 2026-10-09 修正（**真 bug，会让整个驻留方案静默失效**）：
  //     我原先写的是 `findComfyPython?.()` —— **这个函数根本不存在**。
  //     全文只有 `discoverComfyPaths`（真正的路径解析器，见 821 行）。
  //     因为用了可选链 `?.`，不存在的函数会**静默返回 undefined**，
  //     于是 ② 这一层**永远不会执行**，一路落到被守卫拦掉的 WMI 层，
  //     最终 vramGB 恒为 0 ⇒ VRAM_ARGS 永远返回空数组 ⇒ `--highvram` 永不生效。
  //     表现就是"改了半天，30~40 秒还是没到"。教训：可选链是好的，
  //     但它会把"函数名写错"这种硬错误伪装成"运行时没数据"，务必回查调用点。
```

### config-note-041（原 lib/config.js L1328-1338）

```js
        // ★★ 2026-10-09 第二次修正：PowerShell 里调用**带引号的 exe** 必须加 `&`
        //   调用运算符。`"<本地路径>" -c "..."` 在 PowerShell 里是**语法错误**
        //   （ParserError: UnexpectedToken），实测 stdout 为空、命令直接抛错。
        //   这不止影响本处 —— 凡是用 runShell 拼 `"路径" 参数` 的地方在 Windows 上都是坏的。
        //   加 `&` 后实测拿到 21458059264（19.98 GB）。
        // ★★★ 2026-10-11 修 bug（**Linux / macOS 上真失效**）：
        //   下面这行原来**没有平台闸** —— `&` 是 PowerShell 的**调用运算符**，
        //   但在 POSIX 的 `sh -c` 里它是**后台运算符** ⇒ 整条命令语法错、被 catch 吞掉
        //   ⇒ Linux 上 `vramGB` 恒为 0 ⇒ 驻留参数（--highvram 等）**永不生效**。
        //   ⚠ `probeAccelPack` 里踩过一模一样的坑并修好了，这一处漏了。
        //   ⇒ 现在按平台分叉：Windows 用 `& "exe"`，其余用 POSIX 单引号引用。
```

### config-note-042（原 lib/config.js L1346-1352）

```js
        // ★ 解析要**挑出纯数字行**，不能盲取最后一行：
        //   ROCm 启动时会往 stdout 吐 `[WARNING] offload-arch failed...` / `[stderr]`，
        //   实测输出形如：
        //       [WARNING] offload-arch failed with return code 1
        //       [stderr]
        //       21458059264
        //   取最后一行虽然这次恰好对，但换台机器/换版本就可能失灵。
```

### config-note-043（原 lib/config.js L1387-1390）

```js
  // ★★★ 2026-11-12（核显 / 8 GB 支持）：补上**整机内存总量**。
  //   核显没有独立显存，是拿系统内存当显存用 —— 所以"能不能跑"取决于整机内存，
  //   而不是 `vramGB`。`os.totalmem()` 是纯读值、不起子进程、不碰网络，成本可忽略。
  //   留 0 表示拿不到，调用方（assessLowEndReadiness）会如实按"未知"处理，不瞎猜。
```

### config-note-044（原 lib/config.js L1421-1425）

```js
  // ★ AMD 一支**刻意留空**（用户 2026-10-09 明确要求）：
  //   A 卡用户沿用既定优化方案 —— 通用链（turbo8 + 前缀缓存 + 跳步缓存）+ quad，
  //   本机已验证，**不额外引入第三方内核**。唯一例外是 RDNA4（9000 系），
  //   它在**启动参数**上换用 PyTorch 的 CK SDPA 内核（见 GPU_PROFILES.amd_rdna4），
  //   同样不需要下载任何东西。
```

### config-note-045（原 lib/config.js L1509-1515）

```js
    /**
     * ★★ 2026-10-09 实测修正：这个包**不在 PyPI 上**！
     *   裸跑 `pip install intel-extension-for-pytorch` 会报
     *   "No matching distribution found" —— 我一开始就是这么写的，是个真 bug。
     *   它挂在 Intel 自己的扩展索引下（已实测该索引有 2.8.10+xpu / 2.7.10+xpu 等版本），
     *   安装时必须带上 `--extra-index-url` —— 该索引地址配在 `ACCEL_SOURCES.ipex` 里。
     */
```

### config-note-046（原 lib/config.js L1522-1531）

```js
/**
 * ★★ 2026-10-09：加速包按**操作系统**过滤（方案表的 `os` 字段）。
 *
 * 为什么必须分两套：同一个能力在不同系统上**装法不同**。
 *   · **Triton** —— Windows 必须装第三方构建（`triton-windows`，官方长期没有 Windows 轮子），
 *     Linux 则装官方包。**装错了会顶掉正确的那个**，所以两个条目互为平台独占。
 *   · 将来若出现仅 Windows 可用的预编译内核（`.pyd`），也要靠这个字段把 Linux 挡在外面。
 *
 * 缺省（不写 `os`）视为全平台适用。
 */
```

### config-note-047（原 lib/config.js L1579-1587）

```js
/**
 * 执行**一套**下载方案：pip 走 `-m pip install`，custom_node 走 `git clone`。
 *
 * ★ `--timeout 15 --retries 1` 是刻意的：让"连不上"**快速失败**并切下一套源，
 *   而不是卡在 pip 默认的长重试里（默认能拖好几分钟，观感就是"卡死"）。
 *
 * ★ 引号转义**必须按平台选**：PowerShell 用 `''` 转义单引号，POSIX sh 用 `'\''`。
 *   早先这里不分平台统一用了 sh 风格，Windows 上参数一旦含单引号就会被解析错。
 */
```

### config-note-048（原 lib/config.js L1605-1613）

```js
// ===== moved from index.js: planWorkflow (was lines 2434-2521) =====
/**
 * ★★★ 2026-10-12（预设工作流）：把"显式 size / preset / 默认 1:1"的优先级算清楚。
 *   ① 用户显式传了 size（且在 ASPECTS 里）→ 用它；
 *   ② 否则看 preset（工具参数或运行时 cfg.preset）→ 映射成画幅；
 *   ③ 都没有 → 1:1。
 * ⚠ megapixels 不在这里处理：用户显式传的 megapixels 永远优先，没传才回落默认 1.0，
 *   预设**不覆盖** megapixels（见 preset 参数说明）。
 */
```

### config-note-049（原 lib/config.js L1649-1714）

```js
/**
 * 组装千问工作流。
 *
 * · 不给 `reference` → **文生图**（照 app.py build_workflow 的无参考图分支）
 * · 给了 `reference` → **图生图**（照 `scripts/_img2img.mjs`，那份在本机验证过）
 *
 * ★ 图生图有四个要点，一个都不能少：
 *   ① 加一个 `LoadImage` 节点读参考图
 *   ② `TextEncodeQwenImage21` **必须拿到 `vae`** —— 不给 vae 它就不会编码参考图
 *   ③ 参考图走 `images.image_1`（源码支持到 image_16）
 *   ④ KSampler 的 latent 取自该节点的**第 2 号输出**（positive=0 / negative=1 / latent=2），
 *      并且**删掉 `EmptyLatentImage`** —— 所以图生图的 `resolution` 要用 sqrt(W*H)，
 *      它**直接决定输出尺寸**（文生图那边则由 EmptyLatentImage 决定，所以用固定值即可）
 *
 * ★★★ 2026-10-08 重大改动：**Turbo8 八步 + TE-Speed 变成默认链路**。
 *   （需求原文：「你把这个改成默认设置吧。开到最大。就是 turbo8 加 TE 八步」）
 *
 *   模型链（1 → 11 → 12 → 7 → 13 → KSampler）：
 *
 *     UNETLoader ──► LoraLoaderModelOnly(turbo8, 1.0)     ← 八步蒸馏 LoRA
 *                ──► ModelSamplingFlux(0.6935, 0.5)       ← turbo8 官方要求的采样位移
 *                ──► QwenImage21Cache(auto, int8)         ← 官方前缀 KV 缓存（int8 折半，几乎无损）
 *                ──► TESpeedQwenImage21(...)              ← 跳步缓存
 *                ──► KSampler(steps=8, cfg=1.0, euler, simple)
 *
 *   本机实测（RX 7900 XT / ComfyUI 0.39.0，都是 1024 档、每遍换 seed 的稳态值）：
 *     基线 30 步 CFG2.5            ── 91.6 s   （原默认）
 *     turbo8 八步（无缓存）        ── 12.6 s   （−86%）
 *     turbo8 八步 + TE-Speed       ──  9.7 s   （**−89%**）  ← 现在的默认
 *
 *   ⚠ 关于「TE 在这一档里到底做了多少」——查证过，别被老数字误导：
 *     · TE 的**整层跳过**（日志里的 `eligible`）在 8 步下是 **0 次**：8 步的 t 序列是
 *       1.000/0.933/0.857/0.769/0.667/0.546/0.400/0.222，而节点内置窗口硬性要求
 *       t<=0.82，前 3 步直接出局；剩下 5 步的 change 又都 > 0.06 阈值。
 *     · 但它**仍然有效**：每次 call 都会复用一部分 KV/attention（算子级省时），
 *       实测稳态 12.6 s → 9.7 s，**−23%**。
 *     · 早先报过的「−43%」是**测量失真**（撞上了 ComfyUI 对相同 prompt 的直接缓存）。
 *       ★ 教训：任何"快了多少"的对比，**每遍都必须换 seed**。
 *
 *   为什么是 8 步而不是 16 步：turbo8 就是**为 8 步训练的**（发布页写明 8 步 / CFG 1 /
 *   euler + simple）；16 步只会更慢而不会更准。
 *
 *   ⚠ 三条硬约束，别随手改掉：
 *     ① `ModelSamplingFlux` 的 width/height 必须是**字面量**。图生图那一支没有
 *        `EmptyLatentImage`（latent 从 TextEncode 的第 2 号输出拿），一旦写成节点连线，
 *        图生图会**直接引用到不存在的节点**。所以这里固定传 `width`/`height` 数字。
 *     ② `ModelSamplingFlux` 的宽度默认 **1024**，而 ModelSamplingFlux 的 max_shift 是按
 *        像素面积算的 —— 尺寸一变位移量就跟着变（实测 992² 与 1024² 出图不同）。
 *        要换默认尺寸，请把 `DEFAULTS.turbo8RefWidth/Height` 一起改。
 *     ③ `TESpeedQwenImage21` 是**插件节点**，装不上时 ComfyUI 会以
 *        "node type not found" 当场拒收整个任务（不会静默降级）。
 *
 * @param reference ComfyUI 里的参考图文件名（已经上传过去的）；空 = 文生图
 */
/**
 * ★ prompt 精简（2026-10-09 新增，依据见 DEFAULTS 里 `promptTrimEnabled` 的注释）。
 *
 * 只做**不改变语义**的清理：
 *   ① 折叠所有空白（换行/tab/多空格）为单空格并去首尾
 *   ② 合并连续重复的分隔标点（",,,,," → ","）
 *   ③ 去掉末尾悬挂的分隔符
 * 再按 `cfg.maxPromptChars` 可选硬截断（默认 0 = 不截断）。
 *
 * ⚠ 刻意**不做**：删除形容词 / 同义词替换 / 按 token 数截断 —— 那些都会改图，
 *   而实测收益上限只有 4.8%（还得是 2000 字的超长 prompt），不值得。
 */
```

### config-note-050（原 lib/config.js L1728-1747）

```js
/**
 * ★★★★ 2026-10-09：决定这次出图用**哪一组**互斥的 diffusion wrapper。
 *
 * ## 为什么需要它
 *   TE-Speed / Speedup / BlockCache T8 三者争抢同一组 `DIFFUSION_MODEL` wrapper，
 *   同时挂会抛 `ValueError: ... requires exclusive diffusion-wrapper ownership`。
 *   所以必须**三选一**，而"选哪个"取决于尺寸（实测，见 DEFAULTS 里 wrapperPolicy 的注释）。
 *
 * ## 实测依据（都是这台机器上跑出来的，不是估的）
 *   ┌ 场景          ┌ 方案              ┌ 效果
 *   │ 小尺寸/常驻   │ TE-Speed+Speedup  │ +25.4%（11.581 → 8.639 s，纯采样）
 *   │ 大尺寸/换页   │ TE-Speed          │ **0%**（日志：predicted 0/8 steps）
 *   │ 大尺寸/换页   │ Speedup           │ 12.5%（1/8 cached）
 *   │ 大尺寸（120s）│ BlockCache T8     │ **+22.7%**（120.75 → 93.34 s，省 27.4 s）
 *
 *   ⇒ 小尺寸用 TE+Speedup，大尺寸用 BlockCache T8。
 *
 * @returns {{te:boolean, speedup:boolean, blockCache:boolean, reason:string, tokens:number}}
 *   三个布尔**最多只有一个为 true**（互斥是硬约束，由这里的写法保证）。
 */
```

### config-note-051（原 lib/config.js L1799-1810）

```js
// ===== moved from index.js: buildWorkflow (was lines 2594-2906) =====
/**
 * ★ 2026-11-17（M5 落盘目录组织）：SaveImage 前缀模板。
 *
 * cfg.filePrefixTemplate 支持 `{date}` / `{model}` 占位；ComfyUI 前缀里的 `/`
 * 会成为 output 下的子目录，于是「按日期/按模型分目录」不需要插件自己搬文件。
 * 未配置 = 返回 '' = 调用方沿用各自默认前缀，**行为逐字节不变**。
 *
 * 防注入三道闸：拒绝 `..`（目录穿越）、拒绝盘符/反斜杠/正斜杠开头（绝对路径）、
 * 白名单外字符统一压成 `_`（防怪字符进文件名）。非法模板回落默认，不抛错 ——
 * 前缀错了不该让出图失败，但会在响应里如实可见（文件落回平铺默认位置）。
 */
```

### config-note-052（原 lib/config.js L1849-1852）

```js
  // ★ 尺寸锁（2026-10-09）：默认把**文生图**尺寸钉死在优化档，调用方传进来的
  //   size / megapixels / width / height 全部回落到它（默认 = resolution = 1024²），
  //   —— 防止重蹈"1328² + 慢步数"的慢路径。图生图由参考图定尺寸，不锁。
  //   设 cfg.forceOptimizedSize = false 可恢复"听调用方的尺寸"（仍受 32 对齐约束）。
```

### config-note-053（原 lib/config.js L1883-1893）

```js
  // ★★★★ 2026-10-09 二次修正：**三个互斥 wrapper 按本次出图尺寸动态选**。
  //
  //   plan 里的 useTe / useSpeedup / useBlockCache 是**配置级**的静态决定，
  //   它不知道这次要画多大 —— 而实测恰恰证明"该用哪一套"正是**由尺寸决定**的：
  //     · 992×992（15376 tokens）：模型能常驻 → TE+Speedup 实测 +25.4%
  //     · 1408×1408（30976 tokens）：显存换页 → TE 实测 **0%**、Speedup 12.5%，
  //       而 BlockCache T8 在大尺寸实测 **+22.7%**（省 27.4 s）
  //   ⇒ 同一套配置硬扛所有尺寸，必然有一档是错的。所以在这里按尺寸二次决策。
  //
  //   ⚠ 三者的互斥关系**不变**（仍争抢同一组 DIFFUSION_MODEL wrapper），
  //     这里只是把"谁上"从静态配置改成按尺寸挑，绝不会两个同时上（那会 ValueError）。
```

### config-note-054（原 lib/config.js L1897-1923）

```js
  // ★★★ 2026-10-09：BlockCache T8 —— 取代 ToMe 的图生图加速节点
  //
  // ## 为什么它取代了 ToMe（ToMe 已移除，见 DEFAULTS 里的说明）
  //   ToMe 在千问 2.1 上接口不兼容，三条插入点全走不通；而本节点：
  //     · 官方描述明确写着 "preserving Core's reference/text KV cache"
  //       → **原生兼容前缀缓存**（正是 ToMe 卡住的那个点）
  //     · "For editing, start with threshold 0.03" → 图生图推荐起点就是保守值
  //   ✅ 已实测确认：挂上后服务器日志出现 `T8: full=6 cache=2` —— **真的命中**，
  //      不是"看起来在跑其实没生效"。
  //
  // ## ⚠ 与 Speedup 互斥（这点比数字更重要）
  //   BlockCache 要求独占 DIFFUSION_MODEL wrapper（runtime.py:51），而 Speedup
  //   也注册同一组 wrapper → 同时挂会抛 ValueError 整单失败。
  //   处理：**BlockCache 优先，自动让位 Speedup**（见 resolvePlan 里的长注释）。
  //
  // ## 实测耗时（图生图，2 个不同 seed 取平均）
  //   注意：下面的"基线"是**只有 BlockCache / 无 BlockCache** 的对照，
  //   两者都不含 Speedup（因为 Speedup 与 BlockCache 互斥，无法同链对照）。
  //     无 BlockCache      120.75 s
  //     +BlockCache T8      93.34 s   →  快 22.7%（省 27.4 s）
  //   该数字来自独立对照跑（见 memory 2026-10-09），不是端到端全链耗时。
  //   参数即官方默认：threshold=0.03 / start=0.1 / end=0.9 / max_hits=2
  //
  // ## 接在哪
  //   放在模型链**最前面**（紧跟 UNETLoader）—— 它要缓存的是"首块目标残差"，
  //   越靠前拿到的越接近原始 UNET 输出；官方示图也是这个位置。
  // ★ 由 pickWrapperSet 决定（按尺寸），不再只看静态配置
```

### config-note-055（原 lib/config.js L1940-1945）

```js
  // ★★★ 2026-10-12 新增（用户反馈）：**Spectrum 跳步**（跳过部分 Qwen transformer 前向）。
  //   位置：**模型链最末端**（FA 之后、KSampler 之前）—— 节点 README 的接线图就是
  //   "Load Qwen model → (可选 LoRA/改动) → Spectrum Qwen Model Patcher → KSampler"，
  //   放最后能保证 KSampler 最终拿到的那个 model 一定带着它的 patch。
  //   ⚠ 它与 FA **不冲突**：FA 改的是 `model_options` 里的 attention override，
  //     Spectrum 换的是 transformer 的 forward —— 两套机制，互不覆盖。
```

### config-note-056（原 lib/config.js L2021-2026）

```js
    // ---- 2026-10-09 实测新增：QwenImage21Speedup（与 TE-Speed 实测可叠）----
    //   它接在模型链最末端（TE 之后、KSampler 之前），挂在 DIFFUSION_MODEL /
    //   OUTER_SAMPLE wrapper 上做整步残差缓存。
    //   实测：TE 10.741s → TE+Speedup 9.709s；再叠 quad → 8.278s。
    //   ⚠ 它是插件节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withSpeedup 开关控制，且下面要把未启用的节点删掉。
```

### config-note-057（原 lib/config.js L2032-2039）

```js
    // ---- 2026-10-12 新增（用户反馈）：Spectrum 跳步（跳过冗余 Qwen 前向）----
    //   参数默认取它 README 的 "Recommended starting settings → Conservative"，
    //   但**全部可由配置覆盖** —— 因为本插件的 turbo8 链只有 **8 步**，
    //   而它的默认 `warmup_steps=5 + tail_actual_steps=2` 会吃掉 7 步，
    //   只剩 1 步可跳 ⇒ 想看出收益就得把 warmup/tail 调小（画质风险随之上升）。
    //   ⇒ 这也是它**默认关**的原因之一（详见 DEFAULTS.spectrumEnabled）。
    //   ⚠ 它是第三方节点：没装时 ComfyUI 会 "node type not found" 拒收整单，
    //     所以必须用 withSpectrum 开关控制（由 resolvePlan 按探测结果决定）。
```

### config-note-058（原 lib/config.js L2059-2065）

```js
    // ---- 2026-10-12 新增（用户要求）：SADA 跳步采样（ICML 2025 论文实现）----
    //   与 Spectrum 思路同源（跳过部分 transformer 前向），但走**新采样分布**。
    //   ⚠ 输入映射**是**基于论文 + comfyui-sada-icml 仓库 README 的**先验**；
    //     本机未装该节点（`custom_nodes/` 无 sada 痕迹）⇒ 未做真机 A/B。
    //     真装上后若输入名不一致，由 `sadaNodeClass` / `sadaMaxSteps` / `sadaThreshold`
    //     这几个 DEFAULT 微调（不用动插件代码）。
    //   ⚠ 节点必须存在 + withSada=true 才接进去；否则整段被统一 delete（见下面循环）。
```

### config-note-059（原 lib/config.js L2105-2109）

```js
    // 图生图：参考图进来，latent 由编码节点给，不要空 latent。
    // ★ 2026-11-09（issue #1）：第 1 张仍用节点 4（单图工作流逐字不变），
    //   其余各建一个 LoadImage（30 起 —— 现有 20/21/22 是 ControlNet），
    //   按顺序接 images.image_N。节点侧 execute() 就是按 image_N 的数字序
    //   把参考图拼进序列的（comfy_extras/nodes_qwen.py 里 sorted(..., key=image_N)）。
```

### config-note-060（原 lib/config.js L2123-2132）

```js
  // ---- 采样器 ------------------------------------------------------------------
  // ★ 步数默认 **8**：turbo8 是八步蒸馏模型，这就是它的工作点。
  //   层层回落（先到先用）：
  //     ① 用户显式传了 steps（1..60）→ 用它的         ← 只在 forceTurbo8Steps=false 时
  //     ② cfg.turbo8Steps 是正数     → 用配的那个数    ← 同上
  //     ③ 其余一律 → TURBO8_STEPS = 8                  ← 默认走这条
  //   给别的步数会掉出 LoRA 的训练区间、出图变差，所以默认必须钉死在 8。
  //   ★ 2026-10-09（通用化）：**没有 turbo8 时绝不能再钉 8 步** ——
  //     8 步是 turbo8 蒸馏 LoRA 的工作点，缺了 LoRA 还跑 8 步只会得到一张糊图。
  //     此时改用 plan.steps（默认 25），并允许调用方显式传 steps 覆盖。
```

### config-note-061（原 lib/config.js L2170-2189）

```js
  // ★★★ 2026-10-14（C4「专业卡版」）：**通用 ControlNet**（Pose / Canny / Depth / Union）。
  //
  // ## 接线
  //   `20 LoadImage`（控制图） + `21 ControlNetLoader`（权重） + `22 ControlNetApplyAdvanced`
  //     22.positive ← 5.0 ／ 22.negative ← 5.1 ／ 22.control_net ← 21.0 ／ 22.image ← 20.0
  //     KSampler.positive ← 22.0 ／ KSampler.negative ← 22.1
  //   ⚠ 这是 ComfyUI **核心节点**的标准接法；权重来自 `models/controlnet`。
  //
  // ## 三个条件缺一不可（否则**不接**，并如实说明原因）
  //   ① 探测到 `ControlNetLoader` 与 `ControlNetApplyAdvanced` 两个节点；
  //   ② 面板里**选中了** ControlNet 权重（空 = 没选）；
  //   ③ 本次**真的传了控制图**。
  //   ⇒ 只选权重、不给控制图时**不会**接进工作流（避免"面板开了、实际没生效"的假象）。
  //
  // ## ⚠ 与"局部重绘"完全独立
  //   局部重绘走的是另一套（`ControlNetInpaintingAliMamaApply` + 独立工具），两者互不影响。
  //
  // ## ⚠ 未实测
  //   本机（AMD RX 7900 XT 20 GB）**没有验证过**这条链的真机出图效果 ——
  //   节点与接线是 ComfyUI 标准做法，但**真机请你自己验**。
```

### config-note-062（原 lib/config.js L2221-2231）

```js
  // ★★★ 2026-11-17（H1）多 ControlNet 链式叠加。
  // ## 为什么不清空 20/21/22 重写
  //   单路是已经真机验证、指纹夹具锁住的路径 —— 改动它等于把稳定链置于风险中。
  //   多路只在给了 controlStack 时**追加**：第 2 路 30/31/32、第 3 路 33/34/35 …
  //   每路 Apply 的 positive/negative 接上一路 Apply 的输出，KSampler 最后接链尾。
  //   ComfyUI 的 ControlNetApplyAdvanced 就是靠这条 condition 链多路叠加的
  //   （diffusers 里 controlnet=[...] 列表的等价接法）。
  // ## 三个约束
  //   · 每路三件套齐全（控制图 + 权重 + 节点能力）才接，缺任一条如实记 reason，不静默；
  //   · 最多 4 路（显存与耗时都随路数线性涨，超过直接拒绝，不悄悄截断）；
  //   · inputs 键与单路逐字一致（契约扫描器按源码字面量提取键，多一个键就红）。
```

### config-note-063（原 lib/config.js L2314-2324）

```js
/**
 * 把参考图上传给 ComfyUI，返回它在 ComfyUI 那边的文件名。
 *
 * ★ 为什么必须走 `/upload/image` 而不是"自己复制进 input 目录"：
 *   ComfyUI 的 input 目录**未必是配置里以为的那个**（启动时可以用 `--input-directory` 改），
 *   直接复制过去很可能放错地方；`/upload/image` 是**问 ComfyUI 本人要位置**，永远对。
 *   （同样的坑今天刚在 output 目录上踩过一次。）
 *
 * ⚠ 不能复用 `fetchWithTimeout` —— 它写死了 `Content-Type: application/json`，
 *   而这里要发 multipart。所以自己发一次。
 */
```

### config-note-064（原 lib/config.js L2377-2397）

```js
/**
 * ★★★ 2026-10-12（用户要求「分块放大 / 局部重绘」）：探测"辅助引擎"在不在。
 *
 * ## 为什么单独探测
 *   主模型（千问 2.1）走的是 `resolvePlan` 那套通用能力探测；但放大（VOSR2 / RealESRGAN）
 *   和局部重绘所需的那几个节点是**独立于主链路**的，
 *   主探测不覆盖它们。本函数专门问 ComfyUI 本人：这些节点装没装、对应权重文件在不在。
 *
 * ★ 2026-10-19：局部重绘改为**零下载潜空间重绘**，inpaint 一项不再看 ControlNet 权重
 *   （旧实现要 InstantX Inpainting ControlNet，那份权重是给 1.0 的、与 2.1 底模不兼容）。
 *
 * ## 返回结构（全部基于 `/object_info` 真实返回，不猜文件名）
 *   {
 *     vosr2:      { node: bool, models: string[] }   // VOSR2ModelLoader 节点 + models/vosr2 下的包名
 *     realesrgan: { node: bool, models: string[] }   // UpscaleModelLoader 节点 + models/upscale_models 下 .pth
 *     inpaint:    { encodeNode, noiseMaskNode, maskLoadNode, growNode, featherNode } // 前三个必需、后两个可选
 *   }
 *
 * ⚠ 全失败 = 返回全 false 的结构（与 probeCapabilities 同一思路：不抛错、不拖垮调用方）。
 *   结果按地址缓存 60 秒（节点/权重不会频繁变动，但状态端点每 5 秒轮询，避免每次 4 个请求）。
 */
```

### config-note-065（原 lib/config.js L2459-2462）

```js
    // ★ 0.32.1 审计翻案：插件走 ctx.tools.register，那条路径只校验 output.schema；
    //   强校验 render 的是另一条 registerNativeCapability。这里保留 render 作展示层增强，
    //   不再把它写成「注册硬校验」（旧注释会误导后来人）。
    //   宽松 schema 的理由同上：返回的 `models` 是"类别 → 文件名数组"的动态结构。
```

### config-note-066（原 lib/config.js L2488-2505）

```js
/**
 * ★★★ 2026-10-09 新增工具：检查 / 配置本机加速环境。
 *
 * 回答"我这台机器用的是哪套优化、还差什么"。
 * · `action=status`（默认）：**纯只读**，不发任何下载。
 * · `action=install`：安装白名单内的加速包，且受 `accelAutoInstall` 约束。
 *
 * ⚠ 为什么安装要单独一个显式动作、而不是"出图时顺手装上"：
 *   下载并执行第三方代码是**用户环境的实质性改动**，不该藏在绘图流程背后发生。
 *   `action=install` 就是**手动**触发这个动作的入口。
 *
 * ★★★ 2026-10-16 修正（审核在 Issue #1390 指出"注释与实现不一致"）：
 *   **实际默认是 `accelAutoInstall: true`** —— 也就是插件加载后**会自动**检测并安装
 *   白名单内的加速包（见 `lib/index.js` 里 `if (cfg.accelAutoInstall === true)`）。
 *   本段原先写的是"默认 `accelAutoInstall: false`，让'装不装'由人决定"，
 *   **与实现相反**，属实的披露不一致，已改正。
 *   若你希望回到"只报告、不自动下载"的行为，请**显式**设置 `accelAutoInstall: false`。
 */
```

### config-note-067（原 lib/config.js L2521-2529）

```js
  /**
   * GGUF 主模型的"从已装文件里挑最优"排序 —— **仅此而已**。
   *
   * ⚠⚠ 2026-10-12：**插件不再自动下载/推荐任何 GGUF**（原"轻量档"已撤，
   *   原因见 MODEL_TIERS 处的说明：unsloth 那个仓库是 sd.cpp 格式，不再自动下载）。
   *   这里保留只是为了：用户**自己**装了 ComfyUI 能用的 GGUF 之后，
   *   插件探测到就按文件名质量挑一个，别去用排序更差的。
   *   Q4_K_M > Q4_0 > Q5_K_M > Q6_K > Q8_0 > 其余 Qwen GGUF。
   */
```

### config-note-068（原 lib/config.js L2592-2609）

```js
/**
 * ★★★ 2026-10-11 新增：**模型档位** —— 让 8GB 这类小显存卡也能跑起来。
 *
 * ## 为什么需要
 * 默认主模型是 `qwen_image_2.1_int8_convrot.safetensors`（int8，20B 级）。
 * 在 ≥16GB 的卡上是首选；但在 **8GB（如 RTX 5060）** 上装不进显存，只能靠
 * ComfyUI 反复换页 —— 慢到不可用。社区通行做法是换 **GGUF 量化档**，
 * 用 `ComfyUI-GGUF`（city96）的 `UnetLoaderGGUF` 节点加载。
 *
 * ## 两个档位
 *   · `full`（默认）—— 原生 `UNETLoader` + int8 safetensors。**与旧版行为完全一致**。
 *   · `lite`         —— `UnetLoaderGGUF` + GGUF（Q4_K_M 优先，见 MODEL_HINTS.unetGguf）。
 *
 * ⚠ **本表只描述"档位长什么样"，不做任何下载决策** ——
 *   下什么模型由 `scripts/setup.mjs` 的档位选择（安装时那个二选一弹窗）决定。
 *   运行期只做一件事：**看 `cfg.unet` 的后缀**决定用哪个加载器（见 `unetLoaderFor`），
 *   于是"用户下载时选了什么"就自动决定了"运行时怎么加载"，不需要再多一个开关。
 */
```

### config-note-069（原 lib/config.js L2618-2635）

```js
/**
 * ★★★ 2026-10-12 新增：**Spectrum 跳步节点**的类名（第三方：ComfyUI-Spectrum-Qwen-Proper）。
 *
 * 它做的事：在**真实的** Qwen 前向步上抓取 `norm_out` 之前的隐状态，
 * 用岭正则化的切比雪夫拟合去**预测**后续步的隐状态，从而**跳过部分昂贵的 transformer 前向**，
 * 只跑 `time_text_embed → norm_out → proj_out` 这条轻量尾巴。
 * 与 ICML 2025 的 SADA 是**同一思路**（跳过冗余计算），但**是 Qwen 专用的**。
 *
 * ⚠ 必须如实告知的三条边界（取自它自己的 README，不是我的推断）：
 *   ① *"This is not a paper-exact universal Qwen port"* —— 不是论文级通用移植；
 *   ② *"The node does not score image quality for you. You still need to compare results
 *      and tune aggression based on your workflow."* —— **它不替你评估画质**，得自己 A/B 比；
 *   ③ `cache_device = cpu` *"trades VRAM for latency"* —— 可能把提速吃掉。
 * ⚠ 它的默认 `warmup_steps=5` + `tail_actual_steps=2` 是给**常规步数**调的；
 *   本插件的 turbo8 链只有 **8 步** ⇒ 默认参数下**只剩 1 步可跳**，收益可能被预测器自身开销吃掉。
 *   ⇒ 所以本插件里它**默认关**，且参数全部可调（见 DEFAULTS.spectrum*），
 *     必须**先实测**再决定要不要开（见 `_spectrum_ab.mjs`）。
 */
```

### config-note-070（原 lib/config.js L2638-2655）

```js
/**
 * ★★★ 2026-10-12（用户要求 + 审计文档）：**SADA 跳步采样**（ICML 2025 论文
 * "Stochastic Adversarial Diffusion Acceleration"，arXiv 2507.17135）。
 *
 * · 论文实现：`liming123332/comfyui-sada-icml`（第三方）。
 * · 思路：跳过冗余的 Qwen transformer 前向；与 Spectrum 同源但走**新分布**。
 * · 本机**当前未安装该节点**（实测 `custom_nodes/` 目录无 sada 痕迹），
 *   所以**默认关**且插件**不自动下载**（避免版权/GPU 资源的隐式开销）。
 *
 * ⚠ 接入方式（与 Spectrum 保持一致）：
 *   ① 探测阶段 `object_info /SADA*` → `caps.nodes.sada`；
 *   ② resolvePlan 据 `cfg.sadaEnabled` 决定 `useSada`；
 *   ③ buildWorkflow 把节点挂在模型链最末端（KSampler 之前），开关关时整段 delete；
 *   ④ 描述面板单列一项，**默认关 + 已实测基线**，开不开用户说了算。
 *
 * ⚠ 与 Spectrum 一样：节点不存在时 `withSada` 必为 false（**绝不**把不存在的节点
 *   塞进 workflow —— ComfyUI 会直接拒收）。
 */
```

### config-note-071（原 lib/config.js L2658-2677）

```js
/**
 * 主模型**两档**（★ 用户要求保留轻量档）。
 *
 * ⚠⚠ 2026-10-12：**lite 档的自动下载源必须改** —— 原先引的
 * `unsloth/Qwen-Image-2.1-GGUF` 的 `qwen-image-2.1-Q4_K_M.gguf` 是
 * **stable-diffusion.cpp 格式**，ComfyUI-GGUF 的 `UnetLoaderGGUF` 加载不了。
 * 三条证据：
 *   1. 该仓库 ModelScope 页只写 **stable-diffusion.cpp**，没提 ComfyUI-GGUF/city96；
 *   2. ComfyUI-GGUF 官方 README 只列 `city96/FLUX.1-dev-gguf` / `FLUX.1-schnell-gguf`；
 *   3. 用户真下了 4,199,565,024 字节那个文件验过 GGUF 头 ——
 *      **元数据无 `general.architecture`**、张量名 `model.diffusion_model.*`。
 *
 * ⚠ 但 ComfyUI-GGUF 的 `IMG_ARCH_LIST` **确实含 `qwen_image`** ⇒ **节点层面支持**，
 *   缺的只是"ComfyUI 能吃的那份 GGUF 文件"。所以**档位保留**，改为：
 *   · 不再**自动下载**那份错文件（那是 bug，已修）；
 *   · lite 档改为**用户自备 GGUF** —— 把可用文件放进 `models/unet`，
 *     插件会自动按文件名挑最优的一个来用。
 *
 * ⚠ 本表只放"档位 → 加载器"，不放推荐文案（文案在 setup.mjs 的 TIERS 里）。
 */
```

### config-note-072（原 lib/config.js L2696-2700）

```js
  // ★★★ 2026-10-14（C2「专业卡版」）：两个**高精度档**。
  //   ⚠ 它们**不预置具体文件名** —— 由插件从你已装的文件里按标记挑（见 pickUnetForTier）。
  //     这样不会因为"我猜的文件名不对"而假装选中。挑不到就**如实回落**。
  //   ⚠ 本机（AMD RX 7900 XT 20 GB）**无法实测 BF16 / FP8**，档位是按官方发布格式
  //     与显存需求写的；真机效果需你在 24 GB+ 卡上验。
```

### config-note-073（原 lib/config.js L2713-2729）

```js
/**
 * ★★★ 2026-10-14（C2）：按**精度档**从已装的主模型文件里挑一个。
 *
 * ## 为什么按"标记"挑、而不是写死文件名
 *   用户的模型文件名五花八门（各家重打包）。写死一个名字，一旦对不上就会出现
 *   "面板说用上了 BF16、实际跑的还是 int8" —— 这正是本项目反复踩的**假报告**。
 *   所以：**按文件名标记挑；挑不到就返回 null，由调用方如实回落**。
 *
 * ## 各档判据
 *   · `gguf` —— `.gguf` 结尾，按 Q4_K_M > Q4_0 > Q5_K_M … 排序
 *   · `int8` —— 含 `int8`
 *   · `fp8`  —— 含 `fp8`
 *   · `bf16` —— 含 `bf16`/`bfloat16`；**没有再退一步**找"完全无量化标记"的原生文件
 *   · `auto` —— 返回 null（由调用方走老逻辑 `MODEL_HINTS.unet`）
 *
 * @returns {{unet: string, loader: string, tier: string}|null}
 */
```

### config-note-074（原 lib/config.js L2759-2777）

```js
/**
 * ★★★ 2026-10-14（C1「专业卡版」）：把「档位 + 显存 + 平台」折算成 ComfyUI 的显存/内存启动参数。
 *
 * 放在 config.js 而不是 index.js：**启动参数**（index.js 的 ensureComfyUp）与
 * **面板报告**（resolvePlan 里的 residency）必须**同源** —— 两处各写一份，
 * 迟早出现"面板说一套、实际跑另一套"（本项目历史上就出过这种假报告）。
 *
 * 档位（`cfg.vramMode`）：
 *   'auto'     —— 按显存自动（老行为）：≥24 全驻留；16–24 全驻留+保留 0.5；<16 不加
 *   'resident' —— 全驻留 `--highvram`（最快，要求显存装得下）
 *   'standard' —— 不加驻留参数，交给 ComfyUI 自己调度
 *   'save'     —— 省显存 `--lowvram`（部分权重换到内存，会慢）
 *   'ram'      —— 权重放内存 `--novram`（权重常驻内存、按需换入；最省显存、最慢）
 *   'cpu'      —— 纯 CPU `--cpu`（最后手段，很慢）
 *
 * ⚠ macOS：ComfyUI 源码里 MPS 的 `vram_state` 被强制成 `SHARED`，
 *   这组离散显存参数**根本不参与** ⇒ 显式档位在 Mac 上**不生效**，如实返回空。
 * ⚠ 全部是**启动参数** ⇒ 改完必须重启 ComfyUI。
 */
```

### config-note-075（原 lib/config.js L2825-2845）

```js
/**
 * ★★★ 2026-11-12 新增：**低配（核显 / 共享显存 / 8 GB 内存）出图就绪度评估 + 量化验收门槛**。
 *
 * ⚠⚠ 诚实声明：下面的 `speedTargetSec` 与 `meetsAcceptableBar` 门槛是**默认目标值**，
 *   **未经任何真机实测校准**（unverified）。本机没有 Intel 核显 / 8 GB 内存硬件，
 *   无法跑出真实秒数。它们的作用是：
 *     ① 让"什么是可接受出图速度"有一个**可量化、可复核**的初判口径，而不是空喊"能出图"；
 *     ② 作为**待校准占位**，真机跑一张图后替换成实测值即可；
 *     ③ **绝不**写进 README 当结论性指标（README 只写"已支持、门槛待实测校准"）。
 *
 * 判定口径：
 *   · 共享显存（核显）：整机内存 ≥ 16 GB 才谈得上"可接受速度"；8 GB 仅能出图、明显偏慢。
 *   · 独立显存：≥ 8 GB 视为可达标下限，≥ 16 GB 视为舒适区。
 *   · 精度档：共享显存无论探测到多大显存都按最轻 GGUF 档处理（核显上 q4 最稳）。
 *
 * @param {object} profile  detectGpuProfile 返回或等价结构（含 vramGB / sharedMemory / systemRAMGB）
 *   可选 `igpuProfileId` / `igpuProfile`：用户显式选的核显型号 id（见 lib/igpu-profiles.js）。
 * @returns {{tier:string, sharedMemory:boolean, vramGB:number, systemRAMGB:number,
 *            meetsAcceptableBar:boolean, speedTargetSec:number|null, unverified:boolean,
 *            caveat:string, igpuProfile:object|null}}
 */
```

### config-note-076（原 lib/config.js L2871-2874）

```js
  // ★ 2026-11-13：用户显式选了核显型号时**只附加建议**，绝不改动上面的门槛判定。
  //   ⚠ 型号档案里的参考秒数是 SD / SDXL / Z-Image-Turbo 等**别的模型**的社区数据
  //     （comparable:false、unverified），拿来替换 speedTargetSec 等于把「量级参考」
  //     伪装成「本插件实测指标」。所以这里只透出 igpuProfile，不碰任何原有字段。
```

### config-note-077（原 lib/config.js L2917-2924）

```js
/**
 * 给用户看的一句话：当前主模型用的是哪个文件、走哪个加载器。
 *
 * ⚠ 判定**与 `resolvePlan` 同源** —— 只看最终生效的那个模型名（+ 探测阶段定下的加载器），
 *   不另起一套判断。否则又是"面板说一套、实际跑另一套"（这个坑本项目踩过好几次）。
 * ⚠ 2026-10-12：**轻量档保留**，但 lite 不再预置具体文件名（上游那份是 sd.cpp 格式），
 *   改由插件从已装的 GGUF 里挑。这里如实报告"档位 + 当前文件"。
 */
```

### config-note-078（原 lib/config.js L2943-2955）

```js
/**
 * ★★★ 2026-10-11 新增：**把关键能力缺口从 `caps.notes` 里挑出来**，供面板显示。
 *
 * ## 为什么需要（这是个真缺口）
 *   `caps.notes` 以前**只写日志**（`log('info', ...)`），**面板上看不到**。
 *   于是"选了 GGUF 档、却没装 ComfyUI-GGUF 节点"这种**会让出图直接失败**的情况，
 *   用户在界面上完全看不出来 —— 直到出图被 ComfyUI 拒收才知道。
 *   那正是最该避免的一类体验：**机器明明知道，却没告诉用户**。
 *
 * ## 挑哪些
 *   只挑**以 `⚠` 开头**的（这是本项目里"重要"的既有约定），
 *   避免把"跳过了某环节"这类常规说明也糊到面板上。
 */
```

### config-note-079（原 lib/config.js L2981-2995）

```js
/**
 * 取某个节点的 schema。
 *
 * ★ 2026-10-09 加固：返回**三态**，而不是简单的 `null`。
 *
 * 之前用 `null` 表示一切失败，导致**无法区分"节点确实没装"和"这次查询没成功"** ——
 * 于是一次网络抖动、一次超时、甚至用户点了取消（signal abort），
 * 都会被判成"节点缺失" → 静默降级到 basic 档 → 再把这个错误结论**缓存 10 分钟**。
 * 用户看到的现象是"突然变慢好几倍，而且没有任何提示"，极难排查。
 *
 * @returns {{state:'ok'|'missing'|'error', node: object|null}}
 *   · `ok`      — 查询成功，节点存在
 *   · `missing` — 查询成功，但 ComfyUI 里确实没有这个节点（**确定**）
 *   · `error`   — 请求失败 / 超时 / 被取消（**不确定**，绝不能当作缺失）
 */
```

### config-note-080（原 lib/config.js L3060-3063）

```js
    // ★★★ 2026-10-14（C3/C4「专业卡版」）：ControlNet 的加载器与施加节点。
    //   · `ControlNetLoader`            —— ComfyUI 核心节点（列 models/controlnet 下的权重）
    //   · `ControlNetApplyAdvanced`     —— ComfyUI 核心节点（把 control 图作为条件施加）
    //   ⚠ 局部重绘走的是另一套（`ControlNetInpaintingAliMamaApply`），两者互不影响。
```

### config-note-081（原 lib/config.js L3183-3190）

```js
  // ---- 模型档位：决定"用哪个加载器 + 哪个主模型名"（★ 2026-10-11 小显存适配）----
  //
  // 规则（**保证默认行为与旧版一字不差**）：
  //   ① `cfg.unet` 是 `.gguf`                        → 走 GGUF 档（安装时选了小档）
  //   ② 配置的主模型**一个都没探到**、却探到了 GGUF   → 自动走 GGUF 档（**记 note，不静默**）
  //   ③ 其余                                          → 原生 UNETLoader（现状）
  //
  // ⚠ 必须算在 `hasCore` **之前**：否则"只装了 GGUF"的机器会被误判成 unsupported。
```

### config-note-082（原 lib/config.js L3209-3212）

```js
  // ---- ★★★ 2026-10-14（C2「专业卡版」）：**精度档**（面板可选）--------------------
  //   面板选了 bf16 / fp8 / int8 / gguf 时，从**已装文件**里按文件名标记挑一个；
  //   **挑不到就如实回落**（并记 note）—— 绝不出现"面板说用上了 BF16、实际跑 int8"的假报告。
  //   ⚠ 放在"档位判定"之前：hasCore 要用挑完之后的 unet。
```

### config-note-083（原 lib/config.js L3230-3233）

```js
  // ★ 2026-11-10：**显存 → 建议精度档**（`lib/model-map.js`，结构化半开区间，零 eval）。
  //   ⚠ 只写进 caps 供面板**如实展示建议**，绝不据此静默换模型 ——
  //     换模型要重载十几 GB，且"面板说用上了 BF16、实际跑 int8"这种假报告本项目出过。
  //     显存未知（0 / 探测失败）时给 null，面板就不显示这一句，而不是猜一个档。
```

### config-note-084（原 lib/config.js L3283-3288）

```js
  // ★★★ 2026-10-09 性能修正（需求方要求排查"重复请求、浪费算力"）：
  //   这里原先写的是"只在探测可信时才缓存"，于是**失败就完全不缓存** ——
  //   而状态端点是**每 5 秒轮询一次**的，且每次都会走一遍探测。
  //   结果：ComfyUI 在线但不稳定时，每 5 秒重发 10 个 HTTP 请求
  //   （9 个 object_info + 1 个 system_stats），纯粹是浪费。
  //   现在改为**失败也缓存，但用短 TTL**：既不重复轰炸，又能较快恢复真实结论。
```

### config-note-085（原 lib/config.js L3332-3339）

```js
  // ⚠ 只认 `level`（探测阶段算好的）。**绝不能**在这里用 `models.turbo8Lora` 判断 ——
  //   probeCapabilities 会把"没探测到"的 LoRA 名回落到默认文件名（为了给用户一个提示值），
  //   那时该字段非空但文件事实上不存在，用它判断会让 basic 档错误地接上 turbo8 LoRA，
  //   结果整单被 ComfyUI 以 `value not in list` 拒收。
  //
  // ★ 2026-10-09 精简：原先这里还写了 `c === FULL_CAPS ||`，其实**完全冗余** ——
  //   `FULL_CAPS` 自身的 `level` 就是 'full'、`nodes` 也全为 true，
  //   所以下面这些条件在传 FULL_CAPS 时本来就成立。
```

### config-note-086（原 lib/config.js L3341-3346）

```js
  // ★★★ 2026-10-14（C5「专业卡版」）：**文本控制档**（面板可选）。
  //   · 'native' —— 强制走千问**原生工作点**（25 步 / CFG 2.5），**不挂 turbo8**。
  //     turbo8 是为速度牺牲文字渲染的（8 步蒸馏）；要"更精细的文本控制"就该走原生。
  //   · 'turbo'  —— 强制极速档（有 turbo8 时）。
  //   · 'auto'   —— 老行为（有 turbo8 就走 8 步，没有就回退原生）。
  //   ⚠ 'native' 会明显变慢（约 3 倍采样时间）—— 这是拿时间换文字精度，不是 bug。
```

### config-note-087（原 lib/config.js L3353-3359）

```js
  // ★★★ 2026-10-12（用户要求）：**极速档（4 步）** —— 在 turbo 链之上再切一档。
  //   三个条件缺一不可：
  //     ① 整条 turbo 链可用（4 步档同样是"LoRA + 采样位移 + CFG 1.0"这套）；
  //     ② 用户把开关打开了；
  //     ③ **确实探测到了 4 步 LoRA** —— 否则切了也出不来图（ComfyUI 会 value not in list）。
  //   ⚠ 这里用 `caps.models.fast4Lora` 判断是**安全的**，不像上面 turbo8Lora 那条警告：
  //     4 步 LoRA 没有"回落成默认文件名"的问题，探测不到就是 null。
```

### config-note-088（原 lib/config.js L3363-3366）

```js
  // ⚠ TE-Speed / Speedup **刻意挂在 useTurbo 之下**（basic 档不接），这不是偷懒：
  //   它们的阈值（reuse_threshold 0.06 / te_predictor）是**针对 8 步 turbo8 链路调出来的**，
  //   挪到 25 步原生链路上，同一个阈值意味着完全不同的跳过行为，会动画质且未经验证。
  //   想强行叠加：把 turbo8Enabled 保持 true 即可（有 LoRA 时本来就会全接）。
```

### config-note-089（原 lib/config.js L3371-3396）

```js
  // ★★★ 2026-10-09：BlockCache T8 与 **TE-Speed、Speedup 三者互斥**（实测，见下）。
  //
  //   这不是猜测 —— 三个节点都在 ModelPatcher 上注册 **同一组** wrapper：
  //       DIFFUSION_MODEL + OUTER_SAMPLE
  //     · BlockCache  runtime.py:51 要求 **独占** DIFFUSION_MODEL：
  //         "Qwen Image 2.1 T8 cache requires exclusive diffusion-wrapper ownership;
  //          use T8 Spectrum"
  //     · TE-Speed    **编译成 nodes.pyd**，字符串表里能直接读到
  //         `DIFFUSION_MODEL` / `_predictor_diffusion_wrapper` /
  //         `_predictor_sample_wrapper` / `add_wrapper_with_key` / `WrappersMP`
  //     · Speedup     nodes.py:335-338 明写 add_wrapper_with_key(DIFFUSION_MODEL / OUTER_SAMPLE)
  //   只要同时挂上，KSampler 会在 sample_wrapper 里直接抛 ValueError，**整单失败**。
  //
  //   实测证据（同一台机器、图生图、逐个叠加）：
  //     BlockCache 单独                   → ✅ 成功，日志 `T8: full=6 cache=2`（真的命中）
  //     BlockCache + LoRA                 → ✅
  //     BlockCache + LoRA + Flux 位移     → ✅
  //     BlockCache + LoRA + Flux + 前缀缓存 → ✅
  //     BlockCache + … + **TE-Speed**     → ❌ ValueError 整单失败  ★ 真凶在这里
  //     （早先误判为 Speedup —— 当时 Speedup 也开着，是它先暴露了同样的错。）
  //
  //   ⇒ 处理：**BlockCache 优先，挂上它就让 TE-Speed 与 Speedup 双双让位**。
  //     理由：说好的「找一个能用的加速」就是 BlockCache，它是当前唯一被实测确认
  //     真正生效（cache 命中计数非零）的图生图加速；而 TE-Speed/Speedup 每步仍要
  //     算完整 block，只是跳预测，无法与它共存。
  //     想换回原来的链路：把 blockCacheEnabled 设成 false。
```

### config-note-090（原 lib/config.js L3398-3406）

```js
  // ★ 2026-10-10：RDNA3 FlashAttention —— 与上面三者**不互斥**（它是注意力层钩子，
  //   不是 DIFFUSION_MODEL wrapper），可任意叠加。无损，能力门控。
  //
  //   ★★ 还必须看 **GPU 架构**：FA 节点的 `patch()` 在不支持的架构上是**直接抛错**
  //      （不是"跳过"），一旦挂上就会让**整单失败**。所以门控加一条：
  //        · caps **完全没传**（自测 / planWorkflow）→ 视为"能力齐全"，不拦（守住既有约定）；
  //        · caps **传了** → **必须能确认是 RDNA3**（有 GPU 名 且 vendorIdOf==='amd_rdna3'）才挂。
  //          探测不到 GPU 名时**不放行** —— 否则会在"未知架构"上挂出会崩的节点。
  //   ★ 2026-10-10 修正：原先是"拿不到名字就不拦"，与"只认 gfx1100"自相矛盾。
```

### config-note-091（原 lib/config.js L3415-3424）

```js
  // ★★★ 2026-10-09 新增：**显存驻留**档位的判定（供面板如实展示）。
  //   注意：它**不是**工作流节点，而是启动参数 —— 真正的加参数逻辑在
  //   ensureComfyUp（见 VRAM_ARGS），这里只做"同一套规则"的复述，
  //   供 check_acceleration 面板显示，避免面板与实际启动参数说法不一致。
  //   判定必须与 VRAM_ARGS **完全同源**（都读 vramGB + comfyArgs），否则就是假报告。
  //   取值优先级与 detectGpuProfile 一致：caps.gpu（/system_stats，权威）→ cfg.vramGB（探测缓存）。
  // ★ 2026-10-10 修 bug：原来用 `??` —— 而 `c.gpu.vramGB` 在 `/system_stats` 缺 `vram_total`
  //   时会被算成 **0**，`??` 不会把 0 当"空值"跳过 ⇒ 面板报"未取到显存总量"，
  //   可真实启动参数那边用的是 PyTorch 探测值、**已经加了 --highvram** —— 又一处"面板与实际不同源"。
  //   改用 `||`：0 视为无效，继续往回落。
```

### config-note-092（原 lib/config.js L3452-3457）

```js
  // ★★★ 2026-10-12 新增（用户反馈）：**VAE 大图分块解码** 与 **Spectrum 跳步** 的可用性判定。
  //
  // ⚠ 这里**只判"节点在不在 / 配置要不要开 / 显存够不够紧"**，**不判出图尺寸** ——
  //   resolvePlan 拿不到尺寸（它同时被面板调用，面板没有尺寸概念）。
  //   尺寸那一道闸在 buildWorkflow 里（见那里的注释）。两处**判据必须同源**，
  //   否则又会出现"面板说一套、实际跑另一套"的假报告。
```

### config-note-093（原 lib/config.js L3464-3470）

```js
  /**
   * ★★ 2026-10-13：用户**显式**配的 turbo8 LoRA（null = 没改过，仍用内置默认值）。
   *
   * ⚠ 为什么必须跟 `DEFAULT_TURBO8_LORA` 比：DEFAULTS 里 `turbo8Lora` **默认就等于**
   *   这个内置值，所以它**永远非空** —— 用 `cfg.turbo8Lora || …` 判断"用户配没配"
   *   必然恒为真，探测结果就永远赢，用户配置形同虚设（这就是那个 bug）。
   */
```

### config-note-094（原 lib/config.js L3490-3494）

```js
  // ★★★ 2026-10-14（C3「专业卡版」）：**权重覆写是否被采纳**。
  //   规则：只有覆写值**确实出现在探测到的清单里**才认；清单拿不到（caps 缺省 / 探测失败 /
  //   该清单为空）时**不拦**（保持既有"按配置试"的语义）。
  //   ⚠ 覆写被"设置但未采纳"时**必须留痕**（`weightOverride.*.ok=false`），
  //     由面板如实显示 —— 否则就成了"我明明选了 X、插件却用了 Y"的静默改变。
```

### config-note-095（原 lib/config.js L3574-3582）

```js
      // ★ 2026-10-12：极速档时换成 4 步 LoRA（其余情况仍是 turbo8 / 配置值）
      // ★★ 2026-10-13 修 bug：**显式配置此前会被探测结果静默覆盖**。
      //   原来是 `c.models?.turbo8Lora || (cfg.turbo8Lora || DEFAULT_TURBO8_LORA)`
      //   —— 探测结果永远优先。而 `cfg.turbo8Lora` **默认就等于** `DEFAULT_TURBO8_LORA`
      //   （见 DEFAULTS），所以"用户有没有显式改过"不能靠真值判断，只能靠
      //   **是否仍等于内置默认值**来判断。
      //   ⇒ 现在：用户显式改过 → **尊重配置**；没改过（仍是默认值）→ 用探测结果。
      //     否则"我明明配了 A 模型，插件却挑了机器上另一个 turbo8 文件"无从排查。
      // ★★★ 2026-10-14（C3）：**面板选的 LoRA 优先级最高**（用户显式选的赢）。
```

### config-note-096（原 lib/config.js L3600-3615）

```js
/**
 * hipfire 出图分支（★ 2026-10-08 新增）。
 *
 * ★ 设计原则：**复用现有交付链路**，不另造一套 ——
 *   产物路径照样进 value.files → 由外层的 onProduced 登记交付事件 →
 *   正文 Markdown 内联显示（与 ComfyUI 路径完全同一条链路）。
 *
 * ★ 与 ComfyUI 分支的**语义差异**（都是客观限制，如实处理，不粉饰）：
 *   · 尺寸：hipfire 要求宽高是 **16 的倍数**（VAE factor 8 + 2x2 patch），
 *     所以把 calcSize 出来的值再过一遍 alignSize；图生图时 Klein 另有 1 MP 面积上限。
 *   · 步数：schnell 是步蒸馏模型，默认 4 步；用户没显式给 steps 时交给 hipfire
 *     用它自己的架构默认值（不硬塞插件的 25 步 —— 那对 schnell 是纯粹浪费）。
 *   · 参考图：hipfire 直接吃**本地路径**（CLI 的 --image / HTTP 的 multipart），
 *     **不需要**像 ComfyUI 那样先上传到 input 目录。
 *   · 负面提示词：hipfire 不支持 → 在适配器里明确报错。
 */
```

### config-note-097（原 lib/config.js L3620-3624）

```js
    // ★★★ 2026-10-09 修复（**通用性**）：这里原先硬拼 `home/Desktop`，
    //   绕过了本文件里已经写好的跨平台 `defaultOutputDir()`。
    //   而 `defaultOutputDir()` 的注释明确写过：Linux 上（服务器、WSL、无桌面环境）
    //   `~/Desktop` 常常压根不存在，硬拼会**造出一个用户根本不用的 Desktop 目录**。
    //   诊断日志跟出图成品放一起最自然，也顺带复用了那套 XDG → Desktop → 桌面 → 主目录 的探测。
```

### config-note-098（原 lib/config.js L3638-3661）

```js
/**
 * ★★★ 读 safetensors 的 header，取出**所有 4D 卷积权重的输入通道数**，
 *   用于判断 ControlNet 权重是给哪一代 Qwen-Image 底模的。
 *
 * ## 为什么需要
 *   真实用户实测反馈：InstantX 的 Qwen ControlNet（Union / Inpainting）是给
 *   **Qwen-Image 1.0** 的（latent 16 通道），而本插件默认底模是 **2.1**（latent 64 通道）
 *   ⇒ 执行时在 ComfyUI 的 `model.py` 里 unpack 崩。用户希望
 *   「**选权重时就提示，而不是装完才发现**」。
 *
 * ## 只读 header，不读权重本体
 *   safetensors 格式：前 8 字节 = 小端 uint64 的 header 长度 N；随后 N 字节 = JSON header，
 *   形如 `{"层名": {"dtype":"F16","shape":[...],"data_offsets":[a,b]}}`。
 *   所以**几 KB 的读取**就能拿到全部形状，不必把几 GB 权重读进来。
 *
 * ## ⚠ 这是**保守的启发式**，不是权威判定
 *   · `16` / `64` 两个阈值来自**用户实测反馈**（1.0 = 16ch、2.1 = 64ch）。
 *     **本机 `models/controlnet/` 是空的、没有该权重，我无法独立验证这两个数。**
 *   · 因此调用方**必须只在"只见到 16、没见到 64"时才警告**，其余一律不吭声 ——
 *     **宁可漏报，绝不误报**（"报错指错方向"比不报更浪费时间）。
 *
 * @param {string} filePath safetensors 文件路径
 * @returns {Promise<Set<number>|null>} 4D 卷积的 in_channels 集合；读不出返回 null
 */
```

### config-note-044（attention 槽位为什么是 43，2026-11-20 虫修复）

```js
    // ---- 2026-11-15：注意力 / 编译加速后端（SageAttention / Comfy-WaveSpeed）----
    //   接在模型链最末端、KSampler 之前。第三方节点：没探测到就整段 delete，
    //   否则 ComfyUI 会 "node type not found" 拒收整单。
    //   ★ 槽位必须是 43：30..41 属 ControlNet（4 路 stack 的 loaderId 最高到 40），
    //     42 是 EasyCache —— 2026-11-20 实锤旧值 40 会被 4 路 stack 的
    //     ControlNetLoader 覆盖（test-gap-fill「attention × 4 路 ControlNet」防线）。
```

旧值 40 的后果：4 路 stack（`loaderId = 30 + i*3 + 1`，i=3 → 40）后执行，`workflow[40]` 被写成
ControlNetLoader，attention 节点被顶掉，而 KSampler.model 仍指向 '40' —— 整图坏。
两开关默认皆关故从未在真机爆过；EasyCache 当年特意避开 30..41 选 42（L1318 注释），attention 漏避让属疏忽。
防线：test-gap-fill「attention × 4 路 ControlNet（2026-11-20 虫修复）」节 5 条断言 + test-attention-wiring
源码锁同步迁到 43（意图不变原则：锁的是链末端接线与删除表卫生，不是槽位数字本身）。
