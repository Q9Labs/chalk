# Observed managed-release SSM fixtures

These fixtures reproduce Release [39111792077](https://github.com/Q9Labs/chalk/actions/runs/39111792077), which stopped at `DuplicateDocumentContent` before sending a host command.

- `ssm-get-document.nightly.json` is the read-only AWS `GetDocument` response fetched from nightly on 18 October 2026 with `--document-version '$LATEST' --document-format JSON`. The observed version was `1`, status `Active`, and no `VersionName` was present. Only `Name` was replaced with `chalk-fixture-managed-release`; the other response fields and `Content` are unchanged.
- `managed-release-document.json` is the exact tracked document passed by that run's Release deploy command, from source `c1b1373fcd3485c51c5e23fcb4cd25a71c59d229` at `infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json`. Release loads this file rather than generating a different document. Its SHA256 is `3241b6227e0a0e88e5fcf146a4600d664b00ecca988854afb9ad173990741050`.
- The provider Content bytes and the Release file bytes match. The files contain no account IDs, ARNs, host credentials or secret values. Parameters and shell references describe the public deployment contract, not an executed request.

Tests use the observed response for duplicate detection. Error-state tests vary only metadata or the description to exercise the existing refusal and update paths. Refresh both fixtures from a real read when changing the observed contract; do not replace the document with an empty synthetic example.
