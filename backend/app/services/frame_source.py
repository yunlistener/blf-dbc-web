"""帧源抽象:统一"离线回放 / 实时接收"数据源接口(系统设计 §4)。

FrameSource 是播放管线的数据源层 —— 离线 BLF 回放器与后期实时 CAN 接收器
实现同一接口,输出统一帧流,前端/引擎无需区分数据来源。
"""
from __future__ import annotations

import bisect
import heapq
import sqlite3
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# ⚠️ 不 import blf_cache(循环:blf_cache → frame_source → blf_cache);
#   FrameChunk 仅类型注解,用 string 注解/注释表述


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


class MemFrameBuffer:
    """共享内存帧缓冲(同进程):构建线程 append,播放线程游标切片读。
    ⚠️ 比 redis/SQLite 边扫边播更优:同进程无需网络/文件 IPC,
    播放读取 ~5μs(内存切片),构建不额外慢(append O(1))。
    内存:每帧 ~40B(6 元组)→ 3843 万帧 ~1.5GB(树莓派 8GB 可接受)。"""

    def __init__(self):
        self._frames: list = []
        self._lock = threading.Lock()
        self.first_ts: float | None = None
        self.last_ts: float | None = None
        self.closed: bool = False   # 构建完成落盘后置 True:播放源 eof,缓冲可释放

    def append(self, ts: float, ch: int, fid: int, data: bytes, is_fd: bool, dlc: int) -> None:
        with self._lock:
            if self.first_ts is None:
                self.first_ts = ts
            self.last_ts = ts
            self._frames.append((ts, ch, fid, data, int(is_fd), dlc))

    def read(self, pos: int, n: int) -> tuple[list, int]:
        """从 pos 读最多 n 帧,返回 (帧列表, 新游标位置)。"""
        with self._lock:
            end = min(pos + n, len(self._frames))
            return self._frames[pos:end], end

    def reset(self) -> None:
        """构建开始:清空并重新开放(旧播放源应结束,新构建重新喂数据)。"""
        with self._lock:
            self._frames.clear()
            self.first_ts = None
            self.last_ts = None
            self.closed = False

    def close(self) -> None:
        """构建完成落盘:清空并关闭(播放已切 BlfReplaySource,释放全量帧内存)。"""
        with self._lock:
            self._frames.clear()
            self.first_ts = None
            self.last_ts = None
            self.closed = True

    def __len__(self) -> int:
        with self._lock:
            return len(self._frames)


class MemPlaySource(FrameSource):
    """构建中播放源:从共享内存缓冲游标顺序读(同进程,内存切片 ~5μs/批)。
    - end_t 过滤:每批只取"播放时间窗"内的帧(防 x 轴堆积成直线)
    - eof 恒 False:构建中数据持续增长
    - seek:构建中从 0(简化;构建完成后切 BlfReplaySource 支持 seek)
    """

    def __init__(self, buf: MemFrameBuffer, t0: float | None = None):
        self._buf = buf
        self._t0 = float(t0) if t0 else float(buf.first_ts or 0.0)
        self._pos = 0
        self._cur_t = 0.0
        self._eof = False

    # ---- FrameSource ----

    def seek(self, t: float) -> None:
        self._pos = 0       # 构建中:从头顺序播
        self._cur_t = t
        self._eof = False

    def next_batch(self, max_frames: int, end_t: float | None = None) -> list:
        out: list = []
        frames, new_pos = self._buf.read(self._pos, max_frames)
        consumed = 0
        for ts, ch, fid, data, is_fd, dlc in frames:
            rel = ts - self._t0
            if end_t is not None and rel > end_t:
                break   # 超播放时间的帧留给下批
            out.append(Frame(ts=rel, channel=ch, frame_id=fid,
                             data=data, is_fd=bool(is_fd), dlc=dlc))
            consumed += 1
        self._pos += consumed
        if out:
            self._cur_t = out[-1].ts
        return out

    def close(self) -> None:
        pass

    @property
    def eof(self) -> bool:
        return self._buf.closed   # 缓冲关闭(构建完成落盘)→ 播放正常结束,不空转

    @property
    def total_frames(self) -> int:
        return len(self._buf)

    @property
    def current_time(self) -> float:
        return self._cur_t

    @property
    def time_range(self) -> tuple[float, float]:
        hi = (self._buf.last_ts - self._t0) if self._buf.last_ts is not None else 0.0
        return 0.0, hi


class SqliteFrameSource(FrameSource):
    """从 SQLite 读帧(磁盘数据源):构建线程边扫边写(StoreArchiver.insert_rows),
    播放读"已写入部分" → 构建中 1x 播放完整(0-T 已落盘即可读),内存恒定(磁盘为主)。

    - 构建中:is_building()=True → eof 恒 False(数据持续增长);读到的范围 = 已 flush 部分
    - 构建完成:读完全部(查询无更多行)→ eof
    - 时间语义:表内 ts 为绝对时间戳;Frame.ts 相对(ts - t0)
    """

    def __init__(self, db_path, t0: float | None = None, is_building=None):
        self._db = Path(db_path)
        self._is_building = is_building or (lambda: False)
        self._con = sqlite3.connect(str(self._db))
        self._con.execute("PRAGMA query_only=ON")
        # t0 = 文件首帧时间(相对时间基准):自动从表内 MIN(ts) 解析(构建中已写部分)
        if not t0:
            row = self._con.execute("SELECT MIN(ts) FROM frames").fetchone()
            t0 = float(row[0]) if row and row[0] is not None else 0.0
        self._t0 = float(t0)
        self._cur_t = 0.0
        self._eof = False
        self._batch_rows: list = []   # 当前批缓存(按 ts 有序)
        self._last_rowid = 0          # 构建中增量游标(插入顺序=时间顺序,主键扫描免索引)

    # ---- FrameSource ----

    def seek(self, t: float) -> None:
        self._cur_t = t
        self._eof = False
        self._batch_rows = []
        self._last_rowid = 0   # 构建中:从头顺序播(简化);构建完成后走 ts 查询

    def next_batch(self, max_frames: int, end_t: float | None = None) -> list:
        out: list = []
        if self._is_building():
            # ⚠️ 构建中:rowid 增量游标 —— 插入顺序 = BLF 时间顺序,主键扫描免索引;
            #    WHERE ts 查询在无 idx_ts 时全表扫描(3843 万行 → 单批 10-30s → WS 卡死 1011)
            #    ⚠️ 必须加 ts <= end_t 过滤:否则每批取"最近 flush 的 1000 帧"(ts 跨度 ~0.01s),
            #    x 坐标几乎相同 → 画线在时间轴上堆积成直线(用户反馈红框内异常直线)
            abs_end = (end_t + self._t0) if end_t is not None else None
            sql = ("SELECT rowid, ts, channel, frame_id, data, flags FROM frames "
                   "WHERE rowid > ?")
            args: list = [self._last_rowid]
            if abs_end is not None:
                sql += " AND ts <= ?"
                args.append(abs_end)
            sql += " ORDER BY rowid LIMIT ?"
            args.append(max_frames)
            rows = self._con.execute(sql, args).fetchall()
            if rows:
                for rid, ts, ch, fid, data, flags in rows:
                    out.append(Frame(ts=ts - self._t0, channel=ch, frame_id=fid,
                                     data=data, is_fd=bool(flags & 1),
                                     dlc=len(data) if isinstance(data, bytes) else 8))
                self._last_rowid = rows[-1][0]
                self._cur_t = out[-1].ts
            return out   # 构建中 eof 恒 False
        abs_start = self._cur_t + self._t0
        abs_end = (end_t + self._t0) if end_t is not None else None
        # 取 [游标, end_t] 区间的帧(ORDER BY ts 保证有序,游标推进)
        sql = "SELECT ts, channel, frame_id, data, flags FROM frames WHERE ts >= ?"
        args: list = [abs_start]
        if abs_end is not None:
            sql += " AND ts <= ?"
            args.append(abs_end)
        sql += " ORDER BY ts LIMIT ?"
        args.append(max_frames)
        rows = self._con.execute(sql, args).fetchall()
        if rows:
            last_abs = rows[-1][0]
            for ts, ch, fid, data, flags in rows:
                out.append(Frame(ts=ts - self._t0, channel=ch, frame_id=fid,
                                 data=data, is_fd=bool(flags & 1), dlc=len(data) if isinstance(data, bytes) else 8))
            self._cur_t = last_abs - self._t0
            if out:
                self._cur_t = out[-1].ts
        else:
            # 无更多行:构建完成且已读完全部 → eof
            if not self._is_building():
                self._eof = True
        return out

    def close(self) -> None:
        self._con.close()

    @property
    def eof(self) -> bool:
        return self._eof

    @property
    def total_frames(self) -> int:
        row = self._con.execute("SELECT COUNT(*) FROM frames").fetchone()
        return int(row[0]) if row else 0

    @property
    def current_time(self) -> float:
        return self._cur_t

    @property
    def time_range(self) -> tuple[float, float]:
        row = self._con.execute("SELECT MIN(ts), MAX(ts) FROM frames").fetchone()
        if not row or row[0] is None:
            return 0.0, 0.0
        return row[0] - self._t0, row[1] - self._t0


class BlfReplaySource(FrameSource):
    """离线 BLF 回放源(批次 4):直接适配紧凑两级索引(通道→报文→FrameChunk),
    免 get_frames_index 展开(686 万帧展开省 ~200MB 临时内存);seek 用 numpy
    searchsorted 二分,流式输出用最小堆 k-way merge。"""

    def __init__(self, path: Path | str):
        # ⚠️ 延迟 import 防循环(blf_cache ↔ frame_source)
        from app.services.blf_cache import load_index
        self.path = Path(path)
        bundle = load_index(self.path)          # 内存/磁盘缓存,不会全扫
        if bundle is None:
            raise FileNotFoundError(f"无法加载索引: {path}")
        self._index = bundle.index              # {ch: {fid: FrameChunk}}
        self._t0 = bundle.stats.get("first_ts") or 0.0
        # 扁平化:每 (ch, fid) 一个数据项
        self._chunks: list = []   # [(ch, fid, FrameChunk)]
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
