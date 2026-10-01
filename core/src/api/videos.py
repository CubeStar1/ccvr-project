"""Video records: lookup, listing, and deletion.

Every function here works off the saved JSON records (and the vector store /
bucket for deletion) — nothing opens a video file.
"""

import json
from pathlib import Path

from ..log import log
from ..paths import CACHE_DIR, RECORDS_DIR
from .. import storage
from ..vectordb import ChunkStore

POSTER_NAME = "poster.jpg"


def record_path_for(video_id: str) -> Path | None:
    """Find a video's record. Records are named for readability, so this
    matches on the `video_id` inside rather than on the filename."""
    if not RECORDS_DIR.exists():
        return None
    for path in RECORDS_DIR.glob("*.json"):
        try:
            if json.loads(path.read_text(encoding="utf-8")).get("video_id") == video_id:
                return path
        except (json.JSONDecodeError, OSError):
            continue
    return None


def video_url_for(video_id: str) -> str | None:
    """The public Storage URL for an ingested video, for /media to redirect to."""
    path = record_path_for(video_id)
    if path is None:
        return None
    return json.loads(path.read_text(encoding="utf-8")).get("video_url")


def video_path_for(video_id: str) -> str | None:
    """A local file for an ingested video, downloading it back if the cache is cold.

    Nothing stores a local path any more - it is derived from the content hash
    every time - so this no longer has to guess where a moved file went.
    """
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    return storage.local_path_for(video_id, record.get("storage_path"))


def list_videos() -> list[dict]:
    """Videos that have been ingested, from their saved records."""
    out = []
    for path in sorted(RECORDS_DIR.glob("*.json")) if RECORDS_DIR.exists() else []:
        record = json.loads(path.read_text(encoding="utf-8"))
        chunks = record.get("chunks", [])
        out.append(
            {
                "video_id": record.get("video_id", path.stem),
                "filename": record.get("filename"),
                "video_url": record.get("video_url"),
                "poster_url": record.get("poster_url"),
                "duration": record.get("duration")
                or (round(chunks[-1]["end"], 2) if chunks else 0.0),
                "chunks": len(chunks),
                "chunk_config": record.get("chunk_config"),
                "analyzers": record.get("analyzers", []),
            }
        )
    return out


def get_video(video_id: str) -> dict | None:
    """Metadata for one ingested video."""
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    chunks = record.get("chunks", [])
    return {
        "video_id": record.get("video_id"),
        "filename": record.get("filename"),
        "video_url": record.get("video_url"),
        "poster_url": record.get("poster_url"),
        "storage_path": record.get("storage_path"),
        "source_url": record.get("source_url"),
        "size_bytes": record.get("size_bytes"),
        "preset": record.get("preset"),
        "params": record.get("params", {}),
        "chunk_config": record.get("chunk_config"),
        "analyzers": record.get("analyzers", []),
        "aggregates": sorted(record.get("aggregates", {})),
        "chunks": len(chunks),
        "duration": record.get("duration")
        or (round(chunks[-1]["end"], 2) if chunks else 0.0),
    }


def delete_video(video_id: str) -> dict | None:
    """Remove a video completely: vectors, record, bucket objects, cache.

    Every store is dropped in one call because partial deletion is worse than
    none - vectors without a record are unciteable, and an object without
    either is unreachable bytes nothing will ever collect.

    Storage failures are reported rather than raised: the record and the
    vectors are the parts that make a video *visible*, and leaving those in
    place because the bucket call failed would keep a deleted video searchable.
    """
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))

    with ChunkStore() as cs:
        cs.delete_video(video_id)

    objects = [p for p in (record.get("storage_path"), f"{video_id}/{POSTER_NAME}") if p]
    storage_error = None
    try:
        storage.delete(objects)
    except Exception as exc:
        storage_error = f"{type(exc).__name__}: {exc}"
        log.warning("bucket delete for %s failed: %s", video_id, storage_error)

    path.unlink(missing_ok=True)
    for cached in CACHE_DIR.glob(f"{video_id}.*"):
        cached.unlink(missing_ok=True)

    return {
        "video_id": video_id,
        "deleted": True,
        "objects": objects,
        **({"storage_error": storage_error} if storage_error else {}),
    }
