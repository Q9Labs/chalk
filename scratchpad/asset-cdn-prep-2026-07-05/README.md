# Asset CDN Prep - 2026-07-05

Prepared output for `https://assets.chalkmeet.com/ui/` assets.

The optimized media files were uploaded to Cloudflare R2 bucket `chalk-assets`
and served through `assets.chalkmeet.com`. `@q9labs/chalk-ui/assets` now exports
CDN metadata and URLs rather than bundling background or sound binaries in the
npm package.

## Contents

- `backgrounds/`: AVIF preferred assets and WebP fallbacks derived from the four
  existing JPG backgrounds.
- `sounds/`: Opus preferred assets and low-bitrate mono MP3 fallbacks derived
  from the existing MP3 sound effects.
- `manifest.json`: semantic asset ids mapped to filenames, MIME types, byte
  sizes, SHA-256 hash prefixes, and CDN URLs.
- `chalk-ui-assets.manifest.json`: public manifest uploaded to
  `https://assets.chalkmeet.com/ui/manifest.json`.
- `size-report.json`: source-to-derivative byte deltas.

Background names were chosen by visual inspection:

- `bg_1.jpg` -> `beach-palm-promenade`
- `bg_2.jpg` -> `blue-ribbon-loop`
- `bg_3.jpg` -> `bright-office-workspace`
- `bg_4.jpg` -> `sunset-lake-boat`

## Conversion

The prepared assets used these conversion settings:

```bash
magick "$source" -auto-orient -strip -colorspace sRGB -quality 45 -define heic:speed=4 "$name.tmp.avif"
magick "$source" -auto-orient -strip -colorspace sRGB -quality 72 -define webp:method=6 "$name.tmp.webp"
ffmpeg -hide_banner -loglevel error -y -i "$source" -map_metadata -1 -vn -ac 1 -ar 48000 -c:a libopus -b:a 32k -vbr on -compression_level 10 "$name.tmp.opus"
ffmpeg -hide_banner -loglevel error -y -i "$source" -map_metadata -1 -vn -ac 1 -ar 44100 -c:a libmp3lame -b:a 48k "$name.tmp.mp3"
```

Each final filename includes the first 12 hex characters of the derivative
file's SHA-256 digest.

## Cache Headers

For hashed media files:

```http
Cache-Control: public, max-age=31536000, immutable
Content-Type: <manifest mimeType>
```

For an unversioned manifest URL, prefer a short cache with revalidation:

```http
Cache-Control: public, max-age=300, stale-while-revalidate=86400
Content-Type: application/json; charset=utf-8
```

If the manifest itself is versioned or content-hashed, it can use the same
one-year immutable policy as the media files.

## Cloudflare R2

Bucket:

```text
chalk-assets
```

Custom domain:

```text
https://assets.chalkmeet.com
```

Upload paths:

```text
ui/backgrounds/<semantic-name>.<sha256-prefix>.avif
ui/backgrounds/<semantic-name>.<sha256-prefix>.webp
ui/sounds/<semantic-name>.<sha256-prefix>.opus
ui/sounds/<semantic-name>.<sha256-prefix>.mp3
ui/manifest.json
```

CORS is configured for browser reads:

```text
Access-Control-Allow-Origin: *
Allowed methods: GET, HEAD
Exposed headers: ETag, Content-Length, Content-Type, Cache-Control
```

## Package Surface

The public package surface under `@q9labs/chalk-ui/assets` is generated from:

- `backgrounds/*.avif`
- `backgrounds/*.webp`
- `sounds/*.opus`
- `sounds/*.mp3`
- `manifest.json`

Do not move the prepared media files or `size-report.json` into the package
asset surface unless they become part of a deliberate build pipeline. The
package should keep exporting metadata and CDN URLs only.
