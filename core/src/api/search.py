"""Search and question-answering over the indexed video store."""

import json

from .. import analyzers
from ..vectordb import ChunkStore
from .reads import DETAIL_LEVELS, _shape
from .videos import list_videos, record_path_for


def query(
    text: str,
    video_ids: list[str] | None = None,
    analyzer_id: str = "default_video",
    field: str = "combined",
    limit: int = 5,
    score_threshold: float | None = None,
    synthesize: bool = True,
    filters: dict | None = None,
    detail: str = "standard",
    chunk_store: ChunkStore | None = None,
    model: str | None = None,
) -> dict:
    """Retrieve matching chunks and (optionally) synthesise a cited answer.

    `detail` controls how much of each hit comes back: "minimal" for an agent
    that will follow up on the ones it cares about, "standard" for the UI,
    "full" for every nested record.

    `filters` is passed through to the store against FILTER_SPEC, so a filter
    added there is reachable here immediately. Unknown keys raise rather than
    being ignored - a dropped filter returns plausible but wrong results.
    """
    analyzers.get(analyzer_id)
    if detail not in DETAIL_LEVELS:
        raise ValueError(f"Unknown detail {detail!r}; expected one of {list(DETAIL_LEVELS)}")

    active = dict(filters or {})
    if video_ids:
        active["video_ids"] = video_ids
    active["analyzer_ids"] = [analyzer_id]

    cs = chunk_store or ChunkStore()
    owns_store = chunk_store is None
    try:
        hits = cs.search(
            text,
            field=field,
            limit=limit,
            score_threshold=score_threshold,
            **active,
        )
    finally:
        if owns_store:
            cs.close()

    results = [_shape(h, detail) for h in hits]

    answer = None
    if synthesize and results:
        answer = _synthesize(text, results, model=model)

    return {"query": text, "analyzer": analyzer_id, "field": field,
            "detail": detail, "answer": answer, "results": results}


def answer(
    question: str,
    video_ids: list[str] | None = None,
    analyzer_id: str | None = None,
    limit: int = 6,
    chunk_store: ChunkStore | None = None,
    model: str | None = None,
) -> dict:
    """Answer a question using a video's aggregates as well as its segments.

    Distinct from `query`, which retrieves segments and summarises the ones it
    found. Here the question is routed to whichever aggregates can answer it -
    entity narratives for questions about a person, novelty for "what is
    unusual", statistics for counts - because those already contain the
    cross-segment reasoning that searching chunks one at a time cannot recover.
    """
    from . import ask as ask_module

    videos = video_ids or [v["video_id"] for v in list_videos()]
    if not videos:
        return {"question": question, "answer": None, "sources": {}, "results": [],
                "error": "No videos ingested."}

    cs = chunk_store or ChunkStore()
    owns_store = chunk_store is None
    contexts, sources, results = [], {}, []
    try:
        for video_id in videos:
            path = record_path_for(video_id)
            if path is None:
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
            analyzers_present = record.get("analyzers", [])
            search_as = analyzer_id or next(
                (a for a in ("default_video", "people", "diarization", "transcript",
                             "object_detection", "ocr") if a in analyzers_present),
                None,
            )
            hits = []
            if search_as:
                hits = cs.search(
                    question, field="combined", limit=limit,
                    video_ids=[video_id], analyzer_ids=[search_as],
                )
            shaped = [_shape(h, "standard") for h in hits]
            results.extend(shaped)
            context, used = ask_module.build_context(question, record, shaped)
            if context:
                contexts.append(f"=== VIDEO {video_id} ===\n{context}")
                sources[video_id] = used
    finally:
        if owns_store:
            cs.close()

    if not contexts:
        return {"question": question, "answer": None, "sources": {}, "results": [],
                "error": "Nothing indexed for the requested videos."}

    from ..extractors.video.openai_call import DEFAULT_MODEL, _get_client

    response = _get_client().chat.completions.create(
        model=model or DEFAULT_MODEL,
        messages=[{"role": "user", "content": ask_module.PROMPT.format(
            question=question, context="\n\n".join(contexts))}],
    )
    return {
        "question": question,
        "answer": response.choices[0].message.content.strip(),
        "sources": sources,
        "results": results,
    }


SYNTHESIS_PROMPT = """\
You are answering a question about video footage using retrieved segment \
descriptions. Answer only from the segments provided - if they do not support an \
answer, say so plainly.

Cite the segment behind every claim as [video_id start-end], using the exact \
timecodes given. Keep it to a few sentences.

Question: {question}

Segments:
{segments}"""


def _synthesize(question: str, results: list[dict], model: str | None = None) -> str:
    from ..extractors.video.openai_call import DEFAULT_MODEL, _get_client

    segments = "\n\n".join(
        f"[{r['video_id']} {r['start']:.2f}-{r['end']:.2f}s] (score {r['score']})\n"
        f"{r.get('text') or r.get('description') or r.get('snippet') or ''}"
        for r in results
    )
    prompt = SYNTHESIS_PROMPT.format(question=question, segments=segments)

    response = _get_client().chat.completions.create(
        model=model or DEFAULT_MODEL,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content.strip()
