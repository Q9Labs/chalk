# Chalk SDK Implementation

TypeScript SDK implementation for Cloudflare RealtimeKit integration.

---

## Overview

Chalk provides three SDK packages:
- **@chalk/core** - Core vanilla JavaScript/TypeScript client wrapping RealtimeKit
- **@chalk/react** - React components, hooks, and provider
- **@chalk/react-native** - React Native bindings

All SDKs wrap the underlying **Dyte** platform (which powers Cloudflare RealtimeKit).

---

## @chalk/core Implementation

Core SDK wrapping RealtimeKit (Dyte) client.

### Installation

```bash
npm install @dytesdk/web-core
```

### Main Export (sdk-core/src/index.ts)

```typescript
import { DyteClient } from '@dytesdk/web-core';

export interface ChalkClientConfig {
  apiKey?: string;  // For server-to-server auth
  token?: string;   // JWT from Chalk API joinRoom response
}

export interface JoinRoomOptions {
  displayName: string;
  audio?: boolean;
  video?: boolean;
}

export interface Participant {
  id: string;
  displayName: string;
  role: 'host' | 'participant';
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenShareEnabled: boolean;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
}

/**
 * Main Chalk client for joining video rooms
 */
export class ChalkClient {
  private config: ChalkClientConfig;
  private apiBaseUrl = 'https://api.chalk.dev';

  constructor(config: ChalkClientConfig) {
    this.config = config;
  }

  /**
   * Join a room
   * @param roomId - Room ID from Chalk API
   * @param options - Join options (displayName required)
   * @returns ChalkRoom instance
   */
  async joinRoom(roomId: string, options: JoinRoomOptions): Promise<ChalkRoom> {
    // 1. Get auth token from Chalk API (if using apiKey)
    let authToken = this.config.token;

    if (this.config.apiKey && !authToken) {
      const response = await fetch(`${this.apiBaseUrl}/api/v1/rooms/${roomId}/participants`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ display_name: options.displayName }),
      });
      const data = await response.json();
      authToken = data.auth_token;
    }

    if (!authToken) {
      throw new Error('No auth token provided. Set either config.token or config.apiKey');
    }

    // 2. Initialize Dyte client with authToken from Cloudflare
    const meeting = await DyteClient.init({
      authToken,
      defaults: {
        audio: options.audio ?? true,
        video: options.video ?? true,
      },
    });

    // 3. Join the meeting
    await meeting.join();

    // 4. Return wrapped ChalkRoom
    return new ChalkRoom(meeting, roomId);
  }
}

/**
 * Represents an active video room/meeting
 */
export class ChalkRoom {
  private meeting: DyteClient;
  private _roomId: string;
  private _participants: Map<string, Participant> = new Map();
  private eventHandlers: Map<string, Set<Function>> = new Map();

  constructor(meeting: DyteClient, roomId: string) {
    this.meeting = meeting;
    this._roomId = roomId;
    this.setupEventListeners();
  }

  // ===== Properties =====

  get roomId(): string {
    return this._roomId;
  }

  get participants(): Map<string, Participant> {
    return this._participants;
  }

  get localParticipant(): Participant {
    return this.mapParticipant(this.meeting.self);
  }

  // ===== Media Controls =====

  /**
   * Toggle local video on/off
   */
  async toggleVideo(): Promise<void> {
    if (this.meeting.self.videoEnabled) {
      await this.meeting.self.disableVideo();
    } else {
      await this.meeting.self.enableVideo();
    }
  }

  /**
   * Toggle local audio on/off
   */
  async toggleAudio(): Promise<void> {
    if (this.meeting.self.audioEnabled) {
      await this.meeting.self.disableAudio();
    } else {
      await this.meeting.self.enableAudio();
    }
  }

  /**
   * Start screen share
   */
  async startScreenShare(options?: { withAnnotations?: boolean }): Promise<void> {
    await this.meeting.self.enableScreenShare();
  }

  /**
   * Stop screen share
   */
  async stopScreenShare(): Promise<void> {
    await this.meeting.self.disableScreenShare();
  }

  // ===== Recording =====

  /**
   * Start recording the meeting
   */
  async startRecording(): Promise<void> {
    await this.meeting.recording.start();
  }

  /**
   * Stop recording the meeting
   */
  async stopRecording(): Promise<void> {
    await this.meeting.recording.stop();
  }

  /**
   * Get current recording state
   */
  get recordingState(): 'IDLE' | 'STARTING' | 'RECORDING' | 'PAUSED' | 'STOPPING' {
    return this.meeting.recording.recordingState;
  }

  // ===== Chat =====

  /**
   * Send text message to room
   */
  async sendMessage(message: string): Promise<void> {
    await this.meeting.chat.sendTextMessage(message);
  }

  // ===== Events =====

  /**
   * Register event listener
   */
  on(event: ChalkRoomEvent, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unregister event listener
   */
  off(event: ChalkRoomEvent, handler: Function): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  // ===== Cleanup =====

  /**
   * Leave the room and cleanup resources
   */
  async leave(): Promise<void> {
    await this.meeting.leave();
  }

  // ===== Private Methods =====

  private setupEventListeners(): void {
    // Room events
    this.meeting.self.on('roomJoined', () => {
      this.emit('connected');
    });

    this.meeting.self.on('roomLeft', (state) => {
      this.emit('disconnected', { reason: state });
    });

    // Participant events
    this.meeting.participants.joined.on('participantJoined', (participant) => {
      const mapped = this.mapParticipant(participant);
      this._participants.set(participant.id, mapped);
      this.emit('participantJoined', mapped);
    });

    this.meeting.participants.joined.on('participantLeft', (participant) => {
      const mapped = this._participants.get(participant.id);
      this._participants.delete(participant.id);
      this.emit('participantLeft', mapped);
    });

    // Media events
    this.meeting.self.on('videoUpdate', () => {
      this.emit('localVideoChanged', this.localParticipant);
    });

    this.meeting.self.on('audioUpdate', () => {
      this.emit('localAudioChanged', this.localParticipant);
    });

    // Active speaker
    this.meeting.participants.active.on('participantJoined', (participant) => {
      this.emit('activeSpeakerChanged', this.mapParticipant(participant));
    });
  }

  private emit(event: string, data?: any): void {
    this.eventHandlers.get(event)?.forEach(handler => handler(data));
  }

  private mapParticipant(p: any): Participant {
    return {
      id: p.id,
      displayName: p.name,
      role: p.presetName?.includes('host') ? 'host' : 'participant',
      audioEnabled: p.audioEnabled,
      videoEnabled: p.videoEnabled,
      screenShareEnabled: p.screenShareEnabled,
      videoTrack: p.videoTrack,
      audioTrack: p.audioTrack,
    };
  }
}

export type ChalkRoomEvent =
  | 'connected'
  | 'disconnected'
  | 'participantJoined'
  | 'participantLeft'
  | 'participantUpdated'
  | 'activeSpeakerChanged'
  | 'localVideoChanged'
  | 'localAudioChanged'
  | 'recordingStarted'
  | 'recordingStopped'
  | 'chatMessage'
  | 'error';
```

---

## @chalk/react Implementation

React hooks, provider, and pre-built components.

### Installation

```bash
npm install @chalk/core react
```

### Provider & Hooks (sdk-react/src/index.tsx)

```typescript
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { ChalkClient, ChalkRoom, Participant, JoinRoomOptions } from '@chalk/core';

// ===== Context =====

interface ChalkContextValue {
  client: ChalkClient | null;
  room: ChalkRoom | null;
  isConnected: boolean;
  error: Error | null;
}

const ChalkContext = createContext<ChalkContextValue | null>(null);

// ===== Provider =====

interface ChalkProviderProps {
  apiKey?: string;
  token?: string;
  children: React.ReactNode;
}

/**
 * ChalkProvider - Wrap your app with this to enable Chalk SDKs
 *
 * @example
 * <ChalkProvider apiKey="ck_live_xxx">
 *   <MyComponent />
 * </ChalkProvider>
 */
export function ChalkProvider({ apiKey, token, children }: ChalkProviderProps) {
  const [client] = useState(() => new ChalkClient({ apiKey, token }));
  const [room, setRoom] = useState<ChalkRoom | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const value = { client, room, isConnected, error };

  return (
    <ChalkContext.Provider value={value}>
      {children}
    </ChalkContext.Provider>
  );
}

// ===== Hooks =====

/**
 * Access Chalk context
 */
export function useChalk() {
  const context = useContext(ChalkContext);
  if (!context) {
    throw new Error('useChalk must be used within a ChalkProvider');
  }
  return context;
}

/**
 * Join and manage a room
 *
 * @example
 * const { room, isConnected } = useRoom('room_123', {
 *   displayName: 'John Doe',
 *   audio: true,
 *   video: true
 * });
 */
export function useRoom(roomId: string, options?: JoinRoomOptions) {
  const { client } = useChalk();
  const [room, setRoom] = useState<ChalkRoom | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !roomId || !options) return;

    let mounted = true;
    let roomInstance: ChalkRoom | null = null;

    const join = async () => {
      try {
        roomInstance = await client.joinRoom(roomId, options);
        if (mounted) {
          setRoom(roomInstance);
          setIsConnected(true);
        }
      } catch (err) {
        if (mounted) {
          setError(err as Error);
        }
      }
    };

    join();

    return () => {
      mounted = false;
      roomInstance?.leave();
    };
  }, [client, roomId, options?.displayName]);

  return { room, isConnected, error };
}

/**
 * Get list of participants and active speaker
 *
 * @example
 * const { participants, activeSpeaker } = useParticipants();
 */
export function useParticipants() {
  const { room } = useChalk();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<Participant | null>(null);

  useEffect(() => {
    if (!room) return;

    const updateParticipants = () => {
      setParticipants(Array.from(room.participants.values()));
    };

    room.on('participantJoined', updateParticipants);
    room.on('participantLeft', updateParticipants);
    room.on('participantUpdated', updateParticipants);
    room.on('activeSpeakerChanged', setActiveSpeaker);

    updateParticipants();

    return () => {
      room.off('participantJoined', updateParticipants);
      room.off('participantLeft', updateParticipants);
      room.off('participantUpdated', updateParticipants);
      room.off('activeSpeakerChanged', setActiveSpeaker);
    };
  }, [room]);

  return { participants, activeSpeaker, localParticipant: room?.localParticipant };
}

/**
 * Control media devices
 *
 * @example
 * const { toggleAudio, toggleVideo, isAudioEnabled } = useMediaControls();
 */
export function useMediaControls() {
  const { room } = useChalk();

  const toggleVideo = useCallback(async () => {
    await room?.toggleVideo();
  }, [room]);

  const toggleAudio = useCallback(async () => {
    await room?.toggleAudio();
  }, [room]);

  const startScreenShare = useCallback(async () => {
    await room?.startScreenShare();
  }, [room]);

  const stopScreenShare = useCallback(async () => {
    await room?.stopScreenShare();
  }, [room]);

  return {
    toggleVideo,
    toggleAudio,
    startScreenShare,
    stopScreenShare,
    isVideoEnabled: room?.localParticipant?.videoEnabled ?? false,
    isAudioEnabled: room?.localParticipant?.audioEnabled ?? false,
    isScreenSharing: room?.localParticipant?.screenShareEnabled ?? false,
  };
}
```

### UI Components (sdk-react/src/components.tsx)

```typescript
import React, { useEffect } from 'react';
import { Participant } from '@chalk/core';

/**
 * VideoGrid - Display all participants in a grid layout
 *
 * @example
 * <VideoGrid participants={participants} />
 */
export function VideoGrid({
  participants,
  className,
}: {
  participants: Participant[];
  className?: string;
}) {
  return (
    <div className={`chalk-video-grid ${className ?? ''}`}>
      {participants.map((p) => (
        <VideoTile key={p.id} participant={p} />
      ))}
    </div>
  );
}

/**
 * VideoTile - Single participant video display
 *
 * @example
 * <VideoTile participant={participant} />
 */
export function VideoTile({
  participant,
  className,
}: {
  participant: Participant;
  className?: string;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && participant.videoTrack) {
      const stream = new MediaStream([participant.videoTrack]);
      videoRef.current.srcObject = stream;
    }
  }, [participant.videoTrack]);

  return (
    <div className={`chalk-video-tile ${className ?? ''}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={participant.id === 'local'}
      />
      <div className="chalk-participant-name">{participant.displayName}</div>
      <div className="chalk-participant-status">
        {!participant.audioEnabled && <span title="Muted">🔇</span>}
        {!participant.videoEnabled && <span title="Camera off">📵</span>}
      </div>
    </div>
  );
}

/**
 * Controls - Media control buttons (audio, video, screen share, leave)
 *
 * @example
 * <Controls
 *   onToggleAudio={handleAudio}
 *   onToggleVideo={handleVideo}
 *   onScreenShare={handleShare}
 *   onLeave={handleLeave}
 * />
 */
export function Controls({
  onToggleVideo,
  onToggleAudio,
  onScreenShare,
  onLeave,
  className,
}: {
  onToggleVideo?: () => void;
  onToggleAudio?: () => void;
  onScreenShare?: () => void;
  onLeave?: () => void;
  className?: string;
}) {
  const { isVideoEnabled, isAudioEnabled, isScreenSharing } = useMediaControls();

  return (
    <div className={`chalk-controls ${className ?? ''}`}>
      <button
        onClick={onToggleAudio}
        className={`chalk-control-btn ${isAudioEnabled ? 'active' : 'inactive'}`}
        title="Toggle audio"
      >
        {isAudioEnabled ? '🎤' : '🔇'}
      </button>
      <button
        onClick={onToggleVideo}
        className={`chalk-control-btn ${isVideoEnabled ? 'active' : 'inactive'}`}
        title="Toggle video"
      >
        {isVideoEnabled ? '📹' : '📵'}
      </button>
      <button
        onClick={onScreenShare}
        className={`chalk-control-btn ${isScreenSharing ? 'active' : 'inactive'}`}
        title="Screen share"
      >
        🖥️
      </button>
      <button
        onClick={onLeave}
        className="chalk-control-btn chalk-leave-btn"
        title="Leave call"
      >
        📞
      </button>
    </div>
  );
}
```

---

## @chalk/react-native Implementation

React Native bindings (minimal example).

### Installation

```bash
npm install @chalk/core react-native
```

### Main Export (sdk-react-native/src/index.ts)

```typescript
import { DyteClient } from '@dytesdk/react-native-core';
import { ChalkClient, ChalkRoom } from '@chalk/core';

/**
 * React Native version of ChalkClient
 * Uses native React Native Video component instead of HTML video
 */
export class ChalkClientRN extends ChalkClient {
  // Inherits from ChalkClient but can override platform-specific behavior
}

/**
 * Export same hooks as React version
 * They work the same way, just render to native components
 */
export { useRoom, useParticipants, useMediaControls, ChalkProvider } from '@chalk/core';

/**
 * Native React Native components
 */
export function VideoTileRN({ participant }: { participant: any }) {
  return (
    // React Native RTCView or similar
    <NativeRTCView
      streamURL={participant.videoTrack}
      objectFit="cover"
    />
  );
}
```

---

## Usage Examples

### Basic Usage (React)

```tsx
import { ChalkProvider, useRoom, useParticipants, VideoGrid, Controls } from '@chalk/react';

function App() {
  return (
    <ChalkProvider token="jwt_from_chalk_api">
      <MeetingRoom roomId="room_123" />
    </ChalkProvider>
  );
}

function MeetingRoom({ roomId }: { roomId: string }) {
  const { room, isConnected, error } = useRoom(roomId, {
    displayName: 'John Doe',
    audio: true,
    video: true,
  });

  const { participants, activeSpeaker } = useParticipants();

  if (!isConnected) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <VideoGrid participants={participants} />
      <Controls onLeave={() => room?.leave()} />
    </div>
  );
}
```

### Direct API Call (Server-to-Server)

```tsx
import { ChalkProvider, useRoom } from '@chalk/react';

function App() {
  return (
    <ChalkProvider apiKey="ck_live_xxx">
      {/* Uses apiKey to get token from Chalk API */}
      <MeetingRoom roomId="room_123" />
    </ChalkProvider>
  );
}
```

### Vanilla JavaScript

```typescript
import { ChalkClient } from '@chalk/core';

const client = new ChalkClient({ token: 'jwt_from_chalk_api' });

const room = await client.joinRoom('room_123', {
  displayName: 'John Doe',
  audio: true,
  video: true,
});

// Listen to events
room.on('participantJoined', (participant) => {
  console.log(`${participant.displayName} joined`);
});

// Control media
await room.toggleVideo();
await room.toggleAudio();
await room.startScreenShare();

// Leave
await room.leave();
```

---

## Configuration

```javascript
// webpack.config.js or vite.config.js
// Make sure to bundle @dytesdk/web-core properly

{
  externals: {
    '@dytesdk/web-core': '@dytesdk/web-core',
  }
}
```

---

## SDK Features (MVP)

- Video/Audio toggle
- Screen share
- Participant list + active speaker detection
- Recording controls via Chalk API
- Text chat
- Connection status monitoring
- Event system

---

## References

- [Dyte Web Core SDK](https://docs.dyte.io/web-core)
- [Dyte React SDK](https://docs.dyte.io/react-ui-kit)
- [Cloudflare RealtimeKit](https://docs.realtime.cloudflare.com/)
