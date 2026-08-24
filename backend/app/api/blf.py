"""BLF API:统计 / 信号解码 / 帧列表 / CSV 导出。"""
from __future__ import annotations

import csv
import io
import threading
from collections import defaultdict
from pathlib import Path
from typing import Optional

import can
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.config import UPLOAD_DIR
from app.parsers.blf_parser import stats as blf_stats
from app.parsers.dbc_parser import load_database
from app.services.decoder import decode_signal
from app.services.progress import clear_progress, set_progress
from app.services.blf_cache import get_frames as cache_get_frames
from app.services.blf_cache import get_frames_index as cache_index
from app.api.config_api import _load as load_config

router = APIRouter()


def _blf_path(name: str) -> Path:
    path = UPLOAD_DIR / name
    if not path.is_file() or path.suffix.lower() != ".blf":
        raise HTTPException(404, f"BLF 文件不存在: {name}")
    return path


def _resolve_dbc(dbc: Optional[str], channel: Optional[int]) -> str:
    """解析 DBC 文件名:显式传入优先;否则用该通道的映射配置。"""
    if dbc is None and channel is not None:
        dbc = load_config().get("channels", {}).get(str(channel))
    if not dbc:
        raise HTTPException(422,
            f"通道 {channel} 未配置 DBC,请先在配置抽屉中设置")
    path = UPLOAD_DIR / dbc
    if not path.is_file():
        raise HTTPException(404, f"DBC 文件不存在: {dbc}")
    return dbc


# stats 内存缓存(大文件全扫 1.5s+;按文件 size+mtime 失效,文件不变直接命中)
_stats_cache: dict[str, tuple[tuple, dict]] = {}
_stats_lock = threading.Lock()


@router.get("/{name}/stats")
def get_stats(name: str):
    blf_path = _blf_path(name)
    st = blf_path.stat()
    sig = (st.st_size, st.st_mtime_ns)
    with _stats_lock:
        hit = _stats_cache.get(name)
        if hit and hit[0] == sig:
            return hit[1]
    key = f"stats:{name}"
    set_progress(key, "扫描帧", 0.0)
    try:
        result = blf_stats(blf_path, progress_cb=lambda p: set_progress(key, "扫描帧", p))
    finally:
        clear_progress(key)
    with _stats_lock:
        _stats_cache[name] = (sig, result)
    return result
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

    key = f"index:{name}"
    set_progress(key, "构建帧索引(首次解码,大文件较慢)", 0.0)
    try:
        result = decode_signal(blf_path, db, fid, signal, start, end, max_points,
                               channel=channel,
                               progress_cb=lambda p: set_progress(key, "构建帧索引(首次解码,大文件较慢)", p))
    finally:
        clear_progress(key)
    if not result["times"]:
        # 日志中无该报文数据(报文在 DBC 里有定义但日志里没发)→ 返回空结果,前端提示
        result["empty"] = True
    return result


@router.get("/{name}/frames")
def get_frames(name: str, dbc: Optional[str] = None, frame_id: str = "",
               channel: Optional[int] = None,
               start: Optional[float] = None, end: Optional[float] = None,
               limit: int = 200, offset: int = 0,
               decode: bool = False,
               sig_filter: Optional[str] = None,   # 按信号值搜索:信号名
               sig_value: Optional[str] = None):    # 目标值(数值或值表状态名)
    """Trace 帧列表:分页返回该报文的原始帧;支持按信号值过滤(sig_filter+sig_value)。"""
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

    # 校验搜索信号存在于该报文
    if sig_filter is not None:
        if not any(s.name == sig_filter for s in msg.signals):
            raise HTTPException(422, f"报文 {hex(fid)} 无信号 {sig_filter}")

    def _sig_match(decoded) -> bool:
        """按信号值过滤:数值按容差匹配,值表按状态名或原始值匹配。"""
        if sig_filter is None or sig_value is None:
            return True
        v = decoded.get(sig_filter)
        if v is None:
            return False
        if isinstance(v, dict) and "name" in v:
            # 值表信号 {name, value}:匹配状态名或原始值
            return v["name"] == sig_value or str(v["value"]) == sig_value
        if isinstance(v, (int, float)):
            try:
                tv = float(sig_value)
                return abs(v - tv) < 1e-6
            except ValueError:
                return False
        return str(v) == sig_value

    frames = []
    skipped = 0
    for ts, ch, data, is_fd, dlc in cache_get_frames(blf_path, fid, channel=channel, start=start, end=end):
        if sig_filter is not None:
            try:
                dec = db.decode_message(fid, data)
            except Exception:
                continue
            if not _sig_match(dec):
                continue
        if skipped < offset:
            skipped += 1
            continue
        if len(frames) >= limit:
            break
        row = {
            "timestamp": round(ts, 6),
            "id": fid,
            "id_hex": hex(fid),
            "name": msg.name,
            "dlc": dlc,
            "data": data.hex(" ").upper() if data else "",
            "is_fd": is_fd,
            "channel": ch,
        }
        if decode:
            try:
                row["decoded"] = db.decode_message(fid, data)
            except Exception:
                row["decoded"] = None
        frames.append(row)
    return {"name": msg.name, "channel": channel, "offset": offset,
            "limit": limit, "returned": len(frames), "frames": frames,
            "filter": {"signal": sig_filter, "value": sig_value}}


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
    for ts, _ch, data, _is_fd, _dlc in cache_get_frames(blf_path, fid, channel=channel, start=start, end=end):
        try:
            dec = db.decode_message(fid, data)
        except Exception:
            continue
        writer.writerow([f"{ts:.6f}"] + [dec.get(s, "") for s in signals])
        count += 1

    content = "\ufeff" + buf.getvalue()  # UTF-8 BOM,方便 Excel 识别中文
    ch_tag = f"_ch{channel}" if channel is not None else ""
    filename = f"{Path(name).stem}{ch_tag}_{hex(fid)}_{len(signals)}sig.csv"
    return Response(content=content, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.get("/{name}/signal-stats")
def signal_stats(name: str, dbc: Optional[str] = None, frame_id: str = "",
                 signal: str = "", channel: Optional[int] = None,
                 start: Optional[float] = None, end: Optional[float] = None):
    """信号数值统计:count / min / max / mean / std / 最后值 / 值表分布(走帧缓存)。"""
    blf_path = _blf_path(name)
    dbc_name = _resolve_dbc(dbc, channel)
    db = load_database(UPLOAD_DIR / dbc_name)
    try:
        fid = int(frame_id, 0)
        msg = db.get_message_by_frame_id(fid)
        sig = msg.get_signal_by_name(signal)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, f"DBC 中无报文/信号: {e}") from e

    values = []
    for _ts, _ch, data, _is_fd, _dlc in cache_get_frames(blf_path, fid, channel=channel, start=start, end=end):
        try:
            v = db.decode_message(fid, data).get(signal)
        except Exception:
            continue
        if v is not None:
            values.append(v)

    out = {"frame_id": fid, "frame_id_hex": hex(fid), "signal": signal,
           "channel": channel, "count": len(values)}
    numeric = [v for v in values if isinstance(v, (int, float))]
    if numeric:
        n = len(numeric)
        mean = sum(numeric) / n
        var = sum((x - mean) ** 2 for x in numeric) / n
        out.update({
            "min": round(min(numeric), 6),
            "max": round(max(numeric), 6),
            "mean": round(mean, 6),
            "std": round(var ** 0.5, 6),
            "last": numeric[-1],
        })
    # 值表信号:各状态分布
    if getattr(sig, "choices", None):
        dist = {}
        for v in values:
            key = v["name"] if isinstance(v, dict) and "name" in v else str(v)
            dist[key] = dist.get(key, 0) + 1
        out["choices_dist"] = dist
    # 超范围检测:对比 DBC 定义的 min/max
    if numeric and (sig.minimum is not None or sig.maximum is not None):
        oor = sum(1 for v in numeric
                  if (sig.minimum is not None and v < sig.minimum) or
                     (sig.maximum is not None and v > sig.maximum))
        out["out_of_range"] = oor
        out["range_min"] = sig.minimum
        out["range_max"] = sig.maximum
    return out


@router.get("/{name}/cycle-stats")
def cycle_stats(name: str, dbc: Optional[str] = None, frame_id: str = "",
                channel: Optional[int] = None,
                start: Optional[float] = None, end: Optional[float] = None):
    """报文周期/抖动/丢帧:相邻帧时间间隔统计,期望周期取自 DBC cycle_time。"""
    blf_path = _blf_path(name)
    dbc_name = _resolve_dbc(dbc, channel)
    db = load_database(UPLOAD_DIR / dbc_name)
    try:
        fid = int(frame_id, 0)
        msg = db.get_message_by_frame_id(fid)
    except (KeyError, ValueError) as e:
        raise HTTPException(404, f"DBC 中无报文: {e}") from e

    rows = cache_get_frames(blf_path, fid, channel=channel, start=start, end=end)
    times = sorted(ts for ts, *_ in rows)
    expected_ms = msg.cycle_time
    expected_s = expected_ms / 1000.0 if expected_ms else None

    out = {"frame_id": fid, "frame_id_hex": hex(fid), "name": msg.name,
           "channel": channel, "count": len(times),
           "expected_ms": expected_ms, "expected_s": expected_s}
    if len(times) >= 2:
        ivs = [times[i + 1] - times[i] for i in range(len(times) - 1)]
        max_i = ivs.index(max(ivs))
        min_i = ivs.index(min(ivs))
        out.update({
            "avg_ms": round(sum(ivs) / len(ivs) * 1000, 3),
            "min_ms": round(min(ivs) * 1000, 3),
            "max_ms": round(max(ivs) * 1000, 3),
            "jitter_ms": round((max(ivs) - min(ivs)) * 1000, 3),   # 峰峰抖动
            # 抖动峰值出现的时间点(间隔起始帧时间,绝对时间戳,前端转相对)
            "jitter_max_at": times[max_i],
            "jitter_min_at": times[min_i],
        })
        if expected_s:
            # 丢帧:间隔超过期望 1.5 倍视为缺帧,按比例推算丢帧数
            lost = 0
            for iv in ivs:
                if iv > expected_s * 1.5:
                    lost += max(1, round(iv / expected_s) - 1)
            out["lost_frames"] = lost
            out["lost_pct"] = round(lost / len(times) * 100, 2)
    return out


def _frame_bits(dlc: int, is_fd: bool) -> tuple[int, int]:
    """帧位宽近似(不含位填充):经典 CAN 47+8*DLC(含 IFS);
    CAN FD 仲裁段 20(SOF+ID+控制+DLC),数据段 8*DLC+28(CRC+DEL+ACK+EOF+IFS 近似)。"""
    if is_fd:
        return 20, 8 * dlc + 28
    return 47 + 8 * dlc, 0


@router.get("/{name}/bus-load")
def bus_load(name: str, channel: Optional[int] = None):
    """总线负载率:按配置的波特率估算每通道占用率(近似,不含位填充)。"""
    blf_path = _blf_path(name)
    cfg = load_config()
    arb = int(cfg.get("baudrate_arb", 500000))
    data = int(cfg.get("baudrate_data", 2000000))

    chan_time: dict[int, float] = defaultdict(float)
    chan_frames: dict[int, int] = defaultdict(int)
    first_ts: dict[int, float] = {}
    last_ts: dict[int, float] = {}

    idx = cache_index(blf_path)
    for fid, rows in idx.items():
        for ts, ch, _data, is_fd, dlc in rows:
            if channel is not None and ch != channel:
                continue
            ab, db_ = _frame_bits(dlc, is_fd)
            chan_time[ch] += ab / arb + db_ / data
            chan_frames[ch] += 1
            first_ts.setdefault(ch, ts)
            last_ts[ch] = ts

    out = {}
    for ch in sorted(chan_time):
        dur = last_ts[ch] - first_ts[ch]
        out[str(ch)] = {
            "frames": chan_frames[ch],
            "bus_time_s": round(chan_time[ch], 4),
            "duration_s": round(dur, 4),
            "bus_load_pct": round(chan_time[ch] / dur * 100, 2) if dur > 0 else 0.0,
        }
    return {"arbitration_baudrate": arb, "data_baudrate": data,
            "bus_type": cfg.get("bus_type", "canfd"), "channels": out}
