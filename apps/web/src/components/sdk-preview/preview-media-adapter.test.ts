import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_DEVICE_FIXTURES } from "../../../../../sdks/typescript/react/src/test-support/preview-devices";

import { createPreviewMediaAdapter, createPreviewMediaDevices, PREVIEW_MEDIA_DEVICES } from "./preview-media-adapter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("preview media adapter", () => {
  it("returns deterministic devices without asking for permission", () => {
    expect(PREVIEW_MEDIA_DEVICES).toBe(PREVIEW_DEVICE_FIXTURES);
    expect(createPreviewMediaDevices()).toEqual(PREVIEW_MEDIA_DEVICES);
    expect(createPreviewMediaDevices()).toEqual(createPreviewMediaDevices());
    expect(PREVIEW_MEDIA_DEVICES.microphones[0]).toEqual({ deviceId: "preview-microphone", label: "Preview microphone" });
  });

  it("creates local and remote audio/video/screen handles and stops them through one bundle", () => {
    const adapter = createPreviewMediaAdapter();
    const bundle = adapter.createTrackBundle({
      local: { microphone: true, camera: true, screen: true },
      remote: { nora: { camera: true }, omar: { microphone: true, screen: true } },
    });
    const handles = [bundle.local.microphone, bundle.local.camera, bundle.local.screen, bundle.remote.get("nora")?.camera, bundle.remote.get("omar")?.microphone, bundle.remote.get("omar")?.screen];
    const tracks = handles.flatMap((handle) => (handle ? [handle.track] : []));

    expect(tracks.map((track) => track.id)).toEqual(["preview-local-microphone", "preview-local-camera", "preview-local-screen", "preview-nora-camera", "preview-omar-microphone", "preview-omar-screen"]);
    expect(tracks.every((track) => track.readyState === "live")).toBe(true);

    const camera = bundle.local.camera;
    if (!camera) throw new Error("expected a local camera track");
    const stop = vi.spyOn(camera.track, "stop");
    bundle.stop();
    bundle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(tracks.every((track) => track.readyState === "ended")).toBe(true);
    adapter.dispose();
  });

  it("stops individually created tracks when the adapter is disposed", () => {
    const adapter = createPreviewMediaAdapter();
    const audio = adapter.createAudioTrack("audio-one");
    const camera = adapter.createCameraTrack({ id: "camera-one" });
    const screen = adapter.createScreenTrack("screen-one");

    adapter.dispose();

    expect(audio.track.readyState).toBe("ended");
    expect(camera.track.readyState).toBe("ended");
    expect(screen.track.readyState).toBe("ended");
    adapter.dispose();
  });

  it("exposes live browser-shaped fallback tracks in a non-browser test runtime", () => {
    const adapter = createPreviewMediaAdapter();
    const bundle = adapter.createTrackBundle({ local: { microphone: true, camera: true, screen: true } });

    expect(bundle.local.microphone?.track.kind).toBe("audio");
    expect(bundle.local.camera?.track.kind).toBe("video");
    expect(bundle.local.screen?.track.kind).toBe("video");
    expect(bundle.local.camera?.track.id).toBe("preview-local-camera");
    bundle.stop();
  });
});
