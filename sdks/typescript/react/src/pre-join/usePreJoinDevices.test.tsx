// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRememberedDevices } from "./remembered-devices";
import { usePreJoinDevices, type PreJoinDevices, type PreJoinJoinOptions } from "./usePreJoinDevices";

type FakeTrack = MediaStreamTrack & { readonly stopped: () => boolean };

function fakeTrack(kind: "audio" | "video", deviceId: string): FakeTrack {
  let stopped = false;
  const target = new EventTarget();
  return Object.assign(target, {
    kind,
    readyState: "live",
    getSettings: () => ({ deviceId }),
    stop: () => {
      stopped = true;
    },
    stopped: () => stopped,
  }) as unknown as FakeTrack;
}

class FakeStream {
  readonly #tracks: FakeTrack[];
  constructor(tracks: readonly FakeTrack[] = []) {
    this.#tracks = [...tracks];
  }
  getTracks = () => [...this.#tracks];
  getAudioTracks = () => this.#tracks.filter((track) => track.kind === "audio");
  getVideoTracks = () => this.#tracks.filter((track) => track.kind === "video");
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({ kind, deviceId, label, groupId: "g", toJSON: () => ({}) });
const microphones = [device("audioinput", "mic-1", "Built-in microphone"), device("audioinput", "mic-2", "AirPods")];
const cameras = [device("videoinput", "cam-1", "FaceTime camera"), device("videoinput", "cam-2", "Studio camera")];
const speakers = [device("audiooutput", "spk-1", "Built-in speakers"), device("audiooutput", "spk-2", "Studio speakers")];

type Constraints = { audio: boolean | { deviceId: { exact: string } }; video: boolean | { deviceId: { exact: string } } };

/** A browser whose permission, hardware and device list the test controls. */
function installBrowser(initial: { permission: PermissionState; devices?: MediaDeviceInfo[]; failWith?: (constraints: Constraints) => string | undefined }) {
  const state = { permission: initial.permission, devices: initial.devices ?? [...microphones, ...cameras, ...speakers] };
  const opened: FakeTrack[] = [];
  const deviceChange = new EventTarget();
  const statuses = [new EventTarget(), new EventTarget()].map((target) => Object.assign(target, { state: state.permission }));
  const getUserMedia = vi.fn(async (constraints: Constraints) => {
    const failure = initial.failWith?.(constraints);
    if (failure) throw new DOMException(failure, failure);
    if (state.permission === "denied") throw new DOMException("denied", "NotAllowedError");
    state.permission = "granted";
    const tracks: FakeTrack[] = [];
    if (constraints.audio) tracks.push(fakeTrack("audio", typeof constraints.audio === "object" ? constraints.audio.deviceId.exact : "mic-1"));
    if (constraints.video) tracks.push(fakeTrack("video", typeof constraints.video === "object" ? constraints.video.deviceId.exact : "cam-1"));
    opened.push(...tracks);
    return new FakeStream(tracks);
  });
  const mediaDevices = Object.assign(deviceChange, { getUserMedia, enumerateDevices: async () => state.devices });
  vi.stubGlobal("MediaStream", FakeStream);
  vi.stubGlobal(
    "AudioContext",
    class {
      createMediaStreamSource = () => ({ connect: () => undefined, disconnect: () => undefined });
      createAnalyser = () => ({ fftSize: 0, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128) });
      close = async () => undefined;
    },
  );
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => statuses[0] } });
  return {
    getUserMedia,
    opened,
    plugIn: (plugged: MediaDeviceInfo) => {
      state.devices = [...state.devices, plugged];
      deviceChange.dispatchEvent(new Event("devicechange"));
    },
    unplug: (deviceId: string) => {
      state.devices = state.devices.filter((entry) => entry.deviceId !== deviceId);
      deviceChange.dispatchEvent(new Event("devicechange"));
    },
    grantInBrowserSettings: () => {
      state.permission = "granted";
      for (const status of statuses) {
        Object.assign(status, { state: "granted" });
        status.dispatchEvent(new Event("change"));
      }
    },
  };
}

let root: Root;
let current: PreJoinDevices;
function Probe() {
  current = usePreJoinDevices();
  return null;
}
async function mount() {
  await act(async () => {
    root.render(<Probe />);
  });
  await settle();
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", memoryStorage());
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("usePreJoinDevices", () => {
  it("asks first, then previews both devices and joins with them on", async () => {
    const browser = installBrowser({ permission: "prompt" });
    await mount();
    expect(current.access).toBe("ask");
    expect(browser.getUserMedia).not.toHaveBeenCalled();
    expect(current.joinOptions).toEqual({ microphone: false, camera: false });

    await act(async () => current.requestAccess());
    await settle();
    expect(browser.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(current.access).toBe("granted");
    expect(current.cameraTrack).not.toBeNull();
    expect(current.joinOptions).toEqual({ microphone: true, camera: true, microphoneDeviceId: "mic-1", cameraDeviceId: "cam-1" });
  });

  it("opens the preview straight away when access was already granted", async () => {
    const browser = installBrowser({ permission: "granted" });
    await mount();
    expect(current.access).toBe("granted");
    expect(browser.getUserMedia).toHaveBeenCalledTimes(1);
    expect(current.microphones.map((entry) => entry.deviceId)).toEqual(["mic-1", "mic-2"]);
  });

  it("hands the picked devices to join and reopens the preview on them", async () => {
    const browser = installBrowser({ permission: "granted" });
    await mount();
    await act(async () => {
      current.selectMicrophone("mic-2");
      current.selectCamera("cam-2");
      current.selectSpeaker("spk-2");
    });
    await settle();
    expect(browser.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-2" } }, video: { deviceId: { exact: "cam-2" } } });
    expect(current.joinOptions).toMatchObject({ microphone: true, camera: true, microphoneDeviceId: "mic-2", cameraDeviceId: "cam-2" });
    expect(current.speakerId).toBe("spk-2");
    // Safari has no setSinkId, so the speaker only reaches join where the browser can honour it.
    expect(current.joinOptions.speakerDeviceId).toBe(current.canChooseSpeaker ? "spk-2" : undefined);
  });

  it("stops the old tracks once their replacement runs, and every track on unmount", async () => {
    const browser = installBrowser({ permission: "granted" });
    await mount();
    const first = [...browser.opened];
    await act(async () => current.selectCamera("cam-2"));
    await settle();
    expect(first.every((track) => track.stopped())).toBe(true);
    const second = browser.opened.filter((track) => !first.includes(track));
    expect(second.some((track) => track.stopped())).toBe(false);

    await act(async () => root.unmount());
    expect(second.every((track) => track.stopped())).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("stops a camera that arrives after the step unmounted", async () => {
    const browser = installBrowser({ permission: "granted" });
    let late: (stream: FakeStream) => void = () => undefined;
    browser.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (late = (stream) => resolve(stream as unknown as MediaStream))));
    await act(async () => {
      root.render(<Probe />);
    });
    await settle();
    await act(async () => root.unmount());
    const lateTracks = [fakeTrack("audio", "mic-1"), fakeTrack("video", "cam-1")];
    late(new FakeStream(lateTracks));
    await settle();
    expect(lateTracks.every((track) => track.stopped())).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("turning the camera off stops it and joins with the camera off", async () => {
    const browser = installBrowser({ permission: "granted" });
    await mount();
    const camera = browser.opened.find((track) => track.kind === "video");
    await act(async () => current.setCameraOn(false));
    await settle();
    expect(camera?.stopped()).toBe(true);
    expect(current.cameraTrack).toBeNull();
    expect(current.joinOptions).toMatchObject({ microphone: true, camera: false });
  });

  it("remembers the toggles and devices for the next visit", async () => {
    installBrowser({ permission: "granted" });
    await mount();
    await act(async () => {
      current.setMicrophoneOn(false);
      current.selectCamera("cam-2");
    });
    expect(readRememberedDevices()).toEqual({ microphone: false, camera: true, cameraDeviceId: "cam-2" });

    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));
    const next = installBrowser({ permission: "granted" });
    await mount();
    expect(current.microphoneOn).toBe(false);
    expect(current.joinOptions).toMatchObject({ microphone: false, camera: true, cameraDeviceId: "cam-2" });
    expect(next.getUserMedia).toHaveBeenCalledWith({ audio: false, video: { deviceId: { exact: "cam-2" } } });
  });

  it("commits what the visitor joins with, keeping only the devices they picked", async () => {
    installBrowser({ permission: "granted" });
    await mount();
    expect(readRememberedDevices()).toBeNull();
    let committed: PreJoinJoinOptions | undefined;
    await act(async () => {
      committed = current.commit();
    });
    expect(committed).toEqual(current.joinOptions);
    expect(readRememberedDevices()).toEqual({ microphone: true, camera: true });
  });

  it("ignores a remembered device the browser no longer lists", async () => {
    localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true, cameraDeviceId: "unplugged" }));
    const browser = installBrowser({ permission: "granted" });
    await mount();
    expect(browser.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(current.cameraId).toBe("cam-1");
  });

  it("falls back to the first microphone that appears after joining muted without one", async () => {
    const browser = installBrowser({ permission: "granted", devices: [...cameras, ...speakers] });
    await mount();
    expect(current.microphoneMissing).toBe(true);
    expect(current.joinOptions).toMatchObject({ microphone: false, camera: true });
    expect(current.cameraTrack).not.toBeNull();

    await act(async () => browser.plugIn(microphones[0]!));
    await settle();
    expect(current.microphoneMissing).toBe(false);
    expect(current.joinOptions).toMatchObject({ microphone: true, microphoneDeviceId: "mic-1" });
  });

  it("switches to the default camera when the picked one is unplugged", async () => {
    const browser = installBrowser({ permission: "granted" });
    await mount();
    await act(async () => current.selectCamera("cam-2"));
    await settle();
    await act(async () => browser.unplug("cam-2"));
    await settle();
    expect(current.cameraId).toBe("cam-1");
    expect(browser.getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: true });
  });

  it("reports a blocked browser, then recovers when the visitor allows access in settings", async () => {
    const browser = installBrowser({ permission: "denied" });
    await mount();
    expect(current.access).toBe("blocked");
    await act(async () => current.requestAccess());
    await settle();
    expect(current.access).toBe("blocked");
    expect(current.joinOptions).toEqual({ microphone: false, camera: false });

    await act(async () => browser.grantInBrowserSettings());
    await settle();
    expect(current.access).toBe("granted");
    expect(current.joinOptions).toMatchObject({ microphone: true, camera: true });
  });

  it("joins with a camera that cannot open turned off, and keeps the microphone", async () => {
    installBrowser({ permission: "granted", failWith: (constraints) => (constraints.video ? "NotReadableError" : undefined) });
    await mount();
    expect(current.cameraMissing).toBe(true);
    expect(current.microphoneMissing).toBe(false);
    expect(current.joinOptions).toMatchObject({ microphone: true, camera: false });
  });

  it("reads granted access from device labels where the browser cannot query permission", async () => {
    installBrowser({ permission: "granted", devices: [device("audioinput", "mic-1", "Built-in microphone"), device("videoinput", "cam-1", "FaceTime camera")] });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => Promise.reject(new TypeError("unsupported")) } });
    await mount();
    expect(current.access).toBe("granted");
  });
});
