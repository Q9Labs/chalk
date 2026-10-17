# Nightly backend configuration

Nightly runs the same backend images as production with separate data, keys and
provider resources. These files do not provision resources or contain credentials.
Use `nightly` as the deployment identity. Sync still builds with `MIX_ENV=prod`.

## Component names

| Component          | Nightly configuration                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed host       | `chalk-nightly-meeting`, persistent spot `t4g.small`, interruption behavior `stop`, 2 GiB RAM.                                                    |
| Managed deployment | `/chalk/nightly/managed-episode` SSM prefix and log group, `chalk-nightly-managed-episode-release` SSM document.                                  |
| API                | `https://nightly-api.chalkmeet.com`, CORS `https://nightly.chalkmeet.com`.                                                                        |
| Sync               | `https://nightly-sync.chalkmeet.com`, issuer `https://nightly-api.chalkmeet.com`, audience `chalk-nightly-sync`, instance `chalk-nightly-sync-1`. |
| Redis              | Host-local `redis://redis:6379/0`, no public port or persistence.                                                                                 |
| Database           | New empty `chalk-nightly` database, `main` branch, Postgres 18, separate API, direct Sync and direct migrator roles.                              |
| Recorder           | DigitalOcean team `Chalk Nightly`, project `Chalk Nightly Recording`, owner tag `chalk-nightly-recorder-owner`.                                   |
| Capture and render | BLR1 `c-2` capture and CPU `c-8` render, one node and one slot per pool, no spare or reservations.                                                |
| Recorder TLS       | `nightly-recording-control.chalkmeet.com`, worker control port 8443, issuer port 8444.                                                            |
| Storage            | Private R2 `chalk-recorder-nightly`, separate credentials and Singapore recording KEK.                                                            |
| Transcription      | `chalk-nightly-transcription-dispatcher`, audience `chalk-nightly-control-api`, separate workload and DeepInfra secrets.                          |
| Scheduler          | `chalk-nightly-transcription-reconcile` in group `chalk-nightly`, initially disabled.                                                             |
| Release metadata   | `/chalk/nightly/release/recorder.json`, with explicit nightly host, DO context and state coordinates.                                             |
| Uptime             | `wrangler.nightly.toml`, separate Worker secrets and explicit nightly API and Sync targets.                                                       |
| External services  | Separate SFU application, tunnel, Axiom datasets and tokens, Resend key and sender, Google OAuth client.                                          |

The controller's existing [runtime input contract](../managed-episode/contracts/runtime-inputs.json)
is the exact ID-to-SSM-suffix map. Prefix every suffix with
`/chalk/nightly/managed-episode`. All environment files, migrator credentials and
secret files use SecureString. The database proof uses String. Issue new bridge,
controller, issuer and worker trust roots. Keep internal service aliases and
SPIFFE identities, but never share a production signing key or trust root.

Start from the [API example](../managed-episode/env/api.nightly.env.example),
[Sync example](../managed-episode/env/sync.nightly.env.example) and recorder examples
in `env/`. Supply all placeholders privately. Recorder release metadata must select doctl context `chalk-nightly`, scoped to the dedicated team. The host controller injects release
identities and mounted certificate paths. Use only the dedicated DO team's tokens,
project ID, VPC UUID, firewall IDs and qualified image pins.

## Host bootstrap and memory

Supply `host-cloud-init.yaml` as user-data when an operator launches the approved
Ubuntu 24.04 arm64 host. The script checks cgroups v2, Quadlet and the rootless
user manager, then runs a disposable rootless smoke container. It contains no
runtime secrets. Verify SSM Online and a successful reboot before deployment.

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

Copy `transcription/backend.hcl.example` to a private file and replace its account
placeholder with the approved nightly state bucket. Initialize the caller with
`tofu -chdir=infrastructure/nightly/transcription init -backend-config=/private/backend.hcl`.
The backend has no production default. Its fixed key is
`transcription/terraform.tfstate`, with S3 locking and encryption enabled.

Supply `release_id`, `release_manifest_digest`, `config_digest`, `artifact_s3_key`,
`artifact_s3_object_version`, `artifact_sha256`, `artifact_sha256_base64`,
`deepinfra_corpus_digest`, `privacy_gate_accepted` and, when needed,
`ssm_kms_key_arns` through private inputs. The caller derives nightly artifact and
SSM names from the authenticated account. It creates no bucket, secret or Scheduler
group. Provisioning owns `chalk-nightly` outside this dispatcher state; the caller
and release rebinder reference that group by name.
Keep `scheduler_state=DISABLED` until the API release, workload secret and signed
control proof agree. Normal Release deployment rebinds the existing dispatcher
through the same scoped recorder metadata as production.

Set recorder policy inputs `environment=nightly`, `staging_evidence_digest`,
`ready_spare=0`, zero capture reservations and `render_desired_nodes=0`.
Supply the nightly control role, control addresses, R2 account and image evidence.
The policy root never creates runtime Droplets. Its API reconciler does.
