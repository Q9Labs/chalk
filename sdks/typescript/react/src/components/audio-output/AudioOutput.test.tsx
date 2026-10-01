// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AudioOutput } from "./AudioOutput";

vi.mock("../../bindings/hooks", () => ({ useMedia: () => ({ remote: [], selection: {} }), useParticipants: () => ({ roster: [{ participantId: "remote", media: { microphone: "active" } }] }) }));
vi.mock("../participants-panel/participant-volume-context", () => ({ useParticipantVolumeContext: () => null }));

afterEach(() => vi.restoreAllMocks());
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
