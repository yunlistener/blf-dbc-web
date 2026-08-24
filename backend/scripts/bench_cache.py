"""实证:不同大小 BLF 的缓存方案性能对比(全扫构建 / pickle 落盘载入 / 查询性能)
运行:backend/.venv/bin/python scripts/bench_cache.py"""
import bisect
import pickle
import resource
import struct
import sys
import time
from collections import defaultdict
from pathlib import Path

import can
import numpy as np

DATA = Path(__file__).resolve().parents[2] / "data" / "uploads"
FILES = [
    "T1V-CH-DA-log-2026-06-08_13-39-50.blf",                     # 6MB
    "EPS-299716_2026-08-11T08_29_04_2026-08-11T08_39_59_can.blf",  # 89MB
    "EPS_299716_2026-08-11T09_10_00_2026-08-11T09_19_56_can.blf",  # 101MB
]


def full_scan(path):
    """一次全扫:stats + 两级索引(通道→报文→有序帧)"""
    t0 = time.time()
    by_ch = defaultdict(lambda: defaultdict(list))
    stats = {"total": 0, "by_id": defaultdict(int), "channels": set(), "first": None, "last": None}
    for m in can.BLFReader(str(path)):
        ts = m.timestamp
        ch = getattr(m, "channel", 0)
        if stats["first"] is None:
            stats["first"] = ts
        stats["last"] = ts
        stats["total"] += 1
        stats["by_id"][m.arbitration_id] += 1
        stats["channels"].add(ch)
        by_ch[ch][m.arbitration_id].append((ts, m.data, bool(getattr(m, "is_fd", False)), m.dlc))
    scan_s = time.time() - t0
    # 排序(帧按时间递增,双保险)
    t0 = time.time()
    for ch in by_ch:
        for fid in by_ch[ch]:
            by_ch[ch][fid].sort(key=lambda r: r[0])
    sort_s = time.time() - t0
    return by_ch, stats, scan_s, sort_s


def bench_query(by_ch, n=200_000):
    """查询基准:随机 (通道, 报文, 时间窗) 取帧切片"""
    channels = list(by_ch.keys())
    fid_pool = sorted({fid for ch in by_ch for fid in by_ch[ch]})
    rows = by_ch[channels[0]][fid_pool[0]] if fid_pool else []
    tmax = rows[-1][0] if rows else 1.0
    # dict + bisect(方案)
    t0 = time.time()
    hits = 0
    for _ in range(n):
        ch = channels[0]
        fid = fid_pool[0]
        r = by_ch[ch][fid]
        t = (tmax - 1.0) * (_ / n) + 0.5
        lo = bisect.bisect_left(r, t, key=lambda x: x[0])
        hi = bisect.bisect_left(r, t + 0.01, key=lambda x: x[0])
        hits += hi - lo
    dict_s = time.time() - t0
    # numpy searchsorted(对比)
    ts_arr = np.array([r[0] for r in rows], dtype=np.float64)
    t0 = time.time()
    for _ in range(n):
        t = (tmax - 1.0) * (_ / n) + 0.5
        lo = int(np.searchsorted(ts_arr, t, side="left"))
        hi = int(np.searchsorted(ts_arr, t + 0.01, side="left"))
    np_s = time.time() - t0
    return dict_s, np_s, hits


def pickle_roundtrip(by_ch, stats):
    payload = {
        "index": {ch: {fid: rows for fid, rows in by_ch[ch].items()} for ch in by_ch},
        "stats": {k: (dict(v) if isinstance(v, defaultdict) else v) for k, v in stats.items()},
    }
    t0 = time.time()
    blob = pickle.dumps(payload, protocol=4)
    dump_s = time.time() - t0
    t0 = time.time()
    back = pickle.loads(blob)
    load_s = time.time() - t0
    return len(blob), dump_s, load_s


def main():
    print(f"{'文件':<52}{'大小':>8}{'全扫':>8}{'排序':>7}{'索引pickle':>12}{'写盘':>8}{'载入':>8}{'查询20万次':>14}{'numpy对比':>12}{'内存':>8}")
    print("-" * 140)
    for name in FILES:
        p = DATA / name
        if not p.exists():
            print(f"{name}: 文件不存在,跳过")
            continue
        size_mb = p.stat().st_size / 1e6
        by_ch, stats, scan_s, sort_s = full_scan(p)
        blob_n, dump_s, load_s = pickle_roundtrip(by_ch, stats)
        dict_s, np_s, hits = bench_query(by_ch)
        mem_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        print(f"{name:<52}{size_mb:>7.1f}M{scan_s:>7.1f}s{sort_s:>6.2f}s{blob_n/1e6:>11.1f}M{dump_s:>7.2f}s{load_s:>7.2f}s{dict_s:>12.3f}s{np_s:>11.3f}s{mem_kb/1024:>7.1f}M")


if __name__ == "__main__":
    main()
