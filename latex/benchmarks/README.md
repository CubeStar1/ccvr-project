# FalconVQA component pilot

Run from the repository root after syncing the backend environment:

```sh
backend/.venv/bin/python latex/benchmarks/local_pilot.py > pilot.json
```

The pilot creates its own media and indexes in a temporary directory. It does
not need provider credentials, upload any footage, or write to backend storage.

- **Chunking:** VIDRA's default `uniform` and `scene` policies on three silent,
  60-second, 320×180 H.264 videos at 20 fps. Each has three abrupt changes in
  brightness at known times aligned with the detector's sampling grid. Boundary
  F1 uses one-to-one matching within 250 ms, excluding video endpoints. Timing
  includes boundary evidence and timeline generation, not encoding or media
  probing. One warm-up per video and policy is excluded, leaving 30 timed runs
  per policy. This is a positive-control fixture, not a shot-detection accuracy
  benchmark on real footage.
- **Retrieval:** VIDRA's `Folder.search` plus `to_moments`, over 100, 1,000, and
  5,000 seeded synthetic 1,536-dimensional units (100 chunks per video).
  Timing includes reading JSON, cosine ranking, and grouping the top 20
  candidates into up to five timestamped moments. Query vectors are provided
  directly. Each query checks that its matching vector comes back at rank 1;
  this is a correctness check, not a measure of semantic retrieval quality.
  One warm-up per corpus size is excluded, leaving 15 timed queries per size.

`m2-pilot.json` records the raw samples, runtime versions, source revision, and
summary statistics. The pilot does not measure hosted embeddings, vision
descriptions, answer grounding, HTTP or cloud latency, or end-to-end ingest.
