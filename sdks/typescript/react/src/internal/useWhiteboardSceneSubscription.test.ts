// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";

import { useWhiteboardSceneSubscription } from "./useWhiteboardSceneSubscription";

const transport = (startSceneSubscription: ChalkWhiteboardV1Transport["startSceneSubscription"]): ChalkWhiteboardV1Transport => ({
  startSceneSubscription,
  stopSceneSubscription: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  submitUpdate: vi.fn(),
  sendCursor: vi.fn(),
  requestSnapshot: vi.fn(),
  clear: vi.fn(),
  setDrawPermission: vi.fn(),
  files: { initiateUpload: vi.fn(), finalizeUpload: vi.fn(), getDownloadUrl: vi.fn() },
});

describe("useWhiteboardSceneSubscription", () => {
  it("starts before reporting ready and stops when the Whiteboard closes", async () => {
    let resolveStart: (() => void) | undefined;
    const whiteboard = transport(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      ),
    );
    const { result, rerender } = renderHook(({ active }) => useWhiteboardSceneSubscription(whiteboard, active), { initialProps: { active: false } });

    expect(result.current.status).toBe("closed");
    expect(whiteboard.startSceneSubscription).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(result.current.status).toBe("loading");
    await act(async () => Promise.resolve());
    expect(whiteboard.startSceneSubscription).toHaveBeenCalledOnce();

    await act(async () => resolveStart?.());
    expect(result.current).toEqual({ status: "ready", transport: whiteboard });

    rerender({ active: false });
    expect(result.current.status).toBe("closed");
    expect(whiteboard.stopSceneSubscription).toHaveBeenCalledOnce();
  });

  it("reports startup failure without exposing the collaboration engine", async () => {
    const failure = new Error("Whiteboard welcome timed out.");
    const whiteboard = transport(vi.fn().mockRejectedValue(failure));
    const { result, unmount } = renderHook(() => useWhiteboardSceneSubscription(whiteboard, true));

    await waitFor(() => expect(result.current).toEqual({ status: "failed", error: failure }));
    unmount();
    expect(whiteboard.stopSceneSubscription).toHaveBeenCalledOnce();
  });

  it("turns a synchronous transport failure into hook state", async () => {
    const failure = new Error("Whiteboard transport is unavailable.");
    const whiteboard = transport(
      vi.fn(() => {
        throw failure;
      }),
    );
    const { result } = renderHook(() => useWhiteboardSceneSubscription(whiteboard, true));

    await waitFor(() => expect(result.current).toEqual({ status: "failed", error: failure }));
  });
});
