# API CI/CD Phase 1 — session log 2026-08-14

Scope Hasan approved: CI builds, signs, and publishes the arm64 API+Sync images plus the release manifest on every green master push; deploys stay manual; migration policy untouched.

## Outcome

Phase 1 is live and self-tested. Run 31789719157 on e984122b went green end-to-end: Smart gate → Publish API images → Deploy web. First fully CI-published release:

- Release: `managed-episode-20260814T100054Z-e984122b-40e5ec42`
- API index: `sha256:1bfbcc2c7e83ffcc8a647fea3ae47a6aa492cba389e656b8ed9e3e71491930cd`
- Sync index: `sha256:6de677328283f5e4ed5ddec3b15b29c170f3cd29fec00c1bdd8ad76d184b6c43`
- Managed signing independently verified `COMPLETE` for both via `describe-image-signing-status` (profile `chalk_production_ecr`).

## Defects found and fixed on the way

1. Gate red on the first Phase 1 push: OSV flagged Go 1.25.12 stdlib (GO-2026-6090/6091/6218). Fixed in ef537183 — toolchain/pins bumped to Go 1.25.13 (Dockerfiles, go.mod, db-migrate.sh, README).
2. First publish attempt: images pushed but signing FAILED with `ACCESS_DENIED` — ECR managed signing executes as the pushing principal, and `chalk-ci-image-publish` lacked `signer:SignPayload`. Mirrored the exact statement from `chalk-production-ecr-publisher` into the role's inline `ecr-image-publish` policy (Sid `SignWithChalkProductionProfile`, resource = the `chalk_production_ecr` profile ARN).
3. Rerun still "failed" despite signing actually completing: the poll used `--query status`, but the response shape is `signingStatuses[0].status`, so it always read `None` — it could never see COMPLETE or FAILED (it also masked the attempt-1 ACCESS_DENIED). Fixed in e984122b: correct query path, failure reason surfaced on FAILED, window widened to 10 minutes.

Unsigned residue from the failed attempts exists in ECR (attempt-1 pair unsigned; attempt-2 API image signed late, tags never referenced by any manifest). Repos are immutable; candidates for later cleanup, never for deploy.

## Still open

- Phase 2: one-button parameterized SSM deploy document; Phase 3 auto-deploy later.
- The a4d1227a production cutover runs in a parallel Luna lane (see `managed-episode-live-runtime-controller-session-log-2026-08-09.md`).
- Dependabot: 3 high + 1 moderate on default branch, triage pending.

## 2026-08-14 (later): a4d cutover root cause found and fixed at the credential layer

After v21 failed at `goose up-to` with a generic error, I stopped iterating in production (per Hasan's rebuke) and owned the diagnosis directly:

- Full audit of the migration helper (bundle-v16 `migration/migrate-database`, 293 lines). Found its cleanup trap deletes `helper_error`, destroying goose's stderr on failure — that is why every attempt reported only "Goose up-to migration failed".
- Complete local rehearsal with the exact helper image, the bundle's goose v3.27.1, all 35 migrations, exact invocation pattern: every step passed including `up-to 20260810120000` (rc=0). Tooling proven correct.
- Read-only prod goose history (SSM dad7acdc): identical to rehearsal pre-state. Not a bookkeeping problem.
- Read-only privilege query (both staged env URLs): `participants` is owned by `pscale_api_0nlna4bw0lzc`; sync.env connects as `pscale_api_63se7r6cfbo4`, api.env as `pscale_api_e7i7jwumhpog`, both `pg_has_role`=f. Reads work, `ALTER TABLE` cannot — every cutover attempt was doomed regardless of tooling.

Fix: the owner credential ("Chalk production database migrator 2026-08-09", 1P vault dev, a DATABASE item with split fields and a PlanetScale `role.suffix` username) was staged by Hasan via `/tmp/stage-migrator-url.sh` as SSM SecureString `/chalk/production/episode/managed-episode-20260810T182156Z-a4d1227a-afe9d341/migrator-database-url` (sslmode=verify-full, role prefix verified against the owner). On-host verification (SSM 45b8430b): instance role reads the parameter; connecting with it yields `current_user=owner`, `is_member=t`.

Final attempt (document-v22) launched on the Luna lane: dedicated root-private `migrate.env` for the migrate phase (runtime sync/api envs untouched), helper patched to preserve goose stderr, pre-stop hard gate extended with parameter-read + ownership checks, then the full cutover to a4d1227a with unchanged fence rules.

Pipeline lessons (feed into Phase 2/3): never destroy failure stderr; prove DDL capability pre-stop; migrator credential is a stable per-environment SSM parameter, structurally separate from runtime roles; rehearse the migration chain in CI against scratch Postgres.

## 2026-08-14 evening: a4d1227a IS LIVE IN PRODUCTION

Landed at 14:33:40Z via controller start-and-verify after a fenced recovery. Probe 404→401, healthz 200, all five units active, release pointer on managed-episode-20260810T182156Z-a4d1227a-afe9d341, last-event migrated=true.

The path there (documents v22–v26, each fail-closed with zero DB harm):
- v22: bundle tarball carried macOS xattr headers (com.apple.provenance); host extraction rejected it. Fix: COPYFILE_DISABLE=1 bsdtar --no-xattrs --no-mac-metadata; prove archive clean pre-upload.
- v23: preserved migration-stage root still held the OLD helper while the document pinned the new patched sha; prepare died on a silent bare-[[ assert (rc=1, no output). Diagnosed by decoding the SSM document and checking shas on-host myself.
- v24: stage-refresh implemented as `if verify_stage_root` — bash suppresses set -e inside functions called in condition contexts, so the failed assert didn't abort and refresh never fired.
- v25: everything green through the gate; ownership query returned `true` but the gate accepted only `t`. Fixed with SQL-side `::int` cast.
- v26: gates green, stop 14:00:08Z, backup verified, `goose up-to` APPLIED the migration and head advanced — then the helper's post-migration check grepped goose status from stdout (goose prints to stderr), aborted before writing evidence, and the controller correctly refused to start. Fence held: no old restart on a migrated DB.
- Recovery: I completed the helper's aborted verification out-of-band (head + four schema checks + backup checksum re-run for real on-host), wrote the evidence JSON with the pinned values, then ran document-v26 Action=start-and-verify (controller accepts stop-for-migration state). Hasan executed the two blocked steps via `!` (evidence write; earlier the migrator SecureString staging).
- Outage: ~14:00–14:33Z (~33 min), fenced throughout, database migrated once, zero data harm.

Root-cause chain now fully closed: runtime DB roles can't DDL (owner-role migrator credential staged in SSM), helper must never destroy stderr, all goose output parsing must use combined streams, DDL capability gated pre-stop, no verification functions in bash condition contexts.

Cleanup still owed: scrub migrate.env on host, host staging residue v7–v26, superseded stage roots, unsigned ECR images, .worktrees/api-cutover, local rehearsal containers, migrator SSM parameter left in place (per-environment permanent home to be decided in Phase 2).
