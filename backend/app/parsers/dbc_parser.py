"""DBC 解析:基于 cantools。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Union

import cantools


def _detect_encoding(raw: bytes) -> str:
    """检测 DBC 文本编码:UTF-8 → GBK → GB18030 → latin-1。

    不能靠 cantools 抛错回退(GBK 字节可能被宽松解码成乱码而不报错),
    须用 strict 解码主动检测:GBK 双字节中文字符序列必然无法通过 UTF-8 严格校验。
    """
    for enc in ("utf-8", "gbk", "gb18030", "latin-1"):
        try:
            raw.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    return "utf-8"


@lru_cache(maxsize=32)
def _load_cached(path_str: str, encoding: str):
    return cantools.database.load_file(path_str, encoding=encoding)


def load_database(path: Union[str, Path]):
    """加载 DBC 数据库,自动检测编码(支持 UTF-8 / GBK / GB18030),带缓存。"""
    p = Path(path)
    try:
        enc = _detect_encoding(p.read_bytes())
        return _load_cached(str(p), enc)
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
