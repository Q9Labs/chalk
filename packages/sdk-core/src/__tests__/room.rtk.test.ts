/**
 * RTK identity mapping tests
 * Ensures stable participant IDs (userId/client_specific_id) drive join/leave and active speaker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConferenceSession } from "../room.ts";

const createMockRtkClient = () => {
  const makeEmitter = () => {
    const handlers = new Map<string, Set<(payload: any) => void>>();
    return {
      on: (event: string, handler: (payload: any) => void) => {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return () => set.delete(handler);
      },
      emit: (event: string, payload?: any) => {
        const set = handlers.get(event);
        if (!set) return;
        for (const h of set) h(payload);
      },
    };
  };

  const self = makeEmitter();
  self.audioEnabled = true;
  self.audioTrack = {} as any;
  self.enableAudio = vi.fn(async () => {
    self.audioEnabled = true;
    self.audioTrack = {} as any;
  });
  self.disableAudio = vi.fn(async () => {
    self.audioEnabled = false;
    self.audioTrack = null;
  });

  const joinedParticipants = new Map<string, any>();
  const rawJoined = makeEmitter();
  const joined = {
    on: rawJoined.on,
    emit: (event: string, payload?: any) => {
      if (event === "participantJoined" && payload?.id) {
        joinedParticipants.set(payload.id, payload);
      } else if (event === "participantLeft" && payload?.id) {
        joinedParticipants.delete(payload.id);
      } else if ((event === "videoUpdate" || event === "audioUpdate" || event === "screenShareUpdate") && payload?.id) {
        const prev = joinedParticipants.get(payload.id) ?? { id: payload.id };
        joinedParticipants.set(payload.id, { ...prev, ...payload });
      }
      rawJoined.emit(event, payload);
    },
    values: () => joinedParticipants.values(),
    forEach: (cb: (participant: any) => void) => joinedParticipants.forEach(cb),
    setSnapshot: (participants: any[]) => {
      joinedParticipants.clear();
      for (const participant of participants) {
        if (participant?.id) {
          joinedParticipants.set(participant.id, participant);
        }
      }
    },
  };
  const participantsEmitter = makeEmitter();
  const participants = {
    joined,
    toArray: () => Array.from(joinedParticipants.values()),
    on: (event: string, handler: (payload: any) => void) => participantsEmitter.on(event, handler),
    emit: (event: string, payload?: any) => participantsEmitter.emit(event, payload),
  };

  return {
    self,
    participants,
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
  };
};

const createMockWsClient = () => {
  const handlers = new Map<string, Set<(payload: any) => void>>();
  return {
    connectionState: "connected" as const,
    on: (event: string, handler: (payload: any) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit: (event: string, payload?: any) => {
      const set = handlers.get(event);
      if (!set) return;
      for (const h of set) h(payload);
    },
    raiseHand: vi.fn(() => {}),
    lowerHand: vi.fn(() => {}),
    muteParticipant: vi.fn(() => {}),
    unmuteParticipant: vi.fn(() => {}),
  };
};

describe("ConferenceSession (RTK identity mapping)", () => {
  let rtk: any;
  let room: ConferenceSession;

  beforeEach(() => {
    rtk = createMockRtkClient();
    room = new ConferenceSession("room_123", rtk as any, false);
  });

  it("does not duplicate local participant when RTK includes self in participantJoined", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    rtk.participants.joined.emit("participantJoined", {
      id: "peer_self",
      userId: "uuid_local",
      name: "Me",
    });

    expect(room.participants.size).toBe(1);
    expect(room.participants.get("uuid_local")?.isLocal).toBe(true);
  });

  it("removes remote participant on participantLeft using stable userId", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    rtk.participants.joined.emit("participantJoined", {
      id: "peer_a",
      userId: "uuid_a",
      name: "Alice",
    });

    expect(room.participants.has("uuid_a")).toBe(true);

    let leftId: string | null = null;
    room.on("participant.left", (id) => {
      leftId = id;
    });

    rtk.participants.joined.emit("participantLeft", {
      id: "peer_a",
      userId: "uuid_a",
    });

    expect(leftId).toBe("uuid_a");
    expect(room.participants.has("uuid_a")).toBe(false);
  });

  it("maps activeSpeakerChanged to stable participant id", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_a",
      userId: "uuid_a",
      name: "Alice",
    });

    let emitted: any = null;
    room.on("speaker.active.changed", (p) => {
      emitted = p;
    });

    rtk.participants.emit("activeSpeakerChanged", {
      id: "peer_a",
      userId: "uuid_a",
    });

    expect(room.activeSpeaker?.id).toBe("uuid_a");
    expect(emitted?.id).toBe("uuid_a");
  });

  it("uses peerId->stableId mapping when update payloads omit userId", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_a",
      userId: "uuid_a",
      name: "Alice",
      videoEnabled: false,
    });

    rtk.participants.joined.emit("videoUpdate", {
      id: "peer_a",
      // no userId
      videoEnabled: true,
      videoTrack: {} as any,
    });

    expect(room.participants.get("uuid_a")?.videoEnabled).toBe(true);
  });

  it("recovers remote participant from update events when participantJoined is missed", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    let joinedId: string | null = null;
    room.on("participant.joined", (participant) => {
      joinedId = participant.id;
    });

    // Simulate dropped "participantJoined" event; only media update arrives.
    rtk.participants.joined.emit("videoUpdate", {
      id: "peer_b",
      userId: "uuid_b",
      name: "Bob",
      videoEnabled: true,
      videoTrack: {} as any,
    });

    expect(joinedId).toBe("uuid_b");
    expect(room.participants.has("uuid_b")).toBe(true);
    expect(room.participants.get("uuid_b")?.videoEnabled).toBe(true);
  });

  it("recovers remote participant from participantsUpdate snapshot when join event is missed", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_c",
        userId: "uuid_c",
        name: "Carol",
        videoEnabled: false,
        audioEnabled: false,
      },
    ]);

    let joinedId: string | null = null;
    room.on("participant.joined", (participant) => {
      joinedId = participant.id;
    });

    rtk.participants.joined.emit("participantsUpdate");

    expect(joinedId).toBe("uuid_c");
    expect(room.participants.has("uuid_c")).toBe(true);
  });

  it("prunes stale remotes and hydrates missed joins on roomJoined snapshot", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    rtk.participants.joined.emit("participantJoined", {
      id: "peer_a",
      userId: "uuid_a",
      name: "Alice",
    });
    expect(room.participants.has("uuid_a")).toBe(true);

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_b",
        userId: "uuid_b",
        name: "Bob",
        videoEnabled: false,
        audioEnabled: true,
      },
    ]);

    rtk.self.emit("roomJoined");

    expect(room.participants.has("uuid_a")).toBe(false);
    expect(room.participants.has("uuid_b")).toBe(true);
  });

  it("recovers remote participant from participants.toArray when joined iterators are unavailable", () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    delete (rtk.participants.joined as any).values;
    delete (rtk.participants.joined as any).forEach;

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_t",
        userId: "uuid_t",
        name: "Taylor",
        videoEnabled: false,
        audioEnabled: true,
      },
    ]);

    let joinedId: string | null = null;
    room.on("participant.joined", (participant) => {
      joinedId = participant.id;
    });

    rtk.participants.emit("participantsUpdate");

    expect(joinedId).toBe("uuid_t");
    expect(room.participants.has("uuid_t")).toBe(true);
  });

  it("heals screen share state from participantsUpdate when screenShareUpdate is missed", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_s",
      userId: "uuid_s",
      name: "Sharer",
      screenShareEnabled: false,
    });

    expect(room.participants.get("uuid_s")?.isScreenSharing).toBe(false);

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_s",
        userId: "uuid_s",
        name: "Sharer",
        screenShareEnabled: true,
        screenShareTracks: {
          video: {} as any,
        },
      },
    ]);

    rtk.participants.joined.emit("participantsUpdate");

    expect(room.participants.get("uuid_s")?.isScreenSharing).toBe(true);
    expect(room.participants.get("uuid_s")?.screenShareTrack).toBeTruthy();
  });

  it("heals screen share state from participants emitter updates via toArray fallback", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_z",
      userId: "uuid_z",
      name: "Zara",
      screenShareEnabled: false,
    });

    delete (rtk.participants.joined as any).values;
    delete (rtk.participants.joined as any).forEach;

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_z",
        userId: "uuid_z",
        name: "Zara",
        screenShareEnabled: true,
        screenShareTracks: {
          video: {} as any,
        },
      },
    ]);

    rtk.participants.emit("participantsUpdate");

    expect(room.participants.get("uuid_z")?.isScreenSharing).toBe(true);
    expect(room.participants.get("uuid_z")?.screenShareTrack).toBeTruthy();
  });

  it("treats remote screen share tracks as active even when the RTK flag is stale", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_s2",
      userId: "uuid_s2",
      name: "Sharer",
      screenShareEnabled: false,
    });

    rtk.participants.joined.setSnapshot([
      {
        id: "peer_s2",
        userId: "uuid_s2",
        name: "Sharer",
        screenShareEnabled: false,
        screenShareTracks: {
          video: { id: "track_screen_1", readyState: "live", enabled: true } as any,
        },
      },
    ]);

    rtk.participants.emit("participantsUpdate");

    expect(room.participants.get("uuid_s2")?.isScreenSharing).toBe(true);
    expect(room.participants.get("uuid_s2")?.screenShareTrack).toBeTruthy();
  });

  it("applies remote screen share track updates from the direct screenShareUpdate event", () => {
    rtk.participants.joined.emit("participantJoined", {
      id: "peer_remote_share",
      userId: "uuid_remote_share",
      name: "Remote Sharer",
      screenShareEnabled: false,
    });

    expect(room.participants.get("uuid_remote_share")?.isScreenSharing).toBe(false);

    rtk.participants.joined.emit("screenShareUpdate", {
      id: "peer_remote_share",
      userId: "uuid_remote_share",
      name: "Remote Sharer",
      screenShareEnabled: true,
      screenShareTracks: {
        video: { id: "track_remote_share_1", readyState: "live", enabled: true } as any,
      },
    });

    expect(room.participants.get("uuid_remote_share")?.isScreenSharing).toBe(true);
    expect(room.participants.get("uuid_remote_share")?.screenShareTrack).toBeTruthy();
  });

  it("applies host mute/unmute commands to local audio when addressed to local participant", async () => {
    const ws = createMockWsClient();
    room.attachWsClient(ws as any);

    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: true,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    ws.emit("participant.mute", { participantId: "uuid_local" });
    await new Promise((r) => setTimeout(r, 0));

    expect(rtk.self.disableAudio).toHaveBeenCalled();
    expect(room.localParticipant?.audioEnabled).toBe(false);

    ws.emit("participant.unmute", { participantId: "uuid_local" });
    await new Promise((r) => setTimeout(r, 0));

    expect(rtk.self.enableAudio).toHaveBeenCalled();
    expect(room.localParticipant?.audioEnabled).toBe(true);
  });

  it("sends mute/unmute commands over WS when local participant is host", () => {
    const ws = createMockWsClient();
    room.attachWsClient(ws as any);

    room._setLocalParticipant({
      id: "uuid_host",
      userId: "uuid_host",
      displayName: "Host",
      role: "host",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: true,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    room.muteParticipant("uuid_a");
    room.unmuteParticipant("uuid_a");

    expect(ws.muteParticipant).toHaveBeenCalledWith("uuid_a");
    expect(ws.unmuteParticipant).toHaveBeenCalledWith("uuid_a");
  });

  it("replays a pending hand raise once WS reconnects", () => {
    const ws = createMockWsClient();
    ws.connectionState = "reconnecting";
    room.attachWsClient(ws as any);

    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: true,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    room.raiseHand();

    expect(room.localParticipant?.handRaised).toBe(true);
    expect(ws.raiseHand).not.toHaveBeenCalled();

    ws.connectionState = "connected";
    ws.emit("connected");

    expect(ws.raiseHand).toHaveBeenCalledTimes(1);
  });

  it("relies on RTK internal reconnect when roomLeft reports a disconnect", async () => {
    room._setStatus("connected");

    rtk.self.emit("roomLeft", { state: "disconnected" });

    expect(room.status).toBe("reconnecting");

    rtk.self.emit("roomJoined", { reconnected: true });
    expect(room.status).toBe("connected");
    expect(rtk.join).not.toHaveBeenCalled();
  });

  it("surfaces a failed RTK reconnect as a terminal connection error", () => {
    room._setStatus("connected");

    let emittedError: any = null;
    room.on("error", (error) => {
      emittedError = error;
    });

    rtk.self.emit("roomLeft", { state: "failed" });

    expect(room.status).toBe("failed");
    expect(emittedError).toMatchObject({
      code: "CONNECTION_FAILED",
      message: "Connection lost and could not be restored",
      details: {
        transport: "rtk",
        roomId: "room_123",
        roomState: "failed",
      },
    });
  });

  it("does not reconnect RTK when leave flow triggers roomLeft", async () => {
    room._setStatus("connected");
    rtk.leave.mockImplementation(async () => {
      rtk.self.emit("roomLeft");
    });

    await room.leave();

    expect(rtk.join).not.toHaveBeenCalled();
    expect(room.status).toBe("disconnected");
  });

  it("suspends background effects when local video becomes unavailable", async () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: true,
      videoTrack: {
        enabled: true,
        readyState: "live",
      } as MediaStreamTrack,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    const suspendBackgroundEffect = vi.fn(async () => true);
    const reapplyBackgroundEffect = vi.fn(async () => true);
    const hasSelectedBackgroundEffect = vi.fn(() => true);
    (room as any).mediaController.hasSelectedBackgroundEffect = hasSelectedBackgroundEffect;
    (room as any).mediaController.suspendBackgroundEffect = suspendBackgroundEffect;
    (room as any).mediaController.reapplyBackgroundEffect = reapplyBackgroundEffect;

    rtk.self.emit("videoUpdate", {
      videoEnabled: false,
      videoTrack: null,
    });

    await Promise.resolve();

    expect(suspendBackgroundEffect).toHaveBeenCalledTimes(1);
    expect(reapplyBackgroundEffect).not.toHaveBeenCalled();
    expect(hasSelectedBackgroundEffect).toHaveBeenCalledTimes(1);

    rtk.self.emit("videoUpdate", {
      videoEnabled: false,
      videoTrack: null,
    });

    await Promise.resolve();

    expect(suspendBackgroundEffect).toHaveBeenCalledTimes(1);
  });

  it("reapplies background effects when RTK publishes a fresh live local video track", async () => {
    room._setLocalParticipant({
      id: "uuid_local",
      userId: "uuid_local",
      displayName: "Me",
      role: "participant",
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
    });

    const suspendBackgroundEffect = vi.fn(async () => true);
    const reapplyBackgroundEffect = vi.fn(async () => true);
    const hasSelectedBackgroundEffect = vi.fn(() => true);
    (room as any).mediaController.hasSelectedBackgroundEffect = hasSelectedBackgroundEffect;
    (room as any).mediaController.suspendBackgroundEffect = suspendBackgroundEffect;
    (room as any).mediaController.reapplyBackgroundEffect = reapplyBackgroundEffect;

    rtk.self.emit("videoUpdate", {
      videoEnabled: true,
      videoTrack: {
        enabled: true,
        readyState: "live",
      } as MediaStreamTrack,
    });

    await Promise.resolve();

    expect(reapplyBackgroundEffect).toHaveBeenCalledTimes(1);
    expect(suspendBackgroundEffect).not.toHaveBeenCalled();
    expect(hasSelectedBackgroundEffect).toHaveBeenCalledTimes(1);
  });
});
