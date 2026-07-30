# @q9labsai/chalk-react-native

React Native components and native platform adapters for Chalk.

## Embedded whiteboard

`ChalkEmbeddedWhiteboard` hosts Chalk's pinned Excalidraw renderer in
`react-native-webview`. Pass the canonical `ChalkSessionStore.whiteboard`
transport only after a participant session is live:

```tsx
import { ChalkEmbeddedWhiteboard } from "@q9labsai/chalk-react-native";

const whiteboard = session?.whiteboard;

return whiteboard ? (
  <ChalkEmbeddedWhiteboard
    canClear={session.getSnapshot().whiteboard.canClear}
    canDraw={session.getSnapshot().whiteboard.canDraw}
    journeyId={journey.context.journeyId}
    onError={({ code, recoverable }) => reportWhiteboardError(code, recoverable)}
    onMetric={({ name, value }) => reportWhiteboardMetric(name, value)}
    traceparent={journey.context.traceparent}
    transport={whiteboard}
  />
) : null;
```

The SDK packages the renderer as Android library assets and an iOS resource
bundle. The WebView accepts local file navigation only, disables remote
connections through CSP, and exchanges scene operations through a versioned,
bounded bridge. File uploads and downloads are performed by the host so
temporary storage URLs do not cross into the renderer.

The renderer build and bridge version are exact compatibility boundaries. A
document containing a required element type newer than the bundled renderer
opens read-only with an “Update required” message; it is never silently
rewritten. Bridge messages are limited to 32 MiB. Host-owned image transfers
are limited to 20 MiB and validate MIME declarations, signatures, dimensions,
decoded-memory cost, and SHA-256 digests before upload. Downloads must declare
an identity-encoded content length within the same limit before the host
buffers them.

The whiteboard transport persists submitted operations for retry and recovers
incomplete multipart updates with a fresh snapshot. It does not permit new
offline authoring. Renderer errors and metrics are allowlisted and redacted;
callbacks never contain scene contents, signed URLs, tokens, or file bytes.

Build `@q9labsai/chalk-whiteboard` before
`@q9labsai/chalk-react-native`; the React Native build then copies the generated
renderer into the native resource directories. The Chalk mobile app's
`prepare:whiteboard` script rebuilds the embedded module, its declarations, and
the renderer assets before copying them. This clean-checkout path does not
delete the rest of `dist`, so it can run alongside ordered workspace builds
without serving stale controller code. Run `sync:whiteboard-assets` directly
only when the whiteboard package has already produced both
`dist/embedded/index.js` and `dist/embedded/chalk-whiteboard`.
