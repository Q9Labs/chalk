# Managed Episode runtime

These artifacts package Chalk's API and SyncEngine for the ratified production
application tier: one AWS Singapore node, rootless Podman supervised by systemd
Quadlet, an outbound-only remotely managed Cloudflare Tunnel, PlanetScale
PostgreSQL, and ephemeral Redis acceleration. They do not declare cloud
resources. Host deployment stays off unless a release dispatch sets
`deploy_managed`.

The runtime is fail-closed. Application services publish only on host loopback
and the private `chalk-runtime` network. `chalk-cloudflared` starts after API and
Sync readiness, and the remote Tunnel must match
[`cloudflare/ingress.production.json`](cloudflare/ingress.production.json).
There is no public origin listener, Compose topology, Caddy proxy, or local
PostgreSQL service.

## Image builds

The Dockerfiles use named build contexts so a build never sends the repository's
multi-gigabyte working tree to BuildKit. The official Go 1.25.13 and Elixir
1.19.5/OTP 28 image indexes are pinned by multi-architecture digest. Go 1.25.13
matches the current `apps/api/go.mod` and the `db-migrate.sh` helper default.

Production images are published by the manually dispatched release workflow in
`.github/workflows/ci.yml` after the target commit passes its local gate. The
workflow compares the exact target SHA with the supplied stable release
manifest, builds only the affected API or Sync image, and carries the unchanged
digest and component provenance into the new manifest. Unknown or shared
runtime changes fail closed to both images. Builds are `linux/arm64` only,
pushed to immutable ECR repositories, signed server-side, and include a
BuildKit SLSA provenance attestation. The API and Sync image jobs share remote
BuildKit caches and run in parallel when both are affected. For a local
validation build:

```bash
docker buildx build \
  --platform linux/arm64 \
  --provenance=mode=max \
  --build-context api_source=apps/api \
  --file infrastructure/managed-episode/images/api.Dockerfile \
  --build-arg RELEASE_ID="$RELEASE_ID" \
  --build-arg SOURCE_REVISION="$GIT_SHA" \
  --tag "688819141892.dkr.ecr.ap-southeast-1.amazonaws.com/chalk-api:$RELEASE_ID" \
  infrastructure/managed-episode

docker buildx build \
  --platform linux/arm64 \
  --provenance=mode=max \
  --build-context sync_source=apps/sync \
  --file infrastructure/managed-episode/images/sync.Dockerfile \
  --build-arg RELEASE_ID="$RELEASE_ID" \
  --build-arg SOURCE_REVISION="$GIT_SHA" \
  --tag "688819141892.dkr.ecr.ap-southeast-1.amazonaws.com/chalk-sync:$RELEASE_ID" \
  infrastructure/managed-episode
```

Both final application images run as numeric UID/GID 65532. The API image is a
static scratch image. The Sync release uses a second copy of the pinned official
Elixir image for ABI compatibility, then runs only the OTP release entrypoint.
Both include a small static readiness probe and support `linux/amd64` and
`linux/arm64`. Build the Sync index on native amd64 and arm64 BuildKit workers;
OTP 28's terminal NIF does not start under the current Docker Desktop amd64
emulator on Apple Silicon.

## Release and runtime rendering

After publishing and signing the application image indexes, generate the
manifest from their index digests. The generator refuses a dirty source tree by
default, refuses mutable image references, records every runtime artifact
checksum, and creates a unique release ID without recording environment values
or secrets. New manifests use schema version 2. They retain the complete API,
Sync, Redis, and Tunnel topology while recording a sorted `affected_components`
set and a `component_releases` provenance envelope for API and Sync. Schema
version 1 manifests remain valid stable baselines.

```bash
infrastructure/managed-episode/scripts/generate-release-manifest \
  --api-image "ghcr.io/q9labs/chalk-api@sha256:<index-digest>" \
  --sync-image "ghcr.io/q9labs/chalk-sync@sha256:<index-digest>" \
  --architectures linux/amd64,linux/arm64 \
  --output "/tmp/chalk-release/release-manifest.json"

# Carry the unchanged Sync digest and provenance into an API-only release.
infrastructure/managed-episode/scripts/generate-release-manifest \
  --stable-manifest "/run/chalk/release/release-manifest.json" \
  --affected-components api \
  --api-image "ghcr.io/q9labs/chalk-api@sha256:<new-index-digest>" \
  --output "/tmp/chalk-release/api-release-manifest.json"

infrastructure/managed-episode/scripts/render-runtime \
  /tmp/chalk-release/release-manifest.json \
  /tmp/chalk-release/runtime
```

The rendered Quadlets retain digest references and `Pull=never`. Automatic
registry updates are disabled. CI waits for ECR signing to finish before it
publishes the manifest. The host controller then checks the request, release
identity, runtime artifact hashes, digest-only image references, and image
architecture before cutover.

Component selection is intentionally a public, pure contract. Use
`scripts/plan-release-components` with changed paths (or `--component api`,
`sync`, `both`, or `shared`) to obtain JSON build and restart sets. An API
change rebuilds only API. A Sync change rebuilds only Sync, and each manifest
carries the unchanged component digest forward. Runtime dependencies fail
closed: API requires Redis, Sync requires API, and the Tunnel requires both.
The host cuts over that dependency closure as one bounded transaction so health
and rollback cannot leave a mixed runtime. Unknown paths fail closed.

## SSM deployment controller

The release workflow can carry a manifest from CI to one managed host without
SSH. The deploy job is protected by the selected GitHub Environment and uses
[`ssm/chalk-managed-episode-deploy.json`](ssm/chalk-managed-episode-deploy.json).
The CI runner publishes that command document under a content-addressed version
name, resolves it to a numeric SSM document version, sends one command, and
accepts only the controller's healthy `RESULT` record.

Each GitHub Environment must define these variables:

- `CHALK_MANAGED_DEPLOY_ROLE_ARN`
- `CHALK_MANAGED_AWS_REGION`
- `CHALK_MANAGED_INSTANCE_ID`
- `CHALK_MANAGED_LOG_GROUP_NAME`
- `CHALK_MANAGED_PARAMETER_PREFIX`
- `CHALK_MANAGED_SSM_DOCUMENT_NAME`

The parameter prefix must be scoped as `/chalk/<environment>/...`. The exact
suffixes and canonical IDs live in
[`contracts/runtime-inputs.json`](contracts/runtime-inputs.json). Environment
payloads and secret-file payloads must be SSM `SecureString` values. The
PlanetScale proof may be `String` or `SecureString`.

`managed-migrator-database-url` is also mandatory and must be an SSM
`SecureString` under the same managed prefix. It is a dedicated owner/migrator
credential, not the runtime database user. The controller mounts it only in the
release's one-shot `chalk-api-migrate` unit, removes it after that unit exits,
and never passes it to API or Sync. It cannot be excluded.

Missing or empty inputs fail before the stable runtime stops. A dispatch may
name an allowed missing environment or secret-file input through the
`managed_secret_exclusions` input. The PlanetScale durability proof is always
mandatory and cannot be excluded.
CI converts each comma-separated ID to one exact `--exclude-secret` argument.
Unknown IDs, duplicates, wildcards, and exclusions that were not supplied by
the runner fail. An exclusion only permits the file to be absent; the release
must still pass full runtime health.

On the host, `chalk-deployment-controller` performs this transaction:

1. Validate the versioned request, manifest, source artifacts, SSM response,
   image digests, and host architecture.
2. Fetch all allowlisted SSM inputs with decryption, preserve their exact bytes
   including trailing newlines, and record exact versions without values.
3. On the first controller run, adopt a healthy legacy runtime only when its
   release identity, installed Quadlets, live env/proof, Podman secrets, and
   versioned SSM inputs agree. This creates the rollback point without stopping
   the live services.
4. Render and validate the candidate while the stable runtime is still live,
   exchange the host role for a transient rootless ECR token over standard
   input, then pull its immutable images.
5. Stop the runtime, atomically publish `/run/chalk/env` and the checksummed
   release identity, and stream Podman secrets over standard input.
6. Run the exact `minimum_migration` target from the release manifest in the
   one-shot migration unit. The unit may name an exact checked-in migration as
   an allowed repair; the migrator applies only that missing version below a
   recorded newer version and rejects any other out-of-order gap before it
   continues through the target. API and Sync activation waits for this unit to
   succeed; the migrator credential is removed before the runtime target starts.
7. Start the hard dependency target and run aggregate health with bounded
   retries. The API readiness check also rejects a database below the manifest
   migration target.
8. Promote only after health. Any activation, health, or promotion failure
   fences the candidate and restores the prior rendered runtime and exact SSM
   parameter versions. A healthy first-deploy rollback also installs the
   controller and boot restore unit around the adopted release. A failed
   rollback leaves the runtime fenced. Database migrations are forward-only:
   runtime rollback never attempts to undo an applied migration.

A healthy release writes its non-secret manifest, rendered runtime, active
pointer, and append-only ledger under `/var/lib/chalk/deployment-controller`.
The root
`chalk-runtime-restore.service` retries transient boot failures. After a reboot
clears `/run`, it reads the active pointer, fetches the recorded SSM versions,
rebuilds the env and release identity, reconciles the rootless Podman secrets,
and starts the same health-checked release. Plaintext inputs stay under `/run`
only. Promoted env files remain there for the services; transient secret source
files are removed with the controller's private staging directory.

The CI role needs narrowly scoped SSM document version and Run Command access.
The host role needs `ssm:GetParameters` for its environment prefix, KMS decrypt
for the matching key and context, and read access to the immutable image
repositories. The SSM document exposes named fields only; it has no arbitrary
command parameter.

The pinned host image must provide the `chalk` runtime user with a lingering
user manager, rootless Podman with instance-role ECR authentication, the SSM
agent, AWS CLI, `curl`, `jq`, OpenSSL, and standard Linux archive and systemd
tools. The controller checks these paths through its preparation work and fails
before promotion when a prerequisite is missing.

For a single-architecture Graviton release, build both application images for
`linux/arm64` and pass `--architectures linux/arm64`. The manifest must describe
the published image indexes exactly; it never claims an architecture that was
not built and pushed.

Redis has no volume, append-only file, or snapshot. It is an isolated,
memory-bounded accelerator whose loss resets rate limits and transient OAuth
state but cannot become Sync authority. Journald owns container log retention;
the host image must apply the ratified journal size and forwarding policy.

## Validation and watchdog

The validator checks file permissions, required environment keys, TLS
verification in both PlanetScale URLs, mTLS PEM inputs, digest-only images,
artifact checksums, the exact production Tunnel route contract, and rendered
Quadlet invariants. It never prints environment or secret values.

```bash
infrastructure/managed-episode/scripts/validate-runtime \
  --env-root /tmp/chalk-inputs/env \
  --secret-root /tmp/chalk-inputs/secret-inputs \
  --manifest /tmp/chalk-release/release-manifest.json \
  --sync-proof /tmp/chalk-inputs/evidence/planetscale-sync-proof.json \
  --rendered-root /tmp/chalk-release/runtime

infrastructure/managed-episode/scripts/test-deployment-controller
node --test scripts/deploy/deploy-managed-release.test.mjs
```

The controller runs this validator against its private `/run` stage. It removes
the transient secret inputs after Podman registration, so they are not kept in
the promoted release directory.

The host-side `chalk-runtime-watchdog` checks user-unit activity, local API and
Sync readiness, cloudflared's `/ready` endpoint, release-manifest integrity,
disk pressure, and memory pressure every 15 seconds. A failed oneshot unit is
the local failure signal. Wiring that failure to the IAM-authenticated health
publisher and bounded instance-replacement controller remains an infrastructure
deployment responsibility.

## Launch blocker: PlanetScale Sync probe

Production Sync currently refuses to boot unless PostgreSQL 18 reports safe
durability settings, a configured synchronous standby, at least one visible
`sync` or `quorum` row in `pg_stat_replication`, and WAL lag within the configured
ceiling. It executes those observations through the runtime role at boot and on
readiness. PlanetScale compatibility is not established merely by selecting an
HA branch, and PgBouncer is not used for this proof path.

The validator therefore requires an external, direct-connection proof matching
[`contracts/planetscale-sync-proof.example.json`](contracts/planetscale-sync-proof.example.json)
and rejects the checked-in unverified example. Production remains blocked until
PlanetScale exposes the exact settings and catalog visibility to the Sync
runtime role and the real application probe passes. These artifacts do not
disable or bypass that check.

The runtime shapes follow the current official [Podman Quadlet
contract](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
and Cloudflare's documented [Tunnel readiness
endpoint](https://developers.cloudflare.com/tunnel/deployment-guides/kubernetes/).
The templates use `PodmanArgs` for options that are unavailable as native
Quadlet keys in the production Ubuntu Podman 4.9 generator; the config smoke
test rejects those unsupported keys and preserves Redis's no-snapshot argument
without triggering the older generator's empty-argument truncation.

The production image build consumes the checked-in Sync lockfile. Keep the
patched `hpax` and `plug` releases current and rerun the Sync gate before every
publish; a clean dependency fetch must not reintroduce the retired vulnerable
versions.
