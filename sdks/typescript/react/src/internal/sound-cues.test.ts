// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { createSoundPlayer } from "./sound-cues";

afterEach(() => vi.unstubAllGlobals());

it("initializes audio when mounted after Join, with a short, quiet two-note chime", () => {
  const start = vi.fn();
  const stop = vi.fn();
  const volume = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  const context = vi.fn(function () {
    return {
      state: "running",
      currentTime: 0,
      destination: {},
      close,
      createOscillator: () => ({ frequency: { setValueAtTime: vi.fn() }, connect: (gain: GainNode) => gain, start, stop }),
      createGain: () => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: volume, exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }),
    };
  });
  vi.stubGlobal("AudioContext", context);
  const player = createSoundPlayer();
  try {
    expect(context).toHaveBeenCalledOnce();
    player.play("join");
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls.every(([at]) => at <= 0.35)).toBe(true);
    expect(volume.mock.calls.map(([gain]) => gain)).toEqual([0.04, 0.03]);
  } finally {
    player.dispose();
  }
  window.dispatchEvent(new MouseEvent("click"));
  player.play("join");
  expect(context).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it("silently drops blocked tones, retries unlocking on a gesture, and never replays old joins", async () => {
  const resume = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
  const oscillator = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      resume = resume;
      createOscillator = oscillator;
      close = vi.fn().mockRejectedValue(new Error("already closed"));
    },
  );
  const player = createSoundPlayer();
  try {
    player.play("join");
    await Promise.resolve();
    expect(oscillator).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    window.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(oscillator).not.toHaveBeenCalled();
  } finally {
    player.dispose();
    await Promise.resolve();
  }
});

it("ignores missing audio support, constructor refusals, and synthesis failures", () => {
  for (const audioContext of [
    undefined,
    vi.fn(function () {
      throw new Error("audio unavailable");
    }),
    vi.fn(function () {
      return {
        state: "running",
        close: vi.fn().mockResolvedValue(undefined),
        createOscillator() {
          throw new Error("audio unavailable");
        },
      };
    }),
  ]) {
    vi.stubGlobal("AudioContext", audioContext);
    const player = createSoundPlayer();
    try {
      expect(() => player.play("join")).not.toThrow();
    } finally {
      player.dispose();
    }
  }
});
