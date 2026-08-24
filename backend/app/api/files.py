"""文件管理:上传 / 列表 / 删除。"""
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import ALLOWED_EXTENSIONS, UPLOAD_DIR
from app.services.blf_cache import invalidate as cache_invalidate

router = APIRouter()


BLF_MAGIC = b"LOGG"


def detect_kind(path: Path) -> str:
    """按内容识别文件类型(扩展名不可靠:Windows 上传 .log/.txt 内容可能是 BLF/DBC)。
    BLF:文件头 "LOGG";DBC:文本含 VERSION/BO_/SG_ 特征。识别不出按扩展名兜底。"""
    try:
        with path.open("rb") as f:
            head = f.read(256)
    except OSError:
        return path.suffix.lower()
    if head[:4] == BLF_MAGIC:
        return ".blf"
    text = head.decode("utf-8", errors="ignore").lstrip("\ufeff \t")
    if text.startswith("VERSION") or b"BO_" in head or b"SG_ " in head:
        return ".dbc"
    return path.suffix.lower()


@router.get("")
def list_files():
    files = []
    for p in sorted(UPLOAD_DIR.glob("*")):
        if p.is_file():
            files.append({
                "name": p.name,
                "size": p.stat().st_size,
                "kind": detect_kind(p),
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
    cache_invalidate(dest)   # 同名覆盖/重传 → 旧索引失效
    return {"name": dest.name, "size": dest.stat().st_size, "kind": detect_kind(dest)}


@router.delete("/{name}")
def delete_file(name: str):
    dest = (UPLOAD_DIR / name).resolve()
    if not dest.is_relative_to(UPLOAD_DIR.resolve()) or not dest.is_file():
        raise HTTPException(404, "文件不存在")
    dest.unlink()
    cache_invalidate(dest)
    return {"deleted": name}
