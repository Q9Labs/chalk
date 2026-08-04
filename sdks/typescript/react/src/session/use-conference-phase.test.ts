// @vitest-environment happy-dom

import type { SpaceClientStore, SpaceSnapshotView } from "../client-compat";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useConferencePhase } from "./use-conference-phase";
import { createSpaceSnapshot } from "./space-client.test.helpers";

describe("useConferencePhase", () => {
  it("derives the observable lifecycle phase from the session snapshot", () => {
    const session = createSession();
    const { result } = renderHook(() => useConferencePhase(session.store, { hasAskedToJoin: false, hasAskedToLeave: false }));

    expect(result.current).toBe("prejoin");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), connectionStatus: "joining" });
    });
    expect(result.current).toBe("joining");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), connectionStatus: "live" });
    });
    expect(result.current).toBe("active");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), connectionStatus: "reconnecting" });
    });
    expect(result.current).toBe("reconnecting");
  });

  it("honors leave intent and initial phase before a session exists", () => {
    const { result, rerender } = renderHook(({ initialPhase, hasAskedToLeave }) => useConferencePhase(null, { hasAskedToJoin: false, hasAskedToLeave }, initialPhase), {
      initialProps: { initialPhase: "waiting" as const, hasAskedToLeave: false },
    });

    expect(result.current).toBe("waiting");
    rerender({ initialPhase: "waiting", hasAskedToLeave: true });
    expect(result.current).toBe("ended");
  });
});

function createSession() {
  let snapshot = createSnapshot();
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies Pick<SpaceClientStore, "getSnapshot" | "subscribe">;

  return {
    store,
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot: SpaceSnapshotView) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  };
}

const createSnapshot = (): SpaceSnapshotView => createSpaceSnapshot();
