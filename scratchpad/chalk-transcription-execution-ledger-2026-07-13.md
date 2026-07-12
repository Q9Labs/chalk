# Chalk transcription execution ledger

Status: local implementation verification passed; staging and production readiness are blocked.

## Verified locally

The implementation uses PostgreSQL as the lifecycle authority and private R2
objects as the transcript-content authority. Public callers can request, read,
download, and delete transcript artifacts, but cannot select providers, object
keys, queue priority, retry policy, or lifecycle state. The dispatcher uses
replay-bound workload authentication and short-lived job authority; it has no
database or reusable R2 credential.

The following evidence has been observed in the isolated implementation
worktree:

- the transcription migration completed a fresh PostgreSQL up/down/up cycle;
- the Go API suite passed, including fenced result acceptance, finalization,
  cleanup, atomic nonce replay rejection, R2 DELETE authority, and async Lambda
  wake coverage;
- `route:recording-transcribe` completed through the execution trace harness
  with HTTP 202, tenant authorization, recorder-source lookup, atomic job
  creation, and a media-free asynchronous wake hint;
- the dispatcher passed its focused provider, normalization, fallback,
  multi-track overlap, mixed-provider finalization, late-result, cleanup, and
  reconciliation tests;
- both OpenTofu modules validated and the static dispatcher infrastructure
  contract passed; and
- OpenAPI and TypeScript SDK artifacts were regenerated from the new public
  transcript contract, then built and typechecked as part of the client SDK;
- the isolated API performance load and stress run completed against the fresh
  artifact-backed schema;
- lint, monorepo typechecking, tests, coverage, package publication checks, and
  TypeScript package-resolution checks passed; and
- two dirty-source local release builds produced and verified the identical
  dispatcher ZIP SHA-256
  `e0bee23b5bcd97f1f60e310abc108fa29f23560d78cebe4968ea9c2ffb0afe15`.

The canonical `pnpm run gate` is not green on this `origin/master` base. Its
repository-wide format stage reports eleven pre-existing, out-of-scope files;
those files were left untouched. Running the remaining stages directly exposed
and fixed an SDK schema-name collision, after which all stages passed except the
unrelated mobile build: Expo/Hermes rejects `import.meta.env` in the checked-in
Effect dependency without `unstable_transformImportMeta`. The transcription
dispatcher, client SDK, and web build completed before Turbo stopped. The
post-commit review remains pending until the implementation commit exists.

## Unmet launch gates

This worktree does not establish staging or production readiness. The following
evidence is outside the code available on `origin/master` or requires approved
external systems:

- the recorder capture/render implementation that commits the authenticated
  speaker-turn manifest and transcription-ready isolated audio chunks is not
  present, so a real composite recording-to-transcript run cannot start;
- DeepInfra commercial/privacy approval, processing and deletion terms,
  environment token isolation, spending controls, rotation and revocation,
  observed execution identity, quota/load proof, and the ratified multilingual
  quality corpus have not been produced;
- no live AWS/R2 deployment has proved the Lambda, SSM, VPC egress, async wake,
  minute reconciliation, DLQs, alarms, lifecycle rule, or real deletion failure
  and recovery path;
- the daily provider canary and changelog watcher are not deployed, and the
  current HTTP uptime worker cannot honestly prove the queue/provider/final
  commit path without a purpose-built synthetic; and
- no staging canary has completed once with DeepInfra selected and again with
  DeepInfra disabled and Cloudflare active.

Production enablement remains prohibited until every item above has recorded
evidence and the recorder dependencies in the parent specification pass.
