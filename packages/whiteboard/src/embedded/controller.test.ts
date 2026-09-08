import { describe, expect, it, vi } from "vitest";

import { CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, decodeEmbeddedWhiteboardHostMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedWhiteboardRendererMessage } from "./protocol";
import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardRendererPort, type ChalkEmbeddedWhiteboardTransport } from "./controller";

describe("ChalkWhiteboardController viewport", () => {
  it("replays the latest measured viewport when the renderer becomes ready", async () => {
    let deliverRendererMessage: ((message: string) => void) | undefined;
    const posted: string[] = [];
    const renderer = {
      postMessage: (message: string) => posted.push(message),
      subscribe: (listener: (message: string) => void) => {
        deliverRendererMessage = listener;
        return () => {
          deliverRendererMessage = undefined;
        };
      },
    } satisfies ChalkEmbeddedWhiteboardRendererPort;
    const startSceneSubscription = vi.fn(async () => undefined);
    const transport = createTransport(startSceneSubscription);
    let hostMessageId = 0;
    const controller = new ChalkWhiteboardController({
      renderer,
      transport,
      journeyId: "journey-viewport",
      canDraw: true,
      canClear: true,
      nextMessageId: () => `host-${++hostMessageId}`,
    });

    controller.start();
    controller.setViewport({ width: 640, height: 420, scale: 2 });
    expect(posted).toHaveLength(0);
    if (!deliverRendererMessage) throw new Error("renderer subscription was not started");

    deliverRendererMessage(
      encodeEmbeddedWhiteboardMessage(
        {
          type: "ready",
          payload: { excalidrawVersion: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, supportedBridgeVersions: [1] },
        } satisfies ChalkEmbeddedWhiteboardRendererMessage,
        {
          rendererGeneration: "renderer-viewport",
          journeyId: "journey-viewport",
          nextMessageId: () => "renderer-ready",
        },
      ),
    );

    await vi.waitFor(() => expect(startSceneSubscription).toHaveBeenCalledOnce());
    const messages = posted.map((message) => decodeEmbeddedWhiteboardHostMessage(message, "renderer-viewport"));
    expect(messages.map((message) => message.type)).toEqual(["initialize", "set_viewport"]);
    expect(messages[1]).toMatchObject({ type: "set_viewport", payload: { width: 640, height: 420, scale: 2 } });
    controller.stop();
  });
});

function createTransport(startSceneSubscription: () => Promise<void>): ChalkEmbeddedWhiteboardTransport {
  return {
    startSceneSubscription,
    stopSceneSubscription: () => undefined,
    subscribe: () => () => undefined,
    submitUpdate: async () => ({ operationId: "operation", sceneId: "scene", revision: "revision" }),
    sendCursor: () => undefined,
    requestSnapshot: async () => undefined,
    clear: async () => ({ operationId: "operation", sceneId: "scene", revision: "revision" }),
    files: {
      initiateUpload: async () => ({ uploadId: "upload", method: "PUT", uploadUrl: "https://example.com/upload", headers: {} }),
      finalizeUpload: async () => undefined,
      getDownloadUrl: async () => ({ downloadUrl: "https://example.com/download" }),
    },
  };
}
