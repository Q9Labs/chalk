/**
 * ConferenceSession class - main interface for interacting with a video room
 * Wraps Cloudflare RealtimeKit for WebRTC and WSClient for signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { AppState } from "@q9labs/chalk-whiteboard";
import { EventEmitter } from "./events.ts";
import type {
  ChalkError,
  ChatMessage,
  MediaDevice,
  MediaDeviceKind,
  Participant,
  Reaction,
  ReactionEmoji,
  Recording,
  SessionInfo,
  SessionConnectionState,
  ScreenShareOptions,
  TenantConfig,
  TokenSet,
} from "./types.ts";
import { ChalkErrorCode } from "./types.ts";
import { wideEvents } from "./wide-events/index.ts";
import { WideEventContext } from "./wide-events/context.ts";
import type { WSClient } from "./ws-client.ts";
import { withPatchedGetDisplayMedia } from "./utils/get-display-media-fallback.ts";

/** Real-time transcript entry from speech-to-text */
export interface Transcript {
  /** Unique transcript ID */
  id: string;
  /** Participant who spoke */
  participantId: string;
  /** Display name of speaker */
  speakerName: string;
  /** Transcribed text */
  text: string;
  /** Timestamp of the transcript */
  timestamp: Date;
  /** Whether this is an interim (in-progress) result */
  isInterim?: boolean;
  /** Confidence score (0-1) */
  confidence?: number;
}

export interface ConferenceSessionEvents {
  "connection.state.changed": SessionConnectionState;
  "participant.joined": Participant;
  "participant.left": string;
  "participant.updated": { participantId: string; participant: Participant };
  "speaker.active.changed": Participant | null;
  "chat.message": ChatMessage;
  reaction: Reaction;
  "hand.raised": { participantId: string };
  "hand.lowered": { participantId: string };
  "recording.started": { recordingId: string };
  "recording.stopped": Recording;
  /** Real-time transcript from speech-to-text */
  transcript: Transcript;
  error: ChalkError;
  "whiteboard.update": {
    schemaVersion?: number;
    sceneId?: string;
    syncAll?: boolean;
    participantId: string;
    displayName: string;
    elements: unknown[];
    files?: Record<string, unknown>;
    seq: number;
  };
  "whiteboard.snapshot": {
    schemaVersion?: number;
    roomId: string;
    sceneId?: string;
    elements: unknown[];
    files: Record<string, unknown>;
    appState: AppState;
    updatedAtMs?: number;
    lastSeq: number;
  };
  "whiteboard.cursor": {
    participantId: string;
    displayName: string;
    x: number;
    y: number;
  };
  "whiteboard.permission.changed": {
    participantId: string;
    canDraw: boolean;
  };
  "whiteboard.opened": {
    participantId: string;
    displayName: string;
  };
  "whiteboard.closed": {
    participantId: string;
  };
}

export class ConferenceSession extends EventEmitter<ConferenceSessionEvents> {
  readonly id: string;
  private _connectionState: SessionConnectionState = "disconnected";
  private _info: SessionInfo | null = null;
  private _participants: Map<string, Participant> = new Map();
  private _rtkPeerIdToStableId = new Map();
  private _localParticipant: Participant | null = null;
  private _activeSpeaker: Participant | null = null;
  private _messages: ChatMessage[] = [];
  private _transcripts: Transcript[] = [];
  private _currentRecording: { id: string } | null = null;
  private _tokens: TokenSet | null = null;
  private _whiteboardPermissions: Map<string, boolean> = new Map();
  private _whiteboardDefaultAccess = true; // tenant config, default: everyone can draw
  private _roomCreated = false;
  private _tenantConfig: TenantConfig | null = null;
  private _roomSyncReadyEmitted = false;

  private rtkClient?: RealtimeKitClient;
  private wsClient?: WSClient;
  private readonly debug: boolean;

  // CRITICAL: Track cleanup state to prevent race conditions
  private isLeaving = false;
  private leavePromise: Promise<void> | null = null;

  constructor(
    roomId: string,
    wsClientOrRtkClient?: WSClient | RealtimeKitClient,
    debug = false,
  ) {
    super();
    this.id = roomId;
    this.debug = debug;

    // Support both WSClient and RealtimeKitClient for backwards compatibility
    if (wsClientOrRtkClient) {
      if ("connect" in wsClientOrRtkClient) {
        // It's a WSClient
        this.wsClient = wsClientOrRtkClient as WSClient;
        this.setupWSListeners();
      } else {
        // It's a RealtimeKitClient
        this.rtkClient = wsClientOrRtkClient as RealtimeKitClient;
        this.setupRTKListeners();
      }
    }
  }

  /**
   * Validate a media track and log diagnostic info
   * Returns true if track is usable, false otherwise
   */
  private validateTrack(track: MediaStreamTrack | undefined | null, _type: string, _participantId: string): boolean {
    if (!track) {
      return false;
    }

    const isLive = track.readyState === "live";
    const isEnabled = track.enabled;

    return isLive && isEnabled;
  }

  /**
   * Log connection diagnostics
   */
  private logConnectionState(): void {
    // No-op: wide events handle connection state via room.join/room.leave
  }

  /**
   * DEBUG: Dump current RTK participant state to logger
   * Call this from browser console: room.debugDumpParticipants()
   */
  debugDumpParticipants(): void {
    // No-op in production; use browser devtools or wide events
  }

  // Getters
  get connectionState(): SessionConnectionState {
    return this._connectionState;
  }

  get status(): SessionConnectionState {
    return this.connectionState;
  }

  get info(): SessionInfo | null {
    return this._info;
  }

  get participants(): Map<string, Participant> {
    return new Map(this._participants);
  }

  get localParticipant(): Participant | null {
    return this._localParticipant;
  }

  get activeSpeaker(): Participant | null {
    return this._activeSpeaker;
  }

  get messages(): ChatMessage[] {
    return [...this._messages];
  }

  /** Get all transcripts from the current session */
  get transcripts(): Transcript[] {
    return [...this._transcripts];
  }

  get isRecording(): boolean {
    return this._currentRecording !== null;
  }

  /** Whether this room was just created (not pre-existing) */
  get roomCreated(): boolean {
    return this._roomCreated;
  }

  /** Tenant configuration for this room */
  get tenantConfig(): TenantConfig | null {
    return this._tenantConfig;
  }

  // Internal methods
  _setConnectionState(state: SessionConnectionState): void {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.emit("connection.state.changed", state);
    }
  }

  _setStatus(status: SessionConnectionState): void {
    this._setConnectionState(status);
  }

  _setInfo(info: SessionInfo): void {
    this._info = info;
  }

  _setLocalParticipant(participant: Participant): void {
    this._localParticipant = participant;
    this._participants.set(participant.id, participant);
  }

  _setTokens(tokens: TokenSet): void {
    this._tokens = tokens;
  }

  _setRoomCreated(created: boolean): void {
    this._roomCreated = created;
  }

  _setTenantConfig(config: TenantConfig | null): void {
    this._tenantConfig = config;
  }

  get tokens(): TokenSet | null {
    return this._tokens;
  }

  private emitRoomSyncReady(source: "rtk.snapshot" | "ws.snapshot", participantCount: number): void {
    if (this._roomSyncReadyEmitted) {
      return;
    }
    this._roomSyncReadyEmitted = true;

    const ctx = new WideEventContext("room.sync.ready", wideEvents.collector);
    ctx.merge({
      source,
      roomId: this.id,
      participantCount,
      transport:
        this.rtkClient && this.wsClient
          ? "rtk+ws"
          : this.rtkClient
            ? "rtk"
            : "ws",
    });
    ctx.complete("success");
  }

  private setupWSListeners(): void {
    if (!this.wsClient) return;

    this.wsClient.on("connected", () => {
      if (!this.rtkClient) {
        this._setConnectionState("connected");
      }
    });

    this.wsClient.on("disconnected", () => {
      if (!this.rtkClient) {
        this._setConnectionState("disconnected");
      }
    });

    this.wsClient.on("reconnecting", () => {
      if (!this.rtkClient) {
        this._setConnectionState("reconnecting");
      }
    });

    // CRITICAL: Only set up WS participant handlers when RTK is NOT active
    // RTK is the source of truth for participant presence (has media tracks)
    // WS uses different participant IDs than RTK, causing duplicates
    if (!this.rtkClient) {
      this.wsClient.on("participant.joined", (data) => {
        if (this._participants.has(data.id)) {
          return;
        }
        this._participants.set(data.id, data);
        this.emit("participant.joined", data);
      });

      this.wsClient.on("participant.left", (data) => {
        const participant = this._participants.get(data.participantId);
        this._participants.delete(data.participantId);
        if (participant) {
          this.emit("participant.left", data.participantId);
        }
      });

      this.wsClient.on("participant.updated", (data) => {
        const participant = this._participants.get(data.participantId);
        if (participant) {
          const updated = { ...participant, ...data.changes };
          this._participants.set(data.participantId, updated);
          this.emit("participant.updated", {
            participantId: data.participantId,
            participant: updated,
          });
        }
      });
    }

    // Host moderation commands (always listen; commands are addressed to the local participant)
    this.wsClient.on("participant.mute", (data) => {
      void this.handleHostAudioCommand(data.participantId, false);
    });

    this.wsClient.on("participant.unmute", (data) => {
      void this.handleHostAudioCommand(data.participantId, true);
    });

    this.wsClient.on("chat.message", (data) => {
      this._messages.push(data);
      this.emit("chat.message", data);
    });

    this.wsClient.on("reaction", (data) => {
      this.emit("reaction", data);
    });

    this.wsClient.on("hand.raised", (data) => {
      const participant = this._participants.get(data.participantId);
      if (participant) {
        participant.handRaised = true;
        this.emit("participant.updated", {
          participantId: data.participantId,
          participant,
        });
      }
      this.emit("hand.raised", { participantId: data.participantId });
    });

    this.wsClient.on("hand.lowered", (data) => {
      const participant = this._participants.get(data.participantId);
      if (participant) {
        participant.handRaised = false;
        this.emit("participant.updated", {
          participantId: data.participantId,
          participant,
        });
      }
      this.emit("hand.lowered", { participantId: data.participantId });
    });

    this.wsClient.on("recording.started", (data) => {
      this._currentRecording = { id: data.recordingId };
      this.emit("recording.started", { recordingId: data.recordingId });
    });

    this.wsClient.on("recording.stopped", (data) => {
      const recording: Recording = {
        id: this._currentRecording?.id ?? data.recordingId,
        roomId: this.id,
        status: "processing",
        durationSeconds: data.duration,
      };
      this._currentRecording = null;
      this.emit("recording.stopped", recording);
    });

    this.wsClient.on("error", (data) => {
      this.emit("error", {
        code: data.code,
        message: data.message,
        details: (data as any).details,
      });
    });

    this.wsClient.on("room.snapshot", (snapshot) => {
      this.emitRoomSyncReady("ws.snapshot", snapshot.participants.length);

      // CRITICAL: When RTK is active, it manages participants (different IDs than WS)
      // Only use snapshot for non-participant data like recording state
      if (this.rtkClient) {
        if (snapshot.isRecording && snapshot.recordingId) {
          this._currentRecording = { id: snapshot.recordingId };
        }
        return;
      }

      // WS-only mode: snapshot is authoritative for participants
      const previousIds = new Set(this._participants.keys());
      this._participants.clear();

      for (const p of snapshot.participants) {
        if (this._localParticipant && p.id === this._localParticipant.id) {
          continue;
        }
        this._participants.set(p.id, p);

        if (!previousIds.has(p.id)) {
          this.emit("participant.joined", p);
        }
      }

      if (this._localParticipant) {
        this._participants.set(
          this._localParticipant.id,
          this._localParticipant,
        );
      }

      if (snapshot.isRecording && snapshot.recordingId) {
        this._currentRecording = { id: snapshot.recordingId };
      }
    });

    // Whiteboard events
    this.wsClient.on("whiteboard.data", (data) => {
      this.emit("whiteboard.update", {
        schemaVersion: data.schemaVersion,
        sceneId: data.sceneId,
        syncAll: data.syncAll,
        participantId: data.participantId,
        displayName: data.displayName,
        elements: data.elements,
        files: data.files,
        seq: data.seq,
      });
    });

    this.wsClient.on("whiteboard.snapshot", (snapshot) => {
      this.emit("whiteboard.snapshot", snapshot);
    });

    this.wsClient.on("whiteboard.cursor", (data) => {
      this.emit("whiteboard.cursor", {
        participantId: data.participantId,
        displayName: data.displayName,
        x: data.x,
        y: data.y,
      });
    });

    this.wsClient.on("permission.changed", (data) => {
      if (data.feature === "whiteboard") {
        this._whiteboardPermissions.set(data.participantId, data.canDraw);
        this.emit("whiteboard.permission.changed", {
          participantId: data.participantId,
          canDraw: data.canDraw,
        });
      }
    });

    this.wsClient.on("whiteboard.opened", (data) => {
      this.emit("whiteboard.opened", {
        participantId: data.participantId,
        displayName: data.displayName,
      });
    });

    this.wsClient.on("whiteboard.closed", (data) => {
      this.emit("whiteboard.closed", {
        participantId: data.participantId,
      });
    });
  }

  private async handleHostAudioCommand(participantId: string, enable: boolean) {
    if (!this._localParticipant || !this.rtkClient) return;
    if (participantId !== this._localParticipant.id) return;

    const ctx = wideEvents.start("participant.moderation.audio");
    ctx.set("action", enable ? "unmute" : "mute");

    try {
      if (enable) {
        if (!this.rtkClient.self.audioEnabled) {
          await this.rtkClient.self.enableAudio();
        }
        this._localParticipant.audioEnabled = true;
        this._localParticipant.audioTrack =
          this.rtkClient.self.audioTrack ?? undefined;
      } else {
        if (this.rtkClient.self.audioEnabled) {
          await this.rtkClient.self.disableAudio();
        }
        this._localParticipant.audioEnabled = false;
        this._localParticipant.audioTrack = undefined;
      }

      this.emit("participant.updated", {
        participantId: this._localParticipant.id,
        participant: this._localParticipant,
      });

      ctx.complete("success", { enabled: this._localParticipant.audioEnabled });
    } catch (error) {
      ctx.complete("error", error);
      this.emit("error", {
        code: "MEDIA_ERROR",
        message: enable
          ? "Failed to unmute microphone"
          : "Failed to mute microphone",
      });
    }
  }

  attachWsClient(wsClient: WSClient): void {
    if (this.wsClient === wsClient) return;
    this.wsClient = wsClient;
    this.setupWSListeners();
  }

  private getRtkIds(rtkParticipant: unknown) {
    const p = rtkParticipant as any;

    const peerId =
      typeof p?.id === "string" && p.id.length > 0 ? p.id : crypto.randomUUID();

    const directUserId =
      (typeof p?.userId === "string" && p.userId.length > 0
        ? p.userId
        : undefined) ??
      (typeof p?.clientSpecificId === "string" && p.clientSpecificId.length > 0
        ? p.clientSpecificId
        : undefined) ??
      (typeof p?.client_specific_id === "string" && p.client_specific_id.length > 0
        ? p.client_specific_id
        : undefined) ??
      (typeof p?.customParticipantId === "string" && p.customParticipantId.length > 0
        ? p.customParticipantId
        : undefined) ??
      (typeof p?.custom_participant_id === "string" &&
      p.custom_participant_id.length > 0
        ? p.custom_participant_id
        : undefined);

    const mapped = this._rtkPeerIdToStableId.get(peerId) as string | undefined;
    const userId = directUserId ?? mapped;
    const stableId = userId ?? peerId;

    if (directUserId) {
      this._rtkPeerIdToStableId.set(peerId, directUserId);
    }

    return { stableId, peerId, userId };
  }

  /**
   * Map a RealtimeKit participant to Chalk Participant type
   */
  private mapRTKParticipant(rtkParticipant: unknown): Participant {
    const p = rtkParticipant as any;
    const { stableId, userId } = this.getRtkIds(rtkParticipant);
    const screenShareVideoTrack =
      p.screenShareTracks?.video ?? p.screenShareVideoTrack ?? undefined;
    const screenShareAudioTrack =
      p.screenShareTracks?.audio ?? p.screenShareAudioTrack ?? undefined;

    return {
      id: stableId,
      userId, // Used for chat message matching (and stable ID when present)
      displayName: p.name ?? "Unknown",
      role: "participant",
      isLocal: false,
      videoEnabled: p.videoEnabled ?? false,
      audioEnabled: p.audioEnabled ?? false,
      videoTrack: p.videoTrack,
      audioTrack: p.audioTrack,
      screenShareTrack: screenShareVideoTrack,
      screenShareAudioTrack: screenShareAudioTrack,
      isSpeaking: false,
      isScreenSharing: p.screenShareEnabled ?? false,
      handRaised: false,
      connectionQuality: 100,
    };
  }

  private setupRTKListeners(): void {
    if (!this.rtkClient) return;

    // DEBUG: Log ALL RTK participant events to diagnose remote track issues
    if (this.debug && this.rtkClient.participants?.joined) {
      const debugEvents = ['participantJoined', 'participantLeft', 'videoUpdate', 'audioUpdate', 'screenShareUpdate', 'participantsUpdate', 'participantsCleared'];
      for (const evt of debugEvents) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.rtkClient!.participants.joined as any).on(evt, (_data: unknown) => {
            // Debug event received
          });
        } catch {
          // Failed to attach listener
        }
      }
    }

    const hasMediaStateChanged = (before: Participant, after: Participant): boolean =>
      before.displayName !== after.displayName ||
      before.videoEnabled !== after.videoEnabled ||
      before.audioEnabled !== after.audioEnabled ||
      before.isScreenSharing !== after.isScreenSharing ||
      before.videoTrack?.id !== after.videoTrack?.id ||
      before.audioTrack?.id !== after.audioTrack?.id ||
      before.screenShareTrack?.id !== after.screenShareTrack?.id ||
      before.screenShareAudioTrack?.id !== after.screenShareAudioTrack?.id;

    const mergeParticipantMediaState = (existing: Participant, incoming: Participant): Participant => ({
      ...existing,
      userId: incoming.userId ?? existing.userId,
      displayName: incoming.displayName || existing.displayName,
      videoEnabled: incoming.videoEnabled,
      audioEnabled: incoming.audioEnabled,
      videoTrack: incoming.videoTrack,
      audioTrack: incoming.audioTrack,
      isScreenSharing: incoming.isScreenSharing,
      screenShareTrack: incoming.screenShareTrack,
      screenShareAudioTrack: incoming.screenShareAudioTrack,
      isLocal: false,
    });

    const collectJoinedParticipants = (): unknown[] => {
      const participantsApi = this.rtkClient?.participants as unknown as {
        toArray?: () => unknown[] | Iterable<unknown>;
      } | undefined;
      const joined = this.rtkClient?.participants?.joined as unknown as {
        toArray?: () => unknown[] | Iterable<unknown>;
        values?: () => Iterable<unknown>;
        forEach?: (cb: (participant: unknown) => void) => void;
        [Symbol.iterator]?: () => Iterator<unknown>;
      } | undefined;
      const toParticipantArray = (source: unknown): unknown[] => {
        if (!source) return [];
        if (Array.isArray(source)) return source;
        if (typeof (source as Iterable<unknown>)[Symbol.iterator] === "function") {
          try {
            return Array.from(source as Iterable<unknown>);
          } catch {
            return [];
          }
        }
        return [];
      };

      if (typeof participantsApi?.toArray === "function") {
        try {
          const snapshot = toParticipantArray(participantsApi.toArray());
          if (snapshot.length > 0) {
            return snapshot;
          }
        } catch {
          // Fall through to joined collection APIs.
        }
      }
      if (!joined) return [];
      if (typeof joined.toArray === "function") {
        try {
          const snapshot = toParticipantArray(joined.toArray());
          if (snapshot.length > 0) {
            return snapshot;
          }
        } catch {
          // Fall through to iterable APIs.
        }
      }
      if (typeof joined[Symbol.iterator] === "function") {
        try {
          const snapshot = Array.from(joined as Iterable<unknown>);
          if (snapshot.length > 0) {
            return snapshot;
          }
        } catch {
          // Fall through to values/forEach APIs.
        }
      }

      const participantList: unknown[] = [];
      if (typeof joined.values === "function") {
        try {
          for (const participant of joined.values()) {
            participantList.push(participant);
          }
          if (participantList.length > 0) {
            return participantList;
          }
        } catch {
          // Fall through to forEach path.
        }
      }
      if (typeof joined.forEach === "function") {
        try {
          joined.forEach((participant) => participantList.push(participant));
        } catch {
          // Ignore iteration failures; event deltas still drive state updates.
        }
      }
      return participantList;
    };

    const onParticipantsEvent = (
      event: string,
      handler: (payload?: unknown) => void,
    ): void => {
      const emitters = [
        this.rtkClient?.participants?.joined as { on?: (eventName: string, fn: (payload?: unknown) => void) => void } | undefined,
        this.rtkClient?.participants as { on?: (eventName: string, fn: (payload?: unknown) => void) => void } | undefined,
      ];
      const attached = new Set<unknown>();

      for (const emitter of emitters) {
        if (!emitter || typeof emitter.on !== "function" || attached.has(emitter)) {
          continue;
        }
        attached.add(emitter);
        try {
          emitter.on(event, handler);
        } catch {
          // Ignore unsupported events on older RTK builds.
        }
      }
    };

    const ensureRemoteParticipant = (rtkParticipant: unknown): Participant | null => {
      const participant = this.mapRTKParticipant(rtkParticipant);

      // Ignore remote collection events that resolve to local participant identity.
      if (this._localParticipant && participant.id === this._localParticipant.id) {
        return null;
      }

      const { peerId } = this.getRtkIds(rtkParticipant);
      let existing = this._participants.get(participant.id);

      // If this participant was temporarily keyed by peerId, migrate it.
      if (!existing && peerId !== participant.id) {
        const existingByPeerId = this._participants.get(peerId);
        if (existingByPeerId) {
          this._participants.delete(peerId);
          existing = {
            ...existingByPeerId,
            ...participant,
            id: participant.id,
            isLocal: false,
          };
          this._participants.set(participant.id, existing);
        }
      }

      if (!existing) {
        this._participants.set(participant.id, participant);
        this.emit("participant.joined", participant);
      }

      return participant;
    };

    const reconcileJoinedParticipants = (): void => {
      const joinedParticipants = collectJoinedParticipants();
      this.emitRoomSyncReady(
        "rtk.snapshot",
        joinedParticipants.length + (this._localParticipant ? 1 : 0),
      );

      for (const joinedParticipant of joinedParticipants) {
        const participant = ensureRemoteParticipant(joinedParticipant);
        if (!participant) continue;

        const existing = this._participants.get(participant.id);
        if (!existing) continue;

        const merged = mergeParticipantMediaState(existing, participant);
        if (!hasMediaStateChanged(existing, merged)) {
          continue;
        }

        this._participants.set(participant.id, merged);
        this.emit("participant.updated", {
          participantId: participant.id,
          participant: merged,
        });
      }
    };

    // ConferenceSession joined event
    this.rtkClient.self.on("roomJoined", () => {
      this._setConnectionState("connected");

      // Sync local participant state with RTK
      if (this._localParticipant) {
        this._localParticipant.videoEnabled = this.rtkClient!.self.videoEnabled;
        this._localParticipant.audioEnabled = this.rtkClient!.self.audioEnabled;
        this._localParticipant.videoTrack =
          this.rtkClient!.self.videoTrack ?? undefined;
        this._localParticipant.audioTrack =
          this.rtkClient!.self.audioTrack ?? undefined;

        // Validate initial tracks
        if (this._localParticipant.videoEnabled) {
          this.validateTrack(this._localParticipant.videoTrack, "LOCAL_VIDEO", this._localParticipant.id);
        }
        if (this._localParticipant.audioEnabled) {
          this.validateTrack(this._localParticipant.audioTrack, "LOCAL_AUDIO", this._localParticipant.id);
        }
      }

      this.logConnectionState();
      reconcileJoinedParticipants();
    });

    // ConferenceSession left event
    this.rtkClient.self.on("roomLeft", () => {
      this._setConnectionState("disconnected");
    });

    // Video update for local user
    this.rtkClient.self.on(
      "videoUpdate",
      (data: {
        videoEnabled: boolean;
        videoTrack: MediaStreamTrack | null;
      }) => {
        if (this._localParticipant) {
          this._localParticipant.videoEnabled = data.videoEnabled;
          this._localParticipant.videoTrack = data.videoTrack ?? undefined;

          // Validate and warn if enabled but no track
          if (data.videoEnabled) {
            const isValid = this.validateTrack(data.videoTrack, "LOCAL_VIDEO", this._localParticipant.id);
            if (!isValid) {
              this.emit("error", {
                code: "MEDIA_ERROR",
                message: "Video enabled but track unavailable or invalid",
                details: { trackState: data.videoTrack?.readyState },
              });
            }
          }

          this.emit("participant.updated", {
            participantId: this._localParticipant.id,
            participant: this._localParticipant,
          });
        }
      },
    );

    // Audio update for local user
    this.rtkClient.self.on(
      "audioUpdate",
      (data: {
        audioEnabled: boolean;
        audioTrack: MediaStreamTrack | null;
      }) => {
        if (this._localParticipant) {
          this._localParticipant.audioEnabled = data.audioEnabled;
          this._localParticipant.audioTrack = data.audioTrack ?? undefined;

          // Validate and warn if enabled but no track
          if (data.audioEnabled) {
            const isValid = this.validateTrack(data.audioTrack, "LOCAL_AUDIO", this._localParticipant.id);
            if (!isValid) {
              this.emit("error", {
                code: "MEDIA_ERROR",
                message: "Audio enabled but track unavailable or invalid",
                details: { trackState: data.audioTrack?.readyState },
              });
            }
          }

          this.emit("participant.updated", {
            participantId: this._localParticipant.id,
            participant: this._localParticipant,
          });
        }
      },
    );

    // Screen share update for local user
    this.rtkClient.self.on(
      "screenShareUpdate",
      (data: {
        screenShareEnabled: boolean;
        screenShareTracks: {
          audio?: MediaStreamTrack;
          video?: MediaStreamTrack;
        };
      }) => {
        if (this._localParticipant) {
          this._localParticipant.isScreenSharing = data.screenShareEnabled;
          this._localParticipant.screenShareTrack =
            data.screenShareTracks?.video ?? undefined;
          this._localParticipant.screenShareAudioTrack =
            data.screenShareTracks?.audio ?? undefined;
          this.emit("participant.updated", {
            participantId: this._localParticipant.id,
            participant: this._localParticipant,
          });
        }
      },
    );

    // Participant joined
    onParticipantsEvent(
      "participantJoined",
      (rtkParticipant: unknown) => {
        ensureRemoteParticipant(rtkParticipant);
      },
    );

    // Participant left
    onParticipantsEvent(
      "participantLeft",
      (rtkParticipant: unknown) => {
        const { stableId, peerId } = this.getRtkIds(rtkParticipant);
        this._rtkPeerIdToStableId.delete(peerId);
        const deletedStable = this._participants.delete(stableId);
        const deletedPeer =
          peerId !== stableId ? this._participants.delete(peerId) : false;

        if (deletedStable || deletedPeer) {
          this.emit("participant.left", stableId);
        }
      },
    );

    // Participant video update
    onParticipantsEvent(
      "videoUpdate",
      (rtkParticipant: unknown) => {
        const participant = ensureRemoteParticipant(rtkParticipant);
        if (!participant) {
          return;
        }

        const existing = this._participants.get(participant.id);
        if (!existing) return;

        // CRITICAL: Create new object for React to detect changes
        const updated: Participant = {
          ...existing,
          videoEnabled: participant.videoEnabled,
          videoTrack: participant.videoTrack,
        };
        this._participants.set(participant.id, updated);

        // Validate remote video track
        if (participant.videoEnabled) {
          this.validateTrack(participant.videoTrack, "REMOTE_VIDEO", participant.id);
        }

        this.emit("participant.updated", {
          participantId: participant.id,
          participant: updated,
        });
      },
    );

    // Participant audio update
    onParticipantsEvent(
      "audioUpdate",
      (rtkParticipant: unknown) => {
        const participant = ensureRemoteParticipant(rtkParticipant);
        if (!participant) {
          return;
        }

        const existing = this._participants.get(participant.id);
        if (!existing) return;

        // CRITICAL: Create new object for React to detect changes
        const updated: Participant = {
          ...existing,
          audioEnabled: participant.audioEnabled,
          audioTrack: participant.audioTrack,
        };
        this._participants.set(participant.id, updated);

        // Validate remote audio track
        if (participant.audioEnabled) {
          this.validateTrack(participant.audioTrack, "REMOTE_AUDIO", participant.id);
        }

        this.emit("participant.updated", {
          participantId: participant.id,
          participant: updated,
        });
      },
    );

    // Participant screen share update
    onParticipantsEvent(
      "screenShareUpdate",
      (rtkParticipant: unknown) => {
        const participant = ensureRemoteParticipant(rtkParticipant);
        if (!participant) {
          return;
        }

        const existing = this._participants.get(participant.id);
        if (!existing) return;

        // CRITICAL: Create new object for React to detect changes
        const updated: Participant = {
          ...existing,
          isScreenSharing: participant.isScreenSharing,
          screenShareTrack: participant.screenShareTrack,
          screenShareAudioTrack: participant.screenShareAudioTrack,
        };
        this._participants.set(participant.id, updated);

        // Validate screen share track
        if (participant.isScreenSharing) {
          const isValid = this.validateTrack(participant.screenShareTrack, "REMOTE_SCREENSHARE", participant.id);
          if (!isValid) {
            this.emit("error", {
              code: "SCREEN_SHARE_ERROR",
              message: `Screen share track unavailable for participant ${participant.displayName}`,
              details: { participantId: participant.id },
            });
          }
        }

        this.emit("participant.updated", {
          participantId: participant.id,
          participant: updated,
        });
      },
    );

    // Reconcile from RTK joined map in case edge events are dropped or reordered.
    onParticipantsEvent("participantsUpdate", () => {
      reconcileJoinedParticipants();
    });

    onParticipantsEvent("participantsCleared", () => {
      const remoteParticipantIDs = Array.from(this._participants.values())
        .filter((participant) => !participant.isLocal)
        .map((participant) => participant.id);

      for (const participantID of remoteParticipantIDs) {
        this._participants.delete(participantID);
        this.emit("participant.left", participantID);
      }
      this._rtkPeerIdToStableId.clear();

      // Some RTK builds emit participantsCleared before repopulating snapshots.
      // Retry reconciliation shortly to heal transient state gaps.
      queueMicrotask(() => reconcileJoinedParticipants());
      setTimeout(() => reconcileJoinedParticipants(), 50);
      setTimeout(() => reconcileJoinedParticipants(), 250);
    });

    // RTK Chat message handling
    if (this.rtkClient.chat) {
      // Cast to unknown to access events that may not be in type defs
      const chat = this.rtkClient.chat as unknown as {
        on: (event: string, handler: (data: unknown) => void) => void;
        messages?: unknown[];
      };

      // Helper to extract message from various payload formats
      const extractMessage = (payload: unknown): ChatMessage | null => {
        const rawData = payload as Record<string, unknown>;

        // Skip non-add actions (like "delete", "pin", etc.)
        if (rawData.action && rawData.action !== "add") {
          return null;
        }

        // RTK/Dyte chatUpdate format: { action: "add", message: {...} }
        // Extract the nested message object if present
        const msgData = (rawData.message as Record<string, unknown>) ?? rawData;

        const chatMessage: ChatMessage = {
          id: (msgData.id as string) ?? crypto.randomUUID(),
          senderId: (msgData.userId as string) ?? "unknown",
          senderName: (msgData.displayName as string) ?? "Unknown",
          content: (msgData.message as string) ?? (msgData.text as string) ?? (msgData.content as string) ?? "",
          timestamp: new Date((msgData.time as string) ?? (msgData.timestamp as string) ?? Date.now()),
        };

        // Ensure content is a string
        if (typeof chatMessage.content !== "string") {
          chatMessage.content = String(chatMessage.content);
        }

        return chatMessage;
      };

      // Handler for chat events
      const chatEventHandler = (_eventName: string) => (payload: unknown) => {
        const chatMessage = extractMessage(payload);
        if (!chatMessage) {
          return;
        }

        // Deduplicate - check if message with same ID or same content+sender+time already exists
        const isDuplicate = this._messages.some(m =>
          m.id === chatMessage.id ||
          (m.senderId === chatMessage.senderId &&
           m.content === chatMessage.content &&
           Math.abs(new Date(m.timestamp).getTime() - new Date(chatMessage.timestamp).getTime()) < 5000)
        );

        if (isDuplicate) {
          return;
        }

        this._messages.push(chatMessage);
        this.emit("chat.message", chatMessage);
      };

      // Register handlers for various chat events (different RTK versions may use different names)
      const chatEvents = ["chatUpdate", "newMessage", "messageReceived", "message"];
      for (const eventName of chatEvents) {
        try {
          chat.on(eventName, chatEventHandler(eventName));
        } catch {
          // Could not register handler
        }
      }
    }

    // Transcription support (if enabled in preset)
    this.setupTranscriptListener();

    this.setupActiveSpeakerListener();
  }

  private setupTranscriptListener(): void {
    if (!this.rtkClient) {
      return;
    }

    // Access RTK ai module for transcription (may not be available in all versions)
    const ai = (this.rtkClient as unknown as { ai?: {
      transcripts?: unknown[];
      on?: (event: string, handler: (data: unknown) => void) => void;
    } }).ai;

    if (!ai) {
      return;
    }

    // Check if there's an enable/start method
    const aiAny = ai as Record<string, unknown>;
    if (typeof aiAny.enable === "function") {
      try {
        (aiAny.enable as () => void)();
      } catch {
        // enable() failed
      }
    }
    if (typeof aiAny.start === "function") {
      try {
        (aiAny.start as () => void)();
      } catch {
        // start() failed
      }
    }
    if (typeof aiAny.startTranscription === "function") {
      try {
        (aiAny.startTranscription as () => void)();
      } catch {
        // startTranscription() failed
      }
    }

    // Load existing transcripts if available
    if (Array.isArray(ai.transcripts)) {
      for (const t of ai.transcripts) {
        const transcript = this.mapRTKTranscript(t);
        if (transcript) {
          this._transcripts.push(transcript);
        }
      }
    }

    // Try multiple event registration methods
    const eventNames = ["transcript", "transcription", "transcriptUpdate", "newTranscript", "message"];

    if (typeof ai.on === "function") {
      for (const eventName of eventNames) {
        try {
          ai.on(eventName, (data: unknown) => {
            const transcript = this.mapRTKTranscript(data);
            if (transcript) {
              this._transcripts.push(transcript);
              this.emit("transcript", transcript);

              // Send final transcripts to backend for persistence
              if (!transcript.isInterim) {
                this.wsClient?.sendTranscript(transcript);
              }
            }
          });
        } catch {
          // Failed to register handler
        }
      }
    }

    // Also try to hook into any observable/signal patterns
    if (aiAny.transcripts$ && typeof (aiAny.transcripts$ as { subscribe?: unknown }).subscribe === "function") {
      (aiAny.transcripts$ as { subscribe: (cb: (data: unknown) => void) => void }).subscribe((_data: unknown) => {
        // transcripts$ emitted
      });
    }
  }

  private mapRTKTranscript(data: unknown): Transcript | null {
    if (!data || typeof data !== "object") return null;

    const raw = data as Record<string, unknown>;

    // Handle Cloudflare RealtimeKit transcript format:
    // { id, name, peerId, userId, customParticipantId, transcript, isPartialTranscript, date }
    const participantId = (raw.peerId as string) ?? (raw.userId as string) ?? (raw.participantId as string) ?? (raw.customParticipantId as string) ?? "";
    const speakerName = (raw.name as string) ?? (raw.participantName as string) ?? (raw.displayName as string) ?? "Unknown";
    const text = (raw.transcript as string) ?? (raw.text as string) ?? (raw.content as string) ?? "";

    if (!text) return null;

    // isPartialTranscript: true means interim, false means final
    const isInterim = raw.isPartialTranscript === true;

    return {
      id: (raw.id as string) ?? crypto.randomUUID(),
      participantId,
      speakerName,
      text,
      timestamp: raw.date ? new Date(raw.date as string | number) : (raw.timestamp ? new Date(raw.timestamp as string | number) : new Date()),
      isInterim,
      confidence: raw.confidence as number | undefined,
    };
  }

  private setupActiveSpeakerListener(): void {
    if (!this.rtkClient?.participants) return;

    const participants = this.rtkClient.participants as unknown as {
      on?: (event: string, handler: (speaker: unknown) => void) => void;
    };

    if (typeof participants.on !== "function") return;

    participants.on("activeSpeakerChanged", (speaker: unknown) => {
      if (speaker) {
        const ids = this.getRtkIds(speaker);
        const participant = this._participants.get(ids.stableId) ?? null;
        if (this._activeSpeaker?.id !== participant?.id) {
          this._activeSpeaker = participant;
          this.emit("speaker.active.changed", participant);
        }
      } else {
        if (this._activeSpeaker !== null) {
          this._activeSpeaker = null;
          this.emit("speaker.active.changed", null);
        }
      }
    });
  }

  /**
   * Boost video bitrate for better quality
   * Attempts to set higher bitrate on the video sender
   */
  private async boostVideoBitrate(): Promise<void> {
    try {
      // Try to access RTCPeerConnection from RealtimeKit client
      const client = this.rtkClient as unknown as {
        peerConnection?: RTCPeerConnection;
        pc?: RTCPeerConnection;
        _peerConnection?: RTCPeerConnection;
        webrtcPeer?: { peerConnection?: RTCPeerConnection };
      };

      const pc =
        client.peerConnection ||
        client.pc ||
        client._peerConnection ||
        client.webrtcPeer?.peerConnection;

      if (!pc) {
        return;
      }

      const senders = pc.getSenders();
      const videoSender = senders.find(
        (s) => s.track?.kind === "video"
      );

      if (!videoSender) {
        return;
      }

      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      const encoding = params.encodings[0];
      if (encoding) {
        // Set higher bitrate: 2.5 Mbps for 720p (default is 1.2 Mbps)
        encoding.maxBitrate = 2_500_000;
        // Ensure no downscaling
        encoding.scaleResolutionDownBy = 1;
      }

      await videoSender.setParameters(params);
    } catch {
      // Fail silently - this is an optimization, not critical
    }
  }

  // Media controls using RealtimeKit
  async toggleVideo(): Promise<boolean> {
    if (!this.rtkClient || !this._localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.toggle");
    ctx.set("mediaType", "video");
    ctx.set("before", this._localParticipant.videoEnabled);

    try {
      if (this.rtkClient.self.videoEnabled) {
        await this.rtkClient.self.disableVideo();
        this._localParticipant.videoEnabled = false;
        this._localParticipant.videoTrack = undefined;
      } else {
        await this.rtkClient.self.enableVideo();
        this._localParticipant.videoEnabled = true;
        this._localParticipant.videoTrack =
          this.rtkClient.self.videoTrack ?? undefined;
        // Boost bitrate after enabling video
        await this.boostVideoBitrate();
      }
      ctx.complete("success", { enabled: this._localParticipant.videoEnabled });
      return this._localParticipant.videoEnabled;
    } catch (error) {
      ctx.complete("error", error);
      this.emit("error", {
        code: "MEDIA_ERROR",
        message: "Failed to toggle camera",
      });
      return this._localParticipant.videoEnabled;
    }
  }

  async toggleAudio(): Promise<boolean> {
    if (!this.rtkClient || !this._localParticipant) {
      return false;
    }

    const ctx = wideEvents.start("media.toggle");
    ctx.set("mediaType", "audio");
    ctx.set("before", this._localParticipant.audioEnabled);

    try {
      if (this.rtkClient.self.audioEnabled) {
        await this.rtkClient.self.disableAudio();
        this._localParticipant.audioEnabled = false;
        this._localParticipant.audioTrack = undefined;
      } else {
        await this.rtkClient.self.enableAudio();
        this._localParticipant.audioEnabled = true;
        this._localParticipant.audioTrack =
          this.rtkClient.self.audioTrack ?? undefined;
      }
      ctx.complete("success", { enabled: this._localParticipant.audioEnabled });
      return this._localParticipant.audioEnabled;
    } catch (error) {
      ctx.complete("error", error);
      this.emit("error", {
        code: "MEDIA_ERROR",
        message: "Failed to toggle microphone",
      });
      return this._localParticipant.audioEnabled;
    }
  }

  async startScreenShare(options?: ScreenShareOptions): Promise<boolean> {
    if (!this._localParticipant || !this.rtkClient) return false;

    if (this._localParticipant.isScreenSharing) return true;

    const ctx = wideEvents.start("screenshare.start");

    try {
      // iPadOS/Safari/WebKit frequently fails when RealtimeKit requests
      // getDisplayMedia({ audio: true, video: {...} }). Patch + retry with safer
      // constraints to make screensharing cross-platform.
      await withPatchedGetDisplayMedia(
        async () => {
          await this.rtkClient!.self.enableScreenShare();
          return true;
        },
        { withAudio: options?.withAudio === true },
      );
      this._localParticipant.isScreenSharing = true;
      ctx.complete("success");
      return true;
    } catch (error) {
      ctx.complete("error", error);
      const err = error as any;
      const name = typeof err?.name === "string" ? err.name : undefined;
      const message =
        typeof err?.message === "string"
          ? err.message
          : "Failed to start screen sharing";

      const code =
        name === "OverconstrainedError"
          ? ChalkErrorCode.OVERCONSTRAINED
          : name === "NotAllowedError"
            ? ChalkErrorCode.SCREEN_SHARE_CANCELLED
            : ChalkErrorCode.SCREEN_SHARE_FAILED;

      this.emit("error", {
        code,
        message,
        details: { name },
      });
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this._localParticipant || !this.rtkClient) return;

    if (!this._localParticipant.isScreenSharing) return;

    const ctx = wideEvents.start("screenshare.stop");

    try {
      await this.rtkClient.self.disableScreenShare();
      this._localParticipant.isScreenSharing = false;
      this._localParticipant.screenShareTrack = undefined;
      this._localParticipant.screenShareAudioTrack = undefined;
      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
    }
  }

  // ===== Device Management =====

  /**
   * Get list of available media devices
   */
  async getDevices(): Promise<MediaDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
        kind: d.kind as MediaDeviceKind,
      }));
    } catch (error) {
      this.emit("error", {
        code: ChalkErrorCode.MEDIA_ERROR,
        message: "Failed to list media devices",
      });
      return [];
    }
  }

  /**
   * Get available video input devices (cameras)
   */
  async getCameras(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  /**
   * Get available audio input devices (microphones)
   */
  async getMicrophones(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === "audioinput");
  }

  /**
   * Get available audio output devices (speakers)
   */
  async getSpeakers(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  }

  /**
   * Switch to a different camera
   */
  async selectCamera(deviceId: string): Promise<boolean> {
    if (!this.rtkClient || !this._localParticipant) return false;

    try {
      // Use setDevice if available, otherwise re-enable with new device
      const self = this.rtkClient.self as unknown as {
        setDevice?: (kind: string, deviceId: string) => Promise<void>;
        videoTrack?: MediaStreamTrack;
      };

      if (typeof self.setDevice === "function") {
        await self.setDevice("video", deviceId);
      } else {
        // Fallback: disable and re-enable with new device
        if (this.rtkClient.self.videoEnabled) {
          await this.rtkClient.self.disableVideo();
        }
        await (
          this.rtkClient.self.enableVideo as (opts?: unknown) => Promise<void>
        )({ videoDevice: deviceId });
      }
      this._localParticipant.videoEnabled = true;
      this._localParticipant.videoTrack =
        (self.videoTrack as MediaStreamTrack | undefined) ?? undefined;
      return true;
    } catch {
      this.emit("error", {
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: "Failed to switch camera",
        details: { deviceId },
      });
      return false;
    }
  }

  /**
   * Switch to a different microphone
   */
  async selectMicrophone(deviceId: string): Promise<boolean> {
    if (!this.rtkClient || !this._localParticipant) return false;

    try {
      const self = this.rtkClient.self as unknown as {
        setDevice?: (kind: string, deviceId: string) => Promise<void>;
        audioTrack?: MediaStreamTrack;
      };

      if (typeof self.setDevice === "function") {
        await self.setDevice("audio", deviceId);
      } else {
        if (this.rtkClient.self.audioEnabled) {
          await this.rtkClient.self.disableAudio();
        }
        await (
          this.rtkClient.self.enableAudio as (opts?: unknown) => Promise<void>
        )({ audioDevice: deviceId });
      }
      this._localParticipant.audioEnabled = true;
      this._localParticipant.audioTrack =
        (self.audioTrack as MediaStreamTrack | undefined) ?? undefined;
      return true;
    } catch {
      this.emit("error", {
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: "Failed to switch microphone",
        details: { deviceId },
      });
      return false;
    }
  }

  // Chat
  sendMessage(content: string): void {
    if (!content.trim()) {
      return;
    }

    const trimmed = content.trim();

    // Try WSClient first, fallback to RealtimeKit
    if (this.wsClient) {
      this.wsClient.sendChatMessage(trimmed);
      // WSClient will echo the message back via chat.message event
    } else if (this.rtkClient) {
      try {
        this.rtkClient.chat?.sendTextMessage(trimmed);
        // RTK echoes messages back via chatUpdate event, so don't add locally
      } catch {
        // Chat send failed
      }
    } else {
      // No client available - add locally for demo/testing only
      const localMessage: ChatMessage = {
        id: crypto.randomUUID(),
        senderId: this._localParticipant?.id ?? "local",
        senderName: this._localParticipant?.displayName ?? "You",
        content: trimmed,
        timestamp: new Date(),
      };
      this._messages.push(localMessage);
      this.emit("chat.message", localMessage);
    }
  }

  // Reactions
  sendReaction(emoji: ReactionEmoji): void {
    // Try WSClient first, fallback to RealtimeKit
    if (this.wsClient) {
      this.wsClient.sendReaction(emoji);
    } else if (this.rtkClient) {
      try {
        // RealtimeKit may have reactions API
        (
          this.rtkClient as unknown as {
            reactions?: { send: (e: string) => void };
          }
        ).reactions?.send(emoji);
      } catch {
        // Reactions not available
      }
    }
  }

  // Hand raise
  raiseHand(): void {
    if (!this._localParticipant) return;

    this._localParticipant.handRaised = true;

    // Try WSClient first
    if (this.wsClient) {
      this.wsClient.raiseHand();
    }

    this.emit("participant.updated", {
      participantId: this._localParticipant.id,
      participant: this._localParticipant,
    });
    this.emit("hand.raised", { participantId: this._localParticipant.id });
  }

  lowerHand(): void {
    if (!this._localParticipant) return;

    this._localParticipant.handRaised = false;

    // Try WSClient first
    if (this.wsClient) {
      this.wsClient.lowerHand();
    }

    this.emit("participant.updated", {
      participantId: this._localParticipant.id,
      participant: this._localParticipant,
    });
    this.emit("hand.lowered", { participantId: this._localParticipant.id });
  }

  // CRITICAL: Async leave with proper cleanup sequencing
  async leave(): Promise<void> {
    if (this.isLeaving && this.leavePromise) {
      return this.leavePromise;
    }

    this.isLeaving = true;

    const ctx = wideEvents.start("room.leave");
    ctx.set("roomId", this.id);

    // Create a promise that resolves when cleanup is complete
    this.leavePromise = (async () => {
      try {
        // Disconnect WSClient if present
        if (this.wsClient) {
          this.wsClient.disconnect();
        }

        // Disconnect RealtimeKit if present (this is async internally)
        if (this.rtkClient) {
          try {
            await this.rtkClient.leave();
          } catch {
            // Error during RTK leave
          }
        }

        // Give browser time to release media devices
        await new Promise(resolve => setTimeout(resolve, 100));

        // Clear state after disconnect
        this._participants.clear();
        this._rtkPeerIdToStableId.clear();
        this._activeSpeaker = null;
        this._messages = [];
        this._currentRecording = null;
        this._localParticipant = null;

        this._setConnectionState("disconnected");
        ctx.complete("success");
      } finally {
        this.isLeaving = false;
        this.leavePromise = null;
      }
    })();

    return this.leavePromise;
  }

  /**
   * Get the underlying RealtimeKit client for advanced usage
   */
  get rtkMeeting(): RealtimeKitClient | undefined {
    return this.rtkClient;
  }

  // ===== Participant Moderation =====

  /**
   * Mute a participant (host only).
   * Sends a command over WebSocket; the participant's client applies it locally.
   */
  muteParticipant(participantId: string): void {
    if (this._localParticipant?.role !== "host") return;
    if (participantId === this._localParticipant.id) return;
    this.wsClient?.muteParticipant(participantId);
  }

  /**
   * Unmute a participant (host only).
   * Sends a command over WebSocket; enabling the mic may still be blocked by browser/user policy.
   */
  unmuteParticipant(participantId: string): void {
    if (this._localParticipant?.role !== "host") return;
    if (participantId === this._localParticipant.id) return;
    this.wsClient?.unmuteParticipant(participantId);
  }

  // ===== Whiteboard Methods =====

  /**
   * Check if a participant can draw on the whiteboard
   */
  canDrawWhiteboard(participantId?: string): boolean {
    const id = participantId ?? this._localParticipant?.id;

    // If no participant ID, return default access (allows drawing before fully joined)
    if (!id) return this._whiteboardDefaultAccess;

    // Host always can draw
    const participant = this._participants.get(id);
    if (participant?.role === "host") return true;

    // Check explicit permission
    const explicit = this._whiteboardPermissions.get(id);
    if (explicit !== undefined) return explicit;

    // Fall back to default - everyone can draw unless explicitly revoked
    return this._whiteboardDefaultAccess;
  }

  /**
   * Grant whiteboard drawing permission to a participant (host only)
   */
  grantWhiteboardPermission(participantId: string): void {
    if (this._localParticipant?.role !== "host") {
      return;
    }
    this.wsClient?.grantWhiteboardPermission(participantId);
  }

  /**
   * Revoke whiteboard drawing permission from a participant (host only)
   */
  revokeWhiteboardPermission(participantId: string): void {
    if (this._localParticipant?.role !== "host") {
      return;
    }
    this.wsClient?.revokeWhiteboardPermission(participantId);
  }

  /**
   * Send a whiteboard update (elements changed)
   */
  sendWhiteboardUpdate(
    elements: unknown[],
    files?: Record<string, unknown>,
    seq?: number,
  ): void {
    this.wsClient?.sendWhiteboardUpdate(elements, files, seq);
  }

  sendWhiteboardUpdateV2(payload: {
    sceneId: string;
    syncAll: boolean;
    elements: unknown[];
    seq?: number;
  }): void {
    this.wsClient?.sendWhiteboardUpdateV2(payload);
  }

  /**
   * Send cursor position on whiteboard
   */
  sendWhiteboardCursor(x: number, y: number): void {
    this.wsClient?.sendWhiteboardCursor(x, y);
  }

  /**
   * Clear the whiteboard (host only)
   */
  clearWhiteboard(): void {
    this.wsClient?.sendWhiteboardClear();
  }

  /**
   * Request whiteboard sync (get current state)
   */
  requestWhiteboardSync(): void {
    this.wsClient?.requestWhiteboardSync();
  }

  /**
   * Notify others that you opened the whiteboard
   */
  openWhiteboard(): void {
    this.wsClient?.sendWhiteboardOpen();
  }

  /**
   * Notify others that you closed the whiteboard
   */
  closeWhiteboard(): void {
    this.wsClient?.sendWhiteboardClose();
  }
}
