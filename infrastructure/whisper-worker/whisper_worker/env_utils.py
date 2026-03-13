from __future__ import annotations

import os
from typing import Optional

_TRUE = {"1", "true", "t", "yes", "y", "on"}
_FALSE = {"0", "false", "f", "no", "n", "off"}


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE


def env_bool_relaxed(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value == "":
        return default
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return default


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    if value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    if value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def env_optional_positive_int(name: str) -> tuple[bool, Optional[int]]:
    raw = os.getenv(name)
    if raw is None:
        return False, None

    value = raw.strip()
    if value == "":
        return True, None
    try:
        parsed = int(value)
    except ValueError:
        return True, None
    if parsed <= 0:
        return True, None
    return True, parsed

