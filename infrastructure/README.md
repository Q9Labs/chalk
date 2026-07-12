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

See [`../docs/observability.md`](../docs/observability.md) for correlation,
telemetry, alerting, and end-to-end proof requirements.

## Asset CDN

Shared SDK media assets are served from Cloudflare R2 through the public custom
domain:

```text
https://assets.chalkmeet.com
```

Current bucket:

```text
chalk-assets
```

Public asset paths use this prefix:

```text
ui/
```

The package surface should stay metadata-only. `@q9labsai/chalk-assets` exports
CDN URLs, filenames, MIME types, byte sizes, and hash prefixes;
`@q9labsai/chalk-ui/assets` re-exports that surface for compatibility. Neither
package should bundle background or sound binaries into npm packages.

### Paths

```text
ui/backgrounds/<semantic-name>.<sha256-prefix>.avif
ui/backgrounds/<semantic-name>.<sha256-prefix>.webp
ui/sounds/<semantic-name>.<sha256-prefix>.opus
ui/sounds/<semantic-name>.<sha256-prefix>.mp3
ui/manifest.json
```

### Cache Contract

Hashed media files:

```http
Cache-Control: public, max-age=31536000, immutable
```

Unversioned manifest:

```http
Cache-Control: public, max-age=300, stale-while-revalidate=86400
Content-Type: application/json; charset=utf-8
```

### Browser Reads

R2 CORS is configured for browser access:

```text
Allowed origins: *
Allowed methods: GET, HEAD
Allowed headers: *
Exposed headers: ETag, Content-Length, Content-Type, Cache-Control
Max age: 86400
```

### Update Flow

1. Generate or collect source assets outside package source.
2. Normalize and export hashed derivatives.
3. Upload hashed media to `chalk-assets`.
4. Upload `ui/manifest.json` with the short manifest cache policy.
5. Update `packages/assets/src/index.ts`.
6. Verify live URLs, CORS, content types, and cache headers.

If replacing immutable assets, delete stale R2 objects and purge exact old URLs
from Cloudflare edge cache when a cache-purge-capable token is available. The
manifest should never point at stale assets.
