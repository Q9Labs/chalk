# Chalk

Ultra low-latency, low-bandwidth optimized, real-time video conferencing platform built on Cloudflare RealtimeKit.

**Primary Use Case:** Education (virtual classrooms, tutoring, lectures)

## Monorepo Structure

```
chalk/
├── packages/
│   ├── api/              # Go backend (Gin, sqlc, WebSocket)
│   ├── sdk-core/         # @chalk/core - Vanilla JS SDK
│   ├── sdk-react/        # @chalk/react - React hooks & components
│   └── sdk-react-native/ # @chalk/react-native - React Native bindings
├── infrastructure/       # Terraform modules for AWS
├── apps/                 # Example applications
└── .github/workflows/    # CI/CD pipelines
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- [Go](https://go.dev) (v1.22+)
- [Terraform](https://terraform.io) (v1.5+)

### Installation

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Type check
bun run check-types
```

### Development

```bash
# Run all packages in dev mode
bun run dev

# Run tests
bun run test
```

## SDK Usage

### @chalk/core

```typescript
import { ChalkClient } from '@chalk/core';

const chalk = new ChalkClient({
  apiKey: 'ck_live_xxx', // or use server-provided token
});

const room = await chalk.joinRoom('room_id', {
  displayName: 'John Doe',
  audio: true,
  video: true,
});

// Media controls
room.toggleVideo();
room.toggleAudio();
room.startScreenShare();

// Chat
room.sendMessage('Hello!');

// Leave
room.leave();
```

### @chalk/react

```tsx
import { ChalkProvider, useRoom, useParticipants, useMedia } from '@chalk/react';

function App() {
  return (
    <ChalkProvider apiKey="ck_live_xxx">
      <MeetingRoom roomId="room_123" />
    </ChalkProvider>
  );
}

function MeetingRoom({ roomId }) {
  const { room, isConnected } = useRoom();
  const { participants } = useParticipants();
  const { toggleVideo, toggleAudio, isVideoEnabled, isAudioEnabled } = useMedia();

  return (
    <div>
      {participants.map(p => (
        <div key={p.id}>{p.displayName}</div>
      ))}
      <button onClick={toggleVideo}>
        {isVideoEnabled ? 'Disable Video' : 'Enable Video'}
      </button>
    </div>
  );
}
```

## Architecture

- **Backend:** Go with Gin framework, Clean Architecture
- **Database:** PostgreSQL (Aurora Serverless v2) with sqlc
- **Cache:** Redis (ElastiCache)
- **WebRTC:** Cloudflare RealtimeKit (SFU)
- **Storage:** Cloudflare R2 (hot) + S3 Glacier (archive)
- **Infrastructure:** AWS (ECS, Aurora, ElastiCache) via Terraform

## License

Private - All rights reserved
