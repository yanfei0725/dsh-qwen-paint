"""加速链：把一个 MODEL 依次接上可用的加速件。

⚠⚠ **互斥关系（最重要的一条，写在这里免得后人踩）**
   `QwenImage21BlockCacheT8` 要求**独占** `DIFFUSION_MODEL` wrapper；
   而 `TESpeedQwenImage21` 与 `QwenImage21Speedup` 也注册**同一组** wrapper。
   三者同时挂上，KSampler 会在 sample_wrapper 里直接抛 `ValueError`，**整单失败**。
   ⇒ 所以本节点**永远只挂其中一套**，另一套会写进 report 说明"已让位"。

   本节点的策略（与 DSH 版实测结论一致）：
     · 小尺寸（≈1024²）→ TE-Speed + Speedup 收益更好
     · 大尺寸（≥1408²）→ BlockCache T8 收益更好
     · `auto` 按像素数自动选
"""

from ._common import Report, available, call_patched_model

CATEGORY = "Qwen Image Optimized/加速"

# 自动选档的像素分界：≤ 该值走 TE+Speedup，> 该值走 BlockCache T8
AUTO_BLOCKCACHE_PIXELS = 1024 * 1024


class QwenImageAccelChain:
    """把加速件按**互斥规则**接到 MODEL 上，缺件自动跳过并如实说明。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "wrapper_mode": (["auto", "blockcache", "te_speedup", "none"], {"default": "auto"}),
                "width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "enable_rdna3_fa": ("BOOLEAN", {"default": True}),
                "enable_spectrum": ("BOOLEAN", {"default": False}),
                "enable_sada": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("model", "report")
    FUNCTION = "apply"
    CATEGORY = CATEGORY
    DESCRIPTION = (
        "按互斥规则接加速件：BlockCache T8 与 TE-Speed/Speedup 二选一（同时挂会整单失败），"
        "RDNA3 FlashAttention 可叠加；缺件跳过并如实说明。"
    )

    def apply(self, model, wrapper_mode, width, height,
              enable_rdna3_fa, enable_spectrum, enable_sada):
        rep = Report("【加速链】")

        # ── ① 选哪一套 wrapper（**互斥**，只挂一套）──
        mode = wrapper_mode
        if mode == "auto":
            pixels = max(1, int(width)) * max(1, int(height))
            mode = "blockcache" if pixels > AUTO_BLOCKCACHE_PIXELS else "te_speedup"
            rep.ok(f"auto 按尺寸选档：{width}×{height} = {pixels} 像素 → {mode}")

        if mode == "blockcache":
            new_model, err = call_patched_model(
                "QwenImage21BlockCacheT8", model,
                residual_diff_threshold=0.03, start_percent=0.1, end_percent=0.9,
                max_consecutive_hits=2, cache_device="cpu", metric_stride=8,
                max_cache_mb=1024, threshold_mode="two_stage",
                split_ratio=0.35, late_threshold=0.15)
            if new_model is not None:
                model = new_model
                rep.ok("BlockCache T8（大尺寸实测收益更好）")
                rep.skip("TE-Speed / Speedup **主动让位** —— 与 BlockCache 争抢同一组 wrapper，同时挂会整单失败")
            else:
                rep.skip(f"BlockCache T8 未接上：{err} → **回落到 TE-Speed + Speedup**")
                mode = "te_speedup"

        if mode == "te_speedup":
            te_model, err = call_patched_model(
                "TESpeedQwenImage21", model,
                attention="kitchen_int8", step_cache="te_predictor",
                reuse_threshold=0.06, start_percent=0.0, end_percent=1.0,
                predictor_error_limit=0.08, verbose=False)
            if te_model is not None:
                model = te_model
                rep.ok("TE-Speed（每跳最多 1 步连续跳过）")
            else:
                rep.skip(f"TE-Speed 未接上：{err}")

            sp_model, err2 = call_patched_model(
                "QwenImage21Speedup", model,
                enable_cache=True, cache_threshold=0.30, target_error=0.05,
                cache_start_percent=0.15, cache_end_percent=0.90,
                max_consecutive_skips=3, forecast="first",
                cache_device="auto", debug_log=False)
            if sp_model is not None:
                model = sp_model
                rep.ok("QwenImage21Speedup（整步残差缓存）")
            else:
                rep.skip(f"Speedup 未接上：{err2}")

        if mode == "none":
            rep.ok("按你的设置**不接任何 wrapper 加速件**")

        # ── ② RDNA3 FlashAttention（**可叠加**，与上面三者不冲突）──
        if enable_rdna3_fa:
            if available("ApplyRDNA3FlashAttention"):
                fa_model, err = call_patched_model("ApplyRDNA3FlashAttention", model)
                if fa_model is not None:
                    model = fa_model
                    rep.ok("RDNA3 FlashAttention（无损；只对 RDNA3/gfx1100 生效，节点自带回退）")
                else:
                    rep.skip(f"RDNA3 FlashAttention 未接上：{err}")
            else:
                rep.skip("未安装 ApplyRDNA3FlashAttention（非 RDNA3 显卡用不上，跳过是对的）")

        # ── ③ 两个**默认关**的实验档 ──
        if enable_spectrum:
            sp, err = call_patched_model(
                "QwenSpectrumModelPatcher", model,
                warmup_steps=2, tail_actual_steps=1, history_points=5,
                chebyshev_degree=3, max_consecutive_forecasts=1, ridge_lambda=1e-4)
            if sp is not None:
                model = sp
                rep.ok("Spectrum 跳步（**实验性**；8 步链上 warmup+tail 会吃掉大半步数，画质风险自负）")
            else:
                rep.skip(f"Spectrum 未接上：{err}")
        if enable_sada:
            sa, err = call_patched_model("QwenImage21SADA", model)
            if sa is not None:
                model = sa
                rep.ok("SADA 跳步（**实验性**）")
            else:
                rep.skip(f"SADA 未接上：{err}（节点未装或本版输入名不匹配）")

        return (model, rep.render())
