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

from app.services.blf_cache import get_frames_index


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


class BlfReplaySource(FrameSource):
    """离线 BLF 回放源:基于帧索引缓存,多报文按时间堆合并,支持 seek。

    构建 O(报文数) 的每报文时间数组用于二分定位;
    流式输出用最小堆做 k-way merge,不产生全局排序副本(内存友好)。
    """

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._index = get_frames_index(self.path)
        # frame_id -> [(ts, ch, data, is_fd, dlc), ...](每报文帧按时间有序)
        self._lists: dict[int, list] = {
            fid: rows for fid, rows in self._index.items() if rows
        }
        # frame_id -> [ts, ...] 时间数组(二分定位用)
        self._times: dict[int, list] = {
            fid: [r[0] for r in rows] for fid, rows in self._lists.items()
        }
        # 时间基准:帧时间戳为绝对 Unix 时间,播放统一用相对时间(ts - t0)
        self._t0 = min(self._times[fid][0] for fid in self._lists) if self._lists else 0.0
        self._heap: list[tuple] = []
        self._pos: dict[int, int] = {}
        self._cur_t = 0.0
        self._total = sum(len(r) for r in self._lists.values())
        self.seek(0.0)   # 默认从相对 0 开始

    # ---- FrameSource ----

    def seek(self, t: float) -> None:
        """定位到相对时间 t(ts - t0 >= t 的首帧)。"""
        self._pos = {}
        self._heap = []
        self._cur_t = t
        abs_t = t + self._t0
        for fid, rows in self._lists.items():
            j = bisect.bisect_left(self._times[fid], abs_t)
            if j < len(rows):
                self._pos[fid] = j
                r = rows[j]
                heapq.heappush(self._heap, (r[0] - self._t0, fid, j))   # 堆用相对时间

    def next_batch(self, max_frames: int, end_t: float | None = None) -> list[Frame]:
        out: list[Frame] = []
        while self._heap and len(out) < max_frames:
            ts, fid, j = self._heap[0]
            if end_t is not None and ts > end_t:
                break
            heapq.heappop(self._heap)
            r = self._lists[fid][j]
            out.append(Frame(
                ts=r[0] - self._t0, channel=r[1], frame_id=fid,   # 相对时间
                data=r[2], is_fd=r[3], dlc=r[4],
            ))
            j += 1
            if j < len(self._lists[fid]):
                self._pos[fid] = j
                nr = self._lists[fid][j]
                heapq.heappush(self._heap, (nr[0] - self._t0, fid, j))   # 相对时间
        if out:
            self._cur_t = out[-1].ts
        return out

    def close(self) -> None:
        self._heap = []
        self._pos = {}

    # ---- 扩展 ----

    @property
    def total_frames(self) -> int:
        return self._total

    @property
    def current_time(self) -> float:
        return self._cur_t

    @property
    def time_range(self) -> tuple[float, float]:
        lo = min(self._times[fid][0] for fid in self._lists) - self._t0
        hi = max(self._times[fid][-1] for fid in self._lists) - self._t0
        return lo, hi
