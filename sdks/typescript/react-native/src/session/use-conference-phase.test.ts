// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "../client-compat";
import { describe, expect, it } from "vitest";

import { act, renderHook } from "./test-renderer";
import { useConferencePhase } from "./use-conference-phase";

type ConferenceSnapshot = Pick<ChalkSessionSnapshot, "state" | "failure" | "connection">;

function createSession(snapshot: ConferenceSnapshot) {
  let current = snapshot;
  const listeners = new Set<() => void>();
  const session = {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies Pick<ChalkSessionStore, "getSnapshot" | "subscribe">;

  return {
    session,
    update(next: ConferenceSnapshot) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("useConferencePhase", () => {
  it("derives transitions from the subscribed snapshot and local intent", () => {
    const session = createSession({ state: "idle", failure: null, connection: { sync: "idle", media: "idle" } });
    const { result, unmount } = renderHook(() => useConferencePhase(session.session, { hasAskedToJoin: false, hasAskedToLeave: false }));

    expect(result.current).toBe("prejoin");
    act(() => session.update({ state: "joining", failure: null, connection: { sync: "connecting", media: "connecting" } }));
    expect(result.current).toBe("joining");
    act(() => session.update({ state: "live", failure: null, connection: { sync: "healthy", media: "healthy" } }));
    expect(result.current).toBe("active");
    act(() => session.update({ state: "reconnecting", failure: null, connection: { sync: "recovering", media: "healthy" } }));
    expect(result.current).toBe("reconnecting");

    unmount();
  });

  it("keeps the initial phase hint until a session exists", () => {
    const { result, rerender, unmount } = renderHook(({ initialPhase }) => useConferencePhase(null, { hasAskedToJoin: false, hasAskedToLeave: false }, initialPhase), { initialProps: { initialPhase: "meeting" as const } });

    expect(result.current).toBe("active");
    rerender({ initialPhase: "end" });
    expect(result.current).toBe("ended");
    unmount();
  });
});
