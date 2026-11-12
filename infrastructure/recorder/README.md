# Recorder infrastructure contract

This OpenTofu root is policy-only for the recorder compute pools. It owns immutable pool tags, unattached outbound-only firewalls, release and image contracts, the private temporary R2 bucket lifecycle and the Singapore recording KEK. It never creates or replaces runtime Droplets: the external recorder reconciler owns scheduled prewarm, scale-to-zero, desired capacity, fencing and replacement. Pool sizes, regions, caps and the `desired_capture_nodes` formula are in `variables.tf` and `locals.tf`; capture and render both default to zero desired nodes.

Direct control TLS egress on ports 8443/8444 requires the exact managed-host `control_addresses` (/32 or /128); workers accept no inbound traffic. Admission targets and caps are capacity inputs, not a claim of regional load qualification. A smaller capture or render maximum lowers the supported concurrency, so operators must lower the admission ceiling with it before launch. Render-phase pipelines do not occupy capture admission. CPU and GPU artifacts are never mixed: a GPU pool needs `render_gpu = true` with an independently qualified GPU image, region and size. Confirm current regional size availability before applying.

## External fleet reconciliation

The controller (`go run ./cmd/recorder-fleet-controller` in `apps/api`, one single-leader process per pool) is a provider-neutral state machine in `apps/api/internal/recorderfleet`. Its settings are the `CHALK_RECORDER_FLEET_*` variables plus `DIGITALOCEAN_TOKEN`; the command rejects a missing required one. Qualification path: zero nodes, one bootstrapping node, one role-fenced ready node, admission closed, leases drained, certificate revoked, zero nodes.

Judgment that the code cannot say:

- Demand must include scheduled prewarms and held unscheduled starts, not only queued jobs. Recording admission already requires ready pool capacity before it creates the pending capture job, so inferring demand from claimable jobs deadlocks bootstrap.
- Readiness and lease observations are per node, never worker-written aggregate health. Aggregate capacity is published only by a SPIFFE identity with the distinct `recorder-fleet-controller` role, and capture and render identities cannot cross the role fences.
- Scale-down closes admission only after a fresh zero lease read, requires another zero read after the close, then revokes the identity before exact Droplet deletion. Foreign inventory is quarantined.
- The DigitalOcean token belongs only to the external controller. User data carries environment, pool, release, image digest, bootstrap endpoint and boot generation, never a provider token, bootstrap assertion, worker certificate or reusable credential. The controller certificate has exactly one URI SAN, `spiffe://<trust-domain>/environment/<environment>/recorder-fleet-controller/<uuid>`, and its transport is never reused for DigitalOcean.
- The local journal is for an explicitly single-leader deployment. A highly available deployment must replace it with a shared fenced `JournalStore` and must not run several controllers on one file.
- Keep Capture `SLOTS_PER_NODE=1` until density is measured; Render stays at one job per node. After qualification, set `SLOTS_PER_NODE=N`, `FREE_SLOTS=8` and an explicit `MAX_NODES` that can hold the floor. An old API makes the new controller count one slot per node and log a warning; it still reconciles.
- `CHALK_RECORDER_FLEET_SSH_KEY_IDS` (at most eight IDs) does not open the firewall. DigitalOcean refuses to create a Droplet from a custom-base image, such as the lean Debian Capture image, unless the request names an SSH key. In production set it only to the `chalk-recorder-no-login` key, whose private half was never stored. Never add a key whose private half exists.
- Bootstrap is fail-closed unless the separately deployed issuer is configured. The node generates its Ed25519 key locally, proves possession over a short-lived challenge, and accepts the certificate only over issuer-pinned TLS after the issuer binds the TCP peer address to exact live inventory. Provider metadata supplies a claimed ID only, never authentication.
- The five-minute scheduled prewarm is a scaling signal, not a media-start hold. Episode media is not gated on capture-worker attachment, so an immediate Recording can begin before cold capacity arrives. Production must keep enough warm capture capacity for its startup objective and monitor that gap.

The control-plane API is under `/internal/v1/recorder/fleet` in `apps/api/internal/adapters/recorderfleetcontrol`. Its client requires TLS 1.3 with explicit roots and server name and does not follow redirects. Responses are limited to 1 MiB, reject unknown or trailing JSON, and must echo the configured environment and role.

## Recorder images

Release owns image builds, inspection, fleet pins, signed cold-boot qualification and deployment; Promote selects the same snapshot IDs without rebuilding ([managed releases](../../docs/managed-release.md)). Never build or publish fleet pins outside that path.

`images/capture` builds a minimal Capture image with no Node, Chromium, FFmpeg or boot-time package installation (bootstrap accepts `capture-minimal-v1` only for Capture). `images/cpu` builds the render worker with checksum-pinned toolchains (see its scripts). Release starts a clean Debian builder at the fleet's disk size and raises only CPU and memory if needed, because the snapshot must fit the fleet.

`image_manifest_digest` is the SHA256 of `/opt/chalk-recorder/image-manifest.json`, not an OCI or whole-VM digest. The bootstrap agent rehashes that manifest and every listed file before generating a node key or contacting the issuer. Portable images contain no environment hostname or CA: cloud-init installs the selected environment's public bootstrap CA and server name, and nightly and production keep their own keys, trust roots and fleet tags.

## Production KMS context cutover

Production planning is fail-closed and requires exactly one state: an externally supplied `legacy_kms_context_key` with `episode_kms_context_cutover_complete = false`, or no legacy key with it `true` after all existing ciphertext is migrated and proved decryptable. The legacy key adds a decrypt-only (`kms:Decrypt`, `kms:DescribeKey`) statement for the control-plane role; the canonical `chalk.episode` statement stays the only key-generation path. Use private production inputs, not a tracked tfvars file.

1. Inventory every encrypted object and its context, and switch every producer to emit `chalk.episode` before planning this revision.
2. While legacy ciphertext remains, supply the exact legacy key and keep the cutover flag `false`.
3. Prove decrypt access for a representative object from each inventory class, re-encrypt every remaining object under the canonical context, and record the proof outside this repository.
4. Rollback: keep the temporary decrypt policy and roll producers back only to a build that still emits the canonical context. A producer that emits the historical context needs a separately approved emergency policy revision.
5. Once the inventory is empty and canonical decrypt passes, remove the legacy key, set the flag `true`, review the plan and apply the removal as its own change.

## Production inputs

Production plans require `capture_capacity_inputs_migrated = true` after `reserved_capture_meetings` and `capture_meetings_per_node` were renamed to `reserved_capture_episodes` and `capture_episodes_per_node`. The acknowledgment is required even when a reservation is intentionally zero, so an omitted legacy input cannot silently produce a zero-capacity plan.

Production R2 adoption is fail-closed: a plan must name the existing bucket, give its private inventory import ID and carry the digest of the approved no-delete, no-replacement plan. Nightly can use its generated name. Backend configuration and credentials live outside this tree, and `scripts/recorder/gate.sh` initializes with the backend disabled and never applies a provider.

The private bucket also serves whiteboard and chat-upload files through short-lived presigned URLs. Every apply must set `whiteboard_allowed_origins` to the exact web origins (no wildcards, paths or trailing slashes). The CORS rule permits only `GET`, `PUT` and the headers those uploads sign, and does not make the bucket public.

No bootstrap assertion or reusable credential may enter OpenTofu state, cloud-init, logs or a tracked file.

## Retained boot diagnostics and cold qualification

Failed-bootstrap fleet nodes retain a `<name>-bootstrap-evidence` snapshot (the newest three are kept). To inspect one, create a Droplet from it with the diagnostic SSH key and read `/var/log/cloud-init-output.log` and `journalctl -u chalk-recorder-*`. The snapshot may hold the node's one-time bootstrap environment, so delete it after use.

A separately owned boot probe must have a name starting `chalk-recorder-diagnostic-` and the `chalk-recorder-diagnostic` tag **in its original provider create payload**, alongside the normal environment, owner, role, release, image and boot-generation tags. The fleet validates its inventory fences but does not adopt, count, bootstrap, drain or delete it. Fleet-generated names are never excluded, and a journal-managed node or pending create cannot escape its lifecycle by adding the tag; the tag grants no bootstrap authority. Never retag a live node. The tag does not isolate worker traffic, so use a task firewall that keeps the bootstrap route but blocks the worker's control-plane route, so a probe cannot join live Capture demand. The operator owns a bounded cleanup deadline, certificate revocation, provider deletion and task-key and firewall cleanup. Keep provider payloads, cloud-init logs, bootstrap environments and identity artifacts in private evidence.

Before publishing a Capture image pin, require a cold boot of the sealed snapshot through the same provider adapter and generated user-data as the fleet, matching region, size, VPC, DNS, bootstrap egress, CA, TLS server name, release and image binding and controller fences. No tunnel, hosts override, post-boot repair or manual bootstrap rerun counts as a pass. Retain the node on failure until evidence is captured. A passing receipt binds the image ID and digest, source revision, provider ID, boot generation and issuer certificate identity, serial and issuance time to the installed certificate fingerprint. File presence, `--help` and an HTTP 202 registration response are not qualification. A rejected or missing receipt must block pin publication; worker and media qualification remain a separate gate.
