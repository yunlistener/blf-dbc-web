"""全局配置:路径、常量。"""
from pathlib import Path

# backend/app/config.py -> 项目根
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOAD_DIR = PROJECT_ROOT / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".blf", ".dbc"}
