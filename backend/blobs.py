"""A mirror of `data/` in an Azure Blob Storage container, for deployments whose
local disk does not survive a restart.

Blob names are paths relative to the data folder (`out/<id>/timeline.json`,
`videos/<id>.json`, `posters/<id>.jpg`), so the local folder is just a cache of
the container: `engine` uploads a video's files when an ingest finishes and
pulls them back the first time something asks for that video.

Browsers reach blobs only through short-lived signed URLs (`sas_url`): a write
URL to upload a video, a read URL to play one. The container stays private.

With `AZURE_STORAGE_CONNECTION_STRING` unset every function here does nothing,
and the backend keeps everything on local disk, as in development.
"""

from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

CONNECTION = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "").strip()
CONTAINER = os.environ.get("AZURE_STORAGE_CONTAINER", "falconvqa").strip()
#: Origins whose browsers may PUT uploads and GET videos straight from storage.
ORIGINS = [o.strip() for o in os.environ.get("FRONTEND_ORIGINS", "http://localhost:3000")
           .split(",") if o.strip()]

_client: Optional[Any] = None
_lock = threading.Lock()


def enabled() -> bool:
    return bool(CONNECTION)


def describe() -> str:
    return f"azure:{CONTAINER}" if enabled() else "local"


def _container() -> Any:
    """The container client, built once. The container is created if missing,
    and the account's CORS rules are set to `ORIGINS`, replacing any others:
    the storage account is meant to be this backend's alone."""
    global _client
    with _lock:
        if _client is None:
            from azure.storage.blob import BlobServiceClient, CorsRule
            service = BlobServiceClient.from_connection_string(CONNECTION)
            service.set_service_properties(cors=[CorsRule(
                ORIGINS, ["GET", "HEAD", "PUT", "OPTIONS"], allowed_headers=["*"],
                exposed_headers=["*"], max_age_in_seconds=3600)])
            client = service.get_container_client(CONTAINER)
            if not client.exists():
                client.create_container()
            _client = client
    return _client


def sas_url(name: str, *, write: bool = False, minutes: int = 60) -> str:
    """A URL a browser can use without credentials: read, or create-and-write,
    for `minutes`."""
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas
    container = _container()
    now = datetime.now(timezone.utc)
    token = generate_blob_sas(
        account_name=container.account_name, container_name=CONTAINER, blob_name=name,
        account_key=container.credential.account_key,
        permission=BlobSasPermissions(create=True, write=True) if write
        else BlobSasPermissions(read=True),
        start=now - timedelta(minutes=5),            # tolerate clock skew
        expiry=now + timedelta(minutes=minutes))
    return f"{container.get_blob_client(name).url}?{token}"


def upload(root: Path, *paths: Path) -> int:
    """Upload each file, and every file under each directory, named by its path
    relative to `root`. Missing paths are skipped."""
    if not enabled():
        return 0
    container = _container()
    sent = 0
    for path in paths:
        if not path.exists():
            continue
        files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
        for file in files:
            with file.open("rb") as data:
                container.upload_blob(file.relative_to(root).as_posix(), data, overwrite=True)
            sent += 1
    return sent


def download(root: Path, prefix: str) -> int:
    """Write every blob whose name starts with `prefix` under `root`."""
    if not enabled():
        return 0
    container = _container()
    got = 0
    for blob in container.list_blobs(name_starts_with=prefix):
        target = root / blob.name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as out:
            container.download_blob(blob.name).readinto(out)
        got += 1
    return got


def names(prefix: str) -> list[str]:
    if not enabled():
        return []
    return [blob.name for blob in _container().list_blobs(name_starts_with=prefix)]


def delete(prefix: str) -> int:
    """Delete every blob whose name starts with `prefix`."""
    if not enabled():
        return 0
    container = _container()
    gone = 0
    for name in names(prefix):
        container.delete_blob(name)
        gone += 1
    return gone
