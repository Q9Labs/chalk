# Nightly backend configuration

Nightly runs the same backend images as production with separate data, keys and
provider resources. These files do not provision resources or contain credentials.
Use `nightly` as the deployment identity. Sync still builds with `MIX_ENV=prod`.

## Component names

| Component          | Nightly configuration                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Managed host       | `chalk-nightly-meeting`, persistent spot `t4g.small`, interruption behavior `stop`, 2 GiB RAM.                                            |
| Managed deployment | `/chalk/nightly/managed-episode` SSM prefix and log group, `chalk-nightly-managed-episode-release` SSM document.                          |
| API                | `https://nightly-api.chalkmeet.com`, CORS `https://nightly.chalkmeet.com`.                                                                |
| Sync               | `https://nightly-sync.chalkmeet.com`, issuer `https://nightly-api.chalkmeet.com`, audience `chalk-sync`, instance `chalk-nightly-sync-1`. |
| Redis              | Host-local `redis://redis:6379/0`, no public port or persistence.                                                                         |
| Database           | New empty `chalk-nightly` database, `main` branch, Postgres 18, separate API, direct Sync and direct migrator roles.                      |
| Recorder           | Shared DigitalOcean team, private configured builder context, separate nightly project and fleet owner tag.                               |
| Capture and render | BLR1 `c-2` capture and CPU `c-8` render, one node and one slot per pool, no spare or reservations.                                        |
| Recorder TLS       | `nightly-recording-control.chalkmeet.com`, worker control port 8443, issuer port 8444.                                                    |
| Storage            | Private R2 `chalk-recorder-nightly`, separate credentials and Singapore recording KEK.                                                    |
| Transcription      | `chalk-nightly-transcription-dispatcher`, audience `chalk-nightly-control-api`, separate workload and DeepInfra secrets.                  |
| Scheduler          | `chalk-nightly-transcription-reconcile` in group `chalk-nightly`, initially disabled.                                                     |
| Release metadata   | `/chalk/nightly/release/recorder.json`, with explicit nightly host, DO context and state coordinates.                                     |
| Uptime             | `wrangler.nightly.toml`, separate Worker secrets and explicit nightly API and Sync targets.                                               |
| External services  | Separate SFU application, tunnel, Axiom datasets and tokens, and Google OAuth client; no email sender.                                    |

The controller's existing [runtime input contract](../managed-episode/contracts/runtime-inputs.json)
is the exact ID-to-SSM-suffix map. Prefix every suffix with
`/chalk/nightly/managed-episode`. All environment files, migrator credentials and
secret files use SecureString. The database proof uses String. Issue new bridge,
controller, issuer and worker trust roots. Keep internal service aliases and
SPIFFE identities, but never share a production signing key or trust root.

Start from the [API example](../managed-episode/env/api.nightly.env.example),
[Sync example](../managed-episode/env/sync.nightly.env.example) and recorder examples
in `env/`. Supply all placeholders privately. Recorder release metadata selects the existing builder context in the shared team.
The host controller injects release identities and mounted certificate paths.
Nightly keeps its own project, VPC UUID, firewall IDs, fleet tags and certificates.
Nightly and production select the same qualified image IDs; boot-time configuration
supplies each environment's own issuer CA and server name.

## Host bootstrap and memory

Supply `host-cloud-init.yaml` as user-data when an operator launches the approved
Ubuntu 24.04 arm64 host. The script checks cgroups v2, Quadlet and the rootless
user manager, then runs a disposable rootless smoke container. It contains no
runtime secrets. Verify SSM Online and a successful reboot before deployment.

### Stable recorder address

The nightly Spot host must use the Elastic IP owned by
[`recording-control-address`](recording-control-address/main.tf). An automatically
assigned public IP changes after a Spot stop/start, leaving the recorder's direct
TLS hostname pointing at the previous address. The API tunnel does not replace
this direct listener.

Apply this root after provisioning a host or changing the nightly release
configuration's `runtime.instance_id`, before running Release. It reads only
`/chalk/nightly/release/recorder.json` and refuses a host without the
`chalk:environment=nightly` tag. Its separate state keeps the allocation when the
host is replaced; only the association moves. Do not destroy or recreate the
allocation during host replacement.

```sh
export AWS_PROFILE=q9labs
tofu -chdir=infrastructure/nightly/recording-control-address init -backend-config=/absolute/path/to/nightly-backend.hcl
tofu -chdir=infrastructure/nightly/recording-control-address plan -out=address.plan
tofu -chdir=infrastructure/nightly/recording-control-address apply address.plan
tofu -chdir=infrastructure/nightly/recording-control-address output -raw public_ip
```

The backend file supplies the existing nightly state bucket, as in
`backend.hcl.example`. On the first install only, save the full Cloudflare record
as the undo and set **only** the DNS-only A record
`nightly-recording-control.chalkmeet.com` to this output, preserving its TTL and
other fields. Keep that record unchanged across later host replacements.
Confirm its public DNS answer matches the output before the signed recorder
cold-boot check. The output `allocation_id` identifies the same allocation for
read-only association checks and recovery. Reverting code does not release the
live address; move the retained allocation back to the previous nightly host to
undo an association change.

Run `tofu test` in this root with OpenTofu 1.12.3 to exercise first installation,
association with a replacement host, and rejection of a production host.
The tests mock AWS and do not create cloud resources. Production's recorder
address is not managed by this root.

`render-runtime <manifest> <output> nightly` selects the following caps.
Production rendering remains unchanged.

| Container                           | Cap, MiB |
| ----------------------------------- | -------: |
| API                                 |       96 |
| Sync                                |      256 |
| Redis                               |      320 |
| Tunnel                              |       48 |
| Capture controller                  |       32 |
| Render controller                   |       32 |
| Issuer                              |       32 |
| One-shot migrator                   |       64 |
| Total including migrator            |      880 |
| Host OS reserve                     |      640 |
| Free after caps and host OS reserve |      528 |

The 640 MiB host reserve exceeds the measured production idle non-container
usage of about 618 MB. Redis retains its 256 MiB maxmemory policy.
These are configured limits, not a
load measurement. Verify actual headroom during the synthetic recording and
transcription call. An out-of-memory failure rejects the candidate.

## Database and privacy

Create an empty database, not a branch or restore of production. Verify empty
user tables before the first migration. Use the dedicated owner credential only
in the migrator mount. Supply a genuine nightly direct-connection Sync proof.
Single-node configuration disables the standby requirement but still verifies
writability, fsync, full-page writes, checksums and synchronous commit.

The [add-only migration rule](../../apps/api/docs/database-workflow.md) and its
existing gate apply to nightly and production. No production schema or rows
change when this configuration lands. Transcription requires explicit privacy
acceptance and a qualified corpus digest before the module can plan.

## Transcription caller

Release builds and qualifies a dispatcher ZIP when its inputs changed or nightly
has no complete dispatcher installation. It initializes this caller using the
nightly state bucket, imports the two provisioned IAM roles and the provisioned
`/aws/lambda/chalk-nightly-transcription-dispatcher` log group if absent from state,
and applies a non-destructive first-install plan. A retry resumes partial state.
The module references the provisioned `chalk-nightly` scheduler group.

After the backend is healthy, Release deploys the exact versioned ZIP and enables
the reconciler before the signed recorder boot and transcript proof. Promote
copies the same ZIP bytes to production without building them again. Normal
updates permit only code, release binding metadata and scheduler state changes.
The nightly cron remains disabled until the lead authorizes the first cut.

Set recorder policy inputs `environment=nightly`, `staging_evidence_digest`,
`ready_spare=0`, zero capture reservations and `render_desired_nodes=0`.
Supply the nightly control role, control addresses, R2 account and image evidence.
The policy root never creates runtime Droplets. Its API reconciler does.
