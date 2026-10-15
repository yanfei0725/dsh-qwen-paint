"""一键出图：一个节点从 prompt 直接出 IMAGE。

它内部把**优化加载器 + 加速链 + 文本编码 + 采样 + 分块解码**串好，
并把每一步的 report 汇总成一段人话输出。

## 设计取舍
  · 它**不替代**上面那几个细粒度节点 —— 想自己接线、想插额外 LoRA，
    就用 `QwenImageOptimizedLoader` / `QwenImageAccelChain` / `QwenImageTiledDecode`。
    本节点是给"不想接线，就想填个 prompt 出图"的人用的。
  · 它**复用**上面那几个节点的实现（直接实例化调用），**不存在第二套逻辑** ——
    否则"一键节点"和"手动接线"迟早跑出两种行为（DSH 版踩过这个坑）。

## ★ 修掉的一个真 bug（第一版）
  第一版直接用"用户填的 shift_preset"去决定 steps/cfg。
  但加载器在**找不到对应 LoRA** 时会如实回落到原生工作点 ——
  于是会出现「按 turbo8 的 **8 步**采样，却**没有** turbo8 LoRA」⇒ **糊图**。
  ⇒ 现在一律用**加载器最终实际生效的档位**（`load_optimized` 返回的 preset）来决定工作点。
"""

import folder_paths

from ._common import PRESET_WORKPOINT
from .accel import QwenImageAccelChain
from .decode import QwenImageTiledDecode
from .loader import QwenImageOptimizedLoader

CATEGORY = "Qwen Image Optimized/一键"

# 常用尺寸（都满足 32 对齐）
SIZES = ["1024x1024", "1152x896", "896x1152", "1216x832", "832x1216",
         "1344x768", "768x1344", "1536x640", "640x1536"]


class QwenImageOneClick:
    """填 prompt + 选尺寸 + 选档位 → 直接出图。

    可选输入：
      · `reference_image` —— 给了就走**图生图**（千问的编辑/改图路径，latent 由参考图定尺寸）；
      · `control_image` + `control_net_name` —— 给了就接 **ControlNet** 做结构约束。
    """

    @classmethod
    def INPUT_TYPES(cls):
        cnets = folder_paths.get_filename_list("controlnet")
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "negative_prompt": ("STRING", {"multiline": True, "default": ""}),
                "size": (SIZES, {"default": "1024x1024"}),
                "unet_name": (folder_paths.get_filename_list("diffusion_models"),),
                "clip_name": (folder_paths.get_filename_list("text_encoders"),),
                "vae_name": (folder_paths.get_filename_list("vae"),),
                "precision": (["auto", "bf16", "fp8", "int8", "gguf"], {"default": "auto"}),
                "shift_preset": (["auto", "turbo8", "fast4", "native"], {"default": "auto"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 8}),
                # 0 = 跟随档位的工作点（推荐）；显式填数则覆盖
                "steps_override": ("INT", {"default": 0, "min": 0, "max": 60}),
                "cfg_override": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 20.0, "step": 0.1}),
                "wrapper_mode": (["auto", "blockcache", "te_speedup", "none"], {"default": "auto"}),
                "decode_mode": (["auto", "always", "never"], {"default": "auto"}),
            },
            "optional": {
                "reference_image": ("IMAGE",),
                "control_image": ("IMAGE",),
                "control_net_name": (["(不用 ControlNet)"] + cnets,),
                "control_strength": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 10.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "report")
    FUNCTION = "generate"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "千问 2.1 一键出图：内部串好优化加载 + 加速链 + 采样 + 分块解码；"
        "可选接参考图（图生图）与 ControlNet。想自己接线请改用细粒度节点，"
        "本节点与它们**共用同一套实现**。"
    )

    def generate(self, prompt, negative_prompt, size, unet_name, clip_name, vae_name,
                 precision, shift_preset, seed, batch_size,
                 steps_override, cfg_override, wrapper_mode, decode_mode,
                 reference_image=None, control_image=None,
                 control_net_name="(不用 ControlNet)", control_strength=0.8):
        import nodes as comfy_nodes

        width, height = (int(x) for x in size.split("x"))
        lines = ["【一键出图】"]

        # ── ① 加载（复用优化加载器，**不另写一套**；拿它**最终实际生效**的档位）──
        loader = QwenImageOptimizedLoader()
        model, clip, vae, preset, load_report = loader.load_optimized(
            unet_name=unet_name, precision=precision, weight_dtype="default",
            clip_name=clip_name, vae_name=vae_name,
            width=width, height=height, shift_preset=shift_preset,
            apply_turbo_lora=True, lora_name="(自动挑)", lora_strength=1.0,
            apply_prefix_cache=True, cache_device="auto", cache_dtype="int8")
        lines.append(load_report.render())

        # ── ② 加速链 ──
        model, accel_report = QwenImageAccelChain().apply(
            model, wrapper_mode, width, height,
            enable_rdna3_fa=True, enable_spectrum=False, enable_sada=False)
        lines.append(accel_report)

        # ── ③ 文本编码 ──
        #   resolution 传目标尺寸的对角等效值（与 DSH 版一致）：参考图/文字排版都按它归一。
        resolution = round((width * height) ** 0.5)
        enc = comfy_nodes.NODE_CLASS_MAPPINGS["TextEncodeQwenImage21"]
        kwargs = dict(clip=clip, prompt=prompt, negative_prompt=negative_prompt,
                      vae=vae, resolution=resolution)
        if reference_image is not None:
            # 参考图走千问的 Autogrow 输入：`{"image_1": tensor}`
            kwargs["images"] = {"image_1": reference_image}
        out = enc.execute(**kwargs)
        result = getattr(out, "result", out)
        positive, negative = result[0], result[1]

        # ── ④ latent：有参考图就用编码器给的（尺寸与它一致），否则造空的 ──
        if reference_image is not None and len(result) > 2 and result[2] is not None:
            latent = result[2]
            lines.append("【图生图】latent 来自参考图（尺寸以参考图为准）")
        else:
            latent = comfy_nodes.NODE_CLASS_MAPPINGS["EmptyLatentImage"]().generate(
                width, height, batch_size)[0]

        # ── ⑤ ControlNet（可选）──
        if control_image is not None and control_net_name and control_net_name != "(不用 ControlNet)":
            cnet = comfy_nodes.NODE_CLASS_MAPPINGS["ControlNetLoader"]().load_controlnet(control_net_name)[0]
            positive, negative = comfy_nodes.NODE_CLASS_MAPPINGS["ControlNetApplyAdvanced"]().apply_controlnet(
                positive, negative, cnet, control_image, control_strength, 0.0, 1.0)
            lines.append(f"【ControlNet】{control_net_name}（strength={control_strength}）")
        elif control_image is not None:
            lines.append("【ControlNet】你给了控制图但**没选权重** → 不接（不假装生效）")

        # ── ⑥ 采样：步数/CFG 由**实际生效档位**决定，除非你显式覆盖 ──
        steps, cfg = PRESET_WORKPOINT.get(preset, PRESET_WORKPOINT["native"])[:2]
        if steps_override > 0:
            steps = int(steps_override)
        if cfg_override > 0:
            cfg = float(cfg_override)
        lines.append(f"【采样】档位={preset} → steps={steps} / cfg={cfg} / seed={seed} / {width}×{height} ×{batch_size}")

        sampled = comfy_nodes.common_ksampler(
            model, seed, steps, cfg, "euler", "simple", positive, negative, latent)[0]

        # ── ⑦ 解码（复用分块解码节点）──
        image, dec_report = QwenImageTiledDecode().decode(
            sampled, vae, decode_mode, 512, 64, True)
        lines.append(dec_report)

        return (image, "\n".join(lines))
