# @q9labsai/chalk-assets

Framework-neutral metadata for Chalk's shared media assets.

Background images and sounds are served from `assets.chalkmeet.com`. They are
intentionally absent from this npm package so applications download only the
media they use and can benefit from immutable CDN caching. The package exports
the canonical URLs, formats, hashes, dimensions, byte sizes, and fallback
variants through `CHALK_BACKGROUND_ASSETS` and `CHALK_SOUND_ASSETS`.

```ts
import { CHALK_BACKGROUND_ASSETS, CHALK_SOUND_ASSETS } from "@q9labsai/chalk-assets";

const background = CHALK_BACKGROUND_ASSETS["bright-creative-studio"].webp.url;
const joinSound = CHALK_SOUND_ASSETS.join.opus.url;
```

`CHALK_ASSET_MANIFEST_URL` points to the CDN manifest. Package consumers should
use the exported registry for compile-time discovery and the manifest when they
need runtime inventory data.
