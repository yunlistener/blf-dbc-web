"""信号解码:BLF × DBC → 物理值时间序列。"""
from __future__ import annotations

from typing import Optional

from app.services.blf_cache import get_frames


def decode_signal(path, db, frame_id: int, signal_name: str,
                  start: Optional[float] = None, end: Optional[float] = None,
                  max_points: Optional[int] = None,
                  channel: Optional[int] = None) -> dict:
    """解码单个信号(走帧缓存,不重复全扫),返回 {times, values}。"""
    times: list[float] = []
    values: list[float] = []

    for _ts, _ch, data, _is_fd, _dlc in get_frames(path, frame_id, channel=channel, start=start, end=end):
        try:
            decoded = db.decode_message(frame_id, data)
        except Exception:
            continue
        if signal_name in decoded:
            times.append(_ts)
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
