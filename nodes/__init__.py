"""qwen-image-optimized · 节点实现包。

拆成几个文件是为了**职责清晰**，不是为了好看：
  · `_common.py`  —— 档位定义、文件探测、跨代节点调用（所有节点共用，**只此一份**）
  · `loader.py`    —— 优化加载器（精度档 / LoRA / 位移 / 前缀缓存）
  · `accel.py`     —— 加速链（互斥规则在这里）
  · `decode.py`    —— 分块解码 + OOM 回退
  · `controlnet.py`—— ControlNet 施加
  · `oneclick.py`  —— 一键出图（**复用上面四个**，不另写一套）
"""

from .accel import QwenImageAccelChain
from .controlnet import QwenImageControlNetApply
from .decode import QwenImageTiledDecode
from .loader import QwenImageOptimizedLoader
from .oneclick import QwenImageOneClick

__all__ = [
    "QwenImageOptimizedLoader",
    "QwenImageAccelChain",
    "QwenImageTiledDecode",
    "QwenImageControlNetApply",
    "QwenImageOneClick",
]
