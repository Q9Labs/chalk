import { afterEach, expect, it, vi } from "vitest";
import { NATIVE_SESSION_BACKGROUND_MS } from "./native-session";

const appState = vi.hoisted(() => ({ listeners: [] as ((state: string) => void)[] }));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn((_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: vi.fn(), mediaDevices: {} }));
import { createNativeSpaceClient, installNativeSession } from "./create-native-space-client";

afterEach(() => {
  vi.useRealTimers();
});

function backgroundFor(ms: number) {
  for (const listener of appState.listeners) listener("background");
  vi.advanceTimersByTime(ms);
  for (const listener of appState.listeners) listener("active");
}

it("ends the open-call mark when a joining client is disposed without leave()", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const session = installNativeSession();
  const client = createNativeSpaceClient({ space: "space-1", getAccess: () => new Promise(() => undefined), baseUrl: "https://api.chalk.test", microphone: false, camera: false });
  const joined = client.join().catch(() => undefined);
  await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("joining"));

  const duringCall = session.current();
  backgroundFor(NATIVE_SESSION_BACKGROUND_MS);
  expect(session.current()).toBe(duringCall);

  client.dispose();
  await joined;
  backgroundFor(NATIVE_SESSION_BACKGROUND_MS);
  expect(session.current()).not.toBe(duringCall);
});
