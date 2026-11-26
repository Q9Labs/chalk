#!/usr/bin/env python3
"""Small S3-shaped object server for Chalk's local dashboard artifacts.

The API container uses this server as its internal object endpoint. Browser uploads still enter through the web shim;
both write the same sidecar metadata so signed upload, finalize, download and delete behave like the object store they emulate.
"""

import hashlib
import json
import mimetypes
import os
import posixpath
import sys
import urllib.parse
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

META_SUFFIX = ".chalk-meta.json"


def object_path(root, raw_path):
    path = urllib.parse.unquote(urllib.parse.urlsplit(raw_path).path)
    normalized = posixpath.normpath(path).lstrip("/")
    candidate = (root / normalized).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValueError("object path escapes the artifact root")
    return candidate


def metadata_path(path):
    return path.with_name(path.name + META_SUFFIX)


def request_metadata(headers):
    return {name.lower()[len("x-amz-meta-"):]: value for name, value in headers.items() if name.lower().startswith("x-amz-meta-")}


class ArtifactHandler(BaseHTTPRequestHandler):
    server_version = "ChalkLocalArtifacts/1.0"

    def translated_path(self):
        return object_path(self.server.root, self.path)

    def read_metadata(self, path):
        try:
            return json.loads(metadata_path(path).read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def write_object(self):
        try:
            path = self.translated_path()
        except ValueError:
            self.send_error(403)
            return
        length = self.headers.get("Content-Length")
        try:
            expected = int(length or "0")
        except ValueError:
            self.send_error(400)
            return
        if self.headers.get("If-None-Match") == "*" and path.exists():
            self.send_error(412)
            return
        body = self.rfile.read(expected)
        if len(body) != expected:
            self.send_error(400)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        metadata = {
            "contentType": self.headers.get("Content-Type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "metadata": request_metadata(self.headers),
            "checksumSHA256": self.headers.get("x-amz-checksum-sha256") or "",
            "etag": hashlib.md5(body).hexdigest(),
        }
        metadata_path(path).write_text(json.dumps(metadata, separators=(",", ":")))
        self.send_response(200)
        self.send_header("ETag", metadata["etag"])
        self.send_header("Content-Length", "0")
        self.end_headers()

    def object_headers(self, path, size, stored):
        self.send_header("Content-Type", stored.get("contentType") or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("ETag", stored.get("etag") or hashlib.md5(path.read_bytes()).hexdigest())
        self.send_header("Last-Modified", formatdate(path.stat().st_mtime, usegmt=True))
        if stored.get("checksumSHA256"):
            self.send_header("x-amz-checksum-sha256", stored["checksumSHA256"])
        for name, value in stored.get("metadata", {}).items():
            if "\n" not in value and "\r" not in value:
                self.send_header(f"x-amz-meta-{name}", value)

    def send_object(self, include_body):
        try:
            path = self.translated_path()
        except ValueError:
            self.send_error(403)
            return
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        stored = self.read_metadata(path)
        start = 0
        end = size - 1
        partial = False
        range_header = self.headers.get("Range") or ""
        if range_header.startswith("bytes=") and "-" in range_header[6:]:
            left, right = range_header[6:].split(",", 1)[0].split("-", 1)
            try:
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    suffix = int(right)
                    start = max(0, size - suffix)
                partial = 0 <= start <= end < size
            except ValueError:
                partial = False
            if not partial:
                self.send_error(416)
                return
        length = end - start + 1 if partial else size
        self.send_response(206 if partial else 200)
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.object_headers(path, length, stored)
        self.end_headers()
        if include_body:
            with path.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining and (chunk := source.read(min(1024 * 1024, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def delete_object(self):
        try:
            path = self.translated_path()
        except ValueError:
            self.send_error(403)
            return
        for candidate in (path, metadata_path(path)):
            try:
                candidate.unlink()
            except FileNotFoundError:
                pass
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        self.write_object()

    def do_GET(self):
        self.send_object(True)

    def do_HEAD(self):
        self.send_object(False)

    def do_DELETE(self):
        self.delete_object()

    def log_message(self, format, *args):
        return


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: artifact-server.py <port> <root>")
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), ArtifactHandler)
    server.root = Path(sys.argv[2])
    server.serve_forever()


if __name__ == "__main__":
    main()
