"""DBC API:报文列表 / 信号详情。"""
from fastapi import APIRouter, HTTPException

from app.config import UPLOAD_DIR
from app.parsers.dbc_parser import load_database, message_detail, messages_summary

router = APIRouter()


def _db(name: str):
    path = UPLOAD_DIR / name
    if not path.is_file() or path.suffix.lower() != ".dbc":
        raise HTTPException(404, f"DBC 文件不存在: {name}")
    try:
        return load_database(path)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/{name}/messages")
def get_messages(name: str):
    return {"dbc": name, "messages": messages_summary(_db(name))}


@router.get("/{name}/messages/{frame_id}")
def get_message(name: str, frame_id: str):
    """frame_id 支持十进制或 0x 十六进制。"""
    try:
        fid = int(frame_id, 0)
    except ValueError:
        raise HTTPException(422, f"非法报文 ID: {frame_id}")
    detail = message_detail(_db(name), fid)
    if detail is None:
        raise HTTPException(404, f"报文 {hex(fid)} 不存在")
    return detail
