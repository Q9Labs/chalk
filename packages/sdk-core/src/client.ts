/**
 * ChalkClient - Main entry point for the Chalk SDK
 * Integrates with Cloudflare RealtimeKit for WebRTC
 */

import RealtimeKitClient from "@cloudflare/realtimekit";
import { Effect, pipe } from "effect";
import { APIClient } from "./api-client.ts";
import { EventEmitter } from "./events.ts";
import {
  ChalkPostHogSessionReplay,
  type ChalkPostHogConfig,
} from "./posthog.ts";
import { Room } from "./room.ts";
import type {
  ChalkClientConfig,
  ChalkError,
  Participant,
  RoomConfig,
  RoomStatus,
  TokenProvider,
} from "./types.ts";
import { wideEvents } from "./wide-events/index.ts";
import { createAxiomWideEventsHandler } from "./wide-events/axiom.ts";
import { WideEventContext } from "./wide-events/context.ts";
import { WSClient } from "./ws-client.ts";
import {
  createOperationLock,
  type OperationLock,
} from "./effect/connection.ts";
import { ConnectionError, TimeoutError } from "./effect/errors.ts";
import { getRtkJoinPolicyForCurrentCohort } from "./rtk-join-policy.ts";

const DEFAULT_API_URL = "https://api.chalk.dev";

interface ChalkClientEvents {
  "token-expired": ChalkError;
}

export class ChalkClient extends EventEmitter<ChalkClientEvents> {
  private readonly apiClient: APIClient;
  private readonly wsUrl: string;
  private readonly tokenProvider?: TokenProvider;
  private readonly debug: boolean;
  private readonly demoMode: boolean;
  private currentRoom: Room | null = null;
  private currentWsClient: WSClient | null = null;
  private readonly postHogSessionReplay = new ChalkPostHogSessionReplay();
  // Effect: OperationLock for serializing join operations
  private readonly joinLock: OperationLock = createOperationLock();

  constructor(config: ChalkClientConfig) {
    super();
    const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    this.debug = config.debug ?? false;
    this.demoMode = config.demoMode ?? false;
    this.wsUrl = config.wsUrl ?? this.deriveWsUrl(apiUrl);
    this.tokenProvider = config.tokenProvider;
    this.postHogSessionReplay.configure(config.posthog);

    const hasAuth =
      config.token || config.tokenProvider || config.apiKey || this.debug;
    if (!hasAuth) {
      throw new Error(
        "ChalkClient requires authentication: provide token, tokenProvider, or apiKey",
      );
    }

    if (config.apiKey) {
      console.warn(
        "[Chalk] DEPRECATION: `apiKey` is deprecated. Use `token` or `tokenProvider` instead. This option will be removed in v2.0.",
      );
    }

    this.apiClient = new APIClient({ ...config, apiUrl });

    this.apiClient.on("token-expired", (error) => {
      this.emit("token-expired", error);
    });

    // Configure wide events (optional Axiom helper).
    const userHandler = config.wideEvents?.handler;
    const axiomEnabled = config.axiom?.enabled ?? false;
    const axiomHandler = axiomEnabled
      ? createAxiomWideEventsHandler({
          token: config.axiom!.token,
          dataset: config.axiom!.dataset,
          endpoint: config.axiom!.endpoint,
          flushIntervalMs: config.axiom!.flushIntervalMs,
          maxBatchSize: config.axiom!.maxBatchSize,
          debug: config.axiom!.debug ?? config.debug ?? false,
        }).handler
      : undefined;

    const combinedHandler =
      userHandler && axiomHandler
        ? (event: any) => {
            userHandler(event);
            axiomHandler(event);
          }
        : userHandler ?? axiomHandler;

    wideEvents.configure({
      enabled: config.wideEvents?.enabled ?? config.debug ?? false,
      handler: combinedHandler,
      includeDebugInfo: config.wideEvents?.includeDebugInfo ?? config.debug ?? false,
    });
  }

  configurePostHog(config?: ChalkPostHogConfig): void {
    this.postHogSessionReplay.configure(config);
  }

  private trackPostHogLeave(reason: "disconnect" | "switch_room"): void {
    this.postHogSessionReplay.trackLeave({
      reason,
      roomId: this.currentRoom?.id,
      participantId: this.currentRoom?.localParticipant?.id,
      demoMode: this.demoMode,
    });
  }

  /**
   * Derive WebSocket URL from API URL
   * https://api.example.com -> wss://api.example.com/ws
   * http://localhost:8080 -> ws://localhost:8080/ws
   */
  private deriveWsUrl(apiUrl?: string): string {
    if (!apiUrl) {
      throw new Error("apiUrl is required");
    }
    try {
      const url = new URL(apiUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/ws";
      return url.toString();
    } catch {
      // Fallback for malformed URLs
      const wsProtocol = apiUrl.startsWith("https") ? "wss" : "ws";
      const baseUrl = apiUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return `${wsProtocol}://${baseUrl}/ws`;
    }
  }

  /**
   * Validate JWT token expiration
   * SDKCORE-MED-03: Use Buffer.from for Node.js/SSR compatibility
   */
  private isTokenExpired(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) {
        return true; // Invalid JWT format
      }
      // Decode base64url payload - works in both browser and Node.js.
      // Cloudflare-style JWT payloads may use URL-safe chars and omit padding.
      const payloadB64 = parts[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
      let decoded: string;
      if (typeof atob === 'function') {
        decoded = atob(payloadB64);
      } else if (typeof Buffer !== 'undefined') {
        decoded = Buffer.from(payloadB64, 'base64').toString('utf-8');
      } else {
        // Fallback: assume not expired if we can't decode
        return false;
      }
      const payload = JSON.parse(decoded);
      return Date.now() >= payload.exp * 1000;
    } catch {
      return true; // Invalid token format = treat as expired
    }
  }

  /**
   * Effect-based RTK initialization
   * Uses Effect.tryPromise with proper error typing
   */
  private _initRealtimeKitEffect(authToken: string, audio: boolean, video: boolean) {
    return Effect.tryPromise({
      try: () =>
        RealtimeKitClient.init({
          authToken,
          defaults: { audio, video },
        }),
      catch: (error) =>
        new ConnectionError({
          code: "CONNECTION_FAILED",
          message: error instanceof Error ? error.message : "RealtimeKit init failed",
          recoverable: true,
          cause: error,
        }),
    });
  }

  /**
   * Effect-based RTK join wait with timeout
   * Uses Effect.timeoutOption for clean timeout handling
   */
  private _joinRealtimeKitEffect(joinPromise: Promise<void>, timeoutMs: number) {
    return pipe(
      Effect.tryPromise({
        try: () => joinPromise,
        catch: (error) =>
          new ConnectionError({
            code: "CONNECTION_FAILED",
            message: error instanceof Error ? error.message : "RTK join failed",
            recoverable: true,
            cause: error,
          }),
      }),
      Effect.timeout(`${timeoutMs} millis`),
      Effect.flatMap((option) =>
        option !== null
          ? Effect.succeed(option)
          : Effect.fail(
              new TimeoutError({
                message: `Room join timed out after ${timeoutMs}ms`,
                operation: "joinRTKRoom",
                timeoutMs,
              })
            )
      )
    );
  }

  private _isJoinTimeoutError(error: Error): boolean {
    if (error instanceof TimeoutError) {
      return true;
    }
    return error.message.toLowerCase().includes("timed out");
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
    const attemptCtx = new WideEventContext("room.join.rtk.attempt", wideEvents.collector);
    attemptCtx.merge({
      attempt,
      totalAttempts,
      timeoutMs,
      delayMs,
      attemptDurationMs,
      timeoutVsError,
      outcome,
      rtkJoinPolicy: joinPolicySelection,
    });

    if (outcome === "success") {
      attemptCtx.complete("success");
      return;
    }

    attemptCtx.complete(outcome, {
      code: timeoutVsError === "timeout" ? "RTK_JOIN_TIMEOUT" : "RTK_JOIN_ERROR",
      message: errorMessage ?? "RTK join attempt failed",
    });
  }

  /**
   * RTK join with retry logic and exponential backoff
   * Attempts join multiple times before giving up
   */
  private async _joinRealtimeKitWithRetry(
    rtkClient: RealtimeKitClient,
    joinPolicySelection = getRtkJoinPolicyForCurrentCohort(),
  ): Promise<void> {
    let lastError: Error | null = null;
    let joinPromise: Promise<void> | null = null;
    const retryDelays = joinPolicySelection.policy.retryDelaysMs;
    const timeoutMs = joinPolicySelection.policy.timeoutMs;
    const totalAttempts = 1 + retryDelays.length;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const attemptNumber = attempt + 1;
      const attemptStart = performance.now();

      if (!joinPromise) {
        joinPromise = rtkClient.join();
      }

      try {
        await Effect.runPromise(this._joinRealtimeKitEffect(joinPromise, timeoutMs));
        this._emitRtkJoinAttemptTelemetry({
          attempt: attemptNumber,
          totalAttempts,
          timeoutMs,
          delayMs: 0,
          attemptDurationMs: Math.round(performance.now() - attemptStart),
          timeoutVsError: "none",
          outcome: "success",
          joinPolicySelection,
        });
        return;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        lastError = normalized;
        const isTimeout = this._isJoinTimeoutError(normalized);
        const delayMs = attempt < retryDelays.length ? retryDelays[attempt]! : 0;

        this._emitRtkJoinAttemptTelemetry({
          attempt: attemptNumber,
          totalAttempts,
          timeoutMs,
          delayMs,
          attemptDurationMs: Math.round(performance.now() - attemptStart),
          timeoutVsError: isTimeout ? "timeout" : "error",
          outcome: isTimeout ? "timeout" : "error",
          errorMessage: normalized.message,
          joinPolicySelection,
        });

        // If we timed out, keep awaiting the same in-flight join promise on the
        // next attempt instead of calling rtkClient.join() again (avoids
        // "Already joining a room" duplicate-join races).
        if (!isTimeout) {
          joinPromise = null;
        }

        if (attempt < retryDelays.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // All attempts failed
    throw new Error(`Failed to join room after ${totalAttempts} attempts: ${lastError?.message}`);
  }

  async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
    // Effect: Use OperationLock for serialized join (prevents concurrent joins)
    return this.joinLock.withLock(async () => {
      // Clean up existing room before joining new one
      if (this.currentRoom) {
        this.trackPostHogLeave("switch_room");
        await this.currentRoom.leave();
        this.currentRoom = null;
      }

      const ctx = wideEvents.start("room.join");
      ctx.set("input", { roomId, displayName: config.displayName, role: config.role, audio: config.audio, video: config.video });

      try {
        ctx.markPhase("api");

        const response = this.demoMode
          ? await this.apiClient.demoJoin(roomId, config.displayName)
          : await this.apiClient.addParticipant(
              roomId,
              config.displayName,
              config.role,
              config.metadata,
            );

        if (!response.success || !response.data) {
          throw new Error(response.error?.message ?? "Failed to join room");
        }

        const { participantId, role, tokens, room: roomInfo } = response.data;

        ctx.set("api", { success: true, participantId, role });

        // CRITICAL: Validate token BEFORE using it
        if (!tokens.rtcToken) {
          throw new Error("RealtimeKit token missing - API did not return rtcToken");
        }

        // Never substitute RTC token with tokenProvider output.
        // tokenProvider returns API JWT; RealtimeKit requires rtcToken from join response.
        if (this.isTokenExpired(tokens.rtcToken)) {
          ctx.set("api", { rtcTokenExpiredAtJoin: true });
        }

        this.apiClient.setToken(tokens.accessToken);

        const localParticipant: Participant = {
          id: participantId,
          userId: participantId,
          displayName: config.displayName,
          role: role ?? "participant",
          isLocal: true,
          videoEnabled: config.video ?? false,
          audioEnabled: config.audio ?? false,
          isSpeaking: false,
          isScreenSharing: false,
          handRaised: false,
          connectionQuality: 100,
          metadata: config.metadata,
        };

        // Optional WebSocket signaling (chat, reactions, whiteboard, etc.)
        let wsClient: WSClient | null = null;
        if (this.wsUrl) {
          wsClient = new WSClient(this.wsUrl, {
            debug: this.debug,
            tokenProvider: this.tokenProvider,
          });
          wsClient.on("token-expired", (error) => {
            this.emit("token-expired", error);
          });
        }

        ctx.markPhase("rtk.init");

        // Effect: RTK initialization with typed errors
        const rtkClient = await Effect.runPromise(
          this._initRealtimeKitEffect(
            tokens.rtcToken,
            config.audio ?? false,
            config.video ?? false
          )
        ).catch((error) => {
          if (error instanceof ConnectionError) {
            throw new Error(`RealtimeKit initialization failed: ${error.message}`);
          }
          throw error;
        });

        if (!rtkClient) {
          throw new Error("RealtimeKit init returned null/undefined client");
        }

        const room = new Room(roomInfo.id, rtkClient, this.debug);
        room._setLocalParticipant(localParticipant);
        room._setInfo(roomInfo);
        room._setTokens(tokens);
        room._setRoomCreated(response.data.roomCreated ?? false);
        room._setTenantConfig(response.data.tenantConfig ?? null);

        // Attach WebSocket client to room (sets up event handlers)
        if (wsClient) {
          room.attachWsClient(wsClient);
          this.currentWsClient = wsClient;
        }

        ctx.markPhase("rtk.join");

        const rtkJoinPolicy = getRtkJoinPolicyForCurrentCohort();
        ctx.set("rtkJoinPolicy", rtkJoinPolicy);

        // Run RTK join and WebSocket connect in parallel
        const rtkJoinPromise = this._joinRealtimeKitWithRetry(
          rtkClient,
          rtkJoinPolicy,
        );

        // Start WebSocket connection in parallel (non-blocking)
        if (wsClient && tokens.accessToken) {
          wsClient.connect(tokens.accessToken, roomId);
        }

        // Wait for RTK join to complete (WS connects independently)
        await rtkJoinPromise;

        this.currentRoom = room;
        this.postHogSessionReplay.trackJoinSucceeded({
          roomId: roomInfo.id,
          participantId,
          role: role ?? "participant",
          displayName: config.displayName,
          demoMode: this.demoMode,
        });

        // Auto-start recording if server indicates (force_recording enabled)
        if (response.data.shouldStartRecording) {
          this.startRecording().catch(() => {
            // Recording auto-start failed, non-blocking
          });
        }

        wideEvents.setRoomId(roomInfo.id);
        wideEvents.setParticipantId(participantId);
        ctx.complete("success", { participantCount: room.participants.size, roomCreated: response.data.roomCreated });

        return room;
      } catch (error) {
        this.postHogSessionReplay.trackJoinFailed({
          roomId,
          displayName: config.displayName,
          error: error instanceof Error ? error.message : String(error),
          demoMode: this.demoMode,
        });
        ctx.complete("error", error);
        throw error;
      }
    });
  }

  /**
   * Create a new room (requires API key authentication)
   * @param name - Optional room name
   * @param config - Optional room configuration
   * @returns The room ID
   */
  async createRoom(
    name?: string,
    config?: Record<string, unknown>,
  ): Promise<string> {
    const ctx = wideEvents.start("room.create");
    ctx.set("input", { name, config });

    try {
      const response = await this.apiClient.createRoom(name, config);

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to create room");
      }

      ctx.complete("success", { roomId: response.data.roomId });
      return response.data.roomId;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  /**
   * End a room (host only)
   * @param roomId - The room ID to end
   */
  async endRoom(roomId: string): Promise<void> {
    const ctx = wideEvents.start("room.end");
    ctx.set("input", { roomId });

    try {
      const response = await this.apiClient.endRoom(roomId);

      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to end room");
      }

      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  /**
   * Start recording for the current room
   * @returns The recording ID
   */
  async startRecording(): Promise<string> {
    const ctx = wideEvents.start("recording.start");

    try {
      if (!this.currentRoom) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", { roomId: this.currentRoom.id });

      const response = await this.apiClient.startRecording(this.currentRoom.id);

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to start recording");
      }

      ctx.complete("success", { recordingId: response.data.recordingId });
      return response.data.recordingId;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  /**
   * Stop recording for the current room
   */
  async stopRecording(): Promise<void> {
    const ctx = wideEvents.start("recording.stop");

    try {
      if (!this.currentRoom) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", { roomId: this.currentRoom.id });

      const response = await this.apiClient.stopRecording(this.currentRoom.id);

      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to stop recording");
      }

      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async presignWhiteboardUpload(
    roomId: string,
    fileId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; expiresAtMs: number }> {
    const ctx = wideEvents.start("whiteboard.presign_upload");
    ctx.set("input", { roomId, fileId, mimeType });

    try {
      const response = await this.apiClient.presignWhiteboardUpload(
        roomId,
        fileId,
        mimeType,
      );

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to presign upload");
      }

      ctx.complete("success");
      return response.data;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  async presignWhiteboardDownload(
    roomId: string,
    fileId: string,
  ): Promise<{ downloadUrl: string; expiresAtMs: number }> {
    const ctx = wideEvents.start("whiteboard.presign_download");
    ctx.set("input", { roomId, fileId });

    try {
      const response = await this.apiClient.presignWhiteboardDownload(roomId, fileId);

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? "Failed to presign download");
      }

      ctx.complete("success");
      return response.data;
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  /**
   * Get the current room
   */
  get room(): Room | null {
    return this.currentRoom;
  }

  /**
   * Check if connected to a room
   */
  get isConnected(): boolean {
    return this.currentRoom?.status === "connected";
  }

  /**
   * Get connection status
   */
  get connectionStatus(): RoomStatus {
    return this.currentRoom?.status ?? "disconnected";
  }

  /**
   * Remove (kick) a participant from the current room
   * @param apiParticipantId - The API participant ID (customParticipantId) to remove
   */
  async removeParticipant(apiParticipantId: string): Promise<void> {
    const ctx = wideEvents.start("participant.remove");

    try {
      if (!this.currentRoom) {
        throw new Error("Not connected to a room");
      }

      ctx.set("input", { roomId: this.currentRoom.id, participantId: apiParticipantId });

      // Validate ID format (basic UUID check)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(apiParticipantId)) {
        throw new Error(
          `Invalid participant ID format: "${apiParticipantId}". ` +
          `Use customParticipantId from the participant object.`
        );
      }

      // Prevent self-removal
      if (apiParticipantId === this.currentRoom.localParticipant?.id) {
        throw new Error("Cannot remove yourself from the room");
      }

      const response = await this.apiClient.removeParticipant(
        this.currentRoom.id,
        apiParticipantId,
      );

      if (!response.success) {
        throw new Error(response.error?.message ?? "Failed to remove participant");
      }

      ctx.complete("success");
    } catch (error) {
      ctx.complete("error", error);
      throw error;
    }
  }

  /**
   * Disconnect from the current room and clean up resources
   */
  disconnect(): void {
    const ctx = wideEvents.start("room.leave");

    if (this.currentRoom) {
      this.trackPostHogLeave("disconnect");
      this.currentRoom.leave();
      this.currentRoom = null;
    }
    if (this.currentWsClient) {
      this.currentWsClient.disconnect();
      this.currentWsClient = null;
    }
    // Note: OperationLock handles serialization automatically, no reset needed

    ctx.complete("success");
  }
}
