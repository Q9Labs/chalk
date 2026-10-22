import { expect, it, vi } from "vitest";
import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardTransportEvent } from "./controller";
import { decodeEmbeddedWhiteboardHostMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedBoardContext, type ChalkEmbeddedWhiteboardRendererMessage } from "./protocol";

const board: ChalkEmbeddedBoardContext = {
  primary: true,
  phone: true,
  following: null,
  ownParticipantId: "mobile",
  people: [{ id: "web", displayName: "Web" }],
  sceneId: "scene",
  sceneStatus: "subscribed",
  connectionStatus: "connected",
  viewsAvailable: true,
  viewBounds: { maxCoordinate: 1_000_000, maxExtent: 2_000_000 },
  colors: { canvas: "black", surface: "black", raised: "black", popover: "black", hover: "gray", line: "gray", lineStrong: "gray", text: "white", textStrong: "white", textMuted: "gray", textSoft: "gray", dangerText: "red", focus: "white" },
};
const view = { x: 80, y: 100, width: 390, height: 500, bring: false, originParticipantId: "web", originSequence: 7, originEpoch: "connection-2" } as const;

function fixture(canClear = true) {
  let rendererListener = (_message: string) => {};
  let transportListener = (_event: ChalkEmbeddedWhiteboardTransportEvent) => {};
  let sequence = 0;
  const posted: string[] = [];
  const sendView = vi.fn((_view: typeof view | { bring: boolean }) => true);
  const onFollow = vi.fn();
  const onCloseBoard = vi.fn();
  const onError = vi.fn();
  const controller = new ChalkWhiteboardController({
    renderer: {
      postMessage: (message) => posted.push(message),
      subscribe: (listener) => {
        rendererListener = listener;
        return () => {};
      },
    },
    transport: {
      startSceneSubscription: async () => {},
      stopSceneSubscription: () => {},
      subscribe: (listener) => {
        transportListener = listener;
        return () => {};
      },
      submitUpdate: async () => ({ operationId: "operation", sceneId: "scene", revision: "1" }),
      sendCursor: () => {},
      sendView,
      requestSnapshot: async () => {},
      clear: async () => ({ operationId: "operation", sceneId: "scene", revision: "2" }),
      files: { getDownloadUrl: async () => ({ downloadUrl: "https://example.test/image" }) },
    },
    board,
    journeyId: "mixed-call",
    canDraw: true,
    canClear,
    onFollow,
    onCloseBoard,
    onError,
  });
  controller.start();
  const deliver = (message: ChalkEmbeddedWhiteboardRendererMessage) => rendererListener(encodeEmbeddedWhiteboardMessage(message, { journeyId: "mixed-call", rendererGeneration: "renderer", nextMessageId: () => `renderer-${++sequence}` }));
  deliver({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } });
  return { controller, deliver, emit: (event: ChalkEmbeddedWhiteboardTransportEvent) => transportListener(event), posted, sendView, onFollow, onCloseBoard, onError };
}

it("forwards web views with relay identity and reconnect epoch intact, without echoing", () => {
  const f = fixture();
  try {
    f.emit({ type: "view", ...view, participantId: "web", displayName: "Web", occurredAt: "2026-10-22T00:00:00Z" });
    expect(f.posted.map((raw) => decodeEmbeddedWhiteboardHostMessage(raw))).toContainEqual(expect.objectContaining({ type: "apply_view", payload: expect.objectContaining(view) }));
    expect(f.sendView).not.toHaveBeenCalled();
  } finally {
    f.controller.stop();
  }
});

it("sends mobile views and host Bring everyone through the negotiated transport", async () => {
  const f = fixture();
  try {
    f.deliver({ type: "view", payload: { ...view, requestId: "view" } });
    f.deliver({ type: "view", payload: { ...view, bring: true, requestId: "bring" } });
    await vi.waitFor(() => expect(f.sendView).toHaveBeenCalledTimes(2));
    expect(f.sendView.mock.calls).toEqual([[view], [{ ...view, bring: true }]]);
  } finally {
    f.controller.stop();
  }
});

it("rejects guest Bring and invalid rectangles but permits a guest's own view", async () => {
  const f = fixture(false);
  try {
    f.deliver({ type: "view", payload: { ...view, bring: true, requestId: "bring" } });
    f.deliver({ type: "view", payload: { ...view, width: 0, requestId: "invalid" } });
    await vi.waitFor(() => expect(f.posted.map((raw) => decodeEmbeddedWhiteboardHostMessage(raw)).filter((message) => message.type === "operation_result" && !message.payload.ok)).toHaveLength(2));
    expect(f.sendView).not.toHaveBeenCalled();
    f.deliver({ type: "view", payload: { ...view, requestId: "view" } });
    await vi.waitFor(() => expect(f.sendView).toHaveBeenCalledOnce());
  } finally {
    f.controller.stop();
  }
});

it("replays the latest Follow and tile context after a renderer restart", () => {
  const f = fixture();
  try {
    const next = { ...board, following: "web", primary: false };
    f.controller.setBoard(next);
    f.controller.rendererReloaded();
    f.deliver({ type: "ready", payload: { excalidrawVersion: "0.18.1", supportedBridgeVersions: [1] } });
    expect(f.posted.map((raw) => decodeEmbeddedWhiteboardHostMessage(raw)).at(-1)).toMatchObject({ type: "initialize", payload: { board: next } });
  } finally {
    f.controller.stop();
  }
});

it("reports Stop following and Close board to the native stage", async () => {
  const f = fixture();
  try {
    f.deliver({ type: "follow", payload: { participantId: "web" } });
    f.deliver({ type: "follow", payload: { participantId: null } });
    f.deliver({ type: "close_board", payload: {} });
    await vi.waitFor(() => expect(f.onCloseBoard).toHaveBeenCalledOnce());
    expect(f.onFollow.mock.calls).toEqual([["web"], [null]]);
  } finally {
    f.controller.stop();
  }
});
