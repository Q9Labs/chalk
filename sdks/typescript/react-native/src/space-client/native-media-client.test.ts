import { expect, it, vi } from "vitest";
import type { CloudflareSFUClient } from "@q9labsai/chalk-client";

vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock("@cloudflare/react-native-webrtc", () => ({ RTCPeerConnection: vi.fn(), mediaDevices: {} }));
import { createSFUConnectionMediaClient } from "./create-native-space-client";

it("hands the controller the media client's mute path, so a mute closes over the kept bundle transport", async () => {
  const calls: string[] = [];
  const client = {
    prepareLocalPublicationTarget: vi.fn(),
    setLocalPublicationTarget: vi.fn(),
    pauseLocalCapture: vi.fn(async (source: string) => void calls.push(`capture:${source}`)),
    setLocalSourceIntent: vi.fn((source: string, enabled: boolean, cause?: string) => void calls.push(`intent:${source}:${enabled}:${cause}`)),
    closeForcedLocalPublication: vi.fn(async (source: string, cause?: string) => void calls.push(`close:${source}:${cause}`)),
    observeLocalPublications: vi.fn(),
    observeRemotePublications: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    prepareLocalTrack: vi.fn(),
    clearPreparedLocalTrack: vi.fn(),
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as CloudflareSFUClient;

  const media = createSFUConnectionMediaClient(client);
  media.setLocalSourceIntent?.("microphone", false, "user_pause");
  await media.closeForcedLocalPublication?.("microphone", "user_pause");
  await media.pauseLocalCapture?.("camera");

  expect(calls).toEqual(["intent:microphone:false:user_pause", "close:microphone:user_pause", "capture:camera"]);
});
