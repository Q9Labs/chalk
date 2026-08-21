import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreviewScreenTrack } from "./preview-screen-track";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createCanvasHarness() {
  const track = { stop: vi.fn() };
  const context = {
    fillStyle: "",
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    font: "",
    textAlign: "",
    fillText: vi.fn(),
    strokeStyle: "",
    strokeRect: vi.fn(),
  };
  const getContext = vi.fn(() => context);
  const getVideoTracks = vi.fn(() => [track]);
  const captureStream = vi.fn(() => ({ getVideoTracks }));
  const canvas = { width: 0, height: 0, getContext, captureStream };
  const createElement = vi.fn(() => canvas);
  return { track, context, getContext, getVideoTracks, captureStream, canvas, createElement };
}

describe("createPreviewScreenTrack", () => {
  it("paints and captures a 1280 by 720 canvas as a video track", () => {
    const { track, context, getContext, getVideoTracks, captureStream, canvas, createElement } = createCanvasHarness();
    vi.stubGlobal("document", { createElement });

    const preview = createPreviewScreenTrack();

    if (!preview) throw new Error("Expected a screen preview track");
    expect(createElement).toHaveBeenCalledWith("canvas");
    expect(canvas).toMatchObject({ width: 1280, height: 720 });
    expect(getContext).toHaveBeenCalledWith("2d");
    expect(captureStream).toHaveBeenCalledWith(4);
    expect(getVideoTracks).toHaveBeenCalledOnce();
    expect(preview.track).toBe(track);
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledWith("chalk.team/docs/product-review", 640, 33);
  });

  it("repaints on its timer and clears the timer when stopped", () => {
    vi.useFakeTimers();
    const { track, context, createElement } = createCanvasHarness();
    vi.stubGlobal("document", { createElement });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const preview = createPreviewScreenTrack();
    if (!preview) throw new Error("Expected a screen preview track");

    expect(context.fillStyle).toBe("#202329");
    const initialPaintCount = context.fillRect.mock.calls.length;
    vi.advanceTimersByTime(499);
    expect(context.fillRect).toHaveBeenCalledTimes(initialPaintCount);

    vi.advanceTimersByTime(1);
    expect(context.fillRect).toHaveBeenCalledTimes(initialPaintCount * 2);
    expect(context.fillStyle).toBe("#fbfaf7");

    preview.stop();

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    const stoppedPaintCount = context.fillRect.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(context.fillRect).toHaveBeenCalledTimes(stoppedPaintCount);
  });

  it("falls back when the canvas cannot provide a capture stream or context", () => {
    const canvasWithoutCapture = { width: 0, height: 0, getContext: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvasWithoutCapture) });

    expect(createPreviewScreenTrack("missing-capture").track).toMatchObject({ id: "missing-capture", kind: "video" });
    expect(canvasWithoutCapture.getContext).not.toHaveBeenCalled();

    const canvasWithoutContext = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => null),
      captureStream: vi.fn(),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvasWithoutContext) });

    expect(createPreviewScreenTrack("missing-context").track).toMatchObject({ id: "missing-context", kind: "video" });
    expect(canvasWithoutContext.getContext).toHaveBeenCalledWith("2d");
    expect(canvasWithoutContext.captureStream).not.toHaveBeenCalled();
  });

  it("falls back when canvas context or capture creation throws", () => {
    const contextFailure = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => {
        throw new Error("context unavailable");
      }),
      captureStream: vi.fn(),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => contextFailure) });
    expect(createPreviewScreenTrack("context-fallback").track.id).toBe("context-fallback");

    const captureFailure = createCanvasHarness();
    captureFailure.captureStream.mockImplementation(() => {
      throw new Error("capture unavailable");
    });
    vi.stubGlobal("document", { createElement: captureFailure.createElement });
    expect(createPreviewScreenTrack("capture-fallback").track.id).toBe("capture-fallback");
  });
});
