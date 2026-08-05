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

Capture bundles are private temporary R2 objects and expire after 24 hours;
incomplete multipart uploads expire after seven days. The AWS KMS key is in
Singapore, rotates automatically, and permits data-key generation/decryption
only to the control-plane role when the authenticated context contains the
fixed environment plus tenant, Episode, recording-job, and bundle-schema keys.
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
