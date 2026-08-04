# @q9labsai/chalk-react-native

React Native bindings and native platform adapters for Chalk.

The framework-agnostic `SpaceClient` owns lifecycle, access refresh, transport,
recovery, controllers, and the `SpaceSnapshot` store. The current compatibility
component exports retain `VideoConference`, `ConferenceView`, `PreJoinScreen`,
`EndScreen`, and the client-backed hooks while both platforms bind to the same
snapshot shape.

The React Native pre-live UI uses the same `PreJoinSettings` contract as React,
with `microphoneEnabled` and `cameraEnabled` fields. Native preview components
keep their platform audio/video state behind this public settings boundary.

## Embedded whiteboard

`ChalkEmbeddedWhiteboard` hosts Chalk's pinned Excalidraw renderer in
`react-native-webview`. Pass the `SpaceClient` whiteboard transport only after
the client has joined a live Episode:

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkEmbeddedWhiteboard } from "@q9labsai/chalk-react-native";

function Whiteboard({ client, journey }: { client: SpaceClient; journey: { context: { journeyId: string; traceparent: string } } }) {
  const snapshot = client.getSnapshot();
  const transport = client.whiteboard.transport();

  return transport ? (
    <ChalkEmbeddedWhiteboard
      canClear={snapshot.self.can("manageWhiteboard")}
      canDraw={snapshot.self.can("drawWhiteboard")}
      journeyId={journey.context.journeyId}
      onError={({ code, recoverable }) => reportWhiteboardError(code, recoverable)}
      onMetric={({ name, value }) => reportWhiteboardMetric(name, value)}
      traceparent={journey.context.traceparent}
      transport={transport}
    />
  ) : null;
}
```

The SDK packages the renderer as Android library assets and an iOS resource
bundle. The WebView accepts local file navigation only, disables remote
connections through CSP, and exchanges scene operations through a versioned,
bounded bridge. File uploads and downloads are performed by the application so
temporary storage URLs do not cross into the renderer.

The renderer build and bridge version are exact compatibility boundaries. A
document containing a required element type newer than the bundled renderer
opens read-only with an “Update required” message; it is never silently
rewritten. Bridge messages are limited to 32 MiB. Application-owned image
transfers are limited to 20 MiB and validate MIME declarations, signatures,
dimensions, decoded-memory cost, and SHA-256 digests before upload. Downloads
must declare an identity-encoded content length within the same limit before
the application buffers them.

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
