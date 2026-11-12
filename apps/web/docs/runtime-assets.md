# Runtime assets

The web app requests no fonts, scripts or stylesheets from third-party hosts. Fonts, Excalidraw CSS and fonts, and MathJax (its glyph modules, extensions, speech worker and maps) are served from the app's own origin, so they need no CSP source, CORS host or font fallback. Outgoing links and user content are out of scope. Published SDK builds keep their upstream CDN defaults; self-hosting hosts must call `configureWhiteboardAssets` (`@q9labsai/chalk-whiteboard/assets`) in a bootstrap module imported before the SDK, because Excalidraw initializes its font faces during eager SDK imports. The existing `excalidrawCssPath` prop overrides the stylesheet but cannot initialize fonts early on its own.

## Constraints that shaped the build

- Excalidraw retries a missing font against its CDN. `apps/web/scripts/self-hosted-excalidraw.ts` removes that retry in development prebundling and production, and fails the build if the pinned code changes. A browser regression forces a local font to 404 during SVG export and rejects any external fallback request.
- The embedded/native renderer has an offline CSP and its own local font configuration. Its entry (`packages/whiteboard/src/embedded/renderer-entry.ts`) imports the local asset bootstrap first, so an absolute document-relative font base is set before Excalidraw initializes. The embedded build copies all fonts, and a `file://` browser test requires Excalifont to load from the adjacent directory with no external request or CSP violation.
- Both Vite configs copy vendor assets at startup, so a clean checkout works with `pnpm dev`.

## Immutable vendor URLs

Each vendor URL (`/chalk-whiteboard/<version>-<digest>/...`, `/chalk-mathjax/<version>-<digest>/...`) names the package version and a digest of the copied bytes, from `src/lib/whiteboard-asset-versions.ts`. The copy step checks both against the installed packages and fails with the new digest when they differ, so a version upgrade or a same-version pnpm patch needs a new immutable URL before it builds. The digest is per package: changing any copied file changes every URL in that package. Vendor paths cache for a year as immutable. Site font stylesheets and hashed font files revalidate after a day.

## Store and Worker

Vendor trees are uploaded before each Pages release to the permanent R2 buckets `chalk-vendor-assets` (production) and `chalk-vendor-assets-nightly`, each with its own bucket-scoped token. `apps/web/scripts/upload-vendor-assets.ts` verifies every file against the digest in its URL and sends signed PUTs with `If-None-Match: *`, so an existing key is skipped atomically. It never replaces or deletes objects, so two overlapping deploys can only add verified content. There is no lifecycle deletion, because old tabs can request any published digest indefinitely.

An independent Worker (`wrangler.vendor-assets.toml`) serves the digest URLs on each app origin from R2 and returns 404 for missing keys. It is separate from Pages because rolling back Pages to a snapshot from before this feature would otherwise remove a Pages Function along with the application. The Worker and its binding survive every deploy and native rollback. Legacy non-digest paths pass through to Pages.

Releases upload first, deploy the Worker, then probe both vendor routes (exact bytes, MIME, immutable caching, uncached 404 for a missing key) before publishing Pages. Native Pages rollback checks the existing Worker routes before restoring the application. See [managed release](../../../docs/managed-release.md).
