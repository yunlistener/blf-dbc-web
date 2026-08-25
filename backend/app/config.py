"""全局配置:路径、常量。"""
import os
from pathlib import Path

# backend/app/config.py -> 项目根
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOAD_DIR = PROJECT_ROOT / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR = PROJECT_ROOT / "data" / "cache"     # BLF 索引磁盘缓存(紧凑二进制 pickle)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# 允许上传的扩展名(实际类型按内容魔数识别:BLF 头 "LOGG" / DBC 文本特征)
ALLOWED_EXTENSIONS = {".blf", ".dbc", ".log", ".txt"}

# 实时环形缓冲全局帧数上限(内存封顶):桌面默认 800 万帧(~1.1GB,101MB 文件不裁剪,
# 构建中播放全程边扫边播);树莓派等低内存部署调小(如 BLF_MAX_TOTAL=1000000 → ~140MB)
MAX_TOTAL_FRAMES = int(os.environ.get("BLF_MAX_TOTAL", "8000000"))
