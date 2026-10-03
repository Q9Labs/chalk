# Recorder infrastructure contract

This OpenTofu root is policy-only for the recorder compute pools. It owns
immutable pool tags, unattached outbound-only firewalls, release/image
contracts, the private temporary R2 bucket lifecycle, and the Singapore
recording KEK. It never creates or replaces runtime Droplets: the external
recorder reconciler owns scheduled prewarm, scale-to-zero, desired capacity,
fencing, and replacement, so replacement cannot exceed ten capture nodes,
ten render nodes, or the twenty-node global cap.

The default capture pool uses BLR1 CPU-Optimized two-vCPU nodes. Confirm current
regional size availability before applying; `capture_region` is configurable.
Direct control TLS egress on ports 8443/8444 requires the exact managed-host
`control_addresses` (/32 or /128); the workers still accept no inbound traffic.
Its configured
per-node admission targets are one serial Episode, forty participants, and sixteen
Mbps; these are capacity inputs, not a claim of regional load qualification.
The root exposes the contract formula as `desired_capture_nodes`:

```text
max(episodes, ceil(participants / 40), ceil(input_mbps / 16))
+ ready_spare (fixed at zero)
```

Reservations are checked against ten Episodes, one hundred participants, and
forty Mbps of aggregate input. Render-phase pipelines do not occupy capture
admission. The capture pool supports at most ten concurrent captures with zero
spare, independently of ten render nodes. A smaller capture or render maximum lowers the supported
concurrency; operators must reduce the admission ceiling with it before launch.
The default render target uses BLR1 and the measured CPU-Optimized eight-vCPU
`c-8`/`libx264` profile with the native Node compositor and a deadline-aware
scaler capped at ten nodes. The smaller `c-2` successor uses the same native
compositor. Both pools default to zero desired nodes. A GPU pool
remains configurable by setting `render_gpu = true` together with an independently
qualified GPU image, region, and size; CPU and GPU artifacts are never mixed.

## External fleet reconciliation

The runtime controller is implemented as a provider-neutral state machine in
`apps/api/internal/recorderfleet`. Its initial qualification path is
zero nodes → one bootstrapping node → one role-fenced ready node → admission
closed → active leases drained → certificate revoked → zero nodes. The same
contract accepts configured targets up to the eleven-node capture and ten-node
render limits. The controller saturates its operational target at the configured
limit while preserving raw demand for capacity signals.

The controller does not infer demand from claimable jobs. Its authoritative
demand source must include scheduled prewarms and held unscheduled starts in
addition to queued work. This avoids a bootstrap deadlock: Recording admission
already requires ready pool capacity before it creates the pending capture job.

`apps/api/internal/adapters/digitalocean` provides the DigitalOcean inventory,
idempotent adoption/create, firewall attachment, and exact-delete adapter.
`apps/api/internal/adapters/recorderfleetjournal` provides an atomic `0600`
local journal for an explicitly single-leader deployment. A highly available
deployment must replace that journal with a shared fenced `JournalStore`; it
must not run multiple controllers against one local file.

The control-plane integrations remain explicit ports:

- demand is versioned, bounded, and fresh;
- readiness and active-lease observations are per node, never worker-written
  aggregate pool health;
- aggregate capacity is published only by a SPIFFE identity with the distinct
  `recorder-fleet-controller` role;
- capture and render identities cannot cross the controller or opposite-pool
  role fences;
- bootstrap issuance verifies the live Droplet inventory digest and delivers
  a one-time assertion without returning or journaling it;
- scale-down closes admission before waiting for leases, revokes the issued
  identity before exact Droplet deletion, and quarantines foreign inventory.

The DigitalOcean token belongs only to the external controller. User data
contains the environment, pool, release, image digest, bootstrap endpoint, and
boot generation, but never a provider token, bootstrap assertion, worker
certificate, or reusable Chalk credential.

### Controller command and control-plane API

Run one single-leader process per pool from `apps/api`:

```sh
go run ./cmd/recorder-fleet-controller
```

The command requires the `CHALK_RECORDER_FLEET_*` settings for environment,
role, control-plane URL, controller certificate/key, server CA/name, SPIFFE
trust domain, journal path, owner tag, max nodes, slots per node, release ID,
image ID/digest, region, size, firewall ID, and bootstrap endpoint. The
corresponding uppercase suffixes are `ENVIRONMENT`, `ROLE`,
`CONTROL_PLANE_URL`, `CONTROLLER_CERT`, `CONTROLLER_KEY`, `SERVER_CA`,
`SERVER_NAME`, `SPIFFE_TRUST_DOMAIN`, `JOURNAL_PATH`, `OWNER_TAG`, `MAX_NODES`,
`SLOTS_PER_NODE`, `RELEASE_ID`, `IMAGE_ID`, `IMAGE_DIGEST`, `REGION`, `SIZE`,
`FIREWALL_ID`, `BOOTSTRAP_ENDPOINT`, and `GPU`. `DIGITALOCEAN_TOKEN` is also required;
`CHALK_RECORDER_FLEET_DIGITALOCEAN_API_URL`,
`CHALK_RECORDER_FLEET_DIGITALOCEAN_PROJECT_ID`, and
`CHALK_RECORDER_FLEET_DIGITALOCEAN_VPC_UUID` are optional. Duration overrides
use `DEMAND_MAX_AGE`, `OBSERVATION_MAX_AGE`, `STARTUP_TIMEOUT`, `DRAIN_TIMEOUT`,
`HEALTH_REFRESH`, and `RECONCILE_INTERVAL` with Go duration syntax.
Set `CHALK_RECORDER_FLEET_SLOTS_PER_NODE=1` for both the serial capture pool and
the one-job-per-node render pool. This setting is required; the command has no
implicit role-specific default.
`CHALK_RECORDER_FLEET_SSH_KEY_IDS` is an optional comma-separated list of at
most eight DigitalOcean public key IDs. It does not open the firewall.
DigitalOcean refuses to create a Droplet from a custom-base image, such as the
lean Debian Capture image, unless the request names an SSH key. In production,
set it only to the `chalk-recorder-no-login` key: its private half was never
stored, so nobody can log in with it, and the no-inbound policy still holds.
Never add a key whose private half exists.

The controller certificate must have exactly one URI SAN:
`spiffe://<trust-domain>/environment/<environment>/recorder-fleet-controller/<uuid>`.
The Chalk control-plane client requires TLS 1.3, explicit server roots and
server name, and does not follow redirects. Its certificate-bearing transport
is never reused for DigitalOcean requests.

`apps/api/internal/adapters/recorderfleetcontrol` defines this strict JSON API
under `/internal/v1/recorder/fleet`:

| Method and path                             | Request schema                                                                                                                              | Success response                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /demand?role=<role>`                   | none                                                                                                                                        | `recorder_fleet_demand.v1` with top-level `environment`, `role`, `revision`, `desired_nodes`, `scheduled_prewarms`, `held_starts`, `queued_jobs`, and `observed_at`                  |
| `GET /nodes?role=<role>`                    | none                                                                                                                                        | `recorder_fleet_nodes.v1` with top-level `environment`, `role`, and `nodes`; every node contains its fenced `identity`, readiness, admission, capacity, leases, and observation time |
| `POST /nodes/<provider-id>/bootstrap`       | `recorder_fleet_bootstrap.v1` plus `key`, provider/node identity, region, release/image binding, boot generation, and live inventory digest | the same schema version plus top-level `environment`, `role`, and the issued non-secret node `identity`                                                                              |
| `POST /nodes/<provider-id>/admission/close` | `recorder_fleet_command.v1` with `environment` and exact node `identity`                                                                    | empty `204`                                                                                                                                                                          |
| `POST /nodes/<provider-id>/identity/revoke` | `recorder_fleet_command.v1` with `environment` and exact node `identity`                                                                    | empty `204`                                                                                                                                                                          |
| `PUT /pool`                                 | `recorder_fleet_pool.v1` plus the pool projection                                                                                           | empty `204`                                                                                                                                                                          |

Responses are limited to 1 MiB, reject unknown or trailing JSON, and must echo
the configured environment and role. The bootstrap response returns only the
non-secret node identity: the backend must validate the supplied live inventory
digest and deliver its signed, one-time assertion directly to that node.

The API handlers, durable fleet authority, issuer protocol, and CPU image
bootstrap agent are implemented in this tree. Bootstrap remains fail-closed
unless the separately deployed issuer is configured. The node generates its
Ed25519 key locally, proves possession over a short-lived challenge, and accepts
the leaf certificate only over issuer-pinned TLS after the issuer binds the TCP
peer address to exact live DigitalOcean inventory. Provider metadata supplies a
claimed ID only; it is never treated as authentication. The controller never
receives the private key or fabricates bootstrap/readiness state.

The five-minute scheduled prewarm is a scaling signal, not a media-start hold.
This release does not gate Episode media on capture-worker attachment, so an
immediate Recording can begin before cold capacity arrives. Production must keep
enough warm capture capacity for its startup objective and monitor that gap.

## Recorder images

### Minimal Capture image

`images/capture` builds only `recorder-capture` and
`chalk-recorder-bootstrap`. Build the release on a Linux AMD64 host with Go,
`jq`, `tar`, and `sha256sum`; the build records the source commit and a
deterministic source-tree digest. Create the image builder in BLR1 from the
Debian 13 genericcloud custom image `247595332` on
`s-1vcpu-512mb-10gb` (or `s-1vcpu-1gb` with the same 10 GB disk). Do not
resize its disk: the snapshot must fit `s-1vcpu-512mb-10gb`.

```sh
infrastructure/recorder/images/capture/build-release.sh \
  --source /absolute/path/to/chalk --release-id <release-id> \
  --output /absolute/path/chalk-recorder-capture.tar.gz

sudo infrastructure/recorder/images/capture/install.sh \
  --bundle /absolute/path/chalk-recorder-capture.tar.gz \
  --bundle-sha256 <bundle-sha256> \
  --bootstrap-ca /absolute/path/issuer-server-ca.pem \
  --bootstrap-server-name <issuer-server-name>

sudo infrastructure/recorder/images/cpu/seal.sh
```

Run the installer and seal on that clean Debian builder, then shut it down and
snapshot it. The installer places only the two binaries, Capture and renewal
units, `capture.env` (10-second keyframes), bootstrap CA, and image metadata.
There is no Node, Chromium, FFmpeg, or boot-time package installation. Its
`capture-minimal-v1` manifest hashes only these installed recorder files; the
same digest pin, file rehash, one-time assertion, inventory match, and seal
checks apply. Bootstrap accepts that profile only for the Capture role.

Publish the printed `image_manifest_digest` and new snapshot ID to the
**Capture** image pin only; leave the Render image pin unchanged. The
infrastructure root has separate `capture_image_id`/`capture_image_digest` and
`render_image_id`/`render_image_digest` inputs, and each controller loads its
own role-fenced release. Set the Capture controller's image ID and digest
together after the API and issuer support for the new release is deployed.
Validate the exact snapshot and size in a staging Capture boot before promotion.

### Shared Capture/Render image

`images/cpu` builds one Ubuntu 24.04 AMD64 release containing both real worker
daemons, the native Node compositor, and the node bootstrap/renewal
agent. Build the public artifact on a machine with sufficient CPU, then install
it on a clean 25-GiB `c-2` builder so the resulting DigitalOcean snapshot can
launch both `c-2` capture and `c-8` render nodes:

```sh
sudo infrastructure/recorder/images/cpu/build-release.sh \
  --source /absolute/path/to/chalk \
  --release-id <release-id> \
  --output /absolute/path/chalk-recorder-cpu.tar.gz

sudo infrastructure/recorder/images/cpu/install.sh \
  --bundle /absolute/path/chalk-recorder-cpu.tar.gz \
  --bundle-sha256 <bundle-sha256> \
  --bootstrap-ca /absolute/path/issuer-server-ca.pem \
  --bootstrap-server-name <issuer-server-name>
```

The build uses checksum-pinned Go 1.25.13 and Node.js 22.23.2 toolchains plus
pnpm 10.26.2. It records the Git commit, a deterministic SHA-256 of the complete
public source tree and every installed recorder file. The
installer prints `image_manifest_digest`; this is specifically the SHA-256 of
`/opt/chalk-recorder/image-manifest.json`, not an OCI digest or a digest of the
entire VM filesystem. Cloud-init supplies that exact value as
`CHALK_RECORDER_FLEET_IMAGE_DIGEST`, and the bootstrap agent rehashes the
manifest and every listed file before it generates a node key or contacts the
issuer.

The manifest also attests the baked bootstrap TLS server name and CA SHA-256.
Copy `/opt/chalk-recorder/image-manifest.json` off the image builder alongside
the printed digest. For each Capture and Render pool, run:

```bash
images/verify-bootstrap-name.py \
  --manifest <local-manifest-path> \
  --image-digest <printed-image-manifest-digest> \
  --bootstrap-endpoint <fleet-bootstrap-endpoint>
```

It fails on a digest or endpoint-host mismatch and prints two bounded
`CHALK_RECORDER_FLEET_*` assignments. Put those assignments in that pool's
existing `recorder/capture.env` or `recorder/render.env` runtime input, with
the same digest in `CHALK_RECORDER_FLEET_IMAGE_DIGEST`. Nothing is required
from the publisher for the next release: when both claim inputs are absent,
controller startup logs one warning and continues. Adding
both assignments enables strict validation: incomplete or stale claims, or a
baked name differing from the endpoint host, reject startup before
reconciliation. The worker independently compares its
actual baked name and CA with the attested manifest before contacting the
issuer. No new runtime mount or SSM parameter is needed.

Before snapshotting, stop any worker and run `sudo images/cpu/seal.sh` from this
directory. It removes bootstrap/runtime identity files, operator authorized
keys, SSH host keys, cloud-init state, machine identity, histories, journals,
and temporary build material. Shut down the builder, create the immutable
snapshot, and configure both controllers with its numeric image ID and the
printed manifest digest. The first boot regenerates host/machine identity; the
external reconciler's cloud-init runs the one-time bootstrap and starts only the
role named by the fenced pool release.

Each sealed render image composes the `recording_presentation.v1` timeline
natively with Node and FFmpeg. The capture service uses the same credential
delivery path. A renewal timer derives its lead time as one third of each issued
certificate lifetime, atomically replaces the leaf, and both workers swap to a
fresh HTTP connection pool on the next control request without stopping an
active attempt.

### Deferred Export compatibility and release order

The database constrains both presentation baselines and finalized presentations
to `recording_presentation.v1`. The native compositor reads that version for
all stored Recordings, including existing digest-bearing profiles. New baselines
and finalized presentations omit the retired `uiBuildSha256`; native Render does
not select or install a UI build. The API no longer reads
`CHALK_RECORDING_UI_BUILD_SHA256`, and managed-runtime preflight does not require
it. No database column or old presentation is rewritten.

Rollback targets must support digest-free v1 profiles (#113 or later). API and
Render releases predating that cutover require the old digest and cannot process
new profiles. Rolling back to a browser image also requires that image's retained
UI build. Remove any obsolete profile storage only in a later migration.

Capture bundles are private R2 objects under
`tenants/<tenant>/recordings/<recording>/capture/...`. They are deleted by the
Recording source cleanup queue after the Episode's Recording retention window
(30 days by default), measured from Capture completion or terminal failure.
Failed Captures and their presentation objects are cleaned up through the same
queue, leaving that window for manual recovery. These objects, other retained
Recording objects under `tenants/<tenant>/recordings/...`, and transcripts under
`tenants/<tenant>/transcripts/...` do not match the `temporary/` lifecycle rule.
Incomplete
multipart uploads are eligible for abort after seven days. Previously issued
allocation keys under `recordings/...` remain readable for replay compatibility,
but are outside the `temporary/` lifecycle rule and require separate cleanup
after their processing window. The AWS KMS key is in Singapore, rotates
automatically, and permits data-key
generation/decryption only to the control-plane role when the authenticated
context contains the fixed environment, tenant, Episode, recording,
recording-job, bundle-schema, capture-epoch, and recorder-envelope-digest keys.
Workers receive neither KMS credentials nor reusable R2 or DigitalOcean
credentials.

KMS context cutover: the control-plane producer must emit `chalk.episode`
before this IaC revision is applied. Existing ciphertext encrypted with
`chalk.session` requires retained old-policy access through a separately
coordinated transition and rollback plan; a blind apply will deny those
operations.

## Production KMS context cutover

Production planning is fail-closed and requires exactly one state: an
externally supplied `legacy_kms_context_key` with
`episode_kms_context_cutover_complete = false`, or no legacy key with
`episode_kms_context_cutover_complete = true` after all existing ciphertext
has been migrated and proved decryptable. The legacy key must be distinct from
every fixed canonical context key. When set, it adds a second policy statement
for the control-plane role that permits only `kms:Decrypt` and
`kms:DescribeKey` for the legacy context. It cannot generate new data keys,
and the canonical `chalk.episode` statement remains the only key-generation
path.

Use this order, with private production inputs rather than a tracked tfvars
file:

1. Inventory every existing encrypted object and its context. Switch every
   producer to emit `chalk.episode` before planning this revision.
2. While legacy ciphertext remains, provide its exact key through
   `legacy_kms_context_key` and leave
   `episode_kms_context_cutover_complete = false`. The production guard blocks
   any plan that supplies both states or neither state.
3. Prove decrypt access for a representative object from each inventory class,
   re-encrypt every remaining object under the canonical context, and record
   the inventory completion and decrypt proof outside this repository.
4. For rollback, retain the temporary decrypt policy and roll producers only
   to a build that still emits the canonical context. Rolling back to a
   producer that emits the historical context requires a separately approved
   emergency policy revision; never run that producer against this canonical
   policy.
5. After the old-object inventory is empty and canonical decrypt proof passes,
   remove `legacy_kms_context_key`, set
   `episode_kms_context_cutover_complete = true`, review the production plan,
   and apply the removal as its own change.

## Production capacity-input migration

Private production callers and tfvars must rename these inputs before their
next plan:

| Previous input              | Canonical input             |
| --------------------------- | --------------------------- |
| `reserved_capture_meetings` | `reserved_capture_episodes` |
| `capture_meetings_per_node` | `capture_episodes_per_node` |

Production plans require `capture_capacity_inputs_migrated = true`. Set it in
the same private-input change as both renamed keys, then review the rendered
`desired_capture_nodes` value. The acknowledgment is required even when an
intentional reservation is zero, so an omitted legacy input cannot silently
produce a zero-capacity plan.

Production R2 adoption is fail-closed. A plan must name the existing bucket,
provide its private inventory import ID, and carry a digest of the approved
no-delete/no-replacement plan before mutation is possible. Staging can use its
explicit generated name. All backend configuration and credentials are
provided outside this tree; `gate.sh` always initializes with the backend
disabled and never applies a provider.

The private bucket also serves browser-authorized whiteboard files through
short-lived presigned URLs. Every apply must set `whiteboard_allowed_origins`
to the exact web origins for that environment. The managed CORS rule permits
only `GET`, `PUT`, the four headers signed by whiteboard-v1, and the SHA-256
checksum and attachment identity headers used by chat uploads; it does not make
the bucket public. Wildcard origins, paths, and trailing slashes are rejected.

The reference bootstrap templates mirror the external controller's cloud-init
contract. The issuer verifies live DigitalOcean inventory before returning a
node certificate bound to environment, role, release, intended Droplet, region,
and boot generation; the controller revokes that identity on pool removal. No
bootstrap assertion or reusable credential enters OpenTofu state, cloud-init,
logs, or a tracked file.

### Retained boot diagnostics and cold qualification

Create a separately owned boot probe with `chalk-recorder-diagnostic` present
**in its original provider create payload**, alongside the normal environment,
owner, role, release, image, and boot-generation tags. The fleet validates its
inventory fences but does not adopt, count, bootstrap, drain, or delete an
unmanaged diagnostic node. A journal-managed node or a pending fleet create
cannot escape its lifecycle by adding this tag. Direct issuer inventory inspection
and peer-IP verification remain unchanged: the tag grants no bootstrap authority.

The diagnostic operator must own a bounded cleanup deadline, certificate
revocation/registration abandonment, provider deletion, and task-key/firewall
cleanup. Never retag a live node. The tag does not isolate worker traffic: use a
task firewall that preserves the bootstrap route but blocks the worker's
control-plane route, so a successful probe cannot join live Capture demand.
Keep provider create payloads, cloud-init logs, bootstrap environments, and
identity artifacts in private evidence, never in this public repository.

Before publishing a Capture image pin, require a cold boot of the sealed snapshot
through the same provider adapter and generated user-data as the fleet. Match the
fleet's region, size, VPC default/selection, DNS, bootstrap egress, CA, TLS server
name, release/image binding, and controller generation/inventory fences. Do not
use a tunnel, hosts override, post-boot repair, or manual bootstrap rerun for the
passing qualification. Retain the node on failure until its evidence is captured.
A passing receipt must bind the image ID/digest, source revision, provider ID,
boot generation, issuer certificate identity/serial and issuance time to the
installed certificate fingerprint. File presence, `--help`, and an HTTP 202
registration response are not qualification. A rejected or missing receipt must
prevent pin publication; worker/media qualification remains a separate gate.
