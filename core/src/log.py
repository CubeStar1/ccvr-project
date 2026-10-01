"""One shared logger for the service.

Stdlib `logging`, configured once on import: INFO to stdout with timestamps.
Uvicorn's own logging config leaves existing root handlers alone
(`disable_existing_loggers: False`), so these records survive whether the app
starts via `serve.py` or `python -m uvicorn src.api.app:app` directly.

Usage: `from .log import log`, then `log.info/warning/exception(...)`.
"""

import logging
import sys

_HANDLER_GUARD = "falcon.configured"


def _setup() -> logging.Logger:
    logger = logging.getLogger("falcon")
    if getattr(logger, _HANDLER_GUARD, False):
        return logger
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S"
    ))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    setattr(logger, _HANDLER_GUARD, True)
    return logger


log = _setup()
