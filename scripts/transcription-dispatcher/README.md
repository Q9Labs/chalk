# Transcription dispatcher release scripts

`build-release.sh <unique-release-id>` builds the dispatcher package, requires
`dist/index.js`, creates a reproducible ZIP, and emits a digest sidecar, file
SBOM, provenance record, and release manifest under
`infrastructure/.artifacts/transcription-dispatcher/`. The release ID is part
of the ZIP name and the ZIP's SHA-256 is also part of that name, so a mutable
`latest` artifact cannot pass. `SOURCE_DATE_EPOCH` may be supplied to pin the
release timestamp; otherwise the source commit timestamp is used. The script
requires dispatcher, infrastructure, and release-script inputs to come from a
clean committed worktree. `ALLOW_DIRTY_SOURCE=1` exists only for an explicitly
local proof: it records a deterministic digest of tracked diffs and sorted
untracked source paths/content hashes (never raw content) as
`source_state=dirty-local-proof`. That artifact is ineligible for release or
promotion; `verify-artifact.sh` rejects it unless the same local-only override
is supplied.

`verify-artifact.sh` recomputes the ZIP digest, checks the filename and checksum
sidecar, and verifies that the manifest names the exact same bytes before an
OpenTofu plan consumes the artifact identity. Neither script uploads, deploys,
invokes AWS, or changes production. A missing build output, mutable name, or
digest mismatch fails closed.

`validate-contract.sh` is a static policy check for the OpenTofu module's
schedule, reserved concurrency, timeout reserve, retry/DLQ limits, immutable
artifact selection, exact SSM reads, controlled VPC egress, IAM exclusions,
and clean/dirty provenance boundaries.
