"""信号解码:BLF × DBC → 物理值时间序列。"""
from __future__ import annotations

from typing import Optional

import can


def decode_signal(path, db, frame_id: int, signal_name: str,
                  start: Optional[float] = None, end: Optional[float] = None,
                  max_points: Optional[int] = None,
                  channel: Optional[int] = None) -> dict:
    """流式解码单个信号,返回 {times, values},支持时间区间/通道过滤与降采样。"""
    times: list[float] = []
    values: list[float] = []

    for msg in can.BLFReader(str(path)):
        if msg.arbitration_id != frame_id:
            continue
        if channel is not None and getattr(msg, "channel", 0) != channel:
            continue
        if start is not None and msg.timestamp < start:
            continue
        if end is not None and msg.timestamp > end:
            continue
        try:
            decoded = db.decode_message(msg.arbitration_id, msg.data)
        except Exception:
            continue
        if signal_name in decoded:
            times.append(msg.timestamp)
            values.append(decoded[signal_name])

    # 均匀降采样,控制返回体积
    if max_points and len(times) > max_points > 0:
        step = (len(times) - 1) / (max_points - 1)
        idx = sorted({round(i * step) for i in range(max_points)})
        times = [times[i] for i in idx]
        values = [values[i] for i in idx]

    return {
        "frame_id": frame_id,
        "frame_id_hex": hex(frame_id),
        "signal": signal_name,
        "channel": channel,
        "points": len(times),
        "times": times,
        "values": values,
    }
