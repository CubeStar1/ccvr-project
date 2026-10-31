"""Everything below the HTTP layer: ingest jobs, and VIDRA's output read back
in the shapes the frontend was written against (core's).

VIDRA writes one folder per video under `data/out/<video_id>/`; that folder is
also the search index (`Folder`). Alongside it this module keeps:

    data/sources/<video_id><ext>   the video itself, which `/media/<id>` plays
    data/videos/<video_id>.json    what the frontend asked for, and where it came from
    data/jobs/<job_id>.json        job state, so a restart does not lose it
    data/posters/<video_id>.jpg    one frame for the video card
    data/uploads/<upload_id>…      a browser upload until its ingest takes it

A video arrives either from a URL, which this module downloads, or as an upload:
`create_upload` hands the browser a one-time URL to PUT the file to, and an
ingest of `upload:<upload_id>` takes it from there.

When `blobs` is configured, all of it is mirrored to Azure Blob Storage and the
local folder is a cache: a video's documents come back on first use, its source
only for a re-index, and uploads go straight from the browser to the container.

Vocabulary: the frontend speaks core's analyzer ids; VIDRA has samplers (which
frames to keep and describe) plus the soundtrack. `ANALYZERS` is the mapping.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

import httpx

import vidra
from vidra import Folder, Models, aggregates
from vidra.shared.reporting.errors import Refused
from vidra.video_rag import search
from vidra.video_rag.offline import driver as video_rag
from vidra import workflow as vidra_workflow

import blobs

ROOT = Path(__file__).resolve().parent
vidra.configure(env_file=ROOT / ".env")

DATA = Path(os.environ.get("BACKEND_DATA", ROOT / "data"))
OUT, SOURCES, META, JOBS, POSTERS, UPLOADS = (
    DATA / d for d in ("out", "sources", "videos", "jobs", "posters", "uploads"))
for directory in (OUT, SOURCES, META, JOBS, POSTERS, UPLOADS):
    directory.mkdir(parents=True, exist_ok=True)

#: Where the browser reaches this server, for media, poster and upload URLs.
#: Playback URLs are stored on the frontend's rows, so keep this stable.
PUBLIC_URL = os.environ.get("BACKEND_PUBLIC_URL", "http://127.0.0.1:8077").rstrip("/")
#: The costliest aggregators an ingest runs: free | local | llm. `llm` bills
#: summary, chapters, events and the entity accounts, and is what the UI shows.
TIER = os.environ.get("VIDRA_TIER", "llm")

MODELS = Models()                    # OpenAI for every role; the key comes from .env
DATABASE = Folder(OUT)

# ------------------------------------------------------------------ vocabulary

ANALYZERS: dict[str, str] = {
    "default_video": "Describe each chunk's frames with the vision model",
    "transcript": "Whisper transcript of the soundtrack",
    "diarization": "Transcript with speaker turns (Whisper + pyannote)",
    "ocr": "On-screen text, sampled where text appears",
    "people": "People, sampled where YOLO sees them change",
    "object_detection": "Objects, sampled where detections change",
}
#: Picture analyzers -> the VIDRA sampler that implements each.
SAMPLER_OF = {"default_video": "uniform", "ocr": "text", "people": "yolo",
              "object_detection": "objects"}
AUDIO = {"transcript", "diarization"}
EXCLUSIVE_GROUPS = [["diarization", "transcript"]]

#: VIDRA aggregate ids -> the names the frontend's agent tools ask for.
AGGREGATE_NAME = {"speakers": "speaker_stats", "entities:people": "entities",
                  "entities:objects": "object_entities", "entities:text": "text_entities"}
VIDRA_NAME = {v: k for k, v in AGGREGATE_NAME.items()}

#: Pipeline components -> the stage label a video card shows.
STAGE = {"media": "fetching", "audio": "transcribing", "boundaries.evidence": "chunking",
         "boundaries": "chunking", "video": "sampling", "cut": "transcribing",
         "describe": "analyzing", "glance": "indexing", "embed": "indexing",
         "aggregate": "aggregating"}


def public_name(vidra_id: str) -> str:
    return AGGREGATE_NAME.get(vidra_id, vidra_id)


def make_samplers(analyzer_ids: list[str]) -> list[Any]:
    from vidra.video_rag.samplers import Objects, Text, Uniform, Yolo
    build = {"uniform": Uniform, "text": Text, "yolo": Yolo, "objects": Objects}
    return [build[SAMPLER_OF[a]]() for a in analyzer_ids if a in SAMPLER_OF]


def policy_for(mode: str, preset: Optional[str], weights: dict[str, float],
               use_video: bool, use_audio: bool) -> str:
    """Core's chunking modes, onto VIDRA's four grid policies."""
    if mode == "interval":
        return "uniform"
    if mode == "weights" and weights:
        strongest = max(weights, key=lambda k: weights[k] or 0)
        wanted = {"speaker": "speaker", "silence": "vad", "cut": "scene",
                  "semantic": "scene"}.get(strongest, "scene")
    else:
        wanted = {"audio": "vad", "video": "scene"}.get(preset or "", "scene")
    if vidra_needs(wanted) == "audio" and not use_audio:
        return "scene" if use_video else "uniform"
    if vidra_needs(wanted) == "video" and not use_video:
        return "vad" if use_audio else "uniform"
    return wanted


def vidra_needs(policy: str) -> Optional[str]:
    from vidra.video_rag.offline.boundaries import POLICIES
    return POLICIES.get(policy)


# ------------------------------------------------------------------------ jobs

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
#: One at a time: every ingest loads Whisper, YOLO and friends onto one GPU.
_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ingest")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _save_job(job: dict[str, Any]) -> None:
    path = JOBS / f"{job['job_id']}.json"
    path.write_text(json.dumps(job, default=str))
    blobs.upload(DATA, path)


def create_job(**detail: Any) -> dict[str, Any]:
    job = {"job_id": uuid.uuid4().hex[:12], "status": "queued", "stage": "queued",
           "detail": detail, "result": None, "error": None,
           "created_at": _now(), "updated_at": _now()}
    with _lock:
        _jobs[job["job_id"]] = job
        _save_job(job)
    return job


def update_job(job_id: str, **changes: Any) -> None:
    with _lock:
        job = _jobs[job_id]
        job.update(changes, updated_at=_now())
        _save_job(job)


def get_job(job_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        if job_id in _jobs:
            return dict(_jobs[job_id])
    path = JOBS / f"{job_id}.json"
    if not path.exists() and re.fullmatch(r"[0-9a-f]{12}", job_id):
        blobs.download(DATA, f"jobs/{job_id}.json")
    if not path.exists():
        return None
    job = json.loads(path.read_text())
    if job["status"] in ("queued", "running"):
        # Its worker died with the previous process.
        job.update(status="failed", error="the server restarted while this job ran")
    return job


def submit(job_id: str, fn: Any, *args: Any, **kwargs: Any) -> None:
    def run() -> None:
        update_job(job_id, status="running")
        try:
            result = fn(job_id, *args, **kwargs)
            update_job(job_id, status="done", stage="complete", result=result)
        except Exception as exc:                      # surfaced on the video card
            update_job(job_id, status="failed", error=f"{type(exc).__name__}: {exc}")
    _worker.submit(run)


# ---------------------------------------------------------------------- ingest

def _filename_of(url: str, content_type: Optional[str]) -> str:
    name = Path(unquote(urlparse(url).path)).name
    if Path(name).suffix:
        return name
    return f"{name or 'video'}{mimetypes.guess_extension(content_type or '') or '.mp4'}"


def download(job_id: str, url: str) -> tuple[str, Path, str, int]:
    """Fetch `url`; the video id is the hash of its bytes, as in core."""
    update_job(job_id, stage="fetching")
    temp = SOURCES / f".{job_id}.part"
    digest = hashlib.sha256()
    with httpx.stream("GET", url, follow_redirects=True, timeout=60) as response:
        response.raise_for_status()
        filename = _filename_of(str(response.url), response.headers.get("content-type"))
        with temp.open("wb") as out:
            for block in response.iter_bytes(1 << 20):
                digest.update(block)
                out.write(block)
    video_id = digest.hexdigest()[:16]
    source = SOURCES / f"{video_id}{Path(filename).suffix.lower() or '.mp4'}"
    temp.replace(source)
    return video_id, source, filename, source.stat().st_size


def _poster(video_id: str, source: Path) -> Optional[str]:
    import cv2
    capture = cv2.VideoCapture(str(source))
    try:
        capture.set(cv2.CAP_PROP_POS_MSEC, 1000)
        ok, frame = capture.read()
    finally:
        capture.release()
    if not ok:
        return None
    cv2.imwrite(str(POSTERS / f"{video_id}.jpg"), frame)
    return f"{PUBLIC_URL}/media/{video_id}/poster.jpg"


# --------------------------------------------------------------------- uploads

#: How long a browser has to start its PUT after asking for an upload URL.
UPLOAD_MINUTES = 30


def _safe_name(filename: str) -> str:
    name = re.sub(r"[^\w.\-]+", "_", Path(filename).name).strip("._") or "video"
    return name if Path(name).suffix else f"{name}.mp4"


def _read_upload(upload_id: str) -> Optional[dict[str, Any]]:
    if not re.fullmatch(r"[0-9a-f]{32}", upload_id):
        return None
    path = UPLOADS / f"{upload_id}.json"
    if not path.exists():
        blobs.download(DATA, f"uploads/{upload_id}.json")
    return _read(path)


def _save_upload(record: dict[str, Any]) -> None:
    path = UPLOADS / f"{record['upload_id']}.json"
    path.write_text(json.dumps(record))
    blobs.upload(DATA, path)


def create_upload(filename: str, content_type: Optional[str]) -> dict[str, Any]:
    """A one-time URL the browser PUTs a video file to: Azure Blob Storage when
    configured, else this server. Ingest it afterwards as `upload:<upload_id>`."""
    upload_id = uuid.uuid4().hex
    name = _safe_name(filename)
    kind = content_type or mimetypes.guess_type(name)[0] or "video/mp4"
    expires = datetime.now(timezone.utc) + timedelta(minutes=UPLOAD_MINUTES)
    _save_upload({"upload_id": upload_id, "filename": name, "content_type": kind,
                  "expires_at": expires.isoformat(), "video_id": None})
    if blobs.enabled():
        url = blobs.sas_url(f"uploads/{upload_id}/{name}", write=True, minutes=UPLOAD_MINUTES)
        headers = {"x-ms-blob-type": "BlockBlob", "Content-Type": kind}
    else:
        url, headers = f"{PUBLIC_URL}/uploads/{upload_id}", {"Content-Type": kind}
    return {"upload_id": upload_id, "source": f"upload:{upload_id}", "method": "PUT",
            "upload_url": url, "headers": headers, "expires_at": expires.isoformat()}


def upload_target(upload_id: str) -> Optional[Path]:
    """Where this server writes a PUT upload, or None when the id is unknown,
    expired, already used, or uploads go to blob storage instead."""
    record = None if blobs.enabled() else _read_upload(upload_id)
    if record is None or record["video_id"] \
            or datetime.fromisoformat(record["expires_at"]) < datetime.now(timezone.utc):
        return None
    target = UPLOADS / upload_id / record["filename"]
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def _source_of(meta: dict[str, Any]) -> Path:
    # By name, so a moved data folder still resolves.
    return SOURCES / Path(meta["storage_path"]).name


def _take_upload(job_id: str, upload_id: str) -> tuple[str, Path, str, int]:
    """An upload, as a source: hashed into its video id and moved to `sources/`.
    Ingesting the same upload again (a re-index) reuses the stored source."""
    update_job(job_id, stage="fetching")
    record = _read_upload(upload_id)
    if record is None:
        raise LookupError(f"No upload {upload_id!r}")
    name = record["filename"]
    if record["video_id"]:
        meta = _meta(record["video_id"])
        if meta is None:
            raise LookupError("This upload's video was deleted; upload the file again")
        source = _source_of(meta)
        if not source.exists():
            blobs.download(DATA, f"sources/{source.name}")
        return record["video_id"], source, meta["filename"], source.stat().st_size

    received = UPLOADS / upload_id / name
    if not received.exists():
        blobs.download(DATA, f"uploads/{upload_id}/{name}")
    if not received.exists():
        raise LookupError(f"Upload {upload_id!r} was never received")
    digest = hashlib.sha256()
    with received.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    video_id = digest.hexdigest()[:16]
    source = SOURCES / f"{video_id}{Path(name).suffix.lower()}"
    received.replace(source)
    shutil.rmtree(UPLOADS / upload_id, ignore_errors=True)
    blobs.delete(f"uploads/{upload_id}/")
    _save_upload({**record, "video_id": video_id})
    return video_id, source, name, source.stat().st_size


def media_url(video_id: str) -> str:
    return f"{PUBLIC_URL}/media/{video_id}"


def media(video_id: str) -> Optional[tuple[str, Any]]:
    """How to serve a video: ("redirect", signed blob URL) or ("file", path)."""
    meta = _meta(video_id)
    if meta is None:
        return None
    source = _source_of(meta)
    if blobs.enabled():
        return "redirect", blobs.sas_url(f"sources/{source.name}", minutes=180)
    return ("file", source) if source.exists() else None


def ingest(job_id: str, url: str, analyzer_ids: list[str], mode: str,
           preset: Optional[str], weights: dict[str, float]) -> dict[str, Any]:
    if url.startswith("upload:"):
        video_id, source, filename, size = _take_upload(job_id, url.removeprefix("upload:"))
    else:
        video_id, source, filename, size = download(job_id, url)
    use_audio = bool(AUDIO & set(analyzer_ids))
    samplers = make_samplers(analyzer_ids)
    use_video = bool(samplers)
    policy = policy_for(mode, preset, weights, use_video, use_audio)

    def on_step(component: str, produced: Any) -> None:
        update_job(job_id, stage=STAGE.get(component, component))

    def run(policy: str) -> Any:
        return vidra_workflow.workflow(
            source, into=OUT, video_id=video_id, name=filename, policy=policy,
            use_video=use_video, use_audio=use_audio, sampler=samplers or None,
            models=MODELS, tier=TIER, database=DATABASE, on_step=on_step)

    try:
        run_ = run(policy)
    except Refused as exc:
        # An audio policy on a file with no soundtrack: fall back to a fixed grid.
        if "stream" not in str(exc) or policy == "uniform":
            raise
        policy = "uniform"
        run_ = run(policy)

    meta = {"video_id": run_.video_id, "filename": filename, "source_url": url,
            "storage_path": source.relative_to(DATA).as_posix(), "size_bytes": size,
            "analyzers": analyzer_ids,
            "policy": policy, "params": {"mode": mode, "preset": preset, **weights},
            "poster_url": _poster(run_.video_id, source), "created_at": _now()}
    (META / f"{run_.video_id}.json").write_text(json.dumps(meta))
    update_job(job_id, stage="publishing")
    _publish(run_.video_id)

    video = get_video(run_.video_id)
    assert video is not None
    if blobs.enabled():
        source.unlink(missing_ok=True)            # in blob storage now; frees the disk
    return {**{k: video[k] for k in ("video_id", "video_url", "poster_url", "storage_path",
                                     "filename", "duration", "size_bytes", "chunk_config",
                                     "chunks", "analyzers")},
            "indexed": _indexed(run_.video_id, analyzer_ids),
            "aggregated": {"ran": video["aggregates"], "aggregates": video["aggregates"],
                           **({"error": "; ".join(run_.problems)} if run_.problems else {})}}


def _publish(video_id: str) -> None:
    """Copy a finished video to blob storage. Its metadata goes last, because
    that file is what marks a video as present."""
    if not blobs.enabled():
        return
    meta = _read(META / f"{video_id}.json")
    assert meta is not None
    source = _source_of(meta)
    blobs.delete(f"out/{video_id}/")                 # a re-index may write fewer files
    stored = blobs.names(f"sources/{video_id}")
    for name in stored:                              # or keep the file under a new extension
        if name != f"sources/{source.name}":
            blobs.delete(name)
    if f"sources/{source.name}" not in stored:       # same bytes, same name: already there
        blobs.upload(DATA, source)
    blobs.upload(DATA, OUT / video_id, POSTERS / f"{video_id}.jpg")
    blobs.upload(DATA, META / f"{video_id}.json")


_fetching = threading.Lock()


def _ensure(video_id: str) -> None:
    """Pull a video into the local cache when it is only in blob storage."""
    if not blobs.enabled() or not re.fullmatch(r"[0-9a-f]{16}", video_id) \
            or (META / f"{video_id}.json").exists():
        return
    with _fetching:
        if (META / f"{video_id}.json").exists():
            return
        blobs.download(DATA, f"out/{video_id}/")
        blobs.download(DATA, f"posters/{video_id}.jpg")
        blobs.download(DATA, f"videos/{video_id}.json")   # last: it marks the cache complete


def all_video_ids() -> set[str]:
    ids = {p.stem for p in META.glob("*.json")}
    return ids | {Path(name).stem for name in blobs.names("videos/")}


def poster_path(video_id: str) -> Path:
    _ensure(video_id)
    return POSTERS / f"{video_id}.jpg"


def _indexed(video_id: str, analyzer_ids: list[str]) -> dict[str, int]:
    docs = _docs(video_id)
    counts: dict[str, int] = {}
    for analyzer in analyzer_ids:
        if analyzer in SAMPLER_OF:
            counts[analyzer] = sum(1 for c in docs["descriptions"].values()
                                   if SAMPLER_OF[analyzer] in c)
        else:
            counts[analyzer] = sum(1 for c in docs["transcript"].values() if c.get("text"))
    return counts


def run_aggregates(job_id: str, video_id: str, names: Optional[list[str]],
                   force: bool) -> dict[str, Any]:
    update_job(job_id, stage="aggregating")
    folder = OUT / video_id
    chosen = [VIDRA_NAME.get(n, n) for n in names] if names else \
        vidra_workflow.chosen(vidra_workflow.Options(source=folder, tier=TIER))
    answers = video_rag.layout(folder)["aggregates"]
    handed, skipped = vidra_workflow.inputs_for(chosen, folder)
    produced = aggregates.aggregate(
        out=answers, previous=None if force else answers, models=MODELS, database=DATABASE,
        **{name.replace(":", "_"): data for name, data in handed.items()})
    blobs.upload(DATA, answers, folder / "aggregate_units.json")
    return {"video_id": video_id, "ran": [public_name(n) for n in handed],
            "aggregates": sorted(stored_aggregates(video_id)),
            "skipped": {public_name(k): v for k, v in
                        {**skipped, **produced.stats.get("skipped", {})}.items()}}


# ----------------------------------------------------------------------- reads

def _read(path: Path) -> Optional[dict[str, Any]]:
    return json.loads(path.read_text()) if path.exists() else None


def _docs(video_id: str) -> dict[str, Any]:
    """The documents one video's chunks are built from, by chunk id."""
    at = video_rag.layout(OUT / video_id)
    timeline = _read(at["timeline"]) or {"chunks": [], "duration_s": 0}
    descriptions = _read(at["descriptions"]) or {"chunks": []}
    transcript = _read(at["transcript"]) or {"chunks": []}
    return {
        "timeline": timeline,
        "descriptions": {c["chunk_id"]: c.get("samplers", {}) for c in descriptions["chunks"]},
        "transcript": {c["chunk_id"]: c for c in transcript["chunks"]},
    }


def timecode(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _strings(values: Any) -> list[str]:
    out = []
    for value in values or []:
        if isinstance(value, dict):
            value = value.get("description") or value.get("name") or value.get("label") \
                or json.dumps(value)
        out.append(str(value))
    return out


def chunk_out(video_id: str, chunk: dict[str, Any], docs: dict[str, Any],
              analyzer_ids: list[str], only: Optional[str] = None) -> dict[str, Any]:
    """One chunk in core's `ChunkOut` shape."""
    i = chunk["chunk_id"]
    out: dict[str, Any] = {"chunk_id": i, "start": chunk["start_ts"], "end": chunk["end_ts"],
                           "timecode": f"{timecode(chunk['start_ts'])}-{timecode(chunk['end_ts'])}"}
    described = docs["descriptions"].get(i, {})
    for analyzer, sampler in SAMPLER_OF.items():
        answer = described.get(sampler)
        if not answer:
            continue
        s = answer.get("structured") or {}
        text = answer.get("description", "")
        if analyzer == "default_video":
            out[analyzer] = {"description": text, "setting": s.get("setting"),
                             "people": _strings(s.get("people")),
                             "objects": _strings(s.get("objects")),
                             "actions": _strings(s.get("actions")),
                             "tags": _strings(s.get("tags"))}
        elif analyzer == "ocr":
            # The vision model reads text as {text, context}; core's shape is the same.
            texts = [t if isinstance(t, dict) else {"text": str(t)}
                     for t in s.get("visible_text") or []]
            out[analyzer] = {"texts": texts, "summary": text}
        elif analyzer == "people":
            people = [p if isinstance(p, dict) else {"description": p}
                      for p in s.get("people") or []]
            out[analyzer] = {"people": people, "people_count": len(people), "summary": text}
        else:
            objects = _strings(s.get("objects"))
            out[analyzer] = {"detections": [{"object": o} for o in objects],
                             "objects": objects, "summary": text}
    spoken = docs["transcript"].get(i)
    if spoken is not None:
        # VIDRA joins Whisper's word tokens, which carry their own leading spaces.
        spoken = {**spoken, "text": " ".join((spoken.get("text") or "").split())}
        if "diarization" in analyzer_ids:
            out["diarization"] = {"text": spoken.get("text", ""),
                                  "turns": spoken.get("turns", []),
                                  "speakers": (spoken.get("structured") or {}).get("speakers", [])}
        else:
            out["transcript"] = {"text": spoken.get("text", "")}
    if only:
        keep = {"chunk_id", "start", "end", "timecode", only}
        out = {k: v for k, v in out.items() if k in keep}
    return out


def _meta(video_id: str) -> Optional[dict[str, Any]]:
    _ensure(video_id)
    return _read(META / f"{video_id}.json")


def get_video(video_id: str) -> Optional[dict[str, Any]]:
    meta = _meta(video_id)
    if meta is None:
        return None
    timeline = _read(video_rag.layout(OUT / video_id)["timeline"]) or {}
    return {"video_id": video_id, "filename": meta["filename"],
            "video_url": media_url(video_id), "poster_url": meta.get("poster_url"),
            "storage_path": meta["storage_path"], "source_url": meta["source_url"],
            "size_bytes": meta.get("size_bytes"), "preset": meta["params"].get("preset"),
            "params": meta["params"], "chunk_config": meta["policy"],
            "analyzers": meta["analyzers"], "aggregates": sorted(stored_aggregates(video_id)),
            "chunks": timeline.get("chunk_count", 0), "duration": timeline.get("duration_s", 0)}


def delete_video(video_id: str) -> Optional[dict[str, Any]]:
    meta = _meta(video_id)
    if meta is None:
        return None
    shutil.rmtree(OUT / video_id, ignore_errors=True)
    for path in (_source_of(meta), POSTERS / f"{video_id}.jpg",
                 META / f"{video_id}.json"):
        path.unlink(missing_ok=True)
    blobs.delete(f"videos/{video_id}.json")              # first: it marks the video present
    blobs.delete(f"out/{video_id}/")
    blobs.delete(f"sources/{video_id}")
    blobs.delete(f"posters/{video_id}.jpg")
    return {"video_id": video_id, "deleted": True}


def get_chunks(video_id: str, analyzer: Optional[str], after: Optional[float],
               before: Optional[float], chunk_ids: Optional[list[int]],
               limit: int, offset: int) -> Optional[dict[str, Any]]:
    meta = _meta(video_id)
    if meta is None:
        return None
    if analyzer and analyzer not in ANALYZERS:
        raise ValueError(f"Unknown analyzer {analyzer!r}; have {list(ANALYZERS)}")
    docs = _docs(video_id)
    rows = [c for c in docs["timeline"]["chunks"]
            if (after is None or c["end_ts"] > after)
            and (before is None or c["start_ts"] < before)
            and (chunk_ids is None or c["chunk_id"] in chunk_ids)]
    page = rows[offset:offset + limit]
    return {"video_id": video_id, "analyzers": meta["analyzers"], "total": len(rows),
            "offset": offset, "limit": limit,
            "chunks": [chunk_out(video_id, c, docs, meta["analyzers"], analyzer) for c in page]}


def get_chunk(video_id: str, chunk_id: int) -> Optional[dict[str, Any]]:
    found = get_chunks(video_id, None, None, None, [chunk_id], 1, 0)
    return found["chunks"][0] if found and found["chunks"] else None


# ------------------------------------------------------------------ aggregates

def stored_aggregates(video_id: str) -> dict[str, Any]:
    """Every aggregate on disk, by the frontend's name, in the frontend's shape."""
    folder = video_rag.layout(OUT / video_id)["aggregates"]
    if not folder.exists():
        return {}
    loaded = {}
    for path in sorted(folder.glob("*.json")):
        document = json.loads(path.read_text())
        name = document.get("aggregate_id") or path.stem
        loaded[public_name(name)] = _normalise(name, document.get("payload") or {})
    return loaded


def _with_spans(value: Any) -> Any:
    """Add core's `start`/`end` beside VIDRA's `start_ts`/`end_ts`, everywhere."""
    if isinstance(value, list):
        return [_with_spans(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: _with_spans(v) for k, v in value.items()}
    if "start_ts" in out:
        out.setdefault("start", out["start_ts"])
    if "end_ts" in out:
        out.setdefault("end", out["end_ts"])
    return out


def _normalise(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    p = _with_spans(payload)
    if name == "events":
        p["events"] = [{**e, "event": e.get("what", ""), "category": e.get("kind", "")}
                       for e in p.get("events", [])]
    elif name == "speakers":
        p["speaker_count"] = p.get("speakers", 0)
        p["speakers"] = [{**row, "share": row.get("share", 0)} for row in p.get("by_speaker", [])]
    elif name.startswith("entities:"):
        rows = []
        for e in p.get("entities", []):
            # VIDRA's account is {text, narrative}; core's entities carried plain strings.
            account = e.get("account")
            story = account.get("narrative") if isinstance(account, dict) else account
            rows.append({**e, "name": e.get("label"), "first_seen": e.get("start_ts"),
                         "last_seen": e.get("end_ts"), "narrative": e.get("narrative") or story,
                         "description": e.get("narrative") or story or e.get("label")})
        p["entities"] = rows
        if name == "entities:objects":
            p["objects"] = [{**e, "object_id": e["entity_id"]} for e in rows]
    return p


def get_aggregates(video_id: str, aggregator: Optional[str]) -> Optional[dict[str, Any]]:
    if _meta(video_id) is None:
        return None
    stored = stored_aggregates(video_id)
    if aggregator is None:
        return {"video_id": video_id, "available": sorted(stored), "aggregates": stored}
    if aggregator not in stored:
        raise ValueError(f"Aggregate {aggregator!r} is not stored for {video_id}; "
                         f"available: {', '.join(sorted(stored)) or 'none'}")
    return {"video_id": video_id, "aggregator": aggregator, "result": stored[aggregator]}


def get_entities(video_id: str, min_appearances: int) -> Optional[dict[str, Any]]:
    found = get_aggregates(video_id, "entities")
    if found is None:
        return None
    timeline = _docs(video_id)["timeline"]["chunks"]
    spans = {c["chunk_id"]: (c["start_ts"], c["end_ts"]) for c in timeline}
    rows = []
    for e in found["result"].get("entities", []):
        if e.get("appearances", 0) < min_appearances:
            continue
        rows.append({**e, "timeline": {"observed_seconds": e.get("observed_s", 0),
                                       "spans": [list(spans[c]) for c in e.get("chunk_ids", [])
                                                 if c in spans]}})
    return {"video_id": video_id, "total": len(rows), "entities": rows}


def schema() -> dict[str, Any]:
    return {
        "aggregators": {public_name(n): {"depends_on": [],
                                         "uses_llm": aggregates.tier_of(n) == "llm"}
                        for n in aggregates.available()},
        # VIDRA's search takes no structured filters the frontend knows; none offered.
        "filters": {},
    }


# ---------------------------------------------------------------------- search

def _known(video_ids: Optional[list[str]]) -> Optional[list[str]]:
    """The ingested videos among `video_ids` (all when None), pulled into the
    local cache so the search index can read them."""
    ready = all_video_ids()
    chosen = sorted(ready) if video_ids is None else [v for v in video_ids if v in ready]
    for video_id in chosen:
        _ensure(video_id)
    if video_ids is None:
        return chosen or None
    return chosen


def _hit(moment: Any, detail: str, cache: dict[str, Any]) -> dict[str, Any]:
    vid = moment.video_id
    if vid not in cache:
        meta = _meta(vid) or {"analyzers": [], "source_url": None}
        cache[vid] = (_docs(vid), meta)
    docs, meta = cache[vid]
    chunk = next((c for c in docs["timeline"]["chunks"] if c["chunk_id"] == moment.chunk_id),
                 {"chunk_id": moment.chunk_id, "start_ts": moment.start_ts,
                  "end_ts": moment.end_ts})
    full = chunk_out(vid, chunk, docs, meta["analyzers"])
    visual = full.get("default_video") or {}
    spoken = full.get("diarization") or full.get("transcript") or {}
    description = visual.get("description") or next(
        (full[a].get("summary") for a in ("object_detection", "people", "ocr") if a in full), "") \
        or " ".join((moment.hits[0]["content"] if moment.hits else "").split())
    hit = {"video_id": vid, "chunk_id": moment.chunk_id, "start": moment.start_ts,
           "end": moment.end_ts, "timecode": full["timecode"], "score": round(moment.score, 6)}
    if detail == "minimal":
        return {**hit, "snippet": (description or spoken.get("text", ""))[:240]}
    hit.update(video_url=media_url(vid), description=description,
               people=visual.get("people", []),
               objects=visual.get("objects") or (full.get("object_detection") or {}).get("objects", []),
               actions=visual.get("actions", []), tags=visual.get("tags", []),
               speakers=spoken.get("speakers", []), turns=spoken.get("turns", []),
               people_count=(full.get("people") or {}).get("people_count"))
    if detail == "full":
        hit.update(text=spoken.get("text", ""),
                   persons=(full.get("people") or {}).get("people", []),
                   detections=(full.get("object_detection") or {}).get("detections", []),
                   texts=(full.get("ocr") or {}).get("texts", []))
    return hit


def find(text: str, video_ids: Optional[list[str]], analyzer: Optional[str],
         limit: int, detail: str) -> list[dict[str, Any]]:
    scope = _known(video_ids)
    if not scope:
        return []
    sampler = SAMPLER_OF.get(analyzer or "") if analyzer != "default_video" else None
    moments, _ = search(text, scope, moments=limit, sampler=sampler,
                        database=DATABASE, models=MODELS)
    cache: dict[str, Any] = {}
    return [_hit(m, detail, cache) for m in moments]


def _complete(prompt: str) -> str:
    llm = MODELS.resolved()["llm"]
    return str(asyncio.run(llm.complete(prompt, max_output_tokens=1500))).strip()


ANSWER_RULES = ("Answer from the evidence only. Cite moments as m:ss timestamps. If the "
                "evidence does not answer the question, say so plainly. Be concise.")


def _evidence(hits: list[dict[str, Any]]) -> str:
    return "\n".join(f"- [{h['video_id']} {timecode(h['start'])}-{timecode(h['end'])}] "
                     f"{h.get('description', '')} {h.get('text', '')}".strip()
                     for h in hits)


def query(text: str, video_ids: Optional[list[str]], analyzer: Optional[str], limit: int,
          synthesize: bool, detail: str) -> dict[str, Any]:
    hits = find(text, video_ids, analyzer, limit, detail)
    answer = None
    if synthesize and hits:
        full = find(text, video_ids, analyzer, limit, "full") if detail != "full" else hits
        answer = _complete(f"{ANSWER_RULES}\n\nQuestion: {text}\n\nMoments:\n{_evidence(full)}")
    return {"query": text, "analyzer": analyzer or "default_video", "field": "combined",
            "detail": detail, "answer": answer, "results": hits}


def ask(question: str, video_ids: Optional[list[str]], analyzer: Optional[str],
        limit: int) -> dict[str, Any]:
    """Moments for the specifics, plus each video's summary and chapters for the
    whole-video questions retrieval alone cannot answer."""
    hits = find(question, video_ids, analyzer, limit, "full")
    consulted: dict[str, dict[str, Any]] = {}
    overview = []
    for vid in (_known(video_ids) or [])[:5]:
        stored = stored_aggregates(vid)
        used = [n for n in ("summary", "chapters") if n in stored]
        if not used:
            continue
        consulted[vid] = {"aggregates": used}
        summary = (stored.get("summary") or {}).get("summary", "")
        chapters = "; ".join(f"{timecode(c.get('start', 0))} {c.get('title', '')}"
                             for c in (stored.get("chapters") or {}).get("chapters", []))
        overview.append(f"[{vid}] {summary}\nChapters: {chapters}")
    if not hits and not overview:
        return {"question": question, "answer": None, "sources": consulted, "results": [],
                "error": "Nothing analysed in scope yet."}
    answer = _complete(f"{ANSWER_RULES}\n\nQuestion: {question}\n\n"
                       f"Whole-video overview:\n{chr(10).join(overview) or '(none)'}\n\n"
                       f"Moments:\n{_evidence(hits)}")
    return {"question": question, "answer": answer, "sources": consulted, "results": hits}


def health() -> dict[str, Any]:
    return {"status": "ok", "engine": f"vidra {vidra.__version__}", "tier": TIER,
            "data": str(DATA), "storage": blobs.describe(), "videos": len(all_video_ids()),
            "analyzers": list(ANALYZERS), "aggregators": sorted(schema()["aggregators"]),
            "ffmpeg": shutil.which("ffmpeg")}
