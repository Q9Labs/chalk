import { describe, expect, it } from "vitest";

import { CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION, CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES, decodeEmbeddedWhiteboardRendererMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedWhiteboardRendererMessage } from "./protocol";

const context = {
  rendererGeneration: "renderer-generation-1",
  journeyId: "journey-1",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  nextMessageId: () => "message-1",
};

describe("embedded whiteboard bridge protocol", () => {
  it("round trips a versioned renderer envelope with its exact payload byte count", () => {
    const message: ChalkEmbeddedWhiteboardRendererMessage = {
      type: "ready",
      payload: {
        excalidrawVersion: CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION,
        supportedBridgeVersions: [1],
      },
    };

    const decoded = decodeEmbeddedWhiteboardRendererMessage(encodeEmbeddedWhiteboardMessage(message, context), context.rendererGeneration);

    expect(decoded).toMatchObject({
      bridgeVersion: 1,
      rendererGeneration: context.rendererGeneration,
      journeyId: context.journeyId,
      messageId: "message-1",
      type: "ready",
      payload: message.payload,
    });
    expect(decoded.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(message.payload)).byteLength);
  });

  it("fails closed for stale generations, unknown fields, and changed payloads", () => {
    const raw = encodeEmbeddedWhiteboardMessage(
      {
        type: "cursor",
        payload: { x: 1, y: 2 },
      } satisfies ChalkEmbeddedWhiteboardRendererMessage,
      context,
    );

    expect(() => decodeEmbeddedWhiteboardRendererMessage(raw, "renderer-generation-2")).toThrow("generation is stale");

    const withUnknown = { ...(JSON.parse(raw) as Record<string, unknown>), credential: "must-not-cross" };
    expect(() => decodeEmbeddedWhiteboardRendererMessage(JSON.stringify(withUnknown))).toThrow("envelope is invalid");

    const changed = JSON.parse(raw) as Record<string, unknown>;
    changed.payload = { x: 100, y: 200 };
    expect(() => decodeEmbeddedWhiteboardRendererMessage(JSON.stringify(changed))).toThrow("byte count is invalid");

    expect(() =>
      encodeEmbeddedWhiteboardMessage(
        {
          type: "oversized_probe",
          payload: { value: "x".repeat(CHALK_EMBEDDED_WHITEBOARD_MAX_MESSAGE_BYTES - 256) },
        },
        context,
      ),
    ).toThrow("message exceeds the bridge limit");
  });
});
