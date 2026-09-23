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
`c-8`/`libx264` profile with eight browser-frame producers and a deadline-aware
scaler capped at ten nodes. The requested two-page `c-2` successor image uses
two browser-frame producers; each sealed image attests its own frame profile,
and prior frame-eight images remain valid for rollback. Both pools default to zero desired nodes. A GPU pool
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
most eight DigitalOcean public key IDs for a bounded qualification run. It is
empty by default, does not open the firewall, and must remain empty in the
production no-inbound policy.

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

## Shared CPU worker image

`images/cpu` builds one Ubuntu 24.04 AMD64 release containing both real worker
daemons, the renderer UI, Playwright Chromium, and the node bootstrap/renewal
agent. Build the public artifact on a machine with sufficient CPU, then install
it on a clean 25-GiB `c-2` builder so the resulting DigitalOcean snapshot can
launch both `c-2` capture and `c-8` render nodes:

```sh
sudo infrastructure/recorder/images/cpu/build-release.sh \
  --source /absolute/path/to/chalk \
  --release-id <release-id> \
  --output /absolute/path/chalk-recorder-cpu.tar.gz \
  --retained-ui-client-archive /absolute/path/retained-ui-<sha256>.tar.gz

sudo infrastructure/recorder/images/cpu/install.sh \
  --bundle /absolute/path/chalk-recorder-cpu.tar.gz \
  --bundle-sha256 <bundle-sha256> \
  --bootstrap-ca /absolute/path/issuer-server-ca.pem \
  --bootstrap-server-name <issuer-server-name>
```

The build uses checksum-pinned Go 1.25.13 and Node.js 22.23.2 toolchains plus
pnpm 10.26.2. It records the Git commit, a deterministic SHA-256 of the complete
public source tree, the UI digest, and every installed recorder file. The
installer prints `image_manifest_digest`; this is specifically the SHA-256 of
`/opt/chalk-recorder/image-manifest.json`, not an OCI digest or a digest of the
entire VM filesystem. Cloud-init supplies that exact value as
`CHALK_RECORDER_FLEET_IMAGE_DIGEST`, and the bootstrap agent rehashes the
manifest and every listed file before it generates a node key or contacts the
issuer.

Before snapshotting, stop any worker and run `sudo images/cpu/seal.sh` from this
directory. It removes bootstrap/runtime identity files, operator authorized
keys, SSH host keys, cloud-init state, machine identity, histories, journals,
and temporary build material. Shut down the builder, create the immutable
snapshot, and configure both controllers with its numeric image ID and the
printed manifest digest. The first boot regenerates host/machine identity; the
external reconciler's cloud-init runs the one-time bootstrap and starts only the
role named by the fenced pool release.

Each sealed render image launches `libx264` with its attested frame concurrency
(two for the requested c-2 successor; eight for the existing c-8 image). The
capture service uses the same credential delivery path. A renewal timer derives
its lead time as one third of each issued certificate lifetime, atomically
replaces the leaf, and both workers swap to a fresh HTTP connection pool on the
next control request without stopping an active attempt.

## Recording UI build identity

When `CHALK_RECORDING_ENABLED=true`, the API also requires
`CHALK_RECORDING_UI_BUILD_SHA256`. Set it to the lowercase SHA-256 in
`apps/recording-renderer/dist/client/recording-ui-build.json` from the same
immutable release. API startup validates the value while constructing the
Recording presentation profile, and render workers independently recompute the
client build digest before rendering. A missing, malformed, stale, or
cross-release value must stop Recording startup rather than silently selecting
another UI build.

The renderer build writes the manifest during `pnpm run build` and accepts
exactly this bounded, no-extra-fields shape:

```json
{ "schema_version": "recording-ui-build.v1", "sha256": "<64 lowercase hexadecimal characters>" }
```

The digest is domain-separated as `recording_ui_build.v1` and covers every
regular file under `dist/client` in sorted relative-path order, including its
framed path, byte length, and bytes; the manifest itself is excluded and
symbolic links are rejected. At render startup, the worker reads the manifest,
recomputes the directory digest, and requires both values to equal the
`ui_build_sha256` in the server-authorized presentation request. The API setting
must therefore be copied from the manifest produced by the exact client tree
shipped in the render image, not recomputed over a different directory or
release.

### Deferred Export UI compatibility

An MP4 Export replays the immutable `uiBuildSha256` frozen in the Recording
presentation. A new recorder image therefore carries the current `dist/client`
tree and every exact client tree still needed by a source-eligible Recording.
The image-local `recording-ui-builds.json` registry contains only `client` and
`retained-clients/<sha256>` paths. The Go worker rejects a frozen hash absent
from that bounded registry; the Node renderer then resolves only that local
path and recomputes the selected tree before serving it. There is no URL,
arbitrary-path, or fallback-build selection.

Retained browser bundles continue to use the renderer's local, read-only
runtime surface (`/runtime/input`, `/runtime/assets/<id>`, and
`/runtime/media/<id>`). Recorder releases must preserve that v1 surface while a
retained client can be selected. A deliberate incompatible renderer-runtime
change needs separately version-routed whole images; it cannot be hidden by
rewriting a frozen presentation or substituting a UI digest.

Pass each prior static client tree as
`--retained-ui-client-archive /absolute/path/<archive>.tar.gz`. The archive
must contain exactly one top-level `client/` tree from a prior immutable
recorder release, including its `recording-ui-build.json`; symlinks, special
files, extra top-level paths, traversal, duplicate builds, and a duplicate of
the current digest are rejected. The builder verifies the archived manifest by
recomputing its domain-separated digest, copies it under
`retained-clients/<sha256>`, and regenerates the registry. The installer
re-verifies every registered tree before it creates the immutable snapshot.
Create that input archive from the verified prior release tree, for example:

```sh
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -C /absolute/path/to/prior-release/renderer/dist \
  -czf /absolute/path/retained-ui-<sha256>.tar.gz client
```

Before a UI cutover, produce a private inventory of every frozen
`uiBuildSha256` whose capture source remains within the 30-day
capture-completion retention window, plus hashes used by active render jobs and
currently active captures whose frozen presentation can still complete. Each
must be current or supplied in an archive. Keep a release artifact archive for
each such static tree. Do not remove a retained tree from a later image until
its source window and active-capture margin have elapsed and no job using it can
resume. This is an inventory proof for the release operator, not eager rendering
of any Recording.

Capture bundles are private R2 objects under
`temporary/recordings/<recording>/capture/<epoch>/bundles/...`. The fixed
`temporary/` lifecycle rule makes them eligible for deletion after 24 hours;
actual deletion may occur later. The API allows at most two hours of capture
(`recordingpipeline.MaximumRecordingDuration`) and eight hours of rendering
after capture completion (`recordingpipeline.MaximumRenderDuration`), so the
earliest bundle remains available for at least fourteen hours after its maximum
ten-hour capture-and-render window. Retained render/source objects under
`tenants/<tenant>/recordings/...` and transcripts under
`tenants/<tenant>/transcripts/...` do not match the temporary prefix. Incomplete
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
