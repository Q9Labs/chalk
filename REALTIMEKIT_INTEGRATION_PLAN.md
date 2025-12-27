# Cloudflare RealtimeKit Integration Plan

## Overview

Integrate Cloudflare RealtimeKit WebRTC SDK into `@chalk/core` and `@chalk/react` to provide production-ready real-time video/audio functionality.

## Current State

- Go API backend is complete with Cloudflare Calls integration
- Demo endpoint `/api/v1/demo/join` works and returns `auth_token` from Cloudflare
- SDK structure exists but uses mock WebSocket connection
- Need to replace mock with actual RealtimeKit WebRTC

## Packages to Install

```bash
# In packages/sdk-core
bun add @cloudflare/realtimekit

# In packages/sdk-react
bun add @cloudflare/realtimekit-react
```

## RealtimeKit API Reference

### Installation
```javascript
npm install @cloudflare/realtimekit
npm install @cloudflare/realtimekit-react  // For React
```

### Initialization (Vanilla JS)
```javascript
import { RealtimeKitClient } from '@cloudflare/realtimekit';

const meeting = await RealtimeKitClient.init({
  authToken: '<auth-token-from-api>',
  defaults: {
    audio: false,
    video: false,
  },
});
```

### Initialization (React)
```javascript
import { RealtimeKitProvider, useRealtimeKitClient } from '@cloudflare/realtimekit-react';

function App() {
  const [meeting, initMeeting] = useRealtimeKitClient();

  useEffect(() => {
    initMeeting({
      authToken: '<auth-token>',
      defaults: { audio: false, video: false },
    });
  }, []);

  return (
    <RealtimeKitProvider value={meeting}>
      {/* Components */}
    </RealtimeKitProvider>
  );
}
```

### Join/Leave Room
```javascript
await meeting.join();      // Emits 'roomJoined' event on meeting.self
await meeting.leave();     // Emits 'roomLeft' event
```

### Events
```javascript
meeting.self.on('roomJoined', () => {
  console.log('Joined room');
});

meeting.self.on('roomLeft', () => {
  console.log('Left room');
});
```

### Key Properties
- `meeting.self` - Local participant (audio/video controls)
- `meeting.participants` - Contains `waitlisted`, `joined`, `active`, `pinned` maps
- `meeting.self.videoTrack` - Local video MediaStreamTrack
- `meeting.self.audioTrack` - Local audio MediaStreamTrack

### Media Controls
```javascript
await meeting.self.enableVideo();
await meeting.self.disableVideo();
await meeting.self.enableAudio();
await meeting.self.disableAudio();
```

## Implementation Steps

### 1. Update `packages/sdk-core/src/client.ts`

Replace the custom WebSocket client with RealtimeKit:

```typescript
import { RealtimeKitClient } from '@cloudflare/realtimekit';

export class ChalkClient {
  private rtkClient: RealtimeKitClient | null = null;

  async joinRoom(roomId: string, config: RoomConfig): Promise<Room> {
    // Get auth token from API (existing code works)
    const response = this.debug
      ? await this.apiClient.demoJoin(roomId, config.displayName)
      : await this.apiClient.addParticipant(roomId, config.displayName, undefined, config.metadata);

    const { token } = response.data;  // This is the Cloudflare auth_token

    // Initialize RealtimeKit with the token
    this.rtkClient = await RealtimeKitClient.init({
      authToken: token,
      defaults: {
        audio: config.audio ?? false,
        video: config.video ?? false,
      },
    });

    // Join the room
    await this.rtkClient.join();

    // Create Room wrapper
    const room = new Room(roomId, this.rtkClient, this.debug);
    // ... rest of setup

    return room;
  }
}
```

### 2. Update `packages/sdk-core/src/room.ts`

Wrap RealtimeKit meeting instance:

```typescript
import type { RealtimeKitClient } from '@cloudflare/realtimekit';

export class Room {
  private rtkClient: RealtimeKitClient;

  constructor(id: string, rtkClient: RealtimeKitClient, debug = false) {
    this.id = id;
    this.rtkClient = rtkClient;
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.rtkClient.self.on('roomJoined', () => {
      this._setStatus('connected');
      this.emit('status-changed', 'connected');
    });

    // Map RealtimeKit events to Chalk events
    this.rtkClient.participants.joined.on('participantJoined', (participant) => {
      this.emit('participant-joined', this.mapParticipant(participant));
    });
  }

  async toggleVideo(): Promise<boolean> {
    if (this.rtkClient.self.videoEnabled) {
      await this.rtkClient.self.disableVideo();
      return false;
    } else {
      await this.rtkClient.self.enableVideo();
      return true;
    }
  }

  async toggleAudio(): Promise<boolean> {
    if (this.rtkClient.self.audioEnabled) {
      await this.rtkClient.self.disableAudio();
      return false;
    } else {
      await this.rtkClient.self.enableAudio();
      return true;
    }
  }

  get localVideoTrack(): MediaStreamTrack | null {
    return this.rtkClient.self.videoTrack;
  }

  get localAudioTrack(): MediaStreamTrack | null {
    return this.rtkClient.self.audioTrack;
  }

  leave(): void {
    this.rtkClient.leave();
  }
}
```

### 3. Update `packages/sdk-react/package.json`

```json
{
  "dependencies": {
    "@chalk/core": "workspace:*",
    "@cloudflare/realtimekit-react": "^0.63.0"
  }
}
```

### 4. Update `packages/sdk-react/src/context.tsx`

Use RealtimeKit React provider:

```typescript
import { RealtimeKitProvider, useRealtimeKitClient } from '@cloudflare/realtimekit-react';

export function ChalkProvider({ children, apiKey, token, apiUrl, debug }: ChalkProviderProps) {
  const [rtkMeeting, initRtkMeeting] = useRealtimeKitClient();
  const [client] = useState(() => new ChalkClient({ apiKey, token, apiUrl, debug }));

  // Expose both Chalk client and RTK meeting through context
  const value = useMemo(() => ({
    client,
    rtkMeeting,  // RealtimeKit meeting instance
    initRtkMeeting,
    // ... existing values
  }), [client, rtkMeeting]);

  return (
    <ChalkContext.Provider value={value}>
      <RealtimeKitProvider value={rtkMeeting}>
        {children}
      </RealtimeKitProvider>
    </ChalkContext.Provider>
  );
}
```

### 5. Update `packages/sdk-react/src/components/VideoTile.tsx`

Render actual video from MediaStreamTrack:

```typescript
import { useEffect, useRef } from 'react';

export function VideoTile({ participant }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && participant.videoTrack) {
      const stream = new MediaStream([participant.videoTrack]);
      videoRef.current.srcObject = stream;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [participant.videoTrack]);

  return (
    <div className="chalk-video-tile">
      {participant.videoEnabled ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
        />
      ) : (
        <div className="avatar">{participant.displayName[0]}</div>
      )}
      <span className="name">{participant.displayName}</span>
    </div>
  );
}
```

### 6. Update hooks to use RealtimeKit

**useParticipants.ts:**
```typescript
import { useRealtimeKitMeeting, useRealtimeKitSelector } from '@cloudflare/realtimekit-react';

export function useParticipants() {
  const meeting = useRealtimeKitMeeting();

  const participants = useRealtimeKitSelector((m) =>
    Array.from(m.participants.joined.values())
  );

  const localParticipant = useRealtimeKitSelector((m) => m.self);

  return {
    participants: participants.map(mapToChalkParticipant),
    localParticipant: mapToChalkParticipant(localParticipant),
    participantCount: participants.length + 1,
  };
}
```

**useMedia.ts:**
```typescript
import { useRealtimeKitMeeting } from '@cloudflare/realtimekit-react';

export function useMedia() {
  const meeting = useRealtimeKitMeeting();

  const toggleVideo = async () => {
    if (meeting.self.videoEnabled) {
      await meeting.self.disableVideo();
    } else {
      await meeting.self.enableVideo();
    }
  };

  const toggleAudio = async () => {
    if (meeting.self.audioEnabled) {
      await meeting.self.disableAudio();
    } else {
      await meeting.self.enableAudio();
    }
  };

  return {
    isVideoEnabled: meeting.self.videoEnabled,
    isAudioEnabled: meeting.self.audioEnabled,
    toggleVideo,
    toggleAudio,
    localVideoTrack: meeting.self.videoTrack,
    localAudioTrack: meeting.self.audioTrack,
  };
}
```

## API Response Mapping

The Go API returns this from `/api/v1/demo/join`:

```json
{
  "success": true,
  "room_id": "uuid",
  "participant_id": "uuid",
  "token": "jwt-token",           // Chalk JWT
  "auth_token": "cloudflare-jwt", // Use THIS for RealtimeKit.init()
  "room": { "id": "uuid", "name": "room-name" }
}
```

**Important:** Use `auth_token` (the Cloudflare JWT) for `RealtimeKitClient.init({ authToken })`.

## Files to Modify

1. `packages/sdk-core/package.json` - Add @cloudflare/realtimekit
2. `packages/sdk-core/src/client.ts` - Use RealtimeKitClient
3. `packages/sdk-core/src/room.ts` - Wrap RTK meeting
4. `packages/sdk-core/src/ws-client.ts` - Remove or keep as fallback
5. `packages/sdk-react/package.json` - Add @cloudflare/realtimekit-react
6. `packages/sdk-react/src/context.tsx` - Add RealtimeKitProvider
7. `packages/sdk-react/src/hooks/useParticipants.ts` - Use RTK hooks
8. `packages/sdk-react/src/hooks/useMedia.ts` - Use RTK self
9. `packages/sdk-react/src/hooks/useDevices.ts` - Use RTK device APIs
10. `packages/sdk-react/src/components/VideoTile.tsx` - Render real video
11. `packages/sdk-react/src/components/VideoGrid.tsx` - Pass tracks

## Documentation Sources

- [RealtimeKit Web Core Quickstart](https://docs.realtime.cloudflare.com/web-core)
- [RealtimeKitClient Reference](https://docs.realtime.cloudflare.com/rn-core/reference/RealtimeKitClient)
- [GitHub Examples](https://github.com/cloudflare/realtimekit-web-examples)
- [Cloudflare Realtime Overview](https://developers.cloudflare.com/realtime/)

## Testing

1. Start Go API: `go run ./cmd/main.go` (with env vars)
2. Start web app: `bun run dev` in apps/web
3. Go to http://localhost:3070/demo
4. Enter name and room ID
5. Should see actual video from camera

## Notes

- RealtimeKit handles all WebRTC complexity (ICE, STUN, TURN, etc.)
- No need for custom WebSocket - RealtimeKit handles signaling
- The `auth_token` from Cloudflare is what initializes the WebRTC connection
- Participant sync happens automatically through RealtimeKit
