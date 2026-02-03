from __future__ import annotations

import atexit
import logging
import os
import socket
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

import axiom_py
from axiom_py.logging import AxiomHandler

SERVICE_NAME = "whisper-worker"
ENVIRONMENT = os.getenv("ENVIRONMENT", "dev")
HOSTNAME = socket.gethostname()
AXIOM_DATASET = os.getenv("AXIOM_DATASET", "chalk-whisper-work")


def setup_axiom_logging(*, log_level: str) -> Optional[AxiomHandler]:
    token = os.getenv("AXIOM_TOKEN", "").strip()
    if token == "":
        return None

    try:
        handler = AxiomHandler(axiom_py.Client(), AXIOM_DATASET)
        handler.setLevel(getattr(logging, log_level, logging.INFO))
        logging.getLogger().addHandler(handler)
        atexit.register(handler.close)
        return handler
    except Exception:
        # Never fail worker startup on observability.
        return None


def audio_url_meta(url: str) -> dict[str, Optional[str]]:
    parsed = urlparse(url)
    return {
        "audio_url_scheme": parsed.scheme or None,
        "audio_url_host": parsed.hostname or None,
    }


def emit_event(logger: logging.Logger, *, level: int, event: dict[str, Any]) -> None:
    base = {
        "_time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "service": SERVICE_NAME,
        "environment": ENVIRONMENT,
        "host": HOSTNAME,
        "pid": os.getpid(),
    }

    payload = {**base, **event}
    logger.log(level, str(payload.get("event", "log")), extra=payload)

