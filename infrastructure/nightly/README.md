# Nightly backend configuration

Nightly runs the same backend images as production with separate data, keys and
provider resources. Runtime configuration files contain no credentials; the
OpenTofu roots provision nightly infrastructure. Use `nightly` as the deployment
identity. Sync still builds with `MIX_ENV=prod`.

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

Apply this root once when installing the retained allocation. On later host
replacements, update the nightly release configuration's `runtime.instance_id`
and the nightly managed deployment target together. The existing Release flow
calls `scripts/releases/media.py qualify` after deployment and before either
recorder cold boot. That caller automatically moves the existing tagged allocation
to the SSM target and waits for AWS to confirm it. A retry after a lost response
observes the completed move without remapping it again. Missing or ambiguous
allocations fail closed; Release never allocates, releases, or changes DNS.

The root reads only
`/chalk/nightly/release/recorder.json` and refuses a host without the
`chalk:environment=nightly` tag. Its separate state keeps the allocation when the
host is replaced; only the association moves. Do not destroy or recreate the
allocation during host replacement.

```sh
tofu -chdir=infrastructure/nightly/recording-control-address init -backend-config=/absolute/path/to/nightly-backend.hcl
tofu -chdir=infrastructure/nightly/recording-control-address plan -out=address.plan
tofu -chdir=infrastructure/nightly/recording-control-address apply address.plan
tofu -chdir=infrastructure/nightly/recording-control-address output -raw public_ip
```

Save the `allocation_id` output durably with the private backend coordinates and
DNS undo, outside temporary directories, before replacing a host or removing the
root. If that saved ID is lost, recover it read-only by its tags, then match the
returned public IP to `nightly-recording-control.chalkmeet.com` before importing:

```sh
aws ec2 describe-addresses --region ap-southeast-1 --filters Name=tag:Name,Values=chalk-nightly-recording-control Name=tag:chalk:environment,Values=nightly --query 'Addresses[].{AllocationId:AllocationId,PublicIp:PublicIp}'
```

The release requires [release-policy.json](recording-control-address/release-policy.json).
Use the private **Nightly recorder address permissions** operator runbook in the
repo's ignored `.private/` workspace for account-specific installation and undo.
Select credentials through that runbook, not through public documentation.
The policy allows address/instance reads and association of only the allocation
with both nightly recorder tags. The caller requires the SSM target to match
`CHALK_MANAGED_INSTANCE_ID` and rejects a target without
`chalk:environment=nightly`. The policy grants no allocate, release, disassociate,
DNS, or IAM-write permissions. No instance-profile change is required.

The backend file supplies the existing nightly state bucket, as in
`backend.hcl.example`. On the first install only, save the full Cloudflare record
as the undo and set **only** the DNS-only A record
`nightly-recording-control.chalkmeet.com` to this output, preserving its TTL and
other fields. Append `/32` to the IPv4 output for the capture and render recorder
policies' `control_addresses`, then apply both firewalls before the cold-boot check.
The current nightly firewalls already allow this destination. Keep that record
unchanged across later host replacements.
Confirm its public DNS answer matches the output before the signed recorder
cold-boot check. The output `allocation_id` identifies the same allocation for
read-only association checks and recovery. The allocation uses
`lifecycle.destroy = false`, which persists its retention policy in state even if
the block is removed. Reverting code does not release the live address; move the
retained allocation back to the previous nightly host to undo an association change.
If a removal apply forgets the allocation, import its saved `allocation_id` into
`aws_eip.control` before applying the restored root.

Run `tofu test` in this root with OpenTofu 1.12.3 for host selection and production
isolation. Run `python3 test_lifecycle.py` after `tofu init -backend=false` for a
stateful apply of the real root against a local EC2/SSM emulator. It proves the
allocation ID survives replacement, only the association moves, a lost response
recovers on retry, the next plan is a no-op, and removal retains the allocation.
`python3 test_lifecycle.py --negative replacement` injects an allocation-replacement
dependency and must fail the allocation-ID assertion. `--negative retention` removes
the retention policy and must fail the retained-removal assertion. These tests
create no cloud resources. Production's recorder
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
