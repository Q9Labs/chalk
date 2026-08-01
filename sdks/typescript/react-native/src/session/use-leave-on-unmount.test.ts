// @vitest-environment happy-dom

import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

import { renderHook } from "./test-renderer";
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
});
