# Native Whiteboard Strategy

Status: done
Date: 2026-07-29

Chalk should not start by porting Excalidraw to Swift and Kotlin, and it should not replace Excalidraw with a greenfield whiteboard while lossless web/mobile round trips remain required. The best first implementation is a self-contained Excalidraw web bundle inside thin native iOS and Android views, with Chalk-owned scene, collaboration, file, and bridge contracts around it. If real-device tests show that the embedded renderer cannot meet the inking bar, add a native ink overlay for stylus capture before considering a complete native renderer.

This is not a short-term compromise that blocks a native future. A renderer-neutral boundary lets Chalk ship the embedded renderer now, add native ink selectively, and replace the renderer later without replacing the SDK contract or collaboration protocol.

## What Chalk Already Owns

Chalk already has more reusable whiteboard infrastructure than a new project would. `@q9labsai/chalk-whiteboard` owns the Excalidraw collaboration lifecycle, scene updates, file synchronization, cursor presence, and math elements. The React Native SDK already exposes whiteboard state, permissions, transport, snapshots, updates, cursors, and clear/sync commands, but its meeting stage still shows a placeholder instead of a renderer.

The current collaboration engine is coupled to Excalidraw behavior beyond its JSON shape. It calls Excalidraw's `restoreElements`, `reconcileElements`, and `hashElementsVersion`, and it relies on element versions, deleted elements, ordering, file IDs, and scene epochs. Excalidraw's own restore documentation confirms that restoration repairs defaults and bindings and manages `version`, `versionNonce`, text dimensions, and fractional indices. A compatible native editor must reproduce those rules or continue invoking the Excalidraw implementation.

Sources: [Chalk whiteboard package](../packages/whiteboard/README.md), [Chalk collaboration engine](../packages/whiteboard/src/collab/engine.ts), [React Native whiteboard hook](../sdks/typescript/react-native/src/hooks/useWhiteboard.ts), [Excalidraw restore utilities](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/restore), [Excalidraw JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema).

## Decision Matrix

| Option                                          | Lossless Excalidraw round trip                                             | Native UX ceiling                | SDK reach                                                                                       | Permanent maintenance                                    | Recommendation                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| Port Excalidraw to Swift and Kotlin             | Possible, but hardest to keep correct                                      | Highest                          | Native iOS and Android                                                                          | Extreme: web plus two editors                            | Do not start here                            |
| Build a new Chalk whiteboard                    | Conflicts with the requirement unless it rebuilds Excalidraw compatibility | Highest                          | Depends on every wrapper Chalk ships                                                            | Extreme: Chalk owns the whole editor                     | Reject while compatibility is mandatory      |
| Embed a local Excalidraw bundle in native views | Strongest because the same editor interprets the scene                     | Medium to high after mobile work | Broad: the same bundle can sit behind iOS, Android, React Native, Flutter, and desktop wrappers | Lowest                                                   | Recommended first                            |
| Add native ink over the embedded editor         | Strong for freehand elements; the web editor still owns final scenes       | High for pen input               | Native wrappers plus the same web payload                                                       | Medium                                                   | Recommended if device tests expose ink gaps  |
| Build one shared native renderer                | Possible, but it becomes a second Excalidraw-compatible editor             | High                             | React Native only with RN Skia; broader only with a lower-level C++ or Rust core                | High                                                     | Consider only after measured WebView failure |
| Adopt a managed whiteboard SDK                  | No practical lossless Excalidraw compatibility                             | Product-dependent                | Usually iOS, Android, and web                                                                   | Vendor and migration burden replace renderer maintenance | Procurement fallback only                    |

## Option 1: Port Excalidraw to Swift and Kotlin

This sounds like a fork, but it is a reimplementation. Excalidraw ships as a React component, depends on `react-dom`, targets browsers, uses CSS and web APIs, and does not support server rendering. When asked about React Native, an Excalidraw maintainer closed the request as not planned and said it would likely require a WebView with compatible web and Canvas APIs. The MIT license permits a port, but the license does not make the architecture portable.

Pros:

- Native input APIs offer the highest ceiling for stylus latency, palm rejection, hover, squeeze, eraser controls, accessibility, file handling, keyboard behavior, and app lifecycle. PencilKit provides low-latency Apple Pencil and touch capture, while Jetpack Ink provides low-latency stylus input and rendering on Android.
- Native Swift and Kotlin views produce the cleanest SDK experience for customers already building native apps.
- Chalk controls the release schedule and can tailor every interaction to meetings instead of carrying Excalidraw's desktop-first interface.

Cons:

- Chalk would maintain three editors: the existing web editor and separate iOS and Android implementations. Each new or changed Excalidraw element, binding rule, ordering rule, font metric, import repair, export behavior, and merge rule becomes a compatibility project.
- Matching pixels is not enough. A port must preserve deterministic rough shapes, text dimensions, arrows and bindings, groups and frames, deleted elements, file references, fractional ordering, versions, undo semantics, selection and hit testing, and concurrent reconciliation.
- Native text and shape rendering will differ across Core Graphics, Android Canvas, and browser Canvas unless Chalk builds and owns a shared geometry and text engine.
- Web-only elements such as embeds still require web content, so a pure-native claim does not remove WebViews from the entire feature set.
- Upstream Excalidraw improvements become manual ports rather than package upgrades.

Sources: [Excalidraw installation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation), [browser-only integration details](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration), [package manifest](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/package.json), [React Native support response](https://github.com/excalidraw/excalidraw/issues/8664#issuecomment-2423125479), [MIT license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE), [PencilKit](https://developer.apple.com/documentation/pencilkit), [Jetpack Ink](https://developer.android.com/develop/ui/views/touch-and-input/stylus-input/about-ink-api).

## Option 2: Build a Chalk Whiteboard from Scratch

This is attractive only if Chalk is willing to make its own scene format the source of truth and migrate the web editor too. Under the current requirement, a greenfield editor still needs a complete, lossless Excalidraw importer, exporter, renderer, and merge implementation. That is most of the native-port work plus a format migration.

Pros:

- Chalk can design a small, versioned scene model around meetings, collaboration, observability, offline recovery, permissions, and future AI tools.
- The editor can share one deliberate core instead of inheriting browser architecture.
- Chalk owns product direction and avoids upstream API drift.

Cons:

- A full editor includes selection, transforms, snapping, grouping, arrows, text editing and layout, images, files, clipboard, history, accessibility, export, large-scene performance, recovery, and multiplayer conflict handling. Drawing primitives are a small fraction of the product.
- Lossless Excalidraw compatibility constrains the new model. If Chalk preserves every Excalidraw behavior, this becomes a port under a new name; if it does not, scenes lose data or change appearance.
- Replacing the format also forces a web migration and permanent compatibility support for old scenes.
- Agent capacity reduces typing cost, but it does not remove device-specific failures, interaction design, visual conformance, regression testing, or long-term release drift.

This becomes the right option only if Chalk intentionally stops treating Excalidraw scenes as the durable format.

## Option 3: Local Excalidraw Bundle in a Native SDK Shell

Package a pinned, self-hosted Chalk whiteboard web build with its fonts and assets. Host it in `WKWebView` on Apple platforms and Android `WebView`, then expose native `ChalkWhiteboardView` wrappers. React Native, Flutter, and other framework packages wrap those same native views instead of owning another renderer.

The payload is framework- and language-agnostic because it communicates through versioned JSON messages. The thin host wrappers are necessarily platform-specific; no interactive UI component can be literally package-agnostic. React Native WebView already supports iOS, Android, macOS, and Windows, local HTML, JavaScript injection, and bidirectional messaging.

Pros:

- The same Excalidraw implementation renders, restores, edits, and reconciles every scene, which gives this option the strongest compatibility.
- One bundled renderer can serve Chalk's app and third-party SDKs without a network dependency. Chalk can pin the version, self-host fonts, verify the artifact, and upgrade deliberately.
- Native code can own files, clipboard, share sheets, keyboard avoidance, safe areas, lifecycle, permissions, deep links, and telemetry while the web view owns editor behavior.
- The bridge creates the renderer boundary needed for a later native implementation.
- Using a WebView for one rich feature inside Chalk does not make the whole app a repackaged website. Apple's rule targets apps that offer no meaningful app-like value beyond a site; Chalk already has substantial native conferencing behavior. App review remains a release proof, not an architectural guarantee.

Cons:

- Excalidraw works on touch devices but remains desktop-oriented. Its open touch meta issue lists stylus, palm rejection, gesture, performance, keyboard, file, and mobile UI gaps. Wrapping the existing desktop interface unchanged will not produce native-grade UX.
- WebView differences still require device work for focus, keyboard, clipboard, file pickers, downloads, accessibility, safe areas, memory pressure, process death, and gesture arbitration.
- The JavaScript/native bridge should carry commands and completed scene changes, not every pen sample, or it can become a latency source.
- SDK consumers receive a native view backed by web technology, which some customers may reject for policy or perception reasons even when the UX is good.

Sources: [React Native WebView platforms](https://github.com/react-native-webview/react-native-webview), [local content and messaging guide](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md), [Excalidraw touch-device gaps](https://github.com/excalidraw/excalidraw/issues/9705), [Apple App Review guideline 4.2](https://developer.apple.com/app-store/review/guidelines/).

## Option 4: Native Ink, Web Scene

Place a transparent native ink surface above the embedded editor while the pen tool is active. PencilKit or Jetpack Ink captures and displays the live stroke. At stroke completion, Chalk converts the sampled local points and pressures into an Excalidraw `freedraw` element, commits it into the web editor, and lets the existing collaboration engine broadcast it. Excalidraw already represents freehand strokes as points, pressures, and a pressure-simulation flag, so the data handoff is structurally possible.

Pros:

- This targets the part of mobile whiteboards where native APIs add the most value without rebuilding shapes, text, arrows, selection, files, undo, export, or collaboration.
- High-frequency samples remain native; the bridge can send one completed stroke rather than streaming every sample.
- The final scene stays in Excalidraw format and the web editor remains authoritative.
- Chalk can ship this selectively for devices or tools where it improves measured behavior.

Cons:

- Chalk must keep the native overlay's camera transform exactly synchronized with Excalidraw's pan and zoom.
- The provisional native stroke may change slightly when the Excalidraw renderer replaces it, because PencilKit, Jetpack Ink, and Excalidraw use different stroke renderers.
- Gesture routing becomes stateful: pen drawing, finger panning, pinch zoom, erasing, selection, and accessibility must pass to the correct layer.
- Undo, cancellation, remote updates during a stroke, rotation, split-screen resizing, and process interruption need explicit handoff rules.

This is a focused native enhancement, not a general native editor, and that limited scope is its main advantage.

## Option 5: Shared Native Renderer

React Native Skia is the most practical shared-renderer candidate for Chalk's current mobile app. It supports iOS and Android, works with Expo, provides a Canvas, shapes, paths, images, advanced text, UI-thread integration, and web support through CanvasKit.

Pros:

- One TypeScript/React Native renderer can serve Chalk's iOS and Android apps with native Skia surfaces and a consistent visual implementation.
- Chalk can reuse parts of its TypeScript scene, transport, and collaboration code.
- It offers better control over gestures, rendering, caching, and large-scene performance than a DOM-heavy editor.

Cons:

- React Native Skia is React Native-specific. A native Swift or Kotlin SDK customer cannot consume that component without embedding React Native.
- Web support loads a 2.9 MB compressed CanvasKit WebAssembly runtime and has some unsupported APIs; replacing the current web renderer would add a migration with no immediate compatibility benefit.
- Skia supplies graphics primitives, not an editor. Chalk still builds text editing, selection, hit testing, transforms, arrows, bindings, snapping, history, accessibility overlays, clipboard, files, export, and Excalidraw-compatible reconciliation.
- A truly framework-neutral shared renderer requires a lower-level C++ or Rust core plus Swift, Kotlin, React Native, web, and perhaps Flutter bindings. That reduces duplicated geometry but creates a graphics-engine project.

Sources: [React Native Skia installation and supported platforms](https://shopify.github.io/react-native-skia/docs/getting-started/installation/), [Canvas architecture and accessibility](https://shopify.github.io/react-native-skia/docs/canvas/overview/), [CanvasKit web runtime and limitations](https://shopify.github.io/react-native-skia/docs/getting-started/web/).

## Managed and Alternate Engines

Agora Interactive Whiteboard is the strongest managed alternative found. Its Whiteboard and Fastboard SDKs interoperate across iOS, Android, and web, provide collaboration infrastructure, and offer either APIs or a prebuilt UI. Current list pricing starts at $1.40 per 1,000 usage minutes after the free allowance.

It does not preserve Chalk's Excalidraw scenes or existing collaboration transport, so adopting it means a backend, format, and product migration. Its iOS quickstart also constructs the whiteboard with `WKWebView`, which shows that a vendor's “native SDK” label does not necessarily mean a native renderer. It is useful if Chalk decides to buy the whole whiteboard service and abandon Excalidraw compatibility, not as a renderer swap.

tldraw is a capable React/browser editor with declared mobile and touch support, but it is still a browser SDK, production use requires a license, and its scene model does not round-trip Excalidraw. It may be a better greenfield web engine, but it does not solve this decision under the compatibility requirement.

Sources: [Agora comparison](https://docs.agora.io/en/realtime-media/whiteboard/whiteboard-fastboard), [supported platforms](https://docs.agora.io/en/realtime-media/whiteboard/reference/supported-platforms), [iOS and Android quickstart](https://docs.agora.io/en/realtime-media/whiteboard/build/set-up-and-build-your-first-app/get-started-sdk), [Agora pricing](https://www.agora.io/en/pricing/), [tldraw repository and license summary](https://github.com/tldraw/tldraw).

## Recommended Sequence

1. Define a versioned renderer contract before adding UI: load a scene, apply remote elements, emit local updates, expose camera state, import and export files, report capabilities, and surface structured errors and performance metrics.
2. Build a local embedded renderer around Chalk's existing Excalidraw package. Replace the desktop toolbar with a touch-first Chalk UI, and bridge native files, clipboard, keyboard, lifecycle, safe areas, and telemetry.
3. Create a conformance corpus from real Chalk scenes. Verify lossless JSON preservation, visual snapshots, text and math, images, frames and bindings, deletes and clears, concurrent edits, offline recovery, and unknown future elements.
4. Test on real iPhone, iPad with Apple Pencil, representative Android phones, and a Samsung tablet with S Pen while a Chalk call is carrying live audio and video. Gate on stroke latency, dropped samples, gesture errors, memory pressure, scene size, battery use, rotation, split view, keyboard, files, and recovery.
5. If the embedded editor meets the bar, stop. If pen input fails while the rest succeeds, add the native ink overlay. Build a shared native renderer only if measured failures affect the broader editor and cannot be fixed within the embedded architecture.

The decision flips toward a full native engine only if Chalk later makes its own scene model authoritative, or if real-device evidence shows that the embedded and hybrid paths cannot meet the product bar.
