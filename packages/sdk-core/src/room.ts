/**
 * Room class - main interface for interacting with a video room
 * Wraps Cloudflare RealtimeKit for WebRTC and WSClient for signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
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
  RoomInfo,
  RoomStatus,
  ScreenShareOptions,
  TokenSet,
} from "./types.ts";
import { ChalkErrorCode } from "./types.ts";
import { createLogger, type Logger } from "./utils/logger.ts";
import type { WSClient } from "./ws-client.ts";

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

interface RoomEvents {
  "status-changed": RoomStatus;
  "participant-joined": Participant;
  "participant-left": string;
  "participant-updated": { participantId: string; participant: Participant };
  "active-speaker-changed": Participant | null;
  "chat-message": ChatMessage;
  reaction: Reaction;
  "hand-raised": { participantId: string };
  "hand-lowered": { participantId: string };
  "recording-started": { recordingId: string };
  "recording-stopped": Recording;
  /** Real-time transcript from speech-to-text */
  transcript: Transcript;
  error: ChalkError;
  "whiteboard-update": {
    participantId: string;
    displayName: string;
    elements: unknown[];
    files?: Record<string, unknown>;
    seq: number;
  };
  "whiteboard-cursor": {
    participantId: string;
    displayName: string;
    x: number;
    y: number;
  };
  "whiteboard-permission-changed": {
    participantId: string;
    canDraw: boolean;
  };
  "whiteboard-opened": {
    participantId: string;
    displayName: string;
  };
  "whiteboard-closed": {
    participantId: string;
  };
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  private _status: RoomStatus = "disconnected";
  private _info: RoomInfo | null = null;
  private _participants: Map<string, Participant> = new Map();
  private _localParticipant: Participant | null = null;
  private _activeSpeaker: Participant | null = null;
  private _messages: ChatMessage[] = [];
  private _transcripts: Transcript[] = [];
  private _currentRecording: { id: string } | null = null;
  private _tokens: TokenSet | null = null;
  private _whiteboardPermissions: Map<string, boolean> = new Map();
  private _whiteboardDefaultAccess = true; // tenant config, default: everyone can draw

  private rtkClient?: RealtimeKitClient;
  private wsClient?: WSClient;
  private readonly debug: boolean;
  private readonly log: Logger;

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
    this.log = createLogger("Room");

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
  private validateTrack(track: MediaStreamTrack | undefined | null, type: string, participantId: string): boolean {
    if (!track) {
      this.log.warn(`${type} track missing`, { participantId });
      return false;
    }

    const isLive = track.readyState === "live";
    const isEnabled = track.enabled;

    this.log.debug(`${type} track info`, {
      participantId,
      trackId: track.id?.slice(0, 8),
      state: track.readyState,
      enabled: track.enabled,
    });

    if (!isLive) {
      this.log.warn(`${type} track not live`, { participantId, state: track.readyState });
    }
    if (!isEnabled) {
      this.log.warn(`${type} track disabled`, { participantId });
    }

    return isLive && isEnabled;
  }

  /**
   * Log connection diagnostics
   */
  private logConnectionState(): void {
    if (!this.rtkClient) return;

    const rtk = this.rtkClient as unknown as {
      connectionState?: string;
      self?: {
        videoEnabled?: boolean;
        audioEnabled?: boolean;
        videoTrack?: MediaStreamTrack;
        audioTrack?: MediaStreamTrack;
      };
    };

    this.log.debug("Connection state", {
      status: this._status,
      rtkState: rtk.connectionState ?? "unknown",
      video: rtk.self?.videoEnabled,
      audio: rtk.self?.audioEnabled,
      participants: this._participants.size,
    });
  }

  /**
   * DEBUG: Dump current RTK participant state to logger
   * Call this from browser console: room.debugDumpParticipants()
   */
  debugDumpParticipants(): void {
    this.log.debug("=== Participant Dump ===");
    this.log.debug("Local participant", { participant: this._localParticipant });
    this.log.debug("Participants map size", { size: this._participants.size });

    this._participants.forEach((p, id) => {
      this.log.debug(`Participant [${id}]`, {
        displayName: p.displayName,
        isLocal: p.isLocal,
        videoEnabled: p.videoEnabled,
        audioEnabled: p.audioEnabled,
        isScreenSharing: p.isScreenSharing,
        hasVideoTrack: !!p.videoTrack,
        hasAudioTrack: !!p.audioTrack,
        hasScreenShareTrack: !!p.screenShareTrack,
        videoTrackState: p.videoTrack?.readyState,
        screenShareTrackState: p.screenShareTrack?.readyState,
      });
    });

    // Also dump raw RTK state if available
    if (this.rtkClient) {
      const rtk = this.rtkClient as unknown as {
        participants?: {
          joined?: {
            toArray?: () => unknown[];
            all?: unknown[];
          };
        };
      };

      this.log.debug("=== RAW RTK State ===");
      const joinedParticipants = rtk.participants?.joined?.toArray?.() ?? rtk.participants?.joined?.all ?? [];
      this.log.debug("RTK joined participants count", { count: (joinedParticipants as unknown[]).length });
      (joinedParticipants as Record<string, unknown>[]).forEach((p, i) => {
        this.log.debug(`RTK Participant [${i}]`, {
          id: p.id,
          name: p.name,
          videoEnabled: p.videoEnabled,
          audioEnabled: p.audioEnabled,
          screenShareEnabled: p.screenShareEnabled,
          hasVideoTrack: !!p.videoTrack,
          hasAudioTrack: !!p.audioTrack,
          hasScreenShareTracks: !!p.screenShareTracks,
          screenShareTracksKeys: p.screenShareTracks ? Object.keys(p.screenShareTracks as object) : [],
        });
      });
    }
    this.log.debug("=== END DEBUG ===");
  }

  // Getters
  get status(): RoomStatus {
    return this._status;
  }

  get info(): RoomInfo | null {
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

  // Internal methods
  _setStatus(status: RoomStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit("status-changed", status);
    }
  }

  _setInfo(info: RoomInfo): void {
    this._info = info;
  }

  _setLocalParticipant(participant: Participant): void {
    this._localParticipant = participant;
    this._participants.set(participant.id, participant);
  }

  _setTokens(tokens: TokenSet): void {
    this._tokens = tokens;
  }

  get tokens(): TokenSet | null {
    return this._tokens;
  }

  private setupWSListeners(): void {
    if (!this.wsClient) return;

    this.wsClient.on("connected", () => {
      this.log.info("WebSocket connected");
      if (!this.rtkClient) {
        this._setStatus("connected");
      }
    });

    this.wsClient.on("disconnected", () => {
      this.log.info("WebSocket disconnected");
      if (!this.rtkClient) {
        this._setStatus("disconnected");
      }
    });

    this.wsClient.on("reconnecting", () => {
      this.log.info("WebSocket reconnecting");
      if (!this.rtkClient) {
        this._setStatus("reconnecting");
      }
    });

    // CRITICAL: Only set up WS participant handlers when RTK is NOT active
    // RTK is the source of truth for participant presence (has media tracks)
    // WS uses different participant IDs than RTK, causing duplicates
    if (!this.rtkClient) {
      this.wsClient.on("participant.joined", (data) => {
        if (this._participants.has(data.id)) {
          this.log.debug("Skipping duplicate WS participant", { id: data.id });
          return;
        }
        this.log.info("Participant joined", { name: data.displayName, id: data.id });
        this._participants.set(data.id, data);
        this.emit("participant-joined", data);
      });

      this.wsClient.on("participant.left", (data) => {
        this.log.info("Participant left", { id: data.participantId });
        const participant = this._participants.get(data.participantId);
        this._participants.delete(data.participantId);
        if (participant) {
          this.emit("participant-left", data.participantId);
        }
      });

      this.wsClient.on("participant.updated", (data) => {
        const participant = this._participants.get(data.participantId);
        if (participant) {
          const updated = { ...participant, ...data.changes };
          this._participants.set(data.participantId, updated);
          this.emit("participant-updated", {
            participantId: data.participantId,
            participant: updated,
          });
        }
      });
    } else {
      this.log.debug("RTK active, skipping WS participant handlers");
    }

    this.wsClient.on("chat.message", (data) => {
      this.log.debug("Chat message received", { from: data.senderName, count: this._messages.length + 1 });
      this._messages.push(data);
      this.emit("chat-message", data);
    });

    this.wsClient.on("reaction", (data) => {
      this.emit("reaction", data);
    });

    this.wsClient.on("hand.raised", (data) => {
      const participant = this._participants.get(data.participantId);
      if (participant) {
        participant.handRaised = true;
        this.emit("participant-updated", {
          participantId: data.participantId,
          participant,
        });
      }
      this.emit("hand-raised", { participantId: data.participantId });
    });

    this.wsClient.on("hand.lowered", (data) => {
      const participant = this._participants.get(data.participantId);
      if (participant) {
        participant.handRaised = false;
        this.emit("participant-updated", {
          participantId: data.participantId,
          participant,
        });
      }
      this.emit("hand-lowered", { participantId: data.participantId });
    });

    this.wsClient.on("recording.started", (data) => {
      this._currentRecording = { id: data.recordingId };
      this.emit("recording-started", { recordingId: data.recordingId });
    });

    this.wsClient.on("recording.stopped", (data) => {
      const recording: Recording = {
        id: this._currentRecording?.id ?? data.recordingId,
        roomId: this.id,
        status: "processing",
        durationSeconds: data.duration,
      };
      this._currentRecording = null;
      this.emit("recording-stopped", recording);
    });

    this.wsClient.on("error", (data) => {
      this.emit("error", {
        code: data.code,
        message: data.message,
      });
    });

    this.wsClient.on("room.snapshot", (snapshot) => {
      this.log.debug("Room snapshot received", { participants: snapshot.participants.length });

      // CRITICAL: When RTK is active, it manages participants (different IDs than WS)
      // Only use snapshot for non-participant data like recording state
      if (this.rtkClient) {
        this.log.debug("RTK active, skipping snapshot participant sync");
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
          this.log.info("New participant from snapshot", { name: p.displayName });
          this.emit("participant-joined", p);
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
      this.log.debug("Whiteboard data received", {
        participantId: data.participantId,
        seq: data.seq,
        elements: Array.isArray(data.elements) ? data.elements.length : 0,
      });
      this.emit("whiteboard-update", {
        participantId: data.participantId,
        displayName: data.displayName,
        elements: data.elements,
        files: data.files,
        seq: data.seq,
      });
    });

    this.wsClient.on("whiteboard.cursor", (data) => {
      // Don't log cursor - too noisy
      this.emit("whiteboard-cursor", {
        participantId: data.participantId,
        displayName: data.displayName,
        x: data.x,
        y: data.y,
      });
    });

    this.wsClient.on("permission.changed", (data) => {
      this.log.info("Permission changed", { participantId: data.participantId, feature: data.feature, canDraw: data.canDraw });
      if (data.feature === "whiteboard") {
        this._whiteboardPermissions.set(data.participantId, data.canDraw);
        this.emit("whiteboard-permission-changed", {
          participantId: data.participantId,
          canDraw: data.canDraw,
        });
      }
    });

    this.wsClient.on("whiteboard.opened", (data) => {
      this.log.info("Whiteboard opened", { participantId: data.participantId, displayName: data.displayName });
      this.emit("whiteboard-opened", {
        participantId: data.participantId,
        displayName: data.displayName,
      });
    });

    this.wsClient.on("whiteboard.closed", (data) => {
      this.log.info("Whiteboard closed", { participantId: data.participantId });
      this.emit("whiteboard-closed", {
        participantId: data.participantId,
      });
    });
  }

  attachWsClient(wsClient: WSClient): void {
    if (this.wsClient === wsClient) return;
    this.wsClient = wsClient;
    this.setupWSListeners();
  }

  /**
   * Map a RealtimeKit participant to Chalk Participant type
   */
  private mapRTKParticipant(rtkParticipant: unknown): Participant {
    const p = rtkParticipant as {
      id: string;
      userId?: string;
      name?: string;
      videoEnabled?: boolean;
      audioEnabled?: boolean;
      videoTrack?: MediaStreamTrack;
      audioTrack?: MediaStreamTrack;
      screenShareEnabled?: boolean;
      screenShareTracks?: {
        audio?: MediaStreamTrack;
        video?: MediaStreamTrack;
      };
    };

    return {
      id: p.id,
      userId: p.userId, // Used for chat message matching
      displayName: p.name ?? "Unknown",
      role: "participant",
      isLocal: false,
      videoEnabled: p.videoEnabled ?? false,
      audioEnabled: p.audioEnabled ?? false,
      videoTrack: p.videoTrack,
      audioTrack: p.audioTrack,
      screenShareTrack: p.screenShareTracks?.video,
      screenShareAudioTrack: p.screenShareTracks?.audio,
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
      const debugEvents = ['participantJoined', 'participantLeft', 'videoUpdate', 'audioUpdate', 'screenShareUpdate'];
      debugEvents.forEach(evt => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.rtkClient!.participants.joined as any).on(evt, (data: unknown) => {
            this.log.debug(`RTK event: ${evt}`, data);
          });
        } catch {
          this.log.debug(`Failed to attach RTK listener: ${evt}`);
        }
      });
      this.log.debug("RTK debug listeners attached");
    }

    // Log RTK client structure for debugging
    if (this.debug) {
      this.log.debug("RTK client structure", {
        hasParticipants: !!this.rtkClient.participants,
        hasSelf: !!this.rtkClient.self,
        hasChat: !!this.rtkClient.chat,
      });
    }

    // Room joined event
    this.rtkClient.self.on("roomJoined", () => {
      this.log.info("Room joined");
      this._setStatus("connected");

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
    });

    // Room left event
    this.rtkClient.self.on("roomLeft", () => {
      this.log.info("Room left");
      this._setStatus("disconnected");
    });

    // Video update for local user
    this.rtkClient.self.on(
      "videoUpdate",
      (data: {
        videoEnabled: boolean;
        videoTrack: MediaStreamTrack | null;
      }) => {
        this.log.debug("Local video update", { enabled: data.videoEnabled, hasTrack: !!data.videoTrack });
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

          this.emit("participant-updated", {
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
        this.log.debug("Local audio update", { enabled: data.audioEnabled, hasTrack: !!data.audioTrack });
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

          this.emit("participant-updated", {
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
        this.log.debug("Local screen share update", {
          enabled: data.screenShareEnabled,
          hasVideo: !!data.screenShareTracks?.video,
          hasAudio: !!data.screenShareTracks?.audio,
        });
        if (this._localParticipant) {
          this._localParticipant.isScreenSharing = data.screenShareEnabled;
          this._localParticipant.screenShareTrack =
            data.screenShareTracks?.video ?? undefined;
          this._localParticipant.screenShareAudioTrack =
            data.screenShareTracks?.audio ?? undefined;
          this.emit("participant-updated", {
            participantId: this._localParticipant.id,
            participant: this._localParticipant,
          });
        }
      },
    );

    // Participant joined
    this.rtkClient.participants.joined.on(
      "participantJoined",
      (rtkParticipant: unknown) => {
        const raw = rtkParticipant as Record<string, unknown>;

        // Skip if this is the local participant (RTK may include self in joined list)
        if (this._localParticipant && raw.id === this._localParticipant.id) {
          this.log.debug("Skipping participantJoined for local user", { id: raw.id });
          return;
        }

        const participant = this.mapRTKParticipant(rtkParticipant);

        // CRITICAL: Skip if participant already exists (prevents duplicates from WS + RTK)
        if (this._participants.has(participant.id)) {
          this.log.debug("Skipping duplicate participantJoined", { id: participant.id });
          return;
        }

        this.log.info("Participant joined", {
          name: participant.displayName,
          id: participant.id,
          video: participant.videoEnabled,
          audio: participant.audioEnabled,
        });
        this._participants.set(participant.id, participant);
        this.emit("participant-joined", participant);
      },
    );

    // Participant left
    this.rtkClient.participants.joined.on(
      "participantLeft",
      (rtkParticipant: unknown) => {
        const p = rtkParticipant as { id: string };
        this.log.info("Participant left", { id: p.id });
        this._participants.delete(p.id);
        this.emit("participant-left", p.id);
      },
    );

    // Participant video update
    this.rtkClient.participants.joined.on(
      "videoUpdate",
      (rtkParticipant: unknown) => {
        const participant = this.mapRTKParticipant(rtkParticipant);
        this.log.debug("Remote video update", { id: participant.id, enabled: participant.videoEnabled });

        const existing = this._participants.get(participant.id);
        if (existing) {
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

          this.emit("participant-updated", {
            participantId: participant.id,
            participant: updated,
          });
        } else {
          this.log.warn("Video update for unknown participant", { id: participant.id });
        }
      },
    );

    // Participant audio update
    this.rtkClient.participants.joined.on(
      "audioUpdate",
      (rtkParticipant: unknown) => {
        const participant = this.mapRTKParticipant(rtkParticipant);
        this.log.debug("Remote audio update", { id: participant.id, enabled: participant.audioEnabled });

        const existing = this._participants.get(participant.id);
        if (existing) {
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

          this.emit("participant-updated", {
            participantId: participant.id,
            participant: updated,
          });
        } else {
          this.log.warn("Audio update for unknown participant", { id: participant.id });
        }
      },
    );

    // Participant screen share update
    this.rtkClient.participants.joined.on(
      "screenShareUpdate",
      (rtkParticipant: unknown) => {
        const participant = this.mapRTKParticipant(rtkParticipant);
        this.log.debug("Remote screen share update", {
          id: participant.id,
          sharing: participant.isScreenSharing,
          hasTrack: !!participant.screenShareTrack,
        });

        const existing = this._participants.get(participant.id);
        if (existing) {
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

          this.emit("participant-updated", {
            participantId: participant.id,
            participant: updated,
          });
        } else {
          this.log.warn("Screen share update for unknown participant", { id: participant.id });
        }
      },
    );

    // RTK Chat message handling
    if (this.rtkClient.chat) {
      this.log.debug("Setting up RTK chat listeners");

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
          this.log.debug("Skipping non-add chat action", { action: rawData.action });
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
          this.log.warn("Chat content is not a string, converting");
          chatMessage.content = String(chatMessage.content);
        }

        return chatMessage;
      };

      // Handler for chat events
      const chatEventHandler = (eventName: string) => (payload: unknown) => {
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
          this.log.debug("Skipping duplicate chat message", { id: chatMessage.id });
          return;
        }

        this.log.debug("Chat message via RTK", { event: eventName, from: chatMessage.senderName });
        this._messages.push(chatMessage);
        this.emit("chat-message", chatMessage);
      };

      // Register handlers for various chat events (different RTK versions may use different names)
      const chatEvents = ["chatUpdate", "newMessage", "messageReceived", "message"];
      for (const eventName of chatEvents) {
        try {
          chat.on(eventName, chatEventHandler(eventName));
          this.log.debug("Registered RTK chat handler", { event: eventName });
        } catch {
          this.log.debug("Could not register RTK chat handler", { event: eventName });
        }
      }
    } else {
      this.log.debug("RTK chat module not available");
    }

    // Transcription support (if enabled in preset)
    this.setupTranscriptListener();

    this.setupActiveSpeakerListener();
  }

  private setupTranscriptListener(): void {
    if (!this.rtkClient) return;

    // Access RTK ai module for transcription (may not be available in all versions)
    const ai = (this.rtkClient as unknown as { ai?: {
      transcripts?: unknown[];
      on?: (event: string, handler: (data: unknown) => void) => void;
    } }).ai;

    if (!ai) {
      this.log.debug("RTK ai module not available");
      return;
    }

    this.log.debug("Setting up transcript listener");

    // Load existing transcripts if available
    if (Array.isArray(ai.transcripts)) {
      for (const t of ai.transcripts) {
        const transcript = this.mapRTKTranscript(t);
        if (transcript) {
          this._transcripts.push(transcript);
        }
      }
      this.log.debug("Loaded existing transcripts", { count: this._transcripts.length });
    }

    // Listen for new transcripts
    if (typeof ai.on === "function") {
      ai.on("transcript", (data: unknown) => {
        const transcript = this.mapRTKTranscript(data);
        if (transcript) {
          this._transcripts.push(transcript);
          this.emit("transcript", transcript);
          this.log.debug("Transcript received", { speaker: transcript.speakerName });
        }
      });
      this.log.debug("Transcript handler registered");
    }
  }

  private mapRTKTranscript(data: unknown): Transcript | null {
    if (!data || typeof data !== "object") return null;

    const raw = data as Record<string, unknown>;

    // Handle various RTK transcript formats
    const participantId = (raw.participantId as string) ?? (raw.userId as string) ?? (raw.peerId as string) ?? "";
    const speakerName = (raw.participantName as string) ?? (raw.displayName as string) ?? (raw.name as string) ?? "Unknown";
    const text = (raw.text as string) ?? (raw.transcript as string) ?? (raw.content as string) ?? "";

    if (!text) return null;

    return {
      id: (raw.id as string) ?? crypto.randomUUID(),
      participantId,
      speakerName,
      text,
      timestamp: raw.timestamp ? new Date(raw.timestamp as string | number) : new Date(),
      isInterim: (raw.isInterim as boolean) ?? (raw.isFinal === false),
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
        const speakerId = (speaker as { id: string }).id;
        const participant = this._participants.get(speakerId) ?? null;
        if (this._activeSpeaker?.id !== participant?.id) {
          this._activeSpeaker = participant;
          this.emit("active-speaker-changed", participant);
        }
      } else {
        if (this._activeSpeaker !== null) {
          this._activeSpeaker = null;
          this.emit("active-speaker-changed", null);
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
        this.log.debug("Cannot access peer connection for bitrate boost");
        return;
      }

      const senders = pc.getSenders();
      const videoSender = senders.find(
        (s) => s.track?.kind === "video"
      );

      if (!videoSender) {
        this.log.debug("No video sender found for bitrate boost");
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
      this.log.info("Video bitrate boosted to 2.5 Mbps");
    } catch (error) {
      // Fail silently - this is an optimization, not critical
      this.log.debug("Could not boost video bitrate", { error });
    }
  }

  // Media controls using RealtimeKit
  async toggleVideo(): Promise<boolean> {
    if (!this.rtkClient || !this._localParticipant) {
      return false;
    }

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
      return this._localParticipant.videoEnabled;
    } catch (error) {
      this.log.error("Failed to toggle video", { error });
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

    try {
      if (this.rtkClient.self.audioEnabled) {
        await this.rtkClient.self.disableAudio();
        this._localParticipant.audioEnabled = false;
        this._localParticipant.audioTrack = undefined;
        this.log.info("Audio disabled");
      } else {
        await this.rtkClient.self.enableAudio();
        this._localParticipant.audioEnabled = true;
        this._localParticipant.audioTrack =
          this.rtkClient.self.audioTrack ?? undefined;
        this.log.info("Audio enabled");
      }
      return this._localParticipant.audioEnabled;
    } catch (error) {
      this.log.error("Failed to toggle audio", { error });
      this.emit("error", {
        code: "MEDIA_ERROR",
        message: "Failed to toggle microphone",
      });
      return this._localParticipant.audioEnabled;
    }
  }

  async startScreenShare(_options?: ScreenShareOptions): Promise<boolean> {
    if (!this._localParticipant || !this.rtkClient) return false;

    if (this._localParticipant.isScreenSharing) return true;

    try {
      await this.rtkClient.self.enableScreenShare();
      this._localParticipant.isScreenSharing = true;
      this.log.info("Screen share started");
      return true;
    } catch (error) {
      this.log.error("Failed to start screen share", { error });
      this.emit("error", {
        code: "SCREEN_SHARE_ERROR",
        message: "Failed to start screen sharing",
      });
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this._localParticipant || !this.rtkClient) return;

    if (!this._localParticipant.isScreenSharing) return;

    try {
      await this.rtkClient.self.disableScreenShare();
      this._localParticipant.isScreenSharing = false;
      this._localParticipant.screenShareTrack = undefined;
      this.log.info("Screen share stopped");
    } catch (error) {
      this.log.error("Failed to stop screen share", { error });
    }
  }

  // ===== Device Management =====

  /**
   * Get list of available media devices
   */
  async getDevices(): Promise<MediaDevice[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.log.debug("Enumerated devices", { count: devices.length });
      return devices.map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
        kind: d.kind as MediaDeviceKind,
      }));
    } catch (error) {
      this.log.error("Failed to enumerate devices", { error });
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
      this.log.info("Camera selected", { deviceId: deviceId.slice(0, 8) });
      return true;
    } catch (error) {
      this.log.error("Failed to select camera", { deviceId: deviceId.slice(0, 8), error });
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
      this.log.info("Microphone selected", { deviceId: deviceId.slice(0, 8) });
      return true;
    } catch (error) {
      this.log.error("Failed to select microphone", { deviceId: deviceId.slice(0, 8), error });
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
    this.log.debug("Sending chat message", { length: trimmed.length });

    // Try WSClient first, fallback to RealtimeKit
    if (this.wsClient) {
      this.wsClient.sendChatMessage(trimmed);
      // WSClient will echo the message back via chat.message event
    } else if (this.rtkClient) {
      try {
        this.rtkClient.chat?.sendTextMessage(trimmed);
        // RTK echoes messages back via chatUpdate event, so don't add locally
      } catch (e) {
        this.log.error("Chat send failed", { error: e });
      }
    } else {
      // No client available - add locally for demo/testing only
      this.log.debug("No client, adding message locally");
      const localMessage: ChatMessage = {
        id: crypto.randomUUID(),
        senderId: this._localParticipant?.id ?? "local",
        senderName: this._localParticipant?.displayName ?? "You",
        content: trimmed,
        timestamp: new Date(),
      };
      this._messages.push(localMessage);
      this.emit("chat-message", localMessage);
    }
  }

  // Reactions
  sendReaction(emoji: ReactionEmoji): void {
    this.log.debug("Sending reaction", { emoji });
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
        this.log.warn("Reactions not available");
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

    this.emit("hand-raised", { participantId: this._localParticipant.id });
  }

  lowerHand(): void {
    if (!this._localParticipant) return;

    this._localParticipant.handRaised = false;

    // Try WSClient first
    if (this.wsClient) {
      this.wsClient.lowerHand();
    }

    this.emit("hand-lowered", { participantId: this._localParticipant.id });
  }

  // CRITICAL: Async leave with proper cleanup sequencing
  async leave(): Promise<void> {
    if (this.isLeaving && this.leavePromise) {
      this.log.debug("Leave already in progress");
      return this.leavePromise;
    }

    this.isLeaving = true;
    this.log.info("Leaving room");

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
            this.log.debug("RTK leave completed");
          } catch (e) {
            this.log.warn("Error during RTK leave", { error: e });
          }
        }

        // Give browser time to release media devices
        await new Promise(resolve => setTimeout(resolve, 100));

        // Clear state after disconnect
        this._participants.clear();
        this._activeSpeaker = null;
        this._messages = [];
        this._currentRecording = null;
        this._localParticipant = null;

        this._setStatus("disconnected");
        this.log.info("Room cleanup completed");
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
      this.log.warn("Only host can grant permissions");
      return;
    }
    this.log.info("Granting whiteboard permission", { participantId });
    this.wsClient?.grantWhiteboardPermission(participantId);
  }

  /**
   * Revoke whiteboard drawing permission from a participant (host only)
   */
  revokeWhiteboardPermission(participantId: string): void {
    if (this._localParticipant?.role !== "host") {
      this.log.warn("Only host can revoke permissions");
      return;
    }
    this.log.info("Revoking whiteboard permission", { participantId });
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
