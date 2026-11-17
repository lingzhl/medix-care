"""HTTP entrypoint for MediX Care."""

import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from httpx import HTTPError

from .engine import ChatRequest, ChatResponse, respond


app = FastAPI(title="MediX Care", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.get("/api/health")
async def health() -> dict[str, str | bool]:
    mode = os.getenv("MEDIX_MODE", "demo")
    return {"status": "ok", "mode": mode, "vision_enabled": mode == "live" and os.getenv("MEDIX_MODEL_SUPPORTS_VISION") == "true"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, x_medix_access_token: str | None = Header(default=None)) -> ChatResponse:
    mode = os.getenv("MEDIX_MODE", "demo")
    if mode not in {"demo", "live"}:
        raise HTTPException(status_code=503, detail="服务运行模式配置错误")
    if mode == "live":
        required = os.getenv("MEDIX_ACCESS_TOKEN")
        if not required or not x_medix_access_token or not secrets.compare_digest(x_medix_access_token, required):
            raise HTTPException(status_code=401, detail="实时模型模式需要有效访问口令")
        if not all(os.getenv(name) for name in ("MEDIX_MODEL_BASE_URL", "MEDIX_MODEL_NAME", "MEDIX_MODEL_API_KEY")):
            raise HTTPException(status_code=503, detail="实时模型服务尚未配置")
        if payload.image and os.getenv("MEDIX_MODEL_SUPPORTS_VISION") != "true":
            raise HTTPException(status_code=400, detail="当前模型未启用图像理解；请移除图片或配置视觉模型")
    try:
        return await respond(payload, mode)
    except (HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="模型服务暂时不可用，请稍后重试") from exc


dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if dist.exists():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}")
    async def frontend(path: str) -> FileResponse:
        target = (dist / path).resolve()
        if target.is_file() and dist in target.parents:
            return FileResponse(target)
        return FileResponse(dist / "index.html")
