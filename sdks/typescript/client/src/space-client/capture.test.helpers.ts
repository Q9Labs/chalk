import { vi } from "vitest";
import type { CoreTestPlatform } from "./core.test.helpers";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

export function captureClient(platform: CoreTestPlatform, dependencies: Partial<CoreTestPlatform["dependencies"]>) {
  return createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("test") }, { ...platform, dependencies: { ...platform.dependencies, ...dependencies } });
}
export function pendingCapture() {
  let resolve = (_stream: MediaStream) => {};
  const capture = vi.fn(
    () =>
      new Promise<MediaStream>((done) => {
        resolve = done;
      }),
  );
  return { capture, release: (stream: MediaStream) => resolve(stream) };
}
export function pendingPreview() {
  const video = track("video");
  const { capture, release } = pendingCapture();
  const client = captureClient(createCoreTestPlatform(), { mediaDevices: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } });
  return { video, capture, release, client };
}
export function pendingMedia() {
  return { platform: createCoreTestPlatform(), audio: track("audio"), video: track("video"), ...pendingCapture() };
}
export function noCaptureDevices() {
  throw new DOMException("No capture device", "NotFoundError");
}

export function track(kind: "audio" | "video"): MediaStreamTrack {
  let readyState: MediaStreamTrackState = "live";
  const result = Object.assign(new EventTarget(), {
    contentHint: "",
    enabled: true,
    id: kind,
    kind,
    label: "",
    muted: false,
    get readyState() {
      return readyState;
    },
    onended: null,
    onmute: null,
    onunmute: null,
    applyConstraints: async () => undefined,
    clone: () => track(kind),
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    getSettings: () => ({}),
    stop: vi.fn(() => {
      readyState = "ended";
    }),
  });
  Object.defineProperty(result, "readyState", { get: () => readyState });
  return result;
}

export function stream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return Object.assign(new EventTarget(), {
    active: true,
    id: "capture",
    onaddtrack: null,
    onremovetrack: null,
    addTrack: () => undefined,
    removeTrack: () => undefined,
    clone: () => stream(tracks),
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((input) => input.kind === "audio"),
    getVideoTracks: () => tracks.filter((input) => input.kind === "video"),
    getTrackById: (id: string) => tracks.find((input) => input.id === id) ?? null,
  });
}
