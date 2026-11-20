# DigitalOcean migration reference

Alchemy owns the production `sfu`, `sfu-standby` and `recorder` stacks. They were
seeded from their OpenTofu state on 2026-11-20 and released through `pnpm infra
deploy`. The OpenTofu roots and their state stay untouched as the rollback path
until one more clean Alchemy production release has run (see
[Roll back](#roll-back)). The retired Nightly roots stay OpenTofu-owned for cleanup
only.

## What the seed found

| Stack                    | Live resources against the OpenTofu state                                                                                                                          | First Alchemy plan                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Production `sfu`         | Droplet, firewall and operator key match. The firewall lacked the definition's TCP 50000 media fallback.                                                           | `Node noop`, `Firewall update` (adds TCP 50000). |
| Production `sfu-standby` | Droplet, firewall and operator key match the state and the definition.                                                                                             | `Node noop`, `Firewall noop`.                    |
| Production recorder      | KMS key, alias, R2 bucket, pool firewalls and tags match by identity. R2 CORS and the pool firewalls' control destination had moved since the last OpenTofu apply. | All seven resources `noop`.                      |

The seed records each resource as it is live, never as the stale OpenTofu
attributes, and logs every field where the two differ. It refuses an identity
mismatch: a different ID, name, account, region, location, attachment or public
access. A difference between live and the current definition then shows in the
first plan as an ordinary update, which a reviewer accepts or rejects before the
first deploy. A plan that replaces or deletes a Droplet, firewall, bucket or key
stops the cutover.

The seed also writes the stack output its first deploy would write, built by the
same function the stack returns (`stackOutput` in `sfu/config.ts` and
`recorder/resources.ts`). `migration/seed-output.test.ts` proves that a seeded
stack passes the deploy gate, plans no change and keeps its output, and that a
rerun refuses an output a deploy has since changed.

## Roll back

The original OpenTofu state objects were never changed, and dated copies sit
under `backup/2026-11-20-alchemy-cutover/` in each state bucket. To hand a stack
back to OpenTofu, set its registry row to `provisioner: "opentofu", seeded:
false`, then delete its Alchemy records and output (partition key
`STAGE#<stack>#production` in the `alchemy-state` table). Neither step touches a
live resource. A firewall change an Alchemy deploy made stays live until the next
`tofu apply` of that root.

## Resource mapping and discovery

All mappings use the commit recorded in [`platform/preview-build.json`](../platform/preview-build.json).

| OpenTofu address                                                                                       | Provider                       | Alchemy mapping                                 | Discovery without Alchemy state                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `module.node.data.digitalocean_ssh_key.operator`                                                       | DigitalOcean                   | Read-only `listSshKeys`, exact unique name      | The stack never creates or owns the operator key. Import verifies its ID and fingerprint.                                                              |
| `module.node.digitalocean_droplet.node`                                                                | DigitalOcean                   | `Chalk.DigitalOcean.SfuDroplet`, logical `Node` | Upstream reads an ID or generation tag, then reports a same-named unowned Droplet. Import first requires the original ID to exist and checks identity. |
| `module.node.digitalocean_firewall.node`                                                               | DigitalOcean                   | `DigitalOcean.Firewall`, logical `Firewall`     | UUID, then generated name. An explicit same-named firewall is unowned. Import checks the exact UUID and all rules.                                     |
| `data.aws_caller_identity.current`                                                                     | AWS                            | Existing AWS environment identity               | AWS credential chain in Singapore.                                                                                                                     |
| `data.aws_iam_policy_document.recording_kms`                                                           | AWS                            | `recorder/resources.ts:kmsPolicy`               | Pure policy construction, no cloud resource.                                                                                                           |
| `aws_kms_key.recording`                                                                                | AWS                            | `AWS.KMS.Key`, logical `RecordingKey`           | Cannot discover a key from desired props. Import looks up its original key ID.                                                                         |
| `aws_kms_alias.recording`                                                                              | AWS                            | `AWS.KMS.Alias`, logical `RecordingAlias`       | Exact alias name. Import verifies its target key.                                                                                                      |
| `cloudflare_r2_bucket.recording`                                                                       | Cloudflare                     | `Chalk.R2.RecordingBucket`                      | Explicit bucket name, account and jurisdiction. Import verifies the original bucket and private access.                                                |
| `cloudflare_r2_bucket_cors.whiteboard`                                                                 | Cloudflare                     | Same bucket's `cors`                            | Fresh endpoint read, including unrelated inventoried rules.                                                                                            |
| `cloudflare_r2_bucket_lifecycle.recording`                                                             | Cloudflare                     | Same bucket's `lifecycleRules`                  | Fresh endpoint read. Keeps the one-day temporary expiry and seven-day multipart abort, including original rule IDs.                                    |
| `module.capture.digitalocean_firewall.capture`                                                         | DigitalOcean capture           | `Chalk.DigitalOcean.CaptureFirewall`            | Original UUID and exact outbound-only rules.                                                                                                           |
| `module.render.digitalocean_firewall.render`                                                           | DigitalOcean render            | `Chalk.DigitalOcean.RenderFirewall`             | Original UUID and exact outbound-only rules.                                                                                                           |
| Each pool's `digitalocean_tag.pool`                                                                    | DigitalOcean capture or render | `Chalk.DigitalOcean.CaptureTag` and `RenderTag` | Exact tag name. Existing tags are unowned until imported.                                                                                              |
| `terraform_data.apply_gate`, `production_cutover_gate`, and both `runtime_capacity_contract` resources | OpenTofu built-in              | Validated config and root outputs               | No cloud object. Import checks each original metadata row and the full managed-resource set before any write.                                          |

These states contain no reserved IP, assignment, volume, owned SSH key, or DNS
record. The importer rejects unexpected resources rather than silently omitting them.
The SFU public IP and firewall attachment stay on the original Droplet.
Production primary SFU state and live rules agree, but both omit inbound TCP
50000, which the current legacy root and new definition require. Its strict
seed dry-run refuses that non-no-op configuration mismatch; standby passes.

## Lifecycle differences and provider gaps

- Upstream [packages/digitalocean/src/Droplet.ts:70](https://github.com/alchemy-run/alchemy/blob/852675fdd85bf84fa5fd033ece571b26f46920e0/packages/digitalocean/src/Droplet.ts#L70), `:325` replaces on size
  changes and offers no ignore-changes option. [`providers/digitalocean-sfu-droplet.ts`](../providers/digitalocean-sfu-droplet.ts) retains CPU/RAM-only
  resize with `disk: false`, and ignores image, SSH keys and user data after first
  creation. A resize requires `CHALK_SFU_ALLOW_RESIZE=true` after a separately
  approved drained, already-powered-off node operation. The provider never stops
  or restarts a live SFU. The migration never sets that flag.
- The custom SFU provider exposes only the original root's supported props.
  Region, monitoring and IPv6-removal changes cannot silently become updates.
- The SFU Droplet and firewall use `RemovalPolicy.protect()`. This is stronger
  than the old root: replacement or removal fails during planning. Rebuilds need
  a separate deliberate change. Droplet replacement's upstream create-before-delete
  behavior is not used for a live SFU.
- KMS and R2 `prevent_destroy` become `protect`, which also rejects replacement.
  The alias, pool tags and pool firewalls are protected too. Removing a declaration
  must not silently remove a shared tag or service policy.
- Upstream [packages/cloudflare/src/R2/Bucket.ts:1653](https://github.com/alchemy-run/alchemy/blob/852675fdd85bf84fa5fd033ece571b26f46920e0/packages/cloudflare/src/R2/Bucket.ts#L1653) returns old CORS and
  lifecycle attributes from `read`. The custom [`providers/cloudflare-recording-bucket.ts`](../providers/cloudflare-recording-bucket.ts) reads through
  the provider's full `lookup` so drift actually checks those endpoints.
  Its seed and definition canonicalize unordered policy sets because upstream
  [Bucket.ts:1366](https://github.com/alchemy-run/alchemy/blob/852675fdd85bf84fa5fd033ece571b26f46920e0/packages/cloudflare/src/R2/Bucket.ts#L1366) compares prop arrays by order.
- [packages/aws/src/KMS/Key.ts:238](https://github.com/alchemy-run/alchemy/blob/852675fdd85bf84fa5fd033ece571b26f46920e0/packages/aws/src/KMS/Key.ts#L238) cannot discover an existing key without an
  output ID. An explicit seed is required; `--adopt` is not a substitute.
- Upstream [packages/digitalocean/src/Tag.ts:76](https://github.com/alchemy-run/alchemy/blob/852675fdd85bf84fa5fd033ece571b26f46920e0/packages/digitalocean/src/Tag.ts#L76) includes runtime resource counts
  in its attributes. The custom pool tag providers persist only the name, so
  runtime fleet scaling does not become infrastructure drift.
- Each recorder pool has a distinct resource type and credential layer. Capture
  operations cannot accidentally run with render credentials, or vice versa.

Upstream source paths above refer to the full commit in [`platform/preview-build.json`](../platform/preview-build.json), not
the moving `main` branch. The checked-out source is outside the public repository.

## Inputs and credentials

SFU: set `CHALK_INFRA_INPUTS` to private JSON with `environment`,
`control_addresses`, and optional `size`, `region`, `ssh_key_name`, and
`ssh_addresses`. Historical `nightly` mapped to legacy `staging`; both are retired, never deployable. Set `CHALK_SFU_STACK` to
`sfu` or `sfu-standby`; the default is `sfu`. Keep the same credential source as
the old root: `DIGITALOCEAN_TOKEN` from `doctl auth token`.

Recorder: set `CHALK_INFRA_INPUTS` to private JSON using the existing
snake_case input names. Defaults, validations, KMS context cutover acknowledgment,
capacity formulas, qualification evidence and production bucket-adoption evidence
remain enforced. Unknown fields and embedded credentials fail validation.
Supply secrets separately:

- `CHALK_CAPTURE_DIGITALOCEAN_TOKEN` replaces `capture_provider_token`.
- `CHALK_RENDER_DIGITALOCEAN_TOKEN` replaces `render_provider_token`.
- `CLOUDFLARE_API_TOKEN` replaces `cloudflare_api_token`.
- `CLOUDFLARE_ACCOUNT_ID` must match the private recorder config.

Use the existing protected per-pool tokens. Release tooling obtains the pool's
`DIGITALOCEAN_TOKEN` from its protected environment/SSM settings. Do not print it
or put it in JSON inputs. Read-only verification used the existing doctl credential
for DigitalOcean and a reachable 1Password Cloudflare credential. No permission
was changed and no credential is missing for the reads performed.

Root output names and sensitive-output redaction are preserved. Recorder also exposes `capture` and `render`
output groups with each old module's `droplet_ids`, `droplet_names` and
`firewall_id`. Empty Droplet lists do not confer runtime ownership. The SFU also
exposes the node module's `droplet_id`.

## Remaining OpenTofu consumers

The dispatcher lane already has `scripts/recorder/alchemy_dispatcher.py` and its
engine driver under `releases/`. They implement a dispatcher-specific
closed release policy, not a second SFU/recorder release workflow. No new driver
was added here. This lane leaves dispatcher-owned files untouched.

The following local paths still require the legacy toolchain:

- `scripts/recorder/gate.sh` and `scripts/recorder/tofu-init.sh` validate the
  retained recorder root.
- Dispatcher calls in `scripts/releases/media.py`,
  `scripts/recorder/dispatcher_binding.py` and
  `scripts/transcription-dispatcher/configure-mai.py` now use Alchemy.
  `scripts/releases/check-contracts.sh` uses the infrastructure typecheck,
  not deleted dispatcher, address or CDN OpenTofu roots.
- `.github/workflows/cache-warm.yml`, `.github/workflows/ci.yml` and
  `.github/workflows/gate.yml`, their OpenTofu setup/cache actions and tool pins remain.
  Release-contract validation no longer installs OpenTofu.
- The legacy SFU and recorder roots stay as the rollback path until one more
  clean Alchemy production release has run; then delete them with the toolchain.
  The direct Sync root stays for Nightly cleanup. No script points at a deleted root.

Do not remove shared OpenTofu CI or pins until a fresh search of the merged
branches finds no remaining execution path. The recorder gate now also runs the
strict Alchemy typecheck, DigitalOcean contract tests, and SFU template tests.
