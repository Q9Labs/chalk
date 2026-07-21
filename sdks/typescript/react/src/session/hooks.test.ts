// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChalkProvider } from "./context";
import { useChalkActions, useChalkSelector } from "./hooks";

const participants = [
  {
    participantSessionId: "participant-1",
    displayName: "Ari",
    handRaised: false,
    role: "participant" as const,
    eligibleRoles: ["participant" as const],
    capabilities: [],
  },
];

function createSnapshot(connection: ChalkSessionSnapshot["connection"]): ChalkSessionSnapshot {
  return {
    state: "live",
    subject: null,
    connection,
    admissionPolicy: "open",
    participants,
    admissionRequests: [],
    localMedia: {
      microphone: { source: "microphone", state: "disabled", track: null },
      camera: { source: "camera", state: "disabled", track: null },
      screen: { source: "screen", state: "disabled", track: null },
    },
    remoteMedia: [],
    failure: null,
  };
}

function createSession(leave: () => Promise<void>) {
  let snapshot = createSnapshot({ sync: "healthy", media: "healthy" });
  const listeners = new Set<() => void>();
  const resolved = () => Promise.resolve();
  const store: ChalkSessionStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    join: resolved,
    leave,
    setMicrophoneEnabled: resolved,
    setCameraEnabled: resolved,
    startScreenShare: resolved,
    stopScreenShare: resolved,
    setHandRaised: resolved,
    setDisplayName: resolved,
    setAdmissionPolicy: resolved,
    setParticipantRole: resolved,
    transferHost: resolved,
    admitParticipant: resolved,
    denyAdmission: resolved,
    muteParticipant: resolved,
    stopParticipantCamera: resolved,
    stopParticipantScreenShare: resolved,
    removeParticipant: resolved,
    endSession: resolved,
  };

  return {
    store,
    updateConnection: (connection: ChalkSessionSnapshot["connection"]) => {
      snapshot = createSnapshot(connection);
      for (const listener of listeners) listener();
    },
  };
}

function createWrapper(session: ChalkSessionStore) {
  return ({ children }: PropsWithChildren) => createElement(ChalkProvider, { session }, children);
}

describe("Chalk session hooks", () => {
  it("preserves a selected reference across unrelated snapshot updates", () => {
    const session = createSession(() => Promise.resolve());
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useChalkSelector((snapshot) => snapshot.participants);
      },
      { wrapper: createWrapper(session.store) },
    );
    const selected = result.current;

    act(() => session.updateConnection({ sync: "recovering", media: "healthy" }));

    expect(result.current).toBe(selected);
    expect(renders).toBe(1);
  });

  it("delegates an action once and returns the store's original promise", async () => {
    const promise = Promise.resolve();
    const leave = vi.fn(() => promise);
    const session = createSession(leave);
    const { result } = renderHook(() => useChalkActions(), { wrapper: createWrapper(session.store) });

    const returned = result.current.leave();

    expect(returned).toBe(promise);
    await returned;
    expect(leave).toHaveBeenCalledOnce();
  });
});
