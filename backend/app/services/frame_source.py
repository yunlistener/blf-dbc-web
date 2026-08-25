"""帧源抽象:统一"离线回放 / 实时接收"数据源接口(系统设计 §4)。

FrameSource 是播放管线的数据源层 —— 离线 BLF 回放器与后期实时 CAN 接收器
实现同一接口,输出统一帧流,前端/引擎无需区分数据来源。
"""
from __future__ import annotations

import bisect
import heapq
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.services.blf_cache import FrameChunk, load_index


@dataclass
class Frame:
    """统一帧结构(与 can.Message 解耦,前后端协议对齐)。"""
    ts: float            # 时间戳(秒,相对文件起点)
    channel: int
    frame_id: int
    data: bytes
    is_fd: bool = False
    dlc: int = 0


class FrameSource(ABC):
    """帧源接口:seek 定位 + 按批取出时间有序帧。"""

    @abstractmethod
    def seek(self, t: float) -> None:
        """定位到时间 t(后续 next_batch 返回 ts >= t 的帧)。"""

    @abstractmethod
    def next_batch(self, max_frames: int, end_t: float | None = None) -> list[Frame]:
        """取出最多 max_frames 帧(时间升序);end_t 不为 None 时只取 ts <= end_t。"""

    @abstractmethod
    def close(self) -> None:
        """释放资源。"""

    @property
    @abstractmethod
    def time_range(self) -> tuple[float, float]:
        """数据时间范围(相对秒):(首帧, 末帧)。空窗判断依据。"""

    @property
    def eof(self) -> bool:
        """数据是否已到末尾(静态文件读完)。动态源(实时/边缓存边播)永远 False。
        播放引擎据此区分"真播完"与"暂时无数据(空窗/等待下一批)"。"""
        return True


class LivePlaySource(FrameSource):
    """边缓存边播放:游标跟随 LiveDictStore,新 append 的帧自动被消费。
    - 实时 CAN:采集回调 append → 播放实时跟随(播到"当前已接收")
    - 静态全扫构建期:构建线程逐帧 append → 播放从 0 边扫边播(不用等全扫完成)
    与 BlfReplaySource(完整索引)互补:索引未就绪用 LivePlaySource,就绪后切回索引。"""

    def __init__(self, store, t0: float = 0.0):
        self._store = store
        self._t0 = t0
        self._pos: dict[tuple, int] = {}   # (ch, fid) -> 已消费行数
        self._in_heap: set[tuple] = set()  # (ch, fid) 当前在堆中(避免重复入堆)
        self._cur_t = 0.0
        self._heap: list[tuple] = []
        self.seek(0.0)

    def seek(self, t: float) -> None:
        self._pos = {}
        self._heap = []
        self._in_heap = set()
        self._cur_t = t
        abs_t = t + self._t0
        with self._store._lock:
            for ch, msgs in self._store.idx.items():
                for fid, rows in msgs.items():
                    j = bisect.bisect_left(rows, (abs_t,))
                    if j < len(rows):
                        self._pos[(ch, fid)] = j
        # 重建堆
        for (ch, fid), j in self._pos.items():
            with self._store._lock:
                rows = self._store.idx.get(ch, {}).get(fid, [])
            if j < len(rows):
                heapq.heappush(self._heap, (rows[j][0], ch, fid, j))
                self._in_heap.add((ch, fid))

    def _sync_t0(self) -> None:
        """动态同步相对时间基准:构建/实时首帧到达后 store.first_ts 才确定,
        config 时可能还是 None → t0 固定为 0 会导致相对/绝对时间错乱。"""
        if self._store.first_ts is not None:
            self._t0 = self._store.first_ts

    def _discover(self) -> None:
        """动态发现可消费帧:新 (ch,fid) 或已有游标有新帧(append 后 heap 空)→ 入堆。"""
        self._sync_t0()
        with self._store._lock:
            for ch, msgs in list(self._store.idx.items()):
                for fid, rows in msgs.items():
                    key = (ch, fid)
                    j = self._pos.get(key)
                    if j is None:
                        j = bisect.bisect_left(rows, (self._cur_t + self._t0,))
                        if j >= len(rows):
                            continue
                        self._pos[key] = j
                    if key not in self._in_heap and j < len(rows):
                        heapq.heappush(self._heap, (rows[j][0], ch, fid, j))
                        self._in_heap.add(key)

    def next_batch(self, max_frames: int, end_t: float | None = None) -> list:
        self._discover()   # ⚠️ 每次取批前发现新帧(构建/实时持续 append)
        out: list = []
        guard = 0
        while self._heap and len(out) < max_frames:
            ts, ch, fid, j = self._heap[0]
            if end_t is not None and ts > end_t + self._t0:   # end_t 相对 → 绝对比较
                break
            heapq.heappop(self._heap)
            self._in_heap.discard((ch, fid))
            with self._store._lock:
                rows = self._store.idx.get(ch, {}).get(fid, [])
            if j >= len(rows):          # 被环形裁剪挤掉 → 跳过
                continue
            r = rows[j]
            out.append(Frame(ts=r[0] - self._t0, channel=ch, frame_id=fid,
                             data=r[1], is_fd=r[2], dlc=r[3]))
            self._pos[(ch, fid)] = j + 1
            j += 1
            if j < len(rows):
                heapq.heappush(self._heap, (rows[j][0], ch, fid, j))
                self._in_heap.add((ch, fid))
            guard += 1
            if guard > 100000:
                break
        if out:
            self._cur_t = out[-1].ts
        return out

    def close(self) -> None:
        self._heap = []

    @property
    def eof(self) -> bool:
        return False   # 动态源(实时/边缓存边播):数据持续增长,没有终点

    @property
    def total_frames(self) -> int:
        return len(self._store)

    @property
    def current_time(self) -> float:
        return self._cur_t

    @property
    def time_range(self) -> tuple[float, float]:
        with self._store._lock:
            if not self._store.idx:
                return 0.0, 0.0
            lo = min(rows[0][0] for m in self._store.idx.values() for rows in m.values())
            hi = max(rows[-1][0] for m in self._store.idx.values() for rows in m.values())
        return lo - self._t0, hi - self._t0


class BlfReplaySource(FrameSource):
    """离线 BLF 回放源(批次 4):直接适配紧凑两级索引(通道→报文→FrameChunk),
    免 get_frames_index 展开(686 万帧展开省 ~200MB 临时内存);seek 用 numpy
    searchsorted 二分,流式输出用最小堆 k-way merge。"""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        bundle = load_index(self.path)          # 内存/磁盘缓存,不会全扫
        if bundle is None:
            raise FileNotFoundError(f"无法加载索引: {path}")
        self._index = bundle.index              # {ch: {fid: FrameChunk}}
        self._t0 = bundle.stats.get("first_ts") or 0.0
        # 扁平化:每 (ch, fid) 一个数据项
        self._chunks: list[tuple[int, int, FrameChunk]] = []
        for ch in sorted(self._index):
            for fid in sorted(self._index[ch]):
                self._chunks.append((ch, fid, self._index[ch][fid]))
        self._total = bundle.total_frames
        self._heap: list[tuple[float, int, int, int]] = []   # (abs_ts, ch, fid, i)
        self._cur_t = 0.0
        self.seek(0.0)   # 默认从相对 0 开始

    # ---- FrameSource ----

    def seek(self, t: float) -> None:
        """定位到相对时间 t(ts - t0 >= t 的首帧)。用 numpy searchsorted 二分。"""
        self._heap = []
        self._cur_t = t
        abs_t = t + self._t0
        for ch, fid, chunk in self._chunks:
            # chunk.ts 是相对 chunk.t0 的 float32;abs 目标 → 相对目标
            j = int(np.searchsorted(chunk.ts, abs_t - chunk.t0, side="left"))
            if j < chunk.n:
                heapq.heappush(self._heap, (chunk.t0 + float(chunk.ts[j]), ch, fid, j))

    def next_batch(self, max_frames: int, end_t: float | None = None) -> list[Frame]:
        out: list[Frame] = []
        while self._heap and len(out) < max_frames:
            abs_ts, ch, fid, j = self._heap[0]
            rel = abs_ts - self._t0
            if end_t is not None and rel > end_t:
                break
            heapq.heappop(self._heap)
            chunk = self._index[ch][fid]
            p = int(chunk.off[j])
            out.append(Frame(
                ts=rel, channel=ch, frame_id=fid,
                data=chunk.data[p:p + int(chunk.dlc[j])],
                is_fd=bool(chunk.flags[j] & 1), dlc=int(chunk.dlc[j]),
            ))
            j += 1
            if j < chunk.n:
                heapq.heappush(self._heap, (chunk.t0 + float(chunk.ts[j]), ch, fid, j))
        if out:
            self._cur_t = out[-1].ts
        return out

    def close(self) -> None:
        self._heap = []

    @property
    def eof(self) -> bool:
        return not self._heap   # 静态:堆空 = 全部帧已消费 = 播完

    # ---- 扩展 ----

    @property
    def total_frames(self) -> int:
        return self._total

    @property
    def current_time(self) -> float:
        return self._cur_t

    @property
    def time_range(self) -> tuple[float, float]:
        if not self._chunks:
            return 0.0, 0.0
        lo = min(c.t0 for _, _, c in self._chunks) - self._t0
        hi = max(c.t0 + float(c.ts[-1]) for _, _, c in self._chunks) - self._t0
        return lo, hi
