import { expect, it, vi } from "vitest";
import { AudioPlayback, type AudioElementObservation } from "./audio-playback";

function fixture() {
  const health: unknown[][] = [];
  const changes: boolean[] = [];
  const playback = new AudioPlayback({
    observeElement: () => ({
      played: (result) => health.push([result]),
      detach: () => undefined,
    }),
    changed: () => changes.push(playback.snapshot.blocked),
  });
  return { playback, health, changes };
}

function audioElement(play?: () => Promise<void>): HTMLAudioElement {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    paused: true,
    play: vi.fn(async () => {
      element.paused = false;
      for (const listener of listeners.get("playing") ?? []) listener();
    }),
    addEventListener: (name: string, listener: () => void) => listeners.set(name, new Set([...(listeners.get(name) ?? []), listener])),
    removeEventListener: (name: string, listener: () => void) => listeners.get(name)?.delete(listener),
  };
  if (play) element.play = vi.fn(play);
  return element as unknown as HTMLAudioElement;
}

function audioContext(initialState: AudioContextState): AudioContext {
  const listeners = new Set<() => void>();
  const context = {
    state: initialState,
    resume: vi.fn(async () => {
      context.state = "running";
      for (const listener of listeners) listener();
    }),
    close: vi.fn(async () => {
      context.state = "closed";
      for (const listener of listeners) listener();
    }),
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  };
  return context as unknown as AudioContext;
}

const notAllowed = () => ({ name: "NotAllowedError" });

it("stays unblocked for playback success and non-autoplay rejections", () => {
  const { playback, changes } = fixture();
  const element = audioElement();
  const observation = playback.observeElement({} as MediaStreamTrack, element);
  observation.played({ name: "AbortError" });
  observation.played(undefined);
  expect(playback.snapshot.blocked).toBe(false);
  expect(changes).toEqual([]);
  observation.detach();
});

it("marks a real play rejection blocked and one resume clears it", async () => {
  const { playback, health, changes } = fixture();
  const element = audioElement();
  const observation = playback.observeElement({} as MediaStreamTrack, element);
  observation.played(notAllowed());
  expect(playback.snapshot.blocked).toBe(true);

  element.play = vi.fn(async () => {
    element.paused = false;
  });
  await playback.resume();
  expect(element.play).toHaveBeenCalledOnce();
  expect(playback.snapshot.blocked).toBe(false);
  expect(health).toEqual([[notAllowed()], [undefined]]);
  expect(changes).toEqual([true, false]);
  observation.detach();
});

it("tracks later elements independently and forgets detached output", async () => {
  const { playback } = fixture();
  const first = playback.observeElement({} as MediaStreamTrack, audioElement());
  const secondElement = audioElement(vi.fn().mockRejectedValue(notAllowed()));
  const second = playback.observeElement({} as MediaStreamTrack, secondElement);
  first.played(undefined);
  second.played(notAllowed());
  expect(playback.snapshot.blocked).toBe(true);

  second.detach();
  expect(playback.snapshot.blocked).toBe(false);
  await playback.resume();
  expect(secondElement.play).not.toHaveBeenCalled();
  first.detach();
});

it("uses AudioContext state as evidence and resumes suspended contexts", async () => {
  const { playback, changes } = fixture();
  const context = audioContext("suspended");
  const observation = playback.observeAudioContext(context);
  expect(playback.snapshot.blocked).toBe(true);

  await playback.resume();
  expect(context.resume).toHaveBeenCalledOnce();
  expect(playback.snapshot.blocked).toBe(false);
  expect(changes).toEqual([true, false]);
  observation.detach();
});

it("does not let an earlier rejection reblock an element that is already playing", async () => {
  const { playback } = fixture();
  const element = audioElement();
  element.paused = false;
  const observation = playback.observeElement({} as MediaStreamTrack, element);
  observation.played(undefined);
  observation.played(notAllowed());
  expect(playback.snapshot.blocked).toBe(false);
  observation.detach();
});

it("shares one in-flight resume across gestures", async () => {
  const { playback } = fixture();
  let finish: (() => void) | undefined;
  const element = audioElement(() => new Promise<void>((resolve) => (finish = resolve)));
  const observation = playback.observeElement({} as MediaStreamTrack, element);
  observation.played(notAllowed());
  element.play.mockImplementation(async () => {
    element.paused = false;
  });
  const first = playback.resume();
  const second = playback.resume();
  expect(element.play).toHaveBeenCalledOnce();
  await Promise.all([first, second]);
  expect(playback.snapshot.blocked).toBe(false);
  observation.detach();
});
