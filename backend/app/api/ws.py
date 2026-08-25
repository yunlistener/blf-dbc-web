"""回放 WebSocket 网关(系统设计 §6):/ws/replay

协议(前后端一致):
  客户端 → 服务端:
    {"type":"config","blf":...,"dbc":...,"signals":[{frame_id,channel,signal},...]}
    {"type":"play","rate":1.0} | {"type":"pause"} | {"type":"stop"}
    {"type":"seek","t":10.0}
  服务端 → 客户端:
    {"type":"batch", seq, t1, frames, signals:{key:{times,values}}}  帧批次
    {"type":"progress","t":当前播放时间}                              进度
    {"type":"state","playing":..,"rate":..,"t":..,"dur":..}          状态
    {"type":"end","t":..}                                            播完
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import UPLOAD_DIR
from app.parsers.dbc_parser import load_database
from app.services.frame_source import BlfReplaySource
from app.services.playback import PlaybackEngine, SignalSub

router = APIRouter()

TICK = 0.02          # 推送节流间隔(秒)
BATCH_MAX = 8192     # 单批最大帧数


def _current_play_t(st: dict) -> float:
    """按墙钟 × 速率计算当前播放时间。"""
    return st["play_t"] + (time.monotonic() - st["wall_start"]) * st["rate"]


async def _pump(ws: WebSocket, engine: PlaybackEngine, st: dict) -> None:
    """播放泵:按速率把源推进到当前播放时间,逐批推送。"""
    while st["playing"]:
        if engine.ended:
            st["playing"] = False
            try:
                await ws.send_json({"type": "end", "t": st["play_t"]})
            except Exception:
                pass
            return
        play_t = st["play_t"] + (time.monotonic() - st["wall_start"]) * st["rate"]
        st["wall_start"] = time.monotonic()   # ⚠️ 每批刷新:play_t 纯墙钟驱动,不被数据 t1 污染
        try:
            batch = engine.advance_to(play_t, BATCH_MAX)
        except Exception as e:
            import traceback
            print(f"[ws] advance_to error: {e}")
            traceback.print_exc()
            st["playing"] = False
            return
        if batch is None:
            st["playing"] = False
            try:
                await ws.send_json({"type": "end", "t": st["play_t"]})
            except Exception as e:
                print(f"[ws] send end error: {e}")
            return
        st["play_t"] = play_t   # 播放时间基准(墙钟),非数据 t1
        try:
            await ws.send_json(batch)
            await ws.send_json({"type": "progress", "t": batch["t1"]})
        except Exception as e:
            import traceback
            print(f"[ws] pump send error: {e}")
            traceback.print_exc()
            st["playing"] = False
            return
        await asyncio.sleep(TICK)


@router.websocket("/ws/replay")
async def replay_ws(ws: WebSocket) -> None:
    await ws.accept()
    engine: Optional[PlaybackEngine] = None
    st = {"playing": False, "rate": 1.0, "wall_start": 0.0, "play_t": 0.0, "dur": 0.0}
    pump_task: Optional[asyncio.Task] = None
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")

            if mtype == "config":
                print(f"[ws] config: blf={msg.get('blf')} signals={len(msg.get('signals', []))}")
                # 停旧泵,重建会话(源+引擎,按通道 DBC 映射)
                if pump_task:
                    pump_task.cancel()
                    pump_task = None
                st["playing"] = False
                blf_path = UPLOAD_DIR / msg["blf"]
                dbs: dict = {}
                subs: list[SignalSub] = []
                for s in msg.get("signals", []):
                    dbc_name = s.get("dbc") or ""
                    if dbc_name and dbc_name not in dbs:
                        dbs[s["channel"]] = load_database(UPLOAD_DIR / dbc_name)
                    subs.append(SignalSub(s["frame_id"], s["channel"], s["signal"], dbc_name))
                # ⚠️ 源选择:索引构建中且 store 未裁剪(早期数据在)→ LivePlaySource 边扫边播;
                #            已裁剪(大文件环形上限吃掉早期数据)/未在构建 → BlfReplaySource(完整索引)
                from app.services import blf_cache
                from app.services.frame_source import LivePlaySource
                if str(blf_path) in blf_cache._building:
                    fs = blf_cache.live_store.first_ts
                    earliest = blf_cache.live_store.earliest_ts()
                    trimmed = earliest is None or (fs is not None and earliest - fs > 1.0)
                    if trimmed:
                        print(f"[ws] 构建中但 store 已裁剪(earliest={earliest})→ 等构建完成用完整索引")
                        src = BlfReplaySource(blf_path)   # load_index 内部等待构建完成
                    else:
                        t0 = fs or 0.0
                        src = LivePlaySource(blf_cache.live_store, t0=t0)
                        print(f"[ws] 构建中 → LivePlaySource(t0={t0}, store={len(blf_cache.live_store)}帧)")
                else:
                    src = BlfReplaySource(blf_path)
                engine = PlaybackEngine(src, dbs, subs)
                st.update(play_t=0.0, rate=1.0, dur=src.time_range[1],
                          wall_start=time.monotonic())   # ⚠️ wall_start 必须初始化,否则 play 时算出巨大播放时间
                await ws.send_json({"type": "state", "playing": False,
                                    "rate": 1.0, "t": 0.0, "dur": st["dur"]})

            elif mtype == "play" and engine is not None:
                print(f"[ws] play: rate={msg.get('rate')}")
                st["rate"] = float(msg.get("rate", 1.0))
                # play_t 保持(config 时为 0 / 暂停后续播);wall_start 从现在起
                st["wall_start"] = time.monotonic()
                st["playing"] = True
                if pump_task is None or pump_task.done():
                    pump_task = asyncio.create_task(_pump(ws, engine, st))
                await ws.send_json({"type": "state", "playing": True,
                                    "rate": st["rate"], "t": st["play_t"], "dur": st["dur"]})

            elif mtype == "pause":
                if st["playing"]:
                    st["play_t"] = _current_play_t(st)
                st["playing"] = False
                await ws.send_json({"type": "state", "playing": False,
                                    "rate": st["rate"], "t": st["play_t"], "dur": st["dur"]})

            elif mtype == "stop" and engine is not None:
                st["playing"] = False
                engine.seek(0.0)
                st["play_t"] = 0.0
                await ws.send_json({"type": "state", "playing": False,
                                    "rate": st["rate"], "t": 0.0, "dur": st["dur"]})

            elif mtype == "seek" and engine is not None:
                t = float(msg.get("t", 0.0))
                if st["playing"]:
                    st["play_t"] = _current_play_t(st)
                engine.seek(t)
                st["play_t"] = t
                st["wall_start"] = time.monotonic()
                await ws.send_json({"type": "state", "playing": st["playing"],
                                    "rate": st["rate"], "t": t, "dur": st["dur"]})

    except WebSocketDisconnect:
        st["playing"] = False
        if pump_task:
            pump_task.cancel()
    except Exception as e:
        import traceback
        traceback.print_exc()
        st["playing"] = False
        if pump_task:
            pump_task.cancel()
        try:
            await ws.close(code=1011)
        except Exception:
            pass
