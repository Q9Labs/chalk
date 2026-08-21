import type { RTKParticipant } from "@cloudflare/realtimekit";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { ParticipantMediaAccess } from "../access/grant";
import { observePublications, subscribeSnapshot } from "./observers";
import type { ConnectionMediaLocalTrack, ConnectionMediaRemoteTrack, ConnectionMediaSnapshot, MediaPlaneResult, MediaPlaneTarget, MediaPublication, MediaSource } from "./plane";
import { resolveMediaTarget } from "./target";

type CloudflareRTKSelfAudioUpdate = {
  readonly audioEnabled: boolean;
  readonly audioTrack: MediaStreamTrack;
};

type CloudflareRTKSelfVideoUpdate = {
  readonly videoEnabled: boolean;
  readonly videoTrack: MediaStreamTrack;
};

type CloudflareRTKSelfScreenShareUpdate = {
  readonly screenShareEnabled: boolean;
  readonly screenShareTracks: {
    readonly audio?: MediaStreamTrack;
    readonly video?: MediaStreamTrack;
  };
};

export type CloudflareRTKParticipant = {
  readonly id: string;
  readonly userId: string;
  readonly customParticipantId?: string;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly screenShareEnabled: boolean;
  readonly audioTrack: MediaStreamTrack | null;
  readonly videoTrack: MediaStreamTrack | null;
  readonly screenShareTracks: {
    readonly audio?: MediaStreamTrack;
    readonly video?: MediaStreamTrack;
  };
  readonly onAudioUpdate?: (listener: () => void) => () => void;
  readonly onVideoUpdate?: (listener: () => void) => () => void;
  readonly onScreenShareUpdate?: (listener: () => void) => () => void;
};

export type CloudflareRTKSelf = {
  readonly peerId: string;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly screenShareEnabled: boolean;
  readonly audioTrack: MediaStreamTrack | null;
  readonly videoTrack: MediaStreamTrack | null;
  readonly screenShareTracks: {
    readonly audio?: MediaStreamTrack;
    readonly video?: MediaStreamTrack;
  };
  readonly enableAudio: (customTrack?: MediaStreamTrack) => Promise<void>;
  readonly enableVideo: (customTrack?: MediaStreamTrack) => Promise<void>;
  readonly enableScreenShare: () => Promise<void>;
  readonly disableAudio: () => Promise<void>;
  readonly disableVideo: () => Promise<void>;
  readonly disableScreenShare: () => Promise<void>;
  readonly onAudioUpdate: (listener: (payload: CloudflareRTKSelfAudioUpdate) => void) => () => void;
  readonly onVideoUpdate: (listener: (payload: CloudflareRTKSelfVideoUpdate) => void) => () => void;
  readonly onScreenShareUpdate: (listener: (payload: CloudflareRTKSelfScreenShareUpdate) => void) => () => void;
  readonly onLeft: (listener: () => void) => () => void;
};

export type CloudflareRTKJoinedParticipants = {
  readonly list: () => readonly CloudflareRTKParticipant[];
  readonly onJoined: (listener: (participant: CloudflareRTKParticipant) => void) => () => void;
  readonly onLeft: (listener: (participant: CloudflareRTKParticipant) => void) => () => void;
};

export type CloudflareRTKConnection = {
  readonly self: CloudflareRTKSelf;
  readonly participants: { readonly joined: CloudflareRTKJoinedParticipants };
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
};

export type CloudflareRTKClientFactory = (input: { readonly authToken: string; readonly onError: (error: unknown) => void }) => Promise<CloudflareRTKConnection>;

export type CloudflareRTKClientOptions = {
  readonly authToken: string;
  readonly participantId: string;
  readonly onError?: (error: unknown) => void;
  readonly onScreenEnded?: () => void;
  readonly clientFactory?: CloudflareRTKClientFactory;
};

export type CloudflareRTKErrorCode = "invalid_client" | "invalid_participant" | "invalid_target" | "media_failed" | "media_stopped" | "stale_generation";

export class CloudflareRTKError extends Error {
  readonly code: CloudflareRTKErrorCode;

  constructor(message: string, code: CloudflareRTKErrorCode) {
    super(message);
    this.name = "CloudflareRTKError";
    this.code = code;
  }
}

type LocalTrackState = {
  readonly source: MediaSource;
  readonly track: MediaStreamTrack;
  enabled: boolean;
  readonly endedListener: (() => void) | null;
};

const EMPTY_LOCAL: readonly ConnectionMediaLocalTrack[] = Object.freeze([]);
const EMPTY_REMOTE: readonly ConnectionMediaRemoteTrack[] = Object.freeze([]);

export class CloudflareRTKClient {
  readonly #participantId: string;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onScreenEnded: (() => void) | undefined;
  readonly #clientFactory: CloudflareRTKClientFactory;
  readonly #snapshotListeners = new Set<() => void>();
  readonly #sourceOperations = new Map<MediaSource, Promise<unknown>>();
  #connection: CloudflareRTKConnection | null = null;
  #localTracks = new Map<MediaSource, LocalTrackState>();
  #connectionUnsubscribers: readonly (() => void)[] = [];
  #participantUnsubscribers = new Map<string, readonly (() => void)[]>();
  #snapshot: ConnectionMediaSnapshot;
  #stopped = false;
  #screenDisableRequested = false;
  #initialAuthToken: string;

  constructor(options: CloudflareRTKClientOptions) {
    if (!options.authToken.trim()) throw new CloudflareRTKError("A RealtimeKit auth token is required", "invalid_client");
    if (!options.participantId.trim()) throw new CloudflareRTKError("A participant ID is required", "invalid_participant");
    this.#participantId = options.participantId;
    this.#onError = options.onError;
    this.#onScreenEnded = options.onScreenEnded;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
    this.#snapshot = freezeSnapshot({
      connection: { phase: "idle", peerConnectionState: null, iceConnectionState: null },
      cursor: null,
      localTracks: EMPTY_LOCAL,
      remoteTracks: EMPTY_REMOTE,
      failure: null,
    });
    this.#initialAuthToken = options.authToken;
  }

  getSnapshot(): ConnectionMediaSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    return subscribeSnapshot(this.#snapshotListeners, listener);
  }

  prepareLocalTrack(source: MediaSource, track: MediaStreamTrack): void {
    this.#requireStartable();
    validateTrack(source, track);
    if (this.#localTracks.has(source)) throw new CloudflareRTKError(`A ${source} track is already prepared`, "media_failed");
    const endedListener = source === "screen" ? () => this.#onScreenEnded?.() : null;
    if (endedListener) track.addEventListener("ended", endedListener);
    this.#localTracks.set(source, { source, track, enabled: false, endedListener });
    this.#publishSnapshot();
  }

  async clearPreparedLocalTrack(source: MediaSource): Promise<void> {
    const state = this.#localTracks.get(source);
    if (!state) return;
    if (state.enabled) {
      await this.#setSourceEnabled(state, false);
    }
    if (state.endedListener) state.track.removeEventListener("ended", state.endedListener);
    this.#localTracks.delete(source);
    this.#publishSnapshot();
  }

  async start(localMedia: MediaStream): Promise<void> {
    if (this.#snapshot.connection.phase === "live") return;
    this.#requireStartable();
    this.#setPhase("connecting", null);
    try {
      const tracks = localMedia.getTracks().filter((track) => track.kind === "audio" || track.kind === "video");
      for (const track of tracks) {
        const source = track.kind === "audio" ? "microphone" : "camera";
        if (!this.#localTracks.has(source)) this.#localTracks.set(source, { source, track, enabled: false, endedListener: null });
      }
      await this.#openConnection(this.#initialAuthToken);
      for (const state of this.#localTracks.values()) {
        if (state.source === "microphone" || state.source === "camera") await this.#setSourceEnabled(state, true);
      }
      this.#setPhase("live", null);
    } catch (error) {
      this.#setFailure(error);
      this.#reportError(error);
      throw error;
    }
  }

  async setLocalPublicationTarget(target: MediaPlaneTarget): Promise<MediaPlaneResult> {
    const resolved = resolveMediaTarget(this.#participantId, this.#stopped, this.#localTracks, target);
    if (resolved.kind === "result") return resolved.result;
    const state = resolved.value;
    const previous = this.#sourceOperations.get(target.source) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (state.enabled === target.enabled) return "satisfied" as const;
        try {
          await this.#setSourceEnabled(state, target.enabled);
          return "confirmed" as const;
        } catch (error) {
          this.#reportError(error);
          return "retryable_failure" as const;
        }
      });
    this.#sourceOperations.set(target.source, operation);
    try {
      const outcome = await operation;
      return { outcome, errorCode: outcome === "retryable_failure" ? "media_failed" : null };
    } finally {
      if (this.#sourceOperations.get(target.source) === operation) this.#sourceOperations.delete(target.source);
    }
  }

  observeLocalPublications(listener: (publications: readonly MediaPublication[]) => void): () => void {
    return observePublications(this.#snapshotListeners, listener, () => this.#projectLocalPublications());
  }

  observeRemotePublications(listener: (publications: readonly MediaPublication[]) => void): () => void {
    return observePublications(this.#snapshotListeners, listener, () => this.#projectRemotePublications());
  }

  async restart(input: ParticipantMediaAccess): Promise<void> {
    if (!isRTKAccess(input)) throw new CloudflareRTKError("The RealtimeKit adapter requires a Cloudflare RealtimeKit access grant", "invalid_client");
    if (this.#stopped) throw new CloudflareRTKError("The RealtimeKit media client has stopped", "media_stopped");
    this.#setPhase("recovering", null);
    try {
      await this.#closeConnection();
      await this.#openConnection(input.clientPayload.token);
      for (const state of this.#localTracks.values()) if (state.enabled) await this.#setSourceEnabled(state, true);
      this.#setPhase("live", null);
    } catch (error) {
      this.#setFailure(error);
      this.#reportError(error);
      throw error;
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const leave = this.#closeConnection();
    void leave.catch((error: unknown) => this.#reportError(error));
    for (const state of this.#localTracks.values()) if (state.endedListener) state.track.removeEventListener("ended", state.endedListener);
    this.#localTracks.clear();
    this.#setPhase("stopped", null);
  }

  async #openConnection(authToken: string): Promise<void> {
    this.#connection = await this.#clientFactory({ authToken, onError: (error) => this.#reportError(error) });
    this.#bindConnection(this.#connection);
    await this.#connection.join();
  }

  async #closeConnection(): Promise<void> {
    const connection = this.#connection;
    this.#connection = null;
    this.#unbindConnection();
    if (connection) await connection.leave();
  }

  #bindConnection(connection: CloudflareRTKConnection): void {
    const selfAudio = connection.self.onAudioUpdate(() => this.#syncLocalState("microphone"));
    const selfVideo = connection.self.onVideoUpdate(() => this.#syncLocalState("camera"));
    const selfScreen = connection.self.onScreenShareUpdate((payload) => {
      this.#syncLocalState("screen");
      if (!payload.screenShareEnabled && !this.#screenDisableRequested) this.#onScreenEnded?.();
      this.#screenDisableRequested = false;
    });
    const connectionLeft = connection.self.onLeft(() => {
      if (this.#stopped) return;
      const error = new CloudflareRTKError("The RealtimeKit connection ended unexpectedly", "media_failed");
      this.#setFailure(error);
      this.#reportError(error);
    });
    for (const participant of connection.participants.joined.list()) this.#bindParticipant(participant);
    const participantJoined = connection.participants.joined.onJoined((participant) => {
      this.#bindParticipant(participant);
      this.#publishSnapshot();
    });
    const participantLeft = connection.participants.joined.onLeft((participant) => {
      this.#unbindParticipant(participant.id);
      this.#publishSnapshot();
    });
    this.#connectionUnsubscribers = [selfAudio, selfVideo, selfScreen, connectionLeft, participantJoined, participantLeft];
  }

  #unbindConnection(): void {
    for (const unsubscribe of this.#connectionUnsubscribers) unsubscribe();
    this.#connectionUnsubscribers = [];
    for (const unsubscribers of this.#participantUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
    this.#participantUnsubscribers.clear();
  }

  #bindParticipant(participant: CloudflareRTKParticipant): void {
    if (this.#participantUnsubscribers.has(participant.id)) return;
    const unsubscribers = [participant.onAudioUpdate?.(() => this.#publishSnapshot()), participant.onVideoUpdate?.(() => this.#publishSnapshot()), participant.onScreenShareUpdate?.(() => this.#publishSnapshot())].filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined);
    this.#participantUnsubscribers.set(participant.id, unsubscribers);
  }

  #unbindParticipant(participantId: string): void {
    const unsubscribers = this.#participantUnsubscribers.get(participantId);
    if (!unsubscribers) return;
    for (const unsubscribe of unsubscribers) unsubscribe();
    this.#participantUnsubscribers.delete(participantId);
  }

  async #setSourceEnabled(state: LocalTrackState, enabled: boolean): Promise<void> {
    const connection = this.#connection;
    if (!connection) throw new CloudflareRTKError("The RealtimeKit connection is not active", "media_stopped");
    if (state.source === "microphone") {
      if (enabled) await connection.self.enableAudio(state.track);
      else await connection.self.disableAudio();
    } else if (state.source === "camera") {
      if (enabled) await connection.self.enableVideo(state.track);
      else await connection.self.disableVideo();
    } else {
      this.#screenDisableRequested = !enabled;
      if (enabled) await connection.self.enableScreenShare();
      else await connection.self.disableScreenShare();
    }
    state.enabled = enabled;
    state.track.enabled = enabled;
    this.#publishSnapshot();
  }

  #syncLocalState(source: MediaSource): void {
    const state = this.#localTracks.get(source);
    const connection = this.#connection;
    if (!state || !connection) return;
    state.enabled = source === "microphone" ? connection.self.audioEnabled : source === "camera" ? connection.self.videoEnabled : connection.self.screenShareEnabled;
    state.track.enabled = state.enabled;
    this.#publishSnapshot();
  }

  #publishSnapshot(): void {
    this.#snapshot = freezeSnapshot({ ...this.#snapshot, localTracks: this.#projectLocalTracks(), remoteTracks: this.#projectRemoteTracks() });
    this.#notifyListeners();
  }

  #projectLocalTracks(): readonly ConnectionMediaLocalTrack[] {
    return Object.freeze([...this.#localTracks.values()].map((state) => ({ source: state.source, enabled: state.enabled, publicationId: `${this.#participantId}:${state.source}`, track: state.track })));
  }

  #projectLocalPublications(): readonly MediaPublication[] {
    return Object.freeze(this.#projectLocalTracks().map((track) => ({ participantId: this.#participantId, source: track.source, enabled: track.enabled, publicationId: track.publicationId })));
  }

  #projectRemotePublications(): readonly MediaPublication[] {
    return Object.freeze(this.#projectRemoteTracks().map((track) => ({ participantId: track.participantId, source: track.source, enabled: true, publicationId: track.publicationId })));
  }

  #projectRemoteTracks(): readonly ConnectionMediaRemoteTrack[] {
    return projectRemoteTracks(this.#connection?.participants.joined.list() ?? []);
  }

  #setPhase(phase: ConnectionMediaSnapshot["connection"]["phase"], failure: ConnectionMediaSnapshot["failure"]): void {
    this.#snapshot = freezeSnapshot({ ...this.#snapshot, connection: { phase, peerConnectionState: null, iceConnectionState: null }, failure });
    this.#notifyListeners();
  }

  #setFailure(error: unknown): void {
    this.#setPhase("failed", { code: "media_failed", recoverable: true });
    if (!(error instanceof CloudflareRTKError)) this.#reportError(error);
  }

  #requireStartable(): void {
    if (this.#stopped) throw new CloudflareRTKError("The RealtimeKit media client has stopped", "media_stopped");
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // User callbacks cannot interrupt media ownership.
    }
  }

  #notifyListeners(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        listener();
      } catch (error) {
        this.#reportError(error);
      }
    }
  }
}

function projectRemoteTracks(participants: readonly CloudflareRTKParticipant[]): readonly ConnectionMediaRemoteTrack[] {
  return Object.freeze(participants.flatMap(remoteTracksForParticipant));
}

function remoteTracksForParticipant(participant: CloudflareRTKParticipant): readonly ConnectionMediaRemoteTrack[] {
  const participantId = participantIdentifier(participant);
  if (!participantId) return [];
  const publications: ConnectionMediaRemoteTrack[] = [];
  addRemotePublication(publications, participant, participantId, "microphone", participant.audioEnabled ? participant.audioTrack : null);
  addRemotePublication(publications, participant, participantId, "camera", participant.videoEnabled ? participant.videoTrack : null);
  addRemotePublication(publications, participant, participantId, "screen", participant.screenShareEnabled ? (participant.screenShareTracks.video ?? null) : null);
  return publications;
}

function participantIdentifier(participant: CloudflareRTKParticipant): string {
  return participant.customParticipantId?.trim() || participant.userId.trim() || participant.id.trim();
}

function addRemotePublication(publications: ConnectionMediaRemoteTrack[], participant: CloudflareRTKParticipant, participantId: string, source: MediaSource, track: MediaStreamTrack | null): void {
  if (!track) return;
  publications.push({ participantId, source, publicationId: `${participant.id}:${source}`, track });
}

function validateTrack(source: MediaSource, track: MediaStreamTrack): void {
  const expectedKind = source === "microphone" ? "audio" : "video";
  if (track.kind !== expectedKind) throw new CloudflareRTKError(`A ${source} track must be ${expectedKind}`, "invalid_target");
}

function isRTKAccess(value: ParticipantMediaAccess): value is Extract<ParticipantMediaAccess, { readonly provider: "cloudflare_rtk" }> {
  return value.provider === "cloudflare_rtk";
}

function freezeSnapshot(snapshot: ConnectionMediaSnapshot): ConnectionMediaSnapshot {
  const failure = snapshot.failure ? Object.freeze(snapshot.failure) : null;
  return Object.freeze({
    ...snapshot,
    connection: Object.freeze(snapshot.connection),
    localTracks: Object.freeze(snapshot.localTracks.map((track) => Object.freeze(track))),
    remoteTracks: Object.freeze(snapshot.remoteTracks.map((track) => Object.freeze(track))),
    failure,
  });
}

async function defaultClientFactory(input: { readonly authToken: string; readonly onError: (error: unknown) => void }): Promise<CloudflareRTKConnection> {
  const { default: RealtimeKitClient } = await import("@cloudflare/realtimekit");
  const client = await RealtimeKitClient.init({
    authToken: input.authToken,
    defaults: { audio: false, video: false },
    onError: input.onError,
  });
  return adaptRealtimeKitClient(client);
}

function adaptRealtimeKitClient(client: Awaited<ReturnType<typeof RealtimeKitClient.init>>): CloudflareRTKConnection {
  const self = client.self;
  return {
    join: () => client.join(),
    leave: () => client.leave(),
    self: {
      get peerId() {
        return self.peerId;
      },
      get audioEnabled() {
        return self.audioEnabled;
      },
      get videoEnabled() {
        return self.videoEnabled;
      },
      get screenShareEnabled() {
        return self.screenShareEnabled;
      },
      get audioTrack() {
        return self.audioTrack ?? null;
      },
      get videoTrack() {
        return self.videoTrack ?? null;
      },
      get screenShareTracks() {
        return {
          ...(self.screenShareTracks.audio ? { audio: self.screenShareTracks.audio } : {}),
          ...(self.screenShareTracks.video ? { video: self.screenShareTracks.video } : {}),
        };
      },
      enableAudio: (customTrack) => self.enableAudio(customTrack),
      enableVideo: (customTrack) => self.enableVideo(customTrack),
      enableScreenShare: () => self.enableScreenShare(),
      disableAudio: () => self.disableAudio(),
      disableVideo: () => self.disableVideo(),
      disableScreenShare: () => self.disableScreenShare(),
      onAudioUpdate: (listener) => {
        self.on("audioUpdate", listener);
        return () => self.off("audioUpdate", listener);
      },
      onVideoUpdate: (listener) => {
        self.on("videoUpdate", listener);
        return () => self.off("videoUpdate", listener);
      },
      onScreenShareUpdate: (listener) => {
        self.on("screenShareUpdate", listener);
        return () => self.off("screenShareUpdate", listener);
      },
      onLeft: (listener) => {
        self.on("roomLeft", listener);
        return () => self.off("roomLeft", listener);
      },
    },
    participants: {
      joined: {
        list: () => client.participants.joined.toArray().map(toParticipant),
        onJoined: (listener) => {
          const callback = (participant: RTKParticipant) => listener(toParticipant(participant));
          client.participants.joined.on("participantJoined", callback);
          return () => client.participants.joined.off("participantJoined", callback);
        },
        onLeft: (listener) => {
          const callback = (participant: RTKParticipant) => listener(toParticipant(participant));
          client.participants.joined.on("participantLeft", callback);
          return () => client.participants.joined.off("participantLeft", callback);
        },
      },
    },
  };
}

function toParticipant(participant: RTKParticipant): CloudflareRTKParticipant {
  return {
    id: participant.id,
    userId: participant.userId,
    ...(participant.customParticipantId === undefined ? {} : { customParticipantId: participant.customParticipantId }),
    audioEnabled: participant.audioEnabled,
    videoEnabled: participant.videoEnabled,
    screenShareEnabled: participant.screenShareEnabled,
    audioTrack: participant.audioTrack ?? null,
    videoTrack: participant.videoTrack ?? null,
    screenShareTracks: {
      ...(participant.screenShareTracks.audio ? { audio: participant.screenShareTracks.audio } : {}),
      ...(participant.screenShareTracks.video ? { video: participant.screenShareTracks.video } : {}),
    },
    onAudioUpdate: (listener) => {
      const callback = () => listener();
      participant.on("audioUpdate", callback);
      return () => participant.off("audioUpdate", callback);
    },
    onVideoUpdate: (listener) => {
      const callback = () => listener();
      participant.on("videoUpdate", callback);
      return () => participant.off("videoUpdate", callback);
    },
    onScreenShareUpdate: (listener) => {
      const callback = () => listener();
      participant.on("screenShareUpdate", callback);
      return () => participant.off("screenShareUpdate", callback);
    },
  };
}
