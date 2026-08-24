"""帧源抽象:统一"离线回放 / 实时接收"数据源接口(系统设计 §4)。

FrameSource 是播放管线的数据源层 —— 离线 BLF 回放器与后期实时 CAN 接收器
实现同一接口,输出统一帧流,前端/引擎无需区分数据来源。
"""
from __future__ import annotations

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
