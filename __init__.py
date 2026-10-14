"""qwen-image-optimized —— 千问 2.1 优化节点包（ComfyUI 自定义节点）。

**不依赖 DSH** —— 直接装进 ComfyUI 的 `custom_nodes/` 即可用。

## 包内节点
| 节点 | 作用 |
| --- | --- |
| `QwenImageOptimizedLoader` | 优化加载器：精度档选型 + turbo LoRA + 采样位移 + 前缀缓存 |
| `QwenImageAccelChain` | 加速链：BlockCache / TE-Speed / Speedup / RDNA3-FA（按互斥规则） |
| `QwenImageTiledDecode` | 分块 VAE 解码 + 显存不足自动回退 |
| `QwenImageControlNetApply` | ControlNet 加载 + 施加（结构约束） |
| `QwenImageOneClick` | 一键出图：填 prompt 就出图（内部复用上面四个） |

## 设计原则（三条，都是踩坑换来的）
1. **绝不挂一个不存在的节点** —— ComfyUI 遇到未知 `class_type` 会**整单拒收**，
   所以加速件一律先探测、缺了就跳过。
2. **跳过必须留痕** —— 每个节点都输出 `report`，如实写明接了什么、跳过了什么、为什么。
3. **绝不假装成功** —— 文件不在就说不在，节点没装就说没装。

⚠ **本包不下载任何权重、不装任何第三方节点。** 缺什么会在 `report` 里告诉你缺什么。
"""

from .nodes.accel import QwenImageAccelChain
from .nodes.controlnet import QwenImageControlNetApply
from .nodes.decode import QwenImageTiledDecode
from .nodes.loader import QwenImageOptimizedLoader
from .nodes.oneclick import QwenImageOneClick

NODE_CLASS_MAPPINGS = {
    "QwenImageOptimizedLoader": QwenImageOptimizedLoader,
    "QwenImageAccelChain": QwenImageAccelChain,
    "QwenImageTiledDecode": QwenImageTiledDecode,
    "QwenImageControlNetApply": QwenImageControlNetApply,
    "QwenImageOneClick": QwenImageOneClick,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "QwenImageOptimizedLoader": "千问 2.1 优化加载器 (Qwen Image Optimized Loader)",
    "QwenImageAccelChain": "千问 2.1 加速链 (Qwen Image Accel Chain)",
    "QwenImageTiledDecode": "千问 2.1 分块解码 (Qwen Image Tiled Decode)",
    "QwenImageControlNetApply": "千问 2.1 ControlNet (Qwen Image ControlNet)",
    "QwenImageOneClick": "千问 2.1 一键出图 (Qwen Image One-Click)",
}

# ⚠ 本包**没有**前端资源（无 js/css），所以**不声明** `WEB_DIRECTORY` ——
#   声明一个不存在的目录会让 ComfyUI 打警告，属于"自己给自己找麻烦"。
#   节点全靠标准 widget，无需前端代码。

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
