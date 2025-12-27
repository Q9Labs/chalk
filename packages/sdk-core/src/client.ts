/**
 * ChalkClient - Main entry point for the Chalk SDK
 */

import { APIClient } from './api-client.ts';
import { WSClient } from './ws-client.ts';
import { Room } from './room.ts';
import type {
  ChalkClientConfig,
  Participant,
  RoomConfig,
  RoomStatus,
} from './types.ts';

export class ChalkClient {
  private readonly apiClient: APIClient;
  private readonly wsClient: WSClient;
  private readonly debug: boolean;
  private currentRoom: Room | null = null;

  constructor(config: ChalkClientConfig) {
    if (!config.apiKey && !config.token) {
      throw new Error('ChalkClient requires either apiKey or token');
    }

    this.debug = config.debug ?? false;
    this.apiClient = new APIClient(config);
    this.wsClient = new WSClient(config.wsUrl, this.debug);
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[ChalkClient]', ...args);
    }
  }

  /**
   * Join a room
   * @param roomId - The room ID to join
   * @param config - Room configuration including display name and initial media state
   * @returns The Room instance
   */
  async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
    if (this.currentRoom) {
      this.log('Leaving existing room before joining new one');
      this.currentRoom.leave();
    }

    this.log('Joining room:', roomId);

    // Add participant via API
    const response = await this.apiClient.addParticipant(
      roomId,
      config.displayName,
      undefined,
      config.metadata
    );

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? 'Failed to join room');
    }

    const { participantId, token, room: roomInfo } = response.data;

    // Store token for future API calls
    this.apiClient.setToken(token);

    // Create Room instance
    const room = new Room(roomId, this.wsClient, this.debug);
    room._setInfo(roomInfo);

    // Create local participant
    const localParticipant: Participant = {
      id: participantId,
      displayName: config.displayName,
      role: 'participant',
      isLocal: true,
      videoEnabled: false,
      audioEnabled: false,
      isSpeaking: false,
      isScreenSharing: false,
      handRaised: false,
      connectionQuality: 100,
      metadata: config.metadata,
    };

    room._setLocalParticipant(localParticipant);
    room._setStatus('connecting');

    // Connect WebSocket
    this.wsClient.connect(token, roomId);

    // Initialize media if requested
    if (config.audio) {
      await room.toggleAudio();
    }
    if (config.video) {
      await room.toggleVideo();
    }

    this.currentRoom = room;
    return room;
  }

  /**
   * Create a new room (requires API key authentication)
   * @param name - Optional room name
   * @param config - Optional room configuration
   * @returns The room ID
   */
  async createRoom(name?: string, config?: Record<string, unknown>): Promise<string> {
    this.log('Creating room:', name);

    const response = await this.apiClient.createRoom(name, config);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? 'Failed to create room');
    }

    return response.data.roomId;
  }

  /**
   * End a room (host only)
   * @param roomId - The room ID to end
   */
  async endRoom(roomId: string): Promise<void> {
    this.log('Ending room:', roomId);

    const response = await this.apiClient.endRoom(roomId);

    if (!response.success) {
      throw new Error(response.error?.message ?? 'Failed to end room');
    }
  }

  /**
   * Start recording for the current room
   * @returns The recording ID
   */
  async startRecording(): Promise<string> {
    if (!this.currentRoom) {
      throw new Error('Not connected to a room');
    }

    const response = await this.apiClient.startRecording(this.currentRoom.id);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? 'Failed to start recording');
    }

    return response.data.recordingId;
  }

  /**
   * Stop recording for the current room
   */
  async stopRecording(): Promise<void> {
    if (!this.currentRoom) {
      throw new Error('Not connected to a room');
    }

    const response = await this.apiClient.stopRecording(this.currentRoom.id);

    if (!response.success) {
      throw new Error(response.error?.message ?? 'Failed to stop recording');
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
    return this.currentRoom?.status === 'connected';
  }

  /**
   * Get connection status
   */
  get connectionStatus(): RoomStatus {
    return this.currentRoom?.status ?? 'disconnected';
  }

  /**
   * Disconnect from the current room
   */
  disconnect(): void {
    if (this.currentRoom) {
      this.log('Disconnecting');
      this.currentRoom.leave();
      this.currentRoom = null;
    }
  }
}
