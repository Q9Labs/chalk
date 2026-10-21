// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DevicePopover } from "./DevicePopover";

it("refreshes the open preview when its published camera is disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const videoTrack = track("video");
  const captureCameraPreview = vi.fn(async () => ({ track: videoTrack.enabled ? videoTrack : videoTrack.clone(), release: () => {} }));
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const render = (active: boolean) => root.render(<DevicePopover type="video" isActive={active} onToggle={() => {}} devices={[]} onDeviceChange={() => {}} track={videoTrack} captureCameraPreview={captureCameraPreview} />);
  try {
    await act(async () => render(true));
    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Select camera"]');
    if (!trigger) throw new Error("Camera options missing");
    await act(async () => {
      trigger.click();
    });
    expect(document.querySelector("video")).not.toBeNull();
    videoTrack.enabled = false;
    await act(async () => render(false));
    const preview = document.querySelector("video")?.srcObject;
    if (!(preview instanceof MediaStream)) throw new Error("Preview stream missing");
    expect(preview.getVideoTracks()[0]?.enabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});

function track(kind: "audio" | "video"): MediaStreamTrack {
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
