# FalconVQA backend — CPU-only image.
#
# Build from the repository root, because the backend installs ../vidra:
#
#     docker build -f backend/Dockerfile -t falconvqa-backend .
#
# Torch comes from PyTorch's CPU index, not PyPI: the PyPI Linux wheel is the
# CUDA build and drags in gigabytes of nvidia-* packages nothing here would use.
# Every model falls back to CPU on its own, so no application code changes.

FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /usr/local/bin/uv

# ffmpeg for decoding; libgl1/libglib2.0-0 are opencv-python's; libsndfile1 is soundfile's.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 libsndfile1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    USE_TF=0 \
    HF_HOME=/opt/models/hf \
    VIDRA_WEIGHTS=/opt/models/weights \
    BACKEND_DATA=/data

WORKDIR /app

# Torch in its own layer: the largest download, and the one that changes least.
# Same versions as backend/uv.lock.
RUN uv pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.14.1 torchvision==0.29.1 torchaudio==2.11.0

# Everything else, pinned by the lock — minus torch and the CUDA libraries
# (torch's, and the ones vidra lists for faster-whisper on a GPU). The export is
# the complete set, so --no-deps installs exactly it and nothing pulls CUDA back.
COPY vidra/ vidra/
COPY backend/pyproject.toml backend/uv.lock backend/
RUN cd backend \
    && uv export --frozen --no-hashes --no-dev --no-editable --no-emit-project -o all.txt \
    && grep -vE '^(torch|torchvision|torchaudio|triton|cuda-[a-z0-9-]+|nvidia-(cu|nv|nccl)[a-z0-9-]*)==' \
        all.txt > requirements.txt \
    && uv pip install --no-deps -r requirements.txt \
    && rm all.txt requirements.txt

# Ungated model weights, baked in so a restarted container starts warm.
COPY backend/prefetch.py backend/
RUN python backend/prefetch.py

COPY backend/ backend/

# uid 1000 owns everything the app writes. /data is only a cache when blob
# storage is configured, so it needs no volume.
RUN useradd --uid 1000 --create-home app \
    && mkdir -p /data \
    && chown -R app:app /data /opt/models /app
USER app

WORKDIR /app/backend
EXPOSE 8077

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8077/health || exit 1

# One worker: jobs and the ingest queue live in this process.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8077", "--workers", "1"]
