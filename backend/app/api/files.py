"""文件管理:上传 / 列表 / 删除。"""
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import ALLOWED_EXTENSIONS, UPLOAD_DIR

router = APIRouter()


@router.get("")
def list_files():
    files = []
    for p in sorted(UPLOAD_DIR.glob("*")):
        if p.is_file():
            files.append({
                "name": p.name,
                "size": p.stat().st_size,
                "kind": p.suffix.lower(),
            })
    return {"files": files}


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"仅支持 {sorted(ALLOWED_EXTENSIONS)} 文件")

    name = Path(file.filename).name  # 防路径穿越
    dest = UPLOAD_DIR / name
    if dest.exists():  # 重名加时间戳
        dest = UPLOAD_DIR / f"{dest.stem}_{int(time.time())}{dest.suffix}"

    with dest.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            f.write(chunk)
    return {"name": dest.name, "size": dest.stat().st_size, "kind": dest.suffix.lower()}


@router.delete("/{name}")
def delete_file(name: str):
    dest = (UPLOAD_DIR / name).resolve()
    if not dest.is_relative_to(UPLOAD_DIR.resolve()) or not dest.is_file():
        raise HTTPException(404, "文件不存在")
    dest.unlink()
    return {"deleted": name}
