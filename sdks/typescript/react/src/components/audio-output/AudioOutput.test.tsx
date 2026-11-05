// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AudioOutput } from "./AudioOutput";

const observation = vi.hoisted(() => ({ played: vi.fn(), detach: vi.fn() }));
const observeAudioElement = vi.hoisted(() => vi.fn(() => observation));
vi.mock("../../bindings/hooks", () => ({
  useSpaceClient: () => ({ media: { observeAudioElement } }),
  useSelf: () => ({ participantId: "self" }),
  useMedia: () => ({ remote: [], selection: {} }),
  useParticipants: () => ({
    roster: [
      { participantId: "self", identityId: "person", media: { microphone: "inactive", screenShare: "inactive" } },
      { participantId: "own-phone", identityId: "person", media: { microphone: "active", screenShare: "active" } },
      { participantId: "remote", media: { microphone: "active", screenShare: "active" } },
    ],
  }),
}));
vi.mock("../participants-panel/participant-volume-context", () => ({ useParticipantVolumeContext: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each(["audioTrack", "screenShareAudioTrack"] as const)("observes %s playback rejection and detaches on unmount", async (source) => {
  const cause = new DOMException("Gesture required", "NotAllowedError");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(cause);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const track = { id: "remote-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AudioOutput participants={[{ id: "remote", [source]: track }]} />));
  expect(observeAudioElement).toHaveBeenCalledWith(track, expect.any(HTMLAudioElement));
  expect(observation.played).toHaveBeenCalledWith(cause);
  await act(async () => root.unmount());
  expect(observation.detach).toHaveBeenCalledOnce();
});
it.each(["audioTrack", "screenShareAudioTrack"] as const)("plays a replacement %s object even when its ID is unchanged", async (source) => {
  const played: MediaStreamTrack[] = [];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    const track = (this.srcObject as MediaStream | null)?.getAudioTracks()[0];
    if (track) played.push(track);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const previous = { id: "remote-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const replacement = { id: previous.id, kind: "audio", readyState: "live" } as MediaStreamTrack;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AudioOutput participants={[{ id: "remote", [source]: previous }]} />));
    Object.assign(previous, { readyState: "ended" });
    await act(async () => root.render(<AudioOutput participants={[{ id: "remote", [source]: replacement }]} />));
    expect(played).toEqual([previous, replacement]);
  } finally {
    await act(async () => root.unmount());
  }
});
it("shows one prompt for blocked playback and removes it only after playback succeeds", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Gesture required", "NotAllowedError"));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  // Only readyState is read; no capture or browser device is needed in this UI test.
  const track = { id: "remote-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AudioOutput participants={[{ id: "remote", audioTrack: track }]} />));
    const prompts = container.querySelectorAll("button");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.textContent).toBe("Resume audio");
    await act(async () => prompts[0]?.click());
    expect(container.querySelector("button")).not.toBeNull();
    play.mockResolvedValue(undefined);
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["AbortError", "NotSupportedError"])("does not show an autoplay prompt for %s", async (name) => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Playback failed", name));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const track = { id: "remote-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AudioOutput participants={[{ id: "remote", audioTrack: track }]} />));
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("ignores an autoplay rejection that arrives after the track leaves", async () => {
  let rejectPlay: ((cause: DOMException) => void) | undefined;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectPlay = reject;
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const track = { id: "remote-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AudioOutput participants={[{ id: "remote", audioTrack: track }]} />));
    await act(async () => root.render(<AudioOutput participants={[]} />));
    await act(async () => rejectPlay?.(new DOMException("Gesture required", "NotAllowedError")));
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("never plays microphone or shared audio from another device belonging to self", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const track = { id: "own-audio", kind: "audio", readyState: "live" } as MediaStreamTrack;
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AudioOutput participants={[{ id: "own-phone", audioTrack: track, screenShareAudioTrack: track }]} />));
    expect(play).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
