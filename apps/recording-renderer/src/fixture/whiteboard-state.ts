/** A small Excalidraw scene in the recording whiteboard state format; revision 2 adds three elements to revision 1. */
export function whiteboardState(revision: 1 | 2): Buffer {
  const base = { angle: 0, strokeColor: "#1e1e1e", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false, backgroundColor: "transparent", fillStyle: "solid", roundness: null };
  const text = (id: string, index: string, x: number, y: number, value: string, fontSize: number) => ({
    id,
    index,
    payload: { ...base, x, y, width: value.length * fontSize * 0.55, height: fontSize * 1.25, seed: 7, text: value, originalText: value, fontSize, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 },
    type: "text",
  });
  const elements = [
    { id: "box-1", index: "a0", type: "rectangle", payload: { ...base, x: 40, y: 80, width: 320, height: 180, backgroundColor: "#a5d8ff", fillStyle: "hachure", roundness: { type: 3 }, seed: 1 } },
    text("title", "a1", 40, 10, "Q3 onboarding flow", 36),
    text("box-1-label", "a2", 70, 150, "Sign up", 28),
    {
      id: "arrow-1",
      index: "a3",
      type: "arrow",
      payload: {
        ...base,
        x: 370,
        y: 170,
        width: 180,
        height: 0,
        seed: 3,
        points: [
          [0, 0],
          [180, 0],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      },
    },
    { id: "box-2", index: "a4", type: "ellipse", payload: { ...base, x: 560, y: 80, width: 260, height: 180, backgroundColor: "#ffc9c9", seed: 4 } },
    text("box-2-label", "a5", 610, 150, "First call", 28),
    ...(revision === 2
      ? [{ id: "note", index: "a6", type: "diamond", payload: { ...base, x: 300, y: 330, width: 260, height: 160, backgroundColor: "#b2f2bb", fillStyle: "cross-hatch", seed: 5 } }, text("note-label", "a7", 345, 395, "Invite team?", 24), text("emoji", "a8", 600, 400, "Ship it 🚀", 28)]
      : []),
  ].map((element) => ({ id: element.id, type: element.type, version: revision, version_nonce: revision, index: element.index, is_deleted: false, payload: element.payload }));
  return Buffer.from(JSON.stringify({ schemaVersion: "recording_whiteboard_state.v1", sceneId: "scene-1", revision, appState: {}, elements }));
}
