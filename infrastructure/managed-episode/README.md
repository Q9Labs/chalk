# Managed Episode runtime

These artifacts package Chalk's API and SyncEngine for the production application tier: one AWS Singapore node, rootless Podman supervised by systemd Quadlet, an outbound-only remotely managed Cloudflare Tunnel, PlanetScale PostgreSQL, and ephemeral Redis acceleration. They declare no cloud resources. Host deployment stays off unless a release dispatch sets `deploy_managed`.

Use the [managed release workflow](../../docs/managed-release.md) to deploy or reload inputs. Local controller dry runs are diagnostic only; never follow a build-only Release with a hand-run SSM deployment.

The runtime is fail-closed. Application services publish only on host loopback and the private `chalk-runtime` network. `chalk-cloudflared` starts after API and Sync readiness, and the remote Tunnel must match [`cloudflare/ingress.production.json`](cloudflare/ingress.production.json). There is no public origin listener, Compose topology, Caddy proxy or local PostgreSQL.

## Images and release manifest

The Dockerfiles in `images/` use named build contexts so a build never sends the multi-gigabyte working tree to BuildKit, and pin base images by multi-architecture digest. Both application images run as numeric UID/GID 65532. Build the Sync index on native amd64 and arm64 BuildKit workers: OTP 28's terminal NIF does not start under the Docker Desktop amd64 emulator on Apple Silicon.

The manually dispatched release workflow in `.github/workflows/ci.yml` compares the target SHA with the supplied stable release manifest, builds only the affected image, and carries the unchanged digest and provenance into the new manifest. Unknown or shared runtime changes fail closed to both images. Images are pushed to immutable ECR repositories, signed server-side, and carry a BuildKit SLSA provenance attestation. CI waits for signing before it publishes the manifest.

`scripts/generate-release-manifest` refuses a dirty tree and mutable image references, records every runtime artifact checksum, and creates a unique release ID with no environment values or secrets. The manifest must describe the published indexes exactly and never claims an architecture that was not built. For a runtime-input or controller refresh with no application change, classify the plan as `none` and deploy with a stable manifest: this creates a new release identity while preserving the existing component identities. It does not make unknown source paths safe to skip.

`scripts/plan-release-components` is a public, pure contract mapping changed paths to build and restart sets. Dependencies fail closed: API requires Redis, Sync requires API, the Tunnel requires both, and the host cuts over that closure as one bounded transaction so health and rollback cannot leave a mixed runtime. Rendered Quadlets keep digest references and `Pull=never`; automatic registry updates are disabled.

## SSM deployment controller

The deploy job is protected by the selected GitHub Environment and uses [`ssm/chalk-managed-episode-deploy.json`](ssm/chalk-managed-episode-deploy.json). CI publishes that document under a content-addressed version name, resolves it to a numeric version, sends one command and accepts only the controller's healthy `RESULT` record. The document exposes named fields only, with no arbitrary command parameter. Each GitHub Environment must define the `CHALK_MANAGED_*` variables the workflow reads (role ARN, region, instance ID, log group, parameter prefix, SSM document name).

The parameter prefix is scoped as `/chalk/<environment>/...`. Suffixes and canonical IDs are in [`contracts/runtime-inputs.json`](contracts/runtime-inputs.json). Environment and secret-file payloads are SSM `SecureString`. `managed-migrator-database-url` is a mandatory, dedicated owner credential, not the runtime database user: the controller mounts it only in the one-shot `chalk-api-migrate` unit, removes it when that unit exits, never passes it to API or Sync, and it cannot be excluded.

Missing or empty inputs fail before the stable runtime stops. A dispatch may name an allowed missing environment or secret-file input in `managed_secret_exclusions`; unknown IDs, duplicates, wildcards and exclusions the runner did not supply fail, and the release must still pass full runtime health. The PlanetScale durability proof is never excludable.

`chalk-deployment-controller` runs this transaction on the host:

1. Validate the request, manifest, artifacts, SSM response, image digests and host architecture.
2. Fetch all allowlisted SSM inputs with decryption, keep exact bytes including trailing newlines, and record exact versions without values.
3. On the first run, adopt a healthy legacy runtime only when its release identity, Quadlets, live env and proof, Podman secrets and SSM versions agree. This creates the rollback point without stopping live services.
4. Render and validate the candidate while the stable runtime is still live, then pull its immutable images with a transient rootless ECR token passed over standard input.
5. Stop the runtime, atomically publish `/run/chalk/env` and the release identity, and stream Podman secrets over standard input.
6. Run the manifest's exact `minimum_migration` target in the one-shot migration unit. The unit may name an exact checked-in migration as an allowed repair; the migrator applies only that missing version below a recorded newer one and rejects any other out-of-order gap. API and Sync wait for it, and the migrator credential is removed before the runtime target starts.
7. Start the hard dependency target and run aggregate health with bounded retries. API readiness also rejects a database below the manifest migration target.
8. Promote only after health. Any activation, health or promotion failure fences the candidate and restores the prior rendered runtime and exact SSM versions. A failed rollback leaves the runtime fenced. Migrations are forward-only: runtime rollback never undoes one.

A healthy release writes its manifest, rendered runtime, published pointer and audit ledger under `/var/lib/chalk/deployment-controller`. Pointer schema 2 records the active release and the previous committed release's identity and manifest checksum; the ledger is not a retention authority. `chalk-runtime-restore.service` retries transient boot failures: after a reboot clears `/run` it reads the active pointer, fetches the recorded SSM versions, rebuilds env and identity, reconciles Podman secrets and starts the same health-checked release. Every deploy, rollback and restore first makes sure the `chalk` user manager is running (linger, `user@UID.service`, user bus). Plaintext inputs stay under `/run` only, and transient secret files go with the controller's private staging directory.

The CI role needs narrowly scoped SSM document-version and Run Command access. The host role needs `ssm:GetParameters` for its prefix, KMS decrypt for the matching key and context, and read access to the image repositories. The pinned host image must provide the `chalk` user with lingering user manager, rootless Podman with instance-role ECR authentication, the SSM agent, AWS CLI, `curl`, `jq`, OpenSSL and standard archive and systemd tools; the controller fails before promotion when one is missing. The host keeps a fixed Elastic IP so a stop and start does not change the address that `recording-control` DNS and recorder firewalls allow.

Redis has no volume, append-only file or snapshot. It is a memory-bounded accelerator whose loss resets rate limits and transient OAuth state but cannot become Sync authority. Journald owns container log retention.

## Validation, image cleanup and watchdog

`scripts/validate-runtime` checks file permissions, required environment keys, TLS verification in both PlanetScale URLs, mTLS PEM inputs, digest-only images, artifact checksums, the exact Tunnel route contract and rendered Quadlet invariants, and never prints values. The controller runs it against its private `/run` stage. `scripts/test-deployment-controller --group <name>` runs one group of the controller harness (the groups are listed in the script; `rollback` and `restore` include earlier groups because they need the durable stable release).

Before pulling images, the controller removes only unprotected, containerless Podman images by image ID (`image untag` then `image rm --no-prune`, never `--force`) under the deployment lock. It retains images from the live manifest, the candidate and the active and previous committed releases in the pointer, plus their alternate digest aliases. Cleanup is best effort. After cleanup and pulls the controller requires disk usage below 90% on the root, Podman image-store and controller-state filesystems, matching the runtime health limit; a failed or unreadable check rejects the deployment before cutover, and enough space permits a deployment even if cleanup failed. Containers, volumes, recordings and database data are never touched. Schema-1 pointers do not identify the previous release, so cleanup leaves the cache intact until a deployment publishes the schema-2 pair.

`chalk-runtime-watchdog` checks user units, local API and Sync readiness, cloudflared `/ready`, manifest integrity and disk and memory pressure every 15 seconds. A failed oneshot unit is the local failure signal; wiring it to the health publisher and instance-replacement controller is an infrastructure responsibility.

## PlanetScale Sync production policy

Production Sync requires PostgreSQL 18 safe durability settings, a configured synchronous standby, at least one `sync` or `quorum` row in `pg_stat_replication`, and WAL lag within the ceiling, checked through the runtime role at boot and on readiness. Selecting an HA branch does not establish PlanetScale compatibility, and PgBouncer is not used for this proof. The validator therefore requires an external direct-connection proof matching [`contracts/planetscale-sync-proof.example.json`](contracts/planetscale-sync-proof.example.json) and rejects the unverified example. A saved proof is not live health evidence: the real application probe must also pass.

For an approved single-node deployment set `CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY=false` in `sync.env`. The proof must then declare `require_synchronous_standby: false`, `writable_primary: true`, `fsync`, `full_page_writes` and `data_checksums` as `on`, and `synchronous_commit` as `on` or `remote_apply`, with the actual standby observations (including zero). Only replica failover is waived. Recovery must use a release that supports this setting; older releases still require a standby.

The templates use `PodmanArgs` for options missing as native Quadlet keys in the production Ubuntu Podman 4.9 generator; the config smoke test rejects unsupported keys and preserves Redis's no-snapshot argument without triggering that generator's empty-argument truncation. Keep the patched `hpax` and `plug` releases current in the Sync lockfile and rerun the Sync gate before every publish.

### Participant entry rollout

Entry ownership ships in two releases. The first is an **expand** release: its Sync writer advertises `protocol_compatibility.entry_writer: 1`, its migration image advertises `entry_migrator: 1`, and sockets keep compatibility entry and Leave behavior. Old hosts and sockets may keep writing, and the additive migrations alone do not enable ownership.

After an expanded release is the retained rollback baseline, run the Release workflow with `enforce_entry_ownership: true` and a fresh manifest (the generator flag is `--enforce-entry-ownership`). The generator and controller both check candidate and baseline capabilities. Before starting the runtime the migration job records enforcement in `sync_entry_rollout`, waits for entry and Leave transactions, and refuses activation while a claimed Leave has an unresolved provider result; retry after those finish. There is no runtime operation to turn enforcement off.

Once recorded, the database rejects old Sync entry and Leave mutations, including old-host consumers and delayed finalization, and the migration command rejects an obsolete Sync target. Runtime rollback keeps migrations and the record, and the expanded rollback image reads it. Never select an obsolete release as a rollback baseline after enforcement. Enforcement is a deliberate later release, never the first deployment of this schema, and neither rollback nor host replacement may run migration Down or clear the record.

## Stopping and restarting the node

Every API start drops every live socket, so nobody stops, reboots or restarts the production node by hand. The deploy path and the rollback path are the only ways.

- **Stop protection.** The production node has EC2 stop protection (`disable_api_stop`), set by hand because the node is not defined in OpenTofu. A stop then takes two deliberate calls: `aws ec2 modify-instance-attribute --instance-id <id> --no-disable-api-stop`, then the stop. To undo the protection, run that first call. Nothing in this repository stops the node. Reboots are not blocked, so the host change alert covers them.
- **Grace on an OS stop.** Ubuntu ships `user@.service.d/timeout.conf` with `TimeoutStopSec=5`. The rootless user manager that owns the Quadlet containers was SIGKILLed after five seconds, so the API, Sync, cloudflared and Redis died with no shutdown path. The controller installs [`systemd/chalk-user-manager-grace.conf`](systemd/chalk-user-manager-grace.conf) over it as `/etc/systemd/system/user@.service.d/timeout.conf` (130 seconds: the stop budgets of cloudflared, Sync, the API and Redis, which stop one after another, add up to 115, plus 15 of overhead; `validate-runtime` checks the sum). A reboot now logs `api.shutdown_requested` and `api.shutdown_complete`.
- **How the last boot ended.** `chalk-runtime-restore.service` runs `chalk-deployment-controller boot-end` first. It reads the previous boot's journal and writes `CHALK_PREVIOUS_BOOT_END` (`clean`, `killed` or `unknown`) and `CHALK_HOST_BOOT_ID` to `/run/chalk/boot.env`. The API logs both in `api.starting`, which reaches Axiom. `killed` means the user manager SIGKILLed the containers, or the API never logged `api.shutdown_complete` last. The API unit reads that file through Quadlet, which has no optional `-` prefix, so every deploy creates it when it is missing. `scripts/test-quadlet-generator` runs the rendered units through Ubuntu's Podman 4.9 generator in CI.
- **Alerts.** The [host change check](../host-change-alert/README.md) pages on a stop, start or reboot of the node, and on an API start with no deploy record.
