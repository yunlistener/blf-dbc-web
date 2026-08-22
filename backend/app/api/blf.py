"""BLF API:统计 / 信号解码。"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from app.config import UPLOAD_DIR
from app.parsers.blf_parser import stats as blf_stats
from app.parsers.dbc_parser import load_database
from app.services.decoder import decode_signal

router = APIRouter()


def _blf_path(name: str) -> Path:
    path = UPLOAD_DIR / name
    if not path.is_file() or path.suffix.lower() != ".blf":
        raise HTTPException(404, f"BLF 文件不存在: {name}")
    return path


@router.get("/{name}/stats")
def get_stats(name: str):
    try:
        return blf_stats(_blf_path(name))
    except Exception as e:
        raise HTTPException(422, f"BLF 解析失败: {e}")


@router.get("/{name}/decode")
def get_decode(name: str, dbc: str, frame_id: str, signal: str,
               start: Optional[float] = None, end: Optional[float] = None,
               max_points: Optional[int] = None):
    blf_path = _blf_path(name)
    dbc_path = UPLOAD_DIR / dbc
    if not dbc_path.is_file():
        raise HTTPException(404, f"DBC 文件不存在: {dbc}")

    try:
        fid = int(frame_id, 0)
    except ValueError:
        raise HTTPException(422, f"非法报文 ID: {frame_id}")

    try:
        db = load_database(dbc_path)
        msg = db.get_message_by_frame_id(fid)
    except (KeyError, ValueError):
        msg = None
    if msg is None:
        raise HTTPException(404, f"DBC 中无报文 {hex(fid)}")
    if not any(s.name == signal for s in msg.signals):
        raise HTTPException(404, f"报文 {hex(fid)} 无信号 {signal}")

    result = decode_signal(blf_path, db, fid, signal, start, end, max_points)
    if not result["times"]:
        raise HTTPException(404, f"BLF 中未解码到信号 {signal} 的数据(检查时间区间)")
    return result
