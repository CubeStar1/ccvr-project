"""Fail loudly when requirements.txt drifts from pyproject.toml.

`pyproject.toml` is the single source of truth (dev installs via `uv sync`).
`requirements.txt` exists only because the Docker image installs torch from the
CPU index first and needs the rest without a CUDA torch pin — so it must mirror
pyproject exactly, except:

- `torch`, `torchvision`, `torchaudio` stay *unpinned* on purpose (see the
  header in requirements.txt): pinning them would let pip replace the image's
  CPU build with the CUDA wheel from PyPI.
- `nvidia-cublas-cu12` is Linux/Windows-only and must NOT appear (CPU image).
- A `>=` spec in pyproject is satisfied by any requirements pin at or above it.

Run: `python3 scripts/check_deps.py`. Wired into core-tests.yml.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = ROOT / "pyproject.toml"
REQUIREMENTS = ROOT / "requirements.txt"

UNPINNED_ON_PURPOSE = {"torch", "torchvision", "torchaudio"}
HOST_ONLY = {"nvidia-cublas-cu12"}  # CUDA-only; the Docker image is CPU


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_pyproject() -> dict[str, str]:
    """name -> version spec (e.g. '==4.57.2', '>=2026.7.4', '' if bare)."""
    import tomllib

    deps = tomllib.loads(PYPROJECT.read_text())["project"]["dependencies"]
    out = {}
    for dep in deps:
        dep = dep.split(";")[0].strip()
        match = re.match(r"^([A-Za-z0-9_.\-]+)\s*(.*)$", dep)
        out[normalize(match.group(1))] = match.group(2).strip()
    return out


def parse_requirements() -> dict[str, str | None]:
    """name -> pinned version (None if intentionally unpinned)."""
    out = {}
    for line in REQUIREMENTS.read_text().splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        match = re.match(r"^([A-Za-z0-9_.\-]+)\s*(==\s*[^;\s]+)?", line)
        name = normalize(match.group(1))
        pin = match.group(2)
        out[name] = pin.replace(" ", "")[2:] if pin else None
    return out


def version_tuple(version: str) -> tuple:
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"[.]", version))


def main() -> int:
    pyproject = parse_pyproject()
    requirements = parse_requirements()
    errors = []

    for name, spec in sorted(pyproject.items()):
        if name in HOST_ONLY:
            if name in requirements:
                errors.append(f"{name}: CUDA-only but present in requirements.txt")
            continue
        if name not in requirements:
            errors.append(f"{name}: in pyproject.toml but missing from requirements.txt")
            continue
        if name in UNPINNED_ON_PURPOSE:
            if requirements[name] is not None:
                errors.append(f"{name}: must stay unpinned in requirements.txt")
            continue
        want = requirements[name]
        if spec.startswith("=="):
            if want != spec[2:]:
                errors.append(f"{name}: pyproject {spec} != requirements =={want}")
        elif spec.startswith(">="):
            floor = spec[2:]
            if want is None or version_tuple(want) < version_tuple(floor):
                errors.append(f"{name}: pyproject {spec} not satisfied by requirements =={want}")
        elif spec:
            errors.append(f"{name}: unsupported spec {spec!r} in pyproject.toml")

    for name in sorted(requirements):
        if name not in pyproject:
            errors.append(f"{name}: in requirements.txt but missing from pyproject.toml")

    if errors:
        print("requirements.txt has drifted from pyproject.toml:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"OK: {len(pyproject)} pyproject deps mirrored in requirements.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
