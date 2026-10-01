"""Backward-compatible facade over the split api modules.

This module was 714 lines covering ingest, reads, aggregates and search; the
implementation now lives in `videos.py`, `reads.py`, `ingest.py`,
`aggregates.py` and `search.py`. Everything is re-exported here so existing
importers (`app.py`, tests, scripts) keep working — new code should import
from the specific module instead.
"""

from ..paths import RECORDS_DIR
from .aggregates import run_aggregators
from .ingest import resolve_source, upload, validate_source
from .reads import (
    DETAIL_LEVELS,
    SNIPPET_CHARS,
    get_aggregates,
    get_chunk,
    get_chunks,
    _shape,
)
from .search import SYNTHESIS_PROMPT, answer, query, _synthesize
from .videos import (
    POSTER_NAME,
    delete_video,
    get_video,
    list_videos,
    record_path_for,
    video_path_for,
    video_url_for,
)

__all__ = [
    "RECORDS_DIR",
    "POSTER_NAME",
    "DETAIL_LEVELS",
    "SNIPPET_CHARS",
    "SYNTHESIS_PROMPT",
    "answer",
    "delete_video",
    "get_aggregates",
    "get_chunk",
    "get_chunks",
    "get_video",
    "list_videos",
    "query",
    "record_path_for",
    "resolve_source",
    "run_aggregators",
    "upload",
    "validate_source",
    "video_path_for",
    "video_url_for",
    "_shape",
    "_synthesize",
]
