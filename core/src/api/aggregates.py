"""Video-level aggregation over stored analyzer output.

Separate from ingestion on purpose: aggregators read `records/`, not the
video, so re-summarising or re-linking after tuning costs no re-analysis.
"""

import json
from typing import Callable

from .. import aggregators, store
from ..vectordb import ChunkStore
from .videos import record_path_for


def run_aggregators(
    video_id: str,
    aggregator_ids: list[str] | None = None,
    force: bool = False,
    chunk_store: ChunkStore | None = None,
    progress: Callable[[str, dict], None] | None = None,
) -> dict:
    """Run video-level passes over a video's stored analyzer output.

    Results already stored are reused unless `force`. Four of these bill an
    API call per run, so re-uploading a video to add one analyzer would
    otherwise re-buy its summary, chapters, events and entities every time.
    """
    path = record_path_for(video_id)
    if path is None:
        raise ValueError(f"No such video {video_id!r}")
    record = json.loads(path.read_text(encoding="utf-8"))

    analyzers_now = sorted(record.get("analyzers", []))
    requested = aggregator_ids or aggregators.available()
    order = aggregators.resolve_order(requested, analyzers_now)
    skipped = sorted(set(requested) - set(order))

    stale = record.get("aggregates_analyzers") != analyzers_now
    force = force or stale

    cs = chunk_store or ChunkStore()
    owns_store = chunk_store is None
    ctx = aggregators.AggregateContext(
        record=record, store=cs,
        results=dict(record.get("aggregates", {})),
    )

    produced, failed, reused = {}, {}, []
    try:
        for aggregator_id in order:
            if not force and aggregator_id in ctx.results:
                reused.append(aggregator_id)
                continue
            if progress:
                progress("aggregating", {"aggregator": aggregator_id})
            try:
                result = aggregators.get(aggregator_id).aggregate(ctx)
            except Exception as exc:
                failed[aggregator_id] = f"{type(exc).__name__}: {exc}"
                continue
            if result is not None:
                ctx.results[aggregator_id] = result
                produced[aggregator_id] = result
    finally:
        if owns_store:
            cs.close()

    record["aggregates"] = ctx.results
    record["aggregates_analyzers"] = analyzers_now
    store.save(record, str(path))

    return {
        "video_id": video_id,
        "ran": list(produced),
        "reused": reused,
        "skipped": skipped,
        "failed": failed,
        "aggregates": list(ctx.results),
        "recomputed_because_analyzers_changed": stale,
        "llm_calls_saved": [a for a in reused if a in aggregators.USES_LLM],
    }
