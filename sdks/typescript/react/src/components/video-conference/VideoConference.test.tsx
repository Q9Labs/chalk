// @vitest-environment happy-dom

import type { SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { SpaceClientStore, SpaceSnapshotView } from "../../client-compat";
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
  }: {
    readonly reconnecting?: { readonly isVisible: boolean };
    readonly onLeave?: () => void | Promise<void>;
    readonly layout?: string;
    readonly panels?: { readonly active: string | null; readonly onChange: (panel: string | null) => void };
    readonly controls?: { readonly buttons?: readonly string[] };
    readonly settingsDialog?: {
      readonly onOpenChange: (open: boolean) => void;
      readonly onUpdateIdentity: (updates: { readonly displayName: string }) => void;
    };
  }) => (
    <div data-testid="conference-view" data-layout={layout} data-active-panel={panels?.active ?? ""} data-buttons={controls?.buttons?.join(",")}>
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
    </div>
  ),
}));

import { VideoConference } from "./VideoConference";
import { createSpaceClientStore, createSpaceSnapshot } from "../../session/space-client.test.helpers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const canonicalProps = { roomId: "space-1", userName: "Ada" } as const;

describe("VideoConference", () => {
  it("renders the lifecycle from prejoin through joining, active, reconnecting, and ended", async () => {
    const testSession = createTestSession();
    const joinGate = deferred<void>();
    const createSession = vi.fn(() => {
      testSession.setJoin(
        vi.fn(() => {
          testSession.setSnapshot({
            ...testSession.getSnapshot(),
            connectionStatus: "joining",
          });
          return joinGate.promise.then(() => {
            testSession.setSnapshot({
              ...testSession.getSnapshot(),
              connectionStatus: "live",
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
      connectionStatus: "reconnecting",
    });
    await waitFor(() => expect(screen.getByTestId("reconnecting-overlay")).toBeInTheDocument());
    expect(screen.getByTestId("conference-view")).toBeInTheDocument();

    testSession.setLeave(
      vi.fn(async () => {
        testSession.setSnapshot({ ...testSession.getSnapshot(), connectionStatus: "left" });
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave active conference" }));
    await waitFor(() => expect(screen.getByTestId("end-screen")).toBeInTheDocument());

    expect(onPhaseChange.mock.calls.map(([phase]) => phase)).toEqual(expect.arrayContaining(["prejoin", "joining", "active", "reconnecting", "ended"]));
  });

  it("adapts a canonical SpaceClient returned by createSession", async () => {
    const client = createCanonicalSpaceClient();
    const onSessionChange = vi.fn();

    render(<VideoConference {...canonicalProps} createSession={() => client} onSessionChange={onSessionChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Join conference" }));

    await waitFor(() => expect(onSessionChange).toHaveBeenCalledWith(expect.any(Object)));
    const adapted = onSessionChange.mock.calls[0]?.[0] as SpaceClientStore;

    expect(adapted).not.toBe(client);
    expect(adapted.getSnapshot()).toMatchObject({ connectionStatus: "idle", self: null });
  });

  it("disposes a canonical client whose creation completes after unmount", async () => {
    const clientCreation = deferred<SpaceClient>();
    const leave = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const client = createCanonicalSpaceClient({ leave, dispose });
    const { unmount } = render(<VideoConference {...canonicalProps} createSession={() => clientCreation.promise} />);

    fireEvent.click(screen.getByRole("button", { name: "Join conference" }));
    unmount();
    clientCreation.resolve(client);

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(leave).toHaveBeenCalledOnce();
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
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
      admissionRequests: [{ requestId: "request-1", participantId: "guest-1", displayName: "Nia", initialRole: "participant", eligibleRoles: ["participant"], expiresAt: "2026-08-02T00:00:00.000Z" }],
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
    Object.assign(testSession, { setDisplayName });

    render(<VideoConference roomId="room-1" userName="Ada" autoJoin createSession={() => testSession} />);
    await waitFor(() => expect(screen.getByTestId("conference-view")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Update display name" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(setDisplayName).toHaveBeenCalledWith("Grace"));
  });
});

function createLiveTestSession() {
  const testSession = createTestSession();
  testSession.setSnapshot({ ...testSession.getSnapshot(), connectionStatus: "live" });
  return testSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function actResolve(gate: { readonly resolve: () => void }): Promise<void> {
  gate.resolve();
  await Promise.resolve();
}

type TestSpaceClientStore = SpaceClientStore & {
  readonly setSnapshot: (snapshot: SpaceSnapshotView) => void;
  readonly setJoin: (join: SpaceClientStore["join"]) => void;
  readonly setLeave: (leave: SpaceClientStore["leave"]) => void;
};

function createTestSession(): TestSpaceClientStore {
  let snapshot = createSnapshot();
  let join: SpaceClientStore["join"] = async () => undefined;
  let leave: SpaceClientStore["leave"] = async () => undefined;
  const listeners = new Set<() => void>();
  const store = createSpaceClientStore(snapshot, {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    join: (...args) => join(...args),
    leave: () => leave(),
  });
  return Object.assign(store, {
    setSnapshot: (nextSnapshot: SpaceSnapshotView) => {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
    setJoin: (nextJoin: SpaceClientStore["join"]) => {
      join = nextJoin;
    },
    setLeave: (nextLeave: SpaceClientStore["leave"]) => {
      leave = nextLeave;
    },
  });
}

const createSnapshot = (overrides: Partial<SpaceSnapshotView> = {}): SpaceSnapshotView => createSpaceSnapshot(overrides);

function createCanonicalSpaceClient({ leave = async () => undefined, dispose = () => undefined }: Pick<SpaceClient, "leave" | "dispose"> = {}): SpaceClient {
  const snapshot: SpaceSnapshot = {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities: [], handRaised: false, can: () => false },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: {
        microphone: { source: "microphone", state: "disabled", track: null },
        camera: { source: "camera", state: "disabled", track: null },
        screen: { source: "screen", state: "disabled", track: null },
      },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: {
      status: "idle",
      messages: [],
      pendingSends: [],
      readReceipts: [],
      unreadCount: 0,
      pagination: { cursor: null, hasOlder: false, historyTruncated: false },
      lastError: null,
    },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  };
  return {
    media: {},
    chat: { files: { upload: unavailable, url: () => "" } },
    whiteboard: { transport: () => null },
    join: async () => undefined,
    leave,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    dispose,
  } as unknown as SpaceClient;
}

async function unavailable(): Promise<never> {
  throw new Error("This command is not configured for the test");
}
