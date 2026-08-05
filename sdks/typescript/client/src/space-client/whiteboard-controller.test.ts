import { afterEach, describe, expect, it } from "vitest";
import type { ChalkWhiteboardSummary } from "../whiteboard/types";
import { ControllerHarness, disposeControllerRuntimes, whiteboardTransport } from "./controller-parity.test.helpers";

afterEach(disposeControllerRuntimes);

describe("WhiteboardController", () => {
  it("keeps the transport as the engine attach point while reflecting summaries and resetting it on leave", async () => {
    const transport = whiteboardTransport();
    let onSummary: ((summary: ChalkWhiteboardSummary) => void) | undefined;
    const harness = new ControllerHarness();
    const { controller } = harness.whiteboard((input) => {
      onSummary = input.onSummary;
      return transport;
    });

    harness.connect();
    expect(controller.transport()).toBe(transport);
    expect(transport.startSceneSubscription).not.toHaveBeenCalled();
    await controller.transport()!.startSceneSubscription();
    onSummary?.({ status: "ready", sceneId: "scene-1", revision: "3", capabilities: ["drawWhiteboard"], canDraw: true, canClear: false, error: null });
    expect(harness.store.getSnapshot().whiteboard).toEqual({ open: true, engine: { status: "ready", sceneId: "scene-1", revision: "3", error: null } });

    const stable = harness.store.getSnapshot().whiteboard;
    onSummary?.({ status: "ready", sceneId: "scene-1", revision: "3", capabilities: ["drawWhiteboard"], canDraw: true, canClear: false, error: null });
    expect(harness.store.getSnapshot().whiteboard).toBe(stable);

    harness.disconnect();
    expect(transport.stopSceneSubscription).toHaveBeenCalledOnce();
    expect(harness.store.getSnapshot().whiteboard).toEqual({ open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } });
    onSummary?.({ status: "ready", sceneId: "stale-scene", revision: "4", capabilities: ["drawWhiteboard"], canDraw: true, canClear: false, error: null });
    expect(harness.store.getSnapshot().whiteboard.engine.sceneId).toBeNull();
  });
});
