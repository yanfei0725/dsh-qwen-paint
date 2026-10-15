"""优化加载器：一次把 unet / clip / vae 装好，并把「精度档 / turbo LoRA / 采样位移 / 前缀缓存」接上。

这是一个**加速器**节点 —— 你把它插在工作流最前面，后面照常接
`TextEncodeQwenImage21` → `KSampler` → 解码即可。

## ★ 为什么加载一律走 ComfyUI 自己的节点类（而不是 comfy.sd 底层函数）
第一版我直接调了 `comfy.sd.load_vae(...)` —— 结果**这个函数在当前版本根本不存在**
（`comfy/sd.py` 里只有 `load_vae_patcher`），节点一执行就 `AttributeError` 崩掉。
而当时的契约测试**没抓到** —— 它只验类契约、**从不真正执行** load()。
⇒ 教训：**优先复用 ComfyUI 自带的节点类**（`UNETLoader` / `CLIPLoader` / `VAELoader`），
   它们的输入输出与当前版本**天然同步**；直接调底层函数等于把版本兼容的活揽到自己身上。
"""

import folder_paths

from ._common import (
    PRESET_WORKPOINT,
    PRECISION_TIERS,
    SHIFT_PRESETS,
    Report,
    available,
    call_patched_model,
    pick_unet_by_tier,
)

CATEGORY = "Qwen Image Optimized/加载"

# UNETLoader 支持的权重精度（**照抄** ComfyUI 自带选项，不自己编）
UNET_DTYPES = ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]


class QwenImageOptimizedLoader:
    """把千问 2.1 的加载 + 常用加速件合成一个节点。

    做四件事（每件都可单独关掉，且**关/缺都会写进 report**）：
      1. 按**精度档**挑主模型（bf16 / fp8 / int8 / gguf），挑不到就**如实回落**；
      2. 可选接 **turbo8 / fast4 蒸馏 LoRA**（提速的主力）；
      3. 按档位补上**采样位移**（`ModelSamplingFlux`）—— 位移与 LoRA 必须配套，
         且 shift **依赖真实宽高**（第一版写死 1024 是个 bug，会算错位移 → 掉画质）；
      4. 可选接 **QwenImage21Cache 前缀缓存**（ComfyUI 自带，无损/近无损）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unet_name": (folder_paths.get_filename_list("diffusion_models"),),
                "precision": (PRECISION_TIERS, {"default": "auto"}),
                "weight_dtype": (UNET_DTYPES, {"default": "default", "advanced": True}),
                "clip_name": (folder_paths.get_filename_list("text_encoders"),),
                "vae_name": (folder_paths.get_filename_list("vae"),),
                # ★ 位移依赖真实尺寸，所以必须让用户在节点上给出目标宽高
                "width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "shift_preset": (SHIFT_PRESETS, {"default": "auto"}),
                "apply_turbo_lora": ("BOOLEAN", {"default": True}),
                "lora_name": (["(自动挑)"] + folder_paths.get_filename_list("loras"),),
                "lora_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.01}),
                "apply_prefix_cache": ("BOOLEAN", {"default": True}),
                "cache_device": (["auto", "gpu", "cpu", "off"], {"default": "auto"}),
                "cache_dtype": (["default", "int8", "int4"], {"default": "int8"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "STRING")
    RETURN_NAMES = ("model", "clip", "vae", "report")
    FUNCTION = "load"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "千问 2.1 优化加载器：精度档选型 + turbo LoRA + 采样位移 + 前缀缓存，一次接好。"
        "每一项都可关；缺文件/缺节点会**如实写进 report**，绝不假装已生效。"
    )

    # ---------------------------------------------------------------- helpers
    @staticmethod
    def _resolve_lora(choice, preset):
        """决定用哪个 LoRA。返回 (文件名, 说明)。"""
        import re
        if choice and choice != "(自动挑)":
            return choice, ""
        try:
            loras = [str(x) for x in folder_paths.get_filename_list("loras")]
        except Exception:
            return None, "读不到 loras 目录"
        pat = (re.compile(r"lightning.*4steps?|4steps?.*lightning", re.I) if preset == "fast4"
               else re.compile(r"turbo8", re.I))
        hit = [f for f in loras if pat.search(f)]
        return (sorted(hit)[0], "") if hit else (None, f"loras 目录里没有匹配 {preset} 的 LoRA 文件")

    @staticmethod
    def _load_unet(unet_name, weight_dtype):
        """加载主模型。**优先复用 ComfyUI 的加载器节点**（见本文件顶部说明）。

        GGUF 走 `UnetLoaderGGUF`（第三方节点）；没装就**如实报错**，
        绝不拿 GGUF 去喂 UNETLoader（那只会加载失败）。
        """
        import nodes as comfy_nodes
        if str(unet_name).lower().endswith(".gguf"):
            if not available("UnetLoaderGGUF"):
                raise RuntimeError(
                    f"{unet_name} 是 GGUF 权重，但 ComfyUI 里没有 UnetLoaderGGUF 节点"
                    "（需装 ComfyUI-GGUF）—— 不会拿它去喂 UNETLoader，那只会加载失败")
            return comfy_nodes.NODE_CLASS_MAPPINGS["UnetLoaderGGUF"]().load_unet(unet_name)[0]
        return comfy_nodes.NODE_CLASS_MAPPINGS["UNETLoader"]().load_unet(unet_name, weight_dtype)[0]

    # ------------------------------------------------------------- 核心（可复用）
    def load_optimized(self, unet_name, precision, weight_dtype, clip_name, vae_name,
                       width, height, shift_preset,
                       apply_turbo_lora, lora_name, lora_strength,
                       apply_prefix_cache, cache_device, cache_dtype):
        """返回 `(model, clip, vae, preset, report)`。

        ⚠ **`preset` 是"最终实际生效"的档位**，不是用户填的那个 ——
          例如用户填 turbo8 但机器上没有 turbo8 LoRA 时，它会如实变成 `native`。
          一键出图节点必须**用它**来决定 steps/cfg，否则会出现
          "按 8 步采样却没有对应 LoRA" 的糊图（第一版就有这个 bug）。
        """
        import nodes as comfy_nodes
        rep = Report("【优化加载器】")

        # ① 精度档挑主模型
        chosen, why = pick_unet_by_tier(precision)
        if chosen:
            unet_name = chosen
            rep.ok(f"精度档 {precision} → 主模型 {chosen}{('（' + why + '）') if why else ''}")
        elif precision != "auto":
            rep.skip(f"精度档 {precision} 未生效：{why} → **已回落到你选的 {unet_name}**（不假装用上了）")

        # ② 加载三件套（全部走 ComfyUI 自己的加载器节点）
        model = self._load_unet(unet_name, weight_dtype)
        clip = comfy_nodes.NODE_CLASS_MAPPINGS["CLIPLoader"]().load_clip(clip_name, "qwen_image")[0]
        vae = comfy_nodes.NODE_CLASS_MAPPINGS["VAELoader"]().load_vae(vae_name)[0]

        # ③ 档位决定（auto：打算上 LoRA 才选 turbo 工作点）
        preset = shift_preset
        if preset == "auto":
            preset = "turbo8" if apply_turbo_lora else "native"

        # ④ turbo / fast4 LoRA
        if apply_turbo_lora and preset in ("turbo8", "fast4"):
            lora, why = self._resolve_lora(lora_name, preset)
            if lora:
                try:
                    model = comfy_nodes.NODE_CLASS_MAPPINGS["LoraLoaderModelOnly"]().load_lora_model_only(
                        model, lora, lora_strength)[0]
                    rep.ok(f"{preset} LoRA：{lora}（强度 {lora_strength}）")
                except Exception as exc:
                    rep.skip(f"LoRA 加载失败：{type(exc).__name__}: {exc}")
                    preset = "native"
            else:
                rep.skip(f"{preset} LoRA 未接上：{why} → **改按原生工作点**跑（steps 提到 25 / cfg 2.5）")
                preset = "native"
        elif preset in ("turbo8", "fast4"):
            rep.skip(f"按你的设置**没有**接 {preset} LoRA → **改按原生工作点**跑（steps 提到 25 / cfg 2.5）")
            preset = "native"

        # ⑤ 采样位移（只有 turbo8/fast4 需要；且**必须用真实宽高**算）
        if preset in ("turbo8", "fast4"):
            _, _, max_shift, base_shift = PRESET_WORKPOINT[preset]
            try:
                from comfy_extras.nodes_model_advanced import ModelSamplingFlux
                model = ModelSamplingFlux().patch(model, max_shift, base_shift,
                                                  int(width), int(height))[0]
                rep.ok(f"采样位移：max={max_shift} base={base_shift}（{preset} · {int(width)}×{int(height)}）")
            except Exception as exc:
                rep.skip(f"采样位移未接上：{type(exc).__name__}: {exc}（LoRA 与位移不配套会掉画质）")

        # ⑥ 前缀缓存（ComfyUI 自带）
        if apply_prefix_cache:
            if cache_device == "off":
                rep.skip("前缀缓存被你设成 off（每步重算前缀，更慢但可用来排查缓存问题）")
            else:
                new_model, err = call_patched_model(
                    "QwenImage21Cache", model, device=cache_device, dtype=cache_dtype)
                if new_model is not None:
                    model = new_model
                    rep.ok(f"前缀缓存：device={cache_device} dtype={cache_dtype}")
                else:
                    rep.skip(f"前缀缓存未接上：{err}（ComfyUI 版本可能偏旧）")

        steps, cfg, _, _ = PRESET_WORKPOINT.get(preset, PRESET_WORKPOINT["native"])
        rep.ok(f"最终档位 **{preset}** → 工作点 steps={steps} / cfg={cfg}")
        return model, clip, vae, preset, rep

    # ------------------------------------------------------------- 节点入口
    def load(self, unet_name, precision, weight_dtype, clip_name, vae_name,
             width, height, shift_preset,
             apply_turbo_lora, lora_name, lora_strength,
             apply_prefix_cache, cache_device, cache_dtype):
        model, clip, vae, _preset, rep = self.load_optimized(
            unet_name, precision, weight_dtype, clip_name, vae_name,
            width, height, shift_preset,
            apply_turbo_lora, lora_name, lora_strength,
            apply_prefix_cache, cache_device, cache_dtype)
        return (model, clip, vae, rep.render())
