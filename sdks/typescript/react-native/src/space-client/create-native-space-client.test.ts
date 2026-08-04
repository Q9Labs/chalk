import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpaceClientForPlatform = vi.hoisted(() => vi.fn());
const addAppStateListener = vi.hoisted(() => vi.fn());
const createV1SyncClient = vi.hoisted(() => vi.fn());

vi.mock("@q9labsai/chalk-client", () => ({
  AsyncStorageV1PendingTargetStore: vi.fn(),
  CloudflareSFUClient: vi.fn(),
  createChalkChatFileHttpTransport: vi.fn(),
  createChalkWhiteboardV1Client: vi.fn(),
  createChalkWhiteboardV1FileHttpTransport: vi.fn(),
  createCloudflareSFUHTTPTransport: vi.fn(),
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
  });

  it("preserves an explicit consumer Sync startup budget", () => {
    createNativeSpaceClient({ ...options(), syncStartupTimeoutMs: 45_000 });

    expect(createSpaceClientForPlatform.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ syncStartupTimeoutMs: 45_000 }));
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
  return {
    media: {},
    chat: { files: {} },
    participants: {},
    reactions: {},
    whiteboard: { transport: () => null },
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  };
}
