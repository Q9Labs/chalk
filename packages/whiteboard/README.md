# @q9labsai/chalk-whiteboard

Reusable Chalk whiteboard behavior for SDKs and first-party applications. The package root exports framework-neutral contracts; the `collab` subpath exports the Excalidraw collaboration and file sync engine, `react` exports `WhiteboardCanvas`, math authoring and React types, `embedded` exports the versioned native bridge, `ChalkWhiteboardController` and the compatibility manifest for mobile hosts, and `assets` configures asset paths.

`WhiteboardCanvas` owns Excalidraw loading, collaboration lifecycle, cursor and scene updates, file synchronization and math elements. Its `classNames` and `icons` props let each surface supply presentation, and `@q9labsai/chalk-react` wraps it as `WhiteboardView`.

`pnpm run build:embedded` produces a self-contained, offline-only `dist/embedded/chalk-whiteboard` (Excalidraw, fonts, MathJax, licences, a content-security policy and SHA-256 asset metadata). Authentication credentials, Sync tokens, storage signatures and signed URLs stay in the native JavaScript host and are never posted into renderer JavaScript.

The native bridge checks exact build, protocol, renderer-generation and scene-generation values, strictly decodes and bounds messages, ignores duplicate message IDs, and on reload requests a canonical snapshot instead of trusting renderer state. A document containing a required element type missing from `src/embedded/compatibility-manifest.json` opens read-only with an "Update required" message.

The `whiteboard-v1` transport limits (frame sizes, multipart update bounds, snapshot recovery timing) live in `contract/schema/whiteboard-v1.json`. Larger logical updates travel as atomic multipart operations, and an incomplete inbound operation is never exposed to the renderer.
