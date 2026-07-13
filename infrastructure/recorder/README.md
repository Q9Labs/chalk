# Recorder infrastructure contract

This OpenTofu root is policy-only for the recorder compute pools. It owns
immutable pool tags, unattached outbound-only firewalls, release/image
contracts, the private temporary R2 bucket lifecycle, and the Singapore
recording KEK. It never creates or replaces runtime Droplets: the external
recorder reconciler owns scheduled prewarm, scale-to-zero, desired capacity,
fencing, and replacement, so replacement cannot exceed eleven capture nodes,
ten render nodes, or the twenty-one-node global cap.

Capture is qualified for SGP1 CPU-Optimized two-vCPU nodes at four meetings,
forty participants, and sixteen Mbps per node. The root exposes the contract
formula as `desired_capture_nodes`:

```text
max(ceil(meetings / 4), ceil(participants / 40), ceil(input_mbps / 16))
+ ready_spare
```

Reservations are checked against twenty meetings and one hundred participants.
The render target is a TOR1 RTX 4000 pool with a deadline-aware scaler capped at
ten nodes. Both pools default to zero desired nodes.

Capture bundles are private temporary R2 objects and expire after 24 hours;
incomplete multipart uploads expire after seven days. The AWS KMS key is in
Singapore, rotates automatically, and permits data-key generation/decryption
only to the control-plane role when the authenticated context contains the
fixed environment plus tenant, session, recording-job, and bundle-schema keys.
Workers receive neither KMS credentials nor reusable R2 or DigitalOcean
credentials.

Production R2 adoption is fail-closed. A plan must name the existing bucket,
provide its private inventory import ID, and carry a digest of the approved
no-delete/no-replacement plan before mutation is possible. Staging can use its
explicit generated name. All backend configuration and credentials are
provided outside this tree; `gate.sh` always initializes with the backend
disabled and never applies a provider.

The reference bootstrap templates describe the external handshake only. A
reconciler must deliver a signed, one-time assertion bound to environment,
role, release, intended Droplet, region, and boot generation, verify live
DigitalOcean inventory, consume the assertion once, and revoke the resulting
certificate on pool removal. The assertion never enters OpenTofu state,
cloud-init, logs, or a tracked file.
