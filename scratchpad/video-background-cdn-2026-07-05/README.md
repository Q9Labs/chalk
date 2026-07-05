# Video Background CDN Prep - 2026-07-05

Prepared six generated virtual backgrounds for `https://assets.chalkmeet.com/ui/`.

These backgrounds replace the first four generic background assets in the public
manifest and in `@q9labs/chalk-ui/assets`. Sound assets are unchanged from
`scratchpad/asset-cdn-prep-2026-07-05/`.

## Backgrounds

- `bright-creative-studio`
- `cozy-evening-lounge`
- `garden-terrace-lounge`
- `modern-acoustic-office`
- `soft-abstract-glass`
- `warm-executive-home-office`

Each background was normalized to `1280x720`, then exported as AVIF preferred
format plus WebP fallback. Filenames include the first 12 hex characters of the
derivative file's SHA-256 digest.

## Conversion

```bash
magick "$source" -auto-orient -strip -colorspace sRGB -resize '1280x720^' -gravity center -extent 1280x720 "$normalized"
magick "$normalized" -strip -colorspace sRGB -quality 48 -define heic:speed=4 "$name.tmp.avif"
magick "$normalized" -strip -colorspace sRGB -quality 74 -define webp:method=6 "$name.tmp.webp"
```

## Upload

Uploaded to Cloudflare R2 bucket `chalk-assets` under:

```text
ui/backgrounds/<semantic-name>.<sha256-prefix>.avif
ui/backgrounds/<semantic-name>.<sha256-prefix>.webp
ui/manifest.json
```

Hashed media files use:

```http
Cache-Control: public, max-age=31536000, immutable
```

The manifest uses:

```http
Cache-Control: public, max-age=300, stale-while-revalidate=86400
Content-Type: application/json; charset=utf-8
```

## Verification

- `assets.chalkmeet.com` remains active with SSL.
- R2 CORS allows browser reads with `GET` and `HEAD`.
- The public manifest and all referenced background and sound variants returned
  `200` with expected content types, cache policy, and CORS headers.
- The old generic background objects were deleted from R2. A cache-busting check
  confirms deleted keys return `404`; exact old immutable URLs may briefly be
  served from Cloudflare edge cache unless purged with a cache-purge-capable
  Cloudflare token.
