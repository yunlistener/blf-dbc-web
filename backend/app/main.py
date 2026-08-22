"""FastAPI 入口。"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import blf, dbc, files

app = FastAPI(title="BLF/DBC 网页解析平台", version="0.1.0")

app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(dbc.router, prefix="/api/dbc", tags=["dbc"])
app.include_router(blf.router, prefix="/api/blf", tags=["blf"])


@app.get("/api/health")
def health():
    return {"status": "ok", "version": app.version}


# 前端静态资源(放在最后挂载,避免吞掉 API 路由)
FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
