# Infrastructure

Public deployable support tooling lives here.

## Service Health And Uptime Monitoring

Every new deployable service must expose an independently checkable health or
synthetic target and join Chalk's uptime coverage in the same change. Add a
stable, non-secret monitor key and target to `uptime-worker/src/index.ts`, define
the expected response and severity, and add focused tests that prove the target
is checked and its result is ingested.

The monitor must cover the user-visible dependency rather than a handler that
can stay green while the service is unusable. Verify at least one scheduled run,
the result in the operational surface, and a real failure-to-recovery
transition. Add or update status-page projection when the service is a distinct
customer-visible component. Deployment-specific URLs, monitor IDs, alert
recipients, and credentials stay in private configuration rather than public
documentation.

Recorder admission uses the public-safe API contracts
`/healthz/recorder/capture` and `/healthz/recorder/render`. Each returns 200
only when its reconciler and qualified capacity are healthy, and 503 when
stale provider, qualification, or readiness state closes admission; neither
response exposes pool counts, regions, identifiers, or failure details.

See [`../docs/observability.md`](../docs/observability.md) for correlation,
telemetry, alerting, and end-to-end proof requirements.

## Recorder infrastructure

The recorder pools are declared under [`recorder/`](recorder/); its README explains the policies. OpenTofu owns immutable pool tags, outbound-only firewalls, image and release contracts, and the zero-idle capacity bounds. The external recorder reconciler owns Droplet creation, prewarm, desired capacity, fencing and replacement. The KMS policy grants data-key operations only to the control-plane role with the fixed environment and required recording context; recorder nodes receive neither KMS nor provider credentials.

`pnpm run recorder:gate` runs backend-disabled validation and the fail-closed credential check, and never applies infrastructure. A mutation takes values from protected environment configuration, never tracked tfvars, cloud-init, plans or logs. Production R2 adoption needs an explicit existing bucket name, so a default name can never create a replacement. The reconciler's signed one-time bootstrap assertion is never received or stored by OpenTofu.

## Asset CDN

Shared SDK media assets are served from Cloudflare R2 through the public custom
domain:

```text
https://assets.chalkmeet.com
```

The bucket is `chalk-assets`, with public paths under `ui/`. Hashed media files (`ui/backgrounds/`, `ui/sounds/`, names carry a sha256 prefix) are served `public, max-age=31536000, immutable`. The unversioned `ui` manifest is served `public, max-age=300, stale-while-revalidate=86400`. R2 CORS allows `GET` and `HEAD` from any origin.

`@q9labsai/chalk-assets` stays metadata-only (URLs, filenames, MIME types, sizes, hash prefixes); neither it nor `@q9labsai/chalk-ui/assets` bundles binaries.

### Update Flow

1. Generate or collect source assets outside package source.
2. Normalize and export hashed derivatives.
3. Upload hashed media to `chalk-assets`.
4. Upload the generated ui/manifest.json with the short manifest cache policy.
5. Update `packages/assets/src/index.ts`.
6. Verify live URLs, CORS, content types, and cache headers.

If replacing immutable assets, delete stale R2 objects and purge exact old URLs
from Cloudflare edge cache when a cache-purge-capable token is available. The
manifest should never point at stale assets.

## Alchemy stacks

`@chalk/infrastructure` pins one complete preview build of Alchemy, AWS,
Cloudflare, DigitalOcean and their workspace dependencies. The upstream commit
and immutable content-addressed tarballs are recorded in
[`platform/preview-build.json`](platform/preview-build.json). The tarballs still
report `2.0.0-beta.87`; their URLs, not that version string, identify the build.
Workspace overrides keep one Alchemy and one Effect 4.1.4 runtime in the
infrastructure dependency graph. The application and SDK's existing Effect beta
is intentionally untouched. No release-age or build-script policy is relaxed;
the pre-existing q9stack non-registry policy is unchanged. The lockfile includes
SHA-512 integrity for every preview tarball. `check-types` first checks the whole
graph and rejects partial bumps. To additionally check provenance online, run
`node infrastructure/platform/check-preview-build.mjs --verify-source`.

### Return to npm releases

When DigitalOcean reaches npm, change all `alchemy` and `@alchemy.run/*` URL
entries in `infrastructure/package.json` to the same exact published version.
Change the direct `@distilled.cloud/*` entries to the exact npm versions used by
those providers. Remove the preview graph's twenty URL overrides and its scoped
Effect override from `pnpm-workspace.yaml` (leave unrelated overrides alone).
Replace `platform/preview-build.json` and its preview-only check with an exact npm
version alignment check in the `check-types` script. Regenerate the lockfile with
`pnpm install`; retain the existing age gate and build-script allowlist. Do not
add a wildcard trust exception if the release is too new.

Run the strict typecheck and a detailed no-op plan for **each** stack and stage
before deploying with the npm build. Plans take leases: run them sequentially.
Check drift too for already-cut-over stacks. A package switch never authorizes
an otherwise unapproved production deployment.

### Preview state compatibility

Against `v2.0.0-beta.87`, the selected preview has no AWS StateStore changes and
only one state-type addition: optional `old.removalPolicy` in an interrupted
`updating` resource checkpoint. No keys, wire encoding, required fields, leases,
or completed-resource rows change. Both versions can read each other's completed
states. The preview planner also respects the last successful protected policy
in that optional checkpoint; beta.87 can read it but lacks that protection fix.
Do not downgrade during an interrupted update that changes a protected policy.
The existing archive CDN's detailed plan and read-only drift were both all no-ops
on the preview; no deploy was run for this compatibility proof.

### Stack registry

[`registry.ts`](registry.ts) is the authority for entrypoints, supported stages,
and current ownership. Seven component directories use `alchemy.run.ts`,
`config.ts` and `README.md`. SFU primary and standby share one component but
retain distinct state identities. Runtime assets stay in their existing paths;
Direct Sync's proxy and retained OpenTofu root remain under `managed-episode/`.
The following table is checked by `pnpm infra check`; regenerate it with
`pnpm infra table` when ownership changes.

<!-- stacks:start -->
| Stack | Stage | Owner | Entry |
| --- | --- | --- | --- |
| archive-cdn | nightly | alchemy | [archive-cdn/alchemy.run.ts](archive-cdn/alchemy.run.ts) |
| recording-control-address | nightly | unmanaged | [recording-control-address/alchemy.run.ts](recording-control-address/alchemy.run.ts) |
| transcription-dispatcher | nightly | alchemy | [transcription-dispatcher/alchemy.run.ts](transcription-dispatcher/alchemy.run.ts) |
| transcription-dispatcher | production | opentofu | [transcription-dispatcher/alchemy.run.ts](transcription-dispatcher/alchemy.run.ts) |
| direct-sync | nightly | opentofu | [direct-sync/alchemy.run.ts](direct-sync/alchemy.run.ts) |
| sfu | nightly | opentofu | [sfu/alchemy.run.ts](sfu/alchemy.run.ts) |
| sfu | production | opentofu | [sfu/alchemy.run.ts](sfu/alchemy.run.ts) |
| sfu-standby | nightly | opentofu | [sfu/alchemy.run.ts](sfu/alchemy.run.ts) |
| sfu-standby | production | opentofu | [sfu/alchemy.run.ts](sfu/alchemy.run.ts) |
| recorder | nightly | opentofu | [recorder/alchemy.run.ts](recorder/alchemy.run.ts) |
| recorder | production | opentofu | [recorder/alchemy.run.ts](recorder/alchemy.run.ts) |
| cloudflare-turn | nightly | unmanaged | [cloudflare-turn/alchemy.run.ts](cloudflare-turn/alchemy.run.ts) |
| cloudflare-turn | production | unmanaged | [cloudflare-turn/alchemy.run.ts](cloudflare-turn/alchemy.run.ts) |
<!-- stacks:end -->

`alchemy` means the stage is cut over. `opentofu` means its legacy state remains
the authority until a reviewed migration; it is not permission to deploy Alchemy.
`unmanaged` means this port is not an active owner. The retired recording control
address must not be recreated from stale state. TURN creation is not authorized.
The [R2 transcription lifecycle component](components/README.md) has no callers
and no stack or state identity; do not add a fictitious root for it.

### One command

```sh
pnpm infra list
pnpm infra plan archive-cdn nightly
pnpm infra drift archive-cdn nightly
pnpm infra seed sfu production /private/tofu-state.json --dry-run
```

`infra.ts` validates the stack and stage before starting Alchemy. `deploy` is
refused for stages that are not cut over. `drift` accepts no mutation flags and
preserves Alchemy's exit code (2 means drift). Operations on the same stack/stage
must be sequential because even plans and drift hold its state lease. Dispatcher
releases use the declared policies in `transcription-dispatcher/policy.ts`, not
an unrestricted deploy. Python calls `releases/driver.ts` once and reads one
private JSON result; the checked in-memory plan is the only plan applied.

### Layout and glossary

- Component directories (`archive-cdn`, `recording-control-address`,
  `transcription-dispatcher`, `direct-sync`, `sfu`, `recorder`, `cloudflare-turn`)
  each own one stack definition and its typed configuration.
- `platform/` owns shared stage parsing, AWS providers/state, and the pinned
  preview build and its guard.
- `providers/` owns custom resource adapters, named for their cloud provider,
  with their focused tests beside them.
- `components/` owns reusable resource groups with no independent stack identity.
- `releases/` owns plan projection, generic policy checking and exact-plan apply.
- `migration/` owns temporary OpenTofu readers, seed mappings and the offline
  definition-preservation proof; delete it after the last cutover.

A **component** is the provisioning boundary (for example SFU). A **stack** is
its durable Alchemy state identity (for example `sfu-standby`). A **stage** is the
environment (`nightly` or `production`), never a directory. **Transcription
dispatcher** is the one name for the Lambda and its queues, schedule and alarms;
“transcription” alone describes the wider product capability. **Direct Sync**
is the proxy's network infrastructure, not a state-storage mechanism. A
**provider** adapts a cloud resource; a **policy** declares the exact permitted
plan edits; a **seed** imports verified existing resources without deployment.

No physical names, logical IDs, resource types or stack names change in this
restructure. No live state rename is required.

### Scheduled drift

[`infrastructure-drift.yml`](../.github/workflows/infrastructure-drift.yml) reads
cut-over stack/stage pairs from the registry, serially runs read-only drift and
notifies the existing Oncall webhook on drift or check failure. It is gated by
`CHALK_ALCHEMY_DRIFT_ENABLED=true` and the dedicated role secret
`CHALK_ALCHEMY_DRIFT_ROLE_ARN`. It is **not enabled by this change**; no IAM was
modified or live proof attempted. See [the permission contract](platform/README.md)
before enabling it. Never use `--repair` in this workflow.

The persistent Nightly host and shared staging SFU were deliberately removed on
2026-11-15 (PRs #1432 and #1453, commit `011fc3f34`). Nightly cuts use
`deploy_managed: false` and prove on throwaway stacks. The address, direct Sync,
and Nightly SFU ports remain reachable through manually dispatched managed
Nightly deployment only. Retiring that path and `media.py` address reconciliation
is a follow-up, not part of this migration. Do not seed stale state to recreate
the retired resources. Production is untouched.

Shared OpenTofu CI actions, caches and tool pins remain because SFU, recorder and
direct Sync still have runnable legacy roots. Dispatcher release tooling no
longer invokes OpenTofu. See the [DigitalOcean migration reference](migration/digitalocean.md)
for remaining validation consumers and the production handoff.

Run commands from the repository root. Install with `pnpm install`, then run the
credential-free check:

```sh
pnpm --dir infrastructure check-types
```

AWS stacks share the credential chain, including `AWS_PROFILE`. State always
uses `ap-southeast-1`; direct Sync can select a different host region. Use Chalk's
`nightly` and `production` stage names. The address and CDN entrypoints reject every stage
except `nightly`; the dispatcher accepts both stages. State uses `AWS.state({ migrateFrom: false })`: the on-demand `alchemy-state` DynamoDB
table and its S3 overflow bucket in the same account and region. First use needs
permission to provision both, or an operator must bootstrap the store ahead of
time. Legacy Alchemy S3-state migration is disabled because these stacks have no
legacy Alchemy state; this also avoids requesting access to an unused bucket.
The store holds a lease for each stack and stage. Bootstrap the configured store
without evaluating the stack program:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy state bootstrap --config archive-cdn/alchemy.run.ts --no-input
```

### Migrate an existing root

Do not deploy against an empty Alchemy state store. EIP allocation IDs and
CloudFront caller references cannot be recovered from physical names alone.
`--adopt` does not replace the seed step.

1. Stop infrastructure writers for the root. Save the current Git commit as the
   undo, and capture live IDs, configuration, tags, and outputs privately.
2. Back up both original state objects without changing their keys:

   ```sh
   export AWS_PROFILE=q9labs
   account_id=$(aws sts get-caller-identity --query Account --output text)
   state_bucket="chalk-nightly-state-$account_id"
   backup_prefix="alchemy-migration-backup/$(date -u +%Y-%m-%dT%H%M%SZ)"
   migration_dir=$(mktemp -d)
   chmod 700 "$migration_dir"
   for stack in recording-control-address archive-cdn; do
     aws s3api copy-object --bucket "$state_bucket" --copy-source "$state_bucket/$stack/terraform.tfstate" --key "$backup_prefix/$stack/terraform.tfstate" >/dev/null
     aws s3 cp "s3://$state_bucket/$stack/terraform.tfstate" "$migration_dir/$stack.json" --only-show-errors
   done
   ```

3. Run the shared seed script only for a root whose resources still exist. It validates the managed resource
   set, reads the existing resources from AWS, and writes completed Alchemy
   records through `State`. It never writes OpenTofu state or product resources.
   The first state-store use can provision the table and overflow bucket.
   Add `--dry-run` to validate live mappings without provisioning or writing state.
   A retry skips matching destination records and refuses conflicting records.
   A missing live resource fails before any records are written.
   CDN ETags and the bucket policy must still match the original state.
   The address root is not eligible: its allocation is gone, so do not seed its
   stale state. The command below documents the CDN migration, not a step to
   repeat after cutover.

   ```sh
   pnpm --dir infrastructure exec tsx migration/seed.ts archive-cdn nightly "$migration_dir/archive-cdn.json"
   ```

4. Follow each stack's plan instructions. Before deploying, require only no-ops
   or in-place ownership-tag changes with no observable product effect. Stop on
   any create, replacement, or delete. Never use a deploy to fix a rejected plan.
5. Deploy, then run verification commands sequentially: even plan and drift
   take a stack/stage state lease and cannot run concurrently. Require an
   all-no-op second plan and a read-only `alchemy drift`
   exit code of zero. Compare all captured live facts, including the full bucket
   policy document. Do not use `drift --repair` or `drift --yes` as proof.
6. Only after successful cutover, remove that root's `.tf` and
   `.terraform.lock.hcl` files. Keep the original state objects and dated backups.

The seed script covers these roots, direct Sync, and the dispatcher's explicit module mapping,
not a generic Terraform provider schema. Follow the [dispatcher cutover runbook](../docs/transcription-production-release.md)
for its private inputs, production gate and release rollback. Extend explicit
mappings when another root migrates. The script rejects unexpected modules,
duplicate or deposed instances and unknown resources.
Direct Sync validates its complete saved resource set, including optional IPv6,
and refuses a missing interface or attachment before writing state. See its
[guide](managed-episode/direct-sync/README.md) for its separate state key and inputs.
Do not run Alchemy and OpenTofu as concurrent owners.

### Undo a cutover

Delete only the Alchemy records for the affected stack and stage, using its
entrypoint, before restoring the previous commit's OpenTofu configuration:

```sh
pnpm --dir infrastructure exec alchemy state delete archive-cdn/nightly --recursive --config archive-cdn/alchemy.run.ts --no-input
```

Run only the command for the stack being rolled back. `state delete` forgets
records and outputs, not AWS resources. No address cutover was performed; its
historical state cannot recover a released allocation. Restore the saved commit's `.tf` files,
initialize OpenTofu with the original backend, and inspect its plan against the
untouched original state. An ownership-tag difference is expected if Alchemy
added tags. Never run `tofu destroy`, `alchemy destroy`, or `alchemy nuke` for this
migration. Do not redeploy Alchemy after deleting its records without reseeding.
