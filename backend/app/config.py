"""全局配置:路径、常量。"""
from pathlib import Path

# backend/app/config.py -> 项目根
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOAD_DIR = PROJECT_ROOT / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 允许上传的扩展名(实际类型按内容魔数识别:BLF 头 "LOGG" / DBC 文本特征)
ALLOWED_EXTENSIONS = {".blf", ".dbc", ".log", ".txt"}
