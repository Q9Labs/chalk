# Document renderer

## Threat model

The renderer is designed to hold nothing worth stealing: it receives only a short-lived, per-job capability in the invocation event, while all object access is through pre-signed URLs and the Lambda execution role grants only CloudWatch Logs. A malicious document may still compromise the isolated child renderer process, so the child runs with a scrubbed environment, resource limits and a wall-clock kill, and any processing failure exits the parent so Lambda recycles the execution environment before another job. Linux process non-dumpability is applied as best-effort defense in depth rather than a trust boundary; denial is logged once and does not fail startup because the parent no longer possesses ambient workload or object-store authority.

## Office documents

The renderer accepts PDF and images, and, when the image carries LibreOffice, Office and OpenDocument files: pptx, ppt, docx, doc, xlsx, xls, odp, odt, ods and txt, plus Keynote (.key, best effort, only with `RENDERER_KEYNOTE=1`). `internal/office/formats.go` holds the single MIME table. A job whose MIME type is in it runs the isolated `office` child, which checks the source, converts it to PDF in the job scratch directory, and then continues as an ordinary PDF job with MIME type `application/pdf`.

### Conversion

- `office.Precheck` runs first, inside the child. It reads only container metadata: password protection (CFB `EncryptedPackage`, the Word encryption flag, the BIFF FILEPASS record, the PowerPoint encrypted header token, ODF manifest `encryption-data`) gives `password_protected`; a magic or structure mismatch with the claimed type gives `corrupt`.
- `office/office_convert.py` is a small trusted UNO driver run by `python3 -I`. It starts soffice with a fresh `-env:UserInstallation` profile, loads the document hidden and read-only with `MacroExecutionMode` NEVER_EXECUTE, and exports PDF with `PageRange` 1-301. Spreadsheets get every Calc page style set to landscape with `ScaleToPagesX=1`, `ScaleToPagesY=0`.
- The profile's `registrymodifications.xcu` disables macros (security level 3) and link updates.
- LibreOffice exits 0 without writing a PDF for several bad inputs, so a missing output is the failure signal (`corrupt`).
- Caps: at most 300 pages (the export stops at 301, and more than 300 gives `too_many_pages`), 64 MB of PDF (`too_large`), 60 s of wall clock (`too_large`). `unsupported_format` means this image has no converter (`RENDERER_SOFFICE` or `RENDERER_OFFICE_DRIVER` unset) or Keynote is off.

Inventory, pages and zoom jobs each convert the source again, because jobs share no state. That only works while LibreOffice lays the document out the same way each time. A pages or zoom job therefore re-inventories the converted PDF and fails with `infrastructure` when the PDF has fewer pages than the page it must render. The renderer cannot detect a layout that shifts content between pages without changing the count.

### Environment

The office child receives only `RENDERER_SOFFICE` (soffice path), `RENDERER_OFFICE_DRIVER` (driver script path), `RENDERER_PYTHON` (default `/usr/bin/python3`, needs python3-uno) and `RENDERER_KEYNOTE`. soffice and python run with `PATH=/usr/bin:/bin`, `HOME`, `TMPDIR` and `XDG_CACHE_HOME` inside the job scratch directory, and nothing else from the parent.

### LibreOffice threat model

LibreOffice is a large, untrusted-input parser written in C++, with the Java integration not installed; assume a malicious document can take over the soffice process. What contains it:

- The child and its descendants share one process group, are limited to 4 GiB address space, 60 s CPU, 128 MiB per file and 1024 descriptors, and are killed as a group at the 60 s wall clock or when the child exits.
- The environment is scrubbed and the profile lives in per-job scratch, so no credentials or earlier job's files are inherited. Macros, link updates and external references are disabled, and the document is opened read-only.
- The parent holds no ambient authority: object access is through pre-signed URLs and the control capability, and any failure exits the parent so Lambda recycles the execution environment.

What is not isolated on Lambda: user namespaces are unavailable, so the converter does not get its own network namespace or a private filesystem view. A compromised soffice can read the image filesystem, reach the network that the function has, and read or write `/tmp` for the duration of the job, including the other jobs' scratch in the same environment if invocations overlap. It runs as the same uid as the parent, so non-dumpable protection of the parent is the only barrier to its memory. Outside Lambda, the child is placed in new user and network namespaces when the host allows it. Recycling the execution environment after each job bounds the time an attacker keeps any foothold.

## Packaging

The renderer ships two ways. `scripts/build-document-renderer.sh` builds the ZIP custom runtime. `scripts/build-document-renderer-image.sh` builds the container image from [`image/Dockerfile`](image/Dockerfile): Debian trixie with the same Go bootstrap and pinned PDFium, LibreOffice for Office conversion, bundled fonts and `/opt/renderer/office-convert.py`, run as a non-root user on a read-only root with only `/tmp` writable. Release, rollback and the ECR repository are described in [infrastructure/document-renderer](../../infrastructure/document-renderer/README.md#container-image-renderer).
