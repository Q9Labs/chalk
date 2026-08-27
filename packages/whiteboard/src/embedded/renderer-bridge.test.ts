// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeEmbeddedWhiteboardRendererMessage, encodeEmbeddedWhiteboardMessage, type ChalkEmbeddedWhiteboardHostMessage } from "./protocol";
import { ChalkEmbeddedWhiteboardRendererBridge } from "./renderer-bridge";

const rendererGeneration = "renderer-generation-test";
const journeyId = "journey-test";

describe("ChalkEmbeddedWhiteboardRendererBridge", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", `/?journeyId=${journeyId}&rendererGeneration=${rendererGeneration}`);
    window.ReactNativeWebView = { postMessage: vi.fn() };
  });

  it("announces compatibility and ignores replayed host messages", () => {
    const bridge = new ChalkEmbeddedWhiteboardRendererBridge();
    const listener = vi.fn();
    bridge.subscribe(listener);

    bridge.start();

    const postMessage = vi.mocked(window.ReactNativeWebView!.postMessage);
    expect(decodeEmbeddedWhiteboardRendererMessage(String(postMessage.mock.calls[0]?.[0]), rendererGeneration)).toMatchObject({
      type: "ready",
      journeyId,
      rendererGeneration,
    });

    const initialize = hostMessage(
      {
        type: "initialize",
        payload: { canDraw: true, canClear: false, theme: "light" },
      },
      "host-message-1",
    );
    window.dispatchEvent(new MessageEvent("message", { data: initialize }));
    window.dispatchEvent(new MessageEvent("message", { data: initialize }));

    expect(listener).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("settles renderer requests only from matching host operation results", async () => {
    const bridge = new ChalkEmbeddedWhiteboardRendererBridge();
    bridge.start();

    const request = bridge.requestSnapshot();
    const postMessage = vi.mocked(window.ReactNativeWebView!.postMessage);
    const outbound = decodeEmbeddedWhiteboardRendererMessage(String(postMessage.mock.calls.at(-1)?.[0]), rendererGeneration);
    expect(outbound.type).toBe("request_snapshot");
    if (outbound.type !== "request_snapshot") throw new Error("expected request_snapshot");

    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    window.dispatchEvent(
      new MessageEvent("message", {
        data: hostMessage(
          {
            type: "operation_result",
            payload: { requestId: "different-request", ok: true },
          },
          "host-message-wrong",
        ),
      }),
    );

    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: hostMessage(
          {
            type: "operation_result",
            payload: { requestId: outbound.payload.requestId, ok: true },
          },
          "host-message-2",
        ),
      }),
    );

    await expect(request).resolves.toBeUndefined();
    bridge.dispose();
  });
});

function hostMessage(message: ChalkEmbeddedWhiteboardHostMessage, messageId: string): string {
  return encodeEmbeddedWhiteboardMessage(message, {
    rendererGeneration,
    journeyId,
    nextMessageId: () => messageId,
  });
}
