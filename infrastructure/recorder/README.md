# Recorder infrastructure contract

This OpenTofu root is policy-only for the recorder compute pools. It owns
immutable pool tags, unattached outbound-only firewalls, release/image
contracts, the private temporary R2 bucket lifecycle, and the Singapore
recording KEK. It never creates or replaces runtime Droplets: the external
recorder reconciler owns scheduled prewarm, scale-to-zero, desired capacity,
fencing, and replacement. Capture defaults to a ten-node cap, set by
`capture_max_nodes`. Render retains its ten-node cap and the shared planning
budget remains twenty nodes.

The default capture pool uses BLR1 CPU-Optimized two-vCPU nodes. Confirm current
regional size availability before applying; `capture_region` is configurable.
Direct control TLS egress on ports 8443/8444 requires the exact managed-host
`control_addresses` (/32 or /128); the workers still accept no inbound traffic.
Its configured
per-node admission targets are one serial Episode, forty participants, and sixteen
Mbps; these are capacity inputs, not a claim of regional load qualification.
The root exposes the contract formula as `desired_capture_nodes`:

```text
min(capture_max_nodes, max(ceil((episodes + ready_spare) / capture_episodes_per_node),
                           ceil(participants / 40), ceil(input_mbps / 16)))
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
contract accepts a configurable Capture cap and retains the ten-node Render
limit. The controller saturates its operational target at the configured
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
Keep `CHALK_RECORDER_FLEET_SLOTS_PER_NODE=1` until Capture density is measured.
Render stays at one job per node. This setting is required; the command has no
implicit role-specific default. `CHALK_RECORDER_FLEET_FREE_SLOTS` defaults to zero
and applies only to Capture. Do not set production values in this change.

After qualification, set Capture `SLOTS_PER_NODE=N`, `FREE_SLOTS=8`, and an
explicit `MAX_NODES` that can hold the floor. New droplets receive
`CHALK_RECORDER_CAPTURE_SLOTS=N` through a systemd environment-file override.
Existing workers count only their fresh reported capacity; old or unknown
workers count as one slot. The controller adds nodes when this mixed fleet
cannot cover demand plus the floor, without exceeding its configured cap.

Capture negotiates v2 demand on the existing private endpoint. It divides only
slot demand, including held starts and preparations. Participant and bitrate
floors remain node counts. Old controllers receive the unchanged v1 response.
An old API forces the new controller to count one slot per node and log a
warning; it still reconciles. Render does not divide its demand. Bootstrap rows
are reserved at create, before provider activation. A stuck create uses the
bootstrap abandonment fence; an issued identity uses the confirmed-404 lease
recovery path. Scale-down closes admission only after a fresh zero lease read,
then requires another zero read after the close before revocation or deletion.
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

Release owns image builds, inspection, fleet pins, signed cold-boot qualification
and deployment. Promote selects those same snapshot IDs without rebuilding.
See [managed releases](../../docs/managed-release.md) for release and rollback.
Do not build or publish fleet pins outside that path.

The pipeline's `images/capture` builder produces only `recorder-capture` and
`chalk-recorder-bootstrap`, Capture and renewal units, `capture.env` with
10-second keyframes, and image metadata. There is no Node, Chromium, FFmpeg or
boot-time package installation. Bootstrap accepts `capture-minimal-v1` only for
the Capture role.

The `images/cpu` builder produces the render worker, native Node compositor and
bootstrap/renewal agent. It uses checksum-pinned Go 1.26.10, Node.js 22.23.2 and
pnpm 12.8.1. Release starts a clean Debian builder at the fleet's disk size, then
increases only CPU and memory if needed. The snapshot must still fit the fleet.

Each image records its source commit, deterministic source-tree digest and
installed recorder files. `image_manifest_digest` is the SHA256 of
`/opt/chalk-recorder/image-manifest.json`, not an OCI or whole-VM digest. The
bootstrap agent rehashes that manifest and every listed file before generating
a node key or contacting the issuer.

Portable v2 images contain no environment hostname or CA. Cloud-init installs
the selected environment's public bootstrap CA and server name before signed
bootstrap. Nightly and production keep their own keys, trust roots and fleet tags.

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
no-delete/no-replacement plan before mutation is possible. Nightly can use its
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

Create a separately owned boot probe whose name starts with
`chalk-recorder-diagnostic-`, with the `chalk-recorder-diagnostic` tag present
**in its original provider create payload**, alongside the normal environment,
owner, role, release, image, and boot-generation tags. The fleet validates its
inventory fences but does not adopt, count, bootstrap, drain, or delete an
unmanaged diagnostic node in that separate name namespace. Fleet-generated names
are never excluded, even with the tag, so a probe cannot collide with a future
fleet create. A journal-managed node or a pending fleet create
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
