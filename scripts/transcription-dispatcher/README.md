# Transcription dispatcher release scripts

`build-release.sh` makes a reproducible, content-addressed ZIP (release ID and SHA-256 are in the name, so a mutable `latest` cannot pass) plus digest, SBOM, provenance and manifest. It requires a clean committed worktree. `ALLOW_DIRTY_SOURCE=1` is for a local proof only: the artifact records `source_state=dirty-local-proof`, is ineligible for release, and `verify-artifact.sh` rejects it unless the same override is set.

`verify-artifact.sh` checks that the manifest names the exact bytes before an OpenTofu plan consumes the artifact. Neither script uploads, deploys or calls AWS. `validate-contract.sh` is a static policy check of the OpenTofu module (see the module README for what it pins).
