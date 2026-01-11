# Chalk - Real-Time Video Conferencing Platform

**Ultra low-latency video conferencing built on Cloudflare RealtimeKit**
- **Use Case:** Education (virtual classrooms, tutoring, lectures)
- **Scale:** 1-10 participants/room, 1K-50K concurrent users
- **Timeline:** 2-4 weeks MVP

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONSUMING APPLICATIONS                           │
│                    (LMS, Education Platforms, Apps)                      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │      CHALK SDK LAYER    │
                    │  @chalk/react  @chalk/rn│
                    │       @chalk/core       │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ CLOUDFLARE EDGE │   │ CLOUDFLARE EDGE │   │ CLOUDFLARE EDGE │
│  (RealtimeKit   │   │   (RealtimeKit  │   │  (RealtimeKit   │
│   SFU + TURN)   │   │    SFU + TURN)  │   │   SFU + TURN)   │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         └───────────────────────┼───────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────────────────┐
│                         AWS CLOUD (us-east-1)                            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  API Gateway → ALB → ECS Cluster (Chalk API - Gin + WebSocket)   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│         │                    │                    │                      │
│         ▼                    ▼                    ▼                      │
│  ┌────────────┐      ┌────────────┐      ┌────────────┐                 │
│  │  Aurora    │      │ ElastiCache│      │  Secrets   │                 │
│  │ Serverless │      │  (Redis)   │      │  Manager   │                 │
│  │ PostgreSQL │      │            │      │            │                 │
│  └────────────┘      └────────────┘      └────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Cloudflare R2   │   │  S3 Glacier     │   │ Grafana Cloud   │
│ (Hot Storage)   │   │  (Archive)      │   │ (Monitoring)    │
│ 0-7 days        │   │  7+ days        │   │                 │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Data Flow Summary

1. **Room Creation:** Consumer App → Chalk API → Cloudflare API → Store mapping in DB
2. **Participant Join:** Client SDK → Chalk API → Cloudflare → Returns authToken for WebRTC
3. **Media Streaming:** Client ↔ Cloudflare SFU ↔ Client (Chalk NOT in media path)
4. **Real-time Events:** Client ↔ Chalk WebSocket ↔ Redis Pub/Sub ↔ Other Clients
5. **Recording:** Cloudflare SFU → R2 (hot) → S3 Glacier (archive after 7 days)

---

## Technology Stack

### Backend (Go)
| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | Gin | Fast, simple, popular |
| Structure | Clean Architecture | /domain, /usecase, /infrastructure, /interfaces |
| Database | sqlc | Type-safe Go from SQL |
| WebSocket | nhooyr/websocket | Modern, maintained |

### Client SDKs (TypeScript)
| Package | Purpose |
|---------|---------|
| `@chalk/core` | Vanilla JS, WebRTC logic, RealtimeKit wrapper |
| `@chalk/react` | React hooks & components |
| `@chalk/react-native` | React Native bindings |

### Infrastructure
| Component | Service |
|-----------|---------|
| Compute | ECS on EC2 (WebSocket support) |
| Database | Aurora Serverless v2 (PostgreSQL) |
| Cache | ElastiCache (Redis) |
| API Gateway | AWS API Gateway |
| Secrets | Secrets Manager |
| Storage (Hot) | Cloudflare R2 |
| Storage (Archive) | S3 Glacier |
| CI/CD | GitHub Actions + Terraform |
| Monitoring | Grafana Cloud |

---

## Monorepo Structure

```
chalk/
├── packages/
│   ├── api/                    # Go backend
│   │   ├── cmd/server/         # Entry point
│   │   ├── internal/
│   │   │   ├── domain/         # Entities (room, participant, tenant, recording)
│   │   │   ├── usecase/        # Business logic
│   │   │   ├── infrastructure/ # External services (cloudflare, postgres, redis)
│   │   │   └── interfaces/     # HTTP handlers, WebSocket, middleware
│   │   └── db/                 # Migrations + sqlc queries
│   ├── sdk-core/               # @chalk/core
│   ├── sdk-react/              # @chalk/react
│   └── sdk-react-native/       # @chalk/react-native
├── infrastructure/             # Terraform modules (vpc, ecs, aurora, elasticache)
└── .github/workflows/          # CI/CD (api.yml, sdk.yml, infra.yml)
```

---

## API Design

### REST Endpoints

```
# Auth
POST /api/v1/auth/token           # Exchange API key for JWT
POST /api/v1/auth/refresh         # Refresh JWT

# Tenants
POST   /api/v1/tenants            # Create
GET    /api/v1/tenants/:id        # Get
PATCH  /api/v1/tenants/:id        # Update
DELETE /api/v1/tenants/:id        # Delete

# Rooms
POST   /api/v1/rooms              # Create room
GET    /api/v1/rooms              # List rooms
GET    /api/v1/rooms/:id          # Get room
PATCH  /api/v1/rooms/:id          # Update
DELETE /api/v1/rooms/:id          # Delete
POST   /api/v1/rooms/:id/end      # End session

# Participants
POST   /api/v1/rooms/:id/participants           # Add (returns auth token)
GET    /api/v1/rooms/:id/participants           # List
DELETE /api/v1/rooms/:id/participants/:pid      # Remove
POST   /api/v1/rooms/:id/participants/:pid/token # Refresh token

# Recordings
POST   /api/v1/rooms/:id/recordings/start       # Start
POST   /api/v1/rooms/:id/recordings/stop        # Stop
GET    /api/v1/recordings                       # List
GET    /api/v1/recordings/:id                   # Get details
GET    /api/v1/recordings/:id/download          # Get download URL
DELETE /api/v1/recordings/:id                   # Delete
```

### WebSocket Events

```
ws://api.chalk.dev/ws?token=<jwt>

Server → Client: connected, participant.joined/left/updated, room.updated,
                 recording.started/stopped, chat.message, reaction, hand.raised/lowered, error

Client → Server: chat.send, reaction.send, hand.raise, hand.lower, ping
```

---

## Database Schema

```sql
-- Tenants (consuming applications)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL UNIQUE,
    config JSONB NOT NULL DEFAULT '{}',
    max_concurrent_rooms INT DEFAULT 100,
    max_participants_per_room INT DEFAULT 10,
    max_recording_duration_minutes INT DEFAULT 120,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rooms
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    cloudflare_meeting_id VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'active', -- active, ended
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Participants
CREATE TABLE participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    cloudflare_participant_id VARCHAR(255) NOT NULL,
    external_user_id VARCHAR(255),
    display_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'participant', -- host, participant
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recordings
CREATE TABLE recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    cloudflare_recording_id VARCHAR(255),
    storage_provider VARCHAR(50), -- r2, s3_glacier
    storage_path VARCHAR(500),
    size_bytes BIGINT,
    duration_seconds INT,
    status VARCHAR(50) DEFAULT 'recording', -- recording, processing, ready, archived, deleted
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit Logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    room_id UUID REFERENCES rooms(id),
    actor_id VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id UUID,
    metadata JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_participants_room_id ON participants(room_id);
CREATE INDEX idx_recordings_room_id ON recordings(room_id);
CREATE INDEX idx_recordings_status ON recordings(status);
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

---

## SDK API Design

### @chalk/core

```typescript
import { ChalkClient } from '@chalk/core';

const chalk = new ChalkClient({ apiKey: 'ck_live_xxx' }); // or token: 'jwt_from_server'

const room = await chalk.joinRoom('room_id', {
  displayName: 'John Doe',
  audio: true,
  video: true,
});

// Media controls
room.toggleVideo();
room.toggleAudio();
room.startScreenShare({ withAnnotations: true });

// Participants
room.participants; // Map<string, Participant>
room.on('participantJoined', (p) => {});
room.on('activeSpeakerChanged', (p) => {});

// Chat & Reactions
room.sendMessage('Hello!');
room.sendReaction('👍');
room.raiseHand();

// Recording (if permitted)
room.startRecording();
room.stopRecording();

room.leave();
```

### @chalk/react

```tsx
import { ChalkProvider, useRoom, useParticipants, VideoGrid, Controls } from '@chalk/react';

function App() {
  return (
    <ChalkProvider apiKey="ck_live_xxx">
      <MeetingRoom roomId="room_123" />
    </ChalkProvider>
  );
}

function MeetingRoom({ roomId }) {
  const { room, isConnected } = useRoom(roomId);
  const { participants } = useParticipants();

  return (
    <div>
      <VideoGrid participants={participants} />
      <Controls
        onToggleVideo={() => room.toggleVideo()}
        onToggleAudio={() => room.toggleAudio()}
        onScreenShare={() => room.startScreenShare()}
      />
    </div>
  );
}
```

### SDK Features (MVP)
- Video/Audio toggle
- Screen share with collaborative annotations
- Participant list + active speaker detection
- Virtual backgrounds + noise cancellation
- Connection status + bandwidth indicator
- Recording controls
- Text chat (ephemeral)
- Raise hand + Reactions (emoji)

---

## Authentication Flow

```
SERVER-TO-SERVER (Recommended):
1. Consumer Backend → Chalk API: POST /rooms (API Key)
2. Chalk API → Cloudflare: Create meeting → Get meeting_id
3. Consumer Backend → Chalk API: POST /rooms/:id/participants (user info)
4. Chalk API → Cloudflare: Add participant → Get cf_authToken
5. Chalk API → Consumer Backend: chalk_jwt (wraps cf_authToken)
6. Consumer → Client: Pass chalk_jwt
7. Client SDK → Cloudflare: Connect WebRTC with authToken

JWT Payload:
{
  "sub": "participant_uuid",
  "room_id": "room_uuid",
  "tenant_id": "tenant_uuid",
  "display_name": "John Doe",
  "role": "host" | "participant",
  "permissions": { "can_record": true, "can_screen_share": true, "can_kick": false },
  "cf_auth_token": "cloudflare_participant_token",
  "exp": 1703289600,
  "iat": 1703286000
}
```

---

## Cost Model

### Cloudflare RealtimeKit Pricing
- **$0.05/GB** egress (SFU → clients)
- **1 TB free** per month
- Ingress (client → SFU) is **FREE**

### SFU Bandwidth Formula
```
Egress Streams = N participants × (N-1)
GB per room per hour = Egress Streams × 0.35 GB (medium quality @ 784 Kbps)
```

| Participants | Egress Streams | GB/Hour | Cost/Hour |
|--------------|----------------|---------|-----------|
| 2 (1:1) | 2 | 0.7 GB | $0.035 |
| 3 | 6 | 2.1 GB | $0.105 |
| 5 | 20 | 7.0 GB | $0.35 |
| 10 | 90 | 31.5 GB | $1.58 |

### Monthly Cost by Tier

| Tier | MAU | Concurrent | Cloudflare | AWS Infra | Total |
|------|-----|------------|------------|-----------|-------|
| **Startup** | ~200 | 10 rooms × 3p = 30 | $34 | $174 | **~$210/mo** |
| **Growth** | ~1,000 | 33 rooms × 3p = 100 | $370 | $404 | **~$775/mo** |
| **Scale** | ~5,000 | 125 rooms × 4p = 500 | $4,150 | $1,000 | **~$5,150/mo** |

*Current prod is Startup tier (verified Jan 2026)*

### AWS Infrastructure Breakdown

| Component | Startup | Growth | Scale |
|-----------|---------|--------|-------|
| ECS | $15 (1× t3.small) | $61 (2× t3.medium) | $200 (4× t3.large) |
| Aurora Serverless v2 | $44 (0.5-2 ACU) | $175 (2-8 ACU) | $350 (4-16 ACU) |
| ElastiCache | $24 (2× t3.micro) | $50 (2× t3.small) | $150 (2× r6g.large) |
| NAT Gateway | $33 (1×) | $33 (1×) | $99 (3×) |
| ALB + API Gateway | $26 | $35 | $100 |
| Other (WAF, KMS, CW) | $32 | $50 | $101 |
| **Total** | **$174** | **$404** | **$1,000** |

### Recording Storage Costs
- **R2 (0-7 days):** $0.015/GB/month, FREE egress
- **S3 Glacier (7+ days):** $0.004/GB/month
- **Recording size** = live bandwidth × duration (e.g., 3p × 1hr = ~2.1 GB)

### Quick Calculator
```javascript
function calculateMinutes(budget, participants) {
  const costPerHour = { 2: 0.035, 3: 0.105, 5: 0.35, 10: 1.58 };
  const awsInfra = budget <= 300 ? 174 : 404; // Startup vs Growth tier
  const available = (budget - awsInfra) + 50; // +$50 free tier
  const hours = available / costPerHour[participants];
  return Math.round(hours * 60);
}
// calculateMinutes(250, 3) → 72,000 minutes (~1,200 hours)
```

### Cost Optimization
1. **Adaptive bitrate** - 50-70% bandwidth savings
2. **Audio-only mode** - 95% reduction for listeners
3. **Participant limits** - Cap at 5-6 (sweet spot: 3-5)
4. **Auto-delete recordings** - 30/60/90 day retention
5. **Negotiate volume pricing** at scale

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [x] Terraform: VPC, ECS, Aurora, ElastiCache
- [ ] GitHub Actions pipelines
- [ ] Go backend skeleton (Clean Architecture, Gin, sqlc)
- [ ] Cloudflare RealtimeKit app + R2 bucket

### Phase 2: Core API (Week 1-2)
- [ ] Auth: API key validation, JWT gen/validate, tenant management
- [ ] Room management + Cloudflare integration
- [ ] WebSocket server + Redis Pub/Sub

### Phase 3: SDK Development (Week 2-3)
- [ ] @chalk/core: ChalkClient, Room, media controls, chat, reactions
- [ ] @chalk/react: ChalkProvider, hooks, components
- [ ] @chalk/react-native: Native bridge + RealtimeKit RN SDK

### Phase 4: Features & Polish (Week 3-4)
- [ ] Recording: start/stop API, R2 integration, Glacier lifecycle
- [ ] Screen share + annotations
- [ ] Testing (unit, integration, E2E)
- [ ] OpenAPI spec + documentation

---

## Security

### Authentication
- API keys (bcrypt hashed)
- JWT tokens (RS256, short-lived)
- Token refresh mechanism

### Network
- HTTPS/WSS only
- VPC with private subnets
- Security groups (least privilege)
- WAF on API Gateway

### Data
- Encryption at rest (Aurora, S3)
- SFU-terminated encryption (Cloudflare handles)
- Audit logging for compliance

### Future (HIPAA/GDPR)
- BAA with Cloudflare
- Data residency controls
- Right to deletion

---

## Rate Limiting

```go
type RateLimits struct {
    MaxConcurrentRooms       int // per tenant
    MaxParticipantsPerRoom   int
    MaxRecordingDurationMins int
    APIRequestsPerMinute     int
}
// Stored in tenant config, enforced via Redis
```

---

## Monitoring & Alerting

**Metrics:** Request latency (p50/95/99), error rates, active rooms, concurrent participants, recording size, Cloudflare API latency, DB connections, Redis hit rate

**Alerts (Email + Discord):** Error rate > 5%, latency p99 > 500ms, DB connections > 80%, failed Cloudflare calls, storage quota warnings

---

## Open Questions

1. Domain name
2. Cloudflare account setup
3. AWS region confirmation (us-east-1?)
4. Branding/logo for SDK docs

---

## References

- [Cloudflare Realtime Docs](https://developers.cloudflare.com/realtime/)
- [RealtimeKit API Reference](https://developers.cloudflare.com/api/resources/realtime_kit/)
- [RealtimeKit Documentation](https://docs.realtime.cloudflare.com/)
