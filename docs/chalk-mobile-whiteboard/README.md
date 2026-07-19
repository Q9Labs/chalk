# Native Chalk whiteboard proposal

This is a target design, not a shipped-capability description. The current React whiteboard uses the shared Excalidraw collaboration package, while React Native exposes whiteboard state but still renders a placeholder stage; see [`product.yaml`](../../product.yaml) for current status.

A native implementation should render and edit Chalk's shared whiteboard model directly on iOS and Android rather than embedding a web canvas. It should support local-first edits, versioned operations, snapshots, retry, deterministic conflict handling, cursors, and partial strokes, with one interoperable file format across web and mobile.
