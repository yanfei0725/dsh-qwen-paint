"""优化加载器：一次把 unet / clip / vae 装好，并把「精度档 / turbo LoRA / 采样位移 / 前缀缓存」接上。

这是一个**加速器**节点 —— 你把它插在工作流最前面，后面照常接
`TextEncodeQwenImage21` → `KSampler` → 解码即可。
"""

import torch

import comfy.sd
import folder_paths

from ._common import (
    PRESET_WORKPOINT,
    PRECISION_TIERS,
    SHIFT_PRESETS,
    Report,
    call_patched_model,
    pick_unet_by_tier,
)

CATEGORY = "Qwen Image Optimized/加载"


class QwenImageOptimizedLoader:
    """把千问 2.1 的加载 + 常用加速件合成一个节点。

    做四件事（每件都可单独关掉，且**关/缺都会写进 report**）：
      1. 按**精度档**挑主模型（bf16 / fp8 / int8 / gguf），挑不到就**如实回落**；
      2. 可选接 **turbo8 / fast4 蒸馏 LoRA**（提速的主力）；
      3. 按档位补上**采样位移**（`ModelSamplingFlux`）—— 位移与 LoRA 必须配套，
         拿错位移会明显掉画质（DSH 版实测过：用错位移会糊、五官走形）；
      4. 可选接 **QwenImage21Cache 前缀缓存**（ComfyUI 自带，无损/近无损）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unet_name": (folder_paths.get_filename_list("diffusion_models"),),
                "precision": (PRECISION_TIERS, {"default": "auto"}),
                "clip_name": (folder_paths.get_filename_list("text_encoders"),),
                "vae_name": (folder_paths.get_filename_list("vae"),),
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
        if choice and choice != "(自动挑)":
            return choice, ""
        try:
            loras = [str(x) for x in folder_paths.get_filename_list("loras")]
        except Exception:
            return None, "读不到 loras 目录"
        import re
        if preset == "fast4":
            pat = re.compile(r"lightning.*4steps?|4steps?.*lightning", re.I)
        else:
            pat = re.compile(r"turbo8", re.I)
        hit = [f for f in loras if pat.search(f)]
        if hit:
            return sorted(hit)[0], ""
        return None, f"loras 目录里没有匹配 {preset} 的 LoRA 文件"

    # ---------------------------------------------------------------- 主流程
    def load(self, unet_name, precision, clip_name, vae_name, shift_preset,
             apply_turbo_lora, lora_name, lora_strength,
             apply_prefix_cache, cache_device, cache_dtype):
        rep = Report("【优化加载器】")

        # ① 精度档挑主模型
        chosen, why = pick_unet_by_tier(precision)
        if chosen:
            unet_name = chosen
            rep.ok(f"精度档 {precision} → 主模型 {chosen}{('（' + why + '）') if why else ''}")
        elif precision != "auto":
            rep.skip(f"精度档 {precision} 未生效：{why} → **已回落到你选的 {unet_name}**（不假装用上了）")

        # ② 加载 unet
        unet_path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)
        model = comfy.sd.load_diffusion_model(unet_path)

        # ③ 加载 clip（qwen_image 类型）
        clip_path = folder_paths.get_full_path_or_raise("text_encoders", clip_name)
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=comfy.sd.CLIPType.QWEN_IMAGE,
        )

        # ④ 加载 vae
        vae_path = folder_paths.get_full_path_or_raise("vae", vae_name)
        vae = comfy.sd.load_vae(vae_path)

        # ⑤ 采样位移档 —— 决定 steps/cfg 的工作点，也决定要不要接 LoRA
        preset = shift_preset
        if preset == "auto":
            # 自动：有 turbo8 LoRA 就用 turbo8 工作点；否则走原生
            preset = "turbo8" if apply_turbo_lora else "native"

        # ⑥ turbo / fast4 LoRA
        if apply_turbo_lora and preset in ("turbo8", "fast4"):
            lora, why = self._resolve_lora(lora_name, preset)
            if lora:
                try:
                    from nodes import LoraLoaderModelOnly
                    model = LoraLoaderModelOnly().load_lora_model_only(model, lora, lora_strength)[0]
                    rep.ok(f"{preset} LoRA：{lora}（强度 {lora_strength}）")
                except Exception as exc:
                    rep.skip(f"LoRA 加载失败：{type(exc).__name__}: {exc}")
            else:
                rep.skip(f"{preset} LoRA 未接上：{why}（本次按**原生工作点**跑，请把 steps 提到 25 / cfg 2.5）")
                preset = "native"
        elif preset in ("turbo8", "fast4"):
            rep.skip(f"按你的设置**没有**接 {preset} LoRA → 本次按**原生工作点**跑，请把 steps 提到 25 / cfg 2.5")
            preset = "native"

        # ⑦ 采样位移（只有 turbo8/fast4 才需要；原生档由模型自带配置决定，不覆盖）
        if preset in ("turbo8", "fast4"):
            _, _, max_shift, base_shift = PRESET_WORKPOINT[preset]
            try:
                from comfy_extras.nodes_model_advanced import ModelSamplingFlux
                model = ModelSamplingFlux().patch(model, max_shift, base_shift, 1024, 1024)[0]
                rep.ok(f"采样位移：max_shift={max_shift} base_shift={base_shift}（{preset} 工作点）")
            except Exception as exc:
                rep.skip(f"采样位移未接上：{type(exc).__name__}: {exc}（LoRA 与位移不配套会掉画质）")

        # ⑧ 前缀缓存（ComfyUI 自带，无损/近无损）
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
        rep.ok(f"建议工作点：steps={steps} / cfg={cfg}（档位 {preset}）")
        return (model, clip, vae, rep.render())
