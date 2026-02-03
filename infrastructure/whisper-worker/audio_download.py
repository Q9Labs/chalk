from __future__ import annotations

import os
import tempfile
from urllib.request import urlopen


def download_audio(url: str):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as f:
        tmp_path = f.name
        size_bytes = 0
        http_status = None
        success = False
        try:
            with urlopen(url, timeout=300) as response:
                http_status = getattr(response, "status", None) or response.getcode()
                while chunk := response.read(8192):
                    f.write(chunk)
                    size_bytes += len(chunk)
            success = True
            return tmp_path, http_status, size_bytes
        finally:
            if not success and os.path.exists(tmp_path):
                os.unlink(tmp_path)
