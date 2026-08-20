import { beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/realtimekit-react-native", () => ({ default: { init: initialize } }));

import { createNativeRealtimeKitClient } from "./cloudflare-rtk-native";

describe("native RealtimeKit adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes, joins, leaves, and projects native participants", async () => {
    const selfOn = vi.fn();
    const selfOff = vi.fn();
    const joinedOn = vi.fn();
    const joinedOff = vi.fn();
    const joinRoom = vi.fn().mockResolvedValue(undefined);
    const leaveRoom = vi.fn().mockResolvedValue(undefined);
    const audioTrack = { kind: "audio" };
    const videoTrack = { kind: "video" };
    const participant = {
      id: "native-participant",
      userId: "user",
      customParticipantId: "custom-participant",
      audioEnabled: true,
      videoEnabled: false,
      screenShareEnabled: false,
      audioTrack,
      videoTrack: null,
      screenShareTracks: {},
    };
    const nativeClient = {
      joinRoom,
      leaveRoom,
      self: {
        peerId: "peer",
        audioEnabled: true,
        videoEnabled: false,
        screenShareEnabled: false,
        audioTrack,
        videoTrack,
        screenShareTracks: {},
        enableAudio: vi.fn().mockResolvedValue(undefined),
        enableVideo: vi.fn().mockResolvedValue(undefined),
        enableScreenShare: vi.fn().mockResolvedValue(undefined),
        disableAudio: vi.fn().mockResolvedValue(undefined),
        disableVideo: vi.fn().mockResolvedValue(undefined),
        disableScreenShare: vi.fn().mockResolvedValue(undefined),
        on: selfOn,
        off: selfOff,
      },
      participants: {
        joined: {
          toArray: vi.fn(() => [participant]),
          on: joinedOn,
          off: joinedOff,
        },
      },
    };
    initialize.mockResolvedValue(nativeClient);

    const onError = vi.fn();
    const connection = await createNativeRealtimeKitClient({ authToken: "rtk-token", onError });
    await connection.join();
    await connection.leave();

    expect(initialize).toHaveBeenCalledWith({ authToken: "rtk-token", defaults: { audio: false, video: false }, onError });
    expect(joinRoom).toHaveBeenCalledOnce();
    expect(leaveRoom).toHaveBeenCalledOnce();
    expect(connection.self.peerId).toBe("peer");
    expect(connection.self.audioTrack).toBe(audioTrack);
    expect(connection.participants.joined.list()).toEqual([expect.objectContaining({ id: "native-participant", customParticipantId: "custom-participant", audioTrack })]);
  });

  it("bridges lifecycle event subscriptions and removes them", async () => {
    const selfOn = vi.fn();
    const selfOff = vi.fn();
    const joinedOn = vi.fn();
    const joinedOff = vi.fn();
    initialize.mockResolvedValue({
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      self: {
        peerId: "peer",
        audioEnabled: false,
        videoEnabled: false,
        screenShareEnabled: false,
        audioTrack: null,
        videoTrack: null,
        screenShareTracks: {},
        enableAudio: vi.fn(),
        enableVideo: vi.fn(),
        enableScreenShare: vi.fn(),
        disableAudio: vi.fn(),
        disableVideo: vi.fn(),
        disableScreenShare: vi.fn(),
        on: selfOn,
        off: selfOff,
      },
      participants: { joined: { toArray: vi.fn(() => []), on: joinedOn, off: joinedOff } },
    });

    const connection = await createNativeRealtimeKitClient({ authToken: "rtk-token", onError: vi.fn() });
    const listener = vi.fn();
    const unsubscribeAudio = connection.self.onAudioUpdate(listener);
    const unsubscribeJoined = connection.participants.joined.onJoined(listener);

    unsubscribeAudio();
    unsubscribeJoined();

    expect(selfOn).toHaveBeenCalledWith("audioUpdate", listener);
    expect(selfOff).toHaveBeenCalledWith("audioUpdate", listener);
    expect(joinedOn).toHaveBeenCalledWith("participantJoined", expect.any(Function));
    expect(joinedOff).toHaveBeenCalledWith("participantJoined", expect.any(Function));
  });
});
