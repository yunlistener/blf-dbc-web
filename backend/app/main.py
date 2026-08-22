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
    # no-cache:开发期避免浏览器缓存旧版 JS/HTML 导致前后端版本不匹配
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True,
                               headers={"Cache-Control": "no-cache"}), name="frontend")
