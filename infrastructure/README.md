# Infrastructure

Stacks describe product capabilities, not environments. Each registered stack has
`<component>/alchemy.run.ts`, `<component>/config.ts` and `README.md`. SFU variants share one
component. Runtime assets under `sfu`, `recorder` and `managed-episode` stay put.

## Vocabulary

| Name                         | What it is for                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `recorder-runtime-downloads` | Delivers signed recorder software bundles to recorder hosts, **not finished user recordings**.             |
| `recorder-control-endpoint`  | Gives a recorder controller a stable public network endpoint.                                              |
| `sync-direct-access`         | Connects clients directly to a Sync host without its tunnel.                                               |
| `media-relay-access`         | Supplies credentials for relaying media when direct connectivity fails.                                    |
| `sfu` / `sfu-standby`        | Runs the primary / standby media forwarding server.                                                        |
| `recorder`                   | Provisions capture and render workers and recording storage.                                               |
| `transcription-dispatcher`   | Dispatches transcription work and reconciles stalled jobs.                                                 |
| `transcription-storage`      | Defines temporary transcription-object cleanup; it is an unused reusable declaration, not an eighth stack. |

The download name follows [recorder release keys](../scripts/recorder/README.md)
(`recorder/<role>/<sha256>.tar.gz`) and the recorder fleet's signed-bundle adapter.
Finished recording downloads are a different product capability.

## Layout

- `platform/`: shared stage, credential, input and state boundaries, plus the pinned preview-build guard.
- `providers/`: cloud-provider-specific resources, with tests beside each provider.
- `releases/`: check a declared plan policy and apply the same in-memory plan; also run-owned lifecycle operations.
- `migration/`: temporary OpenTofu import, retirement and declaration-comparison tools; delete after the last cutover and retirement.
- Component directories: one stack and its typed configuration, documentation and owned assets.

There is no framework, base class or environment-specific stack entrypoint.

## Stack and stage registry

`registry.ts` is the authority for commands, type/contract checks, drift CI and
this checked table. Run `pnpm infra table` after changing it.

<!-- stacks:start -->

| Stack                      | Stage kind                              | Provisioner       | Status                                                                                                                                                                                                                                 | Entry                                                                                  |
| -------------------------- | --------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| recorder-control-endpoint  | retired legacy Nightly (not deployable) | cleanup inventory | Retire: persistent Nightly host removed 2026-11-15 (PR #1432); proofs create and delete their own host                                                                                                                                 | [recorder-control-endpoint/alchemy.run.ts](recorder-control-endpoint/alchemy.run.ts)   |
| sync-direct-access         | retired legacy Nightly (not deployable) | cleanup inventory | Retire: persistent Nightly host removed 2026-11-15 (PR #1432); proofs create and delete their own host                                                                                                                                 | [sync-direct-access/alchemy.run.ts](sync-direct-access/alchemy.run.ts)                 |
| sfu                        | retired legacy Nightly (not deployable) | cleanup inventory | Retire: shared staging SFU removed 2026-11-15 (PR #1453); proofs use isolated run-owned SFU instances                                                                                                                                  | [sfu/alchemy.run.ts](sfu/alchemy.run.ts)                                               |
| sfu-standby                | retired legacy Nightly (not deployable) | cleanup inventory | Retire: shared staging SFU removed 2026-11-15 (PR #1453); proofs use isolated run-owned SFU instances                                                                                                                                  | [sfu/alchemy.run.ts](sfu/alchemy.run.ts)                                               |
| recorder                   | retired legacy Nightly (not deployable) | cleanup inventory | Retire: ported, deliberately not deployed after persistent host removal (2026-11-15, PR #1432); original Nightly state is stale                                                                                                        | [recorder/alchemy.run.ts](recorder/alchemy.run.ts)                                     |
| transcription-dispatcher   | retired legacy Nightly (not deployable) | cleanup inventory | Retire: no between-run control API or reconciliation schedule; per-run proof replaces the old release gate                                                                                                                             | [transcription-dispatcher/alchemy.run.ts](transcription-dispatcher/alchemy.run.ts)     |
| transcription-dispatcher   | nightly-<run-id> (ephemeral)            | alchemy           | Run-owned deploy/release/convergence/cleanup proof; no seed or always-on Nightly                                                                                                                                                       | [transcription-dispatcher/alchemy.run.ts](transcription-dispatcher/alchemy.run.ts)     |
| transcription-dispatcher   | production (persistent)                 | alchemy           | Production: seeded from its former OpenTofu state; releases run through the guarded driver and OpenTofu holds no records of it                                                                                                         | [transcription-dispatcher/alchemy.run.ts](transcription-dispatcher/alchemy.run.ts)     |
| sfu                        | production (persistent)                 | opentofu          | Primary variant: ported; live firewall drift blocks cutover                                                                                                                                                                            | [sfu/alchemy.run.ts](sfu/alchemy.run.ts)                                               |
| sfu-standby                | production (persistent)                 | opentofu          | Standby variant: ported; dry-run is not cutover authorization                                                                                                                                                                          | [sfu/alchemy.run.ts](sfu/alchemy.run.ts)                                               |
| recorder                   | production (persistent)                 | opentofu          | Ported; reconcile CORS/pool firewall drift before cutover                                                                                                                                                                              | [recorder/alchemy.run.ts](recorder/alchemy.run.ts)                                     |
| recorder-runtime-downloads | production (persistent)                 | alchemy           | Production: the CloudFront distribution serves signed recorder software bundles and is referenced by production SSM (the CHALK_RECORDER_FLEET_ARCHIVE_CDN settings). Alchemy owns it; its state sits under its own production identity | [recorder-runtime-downloads/alchemy.run.ts](recorder-runtime-downloads/alchemy.run.ts) |
| media-relay-access         | production (persistent)                 | none              | Ported, deliberately not deployed; TURN key creation/adoption not authorized                                                                                                                                                           | [media-relay-access/alchemy.run.ts](media-relay-access/alchemy.run.ts)                 |

<!-- stacks:end -->

`production` is persistent. `nightly-<run-id>` is ephemeral: a lowercase
alphanumeric/hyphen run ID of 1–15 characters, with alphanumeric ends. Bare
`nightly` is rejected. Retired rows are cleanup inventory, never active stages.
The former persistent Nightly stages retire, except the recorder runtime
downloads CDN: it serves production, so it is a production target (see below),
never a retirement. The dispatcher gains a run-owned deployment for the
production-cutover proof. Existing Nightly media proofs already create/delete
their hosts and use isolated runtime assets; they do not need the retired
address, direct Sync trial or shared SFU.

The registry discriminates ownership and seeding: a production Alchemy owner
must be seeded; OpenTofu/not-deployed rows cannot deploy. Deploy also checks real
resource/output state, so metadata cannot bypass a missing seed.

## Commands

```sh
pnpm infra list
pnpm infra plan transcription-dispatcher production
pnpm infra drift transcription-dispatcher production
pnpm infra deploy transcription-dispatcher nightly-123456
pnpm infra destroy transcription-dispatcher nightly-123456
pnpm infra prove transcription-dispatcher nightly-123456
```

Plan/drift are read-only cloud operations but acquire a stage lease. Never run
them concurrently with another lane's proof. Deploy/destroy are explicit writes.
Destroy only accepts ephemeral stages, deletes owned resources and stage state,
and is retry-idempotent. Production deploy is refused until cut over and seeded.
The proof command deploys, makes one checked versioned-code release, requires a
no-op re-plan and clean drift, and destroys twice even when the proof fails.
See [proof and retirement instructions](migration/README.md).

## One input boundary

Set `CHALK_INFRA_INPUTS` to a protected JSON file. Each component's `<component>/config.ts`
parses a typed schema with excess-property rejection before resource work.
Input keys use `snake_case`; never commit private input files. Schema failures
name the component/source without printing values. SFU and recorder retain their
existing typed config shapes; the SFU variant is selected by the registry.

Examples of required shapes: recorder-runtime downloads `{public_key_file}`;
recorder control endpoint `{instance_id}`; Sync direct access
`{instance_id, hostname, zone_id, ipv4_address, ipv6_address?}`. Read the component
schemas for complete recorder, SFU and dispatcher inputs.

The dispatcher has one deliberate exception: normal releases read the deployed
redacted `dispatcher_inputs` output when no proposed file is supplied. The
release policy compares proposed inputs to this deployed authority; rebuilding
configuration from unrelated environment variables would weaken that guarantee.
Only a new ephemeral stage may bootstrap without previous output, and only
with explicit validated inputs. Production always fails loudly when unseeded.

## One credential boundary

Credentials are not stack inputs. `platform/credentials.ts` and `<component>/config.ts`
resolve them from the protected operator/CI environment and never print values:

| Provider                    | Source                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| AWS                         | Standard credential chain: operator `AWS_PROFILE` or CI/instance role; state is in `ap-southeast-1`.            |
| Cloudflare                  | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.                                                             |
| DigitalOcean SFU            | `DIGITALOCEAN_TOKEN`.                                                                                           |
| DigitalOcean recorder pools | `CHALK_CAPTURE_DIGITALOCEAN_TOKEN`, `CHALK_RENDER_DIGITALOCEAN_TOKEN`; separate pool authorities stay separate. |

Missing credentials name the missing source, never its value. State uses the
existing `alchemy-state` store and overflow objects; no account identifier is
stored in the repository.

## Alchemy stacks

All stacks use one [pinned preview graph](platform/preview-build.json), guarded
by `pnpm --dir infrastructure run check-types`. Run all infrastructure tests
with `pnpm --dir infrastructure test`. The [release mechanism](releases/README.md)
contains the Python-to-TypeScript policy parity table.

The [drift workflow](platform/README.md) is gated off until its dedicated role is
configured and checked. It follows only active, seeded production cutovers;
currently that list is empty. Retired Nightly schedules are deleted by
retirement, not maintained in a permanently disabled steady state.

## Migration and retained OpenTofu

Use [migration instructions](migration/README.md) for import, declaration parity,
retirement and the new production-cutover proof. SFU, recorder and the retained
[direct Sync trial](managed-episode/direct-sync/README.md) keep runnable OpenTofu
roots. Never let two provisioners own one stage concurrently. Physical resource
names and existing logical IDs are unchanged; legacy state identities remain
explicit in the registry until retirement. The recorder runtime downloads stage
already runs under its own production identity.
