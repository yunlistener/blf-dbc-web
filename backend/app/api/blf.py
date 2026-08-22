"""BLF API:统计 / 信号解码 / 帧列表 / CSV 导出。"""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Optional

import can
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.config import UPLOAD_DIR
from app.parsers.blf_parser import stats as blf_stats
from app.parsers.dbc_parser import load_database
from app.services.decoder import decode_signal
from app.api.config_api import _load as load_config

router = APIRouter()


def _blf_path(name: str) -> Path:
    path = UPLOAD_DIR / name
    if not path.is_file() or path.suffix.lower() != ".blf":
        raise HTTPException(404, f"BLF 文件不存在: {name}")
    return path


def _resolve_dbc(dbc: Optional[str], channel: Optional[int]) -> str:
    """解析 DBC 文件名:显式传入优先;否则用该通道的映射配置;再否则用默认 dbc。"""
    if dbc is None and channel is not None:
        dbc = load_config().get("channels", {}).get(str(channel))
    if dbc is None:
        dbc = load_config().get("dbc")
    if not dbc:
        raise HTTPException(422,
            f"通道 {channel} 未配置 DBC,请先在配置抽屉中设置")
    path = UPLOAD_DIR / dbc
    if not path.is_file():
        raise HTTPException(404, f"DBC 文件不存在: {dbc}")
    return dbc


@router.get("/{name}/stats")
def get_stats(name: str):
    try:
        return blf_stats(_blf_path(name))
    except Exception as e:
        raise HTTPException(422, f"BLF 解析失败: {e}")


@router.get("/{name}/decode")
def get_decode(name: str, dbc: Optional[str] = None, frame_id: str = "",
               signal: str = "", channel: Optional[int] = None,
               start: Optional[float] = None, end: Optional[float] = None,
               max_points: Optional[int] = None):
    blf_path = _blf_path(name)
    dbc_name = _resolve_dbc(dbc, channel)
    dbc_path = UPLOAD_DIR / dbc_name

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

    result = decode_signal(blf_path, db, fid, signal, start, end, max_points,
                           channel=channel)
    if not result["times"]:
        raise HTTPException(404, f"BLF 中未解码到信号 {signal} 的数据(检查通道/时间区间)")
    return result


@router.get("/{name}/frames")
def get_frames(name: str, dbc: Optional[str] = None, frame_id: str = "",
               channel: Optional[int] = None,
               start: Optional[float] = None, end: Optional[float] = None,
               limit: int = 200, offset: int = 0,
               decode: bool = False):
    """Trace 帧列表:分页返回该报文的原始帧(时间戳/ID/DLC/数据/解码值)。"""
    if limit > 1000:
        raise HTTPException(422, "limit 最大 1000")
    blf_path = _blf_path(name)
    dbc_name = _resolve_dbc(dbc, channel)
    dbc_path = UPLOAD_DIR / dbc_name

    try:
        fid = int(frame_id, 0)
        db = load_database(dbc_path)
        msg = db.get_message_by_frame_id(fid)
    except (KeyError, ValueError):
        msg = None
    if msg is None:
        raise HTTPException(404, f"DBC 中无报文 {hex(fid)}")

    frames = []
    skipped = 0
    for m in can.BLFReader(str(blf_path)):
        if m.arbitration_id != fid:
            continue
        if channel is not None and getattr(m, "channel", 0) != channel:
            continue
        if start is not None and m.timestamp < start:
            continue
        if end is not None and m.timestamp > end:
            continue
        if skipped < offset:
            skipped += 1
            continue
        if len(frames) >= limit:
            break
        row = {
            "timestamp": round(m.timestamp, 6),
            "id": fid,
            "id_hex": hex(fid),
            "name": msg.name,
            "dlc": m.dlc,
            "data": m.data.hex(" ").upper() if m.data else "",
            "is_fd": bool(getattr(m, "is_fd", False)),
            "channel": getattr(m, "channel", 0),
        }
        if decode:
            try:
                row["decoded"] = db.decode_message(fid, m.data)
            except Exception:
                row["decoded"] = None
        frames.append(row)
    return {"name": msg.name, "channel": channel, "offset": offset,
            "limit": limit, "returned": len(frames), "frames": frames}


@router.get("/{name}/export")
def export_csv(name: str, dbc: Optional[str] = None, frame_id: str = "",
               signal: Optional[str] = None, channel: Optional[int] = None,
               start: Optional[float] = None, end: Optional[float] = None):
    """导出 CSV:时间 + 指定报文的一个/全部信号(同报文信号共享时间戳)。"""
    blf_path = _blf_path(name)
    dbc_name = _resolve_dbc(dbc, channel)
    dbc_path = UPLOAD_DIR / dbc_name

    try:
        fid = int(frame_id, 0)
        db = load_database(dbc_path)
        msg = db.get_message_by_frame_id(fid)
    except (KeyError, ValueError):
        msg = None
    if msg is None:
        raise HTTPException(404, f"DBC 中无报文 {hex(fid)}")

    signals = [signal] if signal else [s.name for s in msg.signals]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp"] + signals)
    count = 0
    for m in can.BLFReader(str(blf_path)):
        if m.arbitration_id != fid:
            continue
        if channel is not None and getattr(m, "channel", 0) != channel:
            continue
        if start is not None and m.timestamp < start:
            continue
        if end is not None and m.timestamp > end:
            continue
        try:
            dec = db.decode_message(fid, m.data)
        except Exception:
            continue
        writer.writerow([f"{m.timestamp:.6f}"] + [dec.get(s, "") for s in signals])
        count += 1

    content = "\ufeff" + buf.getvalue()  # UTF-8 BOM,方便 Excel 识别中文
    ch_tag = f"_ch{channel}" if channel is not None else ""
    filename = f"{Path(name).stem}{ch_tag}_{hex(fid)}_{len(signals)}sig.csv"
    return Response(content=content, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})
