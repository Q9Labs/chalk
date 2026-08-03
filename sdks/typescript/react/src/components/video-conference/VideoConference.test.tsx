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
  ConferenceView: ({
    reconnecting,
    onLeave,
    layout,
    panels,
    controls,
    settingsDialog,
    palette,
    texture,
  }: {
    readonly reconnecting?: { readonly isVisible: boolean };
    readonly onLeave?: () => void | Promise<void>;
    readonly layout?: string;
    readonly panels?: { readonly active: string | null; readonly onChange: (panel: string | null) => void };
    readonly controls?: { readonly buttons?: readonly string[] };
    readonly palette?: string;
    readonly texture?: string;
    readonly settingsDialog?: {
      readonly onOpenChange: (open: boolean) => void;
      readonly onUpdateIdentity: (updates: { readonly displayName: string }) => void;
      readonly onUpdateAppearance: (updates: { readonly palette: "warm-porcelain"; readonly theme: "light" }) => void;
    };
  }) => (
    <div data-testid="conference-view" data-layout={layout} data-active-panel={panels?.active ?? ""} data-buttons={controls?.buttons?.join(",")} data-palette={palette} data-texture={texture}>
      Active conference
      {reconnecting?.isVisible ? <div data-testid="reconnecting-overlay">Reconnecting</div> : null}
      <button type="button" onClick={() => void onLeave?.()}>
        Leave active conference
      </button>
      <button type="button" onClick={() => panels?.onChange(null)}>
        Close panel
      </button>
      <button type="button" onClick={() => settingsDialog?.onUpdateIdentity({ displayName: "Grace" })}>
        Update display name
      </button>
      <button type="button" onClick={() => settingsDialog?.onOpenChange(false)}>
        Close settings
      </button>
      <button type="button" onClick={() => settingsDialog?.onUpdateAppearance({ palette: "warm-porcelain", theme: "light" })}>
        Use warm porcelain
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

  it("switches the stage to presentation while screen sharing is active", async () => {
    const testSession = createLiveTestSession();

    render(<VideoConference roomId="room-1" userName="Ada" autoJoin createSession={() => testSession} />);
    await waitFor(() => expect(screen.getByTestId("conference-view")).toHaveAttribute("data-layout", "focus"));

    testSession.setSnapshot({
      ...testSession.getSnapshot(),
      localMedia: { ...testSession.getSnapshot().localMedia, screen: { source: "screen", state: "enabled", track: null } },
    });
    await waitFor(() => expect(screen.getByTestId("conference-view")).toHaveAttribute("data-layout", "presentation"));
  });

  it("opens the admission panel for hosts when requests arrive and honors dismissal", async () => {
    const testSession = createLiveTestSession();

    render(<VideoConference roomId="room-1" userName="Ada" autoJoin canAdmit createSession={() => testSession} />);
    await waitFor(() => expect(screen.getByTestId("conference-view")).toHaveAttribute("data-active-panel", ""));

    testSession.setSnapshot({
      ...testSession.getSnapshot(),
      admissionRequests: [{ admissionRequestId: "request-1", participantSessionId: "guest-1", displayName: "Nia", initialRole: "participant", eligibleRoles: ["participant"], expiresAt: "2026-08-02T00:00:00.000Z" }],
    });
    await waitFor(() => expect(screen.getByTestId("conference-view")).toHaveAttribute("data-active-panel", "admission"));

    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    await waitFor(() => expect(screen.getByTestId("conference-view")).toHaveAttribute("data-active-panel", ""));
  });

  it("omits the participants and settings controls when those features are disabled", async () => {
    render(<VideoConference roomId="room-1" userName="Ada" autoJoin participantsEnabled={false} settingsEnabled={false} createSession={() => createLiveTestSession()} />);

    await waitFor(() => expect(screen.getByTestId("conference-view")).toBeInTheDocument());
    const buttons = screen.getByTestId("conference-view").getAttribute("data-buttons") ?? "";
    expect(buttons).not.toContain("participants");
    expect(buttons).not.toContain("more");
    expect(buttons).toContain("mic");
  });

  it("applies the display name from settings when the dialog closes", async () => {
    const testSession = createLiveTestSession();
    const setDisplayName = vi.fn(async () => undefined);
    const onAppearanceChange = vi.fn();
    Object.assign(testSession, { setDisplayName });

    render(<VideoConference roomId="room-1" userName="Ada" autoJoin initialPalette="cool-graphite" initialTexture="slate" onAppearanceChange={onAppearanceChange} createSession={() => testSession} />);
    const activeSurface = await screen.findByTestId("conference-view");
    expect(activeSurface).toHaveAttribute("data-palette", "cool-graphite");
    expect(activeSurface).toHaveAttribute("data-texture", "slate");

    fireEvent.click(screen.getByRole("button", { name: "Update display name" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(setDisplayName).toHaveBeenCalledWith("Grace"));

    fireEvent.click(screen.getByRole("button", { name: "Use warm porcelain" }));

    await waitFor(() => expect(activeSurface).toHaveAttribute("data-palette", "warm-porcelain"));
    expect(onAppearanceChange).toHaveBeenCalledWith({ palette: "warm-porcelain", texture: "slate" });
  });
});

function createLiveTestSession() {
  const testSession = createTestSession();
  testSession.setSnapshot({ ...testSession.getSnapshot(), state: "live", connection: { sync: "healthy", media: "healthy" } });
  return testSession;
}

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
