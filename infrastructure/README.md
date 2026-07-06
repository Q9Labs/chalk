# Infrastructure

Public deployable support tooling lives here.

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

The package surface should stay metadata-only. `@q9labsai/chalk-ui/assets`
exports CDN URLs, filenames, MIME types, byte sizes, and hash prefixes; it should
not bundle background or sound binaries into npm packages.

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
5. Update `packages/ui/src/assets/index.ts`.
6. Verify live URLs, CORS, content types, and cache headers.

If replacing immutable assets, delete stale R2 objects and purge exact old URLs
from Cloudflare edge cache when a cache-purge-capable token is available. The
manifest should never point at stale assets.
