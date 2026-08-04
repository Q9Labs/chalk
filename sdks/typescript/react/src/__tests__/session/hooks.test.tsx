// @vitest-environment happy-dom

import type { SpaceClientStore, SpaceSnapshotView } from "../../client-compat";
import { act, render, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChalkProvider, useChalkActions, useChalkSelector, useChalkSession, useChalkSnapshot, useLocalMedia, useParticipants, useRemoteMedia } from "../../session";
import { createSpaceClientStore, createSpaceSnapshot } from "../../session/space-client.test.helpers";

type TestSession = {
  readonly store: SpaceClientStore;
  readonly setSnapshot: (snapshot: SpaceSnapshotView) => void;
  readonly activeSubscriptions: () => number;
  readonly subscribeCount: () => number;
  readonly unsubscribeCount: () => number;
};

const createSnapshot = (overrides: Partial<SpaceSnapshotView> = {}): SpaceSnapshotView => createSpaceSnapshot(overrides);

function createSession(initialSnapshot = createSnapshot()): TestSession {
  let snapshot = initialSnapshot;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const listeners = new Set<() => void>();
  const store = createSpaceClientStore(snapshot, {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => {
        unsubscriptions += 1;
        listeners.delete(listener);
      };
    },
  });

  return {
    store,
    setSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
    activeSubscriptions: () => listeners.size,
    subscribeCount: () => subscriptions,
    unsubscribeCount: () => unsubscriptions,
  };
}

function Provider({ children, session }: PropsWithChildren<{ readonly session: SpaceClientStore }>) {
  return <ChalkProvider session={session}>{children}</ChalkProvider>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Chalk React session bindings", () => {
  it("fails clearly when a session hook is used without ChalkProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => renderHook(() => useChalkSession())).toThrowError("Chalk session hooks must be used within a ChalkProvider.");

    consoleError.mockRestore();
  });

  it("unsubscribes from the old session when provider identity changes", () => {
    const first = createSession();
    const second = createSession();
    const { rerender, unmount } = render(
      <Provider session={first.store}>
        <SnapshotProbe />
      </Provider>,
    );

    expect(first.activeSubscriptions()).toBe(1);
    rerender(
      <Provider session={second.store}>
        <SnapshotProbe />
      </Provider>,
    );

    expect(first.activeSubscriptions()).toBe(0);
    expect(second.activeSubscriptions()).toBe(1);
    unmount();
    expect(second.activeSubscriptions()).toBe(0);
  });

  it("balances subscriptions under React strict mode", () => {
    const session = createSession();
    const { unmount } = render(
      <StrictMode>
        <Provider session={session.store}>
          <SnapshotProbe />
        </Provider>
      </StrictMode>,
    );

    expect(session.subscribeCount()).toBeGreaterThan(1);
    expect(session.subscribeCount() - session.unsubscribeCount()).toBe(1);
    unmount();
    expect(session.subscribeCount()).toBe(session.unsubscribeCount());
  });

  it("does not rerender a selector when an unrelated snapshot field changes", () => {
    const participants = [
      {
        participantId: "participant-1",
        displayName: "Ari",
        handRaised: false,
        role: "participant" as const,
        eligibleRoles: ["participant" as const],
        capabilities: [],
        media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
      },
    ];
    const initial = createSnapshot({ participants });
    const session = createSession(initial);
    const renders = vi.fn();
    const { getByText } = render(
      <Provider session={session.store}>
        <ParticipantCount onRender={renders} />
      </Provider>,
    );

    expect(getByText("1")).toBeInTheDocument();
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => {
      session.setSnapshot({
        ...initial,
        connectionStatus: "reconnecting",
      });
    });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("delegates actions once and preserves fulfillment and rejection promises", async () => {
    const session = createSession();
    const leavePromise = Promise.resolve();
    const failure = new Error("command rejected");
    const endPromise = Promise.reject(failure);
    const leave = vi.fn(() => leavePromise);
    const endEpisode = vi.fn(() => endPromise);
    const store = { ...session.store, leave, endEpisode };
    const { result } = renderHook(() => useChalkActions(), {
      wrapper: ({ children }) => <Provider session={store}>{children}</Provider>,
    });

    const returnedLeavePromise = result.current.leave();
    expect(returnedLeavePromise).toBe(leavePromise);
    await returnedLeavePromise;
    expect(leave).toHaveBeenCalledTimes(1);

    const returnedEndPromise = result.current.endEpisode();
    expect(returnedEndPromise).toBe(endPromise);
    await expect(returnedEndPromise).rejects.toBe(failure);
    expect(endEpisode).toHaveBeenCalledTimes(1);
  });

  it("opens no network or peer connection when provider and hooks render", () => {
    const fetchMock = vi.fn();
    const webSocketMock = vi.fn();
    const peerConnectionMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", webSocketMock);
    vi.stubGlobal("RTCPeerConnection", peerConnectionMock);
    const session = createSession();

    render(
      <Provider session={session.store}>
        <AllHooksProbe />
      </Provider>,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSocketMock).not.toHaveBeenCalled();
    expect(peerConnectionMock).not.toHaveBeenCalled();
  });
});

function SnapshotProbe() {
  useChalkSnapshot();
  return null;
}

function ParticipantCount({ onRender }: { readonly onRender: () => void }) {
  onRender();
  return <span>{useParticipants().length}</span>;
}

function AllHooksProbe() {
  useChalkSession();
  useChalkSnapshot();
  useChalkSelector((snapshot) => snapshot.connectionStatus);
  useParticipants();
  useLocalMedia();
  useRemoteMedia();
  useChalkActions();
  return null;
}
