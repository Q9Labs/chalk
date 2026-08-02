import { beforeEach, describe, expect, it, vi } from "vitest";

const chalkSession = vi.hoisted(() => vi.fn(function ChalkSession() {}));

vi.mock("@q9labsai/chalk-client", () => ({
  AsyncStorageV3PendingTargetStore: vi.fn(),
  ChalkSession: chalkSession,
  CloudflareSFUClient: vi.fn(),
  createChalkChatFileHttpTransport: vi.fn(),
  createChalkWhiteboardV1Client: vi.fn(),
  createChalkWhiteboardV1FileHttpTransport: vi.fn(),
  createCloudflareSFUHTTPTransport: vi.fn(),
  createReactNativeSyncLifecycle: vi.fn(() => ({})),
  createReactNativeWebSocketFactory: vi.fn(() => ({})),
  createV3SyncClient: vi.fn(),
}));
vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCPeerConnection: vi.fn(),
  mediaDevices: {
    getDisplayMedia: vi.fn(),
    getUserMedia: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(),
    currentState: "active",
  },
}));

import { createChalkSession } from "./create-chalk-session";

describe("createChalkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows multiple native WebSocket attempts before Sync startup expires", () => {
    createChalkSession(options());

    expect(chalkSession).toHaveBeenCalledWith(expect.objectContaining({ syncStartupTimeoutMs: 30_000 }));
  });

  it("preserves an explicit consumer Sync startup budget", () => {
    createChalkSession({ ...options(), syncStartupTimeoutMs: 45_000 });

    expect(chalkSession).toHaveBeenCalledWith(expect.objectContaining({ syncStartupTimeoutMs: 45_000 }));
  });

  it("forwards join spans into the correlated diagnostic timeline", () => {
    const journey = {
      context: { journeyId: "journey", rootJourneyId: "journey", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      headers: {},
      recordDiagnostic: vi.fn(),
      recordRtcSummary: vi.fn(),
      recordSyncFrame: vi.fn(),
    };

    createChalkSession({ ...options(), telemetry: journey });
    const sessionOptions = chalkSession.mock.calls[0]?.[0] as { readonly diagnostics: { readonly onEvent: (event: unknown) => void } };
    sessionOptions.diagnostics.onEvent({
      event: "join_span",
      state: "live",
      epoch: 2,
      step: "start_media",
      spanId: "join-span-2",
      parentSpanId: "join-span-1",
      outcome: "succeeded",
      durationMs: 12,
      code: "media_start_failed",
    });

    expect(journey.recordDiagnostic).toHaveBeenCalledWith({
      category: "session",
      code: "join.start_media.succeeded",
      phase: "media",
      state: "succeeded",
      metricValue: 12,
      attributes: {
        span_id: "join-span-2",
        parent_span_id: "join-span-1",
        step: "start_media",
        outcome: "succeeded",
        epoch: 2,
        failure_code: "media_start_failed",
      },
    });
  });
});

function options() {
  return {
    access: vi.fn(),
    apiBaseURL: "https://api.chalk.test",
    syncURL: "wss://sync.chalk.test/v3/sync",
  };
}
