# Document renderer

## Threat model

The renderer is designed to hold nothing worth stealing: it receives only a short-lived, per-job capability in the invocation event, while all object access is through pre-signed URLs and the Lambda execution role grants only CloudWatch Logs. A malicious document may still compromise the isolated child renderer process, so the child runs with a scrubbed environment, resource limits and a wall-clock kill, and any processing failure exits the parent so Lambda recycles the execution environment before another job. Linux process non-dumpability is applied as best-effort defense in depth rather than a trust boundary; denial is logged once and does not fail startup because the parent no longer possesses ambient workload or object-store authority.

## Packaging

The renderer ships two ways. `scripts/build-document-renderer.sh` builds the ZIP custom runtime. `scripts/build-document-renderer-image.sh` builds the container image from [`image/Dockerfile`](image/Dockerfile): Debian trixie with the same Go bootstrap and pinned PDFium, LibreOffice for Office conversion, bundled fonts and `/opt/renderer/office-convert.py`, run as a non-root user on a read-only root with only `/tmp` writable. Release, rollback and the ECR repository are described in [infrastructure/document-renderer](../../infrastructure/document-renderer/README.md#container-image-renderer).
