// @vitest-environment happy-dom

import type { ChalkSessionStore, SpaceClientStore } from "../client-compat";
import { describe, expect, it, vi } from "vitest";

import { renderHook, waitFor } from "./test-renderer";
import { useLeaveOnUnmount } from "./use-leave-on-unmount";

describe("useLeaveOnUnmount", () => {
  it("leaves the latest session once when the component unmounts", () => {
    const firstLeave = vi.fn(() => Promise.resolve());
    const secondLeave = vi.fn(() => Promise.resolve());
    const firstSession = { leave: firstLeave } satisfies Pick<ChalkSessionStore, "leave">;
    const secondSession = { leave: secondLeave } satisfies Pick<ChalkSessionStore, "leave">;
    const onUnmount = vi.fn();
    const { rerender, unmount } = renderHook(({ session }) => useLeaveOnUnmount(session, onUnmount), { initialProps: { session: firstSession } });

    rerender({ session: secondSession });
    unmount();

    expect(onUnmount).toHaveBeenCalledOnce();
    expect(firstLeave).not.toHaveBeenCalled();
    expect(secondLeave).toHaveBeenCalledOnce();
  });

  it("disposes after the best-effort leave settles", async () => {
    const leave = vi.fn(() => Promise.reject(new Error("leave failed")));
    const dispose = vi.fn();
    const store = { leave, dispose } satisfies Pick<SpaceClientStore, "leave"> & { readonly dispose: () => void };
    const { unmount } = renderHook(() => useLeaveOnUnmount(store, () => undefined));

    unmount();

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(leave).toHaveBeenCalledOnce();
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });
});
