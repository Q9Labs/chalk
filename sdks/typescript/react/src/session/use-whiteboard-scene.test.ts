// @vitest-environment happy-dom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWhiteboardScene } from "./use-whiteboard-scene";

describe("useWhiteboardScene", () => {
  it("starts on open, stops on close, and stops on unmount", () => {
    const start = vi.fn(() => Promise.resolve());
    const stop = vi.fn();
    const whiteboard = { startSceneSubscription: start, stopSceneSubscription: stop };
    const onError = vi.fn();
    const { rerender, unmount } = renderHook(({ isOpen }) => useWhiteboardScene(whiteboard, isOpen, onError), { initialProps: { isOpen: false } });

    rerender({ isOpen: true });
    expect(start).toHaveBeenCalledOnce();
    rerender({ isOpen: false });
    expect(stop).toHaveBeenCalledOnce();

    rerender({ isOpen: true });
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed subscription only while the subscription is active", async () => {
    const start = vi.fn(() => Promise.reject(new Error("Whiteboard unavailable")));
    const stop = vi.fn();
    const onError = vi.fn();
    const { unmount } = renderHook(() => useWhiteboardScene({ startSceneSubscription: start, stopSceneSubscription: stop }, true, onError));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Whiteboard unavailable"));
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
});
