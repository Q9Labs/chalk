# Chalk mobile whiteboard

Chalk should own a small whiteboard format and render it natively on web, iOS, and Android. The first version needs pen strokes, basic shapes, text, selection, erasing, zoom, and pan.

Clients should apply edits locally, then send versioned operations through Chalk's existing whiteboard transport. Ordered operations, snapshots, retries, and deterministic conflict rules can guarantee that every client eventually reaches the same board, while live cursors and partial strokes make collaboration feel immediate.

This approach avoids a WebView and Excalidraw dependency, but Chalk must build and maintain the editing experience. The scope should stay smaller than Excalidraw until the core board works well on real devices.
