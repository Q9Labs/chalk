import { describe, expect, it, vi } from "vitest";
import { parseParsedAccessGrant, type ParticipantMediaAccess } from "../access/grant";
import { CloudflareRTKClient, type CloudflareRTKClientFactory, type CloudflareRTKConnection, type CloudflareRTKJoinedParticipants, type CloudflareRTKParticipant, type CloudflareRTKSelf } from "./rtk";

describe("CloudflareRTKClient", () => {
  it("initializes RealtimeKit, joins, and publishes prepared audio and video tracks", async () => {
    const connection = new FakeConnection();
    const factory = factoryFor(connection);
    const client = new CloudflareRTKClient({ authToken: "rtk-token-1", participantId: "participant-1", clientFactory: factory });
    const audio = fakeTrack("audio");
    const video = fakeTrack("video");

    await client.start(stream(audio, video));

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ authToken: "rtk-token-1" }));
    expect(connection.join).toHaveBeenCalledOnce();
    expect(connection.self.audioTrack).toBe(audio);
    expect(connection.self.videoTrack).toBe(video);
    expect(client.getSnapshot()).toMatchObject({
      connection: { phase: "live" },
      localTracks: [
        { source: "microphone", enabled: true },
        { source: "camera", enabled: true },
      ],
    });
  });

  it("projects joined participants and controls screen publication through the RTK client", async () => {
    const connection = new FakeConnection();
    const client = new CloudflareRTKClient({ authToken: "rtk-token-1", participantId: "participant-1", clientFactory: factoryFor(connection) });
    await client.start(emptyStream());
    const screen = fakeTrack("video");
    client.prepareLocalTrack("screen", screen);

    const outcome = await client.setLocalPublicationTarget({ operationId: "operation-1", participantId: "participant-1", source: "screen", enabled: true });
    expect(outcome).toEqual({ outcome: "confirmed", errorCode: null });
    expect(connection.self.enableScreenShare).toHaveBeenCalledOnce();

    connection.participants.joined.add({
      id: "peer-2",
      userId: "user-2",
      customParticipantId: "participant-2",
      audioEnabled: true,
      videoEnabled: false,
      screenShareEnabled: false,
      audioTrack: fakeTrack("audio"),
      videoTrack: null,
      screenShareTracks: {},
    });
    expect(client.getSnapshot().remoteTracks).toEqual([expect.objectContaining({ participantId: "participant-2", source: "microphone" })]);
  });

  it("restarts with the provider token from a refreshed RTK grant", async () => {
    const firstConnection = new FakeConnection();
    const secondConnection = new FakeConnection();
    const factory = vi.fn<CloudflareRTKClientFactory>().mockResolvedValueOnce(firstConnection).mockResolvedValueOnce(secondConnection);
    const client = new CloudflareRTKClient({ authToken: "rtk-token-1", participantId: "participant-1", clientFactory: factory });
    await client.start(emptyStream());

    await client.restart(mediaAccess("rtk-token-2"));

    expect(firstConnection.leave).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ authToken: "rtk-token-2" }));
    expect(secondConnection.join).toHaveBeenCalledOnce();
    expect(client.getSnapshot().connection.phase).toBe("live");
  });
});

class FakeSelf implements CloudflareRTKSelf {
  readonly peerId = "peer-1";
  audioEnabled = false;
  videoEnabled = false;
  screenShareEnabled = false;
  audioTrack: MediaStreamTrack | null = null;
  videoTrack: MediaStreamTrack | null = null;
  screenShareTracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack } = {};
  readonly enableAudio = vi.fn(async (track?: MediaStreamTrack) => {
    this.audioEnabled = true;
    this.audioTrack = track ?? this.audioTrack;
    this.#audioListeners.forEach((listener) => listener({ audioEnabled: true, audioTrack: this.audioTrack! }));
  });
  readonly enableVideo = vi.fn(async (track?: MediaStreamTrack) => {
    this.videoEnabled = true;
    this.videoTrack = track ?? this.videoTrack;
    this.#videoListeners.forEach((listener) => listener({ videoEnabled: true, videoTrack: this.videoTrack! }));
  });
  readonly enableScreenShare = vi.fn(async () => {
    this.screenShareEnabled = true;
    this.screenShareTracks = { video: fakeTrack("video") };
    this.#screenListeners.forEach((listener) => listener({ screenShareEnabled: true, screenShareTracks: this.screenShareTracks }));
  });
  readonly disableAudio = vi.fn(async () => {
    this.audioEnabled = false;
    this.#audioListeners.forEach((listener) => listener({ audioEnabled: false, audioTrack: this.audioTrack! }));
  });
  readonly disableVideo = vi.fn(async () => {
    this.videoEnabled = false;
    this.#videoListeners.forEach((listener) => listener({ videoEnabled: false, videoTrack: this.videoTrack! }));
  });
  readonly disableScreenShare = vi.fn(async () => {
    this.screenShareEnabled = false;
    this.screenShareTracks = {};
    this.#screenListeners.forEach((listener) => listener({ screenShareEnabled: false, screenShareTracks: {} }));
  });
  readonly #audioListeners = new Set<CloudflareRTKSelf["onAudioUpdate"] extends (listener: infer T) => unknown ? T : never>();
  readonly #videoListeners = new Set<CloudflareRTKSelf["onVideoUpdate"] extends (listener: infer T) => unknown ? T : never>();
  readonly #screenListeners = new Set<CloudflareRTKSelf["onScreenShareUpdate"] extends (listener: infer T) => unknown ? T : never>();
  readonly #leftListeners = new Set<() => void>();

  onAudioUpdate(listener: CloudflareRTKSelf["onAudioUpdate"] extends (listener: infer T) => unknown ? T : never): () => void {
    this.#audioListeners.add(listener);
    return () => this.#audioListeners.delete(listener);
  }
  onVideoUpdate(listener: CloudflareRTKSelf["onVideoUpdate"] extends (listener: infer T) => unknown ? T : never): () => void {
    this.#videoListeners.add(listener);
    return () => this.#videoListeners.delete(listener);
  }
  onScreenShareUpdate(listener: CloudflareRTKSelf["onScreenShareUpdate"] extends (listener: infer T) => unknown ? T : never): () => void {
    this.#screenListeners.add(listener);
    return () => this.#screenListeners.delete(listener);
  }
  onLeft(listener: () => void): () => void {
    this.#leftListeners.add(listener);
    return () => this.#leftListeners.delete(listener);
  }
}

class FakeJoinedParticipants implements CloudflareRTKJoinedParticipants {
  #participants: CloudflareRTKParticipant[] = [];
  #joinedListeners = new Set<(participant: CloudflareRTKParticipant) => void>();
  #leftListeners = new Set<(participant: CloudflareRTKParticipant) => void>();
  list = () => this.#participants;
  onJoined = (listener: (participant: CloudflareRTKParticipant) => void) => {
    this.#joinedListeners.add(listener);
    return () => this.#joinedListeners.delete(listener);
  };
  onLeft = (listener: (participant: CloudflareRTKParticipant) => void) => {
    this.#leftListeners.add(listener);
    return () => this.#leftListeners.delete(listener);
  };
  add(participant: CloudflareRTKParticipant): void {
    this.#participants.push(participant);
    this.#joinedListeners.forEach((listener) => listener(participant));
  }
}

class FakeConnection implements CloudflareRTKConnection {
  readonly self = new FakeSelf();
  readonly participants = { joined: new FakeJoinedParticipants() };
  readonly join = vi.fn(async () => undefined);
  readonly leave = vi.fn(async () => undefined);
}

function factoryFor(connection: CloudflareRTKConnection): CloudflareRTKClientFactory {
  return vi.fn(async () => connection);
}

function fakeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    kind,
    readyState: "live",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function emptyStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function mediaAccess(providerToken: string): ParticipantMediaAccess {
  return parseParsedAccessGrant({
    subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 1 },
    sync: { token: jwt("chalk-sync"), expires_at: "2026-08-20T00:00:00.000Z" },
    media: { token: jwt("chalk-media"), expires_at: "2026-08-20T00:00:00.000Z", provider: "cloudflare_rtk", client_payload: { provider_subject: "participant-1", token: providerToken } },
  }).media;
}

function jwt(audience: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ aud: audience })}.signature`;
}
