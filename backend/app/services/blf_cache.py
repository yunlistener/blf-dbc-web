"""BLF 帧缓存:首次全扫后缓存 {frame_id: [(ts, channel, data), ...]} 索引,
避免 decode/frames/export 每次全文件重扫。LRU 容量限制 + 文件 mtime/size 校验。"""
from __future__ import annotations

import threading
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Optional

import can

# 缓存上限:最多缓存 MAX_FILES 个文件 / MAX_FRAMES 总帧数(约 1GB 内存预算内的安全值)
MAX_FILES = 4
MAX_FRAMES = 2_000_000

_cache: "OrderedDict[str, tuple[dict, tuple, int]]" = OrderedDict()
# path -> (index, (size, mtime_ns), frames)
_lock = threading.Lock()


def _build_index(path: Path) -> tuple[dict, int]:
    """全扫 BLF,构建 {frame_id: [(ts, channel, data, is_fd, dlc), ...]}。"""
    idx: dict[int, list] = defaultdict(list)
    n = 0
    for m in can.BLFReader(str(path)):
        idx[m.arbitration_id].append((
            m.timestamp,
            getattr(m, "channel", 0),
            m.data,
            bool(getattr(m, "is_fd", False)),
            m.dlc,
        ))
        n += 1
    return dict(idx), n


def get_frames_index(path: Path) -> dict:
    """返回 {frame_id: [(ts, channel, data), ...]} 索引(命中缓存或全扫构建)。"""
    key = str(path)
    st = path.stat()
    sig = (st.st_size, st.st_mtime_ns)

    with _lock:
        hit = _cache.get(key)
        if hit and hit[1] == sig:
            _cache.move_to_end(key)   # LRU 刷新
            return hit[0]

    idx, n = _build_index(path)
    with _lock:
        _cache[key] = (idx, sig, n)
        _cache.move_to_end(key)
        # LRU 淘汰:超文件数或总帧数
        while len(_cache) > MAX_FILES:
            _cache.popitem(last=False)
        total = sum(v[2] for v in _cache.values())
        while total > MAX_FRAMES and len(_cache) > 1:
            _, (_, _, popped) = _cache.popitem(last=False)
            total -= popped
    return idx


def get_frames(path: Path, frame_id: int,
               channel: Optional[int] = None,
               start: Optional[float] = None,
               end: Optional[float] = None) -> list:
    """从缓存取某报文的帧列表,按通道/时间过滤。"""
    idx = get_frames_index(path)
    rows = idx.get(frame_id, [])
    if channel is None and start is None and end is None:
        return rows
    out = []
    for row in rows:
        ts, ch, data, is_fd, dlc = row
        if channel is not None and ch != channel:
            continue
        if start is not None and ts < start:
            continue
        if end is not None and ts > end:
            continue
        out.append(row)
    return out


def invalidate(path: Path):
    with _lock:
        _cache.pop(str(path), None)
