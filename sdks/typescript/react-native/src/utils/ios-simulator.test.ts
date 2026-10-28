import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  Platform: { OS: "ios" },
  NativeModules: {
    ChalkRuntimeInfo: { isSimulator: true },
    WebRTCModule: {
      receiverGetCapabilities: () => ({ codecs: ["receiver"], headerExtensions: [] }),
      senderGetCapabilities: () => ({ codecs: ["sender"], headerExtensions: [] }),
    },
  },
}));
vi.mock("react-native", () => native);

import { ensureIosSimulatorWebRtcSafety } from "./ios-simulator";

afterEach(() => {
  vi.unstubAllGlobals();
  native.Platform.OS = "ios";
  native.NativeModules.ChalkRuntimeInfo.isSimulator = true;
});

it("patches simulator module and global capabilities and enumeration only once", async () => {
  const makeTarget = () => ({ getCapabilities: (_kind?: string) => ({ codecs: ["codec"], headerExtensions: [] }) });
  const module = { RTCRtpSender: makeTarget(), RTCRtpReceiver: makeTarget(), mediaDevices: { enumerateDevices: async () => ["device"] } };
  const sender = makeTarget();
  const receiver = makeTarget();
  const mediaDevices = { enumerateDevices: async () => ["global device"] };
  vi.stubGlobal("RTCRtpSender", sender);
  vi.stubGlobal("RTCRtpReceiver", receiver);
  vi.stubGlobal("navigator", { mediaDevices });

  ensureIosSimulatorWebRtcSafety(module);
  const empty = { codecs: [], headerExtensions: [] };
  for (const target of [module.RTCRtpSender, module.RTCRtpReceiver, sender, receiver]) {
    expect(target.getCapabilities("audio")).toEqual(empty);
    expect(target.getCapabilities("invalid")).toEqual(empty);
    const patched = target.getCapabilities;
    ensureIosSimulatorWebRtcSafety(module);
    expect(target.getCapabilities).toBe(patched);
  }
  expect(await module.mediaDevices.enumerateDevices()).toEqual([]);
  expect(await mediaDevices.enumerateDevices()).toEqual([]);
  expect(native.NativeModules.WebRTCModule.receiverGetCapabilities()).toEqual(empty);
  expect(native.NativeModules.WebRTCModule.senderGetCapabilities()).toEqual(empty);
  const capabilities = sender.getCapabilities();
  capabilities.codecs.push("changed");
  expect(sender.getCapabilities()).toEqual(empty);
});

it("does not patch a physical device or a non-iOS platform, and accepts missing globals", async () => {
  const module = { mediaDevices: { enumerateDevices: async () => ["device"] } };
  native.NativeModules.ChalkRuntimeInfo.isSimulator = false;
  ensureIosSimulatorWebRtcSafety(module);
  expect(await module.mediaDevices.enumerateDevices()).toEqual(["device"]);
  native.NativeModules.ChalkRuntimeInfo.isSimulator = true;
  native.Platform.OS = "android";
  ensureIosSimulatorWebRtcSafety(module);
  expect(await module.mediaDevices.enumerateDevices()).toEqual(["device"]);

  native.Platform.OS = "ios";
  vi.stubGlobal("RTCRtpSender", undefined);
  vi.stubGlobal("RTCRtpReceiver", undefined);
  vi.stubGlobal("navigator", undefined);
  expect(() => ensureIosSimulatorWebRtcSafety()).not.toThrow();
});
