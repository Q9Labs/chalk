# Infrastructure

Public deployable support tooling lives here.

## Service Health And Uptime Monitoring

Every new deployable service must expose an independently checkable health or
synthetic target and join Chalk's uptime coverage in the same change. Add a
stable, non-secret monitor key and target to `uptime-worker/src/index.ts`, define
the expected response and severity, and add focused tests that prove the target
is checked and its result is ingested.

The monitor must cover the user-visible dependency rather than a handler that
can stay green while the service is unusable. Verify at least one scheduled run,
the result in the operational surface, and a real failure-to-recovery
transition. Add or update status-page projection when the service is a distinct
customer-visible component. Deployment-specific URLs, monitor IDs, alert
recipients, and credentials stay in private configuration rather than public
documentation.

Recorder admission uses the public-safe API contracts
`/healthz/recorder/capture` and `/healthz/recorder/render`. Each returns 200
only when its reconciler and qualified capacity are healthy, and 503 when
stale provider, qualification, or readiness state closes admission; neither
response exposes pool counts, regions, identifiers, or failure details.

See [`../docs/observability.md`](../docs/observability.md) for correlation,
telemetry, alerting, and end-to-end proof requirements.

## Recorder infrastructure

The recorder pools are declared under [`recorder/`](recorder/); its README explains the policies. OpenTofu owns immutable pool tags, outbound-only firewalls, image and release contracts, and the zero-idle capacity bounds. The external recorder reconciler owns Droplet creation, prewarm, desired capacity, fencing and replacement. The KMS policy grants data-key operations only to the control-plane role with the fixed environment and required recording context; recorder nodes receive neither KMS nor provider credentials.

`pnpm run recorder:gate` runs backend-disabled validation and the fail-closed credential check, and never applies infrastructure. A mutation takes values from protected environment configuration, never tracked tfvars, cloud-init, plans or logs. Production R2 adoption needs an explicit existing bucket name, so a default name can never create a replacement. The reconciler's signed one-time bootstrap assertion is never received or stored by OpenTofu.

## Asset CDN

Shared SDK media assets are served from Cloudflare R2 through the public custom
domain:

```text
https://assets.chalkmeet.com
```

The bucket is `chalk-assets`, with public paths under `ui/`. Hashed media files (`ui/backgrounds/`, `ui/sounds/`, names carry a sha256 prefix) are served `public, max-age=31536000, immutable`. The unversioned `ui` manifest is served `public, max-age=300, stale-while-revalidate=86400`. R2 CORS allows `GET` and `HEAD` from any origin.

`@q9labsai/chalk-assets` stays metadata-only (URLs, filenames, MIME types, sizes, hash prefixes); neither it nor `@q9labsai/chalk-ui/assets` bundles binaries.

### Update Flow

1. Generate or collect source assets outside package source.
2. Normalize and export hashed derivatives.
3. Upload hashed media to `chalk-assets`.
4. Upload the generated ui/manifest.json with the short manifest cache policy.
5. Update `packages/assets/src/index.ts`.
6. Verify live URLs, CORS, content types, and cache headers.

If replacing immutable assets, delete stale R2 objects and purge exact old URLs
from Cloudflare edge cache when a cache-purge-capable token is available. The
manifest should never point at stale assets.
