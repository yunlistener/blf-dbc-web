"""BLF 帧缓存(批次 1 重构):一次全扫产出 stats + 两级索引(通道→报文→有序帧),
紧凑存储(ts/off/dlc/flags numpy 数组 + data 拼接池,实测体积约为 pickle-list 方案的 1/10),
pickle 落盘 data/cache/{name}.idx(文件 size+mtime 签名失效,重启免重建)。
解码按通道 O(1) 定位 + 时间窗二分(np.searchsorted),与"通道 ID + 时间筛选"需求对齐。
"""
from __future__ import annotations

import pickle
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import can
import numpy as np

from app.config import CACHE_DIR, MAX_TOTAL_FRAMES
from app.services.live_store import LiveDictStore, StoreArchiver

# 全局环形缓冲:静态构建/实时采集共用,播放源(边缓存边播放)消费
# ⚠️ 构建期窗口=全量(1e9):播放从 0 跟随构建进度,60s 环形会裁掉早期数据;
#    帧数上限 5 万/报文(101MB 45 报文 ≈ 315MB 内存,预算内);实时接入时再调环形参数
live_store = LiveDictStore(window_s=1e9, max_frames_per_msg=50000, max_total=MAX_TOTAL_FRAMES)

MAX_FRAMES = 4_000_000        # 内存常驻总帧数上限(紧凑结构 ~30B/帧 → 4M 帧约 120MB)
CACHE_VERSION = 2

_lock = threading.Lock()
BUILD_LOCK = threading.Lock()            # 构建串行化:同一时间一个构建线程喂 live_store(防多文件混合)
_mem: dict[str, "IndexBundle"] = {}        # path -> 内存索引(进程内复用)
_building: set[str] = set()                # 正在后台构建的 path(防重复)


@dataclass
class FrameChunk:
    """紧凑帧块:某 (channel, frame_id) 的全部帧。data 为拼接池,off[i] 为第 i 帧起点。
    ts 存相对时间 float32(t0 基准;float32 在 0~1e4s 内分辨率 ~1e-4s,解码精度足够),
    off 用 int32(池 < 2GB)→ 体积约为 float64/int64 的 60%。"""
    ts: np.ndarray      # float32 (N,)  相对 chunk.t0
    t0: float           # 该块首帧绝对时间戳
    off: np.ndarray     # int32 (N,)    data 池偏移
    dlc: np.ndarray     # uint8 (N,)
    flags: np.ndarray   # uint8 (N,)    bit0=is_fd bit1=error bit2=remote
    data: bytes         # 拼接池

    @property
    def n(self) -> int:
        return len(self.ts)


@dataclass
class IndexBundle:
    """一次全扫的全部产物:stats + 两级索引 + 通道列表。"""
    index: dict           # {channel: {frame_id: FrameChunk}}
    stats: dict
    channels: list
    total_frames: int
    sig: tuple


def _sig(path: Path) -> tuple:
    st = path.stat()
    return (st.st_size, st.st_mtime_ns)


def _cache_file(path: Path) -> Path:
    return CACHE_DIR / f"{path.stem}.idx"


def build_index(path: Path, progress_cb=None, on_frame=None) -> IndexBundle:
    """一次全扫 BLF:统计 + 两级索引(通道→报文→有序帧),紧凑结构。"""
    total_size = path.stat().st_size or 1
    by_ch: dict[int, dict[int, list]] = defaultdict(lambda: defaultdict(list))
    stats = {
        "total_frames": 0, "fd_frames": 0, "error_frames": 0, "remote_frames": 0,
        "first_ts": None, "last_ts": None,
        "by_id": defaultdict(int), "channels": set(),
    }
    reader = can.BLFReader(str(path))
    fobj = getattr(reader, "f", None) or getattr(reader, "_file", None) or getattr(reader, "file", None)
    for m in reader:
        ts = m.timestamp
        ch = getattr(m, "channel", 0)
        is_fd = bool(getattr(m, "is_fd", False))
        is_err = bool(getattr(m, "is_error_frame", False))
        is_rem = bool(getattr(m, "is_remote_frame", False))
        stats["total_frames"] += 1
        if is_fd:
            stats["fd_frames"] += 1
        if is_err:
            stats["error_frames"] += 1
        if is_rem:
            stats["remote_frames"] += 1
        if stats["first_ts"] is None:
            stats["first_ts"] = ts
        stats["last_ts"] = ts
        stats["by_id"][m.arbitration_id] += 1
        stats["channels"].add(ch)
        by_ch[ch][m.arbitration_id].append((ts, m.data, is_fd, is_rem, m.dlc))
        if on_frame is not None:   # 边扫边播:喂全局环形缓冲(构建线程)
            on_frame(ts, ch, m.arbitration_id, m.data, is_fd, m.dlc)
        if progress_cb and fobj is not None:
            try:
                progress_cb(min(0.99, fobj.tell() / total_size))
            except Exception:
                pass

    # 转紧凑结构
    index: dict[int, dict[int, FrameChunk]] = {}
    for ch in by_ch:
        index[ch] = {}
        for fid, rows in by_ch[ch].items():
            rows.sort(key=lambda r: r[0])   # 帧按时间递增(双保险)
            n = len(rows)
            t0 = rows[0][0]
            ts = np.empty(n, dtype=np.float32)
            off = np.empty(n, dtype=np.int32)
            dlc = np.empty(n, dtype=np.uint8)
            flags = np.empty(n, dtype=np.uint8)
            parts = []
            pos = 0
            for i, (t, data, is_fd, is_rem, d) in enumerate(rows):
                ts[i] = t - t0
                off[i] = pos
                dlc[i] = d
                flags[i] = (1 if is_fd else 0) | (2 if is_rem else 0)
                parts.append(data)
                pos += len(data)
            index[ch][fid] = FrameChunk(ts=ts, t0=t0, off=off, dlc=dlc, flags=flags,
                                        data=b"".join(parts))

    stats["channels"] = sorted(stats["channels"])
    stats["by_id"] = dict(stats["by_id"])
    stats["duration_s"] = round((stats["last_ts"] - stats["first_ts"]), 4) \
        if stats["first_ts"] is not None else 0.0
    stats["unique_ids"] = len(stats["by_id"])
    return IndexBundle(index=index, stats=stats, channels=stats["channels"],
                       total_frames=stats["total_frames"], sig=_sig(path))


def save_disk(bundle: IndexBundle, path: Path) -> Path:
    """pickle 落盘(先写 .tmp 再 rename,防半写)。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dst = _cache_file(path)
    payload = {"version": CACHE_VERSION, "sig": bundle.sig, "stats": bundle.stats,
               "channels": bundle.channels, "index": bundle.index}
    tmp = dst.with_suffix(".tmp")
    with tmp.open("wb") as f:
        pickle.dump(payload, f, protocol=4)
    tmp.rename(dst)
    return dst


def _load_disk(path: Path) -> Optional[IndexBundle]:
    cf = _cache_file(path)
    if not cf.is_file():
        return None
    try:
        with cf.open("rb") as f:
            payload = pickle.load(f)
    except Exception:
        return None
    if payload.get("version") != CACHE_VERSION or payload.get("sig") != _sig(path):
        return None   # 版本/文件变更 → 失效
    return IndexBundle(index=payload["index"], stats=payload["stats"],
                       channels=payload["channels"],
                       total_frames=payload["stats"]["total_frames"], sig=payload["sig"])


def load_index(path: Path, progress_cb=None, build: bool = True) -> Optional[IndexBundle]:
    """取索引:内存缓存 → 磁盘缓存 → 全扫构建。无缓存且 build=False 返回 None。

    若该文件正在后台构建(_building)→ **等待构建完成**(轮询 0.1s),不并发构建:
    否则播放/解码触发第二次全扫,与后台线程竞争(更慢且写缓存互相覆盖)。"""
    key = str(path)
    sig = _sig(path)
    # 构建中 → 等待(最多 30 分钟;完成后走内存/磁盘缓存)
    if build and key in _building:
        waited = 0.0
        while key in _building and waited < 1800.0:
            time.sleep(0.1)
            waited += 0.1
    with _lock:
        hit = _mem.get(key)
        if hit and hit.sig == sig:
            return hit
    disk = _load_disk(path)
    if disk is not None:
        with _lock:
            _mem[key] = disk
        return disk
    if not build:
        return None
    bundle = build_index(path, progress_cb=progress_cb)
    save_disk(bundle, path)
    with _lock:
        # 内存 LRU 上限
        _mem[key] = bundle
        while sum(b.total_frames for b in _mem.values()) > MAX_FRAMES and len(_mem) > 1:
            _mem.pop(next(iter(_mem)))
    return bundle


def start_build(path: Path) -> bool:
    """后台构建(上传后/页面加载):幂等,已在构建或已有缓存返回 False。"""
    key = str(path)
    with _lock:
        if key in _building or _load_disk(path) is not None:
            return False
        _building.add(key)
    return True


def finish_build(path: Path):
    with _lock:
        _building.discard(str(path))


def build_async(path: Path) -> bool:
    """后台线程构建索引(上传后/无缓存时):立即返回,不阻塞请求。
    带进度跟踪(progress.py),前端遮罩可见;已在构建/已有缓存则跳过。"""
    if not start_build(path):
        return False
    from app.services.progress import clear_progress, set_progress

    key = f"index:{path.stem}"
    set_progress(key, "后台构建索引(首次加载,大文件较慢)", 0.0)

    def _work():
        with BUILD_LOCK:   # ⚠️ 串行构建:防多文件构建线程并发
            try:
                # ⚠️ 2026-08-27 构建提速:不再边扫边写 SQLite(SQLite 写入+建索引+checkpoint
                #    占构建 ~240s/282MB,且只为"构建中播放"(卡顿,用户已否)→ 砍掉;
                #    构建 = 纯解析 + 内存索引 + pickle 落盘 → 282MB 324s → ~100s
                #    SQLite 数据源保留(实时 CAN 输入后续接入用,与静态构建无关)
                bundle = build_index(
                    path,
                    progress_cb=lambda p: set_progress(key, "后台构建索引(首次加载,大文件较慢)", p))
                save_disk(bundle, path)
                with _lock:
                    _mem[str(path)] = bundle
            except Exception:
                import traceback
                traceback.print_exc()   # ⚠️ 构建线程异常必须打印(曾静默崩溃)
            finally:
                clear_progress(key)
                finish_build(path)

    threading.Thread(target=_work, daemon=True).start()
    return True


def get_frames(path: Path, frame_id: int, channel: Optional[int] = None,
               start: Optional[float] = None, end: Optional[float] = None,
               progress_cb=None) -> list:
    """按 (通道, 报文, 时间窗) 取帧:通道 O(1) 定位 + 时间窗二分切片。
    返回兼容格式 [(ts, channel, data, is_fd, dlc), ...]。"""
    bundle = load_index(path, progress_cb=progress_cb)
    if bundle is None:
        return []
    out: list = []
    for ch in (bundle.index.keys() if channel is None else (channel,)):
        chunk = bundle.index.get(ch, {}).get(frame_id)
        if chunk is None:
            continue
        lo = 0 if start is None else int(np.searchsorted(chunk.ts, start - chunk.t0, side="left"))
        hi = chunk.n if end is None else int(np.searchsorted(chunk.ts, end - chunk.t0, side="left"))
        d, off, dlc, fl, t0 = chunk.data, chunk.off, chunk.dlc, chunk.flags, chunk.t0
        for i in range(lo, hi):
            p = int(off[i])
            out.append((t0 + float(chunk.ts[i]), ch, d[p:p + int(dlc[i])],
                        bool(fl[i] & 1), int(dlc[i])))
    return out


def get_frames_index(path: Path, progress_cb=None) -> dict:
    """兼容旧接口:展开为 {frame_id: [(ts, channel, data, is_fd, dlc), ...]}。
    (播放源 BlfReplaySource 使用;批次 4 将直接适配紧凑结构)"""
    bundle = load_index(path, progress_cb=progress_cb)
    idx: dict[int, list] = defaultdict(list)
    if bundle is None:
        return idx
    for ch, msgs in bundle.index.items():
        for fid, chunk in msgs.items():
            d, off, dlc, fl, t0 = chunk.data, chunk.off, chunk.dlc, chunk.flags, chunk.t0
            for i in range(chunk.n):
                p = int(off[i])
                idx[fid].append((t0 + float(chunk.ts[i]), ch, d[p:p + int(dlc[i])],
                                 bool(fl[i] & 1), int(dlc[i])))
    return dict(idx)


def get_stats(path: Path, progress_cb=None) -> Optional[dict]:
    bundle = load_index(path, progress_cb=progress_cb)
    return bundle.stats if bundle else None


def partial_channels(path: Path, limit: int = 20000) -> list:
    """部分扫描前 limit 帧统计通道(meta 无缓存时秒回;多通道同步记录近似全覆盖)。"""
    chs: set[int] = set()
    try:
        with can.BLFReader(str(path)) as reader:
            for i, m in enumerate(reader):
                if i >= limit:
                    break
                chs.add(getattr(m, "channel", 0))
    except Exception:
        pass
    return sorted(chs)


def invalidate(path: Path):
    key = str(path)
    with _lock:
        _mem.pop(key, None)
    cf = _cache_file(path)
    try:
        cf.unlink()
    except OSError:
        pass
