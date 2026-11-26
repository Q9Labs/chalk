// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePreJoinDevices, type PreJoinDevices } from "./usePreJoinDevices";

const roots: ReturnType<typeof createRoot>[] = [];
let restoreNavigator: () => void = () => undefined;

function mediaDevice(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { deviceId, groupId: "group", kind, label: deviceId, toJSON: () => ({ deviceId, kind }) } as MediaDeviceInfo;
}

function mediaTrack(kind: "audio" | "video", deviceId: string): MediaStreamTrack {
  return {
    kind,
    readyState: "live",
    enabled: true,
    muted: false,
    getSettings: () => ({ deviceId }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

class FakeMediaStream {
  readonly #tracks: readonly MediaStreamTrack[];

  constructor(tracks: readonly MediaStreamTrack[] = []) {
    this.#tracks = [...tracks];
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.#tracks];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === "audio");
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === "video");
  }
}

function defineNavigatorProperties(values: ReadonlyArray<readonly [string, unknown]>): () => void {
  const previous = values.map(([key]) => [key, Object.getOwnPropertyDescriptor(navigator, key)] as const);
  for (const [key, value] of values) Object.defineProperty(navigator, key, { configurable: true, value });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(navigator, key, descriptor);
      else Reflect.deleteProperty(navigator, key);
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  vi.stubGlobal("MediaStream", FakeMediaStream);
  const permission = { state: "granted", addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as PermissionStatus;
  const mediaDevices = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    enumerateDevices: vi.fn(async () => [mediaDevice("audioinput", "microphone"), mediaDevice("videoinput", "camera"), mediaDevice("audiooutput", "speaker")]),
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      const tracks: MediaStreamTrack[] = [];
      if (constraints.audio) tracks.push(mediaTrack("audio", "microphone"));
      if (constraints.video) tracks.push(mediaTrack("video", "camera"));
      return new FakeMediaStream(tracks) as unknown as MediaStream;
    }),
  } as unknown as MediaDevices;
  restoreNavigator = defineNavigatorProperties([
    ["mediaDevices", mediaDevices],
    ["permissions", { query: vi.fn(async () => permission) }],
  ]);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  restoreNavigator();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let count = 0; count < 12; count += 1) await Promise.resolve();
  });
}

async function mountDevices(options?: { readonly startWithDevicesOff?: boolean }): Promise<() => PreJoinDevices> {
  let current: PreJoinDevices | undefined;
  function Probe() {
    current = usePreJoinDevices(options);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(<Probe />));
  await flush();
  return () => {
    const devices = current;
    if (!devices) throw new Error("PreJoin device probe did not render");
    return devices;
  };
}

it("keeps remembered devices on for a first join", async () => {
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true }));
  const devices = await mountDevices();

  expect(devices().access).toBe("granted");
  expect(devices().joinOptions).toMatchObject({ microphone: true, camera: true });
});

it("starts devices off for a rejoin without overwriting the remembered choice", async () => {
  const saved = { microphone: true, camera: true };
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify(saved));
  const devices = await mountDevices({ startWithDevicesOff: true });

  expect(devices().access).toBe("granted");
  expect(devices().joinOptions).toMatchObject({ microphone: false, camera: false });
  expect(devices().commit()).toMatchObject({ microphone: false, camera: false });
  expect(JSON.parse(localStorage.getItem("chalk.prejoin-devices") ?? "{}")).toMatchObject(saved);
});

it("keeps mic and camera preferences when only the speaker changes before rejoining", async () => {
  const saved = { microphone: true, camera: true };
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify(saved));
  const devices = await mountDevices({ startWithDevicesOff: true });

  await act(async () => devices().selectSpeaker("speaker"));
  devices().commit();
  expect(JSON.parse(localStorage.getItem("chalk.prejoin-devices") ?? "{}")).toMatchObject({ ...saved, speakerDeviceId: "speaker" });
});

it("keeps a speaker remembered in another tab before rejoining", async () => {
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true, speakerDeviceId: "speaker" }));
  const devices = await mountDevices({ startWithDevicesOff: true });

  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true, speakerDeviceId: "other-speaker" }));
  devices().commit();
  expect(JSON.parse(localStorage.getItem("chalk.prejoin-devices") ?? "{}")).toMatchObject({ microphone: true, camera: true, speakerDeviceId: "other-speaker" });
});

it("leaves preferences absent when an untouched rejoin had none", async () => {
  const devices = await mountDevices({ startWithDevicesOff: true });

  devices().commit();
  expect(localStorage.getItem("chalk.prejoin-devices")).toBeNull();
});

it("remembers a device the visitor turns back on before rejoining", async () => {
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true }));
  const devices = await mountDevices({ startWithDevicesOff: true });

  await act(async () => devices().setMicrophoneOn(true));
  await flush();
  expect(devices().commit()).toMatchObject({ microphone: true, camera: false });
  expect(JSON.parse(localStorage.getItem("chalk.prejoin-devices") ?? "{}")).toMatchObject({ microphone: true, camera: false });
});
