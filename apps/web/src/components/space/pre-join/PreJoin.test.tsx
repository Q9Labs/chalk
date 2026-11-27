// @vitest-environment jsdom
/// <reference types="vitest/jsdom" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { PreJoin } from "./PreJoin";

// The SDK entry pulls in the whiteboard, which probes a canvas at import time.
const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);

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

function grantMediaAccess(): void {
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
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let count = 0; count < 12; count += 1) await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  const restore = restoreNavigator;
  restoreNavigator = () => undefined;
  restore();
  vi.unstubAllGlobals();
});

it("draws every lobby icon in the call's family: 1.75 outline glyphs, none from the older icon set", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PreJoin spaceName="Q9 team" displayName="Hasan" onDisplayNameChange={() => undefined} joining={false} onJoin={() => undefined} />));
  const icons = [...document.querySelectorAll("svg")];
  expect(icons.length).toBeGreaterThan(3);
  expect(icons.map((icon) => icon.getAttribute("stroke-width"))).toEqual(icons.map(() => "1.75"));
  expect(document.querySelectorAll("style[data-href]").length).toBeGreaterThan(0);
  await act(async () => root.unmount());
});

it("shows the joining spinner as the call's ring, not an icon", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PreJoin displayName="Hasan" onDisplayNameChange={() => undefined} joining onJoin={() => undefined} />));
  const join = document.querySelector("button[aria-busy=true]");
  expect(join?.textContent).toBe("Joining…");
  expect(join?.querySelector(".animate-spin")).not.toBeNull();
  expect(join?.querySelector("svg")).toBeNull();
  await act(async () => root.unmount());
});

it("rejoins with mic and camera off when the browser remembers them on", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  grantMediaAccess();
  localStorage.setItem("chalk.prejoin-devices", JSON.stringify({ microphone: true, camera: true }));
  const joins: PreJoinJoinOptions[] = [];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PreJoin displayName="Hasan" onDisplayNameChange={() => undefined} joining={false} rejoin onJoin={(devices) => joins.push(devices)} />));
  await flush();

  expect(document.body.textContent).toContain("mic and camera off");
  const join = [...document.querySelectorAll("button")].find((button) => button.textContent === "Rejoin");
  expect(join?.hasAttribute("disabled")).toBe(false);
  await act(async () => join?.click());
  expect(joins).toHaveLength(1);
  expect(joins[0]).toMatchObject({ microphone: false, camera: false });
  await act(async () => root.unmount());
});
