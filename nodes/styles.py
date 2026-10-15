"""出图风格预设。

## ⚠ 先说清一件事，免得误解
这些预设**不是模型微调 / 不是 LoRA**，它们只是**一组提示词模板 + 推荐参数**：
  · `positive_suffix` —— 追加到你 prompt 后面的风格描述词；
  · `negative`        —— 该风格常用的负面词；
  · `steps` / `cfg`   —— **可选**覆盖；`None` 表示**跟随档位**（不覆盖）。

⇒ 所以"换个预设"= 换一段描述词，**不换模型、不增加显存**。
   效果差异来自提示词本身，不是玄学开关。

## ★ 为什么 steps/cfg 默认是 None（这是个设计决定，别改回去）
第一版一键出图有个 bug：用"用户填的档位"而不是"实际生效档位"去定 steps/cfg，
于是「按 8 步采样却没有 turbo8 LoRA」⇒ 糊图。
⇒ 所以这里**默认一律 None（跟随档位）**，只有当某个风格**确实需要**不同工作点时才显式写，
   并且写的时候要在 `note` 里说明原因。

## 想改就用
直接编辑本文件的 `STYLE_PRESETS` —— 它就是一个普通 dict，改完重启 ComfyUI 即生效。
"""

# ─────────────────────────────────────────────────────────────────────────────
# 风格表
# ─────────────────────────────────────────────────────────────────────────────
# 每个条目：
#   label           界面显示名（**列表顺序 = 下拉顺序**）
#   positive_suffix 追加到 prompt 后的风格词
#   negative        负面词
#   steps / cfg     None = 跟随档位；填数字 = 显式覆盖
#   sampler / scheduler   采样器（None = 用节点默认 euler/simple）
#   note            给用户的说明（会写进节点的 report）
STYLE_PRESETS = [
    {
        "key": "none",
        "label": "（不加风格词）",
        "positive_suffix": "",
        "negative": "",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "只按你写的 prompt 出图，不追加任何风格词。",
    },
    {
        "key": "photo",
        "label": "写实摄影",
        "positive_suffix": "，写实摄影风格，自然光，浅景深，皮肤与材质细节清晰，色彩真实，高动态范围",
        "negative": "绘画感、插画感、塑料感、过度磨皮、畸变、模糊、低分辨率",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "偏真实照片。想要证件照/人像质感就用它。",
    },
    {
        "key": "cinematic",
        "label": "电影感",
        "positive_suffix": "，电影质感，戏剧性布光，冷暖对比，宽画幅构图，胶片颗粒，氛围浓厚",
        "negative": "过曝、死黑、平淡布光、卡通感、低对比",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "强氛围与光影对比，适合场景图。",
    },
    {
        "key": "anime",
        "label": "动漫插画",
        "positive_suffix": "，日式动漫插画风格，干净线条，通透上色，精致五官，柔和光晕",
        "negative": "写实照片感、真人皮肤质感、噪点、脏色、比例失调",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "二次元插画。注意：它只是描述词，不等于专门的动漫模型。",
    },
    {
        "key": "ink",
        "label": "水墨国风",
        "positive_suffix": "，中国水墨画风格，留白，写意笔触，墨色浓淡，宣纸质感，东方意境",
        "negative": "浓艳塑料色、写实照片感、硬边线稿、西方油画感",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "水墨/国风。千问对中文提示词理解较好，效果通常不错。",
    },
    {
        "key": "3d",
        "label": "3D 渲染",
        "positive_suffix": "，3D 渲染风格，PBR 材质，体积光，全局光照，次表面散射，八猴/OC 渲染器质感",
        "negative": "手绘感、平面贴图、低模粗糙、锯齿、过曝",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "偏三维渲染质感，适合产品/角色展示。",
    },
    {
        "key": "product",
        "label": "产品摄影",
        "positive_suffix": "，商业产品摄影，纯色背景，柔光箱布光，清晰锐利，高细节，电商级质感",
        "negative": "杂乱背景、手部、文字水印、反光溢出、模糊",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "干净背景 + 商业布光，适合商品图。",
    },
    {
        "key": "concept",
        "label": "概念艺术",
        "positive_suffix": "，电影级概念艺术，宏大场景，丰富细节，matte painting 质感，史诗氛围",
        "negative": "简陋、平面、低细节、卡通、构图松散",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "场景概念图，细节量与氛围优先。",
    },
    {
        "key": "cyberpunk",
        "label": "赛博朋克",
        "positive_suffix": "，赛博朋克风格，霓虹灯光，潮湿反光地面，青紫配色，未来都市，高对比",
        "negative": "白天、田园、柔和暖色、低对比、朴素",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "霓虹 + 冷暖对撞。",
    },
    {
        "key": "watercolor",
        "label": "水彩手绘",
        "positive_suffix": "，水彩画风格，透明叠色，纸张纹理，柔和边缘，手绘感",
        "negative": "数码感、油腻、硬边、写实照片感、高饱和",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "轻盈手绘。",
    },
    {
        "key": "minimal",
        "label": "极简",
        "positive_suffix": "，极简主义，大量留白，单一主体，干净背景，克制的配色",
        "negative": "繁复、杂乱元素、多种主体、花哨配色、纹理堆叠",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "少即是多，适合做图标/壁纸/封面底图。",
    },
    {
        "key": "gameart",
        "label": "游戏原画",
        "positive_suffix": "，游戏角色原画，立绘质感，精致装备细节，动态姿势，厚涂上色",
        "negative": "低模、简笔、模糊、肢体畸变、装备糊成一团",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "角色立绘向。肢体畸变时加负面词或提高步数。",
    },
    {
        "key": "bnwfilm",
        "label": "黑白胶片",
        "positive_suffix": "，黑白胶片摄影，银盐颗粒，高反差，经典构图，无色彩",
        "negative": "彩色、低对比、数码平滑感、过曝",
        "steps": None, "cfg": None,
        "sampler": None, "scheduler": None,
        "note": "纯黑白 + 颗粒。",
    },
]

# 下拉里显示的名字（顺序 = STYLE_PRESETS 顺序）
STYLE_LABELS = [p["label"] for p in STYLE_PRESETS]
# key <-> label 互查
STYLE_BY_KEY = {p["key"]: p for p in STYLE_PRESETS}
STYLE_BY_LABEL = {p["label"]: p for p in STYLE_PRESETS}


def resolve_style(style, user_prompt="", user_negative=""):
    """把"风格 + 用户 prompt"合成最终的正/负提示词与推荐参数。

    返回 dict：`positive` / `negative` / `steps` / `cfg` / `sampler` / `scheduler` / `note` / `key`。

    ## 合并规则（三条，都是为了"不越俎代庖"）
    1. 风格词**追加在用户 prompt 之后**（不覆盖用户写的内容）；
    2. 负面词：用户自己写了就用用户的，没写才用风格自带的（**用户优先**）；
    3. `steps`/`cfg` 默认 `None` ⇒ 调用方应保持档位工作点（**这是防止"8 步无 LoRA"糊图的关键**）。

    ⚠ 传了不认识的风格名 → 按 `none` 处理并**在 note 里说明**，绝不静默当没传。
    """
    preset = STYLE_BY_KEY.get(str(style or "").strip()) \
        or STYLE_BY_LABEL.get(str(style or "").strip())

    unknown = False
    if preset is None:
        preset = STYLE_BY_KEY["none"]
        unknown = str(style or "").strip() != ""

    suffix = preset.get("positive_suffix") or ""
    base = (user_prompt or "").strip()
    positive = (base + suffix).strip() if suffix else base

    # 负面词：用户优先
    negative = (user_negative or "").strip() or (preset.get("negative") or "")

    note = preset.get("note") or ""
    if unknown:
        note = f"⚠ 未识别的风格「{style}」→ 已按「不加风格词」处理（不会静默套用别的风格）。{note}"

    return {
        "key": preset.get("key"),
        "positive": positive,
        "negative": negative,
        "steps": preset.get("steps"),
        "cfg": preset.get("cfg"),
        "sampler": preset.get("sampler"),
        "scheduler": preset.get("scheduler"),
        "note": note,
    }


class QwenImageStylePreset:
    """把「你的 prompt + 一个风格」合成最终的正/负提示词，输出给别处接线用。

    ## 为什么单独做一个节点
    一键出图节点内部当然会用风格，但那样**只有一键能用**。
    单独做成节点后，你可以把它接进**任何工作流**：
    `QwenImageStylePreset` → `TextEncodeQwenImage21` → 你自己的采样器/放大链。

    ## ⚠ 输出的 `steps` / `cfg` 为 **0** 表示「跟随档位」
    这两项是 INT/FLOAT，没法输出 `None`，所以用 **0 = 不覆盖**。
    ⇒ 接线时请按「0 就用你原来的值」处理；**别把 0 直接当步数喂给 KSampler**。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "style": (STYLE_LABELS,),
            },
            "optional": {
                "negative_prompt": ("STRING", {"multiline": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("positive", "negative", "steps", "cfg", "note")
    FUNCTION = "apply"
    CATEGORY = "Qwen Image Optimized/风格"
    DESCRIPTION = (
        "把 prompt 与风格预设合成最终提示词（纯描述词模板，不是 LoRA/微调）。"
        "输出的 steps/cfg 为 0 表示「跟随档位，不覆盖」。"
    )

    def apply(self, prompt, style, negative_prompt=""):
        r = resolve_style(style, prompt, negative_prompt)
        # None → 0（表示"不覆盖"）；见类注释
        return (r["positive"], r["negative"],
                int(r["steps"] or 0), float(r["cfg"] or 0.0),
                r["note"])
