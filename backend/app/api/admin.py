"""管理接口:强制重启后台服务。"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()

BACKEND_DIR = Path(__file__).resolve().parents[1]   # backend/
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "8000")


@router.post("/restart")
def restart_server():
    """重启 uvicorn 进程(Windows/Linux 通用):延时 1s 启动新进程替换自己。

    用 sys.executable(uv 虚拟环境的解释器)启动,工作目录=backend(保证 app.main 可导入)。
    新进程启动前旧进程已退出,避免端口占用。"""
    cmd = [sys.executable, "-m", "uvicorn", "app.main:app",
           "--host", HOST, "--port", PORT]

    def _do_restart():
        time.sleep(1.0)
        try:
            subprocess.Popen(cmd, cwd=str(BACKEND_DIR))
        except Exception:
            pass
        os._exit(0)   # 旧进程退出,让出端口

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"status": "restarting", "cmd": " ".join(cmd)}
