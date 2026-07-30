import { describe, expect, it, vi } from "vitest";

import { MediaManager, ScreenShareManager } from "./realtimekit-media-managers";
import type { RealtimeKitMeeting, RealtimeKitSelf } from "./realtimekit-ports";

describe("RealtimeKit media managers", () => {
  it("projects devices and drives audio, video, and device selection", async () => {
    const harness = createSelfHarness();
    const manager = new MediaManager();

    manager.attach(harness.self);
    await vi.waitFor(() => expect(manager.getState().devices).toHaveLength(3));

    await expect(manager.toggleAudio()).resolves.toBe(false);
    await expect(manager.toggleVideo()).resolves.toBe(false);
    await manager.selectCamera("camera-1");

    expect(harness.disableAudio).toHaveBeenCalledOnce();
    expect(harness.disableVideo).toHaveBeenCalledOnce();
    expect(harness.setDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "camera-1" }));
    expect(manager.getState()).toMatchObject({
      isAudioEnabled: false,
      isVideoEnabled: false,
      selectedCameraId: "camera-1",
      cameras: [{ id: "camera-1", label: "Front camera", kind: "camera" }],
    });

    manager.detach();
    expect(manager.getState().devices).toEqual([]);
  });

  it("tracks local screen sharing and notifies the runtime after controls settle", async () => {
    const harness = createSelfHarness();
    const onChange = vi.fn();
    const manager = new ScreenShareManager();
    const meeting = createMeeting(harness.self);

    manager.attach(harness.self, onChange);
    await expect(manager.start()).resolves.toBe(true);
    manager.sync(meeting);

    expect(harness.enableScreenShare).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(manager.getState()).toMatchObject({
      isActive: true,
      isLocalSharing: true,
      sharerParticipantId: "local-1",
    });

    await manager.stop();
    expect(harness.disableScreenShare).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

function createSelfHarness() {
  let audioEnabled = true;
  let videoEnabled = true;
  let screenShareEnabled = false;
  const devices = [
    { deviceId: "camera-1", kind: "videoinput", label: "Front camera" },
    { deviceId: "microphone-1", kind: "audioinput", label: "Microphone" },
    { deviceId: "speaker-1", kind: "audiooutput", label: "Speaker" },
  ];
  const disableAudio = vi.fn(async () => {
    audioEnabled = false;
  });
  const disableVideo = vi.fn(async () => {
    videoEnabled = false;
  });
  const enableScreenShare = vi.fn(async () => {
    screenShareEnabled = true;
  });
  const disableScreenShare = vi.fn(async () => {
    screenShareEnabled = false;
  });
  const setDevice = vi.fn(async () => undefined);
  const self = {
    id: "local-1",
    name: "Local participant",
    on: vi.fn(),
    off: vi.fn(),
    setName: vi.fn(),
    getAllDevices: vi.fn(async () => devices),
    getDeviceById: vi.fn(async (deviceId: string) => devices.find((device) => device.deviceId === deviceId) ?? devices[0]!),
    setDevice,
    enableAudio: vi.fn(async () => {
      audioEnabled = true;
    }),
    disableAudio,
    enableVideo: vi.fn(async () => {
      videoEnabled = true;
    }),
    disableVideo,
    enableScreenShare,
    disableScreenShare,
  };
  Object.defineProperties(self, {
    audioEnabled: { get: () => audioEnabled },
    videoEnabled: { get: () => videoEnabled },
    screenShareEnabled: { get: () => screenShareEnabled },
  });
  return {
    self: self as RealtimeKitSelf,
    disableAudio,
    disableVideo,
    enableScreenShare,
    disableScreenShare,
    setDevice,
  };
}

function createMeeting(self: RealtimeKitSelf): RealtimeKitMeeting {
  return {
    self,
    participants: {
      on: vi.fn(),
      off: vi.fn(),
      joined: {
        on: vi.fn(),
        off: vi.fn(),
        get: () => undefined,
        toArray: () => [],
      },
    },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
  };
}
