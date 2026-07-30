import { describe, expect, it, vi } from "vitest";
import type { RealtimeKitDevice, RealtimeKitEventHandler, RealtimeKitMeeting, RealtimeKitParticipant, RealtimeKitSelf } from "./realtimekit-ports";
import { ChalkSession } from "./realtimekit-runtime";

class FakeEventSource {
  readonly handlers = new Map<string, Set<RealtimeKitEventHandler>>();

  on(event: string, handler: RealtimeKitEventHandler): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: RealtimeKitEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  listenerCount(): number {
    return [...this.handlers.values()].reduce((count, handlers) => count + handlers.size, 0);
  }
}

describe("ChalkSession RealtimeKit runtime", () => {
  it("joins the native meeting and projects media, participants, and devices", async () => {
    const harness = createMeetingHarness();
    const init = vi.fn(async () => harness.meeting);
    const fetchImplementation = admissionFetch();
    const session = new ChalkSession({
      apiUrl: "https://api.test",
      token: " participant-token ",
      realtimeKitLoader: async () => ({ init }),
      fetch: fetchImplementation,
    });
    const connected = vi.fn();
    session.on("connected", connected);

    await session.join("room-1", { userName: "Hasan", audioEnabled: false, videoEnabled: true });
    await vi.waitFor(() => expect(session.media.getState().devices).toHaveLength(3));

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: "rtk-token",
        defaults: { audio: false, video: true },
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.test/api/v1/rooms/room-1/participants",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer participant-token" }),
        body: JSON.stringify({ display_name: "Hasan", role: "participant" }),
      }),
    );
    expect(harness.setName).toHaveBeenCalledWith("Hasan");
    expect(harness.join).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledOnce();
    expect(session.room.getState()).toMatchObject({ roomId: "room-1", roomName: "Team room", status: "connected", rtkMeeting: harness.meeting });
    expect(session.participants.getState()).toMatchObject({
      count: 2,
      localParticipant: { id: "local-1", displayName: "Local participant" },
    });
    expect(session.media.getState()).toMatchObject({
      cameras: [{ id: "camera-1", label: "Front camera", kind: "camera" }],
      microphones: [{ id: "microphone-1", label: "Microphone", kind: "microphone" }],
      speakers: [{ id: "speaker-1", label: "Speaker", kind: "speaker" }],
      isAudioEnabled: true,
      isVideoEnabled: true,
    });

    harness.participants.emit("activeSpeaker", { peerId: "remote-1" });
    expect(session.participants.getState().activeSpeaker?.id).toBe("remote-1");

    harness.meta.emit("socketConnectionUpdate", { state: "reconnecting", reconnected: false, reconnectionAttempt: 1 });
    expect(session.room.getState().status).toBe("reconnecting");
    harness.meta.emit("socketConnectionUpdate", { state: "connected", reconnected: true, reconnectionAttempt: 1 });
    expect(session.room.getState().status).toBe("connected");
  });

  it("drives RealtimeKit media controls and removes listeners on leave", async () => {
    const harness = createMeetingHarness();
    const session = new ChalkSession({
      apiUrl: "https://api.test",
      tokenProvider: async () => "provider-token",
      realtimeKitLoader: async () => ({ init: async () => harness.meeting }),
      fetch: admissionFetch(),
    });

    await session.join("room-1", { userName: "Hasan" });
    expect(await session.media.toggleAudio()).toBe(false);
    expect(harness.disableAudio).toHaveBeenCalledOnce();
    expect(await session.media.toggleVideo()).toBe(false);
    expect(harness.disableVideo).toHaveBeenCalledOnce();
    expect(await session.screenShare.start()).toBe(true);
    expect(harness.enableScreenShare).toHaveBeenCalledOnce();
    expect(session.screenShare.getState()).toMatchObject({ isActive: true, isLocalSharing: true });

    expect(totalListeners(harness)).toBeGreaterThan(0);
    await session.leave();

    expect(harness.leave).toHaveBeenCalledOnce();
    expect(totalListeners(harness)).toBe(0);
    expect(session.room.getState().status).toBe("disconnected");
    expect(session.participants.getState().count).toBe(0);
  });

  it("leaves an active RealtimeKit meeting when the provider disposes its session", async () => {
    const harness = createMeetingHarness();
    const session = new ChalkSession({
      apiUrl: "https://api.test",
      token: "participant-token",
      realtimeKitLoader: async () => ({ init: async () => harness.meeting }),
      fetch: admissionFetch(),
    });

    await session.join("room-1", { userName: "Hasan" });
    expect(totalListeners(harness)).toBeGreaterThan(0);

    session.dispose();
    session.dispose();

    await vi.waitFor(() => expect(harness.leave).toHaveBeenCalledOnce());
    expect(totalListeners(harness)).toBe(0);
    expect(session.participants.getState().count).toBe(0);
  });

  it("fails closed when media credentials or canonical capabilities are unavailable", async () => {
    const harness = createMeetingHarness();
    const session = new ChalkSession({
      apiUrl: "https://api.test",
      realtimeKitLoader: async () => ({ init: async () => harness.meeting }),
      fetch: admissionFetch(),
    });
    const error = vi.fn();
    session.on("error", error);

    await expect(session.join("room-1", { userName: "Hasan" })).rejects.toThrow("Chalk access token");
    expect(session.room.getState()).toMatchObject({ status: "failed", roomId: "room-1" });
    expect(session.room.getRoom()).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    await expect(session.createSession()).rejects.toThrow("unavailable");
    expect(() => session.muteParticipant("participant-1")).toThrow("canonical session store");
    expect(() => session.interactions.raiseHand()).toThrow("canonical session store");
  });

  it("does not reconnect after leave cancels an in-flight native join", async () => {
    let finishJoin: (() => void) | undefined;
    const harness = createMeetingHarness(
      () =>
        new Promise<void>((resolve) => {
          finishJoin = resolve;
        }),
    );
    const session = new ChalkSession({
      apiUrl: "https://api.test",
      token: "participant-token",
      realtimeKitLoader: async () => ({ init: async () => harness.meeting }),
      fetch: admissionFetch(),
    });

    const join = session.join("room-1", { userName: "Hasan" });
    await vi.waitFor(() => expect(harness.join).toHaveBeenCalledOnce());
    await session.leave();
    finishJoin?.();

    await expect(join).rejects.toThrow("cancelled");
    expect(harness.leave).toHaveBeenCalledOnce();
    expect(session.room.getState().status).toBe("disconnected");
  });

  it("surfaces participant admission failures without initializing RealtimeKit", async () => {
    const harness = createMeetingHarness();
    const init = vi.fn(async () => harness.meeting);
    const session = new ChalkSession({
      apiUrl: "https://api.test/",
      token: "expired-access-token",
      realtimeKitLoader: async () => ({ init }),
      fetch: vi.fn(async () => new Response(JSON.stringify({ message: "Participant access expired" }), { status: 401 })),
    });

    await expect(session.join("room with spaces", { userName: "Hasan" })).rejects.toThrow("Participant access expired");
    expect(init).not.toHaveBeenCalled();
    expect(session.room.getState()).toMatchObject({
      status: "failed",
      error: "Participant access expired",
      roomId: "room with spaces",
    });
  });
});

function createMeetingHarness(joinImplementation: () => Promise<void> = async () => undefined) {
  const selfEvents = new FakeEventSource();
  const participants = new FakeEventSource();
  const joined = new FakeEventSource();
  const meta = new FakeEventSource();
  const remoteParticipants: RealtimeKitParticipant[] = [
    participant(joined, {
      id: "remote-1",
      name: "Remote participant",
      audioEnabled: true,
      videoEnabled: false,
    }),
  ];
  let audioEnabled = true;
  let videoEnabled = true;
  let screenShareEnabled = false;
  const devices: RealtimeKitDevice[] = [
    { deviceId: "camera-1", kind: "videoinput", label: "Front camera" },
    { deviceId: "microphone-1", kind: "audioinput", label: "Microphone" },
    { deviceId: "speaker-1", kind: "audiooutput", label: "Speaker" },
  ];
  const setName = vi.fn();
  const disableAudio = vi.fn(async () => {
    audioEnabled = false;
  });
  const disableVideo = vi.fn(async () => {
    videoEnabled = false;
  });
  const enableScreenShare = vi.fn(async () => {
    screenShareEnabled = true;
  });
  const selfBase = Object.assign(selfEvents, {
    id: "local-1",
    name: "Local participant",
    isHost: true,
    setName,
    getAllDevices: vi.fn(async () => devices),
    getDeviceById: vi.fn(async (deviceId: string) => devices.find((device) => device.deviceId === deviceId) ?? devices[0]!),
    setDevice: vi.fn(async () => undefined),
    enableAudio: vi.fn(async () => {
      audioEnabled = true;
    }),
    disableAudio,
    enableVideo: vi.fn(async () => {
      videoEnabled = true;
    }),
    disableVideo,
    enableScreenShare,
    disableScreenShare: vi.fn(async () => {
      screenShareEnabled = false;
    }),
  });
  Object.defineProperties(selfBase, {
    audioEnabled: { get: () => audioEnabled },
    videoEnabled: { get: () => videoEnabled },
    screenShareEnabled: { get: () => screenShareEnabled },
  });
  const self = selfBase as RealtimeKitSelf;
  const joinedMap = Object.assign(joined, {
    get: (id: string) => remoteParticipants.find((candidate) => candidate.id === id),
    toArray: () => [...remoteParticipants],
  });
  const join = vi.fn(joinImplementation);
  const leave = vi.fn(async () => undefined);
  const meeting: RealtimeKitMeeting = {
    self,
    participants: Object.assign(participants, { joined: joinedMap }),
    meta: Object.assign(meta, {
      meetingId: "meeting-1",
      meetingTitle: "Team room",
      socketState: { state: "connected" as const, reconnected: false, reconnectionAttempt: 0 },
    }),
    join,
    leave,
  };

  return { meeting, selfEvents, participants, joined, meta, setName, join, leave, disableAudio, disableVideo, enableScreenShare };
}

function participant(events: FakeEventSource, values: Omit<RealtimeKitParticipant, "on" | "off">): RealtimeKitParticipant {
  return Object.assign(events, values);
}

function totalListeners(harness: ReturnType<typeof createMeetingHarness>): number {
  return harness.selfEvents.listenerCount() + harness.participants.listenerCount() + harness.joined.listenerCount() + harness.meta.listenerCount();
}

function admissionFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ auth_token: "rtk-token" }), { status: 201, headers: { "content-type": "application/json" } }));
}
