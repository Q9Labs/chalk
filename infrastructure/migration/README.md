# Temporary infrastructure migration

Delete this directory when the last registered OpenTofu stack is cut over and
legacy Nightly retirement is complete. No runtime declaration or provider imports
from it. The command router invokes its explicit migration entrypoints only.

## Import a production root

`seed.ts` is the sole import entrypoint, called through the registry:

```sh
pnpm infra seed sfu production /private/sfu-state.json --dry-run
```

Dry-run validates mappings and reads cloud resources but never writes the store;
it is not an offline test. It rejects unexpected, duplicate/deposed resources
and conflicting destination records. Matching completed writes resume safely.
A dry-run is not production cutover authorization. Never seed stale retired
Nightly state. Original state and dated backups remain untouched.

## Offline declaration comparison

```sh
pnpm --dir infrastructure exec tsx migration/check-definitions.ts ab6e458b8f
```

`structure-moves.json` records source relocations. The comparison walks every
transitive declaration/provider module, compares executable TypeScript ASTs and
import edges, and hashes the result. No cloud calls, evaluation or lease occurs.
For the same validated inputs/cloud reads, the unchanged declarations produce
the same resources, logical IDs, physical names, props and outputs.

Explicit exclusions are intentional boundary changes: JSON/credential loading,
stage parsing, retired-stage refusal, ephemeral bootstrap validation and the
new media-relay stack label (never deployed). The custom Lambda provider also
adds explicitly stage-scoped ephemeral creation/deletion; its existing update
branch and all resource declarations remain compared. Run-owned reads represent
missing concurrency/invoke settings after interrupted creation, so cleanup can
finish; production still requires the complete configuration. Native-engine
tests with a fake AWS HTTP boundary prove exact versioned creation, cleanup
after both partial-creation failures, and repeated deletion. Production and
cross-run names are refused. Ownership of a run-created function is a persisted
fact: creation stamps the engine's instance ID as a tag, a function without it
reads as unowned (so plan and create refuse), and delete verifies it first.
Tests reproduce the cleanup that used to delete a same-named function it never
created. The same proof guards the run-owned log group (stack/stage/id tags) and
schedule (instance ID in its description) through `providers/aws-run-owned.ts`,
which is excluded from parity like the other ownership checks; roles, queues and
alarms already carry it upstream. Production's seeded resources are not held to
it. The former Nightly-only security
conditions now apply to any nonproduction stage; production conditions are
unchanged. Input schemas otherwise remain compared. These exclusions are not
claimed as a whole-program no-op: stage behavior deliberately changed, and
boundary/isolation tests cover it. No physical cloud name or live logical ID
was renamed. The renamed retired components retain their old stack identities
solely for cleanup, except recorder runtime downloads, whose state moves to its
production identity (below).

## Retire persistent Nightly after merge

Do not run these while the other lane holds its proof lease. This branch has
not run them. First save private state/output snapshots and complete the other
lane's current no-op proof. All commands below are **future operator writes**.
No active operation accepts bare `nightly`; only retirement can address it.

Recorder runtime downloads (`archive-cdn/nightly`) is **not** retired. Its
CloudFront distribution is referenced by the production SSM recorder settings
(`CHALK_RECORDER_FLEET_ARCHIVE_CDN_*`), so `pnpm infra retire
recorder-runtime-downloads` refuses; see the state move below.

For the two remaining Alchemy stages, preview first, then apply sequentially.
Every preview prints each resource's type and physical name, so an operator sees
what goes before it goes (a CloudFront distribution, a bucket, a KMS key):

```sh
AWS_PROFILE=q9labs pnpm infra retire transcription-dispatcher
AWS_PROFILE=q9labs pnpm infra retire transcription-dispatcher --settle   # only if the preview says a record is not stable
AWS_PROFILE=q9labs pnpm infra retire transcription-dispatcher --apply
AWS_PROFILE=q9labs pnpm infra retire recorder-control-endpoint
AWS_PROFILE=q9labs pnpm infra retire recorder-control-endpoint --apply
```

| Retired component                                  | Deletes                                                                                                                                                | Keeps                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Transcription dispatcher                           | Function/versions, logs, queues, IAM roles/policies, schedule, invoke permission and alarms, then its state/output.                                    | Borrowed artifacts bucket/versions, SSM parameters, KMS keys, control API and caller-owned resources. |
| Recorder control endpoint                          | Nothing expected: it was released, never seeded/cut over; empty cleanup is idempotent.                                                                 | Refuses retained resources instead of silently forgetting an unexpected protected allocation.         |

Every seeded Nightly dispatcher record carries `removalPolicy: "retain"`, which
the planner turns into an `orphaned` node that cleanup refuses. `retire
transcription-dispatcher --apply` therefore runs an explicit transition
(`retirement-transition.ts`) under the stack/stage lease. It validates that the
records are exactly the legacy Nightly dispatcher inventory (types, logical IDs,
Nightly-prefixed physical names, the saved Nightly environment tag) and refuses
anything else: an unexpected logical ID, a borrowed artifacts bucket, bucket
versions or KMS key, a record from another environment, a `protect` policy.
Then it makes only those records destroyable, one record at a time, and runs the
existing preview/apply destroy in a second leased step that validates again.
Every step is idempotent: a retry after a crash in the release step or in the
destroy resumes where it stopped.

The preview fails closed on any record that is not stable. If a failed apply
left a record `updating` (the live schedule was one), run `pnpm infra retire
transcription-dispatcher --settle`: it re-reads each live resource, records it
as `created`, deletes nothing, and refuses a record whose live resource is gone
or a record in any state other than an interrupted update. Then preview again.

The migration-only dispatcher deletion override requires the legacy `nightly`
stage and a saved Nightly environment tag; normal production deletion remains
forbidden. Destroy reads saved state
without evaluating retired declarations. Cleanup refuses retained/orphaned
resources and refuses to forget state while any resources remain.

The Sync trial, SFU variants and legacy recorder policy are still OpenTofu-owned. `pnpm infra retire`
refuses them rather than falsely reporting an empty Alchemy store as cleanup.
Use their original protected backend and variable files, not a new state root:

```sh
tofu -chdir=infrastructure/managed-episode/direct-sync/opentofu init -reconfigure -backend-config=/private/direct-sync/nightly/backend.hcl
tofu -chdir=infrastructure/managed-episode/direct-sync/opentofu plan -destroy -var-file=/private/direct-sync/nightly/terraform.tfvars -out=/private/direct-sync/nightly/retire.tfplan
tofu -chdir=infrastructure/managed-episode/direct-sync/opentofu show /private/direct-sync/nightly/retire.tfplan
tofu -chdir=infrastructure/managed-episode/direct-sync/opentofu apply /private/direct-sync/nightly/retire.tfplan
tofu -chdir=infrastructure/sfu init -reconfigure -backend-config=/private/sfu/nightly/backend.hcl
tofu -chdir=infrastructure/sfu plan -destroy -var-file=/private/sfu/nightly/node.tfvars -out=/private/sfu/nightly/retire.tfplan
tofu -chdir=infrastructure/sfu show /private/sfu/nightly/retire.tfplan
tofu -chdir=infrastructure/sfu apply /private/sfu/nightly/retire.tfplan
```

The recorder's legacy Nightly state is also stale. Inspect its original private
backend with `tofu -chdir=infrastructure/recorder init -reconfigure
-backend-config=/private/recorder/nightly/backend.hcl`, then `tofu
-chdir=infrastructure/recorder state list`. Do not infer deleted recording data
from a missing host. Do not apply a destroy of a recording bucket or KMS key;
retention decisions require a separate inventory. The Alchemy port was never
deployed there, so there is no Alchemy cleanup to run.

Repeat the four SFU commands with `/private/sfu-standby/nightly/` for the standby
backend/vars. Review the saved plans before applying: only the old trial network
interface/association/security group and DNS, or the selected SFU droplet/DNS/
firewall/tag belong to these roots. Hosts were already removed on 2026-11-15
(PR #1432/#1453); stale state can therefore produce an empty cleanup. Preserve
borrowed hosts, shared artifact buckets and production roots. These are exact
command forms with private paths as placeholders; live residual inventory has
not been verified in this lane.

## Ephemeral release gate for production cutover

Create a private JSON file `{ "initial": <dispatcher inputs>, "release":
<dispatcher inputs> }`. Both name the same fresh `nightly-<run-id>` stage; use
`function_name=chalk-<stage>-transcription-dispatcher`,
`scheduler_name=chalk-<stage>-transcription-reconcile`, default schedule group,
`scheduler_state=DISABLED`, and no control-API invoker principal. The per-run
schedule is inert because this proof tests a release, not an always-on service.
Supply two existing, valid versioned dispatcher ZIP artifacts with different
SHA256 values/release identities and matching private control/provider inputs.
Borrowed buckets, objects, secrets and keys are not created or destroyed by it.

```sh
AWS_PROFILE=q9labs CHALK_INFRA_INPUTS=/private/dispatcher-release-proof.json pnpm infra prove transcription-dispatcher nightly-123456
```

This bootstraps exactly the expected create-only isolated resources, calls the
same checked release command used by Python, confirms a no-op re-plan and clean
drift, destroys in `finally`, repeats destroy and verifies no resource/output
state remains. Success is one JSON result. Cloud diagnostics stay in protected
temporary files. A failed/crashed operator process can retry cleanup directly:

```sh
AWS_PROFILE=q9labs pnpm infra destroy transcription-dispatcher nightly-123456
```

The proof has **not** been run live here. Its successful result replaces the
obsolete "one persistent Nightly release" production-cutover gate. Production
remains OpenTofu-owned/unseeded until the lead explicitly sequences cutover.

## Recorder runtime downloads state move

The CloudFront distribution behind recorder runtime downloads serves production,
so its state moves from `archive-cdn/nightly` to
`recorder-runtime-downloads/production` instead of retiring. Physical names do
not change: the distribution keeps its `chalk:environment = nightly` tag and the
bucket stays `chalk-nightly-artifacts-<account>`, because renaming either would
replace a live resource (see the stack's README). The move is a recorded,
replayable step; it holds both leases, copies the five records and the stack
output, verifies the copy, and only then removes the old identity. It refuses a
destination that holds different records, so a retry after a crash finishes the
move and a second run changes nothing.

```sh
AWS_PROFILE=q9labs pnpm infra move-state recorder-runtime-downloads --dry-run
AWS_PROFILE=q9labs pnpm infra move-state recorder-runtime-downloads
```

Then set `seeded: true` on the registry entry, run `pnpm infra table`, and prove
the plan at `production` is all no-ops. The plan needs the private public-key
input (`CHALK_INFRA_INPUTS`, a file with `{public_key_file}`):

```sh
AWS_PROFILE=q9labs CHALK_INFRA_INPUTS=<private inputs file> pnpm infra plan recorder-runtime-downloads production
```

Every resource must plan as a no-op. Any update or replacement means the
declaration differs from the seeded state: stop, and do not apply.
