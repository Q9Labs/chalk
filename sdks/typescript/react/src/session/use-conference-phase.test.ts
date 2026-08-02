// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useConferencePhase } from "./use-conference-phase";

describe("useConferencePhase", () => {
  it("derives the observable lifecycle phase from the session snapshot", () => {
    const session = createSession();
    const { result } = renderHook(() => useConferencePhase(session.store, { hasAskedToJoin: false, hasAskedToLeave: false }));

    expect(result.current).toBe("prejoin");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), state: "joining" });
    });
    expect(result.current).toBe("joining");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), state: "live", connection: { sync: "healthy", media: "healthy" } });
    });
    expect(result.current).toBe("active");

    act(() => {
      session.setSnapshot({ ...session.getSnapshot(), connection: { sync: "recovering", media: "healthy" } });
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
  } satisfies Pick<ChalkSessionStore, "getSnapshot" | "subscribe">;

  return {
    store,
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot: ChalkSessionSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  };
}

function createSnapshot(): ChalkSessionSnapshot {
  return {
    state: "idle",
    subject: null,
    connection: { sync: "idle", media: "idle" },
    admissionPolicy: null,
    participants: [],
    admissionRequests: [],
    localMedia: {
      microphone: { source: "microphone", state: "unavailable", track: null },
      camera: { source: "camera", state: "unavailable", track: null },
      screen: { source: "screen", state: "unavailable", track: null },
    },
    remoteMedia: [],
    failure: null,
    roomActions: { phase: "disabled", version: null, capabilities: [], error: null },
    participantRoomActionCapabilities: {},
    participantMedia: {},
    reactions: [],
    chat: {
      status: "idle",
      messages: [],
      pending: [],
      hasOlder: false,
      historyTruncated: false,
      retainedFloorSequence: null,
      unreadCount: 0,
      readReceipts: [],
      localReadThroughSequence: null,
      error: null,
    },
    whiteboard: { status: "unsubscribed", sceneId: null, revision: null, capabilities: [], canDraw: false, canClear: false, error: null },
    incomingMediaRequests: [],
  };
}
