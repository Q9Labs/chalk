// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCallKnocks } from "./useCallKnocks";

const knock = { handle: "request-1", name: "June", requestedAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-21T00:05:00Z", state: "pending" };
afterEach(cleanup);

function mount() {
  return renderHook(({ incoming, terminal }) => useCallKnocks("space", incoming, terminal), { initialProps: { incoming: [knock], terminal: false } });
}

describe("accepted dashboard knocks", () => {
  it("stays hidden across repeated server refreshes while Sync finalisation is delayed, without a second decision", async () => {
    const hook = mount();
    const decision = vi.fn(async () => {});
    await act(async () => {
      await hook.result.current.decide(knock.handle, decision);
    });
    expect(hook.result.current.knocks).toEqual([]);
    for (let poll = 0; poll < 5; poll++) {
      hook.rerender({ incoming: [{ ...knock }], terminal: false });
      expect(hook.result.current.knocks).toEqual([]);
      await act(async () => {
        await hook.result.current.decide(knock.handle, decision);
      });
    }
    expect(decision).toHaveBeenCalledTimes(1);
    hook.rerender({ incoming: [], terminal: false });
    expect(hook.result.current.knocks).toEqual([]);
    hook.rerender({ incoming: [knock], terminal: false });
    expect(hook.result.current.knocks).toEqual([knock]);
  });

  it("does not hide failed decisions and clears accepted handles after a terminal read error", async () => {
    const hook = mount();
    await act(async () => {
      await expect(
        hook.result.current.decide(knock.handle, async () => {
          throw new Error("offline");
        }),
      ).rejects.toThrow("offline");
    });
    expect(hook.result.current.knocks).toEqual([knock]);
    await act(async () => {
      await hook.result.current.decide(knock.handle, async () => {});
    });
    hook.rerender({ incoming: [knock], terminal: true });
    hook.rerender({ incoming: [knock], terminal: false });
    expect(hook.result.current.knocks).toEqual([knock]);
  });

  it("prevents concurrent decisions on the same handle", async () => {
    const hook = mount();
    let finish = () => {};
    const decision = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      const first = hook.result.current.decide(knock.handle, decision);
      await hook.result.current.decide(knock.handle, decision);
      finish();
      await first;
    });
    expect(decision).toHaveBeenCalledTimes(1);
    expect(hook.result.current.knocks).toEqual([]);
  });
});
