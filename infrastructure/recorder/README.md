# Recorder infrastructure contract

This OpenTofu root is policy-only for the recorder compute pools. It owns
immutable pool tags, unattached outbound-only firewalls, release/image
contracts, the private temporary R2 bucket lifecycle, and the Singapore
recording KEK. It never creates or replaces runtime Droplets: the external
recorder reconciler owns scheduled prewarm, scale-to-zero, desired capacity,
fencing, and replacement, so replacement cannot exceed eleven capture nodes,
ten render nodes, or the twenty-one-node global cap.

Capture is qualified for SGP1 CPU-Optimized two-vCPU nodes at four Episodes,
forty participants, and sixteen Mbps per node. The root exposes the contract
formula as `desired_capture_nodes`:

```text
max(ceil(episodes / 4), ceil(participants / 40), ceil(input_mbps / 16))
+ ready_spare
```

Reservations are checked against twenty Episodes and one hundred participants.
The render target is a TOR1 RTX 4000 pool with a deadline-aware scaler capped at
ten nodes. Both pools default to zero desired nodes.

## External fleet reconciliation

The runtime controller is implemented as a provider-neutral state machine in
`apps/api/internal/recorderfleet`. Its initial qualification path is
zero nodes → one bootstrapping node → one role-fenced ready node → admission
closed → active leases drained → certificate revoked → zero nodes. The same
contract accepts configured targets up to the eleven-node capture and ten-node
render limits; demand above a configured limit fails closed.

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
`FIREWALL_ID`, and `BOOTSTRAP_ENDPOINT`. `DIGITALOCEAN_TOKEN` is also required;
`CHALK_RECORDER_FLEET_DIGITALOCEAN_API_URL`,
`CHALK_RECORDER_FLEET_DIGITALOCEAN_PROJECT_ID`, and
`CHALK_RECORDER_FLEET_DIGITALOCEAN_VPC_UUID` are optional. Duration overrides
use `DEMAND_MAX_AGE`, `OBSERVATION_MAX_AGE`, `STARTUP_TIMEOUT`, `DRAIN_TIMEOUT`,
`HEALTH_REFRESH`, and `RECONCILE_INTERVAL` with Go duration syntax.

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

The API handlers and durable fleet authority for these endpoints are implemented
in this tree. Certificate issuance and direct one-time assertion delivery remain
an external integration boundary, described in
`apps/api/internal/adapters/recorderfleetissuer/README.md`. Without the configured
issuer, bootstrap fails closed and new provider nodes cannot become active
workers; the controller never fabricates bootstrap or readiness state. The immutable
Droplet image must also supply the referenced
`/usr/local/sbin/chalk-recorder-bootstrap` one-time bootstrap agent; this tree
defines its fail-closed invocation contract but does not build that image
component.

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

Capture bundles are private temporary R2 objects and expire after 24 hours;
incomplete multipart uploads expire after seven days. The AWS KMS key is in
Singapore, rotates automatically, and permits data-key generation/decryption
only to the control-plane role when the authenticated context contains the
fixed environment, tenant, Episode, recording, recording-job, bundle-schema,
capture-epoch, and recorder-envelope-digest keys.
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

The reference bootstrap templates describe the external handshake only. A
reconciler must deliver a signed, one-time assertion bound to environment,
role, release, intended Droplet, region, and boot generation, verify live
DigitalOcean inventory, consume the assertion once, and revoke the resulting
certificate on pool removal. The assertion never enters OpenTofu state,
cloud-init, logs, or a tracked file.
