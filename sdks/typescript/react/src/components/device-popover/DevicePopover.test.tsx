// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DevicePopover } from "./DevicePopover";

it("shows connecting as off and allows an immediate cancel, then explains failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const cancel = vi.fn();
  const toggle = vi.fn();
  try {
    await act(async () => root.render(<DevicePopover type="mic" isActive={false} busy onCancelPending={cancel} onToggle={toggle} devices={[]} onDeviceChange={() => {}} />));
    const button = element.querySelector<HTMLButtonElement>('button[aria-label="Cancel connecting microphone"]');
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.disabled).toBe(false);
    expect(element.textContent).toContain("Connecting microphone");
    await act(async () => button?.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(toggle).not.toHaveBeenCalled();
    await act(async () => root.render(<DevicePopover type="mic" isActive={false} warning onToggle={toggle} devices={[]} onDeviceChange={() => {}} />));
    expect(element.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Microphone didn’t reach the call. Try turning it on again.");
    expect(element.querySelector('button[aria-label="Unmute microphone"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});

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
