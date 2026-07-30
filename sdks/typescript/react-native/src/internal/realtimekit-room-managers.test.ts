import { describe, expect, it, vi } from "vitest";

import { connectionState, ParticipantsManager, RoomManager, UIManager } from "./realtimekit-room-managers";
import type { RealtimeKitMeeting, RealtimeKitParticipant, RealtimeKitSelf } from "./realtimekit-ports";

describe("RealtimeKit room managers", () => {
  it("moves rooms through connecting, connected, reconnecting, and disconnected states", () => {
    const meeting = createMeeting();
    const manager = new RoomManager();

    manager.connecting("room-1", "Pending room");
    expect(manager.getState()).toMatchObject({ status: "connecting", isJoining: true });

    manager.connected("room-1", meeting);
    expect(manager.getState()).toMatchObject({
      status: "connected",
      roomName: "RealtimeKit room",
      hostId: "local-1",
      rtkMeeting: meeting,
    });
    expect(manager.getRoom()?.transcripts).toEqual([]);

    manager.reconnecting();
    expect(manager.getState().status).toBe("reconnecting");
    manager.disconnected();
    expect(manager.getState()).toMatchObject({ status: "disconnected", roomId: "room-1" });
    expect(connectionState("failed")).toBe("failed");
  });

  it("projects local and remote participants and resolves active speakers", () => {
    const meeting = createMeeting();
    const manager = new ParticipantsManager();

    manager.setLocalRole("host");
    manager.sync(meeting);
    expect(manager.getState()).toMatchObject({
      count: 2,
      localParticipant: { id: "local-1", role: "host" },
    });

    manager.setActiveSpeaker(meeting, { peerId: "remote-1" });
    expect(manager.getState().activeSpeaker?.id).toBe("remote-1");

    manager.reset();
    expect(manager.getState()).toMatchObject({ count: 0, localParticipant: null });
  });

  it("updates layout, panels, controls, and fullscreen state", async () => {
    const manager = new UIManager();

    manager.toggleLayout();
    manager.openPanel("whiteboard");
    manager.hideControls();
    await manager.toggleFullscreen();

    expect(manager.getState()).toMatchObject({
      layout: "speaker",
      activePanel: "whiteboard",
      controlsVisible: false,
      isFullscreen: true,
    });
    manager.togglePanel("whiteboard");
    manager.showControls();
    expect(manager.getState()).toMatchObject({ activePanel: null, controlsVisible: true });
  });
});

function createMeeting(): RealtimeKitMeeting {
  const remote: RealtimeKitParticipant = {
    id: "remote-1",
    name: "Remote participant",
    audioEnabled: true,
    videoEnabled: false,
    on: vi.fn(),
    off: vi.fn(),
  };
  const self: RealtimeKitSelf = {
    id: "local-1",
    name: "Local participant",
    isHost: true,
    audioEnabled: true,
    videoEnabled: true,
    on: vi.fn(),
    off: vi.fn(),
    setName: vi.fn(),
    getAllDevices: vi.fn(async () => []),
    getDeviceById: vi.fn(async () => ({ deviceId: "device-1", kind: "audioinput", label: "Device" })),
    setDevice: vi.fn(async () => undefined),
    enableAudio: vi.fn(async () => undefined),
    disableAudio: vi.fn(async () => undefined),
    enableVideo: vi.fn(async () => undefined),
    disableVideo: vi.fn(async () => undefined),
    enableScreenShare: vi.fn(async () => undefined),
    disableScreenShare: vi.fn(async () => undefined),
  };
  return {
    self,
    participants: {
      on: vi.fn(),
      off: vi.fn(),
      joined: {
        on: vi.fn(),
        off: vi.fn(),
        get: (id) => (id === remote.id ? remote : undefined),
        toArray: () => [remote],
      },
    },
    meta: {
      on: vi.fn(),
      off: vi.fn(),
      meetingTitle: "RealtimeKit room",
    },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
  };
}
