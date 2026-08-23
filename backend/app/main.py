"""FastAPI 入口。"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api import blf, config_api, dbc, files, ws

app = FastAPI(title="BLF/DBC 网页解析平台", version="0.1.0")

app.include_router(files.router, prefix="/api/files", tags=["files"])
app.include_router(config_api.router, prefix="/api/config", tags=["config"])
app.include_router(dbc.router, prefix="/api/dbc", tags=["dbc"])
app.include_router(blf.router, prefix="/api/blf", tags=["blf"])
app.include_router(ws.router, tags=["replay"])   # /ws/replay


@app.get("/api/health")
def health():
    return {"status": "ok", "version": app.version}


# 前端静态资源(放在最后挂载,避免吞掉 API 路由)
FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")


@app.middleware("http")
async def no_cache_static(request, call_next):
    """静态资源加 Cache-Control: no-cache,避免浏览器缓存旧版 JS/HTML。"""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith(("/js/", "/css/", "/vendor/")):
        response.headers["Cache-Control"] = "no-cache"
    return response
