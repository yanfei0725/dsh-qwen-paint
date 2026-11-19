# lib/hipfire-img.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### hipfire-img-note-001（原 lib/hipfire-img.js L27-39）

```js
  /**
   * 出图模型：registry tag、别名、文件名，或 **hfq trunk pack 的路径**。
   *
   * 默认给 FLUX.2 Klein 4B 的本地路径（本地打包产物，无需注册进 registry）。
   * 官方 docs/IMAGEGEN.md 明确：`hipfire img` 的 MODEL 参数接受
   * 「path to an HFQ trunk pack (`<base>-transformer.hfq`, with its sidecar
   * packs next to it)」—— 即只要 `<base>-transformer.hfq` 旁边放着同名的
   * `-qwen3.hfq` / `-vae.hfq`，直接给路径即可。
   *
   * 为什么默认不是 `flux.schnell:1`：FLUX.1 schnell 主干 23.8 GB、
   * 常驻约 24.3 GB，24 GB 卡（RX 7900 XT/XTX）装不下会 OOM；Klein 4B
   * 约 13 GB，能跑。见 docs/IMAGEGEN.md §10。
   */
```

### hipfire-img-note-002（原 lib/hipfire-img.js L91-101）

```js
/**
 * 按优先级找一个**真实存在**的 hipfire 可执行文件。
 *
 * ① cfg.hipfireExe          用户显式配置，最高优先级
 * ② HIPFIRE_EXE             环境变量
 * ③ HIPFIRE_HOME 之下       hipfire / hipfire.exe / engine/ / bin/
 * ④ PATH                    hipfire.exe / hipfire（Windows 再试 .cmd/.bat）
 * ⑤ 常见安装位置            Windows 与 Linux 各若干（够用即可，不穷举）
 *
 * @returns {Promise<string>} 绝对路径；一个都没找到返回 ''（调用方据此明确报错）
 */
```

### hipfire-img-note-003（原 lib/hipfire-img.js L109-114）

```js
  // ① 显式配置 —— ★ 一旦配了就必须生效，找不到就报错
  //
  //   设计理由：cfg.hipfireExe 是用户**有意指定**的路径。如果它不存在却
  //   静默回退到自动探测，用户会以为"我配的生效了"，实际跑的是另一个 exe
  //   （版本可能不同，甚至来自 PATH 里的无关程序）。这属于**隐蔽的错误成功**，
  //   比直接报错更有害。所以显式配置失败 = 立即返回 ''，交由调用方明确报错。
```

### hipfire-img-note-004（原 lib/hipfire-img.js L146-151）

```js
  // ⑤ 常见安装位置
  //
  // ★ 盘符必须覆盖全 —— 实测有用户把 hipfire 装在 X:\hipfire\engine\
  //   （C 盘紧张、GPU 模型放数据盘的常见做法）。只列 C/D 会"探测不到"，
  //   表现为 resolved='' 后报"请显式配置 hipfireExe"，与"通用桥接"的定位相悖。
  //   Windows 实用盘符就是 C–K，穷举 9 个 × 2 布局的 stat 成本可忽略。
```

### hipfire-img-note-005（原 lib/hipfire-img.js L180-189）

```js
/**
 * spawn 一个子进程，收集 stdout / stderr，支持超时与 signal 取消。
 *
 * ★ 为什么必须用 spawn 而不是 exec：
 *   · exec 把整条命令交给 shell 解析 → 提示词里的 & | > " 都会变成注入面；
 *   · exec 默认 maxBuffer 1 MB，hipfire 的进度输出很容易超；
 *   · prompt 含空格 / 中文 / 引号时，spawn 传数组参数是唯一安全做法。
 *
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean}>}
 */
```

### hipfire-img-note-006（原 lib/hipfire-img.js L194-202）

```js
      // ★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）：
      //   显式传入**过滤后的**环境变量，不再直接继承宿主环境。
      //   审核员明确指出"spawn 未显式设置 env 会继承宿主环境"（并说明这本身
      //   不构成拒绝理由，但既然要整改就做对）：
      //     · 剔除 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY —— 否则子进程的网络去向
      //       可能与本插件声明的"仅本机回环"不一致（代理会把请求转出去）；
      //     · 剔除 *TOKEN* / *KEY* / *SECRET* / *PASSWORD* / *CREDENTIAL* 类变量 ——
      //       子进程没有理由看到它们，少一份泄露面。
      //   保留 PATH / SystemRoot / HOME / TEMP 等运行必需项（见 net-guard.filteredEnv）。
```

### hipfire-img-note-007（原 lib/hipfire-img.js L300-316）

```js
/**
 * ★★ 出图前先确认模型在本地 —— 这是实测事故的防线。
 *
 * 事故：`hipfire img flux.schnell:1` 在模型缺失时**不报错**，而是静默下载
 * 23.8 GB。在插件 600 秒超时里表现为"没有任何反馈"，最后只报超时；
 * 并且会在模型目录留下半截 `.part` 文件。
 *
 * ⚠ 判定依据必须是 `hipfire list --json` 的**结构化字段**，不能靠字符串匹配：
 *   实测 `hipfire list`（无 --json）会把 registry 里**全部 89 个模型**都打印出来，
 *   于是 `out.includes('flux.schnell:1')` 对**未下载**的模型也返回 true → 误判 ✗
 *   ✓ 而 `list --json` 明确分成：
 *       models   = 本地已下载
 *       registry = 远端目录，每项带 downloaded: true/false
 *
 * @returns {Promise<{local:boolean, known:boolean}>}
 *   local=true 表示确认在本地；known=false 表示预检本身没跑成（调用方据此放行）
 */
```

### hipfire-img-note-008（原 lib/hipfire-img.js L375-393）

```js
/**
 * 带超时的 fetch（尊重 signal）。
 *
 * ★★★ 2026-10-16（DSH STORE 第二轮复核整改）：**本函数是 hipfire 所有出站的唯一入口**
 *   （`probeHipfireHttp` / `generateViaHttp` 的两条端点全走它），因此把回环守卫收口在这里。
 *
 *   审核机器人指出（Issue #1390 第二轮）：
 *   > `probeHipfireHttp` / `generateViaHttp` 直接使用可配置 `cfg.hipfireUrl`，
 *   > 没有调用回环校验，也不受 `allowRemoteComfy` 控制；`guardedFetch` 目前只有定义、
 *   > 没有调用。只禁止重定向无法拦住首次请求就指向远端。
 *
 *   确实如此 —— 上一轮我只收口了 `comfyUrl`，漏了 hipfire 这条**独立的外部端点**。
 *   现在：出站前一律 `assertLocalUrl(url, { allowRemote })`；非回环且未 opt-in → 抛错。
 *   `allowRemote` 由调用方从 `cfg.allowRemoteComfy` 透传（与 comfyUrl 共用同一个开关）。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.allowRemote=false] 是否允许非回环地址（来自 cfg.allowRemoteComfy）
 */
```

### hipfire-img-note-009（原 lib/hipfire-img.js L397-400）

```js
  // ★ 2026-10-10 修 bug：**绝不能把 `signal.reason` 原样转发**。
  //   DSH 传入的 abort reason 可能是**普通对象**，原样 abort(reason) 会让 fetch 直接
  //   reject 那个对象，宿主 `String()` 之后就成了 `Error: [object Object]`（零信息量）。
  //   index.js 里已为同款问题加了 `cancelReason()`，这里是漏网的一处 —— 归一化成 Error。
```

### hipfire-img-note-010（原 lib/hipfire-img.js L412-416）

```js
    // ★★ 2026-10-16：改用 `guardedFetch` —— 它内部**同时**做两件事：
    //   ① 出站前 `assertLocalUrl`（非回环且未 opt-in 直接抛错，请求发不出去）；
    //   ② 强制 `redirect: 'error'`（不跟随任何 302）。
    //   这样校验与禁重定向**收口在一处**，不会出现"某条链路只做了其中一半"。
    //   （上一轮遗留问题：guardedFetch 只有定义没有调用 —— 现已接入。）
```

### hipfire-img-note-011（原 lib/hipfire-img.js L803-812）

```js
  // ★★★ 2026-10-16（DSH STORE 第二轮复核整改）：**进入 HTTP 路径前先做回环校验**。
  //
  //   为什么放在这里而不是只靠 fetchJson 里的守卫：守卫能保证"请求发不出去"，
  //   但错误会被 probeHipfireHttp 的 catch 吞成 `online=false`，于是用户看到的是
  //   "hipfire HTTP 服务不在线（http://192.168.1.5:11580），请先启动它：
  //    hipfire serve 127.0.0.1 11580 -d" —— **报错指错方向**，用户会去反复重启一个
  //   根本不该连的地址。真正原因（配置写的是远端、未 opt-in）被完全掩盖。
  //
  //   所以这里显式校验并返回**结构化、可读**的错误，与其它失败路径格式一致。
  //   CLI 通道不受影响（它不走网络，只起本机进程）。
```
