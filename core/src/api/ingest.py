"""Ingestion: chunk a video, run analyzers per chunk, index the results."""

import json
import re
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from .. import analyzers, poster, store, storage, youtube
from ..chunk import chunk_video
from ..log import log
from ..paths import RECORDS_DIR, ensure as ensure_dirs
from ..vectordb import ChunkStore, config_key
from .aggregates import run_aggregators
from .videos import POSTER_NAME, record_path_for


def validate_source(url: str) -> None:
    """Reject a URL the fetcher will not accept, while a caller is still there
    to be told. Ingest runs on a background thread, so anything not checked
    here fails into a job the client has to poll to discover."""
    scheme = urlparse(url).scheme.lower()
    if scheme not in storage.ALLOWED_SCHEMES:
        raise ValueError(
            f"Unsupported URL scheme {scheme or '(none)'!r}; expected http or https"
        )
    if youtube.is_youtube(url) and not youtube.available():
        raise ValueError(
            "This URL is a YouTube link, but yt-dlp is not installed on the "
            "server; install it or supply a direct video URL."
        )


def resolve_source(source: str) -> dict:
    """Turn whatever the caller supplied into a cached local file plus its
    Storage identity.

    A URL and a local path are the same thing to everything downstream, which
    is why this returns one shape. The content hash inside it is the video id:
    not the filename stem, because two different uploads both called `test.mp4`
    would otherwise merge into one video's vectors.
    """
    if urlparse(source).scheme.lower() in storage.ALLOWED_SCHEMES:
        return storage.fetch_source(source)
    return storage.put_local(source)


def _write_poster(video_id: str, video_path: str) -> str | None:
    """Extract one frame and put it in the bucket beside the video.

    Never fatal: a video that analysed fine must not fail its ingest because a
    thumbnail could not be written, so every failure here degrades to no
    poster rather than a failed job.
    """
    try:
        data = poster.poster_bytes(video_path)
        if not data:
            return None
        return storage.put_object(f"{video_id}/{POSTER_NAME}", data, "image/jpeg")
    except Exception as exc:
        log.warning("poster for %s skipped: %s", video_id, exc)
        return None


def upload(
    source: str,
    analyzer_ids: list[str] | None = None,
    preset: str | None = "audio_video",
    weights: dict[str, float] | None = None,
    interval: float | None = None,
    min_duration: float = 5.0,
    max_duration: float = 20.0,
    aggregate: bool = True,
    chunk_store: ChunkStore | None = None,
    progress: Callable[[str, dict], None] | None = None,
) -> dict:
    """Chunk a video, run the chosen analyzers, and index the results.

    `source` is an http(s) URL or a path on this machine; either way the video
    ends up in Storage and the pipeline runs against a local cached copy.

    Chunking is one of three modes - `interval`, `weights`, or `preset` - see
    chunk_video. Analyzers are chosen per upload because they differ wildly in
    cost: the scene analyzer bills per chunk, transcription is free.
    """
    analyzer_ids = analyzer_ids or ["default_video"]
    analyzers.validate_selection(analyzer_ids)

    def report(stage, **info):
        if progress:
            progress(stage, info)

    report("fetching")
    media = resolve_source(source)
    video_id, video_path = media["video_id"], media["local_path"]
    cfg = config_key(preset, min_duration, max_duration, weights=weights, interval=interval)

    duration = poster.duration_of(video_path)
    poster_url = _write_poster(video_id, video_path)

    report("chunking")
    chunks = chunk_video(
        video_path,
        preset=preset,
        min_duration=min_duration,
        max_duration=max_duration,
        weights=weights,
        interval=interval,
    )
    report("chunked", chunks=len(chunks))

    ctx = analyzers.VideoContext(video_path)
    cs = chunk_store or ChunkStore()
    owns_store = chunk_store is None

    existing_path = record_path_for(video_id)
    existing = json.loads(existing_path.read_text(encoding="utf-8")) if existing_path else None
    if existing and existing.get("chunk_config") == cfg:
        record = existing
        record["analyzers"] = sorted(set(record.get("analyzers", [])) | set(analyzer_ids))
        record.update(
            video_url=media["video_url"],
            storage_path=media["storage_path"],
            source_url=media.get("source_url"),
            filename=media["filename"],
        )
    else:
        record = store.build(
            media, chunks, preset=preset,
            min_duration=min_duration, max_duration=max_duration,
        )
        record["analyzers"] = list(analyzer_ids)
        if existing:
            cs.delete_video(video_id)
    record["chunk_config"] = cfg
    record["poster_url"] = poster_url
    record["duration"] = duration
    record["size_bytes"] = media.get("size_bytes")

    indexed = {}
    try:
        for analyzer_id in analyzer_ids:
            analyzer = analyzers.get(analyzer_id)
            report("analyzing", analyzer=analyzer_id)
            cs.delete_video(video_id, chunk_config=cfg, extractor_id=analyzer_id)
            outputs = analyzer.analyze(chunks, ctx)

            payload = []
            for i, ((start, end), output) in enumerate(zip(chunks, outputs)):
                if output is None:
                    continue
                store.attach(record, i, **{analyzer_id: output})
                payload.append(
                    {
                        "id": i,
                        "start": start,
                        "end": end,
                        "output": output,
                        "fields": analyzer.render_fields(output),
                    }
                )

            report("indexing", analyzer=analyzer_id)
            indexed[analyzer_id] = cs.add_chunks(
                video_id, media["video_url"], payload, analyzer_id, cfg
            )
    finally:
        if owns_store:
            cs.close()

    ensure_dirs()
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(media["filename"]).stem)[:48].strip("_")
    for stale in RECORDS_DIR.glob(f"*__{video_id[:8]}.json"):
        stale.unlink()
    store.save(record, str(RECORDS_DIR / f"{stem}__{video_id[:8]}.json"))

    result = {
        "video_id": video_id,
        "video_url": media["video_url"],
        "poster_url": poster_url,
        "filename": media["filename"],
        "duration": duration,
        "size_bytes": media.get("size_bytes"),
        "chunk_config": cfg,
        "chunks": len(chunks),
        "analyzers": record["analyzers"],
        "indexed": indexed,
    }

    if aggregate:
        try:
            result["aggregated"] = run_aggregators(video_id, progress=progress)
        except Exception as exc:
            log.warning("aggregates for %s failed, ingest continues: %s", video_id, exc)
            result["aggregated"] = {"error": f"{type(exc).__name__}: {exc}"}

    return result
