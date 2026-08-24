"""全局任务进度:大文件解析(stats/索引构建)期间记录进度,前端轮询展示。"""
import threading
from typing import Optional

_lock = threading.Lock()
_PROGRESS: dict[str, dict] = {}


def set_progress(key: str, stage: Optional[str] = None, progress: Optional[float] = None) -> None:
    """更新任务进度(0.0~1.0)。key 通常为 'stats:<file>' / 'index:<file>'。"""
    with _lock:
        e = _PROGRESS.setdefault(key, {"stage": "处理中", "progress": 0.0})
        if stage:
            e["stage"] = stage
        if progress is not None:
            e["progress"] = max(0.0, min(0.99, progress))   # 保留 0.99 上限,完成即清除


def clear_progress(key: str) -> None:
    with _lock:
        _PROGRESS.pop(key, None)


def snapshot() -> dict:
    with _lock:
        return dict(_PROGRESS)
