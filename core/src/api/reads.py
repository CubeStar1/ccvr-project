"""Free reads over stored analysis: chunks, aggregates, and hit shaping.

Nothing here opens a video or spends an API call — these serve the saved
records (and vectors, via shaping only) to the UI and to agents.
"""

import json

from .videos import record_path_for


def _timecode(seconds: float) -> str:
    return f"{int(seconds // 60)}:{seconds % 60:05.2f}"


_INTERNAL_KEYS = ("locations",)


def _strip(value, verbose: bool):
    """Remove debug and geometry keys from an analyzer's output."""
    if verbose or not isinstance(value, dict):
        return value
    cleaned = {
        k: v for k, v in value.items()
        if not k.startswith("_") and k not in _INTERNAL_KEYS
    }
    for key, inner in cleaned.items():
        if isinstance(inner, list):
            cleaned[key] = [_strip(item, verbose) for item in inner]
    return cleaned


DETAIL_LEVELS = ("minimal", "standard", "full")
SNIPPET_CHARS = 180


def _shape(hit: dict, detail: str) -> dict:
    """Trim a search hit to the caller's appetite.

    The same result serves a browser and an agent, and they want opposite
    things. A page can render every nested record cheaply; an agent pays for
    each one in context, where five full hits ran to ~19k tokens against ~80
    for their identifiers. So detail is chosen per call rather than baked in.
    """
    base = {
        "video_id": hit["video_id"],
        "chunk_id": hit["chunk_id"],
        "start": hit["start"],
        "end": hit["end"],
        "timecode": f"{_timecode(hit['start'])}-{_timecode(hit['end'])}",
        "score": round(hit["score"], 4),
    }
    if detail == "minimal":
        text = (hit.get("description") or hit.get("text") or "").strip()
        base["snippet"] = text[:SNIPPET_CHARS] + ("..." if len(text) > SNIPPET_CHARS else "")
        return base

    base.update({
        "video_url": hit.get("video_url"),
        "description": hit.get("description", ""),
        "people": hit.get("people", []),
        "objects": hit.get("objects", []),
        "actions": hit.get("actions", []),
        "tags": hit.get("tags", []),
        "speakers": hit.get("speakers", []),
        "people_count": hit.get("people_count"),
        "turns": hit.get("turns", []),
    })
    if detail == "full":
        base.update({
            "text": hit["text"],
            "persons": hit.get("persons", []),
            "detections": hit.get("detections", []),
            "texts": hit.get("texts", []),
        })
    return base


def get_aggregates(video_id: str, aggregator_id: str | None = None) -> dict | None:
    """Stored aggregator output for a video."""
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    stored = record.get("aggregates", {})
    if aggregator_id:
        if aggregator_id not in stored:
            raise ValueError(
                f"Video has no {aggregator_id!r} aggregate; it has {sorted(stored)}"
            )
        return {"video_id": video_id, "aggregator": aggregator_id, "result": stored[aggregator_id]}
    return {"video_id": video_id, "available": sorted(stored), "aggregates": stored}


def get_chunks(
    video_id: str,
    analyzer_id: str | None = None,
    after: float | None = None,
    before: float | None = None,
    chunk_ids: list[int] | None = None,
    limit: int = 50,
    offset: int = 0,
    verbose: bool = False,
) -> dict | None:
    """Stored analyzer output for a video's chunks, scoped and paginated.

    This is the read side an agent or the UI uses to look at what was produced,
    as opposed to searching for it. Always bounded so a caller cannot pull a
    whole video's output into context by accident.
    """
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    available = record.get("analyzers", [])
    if analyzer_id and analyzer_id not in available:
        raise ValueError(f"Video has no {analyzer_id!r} output; it has {available}")

    wanted_ids = set(chunk_ids) if chunk_ids else None

    selected = []
    for chunk in record.get("chunks", []):
        if wanted_ids is not None and chunk["id"] not in wanted_ids:
            continue
        if after is not None and chunk["end"] <= after:
            continue
        if before is not None and chunk["start"] >= before:
            continue
        wanted = [analyzer_id] if analyzer_id else available
        outputs = {a: _strip(chunk[a], verbose) for a in wanted if chunk.get(a)}
        if analyzer_id and not outputs:
            continue
        selected.append({
            "chunk_id": chunk["id"],
            "start": chunk["start"],
            "end": chunk["end"],
            "timecode": f"{_timecode(chunk['start'])}-{_timecode(chunk['end'])}",
            **outputs,
        })

    return {
        "video_id": video_id,
        "analyzers": available,
        "total": len(selected),
        "offset": offset,
        "limit": limit,
        "chunks": selected[offset : offset + limit],
    }


def get_chunk(video_id: str, chunk_id: int, verbose: bool = False) -> dict | None:
    """Everything every analyzer produced for one chunk."""
    path = record_path_for(video_id)
    if path is None:
        return None
    record = json.loads(path.read_text(encoding="utf-8"))
    for chunk in record.get("chunks", []):
        if chunk["id"] == chunk_id:
            outputs = {
                a: _strip(chunk[a], verbose)
                for a in record.get("analyzers", [])
                if chunk.get(a)
            }
            return {
                "video_id": video_id,
                "chunk_id": chunk_id,
                "start": chunk["start"],
                "end": chunk["end"],
                "timecode": f"{_timecode(chunk['start'])}-{_timecode(chunk['end'])}",
                **outputs,
            }
    return None
