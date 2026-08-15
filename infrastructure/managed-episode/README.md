# Managed Episode runtime

These artifacts package Chalk's API and SyncEngine for the ratified production
application tier: one AWS Singapore node, rootless Podman supervised by systemd
Quadlet, an outbound-only remotely managed Cloudflare Tunnel, PlanetScale
PostgreSQL, and ephemeral Redis acceleration. They do not provision, mutate, or
deploy any cloud resource.

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

Production images are published by the `publish-api-images` job in
`.github/workflows/ci.yml` on every green master push: `linux/arm64` only,
pushed to the immutable ECR repositories `chalk-api` and `chalk-sync` in
`ap-southeast-1`, signed server-side by the ECR managed-signing rule
(`chalk_production_ecr` Notation profile), with a BuildKit SLSA provenance
attestation embedded in each OCI index. For a local validation build:

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

The rendered Quadlets retain digest references and `Pull=never`; the boot
workflow must pull and verify signatures, provenance, architecture, and release
identity before starting the target. Automatic registry updates are
intentionally disabled. Install the rendered files as rootless user Quadlets,
install the companion user systemd units, and render runtime environment files
from SSM according to [`env/api.env.example`](env/api.env.example),
[`env/sync.env.example`](env/sync.env.example), and
[`contracts/secret-files.md`](contracts/secret-files.md). Those host steps are
outside this package because they require the pinned machine image, SSM paths,
and deployment controller.

Component selection is intentionally a public, pure contract. Use
`scripts/plan-release-components` with changed paths (or `--component api`,
`sync`, `both`, or `shared`) to obtain JSON build and restart sets. An API
change rebuilds API and restarts API, Sync, and the Tunnel because of the
current Quadlet `Requires=` graph. A Sync change restarts Sync and the Tunnel.
Both/shared changes restart the full application closure. Redis is included
only when a runtime dependency changes. Unknown paths fail closed.

The private release controller owns staging, approvals, host installation,
registry attestation checks, and its durable release ledger. Those control-plane
records are deliberately outside this public package; this contract only
describes immutable runtime inputs and the deterministic component plan.

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
  --env-root /run/chalk/env \
  --secret-root /run/chalk/secret-inputs \
  --manifest /run/chalk/release/release-manifest.json \
  --sync-proof /run/chalk/evidence/planetscale-sync-proof.json \
  --rendered-root /run/chalk/release/runtime

infrastructure/managed-episode/scripts/test-config
```

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
