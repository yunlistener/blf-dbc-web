"""实时/增量帧存储层(2026-08 存储重构):可追加 dict + 环形裁剪 + SQLite 秒级归档。

- `LiveDictStore`:内存环形缓冲(时间窗 ∩ 帧数上限),append O(1),bisect 时间窗查询
  —— 边缓存边播放(播放源游标跟随),静态全扫构建期同样适用(边扫边播)
- `StoreArchiver`:每秒批量归档到 SQLite(WAL + channel/frame_id/ts 复合索引)
  —— 实时 CAN 数据留档(无源文件,持久化=数据本身);崩溃 WAL 恢复,最多丢 <1s
"""
from __future__ import annotations

import bisect
import sqlite3
import threading
from pathlib import Path


class LiveDictStore:
    """可追加帧存储:{channel: {frame_id: [(ts, data, is_fd, dlc), ...]}}。
    帧按时间有序(顺序到达,append 尾部);环形裁剪:超时间窗或帧数上限的旧帧删除。"""

    def __init__(self, window_s: float = 60.0, max_frames_per_msg: int = 20000):
        self.window_s = window_s          # 环形时间窗(秒),保留最近 window_s
        self.max_per = max_frames_per_msg  # 每 (channel, frame_id) 帧数硬上限(内存有界)
        self.idx: dict[int, dict[int, list]] = {}
        self.first_ts: float | None = None   # 首次 append 的时间戳(播放相对时间基准)
        self._lock = threading.Lock()

    def append(self, ts: float, ch: int, fid: int, data: bytes, is_fd: bool, dlc: int):
        with self._lock:
            if self.first_ts is None:
                self.first_ts = ts
            rows = self.idx.setdefault(ch, {}).setdefault(fid, [])
            rows.append((ts, data, is_fd, dlc))
            # 时间窗裁剪(二分定位旧帧边界,O(log n + k))
            cutoff = ts - self.window_s
            i = bisect.bisect_left(rows, (cutoff,))
            if i:
                del rows[:i]
            # 帧数上限裁剪
            if len(rows) > self.max_per:
                del rows[:len(rows) - self.max_per]

    def get(self, ch: int, fid: int, start: float | None = None,
            end: float | None = None) -> list:
        """时间窗查询(相对/绝对时间戳均可,与内部一致)。"""
        with self._lock:
            rows = self.idx.get(ch, {}).get(fid, [])
            lo = 0 if start is None else bisect.bisect_left(rows, (start,))
            hi = len(rows) if end is None else bisect.bisect_left(rows, (end,))
            return rows[lo:hi]

    def snapshot_rows(self) -> dict:
        """返回 {ch: {fid: rows}} 引用快照(调用方在锁外用;只读安全,append 尾部不破坏游标)。"""
        return self.idx

    def clear(self):
        with self._lock:
            self.idx.clear()
            self.first_ts = None   # ⚠️ 必须重置:跨文件构建时旧 first_ts 污染相对时间基准

    def __len__(self) -> int:
        with self._lock:
            return sum(len(r) for m in self.idx.values() for r in m.values())


class StoreArchiver:
    """实时帧归档:增量批量写 SQLite(WAL)。每秒调用 flush() 归档环形缓冲新帧。"""

    def __init__(self, store: LiveDictStore, db_path: str | Path):
        self.store = store
        self.db_path = Path(db_path)
        self.con = sqlite3.connect(str(self.db_path))
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA synchronous=NORMAL")
        self.con.execute(
            "CREATE TABLE IF NOT EXISTS frames("
            "channel INT, frame_id INT, ts REAL, data BLOB, flags INT)")
        self.con.execute(
            "CREATE INDEX IF NOT EXISTS idx_cft ON frames(channel, frame_id, ts)")
        self._last: dict[tuple, int] = {}   # (ch, fid) -> 已归档行数(增量游标)

    def flush(self) -> int:
        """归档自上次以来的新帧(每秒调用)。返回本次归档帧数。"""
        rows: list[tuple] = []
        with self.store._lock:
            for ch, msgs in self.store.idx.items():
                for fid, fr in msgs.items():
                    j = self._last.get((ch, fid), 0)
                    if j < len(fr):
                        for r in fr[j:]:
                            rows.append((ch, fid, r[0], r[1], int(r[2])))
                        self._last[(ch, fid)] = len(fr)
        if rows:
            self.con.executemany("INSERT INTO frames VALUES(?,?,?,?,?)", rows)
            self.con.commit()
        return len(rows)

    def query(self, ch: int, fid: int, start: float | None = None,
              end: float | None = None, limit: int = 100000) -> list:
        """历史归档查询(时间窗,复合索引)。"""
        sql = "SELECT ts, data, flags FROM frames WHERE channel=? AND frame_id=?"
        args: list = [ch, fid]
        if start is not None:
            sql += " AND ts >= ?"; args.append(start)
        if end is not None:
            sql += " AND ts <= ?"; args.append(end)
        sql += " ORDER BY ts LIMIT ?"; args.append(limit)
        return self.con.execute(sql, args).fetchall()

    def close(self):
        self.con.commit()
        self.con.close()
