"""Measure current VIDRA components without remote models or private footage.

Run from the repository root:
  backend/.venv/bin/python latex/benchmarks/local_pilot.py > pilot.json
"""
import json
import platform
import subprocess
import tempfile
from pathlib import Path
from time import perf_counter

import av
import numpy as np

import vidra
from vidra import Folder
from vidra.video_rag.core.retrieve.moments import to_moments
from vidra.video_rag.offline.boundaries import driver as boundaries
from vidra.video_rag.offline.media import driver as media


def summarize(times):
    return {
        "n": len(times),
        "median_ms": round(float(np.median(times)), 3),
        "p95_ms": round(float(np.percentile(times, 95)), 3),
        "samples_ms": [round(x, 3) for x in times],
    }


def make_video(path, changes):
    fps = 20
    frames = [
        av.VideoFrame.from_ndarray(np.full((180, 320, 3), level, np.uint8), format="rgb24")
        for level in (0, 255)
    ]
    with av.open(str(path), mode="w") as output:
        stream = output.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = 320, 180, "yuv420p"
        for j in range(60 * fps):
            frame = frames[sum(j >= t * fps for t in changes) % 2]
            frame.pts = j
            output.mux(stream.encode(frame))
        output.mux(stream.encode())


def chunking(root):
    sequences = [(11, 27, 46), (8, 24, 41), (14, 33, 51)]
    results = {}
    for policy in ("uniform", "scene"):
        times, fixtures = [], []
        for idx, expected in enumerate(sequences):
            source = root / f"synthetic-{idx}.mp4"
            if not source.exists():
                make_video(source, expected)
            receipt = media.media(source, root / "media")
            folder = Path(receipt.stats["folder"])
            cut = folder / f"{policy}-cuts.json"
            timeline = folder / f"{policy}-timeline.json"
            for i in range(11):
                start = perf_counter()
                boundaries.evidence(cut, policy, media=folder / "media.json")
                boundaries.boundaries(
                    folder / "media.json", timeline, policy,
                    cuts=cut if policy == "scene" else None,
                )
                if i:
                    times.append((perf_counter() - start) * 1000)
            chunks = json.loads(timeline.read_text())["chunks"]
            found = [c["start_ts"] for c in chunks[1:]]
            remaining = list(expected)
            matches = 0
            for t in found:
                if remaining:
                    nearest = min(remaining, key=lambda x: abs(x - t))
                    if abs(nearest - t) <= 0.25:
                        remaining.remove(nearest)
                        matches += 1
            fixtures.append({"truth_s": expected, "predicted_s": found, "matches": matches})
        matches = sum(f["matches"] for f in fixtures)
        predicted = sum(len(f["predicted_s"]) for f in fixtures)
        truth = sum(len(f["truth_s"]) for f in fixtures)
        results[policy] = {
            **summarize(times), "matches": matches, "predicted": predicted, "truth": truth,
            "boundary_f1_at_250ms": round(2 * matches / (predicted + truth), 4),
            "fixtures": fixtures,
        }
    return results


def retrieval(root):
    rng = np.random.default_rng(904)
    db = Folder(root)
    results = []
    for count in (100, 1000, 5000):
        # One vector per chunk. Synthetic vectors test rank/scale, not semantics.
        video_ids = [f"video-{count}-{i}" for i in range(count // 100)]
        queries = []
        for vid in video_ids:
            folder = root / vid
            folder.mkdir(parents=True)
            vectors = rng.normal(size=(100, 1536)).round(4).tolist()
            queries.append((vid, 50, vectors[50]))
            units = [
                {"vector": v, "chunk_id": i, "sampler_id": "uniform", "content": "fixture"}
                for i, v in enumerate(vectors)
            ]
            chunks = [{"start_ts": 20 * i, "end_ts": 20 * (i + 1)} for i in range(100)]
            (folder / "embedded.json").write_text(json.dumps({"embedder": "fixture", "units": units}))
            (folder / "timeline.json").write_text(json.dumps({"chunks": chunks}))
        times = []
        for i in range(16):
            vid, chunk_id, vector = queries[i % len(queries)]
            start = perf_counter()
            hits = db.search(vector, "", "fixture", limit=20, video_ids=video_ids)
            moments = to_moments(hits, db.spans, limit=5)
            elapsed = (perf_counter() - start) * 1000
            assert len(moments) == 5 and (moments[0].video_id, moments[0].chunk_id) == (vid, chunk_id)
            if i:
                times.append(elapsed)
        results.append({
            "units": count, "videos": len(video_ids), "dimensions": 1536,
            "json_bytes": sum((root / v / "embedded.json").stat().st_size for v in video_ids),
            **summarize(times),
        })
    return results


if __name__ == "__main__":
    import cv2
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="falconvqa-pilot-") as temp:
        root = Path(temp)
        print(json.dumps({
            "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "vidra": vidra.__version__,
            "platform": platform.platform(),
            "python": platform.python_version(),
            "pyav": av.__version__, "opencv": cv2.__version__, "numpy": np.__version__,
            "chunking": chunking(root),
            "folder_retrieval": retrieval(root / "index"),
        }, indent=2))
