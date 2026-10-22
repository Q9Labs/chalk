import { afterEach, expect, it, vi } from "vitest";
import type { ReactNativeWebSocket, ReactNativeWebSocketCloseEvent } from "@q9labsai/chalk-client";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { parseParsedAccessGrant } from "../../../client/src/access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../client/src/space-client/core.test.helpers";

const mocks = vi.hoisted(() => ({ platform: vi.fn() }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: vi.fn(), mediaDevices: {} }));
vi.mock("@q9labsai/chalk-client/effect", () => ({ createSpaceClientForPlatform: mocks.platform }));
import { createNativeSpaceClient } from "./create-native-space-client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.platform.mockClear();
});

it.each([
  ["sync", 30_000, undefined],
  ["whiteboard", 30_000, undefined],
  ["sync", 45_000, 45_000],
  ["whiteboard", 45_000, 45_000],
] as const)("native %s preserves its existing %i ms startup allowance for a slow opening", async (kind, allowance, configured) => {
  vi.useFakeTimers();
  const sockets: NativeSocket[] = [];
  class NativeSocket implements ReactNativeWebSocket {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onclose: ((event: ReactNativeWebSocketCloseEvent) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", NativeSocket);
  createNativeSpaceClient({
    space: "test",
    getAccess: async () => {
      throw new Error("unused");
    },
    syncStartupTimeoutMs: configured,
  });
  const platform: SpaceClientPlatform | undefined = mocks.platform.mock.calls[0]?.[1];
  if (!platform?.dependencies) throw new Error("Native platform was not created");
  const token = vi.fn(async () => "test-token");
  const access = parseParsedAccessGrant(opaqueAccessGrant("native-dial"));
  const media = createCoreTestPlatform().dependencies.createMediaClient({ access, credential: token, onFailure: () => undefined, onScreenEnded: () => undefined });
  const sync = kind === "sync" ? platform.dependencies.createSyncClient?.({ access, token, media }) : undefined;
  const board = kind === "whiteboard" ? platform.dependencies.createWhiteboardClient?.({ token, onSummary: () => undefined }) : undefined;
  let startup: Promise<void> | undefined;
  try {
    if (sync) await sync.start();
    if (board) startup = board.startSceneSubscription().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    const first = sockets[0];
    if (!first) throw new Error("Native socket was not created");
    await vi.advanceTimersByTimeAsync(allowance - 1);
    expect(first.close).not.toHaveBeenCalled();
    first.onopen?.({});
    await vi.advanceTimersByTimeAsync(1);
    expect(token).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
  } finally {
    sync?.stop();
    await board?.stopSceneSubscription();
    await startup;
  }
});
