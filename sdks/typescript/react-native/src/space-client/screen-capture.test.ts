import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ platform: vi.fn(), display: vi.fn(), start: vi.fn(), os: { OS: "ios" } }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  NativeModules: { ChalkScreenCapture: { start: mocks.start } },
  Platform: mocks.os,
}));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: vi.fn(), mediaDevices: { getDisplayMedia: mocks.display } }));
vi.mock("@q9labsai/chalk-client/effect", () => ({ createSpaceClientForPlatform: mocks.platform }));
import { createNativeSpaceClient } from "./create-native-space-client";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.os.OS = "ios";
});

function capture() {
  createNativeSpaceClient({
    space: "test",
    getAccess: async () => {
      throw new Error("unused");
    },
  });
  const platform: SpaceClientPlatform | undefined = mocks.platform.mock.calls[0]?.[1];
  const display = platform?.dependencies?.mediaDevices?.getDisplayMedia;
  if (!display) throw new Error("The native adapter must supply screen capture.");
  return display({ video: true });
}

function preparedScreen() {
  const track = {
    id: "screen",
    readyState: "live",
    stop: () => {
      track.readyState = "ended";
    },
  };
  const stream = {
    released: false,
    getVideoTracks: () => [track],
    getTracks: () => [track],
    release: () => {
      stream.released = true;
    },
  };
  mocks.display.mockResolvedValue(stream);
  return { stream, track };
}

it("does not hand a screen to the publisher before ReplayKit sends its first frame", async () => {
  const { stream } = preparedScreen();
  const firstFrame = Promise.withResolvers<void>();
  mocks.start.mockReturnValue(firstFrame.promise);
  const screen = capture();
  let ready = false;
  void screen.then(() => {
    ready = true;
  });
  await setImmediate();
  expect(ready).toBe(false);
  firstFrame.resolve();
  await expect(screen).resolves.toBe(stream);
});

it("rejects a cancelled broadcast and stops and releases its prepared screen", async () => {
  const { stream, track } = preparedScreen();
  const firstFrame = Promise.withResolvers<void>();
  void firstFrame.promise.catch(() => undefined);
  mocks.start.mockReturnValue(firstFrame.promise);
  const screen = capture();
  await setImmediate();
  const cancelled = new Error("Broadcast cancelled");
  firstFrame.reject(cancelled);
  await expect(screen).rejects.toBe(cancelled);
  expect(track.readyState).toBe("ended");
  expect(stream.released).toBe(true);
});

it("returns Android's consented capture without opening ReplayKit", async () => {
  mocks.os.OS = "android";
  const { stream } = preparedScreen();
  await expect(capture()).resolves.toBe(stream);
  expect(mocks.start).not.toHaveBeenCalled();
});
