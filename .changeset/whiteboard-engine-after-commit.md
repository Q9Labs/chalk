---
"@q9labsai/chalk-whiteboard": patch
---

Start a collaborating `WhiteboardCanvas` engine only after React commits the editor. Excalidraw hands over its API
while React is still rendering, so a render that React discarded could leave the board bound to an editor that never
appeared: remote drawing stopped showing and local strokes stopped syncing. The engine now binds to the editor that is
on screen.
