// @vitest-environment happy-dom

import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { renderHook, waitFor } from "../test-renderer";
import { useJoinSession } from "./use-join-session";

describe("useJoinSession", () => {
  it("joins on mount and publishes the first live transition once", () => {
    const join = vi.fn(() => Promise.resolve());
    const onFailure = vi.fn();
    const onJoined = vi.fn();
    const session = { join } satisfies Pick<ChalkSessionStore, "join">;
    const { result, rerender, unmount } = renderHook(({ state }) => useJoinSession({ session, state, onFailure, onJoined }), { initialProps: { state: "joining" as const } });

    expect(join).toHaveBeenCalledOnce();
    expect(result.current.current).toBeNull();
    rerender({ state: "live" });
    expect(onJoined).toHaveBeenCalledOnce();
    expect(result.current.current).toBeInstanceOf(Date);
    rerender({ state: "live" });
    expect(onJoined).toHaveBeenCalledOnce();

    unmount();
  });

  it("normalizes join failures before publishing them", async () => {
    const join = vi.fn(() => Promise.reject("join failed"));
    const onFailure = vi.fn();
    const session = { join } satisfies Pick<ChalkSessionStore, "join">;

    renderHook(() => useJoinSession({ session, state: "joining", onFailure, onJoined: vi.fn() }));

    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "join failed" })));
  });
});
