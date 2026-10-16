# @q9labsai/chalk-assets

Framework-neutral metadata for Chalk's shared media assets.

Background images and sounds are served from `assets.chalkmeet.com`. They are
intentionally absent from this npm package so applications download only the
media they use and can benefit from immutable CDN caching. The package exports
the canonical URLs, formats, hashes, dimensions, byte sizes, and fallback

```ts
const joinSound = CHALK_SOUND_ASSETS.join.opus.url;
```

`CHALK_ASSET_MANIFEST_URL` points to the CDN manifest. Package consumers should
use the exported registry for compile-time discovery and the manifest when they
need runtime inventory data.
