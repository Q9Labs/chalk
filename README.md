# Chalk

Ultra low-latency, low-bandwidth optimized, real-time video conferencing platform built on Cloudflare RealtimeKit.


**Primary Use Case:** Education (virtual classrooms, tutoring, lectures)

## Monorepo Structure

```
chalk/
├── packages/
│   ├── sdk-core/              # @q9labs/chalk-core - Vanilla JS SDK
│   ├── sdk-react/             # @q9labs/chalk-react - React hooks & components
│   ├── sdk-react-native/      # @q9labs/chalk-react-native - React Native SDK
│   └── ui/                    # @q9labs/chalk-ui - Base UI components
├── apps/
│   ├── api/                   # Go backend (Gin, sqlc, WebSocket, Clean Architecture)
│   └── web/                   # Demo app (Vite + React + TanStack Router)
├── infrastructure/            # Terraform modules for AWS (ECS, Aurora, ElastiCache, R2, S3)
└── .github/workflows/         # CI/CD pipelines (separate: api.yml, sdk.yml, infra.yml)
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.1+) - JavaScript/TypeScript runtime & package manager
- [Go](https://go.dev) (v1.24+) - Backend server
- [Terraform](https://terraform.io) (v1.5+) - Infrastructure as code (optional)

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

### @q9labs/chalk-core

```typescript
import { ChalkClient } from "@q9labs/chalk-core";

const chalk = new ChalkClient({
  // Recommended: Dynamic token provider for auto-refresh
  tokenProvider: async () => {
    const res = await fetch("/api/chalk-token");
    return res.json().token;
  },
  // Alternative: Static JWT token
  // token: "eyJhbGc...",
});

const room = await chalk.joinRoom("room_id", {
  displayName: "John Doe",
  audio: true,
  video: true,
});

// Media controls
room.toggleVideo();
room.toggleAudio();
room.startScreenShare();

// Chat
room.sendMessage("Hello!");

// Listen to auth events
chalk.on("token-expired", async () => {
  console.log("Token refreshed automatically");
});

// Leave
room.leave();
```

### @q9labs/chalk-react

```tsx
import {
  ChalkProvider,
  useRoom,
  useParticipants,
  useMedia,
  useChat,
  useRecording,
} from "@q9labs/chalk-react";

function App() {
  return (
    <ChalkProvider
      tokenProvider={async () => {
        const res = await fetch("/api/chalk-token");
        return res.json().token;
      }}
    >
      <MeetingRoom roomId="room_123" />
    </ChalkProvider>
  );
}

function MeetingRoom({ roomId }) {
  const { room, isConnected } = useRoom();
  const { participants } = useParticipants();
  const { toggleVideo, toggleAudio, isVideoEnabled, isAudioEnabled } =
    useMedia();
  const { messages, sendMessage } = useChat();
  const { isRecording, startRecording, stopRecording } = useRecording();

  return (
    <div>
      {participants.map((p) => (
        <div key={p.id}>{p.displayName}</div>
      ))}
      <button onClick={toggleVideo}>
        {isVideoEnabled ? "Disable Video" : "Enable Video"}
      </button>
      <button onClick={() => sendMessage("Hi there!")}>Send Message</button>
      <button onClick={isRecording ? stopRecording : startRecording}>
        {isRecording ? "Stop Recording" : "Start Recording"}
      </button>
    </div>
  );
}
```

## Architecture

### Backend

- **Framework:** Go + Gin with Clean Architecture
- **Layering:** Domain services (RoomService, ParticipantService, RecordingService) → HTTP handlers → Infrastructure (Auth, Storage, Database)
- **Database:** PostgreSQL (Aurora Serverless v2) with sqlc for type-safe queries
- **Cache:** Redis (ElastiCache) for room state and rate limiting
- **Auth:** Two-tier (API Key + JWT with 15-min expiry, refresh tokens for 7 days)
- **WebSocket:** Real-time participant state and recording updates

### Frontend SDKs

- **Type Safety:** OpenAPI-driven auto-generated types from `apps/api/openapi.yaml`
- **Auth Pattern:** TokenProvider for dynamic JWT refresh (browser-safe, secure)
- **Payload Transforms:** Automatic snake_case ↔ camelCase conversion (Go ↔ JS)
- **Error Handling:** Type-safe `Result<T>` pattern, no exceptions
- **Layering:**
  - Core (vanilla JS/WebRTC)
  - React hooks + context provider
  - React Native bindings with platform-specific hooks
  - Reusable UI components (Base UI + Tailwind)

### Real-Time Communication

- **WebRTC:** Cloudflare RealtimeKit (SFU) for low-latency video/audio
- **Signaling:** WebSocket upgrade via API for credential exchange
- **Bandwidth:** Optimized for education use case (< 5 Mbps per participant)

### Storage

- **Hot:** Cloudflare R2 (immediate access, cost-effective)
- **Cold:** S3 Glacier (long-term archival with lifecycle manager)
- **Lifecycle:** Automatic R2 → S3 archival after recording completion

### Infrastructure

- **Compute:** AWS ECS with auto-scaling
- **Database:** Aurora Serverless v2 (pay-per-use)
- **Cache:** ElastiCache Redis (session state, rate limiting)
- **Code:** Terraform modules for repeatable deployments (dev → staging → prod)

## License

Q9Labs - All rights reserved
