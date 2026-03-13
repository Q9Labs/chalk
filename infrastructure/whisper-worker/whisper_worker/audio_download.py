from __future__ import annotations

import mimetypes
import os
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import urlopen

_RETRYABLE_HTTP_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504})


def _normalize_suffix(raw_suffix: str | None) -> str | None:
    if not raw_suffix:
        return None
    suffix = raw_suffix.strip()
    if suffix == "":
        return None
    return suffix if suffix.startswith(".") else f".{suffix}"


def _suffix_from_url(url: str) -> str | None:
    path = urlparse(url).path
    return _normalize_suffix(Path(path).suffix)


def _suffix_from_headers(headers) -> str | None:
    if headers is None:
        return None

    filename_getter = getattr(headers, "get_filename", None)
    if callable(filename_getter):
        filename = filename_getter()
        suffix = _normalize_suffix(Path(filename or "").suffix)
        if suffix:
            return suffix

    content_type_getter = getattr(headers, "get_content_type", None)
    if callable(content_type_getter):
        content_type = content_type_getter()
        suffix = _normalize_suffix(mimetypes.guess_extension(content_type or ""))
        if suffix:
            return suffix

    return None


def _infer_suffix(url: str, headers) -> str:
    return _suffix_from_headers(headers) or _suffix_from_url(url) or ".bin"


def _is_retryable_error(error: Exception) -> bool:
    if isinstance(error, HTTPError):
        return error.code in _RETRYABLE_HTTP_STATUS_CODES
    if isinstance(error, URLError):
        return True
    if isinstance(error, TimeoutError):
        return True
    return False


def download_audio(
    url: str,
    *,
    timeout_seconds: int = 300,
    max_attempts: int = 3,
    initial_backoff_seconds: float = 1.0,
    open_url=urlopen,
    sleep=time.sleep,
):
    attempt = 1

    while True:
        tmp_path = None
        try:
            with open_url(url, timeout=timeout_seconds) as response:
                suffix = _infer_suffix(url, getattr(response, "headers", None))
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as file_handle:
                    tmp_path = file_handle.name
                    size_bytes = 0
                    http_status = getattr(response, "status", None) or response.getcode()

                    while chunk := response.read(8192):
                        file_handle.write(chunk)
                        size_bytes += len(chunk)

                return tmp_path, http_status, size_bytes
        except Exception as error:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

            if attempt >= max_attempts or not _is_retryable_error(error):
                raise

            sleep(initial_backoff_seconds * (2 ** (attempt - 1)))
            attempt += 1
