"""管理接口:强制重启后台服务。"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter

from app.services.progress import snapshot

router = APIRouter()

BACKEND_DIR = Path(__file__).resolve().parents[2]   # backend/(admin.py 在 backend/app/api/ 下)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "8000")


@router.get("/progress")
def get_progress():
    """当前正在处理的任务进度(大文件解析时前端轮询)。"""
    return {"progress": snapshot()}


@router.post("/clear-cache")
def clear_cache():
    """清空 BLF 索引磁盘缓存 + 内存缓存(测试/重新构建用)。返回删除数量。"""
    from app.config import CACHE_DIR
    from app.services import blf_cache

    with blf_cache._lock:
        blf_cache._mem.clear()
        blf_cache._building.clear()
    blf_cache.live_store.clear()   # ⚠️ 内存环形缓冲也清(旧文件帧残留会污染相对时间/混合数据)
    n = 0
    if CACHE_DIR.is_dir():
        for f in CACHE_DIR.glob("*.idx"):
            try:
                f.unlink()
                n += 1
            except OSError:
                pass
    return {"cleared": n, "cache_dir": str(CACHE_DIR)}


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
            proc = subprocess.Popen(
                cmd, cwd=str(BACKEND_DIR),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,   # 独立会话,防被父进程组信号连带终止
            )
            print(f"[admin] restart spawned pid={proc.pid}")
        except Exception as e:
            print(f"[admin] restart Popen failed: {e}")
            return
        os._exit(0)   # 旧进程退出,让出端口

    threading.Thread(target=_do_restart, daemon=True).start()
    return {"status": "restarting", "cmd": " ".join(cmd)}
