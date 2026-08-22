"""配置 API:工程配置(总线类型/波特率/当前 BLF/DBC)持久化。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import PROJECT_ROOT, UPLOAD_DIR

router = APIRouter()

CONFIG_FILE = PROJECT_ROOT / "data" / "config.json"

# 默认配置:总线类型 / 波特率(CAN FD 双速率)
DEFAULT_CONFIG = {
    "bus_type": "canfd",          # can | canfd
    "baudrate_arb": 500000,       # 仲裁段波特率
    "baudrate_data": 2000000,     # 数据段波特率(CAN FD)
    "blf": None,                  # 当前 BLF 文件名
    "dbc": None,                  # 当前 DBC 文件名
}

VALID_BUS_TYPES = {"can", "canfd"}


def _load() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.is_file():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass  # 配置损坏时回落默认
    return cfg


def _save(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def _validate_file(name: Optional[str], suffix: str) -> None:
    if name is None:
        return
    path = UPLOAD_DIR / name
    if not path.is_file() or path.suffix.lower() != suffix:
        raise HTTPException(422, f"文件不存在或类型不符: {name}")


class ConfigIn(BaseModel):
    bus_type: Optional[str] = None
    baudrate_arb: Optional[int] = None
    baudrate_data: Optional[int] = None
    blf: Optional[str] = None
    dbc: Optional[str] = None


@router.get("")
def get_config():
    return _load()


@router.put("")
def put_config(body: ConfigIn):
    cfg = _load()
    if body.bus_type is not None:
        if body.bus_type not in VALID_BUS_TYPES:
            raise HTTPException(422, f"非法总线类型: {body.bus_type}(可选 can/canfd)")
        cfg["bus_type"] = body.bus_type
    if body.baudrate_arb is not None:
        if body.baudrate_arb <= 0:
            raise HTTPException(422, "仲裁段波特率必须为正整数")
        cfg["baudrate_arb"] = body.baudrate_arb
    if body.baudrate_data is not None:
        if body.baudrate_data <= 0:
            raise HTTPException(422, "数据段波特率必须为正整数")
        cfg["baudrate_data"] = body.baudrate_data
    if body.blf is not None:
        _validate_file(body.blf, ".blf")
        cfg["blf"] = body.blf
    if body.dbc is not None:
        _validate_file(body.dbc, ".dbc")
        cfg["dbc"] = body.dbc
    _save(cfg)
    return cfg
