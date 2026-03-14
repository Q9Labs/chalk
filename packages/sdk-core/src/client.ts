/**
 * ConferenceClient - Main entry point for the Chalk SDK
 * Composed from focused modules for config and join orchestration.
 */

import { Effect } from "effect";
import { APIClient } from "./api-client.ts";
import {
  createJoinToken as createJoinTokenOp,
  createRoom as createRoomOp,
  createSession as createSessionOp,
  disconnectCurrentRoom,
  endSession as endSessionOp,
  exchangeJoinToken as exchangeJoinTokenOp,
  listRooms as listRoomsOp,
  presignWhiteboardDownload as presignWhiteboardDownloadOp,
  presignWhiteboardUpload as presignWhiteboardUploadOp,
  removeParticipant as removeParticipantOp,
  scheduleRoom as scheduleRoomOp,
  startRecording as startRecordingOp,
  stopRecording as stopRecordingOp,
  updateOwnDisplayName as updateOwnDisplayNameOp,
} from "./conference-client/client-room-ops.ts";
import { configureConferenceWideEvents, DEFAULT_API_URL, deriveWsUrl, isTokenExpired as parseTokenExpiry } from "./conference-client/config.ts";
import { createRealtimeKitInitEffect, emitRtkJoinAttemptTelemetry, joinRealtimeKitWithRetry, preloadRealtimeKitBundle } from "./conference-client/join-engine.ts";
import { joinConferenceSession } from "./conference-client/join-session.ts";
import { createJoinLock, isJoinTimeoutError, waitForJoinWithTimeout } from "./conference-client/rtk-runtime.ts";
import { ConnectionError } from "./effect/errors.ts";
import { EventEmitter } from "./events.ts";
import { ChalkPostHogSessionReplay, type ChalkPostHogConfig } from "./posthog.ts";
import { importWebRealtimeKit, type RealtimeKitStatic } from "./realtimekit/runtime.ts";
import { getRtkJoinPolicyForCurrentCohort } from "./rtk-join-policy.ts";
import { ConferenceSession } from "./room.ts";
import type { ChalkError, ConferenceClientConfig, CreateJoinTokenResponse, ExchangeJoinTokenResponse, ListRoomsOptions, ListRoomsResponse, CreateRoomOptions, JoinSessionConfig, RoomResource, ScheduleRoomOptions, SessionConnectionState } from "./types.ts";
import { WSClient } from "./ws-client.ts";

interface ConferenceClientEvents {
  "token.expired": ChalkError;
}

type JoinLock = ReturnType<typeof createJoinLock>;

export class ConferenceClient extends EventEmitter<ConferenceClientEvents> {
  private readonly apiClient: APIClient;
  private readonly wsUrl: string;
  private readonly tokenProvider?: ConferenceClientConfig["tokenProvider"];
  private readonly debug: boolean;
  private readonly demoMode: boolean;
  private readonly realtimeKitLoader: NonNullable<ConferenceClientConfig["realtimeKitLoader"]>;
  private currentSession: ConferenceSession | null = null;
  private currentWsClient: WSClient | null = null;
  private readonly postHogSessionReplay = new ChalkPostHogSessionReplay();
  private readonly joinLock: JoinLock = createJoinLock();
  private realtimeKitClientPromise: Promise<RealtimeKitStatic> | null = null;

  constructor(config: ConferenceClientConfig) {
    super();

    const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    this.debug = config.debug ?? false;
    this.demoMode = config.demoMode ?? false;
    this.wsUrl = config.wsUrl ?? deriveWsUrl(apiUrl);
    this.tokenProvider = config.tokenProvider;
    this.realtimeKitLoader = config.realtimeKitLoader ?? importWebRealtimeKit;
    this.postHogSessionReplay.configure(config.posthog);

    const hasAuth = config.token || config.tokenProvider || config.apiKey || this.debug;
    if (!hasAuth) {
      throw new Error("ConferenceClient requires authentication: provide token, tokenProvider, or apiKey");
    }

    if (config.apiKey) {
      console.warn("[Chalk] DEPRECATION: `apiKey` is deprecated. Use `token` or `tokenProvider` instead. This option will be removed in v2.0.");
    }

    this.apiClient = new APIClient({ ...config, apiUrl });
    this.apiClient.on("token.expired", (error) => {
      this.emit("token.expired", error);
    });

    configureConferenceWideEvents(config);
  }

  configurePostHog(config?: ChalkPostHogConfig): void {
    this.postHogSessionReplay.configure(config);
  }

  async preloadRealtimeKit(): Promise<boolean> {
    return preloadRealtimeKitBundle(() => this._getRealtimeKitClient());
  }

  private trackPostHogLeave(reason: "disconnect" | "switch_room"): void {
    this.postHogSessionReplay.trackLeave({
      reason,
      roomId: this.currentSession?.id,
      participantId: this.currentSession?.localParticipant?.id,
      demoMode: this.demoMode,
    });
  }

  private _importRealtimeKitClient() {
    return this.realtimeKitLoader();
  }

  private _getRealtimeKitClient() {
    if (this.realtimeKitClientPromise === null) {
      this.realtimeKitClientPromise = this._importRealtimeKitClient().catch((error) => {
        this.realtimeKitClientPromise = null;
        throw error;
      });
    }

    return this.realtimeKitClientPromise;
  }

  // Kept as a private instance method for test seam compatibility.
  private isTokenExpired(token: string): boolean {
    return parseTokenExpiry(token);
  }

  private _initRealtimeKitEffect(authToken: string, audio: boolean, video: boolean) {
    return createRealtimeKitInitEffect(authToken, audio, video, () => this._getRealtimeKitClient());
  }

  private _joinRealtimeKitEffect(joinPromise: Promise<void>, timeoutMs: number) {
    return waitForJoinWithTimeout(joinPromise, timeoutMs);
  }

  private _isJoinTimeoutError(error: Error): boolean {
    return isJoinTimeoutError(error);
  }

  private _emitRtkJoinAttemptTelemetry({
    attempt,
    totalAttempts,
    timeoutMs,
    delayMs,
    attemptDurationMs,
    timeoutVsError,
    outcome,
    errorMessage,
    joinPolicySelection,
  }: {
    attempt: number;
    totalAttempts: number;
    timeoutMs: number;
    delayMs: number;
    attemptDurationMs: number;
    timeoutVsError: "timeout" | "error" | "none";
    outcome: "success" | "timeout" | "error";
    errorMessage?: string;
    joinPolicySelection: ReturnType<typeof getRtkJoinPolicyForCurrentCohort>;
  }): void {
    emitRtkJoinAttemptTelemetry({
      attempt,
      totalAttempts,
      timeoutMs,
      delayMs,
      attemptDurationMs,
      timeoutVsError,
      outcome,
      errorMessage,
      joinPolicySelection,
    });
  }

  private async _joinRealtimeKitWithRetry(rtkClient: { join: () => Promise<void> }, joinPolicySelection = getRtkJoinPolicyForCurrentCohort()): Promise<void> {
    return joinRealtimeKitWithRetry(rtkClient, joinPolicySelection, {
      waitForJoin: async (joinPromise, timeoutMs) => {
        await Effect.runPromise(this._joinRealtimeKitEffect(joinPromise, timeoutMs));
      },
      isJoinTimeoutError: (error) => this._isJoinTimeoutError(error),
      emitAttemptTelemetry: (telemetry) => this._emitRtkJoinAttemptTelemetry(telemetry),
    });
  }

  private async initRealtimeKitClient(authToken: string, audio: boolean, video: boolean): Promise<any> {
    return Effect.runPromise(this._initRealtimeKitEffect(authToken, audio, video)).catch((error) => {
      if (error instanceof ConnectionError) {
        throw new Error(`RealtimeKit initialization failed: ${error.message}`);
      }
      throw error;
    });
  }

  async joinSession(sessionId: string, config: JoinSessionConfig): Promise<ConferenceSession> {
    return this.joinLock.withLock(async () => {
      if (this.currentSession) {
        this.trackPostHogLeave("switch_room");
        await this.currentSession.leave();
        this.currentSession = null;
      }

      try {
        const joined = await joinConferenceSession(sessionId, config, {
          apiClient: this.apiClient,
          demoMode: this.demoMode,
          wsUrl: this.wsUrl,
          debug: this.debug,
          tokenProvider: this.tokenProvider,
          isTokenExpired: (token) => this.isTokenExpired(token),
          emitTokenExpired: (error) => this.emit("token.expired", error),
          initRealtimeKitClient: (authToken, audio, video) => this.initRealtimeKitClient(authToken, audio, video),
          joinRealtimeKitWithRetry: (rtkClient, policySelection) => this._joinRealtimeKitWithRetry(rtkClient, policySelection),
        });

        this.currentSession = joined.session;
        this.currentWsClient = joined.wsClient;

        this.postHogSessionReplay.trackJoinSucceeded({
          roomId: joined.roomId,
          participantId: joined.participantId,
          role: joined.role,
          displayName: config.displayName,
          demoMode: this.demoMode,
        });

        if (joined.shouldStartRecording) {
          this.startRecording().catch(() => {
            // non-blocking
          });
        }

        return joined.session;
      } catch (error) {
        this.postHogSessionReplay.trackJoinFailed({
          roomId: sessionId,
          displayName: config.displayName,
          error: error instanceof Error ? error.message : String(error),
          demoMode: this.demoMode,
        });
        throw error;
      }
    });
  }

  async createSession(name?: string, config?: Record<string, unknown>): Promise<string> {
    return createSessionOp(this.apiClient, name, config);
  }

  async createRoom(options: CreateRoomOptions = {}): Promise<RoomResource> {
    return createRoomOp(this.apiClient, options);
  }

  async scheduleRoom(options: ScheduleRoomOptions): Promise<RoomResource> {
    return scheduleRoomOp(this.apiClient, options);
  }

  async listRooms(options: ListRoomsOptions = {}): Promise<ListRoomsResponse> {
    return listRoomsOp(this.apiClient, options);
  }

  async createJoinToken(roomId: string): Promise<CreateJoinTokenResponse> {
    return createJoinTokenOp(this.apiClient, roomId);
  }

  async exchangeJoinToken(joinToken: string): Promise<ExchangeJoinTokenResponse> {
    return exchangeJoinTokenOp(this.apiClient, joinToken);
  }

  async endSession(sessionId: string): Promise<void> {
    return endSessionOp(this.apiClient, sessionId);
  }

  async startRecording(): Promise<string> {
    return startRecordingOp(this.apiClient, this.currentSession);
  }

  async stopRecording(): Promise<void> {
    return stopRecordingOp(this.apiClient, this.currentSession);
  }

  async presignWhiteboardUpload(roomId: string, fileId: string, mimeType: string): Promise<{ uploadUrl: string; expiresAtMs: number }> {
    return presignWhiteboardUploadOp(this.apiClient, roomId, fileId, mimeType);
  }

  async presignWhiteboardDownload(roomId: string, fileId: string): Promise<{ downloadUrl: string; expiresAtMs: number }> {
    return presignWhiteboardDownloadOp(this.apiClient, roomId, fileId);
  }

  async presignChatAttachmentsUpload(
    roomId: string,
    files: Array<{ fileName: string; mimeType: string; sizeBytes: number }>,
  ): Promise<
    Array<{
      attachmentId: string;
      uploadUrl: string;
      expiresAtMs: number;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      kind: "image" | "document" | "file";
    }>
  > {
    const response = await this.apiClient.presignChatAttachmentsUpload(roomId, files);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to presign chat attachment upload");
    }
    return response.data.files;
  }

  async presignChatAttachmentDownload(roomId: string, attachmentId: string): Promise<{ downloadUrl: string; expiresAtMs: number }> {
    const response = await this.apiClient.presignChatAttachmentDownload(roomId, attachmentId);
    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to presign chat attachment download");
    }
    return response.data;
  }

  async uploadChatAttachment(roomId: string, attachmentId: string, file: File): Promise<void> {
    const response = await this.apiClient.uploadChatAttachment(roomId, attachmentId, file);
    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to upload chat attachment");
    }
  }

  get session(): ConferenceSession | null {
    return this.currentSession;
  }

  get room(): ConferenceSession | null {
    return this.session;
  }

  get isConnected(): boolean {
    return this.currentSession?.connectionState === "connected";
  }

  get connectionState(): SessionConnectionState {
    return this.currentSession?.connectionState ?? "disconnected";
  }

  get websocketConnectionState(): SessionConnectionState {
    return this.currentWsClient?.connectionState ?? "disconnected";
  }

  get localParticipantId(): string | null {
    return this.currentSession?.localParticipant?.id ?? null;
  }

  async removeParticipant(apiParticipantId: string): Promise<void> {
    return removeParticipantOp(this.apiClient, this.currentSession, apiParticipantId);
  }

  async updateOwnDisplayName(displayName: string): Promise<void> {
    return updateOwnDisplayNameOp(this.apiClient, this.currentSession, displayName);
  }

  disconnect(): void {
    const { nextSession, nextWsClient } = disconnectCurrentRoom(this.currentSession, this.currentWsClient, () => this.trackPostHogLeave("disconnect"));
    this.currentSession = nextSession;
    this.currentWsClient = nextWsClient;
  }
}
