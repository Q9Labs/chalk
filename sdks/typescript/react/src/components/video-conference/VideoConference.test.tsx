// @vitest-environment happy-dom

import type { ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../pre-join-screen/PreJoinScreen", () => ({
  PreJoinScreen: ({ onJoin }: { readonly onJoin: (settings: { readonly displayName: string; readonly microphoneEnabled: boolean; readonly cameraEnabled: boolean }) => void }) => (
    <button type="button" onClick={() => onJoin({ displayName: "Ada", microphoneEnabled: true, cameraEnabled: true })}>
      Join conference
    </button>
  ),
}));

vi.mock("../joining-screen/JoiningScreen", () => ({
  JoiningScreen: ({ message }: { readonly message?: string }) => <div role="status">{message ?? "Joining"}</div>,
}));

vi.mock("../full/EndScreen", () => ({
  EndScreen: ({ onRejoin }: { readonly onRejoin?: () => void }) => (
    <div data-testid="end-screen">
      Meeting ended
      <button type="button" onClick={onRejoin}>
        Rejoin conference
      </button>
    </div>
  ),
}));

vi.mock("../conference-view/ConferenceView", () => ({
  ConferenceView: ({ reconnecting, onLeave }: { readonly reconnecting?: { readonly isVisible: boolean }; readonly onLeave?: () => void | Promise<void> }) => (
    <div data-testid="conference-view">
      Active conference
      {reconnecting?.isVisible ? <div data-testid="reconnecting-overlay">Reconnecting</div> : null}
      <button type="button" onClick={() => void onLeave?.()}>
        Leave active conference
      </button>
    </div>
  ),
}));

import { VideoConference } from "./VideoConference";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("VideoConference", () => {
  it("renders the lifecycle from prejoin through joining, active, reconnecting, and ended", async () => {
    const testSession = createTestSession();
    const joinGate = deferred<void>();
    const createSession = vi.fn(() => {
      testSession.setJoin(
        vi.fn(() => {
          testSession.setSnapshot({
            ...testSession.getSnapshot(),
            state: "joining",
            connection: { sync: "connecting", media: "connecting" },
          });
          return joinGate.promise.then(() => {
            testSession.setSnapshot({
              ...testSession.getSnapshot(),
              state: "live",
              connection: { sync: "healthy", media: "healthy" },
            });
          });
        }),
      );
      return testSession;
    });
    const onPhaseChange = vi.fn();

    render(<VideoConference roomId="room-1" roomName="Design review" userName="Ada" createSession={createSession} onPhaseChange={onPhaseChange} />);

    expect(screen.getByRole("button", { name: "Join conference" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join conference" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Joining Design review"));
    expect(createSession).toHaveBeenCalledWith({ displayName: "Ada", microphoneEnabled: true, cameraEnabled: true });

    await actResolve(joinGate);
    await waitFor(() => expect(screen.getByTestId("conference-view")).toBeInTheDocument());

    testSession.setSnapshot({
      ...testSession.getSnapshot(),
      connection: { sync: "recovering", media: "healthy" },
    });
    await waitFor(() => expect(screen.getByTestId("reconnecting-overlay")).toBeInTheDocument());
    expect(screen.getByTestId("conference-view")).toBeInTheDocument();

    testSession.setLeave(
      vi.fn(async () => {
        testSession.setSnapshot({ ...testSession.getSnapshot(), state: "left", connection: { sync: "stopped", media: "stopped" } });
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave active conference" }));
    await waitFor(() => expect(screen.getByTestId("end-screen")).toBeInTheDocument());

    expect(onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual(expect.arrayContaining(["prejoin", "joining", "active", "reconnecting", "ended"]));
  });

  it("does not invent a joiner waiting screen when the session runtime has no admission-wait signal", () => {
    render(<VideoConference roomId="room-1" phase="waiting" userName="Ada" createSession={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Joining room-1");
    expect(screen.queryByTestId("waiting-screen")).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function actResolve<T>(gate: { readonly resolve: (value: T | PromiseLike<T>) => void }): Promise<void> {
  gate.resolve(undefined as T);
  await Promise.resolve();
}

function createTestSession(): ChalkSessionStore & {
  getSnapshot: () => ChalkSessionSnapshot;
  setSnapshot: (snapshot: ChalkSessionSnapshot) => void;
  setJoin: (join: ChalkSessionStore["join"]) => void;
  setLeave: (leave: ChalkSessionStore["leave"]) => void;
} {
  let snapshot = createSnapshot();
  let join = async () => undefined;
  let leave = async () => undefined;
  const listeners = new Set<() => void>();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSnapshot: (nextSnapshot: ChalkSessionSnapshot) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
    setJoin: (nextJoin: ChalkSessionStore["join"]) => {
      join = nextJoin;
    },
    setLeave: (nextLeave: ChalkSessionStore["leave"]) => {
      leave = nextLeave;
    },
    join: (...args: Parameters<ChalkSessionStore["join"]>) => join(...args),
    leave: (...args: Parameters<ChalkSessionStore["leave"]>) => leave(...args),
    setMicrophoneEnabled: async () => undefined,
    setCameraEnabled: async () => undefined,
    startScreenShare: async () => undefined,
    stopScreenShare: async () => undefined,
    setHandRaised: async () => undefined,
    setDisplayName: async () => undefined,
    setAdmissionPolicy: async () => undefined,
    setParticipantRole: async () => undefined,
    transferHost: async () => undefined,
    admitParticipant: async () => undefined,
    denyAdmission: async () => undefined,
    muteParticipant: async () => undefined,
    stopParticipantCamera: async () => undefined,
    stopParticipantScreenShare: async () => undefined,
    removeParticipant: async () => undefined,
    endSession: async () => undefined,
    sendReaction: async () => ({}) as never,
    sendChatMessage: async () => ({}) as never,
    retryChatMessage: async () => ({}) as never,
    loadOlderChatMessages: async () => ({}) as never,
    markChatRead: async () => null,
    requestUnmute: async () => ({}) as never,
    requestStartCamera: async () => ({}) as never,
    acceptMediaRequest: async () => undefined,
    declineMediaRequest: () => undefined,
    chatFiles: null,
    whiteboard: null,
  } as unknown as ChalkSessionStore & {
    getSnapshot: () => ChalkSessionSnapshot;
    setSnapshot: (snapshot: ChalkSessionSnapshot) => void;
    setJoin: (join: ChalkSessionStore["join"]) => void;
    setLeave: (leave: ChalkSessionStore["leave"]) => void;
  };
  return session;
}

function createSnapshot(overrides: Partial<ChalkSessionSnapshot> = {}): ChalkSessionSnapshot {
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
    ...overrides,
  };
}
