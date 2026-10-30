import { afterEach, describe, expect, it, vi } from "vitest";
import { track, stream } from "../space-client/capture.test.helpers";
import { createCameraEffectsTrack, processCameraStream, setCameraBackground, getCameraBackground } from "./camera-effects";

const model = vi.hoisted(() => ({ close: vi.fn(), create: vi.fn() }));
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ImageSegmenter: { createFromOptions: model.create },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function browser() {
  const output = track("video");
  const source = track("video");
  source.getSettings = () => ({ deviceId: "camera-1", width: 640, height: 360 });
  const video = { style: {}, setAttribute: vi.fn(), remove: vi.fn(), muted: false, playsInline: false, srcObject: null, videoWidth: 640, videoHeight: 360, play: vi.fn(async () => {}), pause: vi.fn(), requestVideoFrameCallback: vi.fn(() => 1), cancelVideoFrameCallback: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), captureStream: () => stream([output]) };
  vi.stubGlobal("document", { documentElement: { appendChild: vi.fn() }, createElement: (tag: string) => (tag === "video" ? video : { ...canvas }) });
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(tracks: MediaStreamTrack[]) {
        return stream(tracks);
      }
    },
  );
  model.create.mockResolvedValue({ close: model.close });
  return { output, source, video };
}

describe("camera effects ownership", () => {
  const files = { wasmRoot: "/camera-effects/wasm", modelUrl: "/camera-effects/model.tflite" };
  it("keeps one output track when switching None and Blur, and releases capture exactly once", async () => {
    const { source, output, video } = browser();
    const originalStop = output.stop;
    const session = await createCameraEffectsTrack(source, files);
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
    expect(video.srcObject).toBe(null);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });
  it("keeps the output live if loading an effect fails, and allows retry", async () => {
    const { source, output } = browser();
    const session = await createCameraEffectsTrack(source, files);
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
    const session = await createCameraEffectsTrack(source, files);
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
    const session = await createCameraEffectsTrack(source, files);
    const preparing = session.prepare("blur");
    await vi.waitFor(() => expect(model.create).toHaveBeenCalled());
    session.stop();
    complete({ close: model.close });
    await expect(preparing).rejects.toThrow("stopped");
    expect(model.close).toHaveBeenCalledTimes(1);
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
});
