"""BLF 解析:流式统计,不把整个文件读入内存。"""
from __future__ import annotations

from pathlib import Path
from typing import Union

import can


def stats(path: Union[str, Path]) -> dict:
    """单遍扫描 BLF,返回帧数/时间范围/错误帧/按 ID 聚合统计/通道分布。"""
    by_id: dict[int, dict] = {}
    channels: dict[int, int] = {}
    total = fd = error = remote = 0
    first_ts = last_ts = None

    for msg in can.BLFReader(str(path)):
        ts = msg.timestamp
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        total += 1

        ch = getattr(msg, "channel", 0)
        channels[ch] = channels.get(ch, 0) + 1

        if getattr(msg, "is_error_frame", False):
            error += 1
            continue
        if getattr(msg, "is_fd", False):
            fd += 1
        if getattr(msg, "is_remote_frame", False):
            remote += 1

        aid = msg.arbitration_id
        e = by_id.setdefault(aid, {"frame_id": aid, "count": 0,
                                   "first": ts, "last": ts, "dlc": 0})
        e["count"] += 1
        e["dlc"] = max(e["dlc"], getattr(msg, "dlc", 0))
        if ts < e["first"]:
            e["first"] = ts
        if ts > e["last"]:
            e["last"] = ts

    ids = sorted(by_id.values(), key=lambda x: -x["count"])
    for e in ids:
        span = e["last"] - e["first"]
        e["duration_s"] = round(span, 4)
        e["rate_hz"] = round(e["count"] / span, 2) if span > 0 else None

    return {
        "file": Path(path).name,
        "total_frames": total,
        "fd_frames": fd,
        "error_frames": error,
        "remote_frames": remote,
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "duration_s": round(last_ts - first_ts, 4) if first_ts is not None else 0.0,
        "unique_ids": len(ids),
        "channels": [{"channel": ch, "frames": n} for ch, n in sorted(channels.items())],
        "by_id": ids,
    }
