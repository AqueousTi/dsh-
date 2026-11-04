"""随包 bge-small-zh-v1.5 的本机 OpenAI embeddings 接口。

固定使用 512 维随包模型；缺失时启动失败，不静默切换到其他向量空间。
启动：astrbot/venv/Scripts/python.exe -X utf8 astrbot/tools/embed_server.py
"""

import argparse
import base64
import os
import struct
import threading
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException
from starlette.concurrency import run_in_threadpool

_MODEL_NAME = "bge-small-zh-v1.5"
_DIMENSIONS = 512
_MAX_ITEMS = 32
_MAX_TEXT_CHARS = 4096
_MAX_TOTAL_CHARS = 32768
_HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SMALL = os.path.join(_HERE, "models", _MODEL_NAME)
_model = None
_model_lock = threading.Lock()
_inference_slot = threading.BoundedSemaphore(1)


def get_model():
    """并发安全地初始化唯一的随包模型，不进行网络下载。"""
    global _model
    with _model_lock:
        if _model is None:
            if not os.path.isfile(os.path.join(_SMALL, "config.json")):
                raise RuntimeError(f"缺少随包模型：{_SMALL}")
            from sentence_transformers import SentenceTransformer

            candidate = SentenceTransformer(_SMALL, local_files_only=True)
            if candidate.get_sentence_embedding_dimension() != _DIMENSIONS:
                raise RuntimeError("随包向量模型维度必须为 512，请核对模型文件")
            candidate.encode(["就绪检查"], normalize_embeddings=True, batch_size=1)
            _model = candidate
        return _model


@asynccontextmanager
async def lifespan(_app):
    await run_in_threadpool(get_model)
    yield


class BodyLimitMiddleware:
    """在 JSON 解析之前限制 embeddings 请求体，兼容分块传输。"""

    def __init__(self, app, max_bytes=128 * 1024):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await send({"type": "http.response.start", "status": 413,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"detail":"request body too large"}'})
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def limited_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, limited_receive, send)


app = FastAPI(lifespan=lifespan)
app.add_middleware(BodyLimitMiddleware)


@app.get("/health")
def health():
    ready = _model is not None
    if not ready:
        raise HTTPException(status_code=503, detail="model is not ready")
    return {"ok": True, "model": _MODEL_NAME, "dimensions": _DIMENSIONS, "model_loaded": ready}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": _MODEL_NAME, "object": "model"}]}


@app.post("/v1/embeddings")
def embeddings(payload: dict):
    # bge-m3/local-bge-m3 是旧配置的标识别名，响应始终报告实际小模型。
    if payload.get("model", _MODEL_NAME) not in {_MODEL_NAME, "bge-m3", "local-bge-m3"}:
        raise HTTPException(status_code=400, detail="unsupported embedding model")
    encoding = payload.get("encoding_format", "float")
    if encoding not in ("float", "base64"):
        raise HTTPException(status_code=400, detail="encoding_format must be float or base64")
    if payload.get("dimensions", _DIMENSIONS) != _DIMENSIONS:
        raise HTTPException(status_code=400, detail="embedding dimensions must be 512")
    text = payload.get("input")
    items = text if isinstance(text, list) else [text]
    if not items or not all(isinstance(item, str) and item.strip() for item in items):
        raise HTTPException(status_code=400, detail="input must be a nonempty string or list of nonempty strings")
    if (len(items) > _MAX_ITEMS or any(len(item) > _MAX_TEXT_CHARS for item in items)
            or sum(map(len, items)) > _MAX_TOTAL_CHARS):
        raise HTTPException(status_code=413, detail="embedding input exceeds batch or text limit")
    if not _inference_slot.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="embedding service is busy", headers={"Retry-After": "1"})
    try:
        model = get_model()
        vectors = model.encode(items, normalize_embeddings=True, batch_size=8)
        data = [{"object": "embedding", "index": i, "embedding": [float(x) for x in vector]}
                for i, vector in enumerate(vectors)]
        if len(data) != len(items) or any(len(item["embedding"]) != _DIMENSIONS for item in data):
            raise HTTPException(status_code=500, detail="embedding model returned inconsistent dimensions")
        if encoding == "base64":
            # OpenAI SDK 未显式传格式时会请求 base64，并按 float32 解码。
            for item in data:
                item["embedding"] = base64.b64encode(
                    struct.pack(f"<{_DIMENSIONS}f", *item["embedding"])
                ).decode("ascii")
        tokenized = model.tokenizer(items, truncation=True, max_length=model.max_seq_length)
        tokens = sum(len(ids) for ids in tokenized["input_ids"])
        return {"object": "list", "model": _MODEL_NAME, "data": data,
                "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}
    finally:
        _inference_slot.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("EMBED_PORT", 6198)))
    parser.add_argument("--host", choices=["127.0.0.1", "::1"], default="127.0.0.1")
    args = parser.parse_args()
    print(f"[embed] http://{args.host}:{args.port}，加载 {_MODEL_NAME}（512 维）后就绪", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
