"""The HTTP surface the frontend calls (`frontend/lib/core/client.ts`).

Same routes and shapes as the old core/ server, backed by VIDRA. The logic is
in `engine.py`; this file validates and translates errors.

    uv run uvicorn app:app --port 8077
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

import blobs
import engine

app = FastAPI(title="FalconVQA backend", description="VIDRA behind core's API.")

API_TOKEN = os.environ.get("CORE_API_TOKEN", "").strip()
# Browsers load /media/ directly, and PUT to /uploads/<id> with no token: an
# upload id is unguessable, single-use and expires, which is the authority.
_OPEN = ("/health", "/docs", "/openapi.json", "/media/", "/uploads/")
_ROOT = "/"


@app.middleware("http")
async def require_token(request: Request, call_next):
    path = request.url.path
    if API_TOKEN and path != _ROOT and not path.startswith(_OPEN):
        if request.headers.get("x-core-token") != API_TOKEN:
            return JSONResponse({"detail": "Invalid or missing X-Core-Token"}, status_code=401)
    return await call_next(request)


# Added last, so it runs first: preflight requests carry no token.
app.add_middleware(CORSMiddleware, allow_origins=blobs.ORIGINS,
                   allow_methods=["GET", "HEAD", "PUT"], allow_headers=["*"])


@app.get("/", include_in_schema=False)
def root():
    # Nothing lives here; the frontend is the UI. Send a browser to the API docs.
    return RedirectResponse("/docs")


@app.get("/health")
def health():
    return engine.health()


@app.get("/media/{video_id}/poster.jpg")
def poster(video_id: str):
    path = engine.poster_path(video_id)
    if not path.exists():
        raise HTTPException(404, f"No poster for {video_id!r}")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/media/{video_id}")
def media(video_id: str):
    found = engine.media(video_id)
    if found is None:
        raise HTTPException(404, f"No video {video_id!r}")
    kind, where = found
    if kind == "redirect":
        # 307: not cached, so an expired signed URL is never replayed.
        return RedirectResponse(where, status_code=307)
    return FileResponse(where)


# --------------------------------------------------------------------- uploads

class UploadRequest(BaseModel):
    filename: str
    content_type: Optional[str] = None


@app.post("/uploads")
def create_upload(request: UploadRequest):
    """A one-time URL to PUT a video file to; ingest it as `upload:<upload_id>`."""
    return engine.create_upload(request.filename, request.content_type)


@app.put("/uploads/{upload_id}", include_in_schema=False)
async def receive_upload(upload_id: str, request: Request):
    # Only used without blob storage; with it, browsers PUT to Azure directly.
    target = engine.upload_target(upload_id)
    if target is None:
        raise HTTPException(404, f"No open upload {upload_id!r}")
    size = 0
    with target.open("wb") as out:
        async for block in request.stream():
            out.write(block)
            size += len(block)
    return {"upload_id": upload_id, "size_bytes": size}


@app.get("/analyzers")
def analyzers():
    return {"analyzers": list(engine.ANALYZERS), "fields": ["combined"],
            "exclusive_groups": engine.EXCLUSIVE_GROUPS,
            "descriptions": engine.ANALYZERS}


@app.get("/schema")
def schema():
    return {"analyzers": list(engine.ANALYZERS), "exclusive_groups": engine.EXCLUSIVE_GROUPS,
            **engine.schema()}


# ---------------------------------------------------------------------- ingest

class IngestRequest(BaseModel):
    url: str
    analyzers: str = "default_video"
    mode: str = "preset"
    preset: str = "audio_video"
    interval: Optional[float] = None
    speaker: Optional[float] = None
    silence: Optional[float] = None
    cut: Optional[float] = None
    semantic: Optional[float] = None
    min_duration: float = 5.0
    max_duration: float = 20.0


@app.post("/videos/url", status_code=202)
def ingest_url(request: IngestRequest):
    ids = [a.strip() for a in request.analyzers.split(",") if a.strip()]
    unknown = [a for a in ids if a not in engine.ANALYZERS]
    if unknown or not ids:
        raise HTTPException(400, f"Unknown or missing analyzers {unknown}; "
                                 f"have {list(engine.ANALYZERS)}")
    if set(engine.EXCLUSIVE_GROUPS[0]) <= set(ids):
        raise HTTPException(400, "transcript and diarization are mutually exclusive")
    if request.mode not in ("preset", "weights", "interval"):
        raise HTTPException(400, f"Unknown mode {request.mode!r}; expected preset|weights|interval")
    if not request.url.startswith(("http://", "https://", "upload:")):
        raise HTTPException(400, "url must be an http(s) link to a video file, "
                                 "or upload:<upload_id> from POST /uploads")
    weights = {k: v for k in ("speaker", "silence", "cut", "semantic")
               if (v := getattr(request, k)) is not None}
    job = engine.create_job(source=request.url, analyzers=ids)
    engine.submit(job["job_id"], engine.ingest, request.url, ids, request.mode,
                  request.preset, weights)
    return {"job_id": job["job_id"], "status": "queued", "source": request.url}


@app.get("/jobs/{job_id}")
def job(job_id: str):
    found = engine.get_job(job_id)
    if found is None:
        raise HTTPException(404, f"No such job {job_id!r}")
    return found


# ----------------------------------------------------------------------- reads

def _or_404(value, what: str):
    if value is None:
        raise HTTPException(404, f"No such video {what!r}")
    return value


@app.get("/videos/{video_id}")
def get_video(video_id: str):
    return _or_404(engine.get_video(video_id), video_id)


@app.delete("/videos/{video_id}")
def delete_video(video_id: str):
    return _or_404(engine.delete_video(video_id), video_id)


@app.get("/videos/{video_id}/chunks")
def get_chunks(video_id: str, analyzer: Optional[str] = None,
               after: Optional[float] = None, before: Optional[float] = None,
               chunk_ids: Optional[str] = Query(None, description="Comma-separated chunk ids"),
               limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
               verbose: bool = False):
    try:
        ids = [int(x) for x in chunk_ids.split(",") if x.strip()] if chunk_ids else None
        found = engine.get_chunks(video_id, analyzer, after, before, ids, limit, offset)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _or_404(found, video_id)


@app.get("/videos/{video_id}/chunks/{chunk_id}")
def get_chunk(video_id: str, chunk_id: int):
    found = engine.get_chunk(video_id, chunk_id)
    if found is None:
        raise HTTPException(404, f"No chunk {chunk_id} in video {video_id!r}")
    return found


@app.get("/videos/{video_id}/aggregates")
def get_aggregates(video_id: str, aggregator: Optional[str] = None):
    try:
        return _or_404(engine.get_aggregates(video_id, aggregator), video_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/videos/{video_id}/aggregates", status_code=202)
def run_aggregates(video_id: str,
                   aggregators_csv: Optional[str] = Form(None, alias="aggregators"),
                   force: bool = Query(True)):
    _or_404(engine.get_video(video_id), video_id)
    names = [a.strip() for a in aggregators_csv.split(",") if a.strip()] if aggregators_csv else None
    job = engine.create_job(video_id=video_id, aggregators=names)
    engine.submit(job["job_id"], engine.run_aggregates, video_id, names, force)
    return {"job_id": job["job_id"], "status": "queued", "video_id": video_id}


@app.get("/videos/{video_id}/entities")
def get_entities(video_id: str, min_appearances: int = Query(1, ge=1)):
    try:
        return _or_404(engine.get_entities(video_id, min_appearances), video_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


# ---------------------------------------------------------------------- search

class QueryRequest(BaseModel):
    text: str
    video_ids: Optional[list[str]] = None
    analyzer: Optional[str] = "default_video"
    field: str = "combined"
    limit: int = Field(5, ge=1, le=50)
    score_threshold: Optional[float] = None
    synthesize: bool = True
    detail: str = "standard"
    filters: dict = Field(default_factory=dict)


@app.post("/query")
def query(request: QueryRequest):
    if request.analyzer and request.analyzer not in engine.ANALYZERS:
        raise HTTPException(400, f"Unknown analyzer {request.analyzer!r}")
    if request.detail not in ("minimal", "standard", "full"):
        raise HTTPException(400, f"Unknown detail {request.detail!r}")
    if request.filters:
        raise HTTPException(400, "filters are not supported by this backend")
    return engine.query(request.text, request.video_ids, request.analyzer, request.limit,
                        request.synthesize, request.detail)


class AskRequest(BaseModel):
    question: str
    video_ids: Optional[list[str]] = None
    analyzer: Optional[str] = None
    limit: int = Field(6, ge=1, le=20)


@app.post("/ask")
def ask(request: AskRequest):
    if request.analyzer and request.analyzer not in engine.ANALYZERS:
        raise HTTPException(400, f"Unknown analyzer {request.analyzer!r}")
    return engine.ask(request.question, request.video_ids, request.analyzer, request.limit)
