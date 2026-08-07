import { describe, expect, it, vi } from "vitest";
import { observeNativeFrameNotObservable } from "./episode-diagnostic-render-observer";

const REGISTRY = Symbol.for("@chalk/private/episode-diagnostic-render-registry/v1");

describe("observeNativeFrameNotObservable", () => {
  it("emits an explicit gap because the native RTC view exposes no first-frame callback", () => {
    const track = {};
    const report = vi.fn();
    (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = new WeakMap([[track, report]]);

    observeNativeFrameNotObservable(track);

    expect(report).toHaveBeenCalledWith("not_observable");
  });

  it("is inert when diagnostics did not register the track", () => {
    const report = vi.fn();
    (globalThis as unknown as Record<symbol, unknown>)[REGISTRY] = new WeakMap();

    expect(() => observeNativeFrameNotObservable({})).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
});
