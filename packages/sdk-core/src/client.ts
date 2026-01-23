/**
 * ChalkClient - Main entry point for the Chalk SDK
 * Integrates with Cloudflare RealtimeKit for WebRTC
 */

import RealtimeKitClient from "@cloudflare/realtimekit";
import { Effect, pipe } from "effect";
import { APIClient } from "./api-client.ts";
import { EventEmitter } from "./events.ts";
import { Room } from "./room.ts";
import type {
  ChalkClientConfig,
  ChalkError,
  Participant,
  RoomConfig,
  RoomStatus,
  TokenProvider,
} from "./types.ts";
import { createLogger, initLogging, type Logger } from "./utils/logger.ts";
import { WSClient } from "./ws-client.ts";
import {
  createOperationLock,
  type OperationLock,
} from "./effect/connection.ts";
import { ConnectionError, TimeoutError } from "./effect/errors.ts";

// RTK join configuration
const RTK_JOIN_TIMEOUT_MS = 30000; // 30 seconds per attempt
const RTK_JOIN_RETRY_DELAYS = [500, 1000, 2000]; // 3 retries with faster backoff

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
  // Effect: OperationLock for serializing join operations
  private readonly joinLock: OperationLock = createOperationLock();
  private readonly log: Logger;

  constructor(config: ChalkClientConfig) {
    super();
    this.debug = config.debug ?? false;
    this.demoMode = config.demoMode ?? false;
    this.wsUrl = config.wsUrl ?? this.deriveWsUrl(config.apiUrl);
    this.tokenProvider = config.tokenProvider;

    // Initialize logging globally
    initLogging(this.debug);
    this.log = createLogger("Client");

    const hasAuth =
      config.token || config.tokenProvider || config.apiKey || this.debug;
    if (!hasAuth) {
      throw new Error(
        "ChalkClient requires authentication: provide token, tokenProvider, or apiKey",
      );
    }

    this.apiClient = new APIClient(config);
    this.log.info("Initialized", { debug: this.debug, hasWsUrl: !!this.wsUrl });

    this.apiClient.on("token-expired", (error) => {
      this.log.warn("Token expired", { code: error.code });
      this.emit("token-expired", error);
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
      // Decode base64 - works in both browser and Node.js
      let decoded: string;
      if (typeof atob === 'function') {
        decoded = atob(parts[1]);
      } else if (typeof Buffer !== 'undefined') {
        decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
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
   * Effect-based RTK join with timeout
   * Uses Effect.timeoutOption for clean timeout handling
   */
  private _joinRealtimeKitEffect(rtkClient: RealtimeKitClient, timeoutMs: number) {
    return pipe(
      Effect.tryPromise({
        try: () => rtkClient.join(),
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

  /**
   * RTK join with retry logic and exponential backoff
   * Attempts join multiple times before giving up
   */
  private async _joinRealtimeKitWithRetry(rtkClient: RealtimeKitClient): Promise<void> {
    let lastError: Error | null = null;

    // First attempt (no delay)
    try {
      await Effect.runPromise(this._joinRealtimeKitEffect(rtkClient, RTK_JOIN_TIMEOUT_MS));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      this.log.warn("RTK join attempt 1 failed, will retry", { error: lastError.message });
    }

    // Retry attempts with exponential backoff
    for (let i = 0; i < RTK_JOIN_RETRY_DELAYS.length; i++) {
      const delay = RTK_JOIN_RETRY_DELAYS[i]!;
      const attemptNum = i + 2;

      this.log.info(`Waiting ${delay}ms before RTK join retry attempt ${attemptNum}`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await Effect.runPromise(this._joinRealtimeKitEffect(rtkClient, RTK_JOIN_TIMEOUT_MS));
        this.log.info(`RTK join succeeded on attempt ${attemptNum}`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.log.warn(`RTK join attempt ${attemptNum} failed`, { error: lastError.message });
      }
    }

    // All attempts failed
    const totalAttempts = 1 + RTK_JOIN_RETRY_DELAYS.length;
    this.log.error(`RTK join failed after ${totalAttempts} attempts`);
    throw new Error(`Failed to join room after ${totalAttempts} attempts: ${lastError?.message}`);
  }

  async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
    // Effect: Use OperationLock for serialized join (prevents concurrent joins)
    return this.joinLock.withLock(async () => {
      // Clean up existing room before joining new one
      if (this.currentRoom) {
        this.log.info("Leaving existing room before joining new one");
        await this.currentRoom.leave();
        this.currentRoom = null;
      }

      this.log.info("Joining room", { roomId });

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
      this.log.info("Got auth tokens", { role, participantId });

      // CRITICAL: Validate token BEFORE using it
      if (!tokens.rtcToken) {
        this.log.error("RealtimeKit token missing");
        throw new Error("RealtimeKit token missing - API did not return rtcToken");
      }

      // Check token expiration
      if (this.isTokenExpired(tokens.rtcToken)) {
        this.log.warn("rtcToken is expired or invalid");

        // Attempt token refresh if provider is available
        if (this.tokenProvider) {
          this.log.info("Attempting token refresh");
          try {
            const newToken = await this.tokenProvider();
            tokens.rtcToken = newToken;
            this.log.info("Token refreshed successfully");
          } catch (refreshError) {
            throw new Error("Token expired and refresh failed: " +
              (refreshError instanceof Error ? refreshError.message : String(refreshError)));
          }
        } else {
          throw new Error("Invalid or expired RealtimeKit token. Provide a tokenProvider for automatic refresh.");
        }
      }

      this.apiClient.setToken(tokens.accessToken);

      const localParticipant: Participant = {
        id: participantId,
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
        this.log.debug("Initializing WebSocket signaling");
        wsClient = new WSClient(this.wsUrl, this.debug, this.tokenProvider);
        wsClient.on("token-expired", (error) => {
          this.emit("token-expired", error);
        });
      }

      // Effect: RTK initialization with typed errors
      this.log.debug("Initializing RealtimeKit");
      const rtkClient = await Effect.runPromise(
        this._initRealtimeKitEffect(
          tokens.rtcToken,
          config.audio ?? false,
          config.video ?? false
        )
      ).catch((error) => {
        if (error instanceof ConnectionError) {
          this.log.error("RealtimeKit init failed", { error: error.message });
          throw new Error(`RealtimeKit initialization failed: ${error.message}`);
        }
        throw error;
      });

      if (!rtkClient) {
        this.log.error("RealtimeKit init returned null/undefined client");
        throw new Error("RealtimeKit init returned null/undefined client");
      }

      this.log.debug("RealtimeKit initialized, creating Room");

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

      // Run RTK join and WebSocket connect in parallel
      this.log.debug("Joining RealtimeKit room");
      const rtkJoinPromise = this._joinRealtimeKitWithRetry(rtkClient);

      // Start WebSocket connection in parallel (non-blocking)
      if (wsClient && tokens.accessToken) {
        this.log.debug("Starting WebSocket connection in parallel");
        wsClient.connect(tokens.accessToken, roomId);
      } else if (wsClient) {
        this.log.warn("accessToken missing; WebSocket features disabled");
      }

      // Wait for RTK join to complete (WS connects independently)
      await rtkJoinPromise;
      this.log.info("Joined RealtimeKit room", { roomId });

      this.currentRoom = room;

      // Auto-start recording if server indicates (force_recording enabled)
      if (response.data.shouldStartRecording) {
        this.log.info("Auto-starting recording (force_recording enabled)");
        this.startRecording().catch((err) => {
          this.log.error("Failed to auto-start recording", { error: err });
        });
      }

      return room;
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
    this.log.info("Creating room", { name });

    const response = await this.apiClient.createRoom(name, config);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to create room");
    }

    return response.data.roomId;
  }

  /**
   * End a room (host only)
   * @param roomId - The room ID to end
   */
  async endRoom(roomId: string): Promise<void> {
    this.log.info("Ending room", { roomId });

    const response = await this.apiClient.endRoom(roomId);

    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to end room");
    }
  }

  /**
   * Start recording for the current room
   * @returns The recording ID
   */
  async startRecording(): Promise<string> {
    if (!this.currentRoom) {
      throw new Error("Not connected to a room");
    }

    const response = await this.apiClient.startRecording(this.currentRoom.id);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? "Failed to start recording");
    }

    return response.data.recordingId;
  }

  /**
   * Stop recording for the current room
   */
  async stopRecording(): Promise<void> {
    if (!this.currentRoom) {
      throw new Error("Not connected to a room");
    }

    const response = await this.apiClient.stopRecording(this.currentRoom.id);

    if (!response.success) {
      throw new Error(response.error?.message ?? "Failed to stop recording");
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
    if (!this.currentRoom) {
      throw new Error("Not connected to a room");
    }

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

    this.log.info("Removing participant", { participantId: apiParticipantId, roomId: this.currentRoom.id });

    const response = await this.apiClient.removeParticipant(
      this.currentRoom.id,
      apiParticipantId,
    );

    if (!response.success) {
      this.log.error("Remove participant failed", { error: response.error });
      throw new Error(response.error?.message ?? "Failed to remove participant");
    }
  }

  /**
   * Disconnect from the current room and clean up resources
   */
  disconnect(): void {
    this.log.info("Disconnecting");
    if (this.currentRoom) {
      this.currentRoom.leave();
      this.currentRoom = null;
    }
    if (this.currentWsClient) {
      this.currentWsClient.disconnect();
      this.currentWsClient = null;
    }
    // Note: OperationLock handles serialization automatically, no reset needed
    this.log.info("Disconnected");
  }
}
