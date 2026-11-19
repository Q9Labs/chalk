# Temporary infrastructure migration

Delete this directory when the last registered OpenTofu stack is cut over.
Runtime stacks, providers and release code must never import from it.

`seed.ts` is the only state-seeding entrypoint. `pnpm infra seed <stack> <stage>
<private-state.json> [--dry-run]` validates the registry before invoking it. It
uses explicit per-stack mappings, verifies existing live resources, rejects
unexpected/deposed/duplicate objects and conflicting destination state, and
resumes matching completed records. Dry-run performs cloud reads but does not
open or write the Alchemy store. It is not an offline test. Never seed stale
state for retired resources. Production writes retain the explicit approval
gate; this restructure does not authorize them.

`opentofu.ts` and `resource.ts` are shared migration readers; `sfu.ts`,
`recorder.ts`, `direct-sync.ts` and `transcription-dispatcher.ts` own the explicit
mappings. `transcription_state.py` and `transcription-evidence.py` are temporary
read-only dispatcher import/evidence tools, not runtime release dependencies.
The original state files and dated backups remain untouched.

## Offline declaration proof

```sh
pnpm --dir infrastructure exec tsx migration/check-definitions.ts origin/infra/alchemy-migration
```

`structure-moves.json` maps old source paths to their new homes.
`check-definitions.ts` compares executable TypeScript ASTs and import edges of
every transitive declaration module on both revisions, including all custom
providers and input/config functions. It normalizes the explicitly changed input/credential boundaries and expands
the extracted TURN stage decoder before comparison. Shared credential lookup,
JSON file loading and input-source changes are covered by separate boundary
tests; they are not claimed to be identical I/O. Formatting, comments and path relocation do not
count as changes. Resource expressions, physical names, logical IDs, resource
types, conditionals, props, outputs and declaration ordering do. Equal ASTs
prove the same resource graph for the same inputs and cloud reads; this is not
a sampled graph or a cloud plan. The proof evaluates no stacks or providers and
takes no state lease. Keep its baseline commit in the implementation report.

## State-key handoff

No stack identity or logical resource ID changes. No state rename command is
necessary, so no state-copy/delete implementation is included. In particular,
`archive-cdn/nightly` and `transcription-dispatcher/nightly` keep every existing
key. The lead should wait until the concurrent no-op proof lane has finished,
merge both branches, and sequentially run the commands below with the existing
private archive public key configured. Do not run any of them concurrently.

```sh
export AWS_PROFILE=q9labs
export CHALK_INFRA_INPUTS=/private/archive-cdn.json
pnpm infra plan archive-cdn nightly
pnpm infra drift archive-cdn nightly
unset CHALK_INFRA_INPUTS
pnpm infra plan transcription-dispatcher nightly
pnpm infra drift transcription-dispatcher nightly
```

Require the plan's resources to be all `noop`, no deletions/actions/binding
changes, and each drift exit code to be zero. No deploy is needed to validate
this refactor. Do not seed or create production state.
