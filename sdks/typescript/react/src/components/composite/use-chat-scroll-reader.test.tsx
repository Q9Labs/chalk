// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatScrollReader } from "./use-chat-scroll-reader";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useChatScrollReader", () => {
  it("coalesces rapid scroll events into one geometry read per animation frame", () => {
    let queuedFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 17;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const scroller = document.createElement("div");
    const marker = document.createElement("div");
    marker.dataset.chatSequence = "7";
    scroller.append(marker);
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
      scrollTop: { value: 100, writable: true },
    });
    const viewportBounds = vi.fn(() => DOMRect.fromRect({ y: 0, height: 100 }));
    const markerBounds = vi.fn(() => DOMRect.fromRect({ y: 20, height: 20 }));
    scroller.getBoundingClientRect = viewportBounds;
    marker.getBoundingClientRect = markerBounds;
    const onMarkRead = vi.fn();

    const { result } = renderHook(() =>
      useChatScrollReader({
        scrollRef: { current: scroller },
        isAtBottomRef: { current: false },
        lastMarkedSequenceRef: { current: null },
        latestSequence: "7",
        onMarkRead,
      }),
    );

    act(() => {
      result.current();
      result.current();
      result.current();
    });
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(viewportBounds).not.toHaveBeenCalled();

    act(() => queuedFrame?.(0));
    expect(viewportBounds).toHaveBeenCalledOnce();
    expect(markerBounds).toHaveBeenCalledOnce();
    expect(onMarkRead).toHaveBeenCalledWith("7");
  });
});
