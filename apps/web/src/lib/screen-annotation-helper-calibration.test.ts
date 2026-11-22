import { afterEach, expect, test, vi } from "vitest";
import { HelperConflict } from "./screen-annotation-helper-bridge";
import { calibrateWindow } from "./screen-annotation-helper-calibration";

afterEach(() => vi.unstubAllGlobals());

function windowCalibration(captureTime?: (now: number) => number | undefined) {
  const controller = new AbortController();
  let callbacks = 0;
  const video = {
    style: {},
    videoWidth: 640,
    videoHeight: 360,
    setAttribute() {},
    remove() {},
    play: async () => {},
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) =>
      setTimeout(() => {
        callbacks++;
        if (callbacks > 5) {
          controller.abort();
          return;
        }
        const now = performance.now();
        callback(now, {
          captureTime: captureTime?.(now),
          presentationTime: now,
          expectedDisplayTime: now,
          presentedFrames: callbacks,
          mediaTime: callbacks / 60,
          width: 640,
          height: 360,
        });
      }, 5),
    cancelVideoFrameCallback: clearTimeout,
  };
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(72 * 72 * 4) }) };
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: (name: string) => (name === "video" ? video : { getContext: () => context }),
  });
  const track = { enabled: true, readyState: "live", clone: () => ({ enabled: true, stop() {} }) } as MediaStreamTrack;
  const point = { x: 0.5, y: 0.5, rgb: [255, 0, 255] as [number, number, number] };
  const probe = { nonce: "A".repeat(22), points: [point, point, point] as [typeof point, typeof point, typeof point] };
  const native: {
    phase: "idle" | "probing" | "calibrated";
    paintedWhileSending: boolean[];
    abortedWhileSending: boolean[];
    paintError?: Error;
    onPaint?: () => void;
  } = { phase: "idle", paintedWhileSending: [], abortedWhileSending: [] };
  return {
    track,
    signal: controller.signal,
    native,
    verify: async () => true,
    start: async () => {
      native.phase = "probing";
      return probe;
    },
    painted: async (nonce: string) => {
      expect(nonce).toBe(probe.nonce);
      native.paintedWhileSending.push(track.enabled);
      native.onPaint?.();
      if (native.paintError) throw native.paintError;
    },
    complete: async () => {
      native.phase = "calibrated";
    },
    abort: async () => {
      native.abortedWhileSending.push(track.enabled);
      native.phase = "idle";
    },
  };
}

test("window exclusion does not complete before the renderer acknowledges the probe", async () => {
  const options = windowCalibration((now) => now);
  options.native.paintError = new Error("No renderer acknowledgement");
  await calibrateWindow(options);
  expect(options.native.phase).toBe("idle");
  expect(options.native.abortedWhileSending).toEqual([false]);
  expect(options.track.enabled).toBe(true);
  expect(options.native.paintedWhileSending).toEqual([false]);
});

test("delayed pre-paint frames cannot prove window exclusion after acknowledgement", async () => {
  let capturedBeforePaint = 0;
  const options = windowCalibration(() => capturedBeforePaint++);
  options.native.onPaint = () => {
    capturedBeforePaint = performance.now() - 100;
  };
  await calibrateWindow(options);
  expect(options.native.phase).toBe("idle");
  expect(options.native.abortedWhileSending).toEqual([false]);
  expect(options.track.enabled).toBe(true);
});

test("window exclusion fails closed without capture timestamps", async () => {
  const options = windowCalibration();
  await calibrateWindow(options);
  expect(options.native.phase).toBe("idle");
  expect(options.native.abortedWhileSending).toEqual([false]);
  expect(options.track.enabled).toBe(true);
});

test("window exclusion can complete with four distinct post-paint captures", async () => {
  const options = windowCalibration((now) => now);
  await calibrateWindow(options);
  expect(options.native.phase).toBe("calibrated");
  expect(options.native.abortedWhileSending).toEqual([]);
  expect(options.track.enabled).toBe(true);
});

test("a stale request to start a window probe does not tear down a ready overlay", async () => {
  const options = windowCalibration((now) => now);
  options.native.phase = "calibrated";
  await calibrateWindow({
    ...options,
    start: async () => {
      throw new HelperConflict("A probe is already ready.");
    },
  });
  expect(options.native.paintedWhileSending).toEqual([]);
  expect(options.native.phase).toBe("calibrated");
  expect(options.track.enabled).toBe(true);
});

test("an uncertain window probe start still clears the native probe before resuming the share", async () => {
  const options = windowCalibration((now) => now);

  await calibrateWindow({
    ...options,
    start: async () => {
      await options.start();
      throw new Error("The response was lost.");
    },
  });
  expect(options.native.phase).toBe("idle");
  expect(options.native.abortedWhileSending).toEqual([false]);
  expect(options.track.enabled).toBe(true);
});
