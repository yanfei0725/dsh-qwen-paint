# lib/tts-workflow.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### tts-workflow-note-001（原 lib/tts-workflow.js L46-65）

```js
/**
 * 语音克隆链（D21，2026-11-14 新增）。
 *
 * ## 为什么**刻意不放进** TTS_FALLBACK_CHAINS
 *   这条链必须有参考音频才能构造。混进自动兜底会在「用户没给参考音频」时被选中，
 *   然后要么构造失败、要么退化成随机音色 —— 两种都是静默骗人。
 *   所以由调用方显式声明要用它，才走这里。
 *
 * ## 真机槽位（ComfyUI 0.39.0，/object_info 1686 节点，2026-11-14 实测）
 *   · `FB_Qwen3TTSVoiceClone`
 *       required = target_text / model_choice / device / precision / language
 *       optional = **ref_audio(AUDIO)** / **ref_text(STRING)** / voice_clone_prompt(VOICE_CLONE_PROMPT) / …
 *     ⇒ 参考音频是**可选输入**，不给也能跑（那就是随机音色），所以槽位存在 ≠ 克隆生效，
 *       必须由我们显式连线。
 *   · `VHS_LoadAudio`：required = audio_file(**STRING**，默认 "input/")，输出 [AUDIO, FLOAT]
 *     ⇒ 选它而不是官方 `LoadAudio`：后者 `audio` 是 COMBO 且本机 options 为空数组，
 *       传任何文件名都可能被判非法；`VHS_LoadAudio` 直接收路径字符串，稳得多。
 *       代价是依赖 VideoHelperSuite —— 而本项目的视频链本来就在用它，不是新增依赖。
 *   · `VoiceClone` / `VoiceClonePrompt` 这两个**裸名字不存在**，真名带 `FB_Qwen3TTS` 前缀。
 */
```

### tts-workflow-note-002（原 lib/tts-workflow.js L144-149）

```js
/**
 * 多角色对话链（A1 提案落地第一步，2026-11-19）——「角色名: 台词」脚本 → 多音色连续对话音频。
 * 设计说明已外置 → docs/backend-headers-design-notes.md#backend-note-tts-workflow-dialogue
 * （节点 schema 事实 / 为何不入兜底链 / 脚本先验纪律）。刻意不放进 TTS_FALLBACK_CHAINS：
 * 必须先上传各角色参考音频才能构造，混进自动兜底会「探测放行、构造失败」。
 */
```

### tts-workflow-note-003（原 lib/tts-workflow.js L180-191）

```js
/**
 * 构造多角色对话工作流。
 *
 * @param {object} caps 同 buildTtsWorkflow（用 caps.nodes 判节点齐否）
 * @param {object} opts
 *   · script：「角色名: 台词」多行脚本（半角/全角冒号都行）
 *   · roles: [{ name, referenceFile, referenceText? }]（1..8 个；referenceFile=已上传的
 *     ComfyUI input 文件名，uploadRefAudio 产物；referenceText 缺省只取说话人嵌入）
 *   · seed/prefix/modelChoice/attention 同克隆链；mergeOutputs 默认 true（合并成单音频）
 *   · pauses: { linebreak, period, comma, question, hyphen } 可选覆盖节点默认停顿
 * @returns {{ workflow: object, payload: object, probe: object, format: string, roleCount: number }}
 */
```

### tts-workflow-note-004（原 lib/tts-workflow.js L411-421）

```js
/**
 * ★ 2026-11-14 全面排查补齐：把 tts-accel.js 的配置补丁接进 TTS 链。
 *
 * 诚实边界（很重要）：ComfyUI 的 TTS 生成节点有哪些输入槽位，是运行时
 * /object_info 决定的；本项目**不预设**任何第三方节点一定接受
 * max_seq_len / vocoder_mel_dtype / streaming。把它们硬塞进节点只会让
 * 真机提交直接被 custom_validation_failed 拒掉。
 * ⇒ 只有调用方显式给出 acceptedInputs（来自真实探测）时才写入；
 *   否则一律只回显到元数据、标 applied:false，绝不污染工作流。
 * 纯函数、零 I/O；不引用任何未经实测的倍率 / RTF / 毫秒数。
 */
```

### tts-workflow-note-005（原 lib/tts-workflow.js L449-465）

```js
/**
 * 构造 TTS 工作流。缺后端时抛带清单的明确错误（报告 §10「任何一层不吞异常」）。
 * 有后端时：Qwen3-TTS 生成节点 → 音频保存节点。
 * accelPatch 来自 ttsAccelToWorkflowPatch()；acceptedInputs 来自 /object_info 探测。
 */
/**
 * ★ 2026-11-15：用户显式选择**非默认** TTS 后端时的工作流构图。
 *
 * ## 诚实边界
 *   GPT-SoVITS v5 / IndexTTS2 的节点类名、输入槽位、权重名都未经本机核实。
 *   ⇒ 生成 / 保存节点一律来自 pickTtsBackend() 对真实 /object_info 的模式发现；
 *     输入只写 acceptedInputs 里确实存在的槽位（没探测到就只给 text），
 *     并在 note 里说明「若被节点拒绝，请按节点包文档补齐槽位映射」。
 *   ⇒ 探测不到节点直接抛明确清单，**绝不静默回退到 Qwen3-TTS**
 *     （用户选了 A 却偷偷跑 B 是最坏的那种骗人）。
 *   ⇒ 不改 TTS_FALLBACK_CHAINS，默认路径完全不变。
 */
```
