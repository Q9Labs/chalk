// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "../client-compat";
import { describe, expect, it, vi } from "vitest";

import { act, renderHook, waitFor } from "./test-renderer";
import { useVideoConferenceDiagnostics } from "./use-video-conference-diagnostics";

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

describe("useVideoConferenceDiagnostics", () => {
  it("publishes after the subscribed snapshot changes and cleans up on unmount", async () => {
    const session = createSession({ state: "joining", failure: null, connection: { sync: "connecting", media: "connecting" } });
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useVideoConferenceDiagnostics({ session: session.session, phase: "joining", roomId: "room-1", joinError: null, conferenceView: null, onChange }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ phase: "joining", connectionStatus: "joining", isJoining: true }));
    act(() => session.update({ state: "live", failure: null, connection: { sync: "healthy", media: "healthy" } }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connectionStatus: "live", isConnected: true })));

    const calls = onChange.mock.calls.length;
    unmount();
    act(() => session.update({ state: "left", failure: null, connection: { sync: "stopped", media: "stopped" } }));
    expect(onChange).toHaveBeenCalledTimes(calls);
  });
});
