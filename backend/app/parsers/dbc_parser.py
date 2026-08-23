"""DBC 解析:基于 cantools。"""
from __future__ import annotations

from pathlib import Path
from typing import Union

import cantools


def load_database(path: Union[str, Path]):
    """加载 DBC 数据库,失败抛 ValueError。"""
    try:
        return cantools.database.load_file(str(path))
    except Exception as e:
        raise ValueError(f"DBC 解析失败: {e}") from e


def messages_summary(db) -> list[dict]:
    """所有报文及其信号摘要(按 ID 排序)。"""
    out = []
    for msg in sorted(db.messages, key=lambda m: m.frame_id):
        out.append({
            "frame_id": msg.frame_id,
            "frame_id_hex": hex(msg.frame_id),
            "name": msg.name,
            "length": msg.length,
            "cycle_time": msg.cycle_time,
            "is_extended": msg.is_extended_frame,
            "senders": list(getattr(msg, "senders", []) or []),
            "signals": [s.name for s in msg.signals],
            "signal_count": len(msg.signals),
        })
    return out


def message_detail(db, frame_id: int) -> dict | None:
    """单个报文的信号详情(起始位/长度/缩放/偏移/单位/值表)。"""
    for msg in db.messages:
        if msg.frame_id == frame_id:
            return {
                "frame_id": msg.frame_id,
                "frame_id_hex": hex(msg.frame_id),
                "name": msg.name,
                "length": msg.length,
                "cycle_time": msg.cycle_time,
                "is_extended": msg.is_extended_frame,
                "senders": list(getattr(msg, "senders", []) or []),
                "signals": [
                    {
                        "name": s.name,
                        "start_bit": s.start,
                        "length_bits": s.length,
                        "byte_order": s.byte_order,
                        "scale": s.scale,
                        "offset": s.offset,
                        "minimum": s.minimum,
                        "maximum": s.maximum,
                        "unit": s.unit,
                        "comment": getattr(s, "comment", None),
                        "choices": s.choices,
                    }
                    for s in msg.signals
                ],
            }
    return None
