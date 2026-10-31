import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraEffectFailure } from "./camera-effects";
import { createCoreTestPlatform } from "../space-client/core.test.helpers";
import { captureClient } from "../space-client/capture.test.helpers";
import { track, stream } from "../space-client/capture.test.helpers";
import { cameraBackgroundAvailable, createCameraEffectsTrack, processCameraStream, setCameraBackground, getCameraBackground, getCameraBackgroundFallback, configureCameraEffectProvider } from "./camera-effects";

const model = vi.hoisted(() => ({ close: vi.fn(), create: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function browser() {
  const output = track("video");
  const source = track("video");
  source.getSettings = () => ({ deviceId: "camera-1", width: 640, height: 360 });
  const painter = { drawImage: vi.fn(), clearRect: vi.fn(), createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData: vi.fn(), getExtension: () => null };
  const canvas = { width: 0, height: 0, getContext: () => painter };
  vi.stubGlobal("document", { createElement: () => ({ ...canvas }) });
  let frames: ReadableStreamDefaultController<VideoFrame> | undefined;
  const readable = new ReadableStream<VideoFrame>({
    start(controller) {
      frames = controller;
    },
  });
  const write = vi.fn(async () => {});
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readonly readable = readable;
    },
  );
  vi.stubGlobal(
    "MediaStreamTrackGenerator",
    class {
      constructor() {
        return Object.assign(output, { writable: new WritableStream({ write }) });
      }
    },
  );
  vi.stubGlobal(
    "VideoFrame",
    class {
      readonly timestamp: number;
      readonly displayWidth = 640;
      readonly displayHeight = 360;
      readonly close = vi.fn();
      constructor(_source: unknown, options: { timestamp: number }) {
        this.timestamp = options.timestamp;
      }
    },
  );
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(tracks: MediaStreamTrack[]) {
        return stream(tracks);
      }
    },
  );
  model.create.mockResolvedValue({
    close: model.close,
    segmentForVideo: (_input: unknown, _time: number, result: (value: { confidenceMasks: { width: number; height: number; getAsFloat32Array: () => Float32Array }[] }) => void) => result({ confidenceMasks: [{ width: 1, height: 1, getAsFloat32Array: () => new Float32Array([1]) }] }),
  });
  return {
    output,
    source,
    painter,
    write,
    frame(timestamp = 1_000_000) {
      const input = new VideoFrame(new Uint8Array(), { format: "RGBA", codedWidth: 640, codedHeight: 360, timestamp });
      frames?.enqueue(input);
      return input;
    },
  };
}

describe("camera effects ownership", () => {
  const files = { wasmRoot: "/camera-effects/wasm", modelUrl: "/camera-effects/model.tflite" };
  it("falls back to plain frames without stopping the camera or its publication track", async () => {
    const { source, output, frame, write } = browser();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const fallback = vi.fn();
    const session = await createCameraEffectsTrack(source, files, () => model.create(), fallback);
    try {
      (await session.prepare("blur"))();
      for (let index = 0; index < 6; index++) {
        now = index * 1000;
        frame((index + 1) * 1_000_000);
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(index + 1));
      }
      expect(fallback).toHaveBeenCalledOnce();
      expect(session.track).toBe(output);
      expect(source.readyState).toBe("live");
      expect(output.readyState).toBe("live");
      expect(source.stop).not.toHaveBeenCalled();
      expect(output.getSettings().frameRate).toBe(30);
    } finally {
      clock.mockRestore();
      session.stop();
    }
  });
  it("keeps one output track when switching None and Blur, and releases capture exactly once", async () => {
    const { source, output } = browser();
    const originalStop = output.stop;
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    (await session.prepare("none"))();
    expect(model.create).not.toHaveBeenCalled();
    (await session.prepare("blur"))();
    (await session.prepare("none"))();
    expect(session.track).toBe(output);
    expect(output.getSettings().deviceId).toBe("camera-1");
    output.stop();
    session.stop();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(originalStop).toHaveBeenCalledTimes(1);
    expect(model.close).toHaveBeenCalledTimes(1);
  });
  it("keeps the output live if loading an effect fails, and allows retry", async () => {
    const { source, output } = browser();
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    (await session.prepare("none"))();
    model.create.mockRejectedValueOnce(new Error("Model unavailable"));
    await expect(session.prepare("blur")).rejects.toThrow("Model unavailable");
    expect(output.readyState).toBe("live");
    (await session.prepare("blur"))();
    expect(model.create).toHaveBeenCalledTimes(2);
    session.stop();
  });
  it("ends the output and releases resources when the camera ends", async () => {
    const { source, output } = browser();
    const ended = vi.fn();
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    output.addEventListener("ended", ended);
    source.dispatchEvent(new Event("ended"));
    expect(output.readyState).toBe("ended");
    expect(ended).toHaveBeenCalledTimes(1);
    await expect(session.prepare("none")).rejects.toThrow("stopped");
  });
  it("closes a model that finishes loading after capture has stopped", async () => {
    const { source } = browser();
    let complete = (_: { close: () => void }) => {};
    model.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    const preparing = session.prepare("blur");
    await vi.waitFor(() => expect(model.create).toHaveBeenCalled());
    session.stop();
    complete({ close: model.close });
    await expect(preparing).rejects.toThrow("stopped");
    expect(model.close).toHaveBeenCalledTimes(1);
  });
  it("consumes captured frames without rendering callbacks, and closes every input", async () => {
    const { source, write, frame } = browser();
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    const before = frame();
    await vi.waitFor(() => expect(before.close).toHaveBeenCalled());
    expect(write).not.toHaveBeenCalled();
    (await session.prepare("none"))();
    const input = frame(2_000_000);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(input.close).toHaveBeenCalledOnce();
    session.stop();
  });
  it("ends failed processing with an allowlisted diagnostic and no raw fallback", async () => {
    const { source, output, painter, frame } = browser();
    const session = await createCameraEffectsTrack(source, files, () => model.create());
    (await session.prepare("none"))();
    painter.drawImage.mockImplementationOnce(() => {
      throw new Error("private error payload");
    });
    frame();
    await vi.waitFor(() => expect(output.readyState).toBe("ended"));
    expect(cameraEffectFailure(output)).toEqual({ event: "media_state", source: "camera", phase: "failed", outcome: "failed", code: "media_capture_failed", media_error_kind: "OperationError", media_error_step: "local_capture" });
    expect(source.stop).toHaveBeenCalledOnce();
    expect(session.track).not.toBe(source);
  });
  it("passes capture through when effects have not been configured", async () => {
    const input = stream([track("video")]);
    expect(await processCameraStream(input)).toBe(input);
  });
  it("serializes rapid choices and preserves per-device settings without active capture", async () => {
    await Promise.all([setCameraBackground("camera-a", "blur"), setCameraBackground("camera-a", "none"), setCameraBackground("camera-b", "blur")]);
    expect(getCameraBackground("camera-a")).toBe("none");
    expect(getCameraBackground("camera-b")).toBe("blur");
  });
  it("remembers plain camera after slow processing and clears the notice on retry", async () => {
    const { source, output, frame, write } = browser();
    vi.stubGlobal("HTMLCanvasElement", class {});
    configureCameraEffectProvider(files, () => model.create());
    await setCameraBackground("camera-1", "blur");
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      await processCameraStream(stream([source]));
      for (let index = 0; index < 5; index++) {
        now = index * 1000;
        frame((index + 1) * 1_000_000);
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(index + 1));
      }
      expect(getCameraBackground("camera-1")).toBe("none");
      expect(getCameraBackgroundFallback("camera-1")).toBeLessThan(15);
      expect(source.readyState).toBe("live");
      await setCameraBackground("camera-1", "blur");
      expect(getCameraBackground("camera-1")).toBe("blur");
      expect(getCameraBackgroundFallback("camera-1")).toBeUndefined();
    } finally {
      clock.mockRestore();
      output.stop();
    }
  });
  it.each(["leave", "dispose"] as const)("stops acquired camera immediately on %s while a saved model is pending", async (action) => {
    const { source, output } = browser();
    vi.stubGlobal("HTMLCanvasElement", class {});
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ getExtension: () => null }) }) });
    configureCameraEffectProvider(files, () => model.create());
    await setCameraBackground("camera-1", "blur");
    let complete = (_: { close: () => void }) => {};
    model.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const client = captureClient(createCoreTestPlatform(), { mediaDevices: { getUserMedia: (_constraints, signal) => processCameraStream(stream([source]), signal) } });
    try {
      await client.join({ microphone: false, camera: false });
      const preview = client.media.captureCameraPreview().then(
        (captured) => {
          captured.release();
          return "resolved";
        },
        () => "rejected",
      );
      await vi.waitFor(() => expect(model.create).toHaveBeenCalled());
      if (action === "leave") await client.leave();
      else client.dispose();
      expect(source.readyState).toBe("ended");
      expect(output.readyState).toBe("ended");
      complete({ close: model.close });
      expect(await preview).toBe("rejected");
      await vi.waitFor(() => expect(model.close).toHaveBeenCalledOnce());
    } finally {
      complete({ close: model.close });
      client.dispose();
    }
  });
});

describe("camera background recovery", () => {
  const files = { wasmRoot: "/camera-effects/wasm", modelUrl: "/camera-effects/model.tflite" };
  function camera(deviceId: string) {
    const capture = browser();
    capture.source.getSettings = () => ({ deviceId, width: 640, height: 360 });
    vi.stubGlobal("HTMLCanvasElement", class {});
    configureCameraEffectProvider(files, () => model.create());
    return capture;
  }
  it("releases the camera's queue when capture is cancelled before a saved model loads", async () => {
    const first = camera("camera-queue");
    await setCameraBackground("camera-queue", "blur");
    let complete = (_: { close: () => void }) => {};
    model.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const cancel = new AbortController();
    const capture = processCameraStream(stream([first.source]), cancel.signal);
    await vi.waitFor(() => expect(model.create).toHaveBeenCalledOnce());
    cancel.abort();
    await expect(capture).rejects.toThrow();
    expect(first.source.readyState).toBe("ended");
    await setCameraBackground("camera-queue", "none");
    const second = camera("camera-queue");
    await processCameraStream(stream([second.source]));
    expect(cameraBackgroundAvailable("camera-queue")).toBe(true);
    expect(second.output.readyState).toBe("live");
    complete({ close: model.close });
    await vi.waitFor(() => expect(model.close).toHaveBeenCalledOnce());
    expect(model.create).toHaveBeenCalledOnce();
    second.output.stop();
  });
  it("keeps a recaptured camera's session when an old output is stopped again", async () => {
    const first = camera("camera-recapture");
    await setCameraBackground("camera-recapture", "none");
    await processCameraStream(stream([first.source]));
    const old = first.output;
    old.stop();
    const second = camera("camera-recapture");
    await processCameraStream(stream([second.source]));
    old.stop();
    expect(cameraBackgroundAvailable("camera-recapture")).toBe(true);
    await setCameraBackground("camera-recapture", "blur");
    expect(model.create).toHaveBeenCalledOnce();
    expect(second.output.getSettings().frameRate).toBe(24);
    second.output.stop();
  });
});
