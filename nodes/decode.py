"""分块 VAE 解码 + 显存不足自动回退。

## 为什么需要
千问的 VAE 内部会跑 fp32，**大图整图解码时显存峰值会失控**（这不是猜测：
DSH 版在大尺寸上实测到过解码阶段 OOM）。ComfyUI 自带的 `VAEDecodeTiled`
把图切块解码，能显著压低峰值。

## 策略
  · `auto`   —— 小图用普通解码（更快、无接缝），大图直接走分块；
  · `always` —— 一律分块；
  · `never`  —— 一律普通（用于排查"接缝是不是分块造成的"）。
  · 另外：普通解码**真的 OOM** 时，本节点会自动改用分块重试一次 —— 而不是把整单打挂。
"""

from ._common import Report

CATEGORY = "Qwen Image Optimized/解码"

# auto 档的分界：超过这个像素数就直接分块（≈1024² 以上）
AUTO_TILE_PIXELS = 1024 * 1024

_OOM_HINTS = ("out of memory", "outofmemory", "hip error", "cuda error", "memory allocation")


def looks_like_oom(exc):
    """是不是显存不足类错误。

    ⚠ **宁松勿漏**：宁可把别的错也当成 OOM 去试一次分块（最坏是多花一次时间），
      也不要把真的 OOM 当成普通错误直接失败。
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(h in text for h in _OOM_HINTS)


class QwenImageTiledDecode:
    """解码 LATENT → IMAGE；大图走分块，OOM 自动回退。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "vae": ("VAE",),
                "mode": (["auto", "always", "never"], {"default": "auto"}),
                "tile_size": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 32}),
                "overlap": ("INT", {"default": 64, "min": 0, "max": 4096, "step": 32}),
                "fallback_on_oom": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "report")
    FUNCTION = "decode"
    CATEGORY = CATEGORY
    DESCRIPTION = "分块 VAE 解码（防大图 OOM）；普通解码真的 OOM 时会自动改用分块重试一次。"

    # ------------------------------------------------------------------ utils
    @staticmethod
    def _pixels_of(samples):
        """从 latent 形状推算出图像素数（千问 VAE 空间下采样 8 倍）。"""
        try:
            s = samples["samples"]
            return int(s.shape[-1]) * 8 * int(s.shape[-2]) * 8
        except Exception:
            return 0

    @staticmethod
    def _tiled(vae, samples, tile_size, overlap):
        from nodes import VAEDecodeTiled
        return VAEDecodeTiled().decode(samples, vae, tile_size, overlap, 64, 8)[0]

    @staticmethod
    def _plain(vae, samples):
        from nodes import VAEDecode
        return VAEDecode().decode(samples, vae)[0]

    # ------------------------------------------------------------------ 主流程
    def decode(self, samples, vae, mode, tile_size, overlap, fallback_on_oom):
        rep = Report("【解码】")
        pixels = self._pixels_of(samples)

        use_tiled = mode == "always" or (mode == "auto" and pixels > AUTO_TILE_PIXELS)
        if mode == "never":
            rep.ok("按你的设置**强制普通解码**（分块接缝有疑问时用它排查）")
        elif use_tiled:
            rep.ok(f"分块解码（{pixels} 像素 > {AUTO_TILE_PIXELS}；tile={tile_size} overlap={overlap}）")
        else:
            rep.ok(f"普通解码（{pixels} 像素较小，整图解码更快且无接缝）")

        if use_tiled:
            try:
                return (self._tiled(vae, samples, tile_size, overlap), rep.render())
            except Exception as exc:
                rep.skip(f"分块解码失败：{type(exc).__name__}: {exc} → 回退普通解码")
                return (self._plain(vae, samples), rep.render())

        try:
            return (self._plain(vae, samples), rep.render())
        except Exception as exc:
            if fallback_on_oom and looks_like_oom(exc):
                rep.skip(f"普通解码**显存不足** → 自动改用分块重试（tile={tile_size}）")
                return (self._tiled(vae, samples, tile_size, overlap), rep.render())
            raise
