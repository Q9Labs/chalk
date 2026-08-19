import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpaceClientForPlatform = vi.hoisted(() => vi.fn());
const addAppStateListener = vi.hoisted(() => vi.fn());
const createV1SyncClient = vi.hoisted(() => vi.fn());
const createCloudflareSFUHTTPTransport = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("@q9labsai/chalk-client", () => ({
  AsyncStorageV1PendingTargetStore: vi.fn(),
  CloudflareSFUClient: vi.fn(),
  createChalkChatFileHttpTransport: vi.fn(),
  createChalkWhiteboardV1Client: vi.fn(),
  createChalkWhiteboardV1FileHttpTransport: vi.fn(),
  createCloudflareSFUHTTPTransport,
  createReactNativeSyncLifecycle: vi.fn(() => ({})),
  createReactNativeWebSocketFactory: vi.fn(() => ({})),
  createV1SyncClient,
}));
vi.mock("@q9labsai/chalk-client/effect", () => ({ createSpaceClientForPlatform }));
vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCPeerConnection: vi.fn(),
  mediaDevices: {
    getDisplayMedia: vi.fn(),
    getUserMedia: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: addAppStateListener,
    currentState: "active",
  },
}));

import { createNativeSpaceClient } from "./create-native-space-client";

describe("native client creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSpaceClientForPlatform.mockReturnValue(spaceClient());
    addAppStateListener.mockReturnValue({ remove: vi.fn() });
  });

  it("allows multiple native WebSocket attempts before Sync startup expires", () => {
    createNativeSpaceClient(options());

    expect(createSpaceClientForPlatform.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ syncStartupTimeoutMs: 30_000 }));
    expect(createSpaceClientForPlatform.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ feedbackSource: "embedded" }));
  });

  it("preserves an explicit consumer Sync startup budget", () => {
    createNativeSpaceClient({ ...options(), syncStartupTimeoutMs: 45_000 });

    expect(createSpaceClientForPlatform.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ syncStartupTimeoutMs: 45_000 }));
  });

  it("derives the canonical Sync origin from the default API origin", () => {
    createNativeSpaceClient({ ...options(), baseUrl: undefined, syncUrl: undefined });

    expect(createSpaceClientForPlatform.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ apiBaseUrl: "https://api.chalkmeet.com", syncUrl: "wss://sync.chalkmeet.com/v1/sync" }));
  });

  it("passes the closed access callback to the client", () => {
    const getAccess = vi.fn();
    createNativeSpaceClient({ ...options(), getAccess });

    expect(createSpaceClientForPlatform.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ getAccess }));
  });

  it("forwards Space join spans into the correlated diagnostic timeline", () => {
    const journey = {
      context: { journeyId: "journey", rootJourneyId: "journey", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      headers: {},
      recordDiagnostic: vi.fn(),
      recordRtcSummary: vi.fn(),
      recordSyncFrame: vi.fn(),
    };

    createNativeSpaceClient({ ...options(), telemetry: journey });
    const platform = createSpaceClientForPlatform.mock.calls[0]?.[1] as { readonly onConnectionDiagnostic: (event: unknown) => void };
    platform.onConnectionDiagnostic({
      event: "space_join_span",
      state: "live",
      epoch: 2,
      step: "start_media",
      spanId: "space-join-span-2",
      parentSpanId: "space-join-span-1",
      outcome: "succeeded",
      durationMs: 12,
      code: "media_start_failed",
    });

    expect(journey.recordDiagnostic).toHaveBeenCalledWith({
      category: "connection",
      code: "space.join.start_media.succeeded",
      phase: "media",
      state: "succeeded",
      metricValue: 12,
      attributes: {
        span_id: "space-join-span-2",
        parent_span_id: "space-join-span-1",
        step: "start_media",
        outcome: "succeeded",
        epoch: 2,
        failure_code: "media_start_failed",
      },
    });
  });

  it("passes telemetry context into the production Sync constructor", () => {
    const journey = {
      context: {
        journeyId: "journey",
        rootJourneyId: "journey",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        tracestate: "chalk=native",
      },
      headers: {},
      recordDiagnostic: vi.fn(),
      recordRtcSummary: vi.fn(),
      recordSyncFrame: vi.fn(),
    };

    createNativeSpaceClient({ ...options(), telemetry: journey });
    const platform = createSpaceClientForPlatform.mock.calls[0]?.[1] as {
      readonly telemetry: typeof journey.context;
      readonly dependencies: { readonly createSyncClient: (input: unknown) => unknown };
    };
    expect(platform.telemetry).toEqual(journey.context);
    platform.dependencies.createSyncClient({
      access: { subject: { tenantId: "tenant", episodeId: "episode", participantId: "participant" } },
      token: async () => "token",
      media: {},
      telemetry: platform.telemetry,
    });

    expect(createV1SyncClient).toHaveBeenCalledWith(expect.objectContaining({ telemetry: journey.context }));
  });

  it("revalidates access when the app returns to the foreground", () => {
    createNativeSpaceClient(options());
    const platform = createSpaceClientForPlatform.mock.calls[0]?.[1] as {
      readonly dependencies: { readonly subscribeForeground: (listener: () => void) => () => void };
    };

    const refresh = vi.fn();
    const unsubscribe = platform.dependencies.subscribeForeground(refresh);
    const stateListener = addAppStateListener.mock.calls[0]?.[1] as (state: string) => void;

    stateListener("background");
    expect(refresh).not.toHaveBeenCalled();
    stateListener("active");
    expect(refresh).toHaveBeenCalledOnce();

    unsubscribe();
    expect(addAppStateListener.mock.results[0]?.value.remove).toHaveBeenCalledOnce();
  });

  it("bridges verified media credentials to telemetry and clears them at terminal teardown", async () => {
    const client = spaceClient();
    createSpaceClientForPlatform.mockReturnValue(client);
    const setAuthenticatedTelemetryHeaders = vi.fn();
    const journey = {
      context: { journeyId: "journey", rootJourneyId: "journey", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      headers: { "x-chalk-journey-id": "journey" },
      recordDiagnostic: vi.fn(),
      recordRtcSummary: vi.fn(),
      recordSyncFrame: vi.fn(),
      setAuthenticatedTelemetryHeaders,
    };
    createNativeSpaceClient({ ...options(), telemetry: journey });
    const platform = createSpaceClientForPlatform.mock.calls[0]?.[1] as {
      readonly dependencies: { readonly createMediaClient: (input: unknown) => unknown };
    };
    const credential = vi.fn().mockResolvedValueOnce("media-one").mockResolvedValueOnce("media-two").mockResolvedValueOnce("media-three");
    platform.dependencies.createMediaClient({
      access: { subject: { tenantId: "tenant", episodeId: "episode", participantId: "participant" }, media: { clientPayload: {} } },
      credential,
      onFailure: vi.fn(),
      onScreenEnded: vi.fn(),
    });

    const transport = createCloudflareSFUHTTPTransport.mock.calls.at(-1)?.[0] as { readonly credential: () => Promise<string> };
    await expect(transport.credential()).resolves.toBe("media-one");
    await expect(transport.credential()).resolves.toBe("media-two");
    expect(setAuthenticatedTelemetryHeaders).toHaveBeenNthCalledWith(1, { Authorization: "Bearer media-one" });
    expect(setAuthenticatedTelemetryHeaders).toHaveBeenNthCalledWith(2, { Authorization: "Bearer media-two" });
    expect(journey.recordDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.stringContaining("media-") }));
    expect(JSON.stringify(journey.recordDiagnostic.mock.calls)).not.toContain("media-one");

    client.setStatus("left");
    expect(setAuthenticatedTelemetryHeaders).toHaveBeenLastCalledWith(undefined);
    await expect(transport.credential()).resolves.toBe("media-three");
    client.dispose();
    expect(setAuthenticatedTelemetryHeaders).toHaveBeenLastCalledWith(undefined);
    expect(credential).toHaveBeenCalledTimes(3);
  });
});

function options() {
  return {
    space: "native-space",
    getAccess: vi.fn(),
    baseUrl: "https://api.chalk.test",
    syncUrl: "wss://sync.chalk.test/v1/sync",
  };
}

function spaceClient() {
  const snapshot = {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities: [], handRaised: false, can: () => false },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: { microphones: [], cameras: [], speakers: [] },
      selection: { microphone: null, camera: null, speaker: null },
      local: {
        microphone: { source: "microphone", state: "unavailable", track: null },
        camera: { source: "camera", state: "unavailable", track: null },
        screen: { source: "screen", state: "unavailable", track: null },
      },
      remote: [],
      screenShare: { source: "screen", state: "unavailable", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, error: null } },
  } as const;
  let currentSnapshot = snapshot;
  const listeners = new Set<() => void>();
  return {
    media: {},
    chat: { files: {} },
    participants: {},
    reactions: {},
    whiteboard: { transport: () => null },
    getSnapshot: () => currentSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStatus: (status: "idle" | "failed" | "left") => {
      currentSnapshot = { ...currentSnapshot, connection: { ...currentSnapshot.connection, status } };
      listeners.forEach((listener) => listener());
    },
    dispose: vi.fn(),
  };
}
