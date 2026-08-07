import { describe, expect, it, vi } from "vitest";
import { observeFirstRenderedFrame } from "./episode-diagnostic-render-observer";

const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

describe("observeFirstRenderedFrame", () => {
  it("reports only after the browser confirms a rendered video frame", () => {
    const track = {} as MediaStreamTrack;
    const report = vi.fn();
    (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = new WeakMap([[track, report]]);
    let frameCallback: (() => void) | undefined;
    const element = { requestVideoFrameCallback: (callback: () => void) => ((frameCallback = callback), 1) } as unknown as HTMLVideoElement;

    observeFirstRenderedFrame(element, track);
    expect(report).not.toHaveBeenCalled();
    frameCallback?.();

    expect(report).toHaveBeenCalledWith("first_frame");
  });

  it("reports the visibility gap when frame callbacks are unavailable", () => {
    const track = {} as MediaStreamTrack;
    const report = vi.fn();
    (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = new WeakMap([[track, report]]);

    observeFirstRenderedFrame({} as HTMLVideoElement, track);

    expect(report).toHaveBeenCalledWith("not_observable");
  });
});
