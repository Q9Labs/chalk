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
});

function options() {
  return {
    access: vi.fn(),
    apiBaseURL: "https://api.chalk.test",
    syncURL: "wss://sync.chalk.test/v3/sync",
  };
}
