/**
 * Room class - main interface for interacting with a video room
 */

import { EventEmitter } from './events.ts';
import { WSClient } from './ws-client.ts';
import type {
  ChatMessage,
  ChalkError,
  MediaDevice,
  MediaDeviceKind,
  Participant,
  Reaction,
  ReactionEmoji,
  Recording,
  RoomInfo,
  RoomStatus,
  ScreenShareOptions,
} from './types.ts';
import { ChalkErrorCode } from './types.ts';

interface RoomEvents {
  'status-changed': RoomStatus;
  'participant-joined': Participant;
  'participant-left': string;
  'participant-updated': { participantId: string; participant: Participant };
  'active-speaker-changed': Participant | null;
  'chat-message': ChatMessage;
  reaction: Reaction;
  'hand-raised': { participantId: string };
  'hand-lowered': { participantId: string };
  'recording-started': { recordingId: string };
  'recording-stopped': Recording;
  error: ChalkError;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  private _status: RoomStatus = 'disconnected';
  private _info: RoomInfo | null = null;
  private _participants: Map<string, Participant> = new Map();
  private _localParticipant: Participant | null = null;
  private _activeSpeaker: Participant | null = null;
  private _messages: ChatMessage[] = [];
  private _currentRecording: { id: string } | null = null;

  private localVideoTrack: MediaStreamTrack | null = null;
  private localAudioTrack: MediaStreamTrack | null = null;
  private screenShareTrack: MediaStreamTrack | null = null;

  private readonly wsClient: WSClient;
  private readonly debug: boolean;

  constructor(
    roomId: string,
    wsClient: WSClient,
    debug = false
  ) {
    super();
    this.id = roomId;
    this.wsClient = wsClient;
    this.debug = debug;
    this.setupWSListeners();
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[Chalk Room]', ...args);
    }
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

  get isRecording(): boolean {
    return this._currentRecording !== null;
  }

  // Internal methods
  _setStatus(status: RoomStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.emit('status-changed', status);
    }
  }

  _setInfo(info: RoomInfo): void {
    this._info = info;
  }

  _setLocalParticipant(participant: Participant): void {
    this._localParticipant = participant;
    this._participants.set(participant.id, participant);
  }

  private setupWSListeners(): void {
    this.wsClient.on('participant.joined', (participant) => {
      this._participants.set(participant.id, participant);
      this.emit('participant-joined', participant);
    });

    this.wsClient.on('participant.left', ({ participantId }) => {
      this._participants.delete(participantId);
      this.emit('participant-left', participantId);
    });

    this.wsClient.on('participant.updated', ({ participantId, changes }) => {
      const participant = this._participants.get(participantId);
      if (participant) {
        const updated = { ...participant, ...changes };
        this._participants.set(participantId, updated);
        this.emit('participant-updated', { participantId, participant: updated });
      }
    });

    this.wsClient.on('chat.message', (message) => {
      this._messages.push(message);
      this.emit('chat-message', message);
    });

    this.wsClient.on('reaction', (reaction) => {
      this.emit('reaction', reaction);
    });

    this.wsClient.on('hand.raised', ({ participantId }) => {
      const participant = this._participants.get(participantId);
      if (participant) {
        participant.handRaised = true;
        this.emit('hand-raised', { participantId });
      }
    });

    this.wsClient.on('hand.lowered', ({ participantId }) => {
      const participant = this._participants.get(participantId);
      if (participant) {
        participant.handRaised = false;
        this.emit('hand-lowered', { participantId });
      }
    });

    this.wsClient.on('recording.started', ({ recordingId }) => {
      this._currentRecording = { id: recordingId };
      this.emit('recording-started', { recordingId });
    });

    this.wsClient.on('recording.stopped', ({ recordingId, duration }) => {
      this._currentRecording = null;
      this.emit('recording-stopped', {
        id: recordingId,
        roomId: this.id,
        status: 'processing',
        durationSeconds: duration,
      });
    });

    this.wsClient.on('error', (error) => {
      this.emit('error', error);
    });

    this.wsClient.on('connected', () => {
      this._setStatus('connected');
    });

    this.wsClient.on('disconnected', () => {
      this._setStatus('disconnected');
    });

    this.wsClient.on('reconnecting', () => {
      this._setStatus('reconnecting');
    });
  }

  // Media controls
  async toggleVideo(): Promise<boolean> {
    if (!this._localParticipant) return false;

    if (this._localParticipant.videoEnabled) {
      // Disable video
      this.localVideoTrack?.stop();
      this.localVideoTrack = null;
      this._localParticipant.videoEnabled = false;
      this._localParticipant.videoTrack = undefined;
    } else {
      // Enable video
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        this.localVideoTrack = stream.getVideoTracks()[0] ?? null;
        this._localParticipant.videoEnabled = true;
        this._localParticipant.videoTrack = this.localVideoTrack ?? undefined;
      } catch (error) {
        this.log('Failed to enable video:', error);
        this.emit('error', {
          code: 'MEDIA_ERROR',
          message: 'Failed to access camera',
        });
        return false;
      }
    }

    return this._localParticipant.videoEnabled;
  }

  async toggleAudio(): Promise<boolean> {
    if (!this._localParticipant) return false;

    if (this._localParticipant.audioEnabled) {
      // Disable audio
      this.localAudioTrack?.stop();
      this.localAudioTrack = null;
      this._localParticipant.audioEnabled = false;
      this._localParticipant.audioTrack = undefined;
    } else {
      // Enable audio
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.localAudioTrack = stream.getAudioTracks()[0] ?? null;
        this._localParticipant.audioEnabled = true;
        this._localParticipant.audioTrack = this.localAudioTrack ?? undefined;
      } catch (error) {
        this.log('Failed to enable audio:', error);
        this.emit('error', {
          code: 'MEDIA_ERROR',
          message: 'Failed to access microphone',
        });
        return false;
      }
    }

    return this._localParticipant.audioEnabled;
  }

  async startScreenShare(_options?: ScreenShareOptions): Promise<boolean> {
    if (!this._localParticipant) return false;
    if (this._localParticipant.isScreenSharing) return true;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: _options?.withAudio ?? false,
      });

      this.screenShareTrack = stream.getVideoTracks()[0] ?? null;
      this._localParticipant.isScreenSharing = true;

      // Handle when user stops sharing via browser UI
      this.screenShareTrack?.addEventListener('ended', () => {
        this.stopScreenShare();
      });

      return true;
    } catch (error) {
      this.log('Failed to start screen share:', error);
      this.emit('error', {
        code: 'SCREEN_SHARE_ERROR',
        message: 'Failed to start screen sharing',
      });
      return false;
    }
  }

  stopScreenShare(): void {
    if (!this._localParticipant) return;

    this.screenShareTrack?.stop();
    this.screenShareTrack = null;
    this._localParticipant.isScreenSharing = false;
  }

  // ===== Device Management =====

  /**
   * Get list of available media devices
   *
   * @example
   * ```ts
   * const devices = await room.getDevices();
   * const cameras = devices.filter(d => d.kind === 'videoinput');
   * console.log('Available cameras:', cameras.map(c => c.label));
   * ```
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
      this.log('Failed to enumerate devices:', error);
      this.emit('error', {
        code: ChalkErrorCode.MEDIA_ERROR,
        message: 'Failed to list media devices',
      });
      return [];
    }
  }

  /**
   * Get available video input devices (cameras)
   */
  async getCameras(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /**
   * Get available audio input devices (microphones)
   */
  async getMicrophones(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /**
   * Get available audio output devices (speakers)
   */
  async getSpeakers(): Promise<MediaDevice[]> {
    const devices = await this.getDevices();
    return devices.filter((d) => d.kind === 'audiooutput');
  }

  /**
   * Switch to a different camera
   *
   * @param deviceId - Device ID from getDevices() or getCameras()
   * @returns true if successful
   *
   * @example
   * ```ts
   * const cameras = await room.getCameras();
   * if (cameras.length > 1) {
   *   await room.selectCamera(cameras[1].deviceId);
   * }
   * ```
   */
  async selectCamera(deviceId: string): Promise<boolean> {
    if (!this._localParticipant) return false;

    try {
      // Stop current video track
      this.localVideoTrack?.stop();

      // Get new stream with specific device
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });

      this.localVideoTrack = stream.getVideoTracks()[0] ?? null;
      this._localParticipant.videoTrack = this.localVideoTrack ?? undefined;
      this._localParticipant.videoEnabled = true;

      return true;
    } catch (error) {
      this.log('Failed to select camera:', error);
      this.emit('error', {
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: 'Failed to switch camera',
        details: { deviceId },
      });
      return false;
    }
  }

  /**
   * Switch to a different microphone
   *
   * @param deviceId - Device ID from getDevices() or getMicrophones()
   * @returns true if successful
   */
  async selectMicrophone(deviceId: string): Promise<boolean> {
    if (!this._localParticipant) return false;

    try {
      // Stop current audio track
      this.localAudioTrack?.stop();

      // Get new stream with specific device
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });

      this.localAudioTrack = stream.getAudioTracks()[0] ?? null;
      this._localParticipant.audioTrack = this.localAudioTrack ?? undefined;
      this._localParticipant.audioEnabled = true;

      return true;
    } catch (error) {
      this.log('Failed to select microphone:', error);
      this.emit('error', {
        code: ChalkErrorCode.DEVICE_NOT_FOUND,
        message: 'Failed to switch microphone',
        details: { deviceId },
      });
      return false;
    }
  }

  // Chat
  sendMessage(content: string): void {
    if (!content.trim()) return;
    this.wsClient.sendChatMessage(content.trim());
  }

  // Reactions
  sendReaction(emoji: ReactionEmoji): void {
    this.wsClient.sendReaction(emoji);
  }

  // Hand raise
  raiseHand(): void {
    if (this._localParticipant) {
      this._localParticipant.handRaised = true;
      this.wsClient.raiseHand();
    }
  }

  lowerHand(): void {
    if (this._localParticipant) {
      this._localParticipant.handRaised = false;
      this.wsClient.lowerHand();
    }
  }

  // Disconnect
  leave(): void {
    this.log('Leaving room');

    // Stop all local tracks
    this.localVideoTrack?.stop();
    this.localAudioTrack?.stop();
    this.screenShareTrack?.stop();

    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.screenShareTrack = null;

    // Disconnect WebSocket
    this.wsClient.disconnect();

    // Clear state
    this._participants.clear();
    this._localParticipant = null;
    this._activeSpeaker = null;
    this._messages = [];
    this._currentRecording = null;

    this._setStatus('disconnected');
  }
}
