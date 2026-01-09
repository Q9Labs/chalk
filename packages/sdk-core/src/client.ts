/**
 * ChalkClient - Main entry point for the Chalk SDK
 * Integrates with Cloudflare RealtimeKit for WebRTC
 */

import RealtimeKitClient from "@cloudflare/realtimekit";
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

interface ChalkClientEvents {
  "token-expired": ChalkError;
}

export class ChalkClient extends EventEmitter<ChalkClientEvents> {
  private readonly apiClient: APIClient;
  private readonly wsUrl: string;
  private readonly tokenProvider?: TokenProvider;
  private readonly debug: boolean;
  private currentRoom: Room | null = null;
  private currentWsClient: WSClient | null = null;
  private isJoining = false; // Prevent concurrent joins
  private readonly log: Logger;

  constructor(config: ChalkClientConfig) {
    super();
    this.debug = config.debug ?? false;
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
   */
  private isTokenExpired(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) {
        return true; // Invalid JWT format
      }
      const payload = JSON.parse(atob(parts[1]));
      return Date.now() >= payload.exp * 1000;
    } catch {
      return true; // Invalid token format = treat as expired
    }
  }

  async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
    // Prevent concurrent room joins
    if (this.isJoining) {
      throw new Error("Already joining a room. Please wait for the current operation to complete.");
    }

    try {
      this.isJoining = true;

      // Clean up existing room before joining new one
      if (this.currentRoom) {
        this.log.info("Leaving existing room before joining new one");
        await this.currentRoom.leave();
        this.currentRoom = null;
      }

      this.log.info("Joining room", { roomId });

      const response = this.debug
        ? await this.apiClient.demoJoin(roomId, config.displayName)
        : await this.apiClient.addParticipant(
            roomId,
            config.displayName,
            undefined,
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

      // RealtimeKit path (media)
      this.log.debug("Initializing RealtimeKit");

      let rtkClient: RealtimeKitClient;
      try {
        rtkClient = await RealtimeKitClient.init({
          authToken: tokens.rtcToken,
          defaults: {
            audio: config.audio ?? false,
            video: config.video ?? false,
          },
        });
      } catch (initError) {
        const errorMsg = initError instanceof Error ? initError.message : String(initError);
        this.log.error("RealtimeKit init failed", { error: errorMsg });
        throw new Error(`RealtimeKit initialization failed: ${errorMsg}`);
      }

      if (!rtkClient) {
        this.log.error("RealtimeKit init returned null/undefined client");
        throw new Error("RealtimeKit init returned null/undefined client");
      }

      this.log.debug("RealtimeKit initialized, creating Room");

      const room = new Room(roomInfo.id, rtkClient, this.debug);
      room._setLocalParticipant(localParticipant);
      room._setInfo(roomInfo);
      room._setTokens(tokens);

      // CRITICAL: Add timeout to WebSocket join
      this.log.debug("Joining RealtimeKit room");
      try {
        let timeoutId: NodeJS.Timeout;
        const joinPromise = rtkClient.join();
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("WebSocket connection timeout after 10 seconds"));
          }, 10000);
        });

        await Promise.race([
          joinPromise.finally(() => clearTimeout(timeoutId)),
          timeout
        ]);

        this.log.info("Joined RealtimeKit room", { roomId });
      } catch (joinError) {
        const errorMsg = joinError instanceof Error ? joinError.message : String(joinError);
        this.log.error("Failed to join RealtimeKit room", { error: errorMsg });
        throw new Error(`Failed to join room: ${errorMsg}`);
      }

      if (wsClient) {
        room.attachWsClient(wsClient);
        if (tokens.accessToken) {
          wsClient.connect(tokens.accessToken, roomId);
        } else {
          this.log.warn("accessToken missing; WebSocket features disabled");
        }
        this.currentWsClient = wsClient;
      }

      this.currentRoom = room;
      return room;
      
    } finally {
      this.isJoining = false;
    }
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

    this.isJoining = false; // Reset join flag
    this.log.info("Disconnected");
  }
}
