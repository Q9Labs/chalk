// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { act, renderHook } from "../test-renderer";
import { useJoiningScreenMessage } from "./joining-screen-message";

describe("useJoiningScreenMessage", () => {
  it("keeps the primary message first and rotates supporting messages", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useJoiningScreenMessage("Preparing the Space", ["Checking AccessGrant", "Opening the Episode"]));

    expect(result.current).toBe("Preparing the Space");
    act(() => vi.advanceTimersByTime(1_800));
    expect(result.current).toBe("Checking AccessGrant");
    act(() => vi.advanceTimersByTime(1_800));
    expect(result.current).toBe("Opening the Episode");

    unmount();
    vi.useRealTimers();
  });
});
