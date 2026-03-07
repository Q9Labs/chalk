/**
 * ChalkSession - Main orchestrator for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/session
 */

import { Effect, ManagedRuntime } from "effect";
import { ConferenceClient } from "../client";
import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import { ChatManager } from "../managers/chat-manager";
import { InteractionManager } from "../managers/interaction-manager";
import { RecordingManager } from "../managers/recording-manager";
import { ScreenShareManager } from "../managers/screen-share-manager";
import { UIManager } from "../managers/ui-manager";
import { WhiteboardManager } from "../managers/whiteboard-manager";
import type { ConferenceSession } from "../room";
import { makeManagerServicesLayer } from "../effect/services/manager-layers";
import { RoomService } from "../effect/services/room-service";
import type { ParticipantService } from "../effect/services/participant-service";
import type { MediaService } from "../effect/services/media-service";
import type { JoinOptions, LeaveOptions } from "../effect/services/room-service";
import { RoomError } from "../effect/errors";
import { TypedEventEmitter } from "../utils/typed-emitter";
import { wideEvents } from "../wide-events/index";
import type { ChalkIncident, ChalkIncidentBreadcrumb, ChalkIncidentConfig, ChalkIncidentInput, ChalkIncidentSource } from "../incident.ts";
import type { ChalkPostHogConfig } from "../posthog.ts";
import type { CreateRoomOptions, RoomResource, ScheduleRoomOptions } from "../types.ts";
import { createDefaultMediaState, createDefaultParticipantState, createDefaultRoomState, createSessionStateApis, type MediaSessionApi, type ParticipantSessionApi, type RoomSessionApi, type SessionStateUpdaters } from "./chalk-session-state";
import { ChalkSessionIncidentPipeline } from "./chalk-session-incidents";
import { attachRoomToManagersAndBridgeState } from "./chalk-session-bridges";

/** ChalkSession configuration */
export interface ChalkSessionConfig {
  /** Base API URL */
  apiUrl: string;
  /** WebSocket URL (optional, derived from apiUrl if not provided) */
  wsUrl?: string;
  /** JWT access token */
  token?: string;
  /** Token provider for refresh */
  tokenProvider?: () => Promise<string>;
  /**
   * API key (deprecated; prefer `token` or `tokenProvider`).
   * @deprecated Will be removed in v2.
   */
  apiKey?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Use demo API endpoints (demoJoin instead of addParticipant) */
  demoMode?: boolean;
  /** Incident reporting callback + transport options. */
  incident?: ChalkIncidentConfig;
  /** Optional PostHog session replay integration. */
  posthog?: ChalkPostHogConfig;
}

/** ChalkSession events */
export interface ChalkSessionEvents {
  /** Successfully connected to room */
  connected: { roomId: string };
  /** Disconnected from room */
  disconnected: { reason: string };
  /** Connection status changed */
  "status:changed": { status: string };
  /** Error occurred */
  error: ChalkError;
  /** Token expired (need to provide new token) */
  "token.expired": void;
}

/**
 * ChalkSession orchestrates all managers and provides
 * a unified interface for video conferencing.
 *
 * @example
 * ```ts
 * const session = new ChalkSession({
 *   apiUrl: 'https://api.chalk.video',
 *   token: 'jwt_xxx',
 * });
 *
 * await session.join('room_123', { userName: 'John' });
 *
 * // Access managers
 * await session.media.toggleVideo();
 * session.chat.sendMessage('Hello!');
 * ```
 */
export class ChalkSession extends TypedEventEmitter<ChalkSessionEvents> {
  /** ConferenceSession API object with state and events */
  readonly room: RoomSessionApi;

  /** Participants API object with state and events */
  readonly participants: ParticipantSessionApi;

  /** Media API object with state and events */
  readonly media: MediaSessionApi;

  /** Screen share manager */
  readonly screenShare: ScreenShareManager;

  /** Chat messages manager */
  readonly chat: ChatManager;

  /** Recording manager */
  readonly recording: RecordingManager;

  /** Reactions and hand raise manager */
  readonly interactions: InteractionManager;

  /** UI state manager */
  readonly ui: UIManager;

  /** Whiteboard collaboration manager */
  readonly whiteboard: WhiteboardManager;

  private readonly client: ConferenceClient;
  private _runtime: ManagedRuntime.ManagedRuntime<RoomService | ParticipantService | MediaService, never>;
  private _currentRoom: ConferenceSession | null = null;
  private readonly incidentPipeline: ChalkSessionIncidentPipeline;
  private readonly stateUpdaters: SessionStateUpdaters;
  private roomBridgeCleanup: (() => void) | null = null;

  constructor(config: ChalkSessionConfig) {
    super();
    const debug = config.debug ?? false;

    // Initialize ConferenceClient for API/WebRTC
    this.client = new ConferenceClient({
      apiUrl: config.apiUrl,
      wsUrl: config.wsUrl,
      token: config.token,
      tokenProvider: config.tokenProvider,
      apiKey: config.apiKey,
      debug,
      demoMode: config.demoMode,
      posthog: config.posthog,
    });

    // Create managed runtime for Effect services
    this._runtime = ManagedRuntime.make(makeManagerServicesLayer(debug));

    const sessionState = createSessionStateApis({
      runtime: this._runtime,
      getCurrentRoom: () => this._currentRoom,
    });
    this.room = sessionState.room;
    this.participants = sessionState.participants;
    this.media = sessionState.media;
    this.stateUpdaters = sessionState.updaters;
    this.incidentPipeline = new ChalkSessionIncidentPipeline({
      emitError: (error) => this.emit("error", error),
      getSnapshot: () => ({
        roomId: this.room.getState().roomId,
        localParticipantId: this.participants.getState().localParticipant?.id ?? null,
      }),
    });
    this.configureIncident(config.incident);

    // Initialize other managers (non-Effect)
    this.screenShare = new ScreenShareManager();
    this.chat = new ChatManager();
    this.recording = new RecordingManager();
    this.interactions = new InteractionManager();
    this.ui = new UIManager();
    this.whiteboard = new WhiteboardManager();

    // Emit session init event
    const initCtx = wideEvents.start("session.init");
    initCtx.set("config", { apiUrl: config.apiUrl, debug, demoMode: config.demoMode });
    initCtx.complete("success");

    this.setupEventForwarding();
    this._initEventBridges();
  }

  configureIncident(config?: ChalkIncidentConfig): void {
    this.incidentPipeline.configure(config);
  }

  configurePostHog(config?: ChalkPostHogConfig): void {
    this.client.configurePostHog(config);
  }

  recordIncidentBreadcrumb(
    breadcrumb: Omit<ChalkIncidentBreadcrumb, "timestamp"> & {
      timestamp?: string;
    },
  ): void {
    this.incidentPipeline.recordBreadcrumb(breadcrumb);
  }

  private emitErrorWithIncident(error: ChalkError, source: ChalkIncidentSource, details?: Record<string, unknown>): void {
    this.incidentPipeline.emitErrorWithIncident(error, source, details);
  }

  async reportIncident(incidentInput: ChalkIncidentInput): Promise<ChalkIncident | null> {
    return this.incidentPipeline.reportIncident(incidentInput);
  }

  private setupEventForwarding(): void {
    // Forward room events
    this.room._emitter.on("connected", (data) => {
      this.recordIncidentBreadcrumb({
        category: "room",
        message: "ConferenceSession connected",
        data,
      });
      this.emit("connected", data);
    });

    this.room._emitter.on("disconnected", (data) => {
      this.recordIncidentBreadcrumb({
        category: "room",
        message: "ConferenceSession disconnected",
        data,
      });
      this.emit("disconnected", data);
    });

    this.room._emitter.on("status:changed", (data) => {
      this.recordIncidentBreadcrumb({
        category: "room",
        message: "ConferenceSession status changed",
        data,
      });
      this.emit("status:changed", data);
    });

    this.room._emitter.on("error", (error) => {
      this.emitErrorWithIncident(error, "room");
    });

    // Forward errors from all managers
    this.media._emitter.on("error", (error) => this.emitErrorWithIncident(error, "media"));
    this.screenShare.on("error", (error) => this.emitErrorWithIncident(error, "screen_share"));
    this.chat.on("error", (error) => this.emitErrorWithIncident(error, "chat"));
    this.recording.on("error", (error) => this.emitErrorWithIncident(error, "recording"));
    this.interactions.on("error", (error) => this.emitErrorWithIncident(error, "interactions"));
    this.whiteboard.on("error", (error) => this.emitErrorWithIncident(error, "whiteboard"));

    // Forward token expired from client
    this.client.on("token.expired", () => {
      this.emit("token.expired", undefined);
      void this.reportIncident({
        severity: "warning",
        source: "api",
        code: "TOKEN_EXPIRED",
        message: "Token expired",
        stage: "auth_refresh",
      });
    });
  }

  private _initEventBridges(): void {
    // State bridges are set up in attachRoomToManagers when room connects
    // This method is kept for initialization order consistency
  }

  private attachRoomToManagers(room: ConferenceSession): void {
    this.roomBridgeCleanup?.();
    this.roomBridgeCleanup = attachRoomToManagersAndBridgeState({
      room,
      setCurrentRoom: (nextRoom) => {
        this._currentRoom = nextRoom;
      },
      roomApi: this.room,
      participantsApi: this.participants,
      mediaApi: this.media,
      stateUpdaters: this.stateUpdaters,
      runtime: this._runtime,
      screenShare: this.screenShare,
      chat: this.chat,
      recording: this.recording,
      interactions: this.interactions,
      whiteboard: this.whiteboard,
      startRecording: () => this.client.startRecording(),
      stopRecording: () => this.client.stopRecording(),
    });
  }

  /**
   * Join a room
   *
   * @param roomId - ConferenceSession ID to join
   * @param options - Join options including userName
   */
  async join(roomId: string, options: JoinOptions): Promise<void> {
    try {
      // Signal join starting via Effect service
      await this._runtime.runPromise(
        Effect.gen(function* () {
          const roomSvc = yield* RoomService;
          yield* roomSvc.requestJoin(roomId, options);
        }),
      );

      // Actually join via ConferenceClient
      const room = await this.client.joinSession(roomId, {
        displayName: options.userName,
        role: options.role,
        audio: options.audioEnabled,
        video: options.videoEnabled,
        metadata: options.metadata,
      });

      // Attach room to all managers
      this.attachRoomToManagers(room);
    } catch (err) {
      const error = ChalkError.wrap(err);
      const roomError = new RoomError({
        code: "ROOM_NOT_FOUND",
        message: error.message,
        recoverable: false,
      });
      await this._runtime
        .runPromise(
          Effect.gen(function* () {
            const roomSvc = yield* RoomService;
            yield* roomSvc.joinFailed(roomError);
          }),
        )
        .catch(() => {
          // Ignore if join failed operation fails
        });
      this.emitErrorWithIncident(error, "session", {
        operation: "join",
        roomId,
      });
      throw error;
    }
  }

  /**
   * Leave the current room
   *
   * @param options - Leave options (endForAll for hosts)
   */
  async leave(options?: LeaveOptions): Promise<void> {
    try {
      await this._runtime.runPromise(
        Effect.gen(function* () {
          const roomSvc = yield* RoomService;
          yield* roomSvc.leave(options);
        }),
      );
      this.client.disconnect();
      this.roomBridgeCleanup?.();
      this.roomBridgeCleanup = null;
      this._currentRoom = null;

      // Ensure hooks see a clean slate after leaving (ConferenceSession.leave clears maps without per-participant events).
      this.resetSessionState();
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "leave",
      });
      throw error;
    }
  }

  private resetSessionState(): void {
    this.stateUpdaters.updateRoomState(createDefaultRoomState());
    this.stateUpdaters.updateParticipantState(createDefaultParticipantState());
    this.stateUpdaters.updateMediaState(createDefaultMediaState());
  }

  /**
   * Create a new room (requires API key or host permissions)
   *
   * @param name - Optional room name
   * @param config - Optional room configuration
   * @returns ConferenceSession ID
   */
  async createSession(name?: string, config?: Record<string, unknown>): Promise<string> {
    try {
      return await this.client.createSession(name, config);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "create_room",
      });
      throw error;
    }
  }

  /**
   * Create a room without joining it.
   */
  async createRoom(options: CreateRoomOptions = {}): Promise<RoomResource> {
    try {
      return await this.client.createRoom(options);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "create_room_resource",
      });
      throw error;
    }
  }

  /**
   * Schedule a room for future activation.
   */
  async scheduleRoom(options: ScheduleRoomOptions): Promise<RoomResource> {
    try {
      return await this.client.scheduleRoom(options);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "schedule_room",
      });
      throw error;
    }
  }

  /**
   * End a room for all participants (host only)
   *
   * @param roomId - ConferenceSession ID to end
   */
  async endSession(roomId: string): Promise<void> {
    try {
      await this.client.endSession(roomId);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "end_room",
        roomId,
      });
      throw error;
    }
  }

  /**
   * Remove a participant from the room (host only)
   *
   * @param participantId - Participant ID to remove
   */
  async removeParticipant(participantId: string): Promise<void> {
    try {
      await this.client.removeParticipant(participantId);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "session", {
        operation: "remove_participant",
        participantId,
      });
      throw error;
    }
  }

  /**
   * Mute a participant (host only).
   *
   * @param participantId - Participant ID to mute
   */
  muteParticipant(participantId: string): void {
    const room = this.room.getRoom();
    room?.muteParticipant(participantId);
  }

  /**
   * Unmute a participant (host only).
   *
   * @param participantId - Participant ID to unmute
   */
  unmuteParticipant(participantId: string): void {
    const room = this.room.getRoom();
    room?.unmuteParticipant(participantId);
  }

  async whiteboardPresignUpload(fileId: string, mimeType: string): Promise<{ uploadUrl: string; expiresAtMs: number }> {
    const roomId = this.room.getState().roomId;
    if (!roomId) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    try {
      return await this.client.presignWhiteboardUpload(roomId, fileId, mimeType);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "whiteboard", {
        operation: "presign_upload",
        fileId,
      });
      throw error;
    }
  }

  async whiteboardPresignDownload(fileId: string): Promise<{ downloadUrl: string; expiresAtMs: number }> {
    const roomId = this.room.getState().roomId;
    if (!roomId) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    try {
      return await this.client.presignWhiteboardDownload(roomId, fileId);
    } catch (err) {
      const error = ChalkError.wrap(err);
      this.emitErrorWithIncident(error, "whiteboard", {
        operation: "presign_download",
        fileId,
      });
      throw error;
    }
  }

  /** Get current connection status */
  get status(): string {
    return this.room.getState().status;
  }

  /** Whether currently connected to a room */
  get isConnected(): boolean {
    return this.room.getState().status === "connected";
  }

  /** Current room ID (null if not connected) */
  get roomId(): string | null {
    return this.room.getState().roomId;
  }

  /** Get underlying ConferenceClient (for advanced use) */
  get chalkClient(): ConferenceClient {
    return this.client;
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    const ctx = wideEvents.start("session.dispose");

    // Dispose Effect services runtime
    this._runtime.dispose();

    // Dispose non-Effect managers
    this.screenShare.dispose();
    this.chat.dispose();
    this.recording.dispose();
    this.interactions.dispose();
    this.ui.dispose();
    this.whiteboard.dispose();

    this.client.disconnect();
    this.roomBridgeCleanup?.();
    this.roomBridgeCleanup = null;
    this._currentRoom = null;
    this.removeAllListeners();

    ctx.complete("success");
  }
}
