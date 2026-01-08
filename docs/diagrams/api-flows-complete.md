# Chalk API - Complete Request Flows

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP Request                            │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                  Gin Router (router.go)                      │
│  - CORS middleware                                           │
│  - Route matching                                            │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              Authentication Middleware                       │
│  - JWT validation (for /rooms, /recordings)                 │
│  - API Key validation (for /tenants)                        │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                 Handler (handlers/*.go)                      │
│  - Parse request                                             │
│  - Validate input                                            │
│  - Call domain service                                       │
│  - Format response                                           │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│           Domain Service (internal/domain/*)                 │
│  - Business logic                                            │
│  - Validation rules                                          │
│  - Orchestrate multiple operations                           │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│              Infrastructure Layer                            │
│  ├─ Database (queries.*)                                    │
│  ├─ Cloudflare API (cfClient.*)                             │
│  ├─ Redis (roomState.*, wsHub.*)                            │
│  └─ Storage (storageR2/S3.*)                                │
└─────────────────────────────────────────────────────────────┘
```

---

## API Routes Map

### Public Routes (No Auth)
```
GET  /health                           → Health check
POST /api/v1/auth/token                → Get JWT token (requires API key in body)
POST /api/v1/auth/refresh              → Refresh JWT token
POST /api/v1/demo/join                 → Quick demo room join
POST /api/v1/tenants                   → Create tenant account
POST /api/v1/webhooks/cloudflare/recording → Cloudflare webhook
```

### Tenant Routes (API Key Auth)
```
GET    /api/v1/tenants/:id             → Get tenant details
PATCH  /api/v1/tenants/:id             → Update tenant
DELETE /api/v1/tenants/:id             → Delete tenant
POST   /api/v1/tenants/:id/rotate-key  → Rotate API key
```

### Room Routes (JWT Auth)
```
POST   /api/v1/rooms                   → Create room
GET    /api/v1/rooms                   → List rooms
GET    /api/v1/rooms/:id               → Get room details
PATCH  /api/v1/rooms/:id               → Update room
DELETE /api/v1/rooms/:id               → Delete room
POST   /api/v1/rooms/:id/end           → End room
```

### Participant Routes (JWT Auth, nested under rooms)
```
POST   /api/v1/rooms/:id/participants              → Add participant
GET    /api/v1/rooms/:id/participants              → List participants
DELETE /api/v1/rooms/:id/participants/:pid         → Remove participant
POST   /api/v1/rooms/:id/participants/:pid/token   → Refresh participant token
```

### Recording Routes (JWT Auth)
```
POST   /api/v1/rooms/:id/recordings/start          → Start recording
POST   /api/v1/rooms/:id/recordings/stop           → Stop recording
POST   /api/v1/rooms/:id/recordings/:rid/archive   → Archive recording

GET    /api/v1/recordings                          → List recordings
GET    /api/v1/recordings/:id                      → Get recording
GET    /api/v1/recordings/:id/download             → Download recording
POST   /api/v1/recordings/:id/archive              → Archive recording
DELETE /api/v1/recordings/:id                      → Delete recording
```

### WebSocket (JWT Auth)
```
GET /ws?token=<jwt>                    → WebSocket connection for real-time updates
```

---

## Flow 1: Create Tenant (Onboarding)

**Request:**
```http
POST /api/v1/tenants
Content-Type: application/json

{
  "name": "Acme University",
  "max_concurrent_rooms": 100,
  "max_participants_per_room": 50
}
```

**Code Flow:**

```
1. router.go:109
   ↓ tenantsGroup.POST("", tenants.Create)

2. handlers/tenants.go → Create()
   ↓ Parse request body
   ↓ Validate input
   ↓ Call apiKeyService.GenerateAPIKey()
   ↓ Hash API key

3. queries.CreateTenant()
   ↓ INSERT INTO tenants (name, api_key_hash, ...)
   ↓ RETURNING *

4. Response
   {
     "id": "550e8400-...",
     "name": "Acme University",
     "api_key": "ck_live_abc123...",  ← Only shown once!
     "created_at": "2026-01-06T10:30:00Z"
   }
```

**Key Points:**
- API key returned ONCE (like Stripe keys)
- API key hash stored in database (bcrypt)
- Client must save API key securely

---

## Flow 2: Get JWT Token (Authentication)

**Request:**
```http
POST /api/v1/auth/token
Content-Type: application/json

{
  "api_key": "ck_live_abc123...",
  "display_name": "Professor Alice",
  "role": "host",
  "room_id": null  // Or specific room ID
}
```

**Code Flow:**

```
1. router.go:100
   ↓ v1.POST("/auth/token", authHandler.Token)

2. handlers/auth.go → Token()
   ↓ Parse request body
   ↓ Extract API key from body

3. middleware/auth.go → apiKeyService.ValidateAPIKey()
   ↓ queries.GetTenantByAPIKeyHash(hash)
   ↓ bcrypt.CompareHashAndPassword(storedHash, providedKey)
   ↓ Return tenant if valid

4. handlers/auth.go → jwtService.GenerateToken()
   ↓ Create JWT claims:
     {
       "tenant_id": "550e8400-...",
       "room_id": "abc123-...",
       "display_name": "Professor Alice",
       "role": "host",
       "exp": now + 15 minutes
     }
   ↓ Sign with HS256

5. Response
   {
     "token": "eyJhbGciOiJIUzI1NiIs...",
     "expires_at": "2026-01-06T10:45:00Z",
     "tenant_id": "550e8400-..."
   }
```

**Key Points:**
- JWT short-lived (15 min default)
- Role embedded in token (host vs participant)
- Token required for all /rooms and /recordings endpoints

---

## Flow 3: Create Room (Main Flow)

**Request:**
```http
POST /api/v1/rooms
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
  "name": "CS101 Lecture",
  "config": {
    "recording_enabled": true,
    "max_participants": 30
  }
}
```

**Code Flow:**

```
1. router.go:122
   ↓ roomsGroup.POST("", rooms.Create)

2. middleware/auth.go → RequireJWT()
   ↓ Extract token from Authorization header
   ↓ jwtService.ValidateToken(token)
   ↓ Parse claims (tenant_id, role, etc.)
   ↓ Store claims in gin.Context
   ↓ c.Set("tenant_id", claims.TenantID)
   ↓ c.Next() → continue to handler

3. handlers/rooms.go → Create()
   ↓ Parse request body
   ↓ Extract tenant_id from context
   ↓ Validate input
   ↓ Call roomService.CreateRoom()

4. domain/room/service.go → CreateRoom()
   ↓ Check tenant limits:
     queries.CountActiveRoomsByTenant(tenantID)
     if count >= tenant.MaxConcurrentRooms → error

   ↓ Create meeting in Cloudflare:
     cfClient.CreateMeeting(ctx, CreateMeetingRequest{
       Name: "CS101 Lecture",
     })
     ← Returns { meetingID: "cf-abc123", sessionURL: "..." }

   ↓ Save to database:
     queries.CreateRoom(ctx, CreateRoomParams{
       TenantID:            tenantID,
       CloudflareMeetingID: "cf-abc123",
       Name:                "CS101 Lecture",
       Config:              marshal(config),
     })
     ← Returns Room with generated ID

   ↓ Store room state in Redis:
     roomState.SetActive(roomID, RoomStateData{
       ParticipantCount: 0,
       Status: "active",
     })

   ↓ Broadcast via WebSocket:
     wsHub.BroadcastToTenant(tenantID, {
       event: "room.created",
       data: room,
     })

   ↓ Create audit log:
     queries.CreateAuditLog(ctx, CreateAuditLogParams{
       TenantID:     tenantID,
       RoomID:       roomID,
       Action:       "room.created",
       ResourceType: "room",
     })

5. Response
   {
     "id": "abc123-...",
     "tenant_id": "550e8400-...",
     "cloudflare_meeting_id": "cf-abc123",
     "name": "CS101 Lecture",
     "status": "active",
     "config": { "recording_enabled": true },
     "created_at": "2026-01-06T10:30:00Z"
   }
```

**Key Points:**
- Multi-step orchestration (Cloudflare → DB → Redis → WebSocket)
- Tenant limit validation (business rule)
- Real-time notification via WebSocket
- Audit trail for compliance

---

## Flow 4: Add Participant to Room

**Request:**
```http
POST /api/v1/rooms/abc123/participants
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
  "external_user_id": "student-42",
  "display_name": "Alice Johnson",
  "role": "participant"
}
```

**Code Flow:**

```
1. router.go:130
   ↓ roomsGroup.POST("/:id/participants", participants.Add)

2. middleware/auth.go → RequireJWT()
   ↓ Validate token
   ↓ Extract claims

3. handlers/participants.go → Add()
   ↓ Extract room ID from URL params: c.Param("id")
   ↓ Parse request body
   ↓ Call participantService.AddParticipant()

4. domain/participant/service.go → AddParticipant()
   ↓ Validate room exists and is active:
     queries.GetRoom(ctx, roomID)
     if room.Status != "active" → error

   ↓ Check room participant limit:
     queries.CountActiveParticipantsByRoom(roomID)
     if count >= room.MaxParticipants → error

   ↓ Create participant in Cloudflare:
     cfClient.AddParticipant(ctx, AddParticipantRequest{
       MeetingID:   room.CloudflareMeetingID,
       DisplayName: "Alice Johnson",
     })
     ← Returns { participantID: "cf-p-xyz" }

   ↓ Generate participant JWT token:
     jwtService.GenerateToken(JWTClaims{
       TenantID:    tenantID,
       RoomID:      roomID,
       ParticipantID: participantID,
       DisplayName: "Alice Johnson",
       Role:       "participant",
     })

   ↓ Save to database:
     queries.CreateParticipant(ctx, CreateParticipantParams{
       RoomID:                  roomID,
       CloudflareParticipantID: "cf-p-xyz",
       ExternalUserID:          "student-42",
       DisplayName:             "Alice Johnson",
       Role:                    "participant",
       JoinedAt:                now,
     })

   ↓ Update Redis room state:
     roomState.IncrementParticipantCount(roomID)

   ↓ Broadcast via WebSocket:
     wsHub.BroadcastToRoom(roomID, {
       event: "participant.joined",
       data: participant,
     })

   ↓ Audit log:
     queries.CreateAuditLog(ctx, {...})

5. Response
   {
     "id": "p-abc...",
     "room_id": "abc123",
     "external_user_id": "student-42",
     "display_name": "Alice Johnson",
     "role": "participant",
     "token": "eyJhbGciOiJIUzI1NiIs...",  ← New JWT for this participant
     "joined_at": "2026-01-06T10:35:00Z"
   }
```

**Key Points:**
- Returns participant-specific JWT token
- Real-time broadcast to all room participants
- Redis tracks live participant count
- Cloudflare integration for WebRTC

---

## Flow 5: Start Recording

**Request:**
```http
POST /api/v1/rooms/abc123/recordings/start
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Code Flow:**

```
1. router.go:136
   ↓ roomsGroup.POST("/:id/recordings/start", recordings.Start)

2. middleware/auth.go → RequireJWT()
   ↓ Validate token
   ↓ Check role == "host" (only hosts can record)

3. handlers/recordings.go → Start()
   ↓ Extract room ID
   ↓ Call recordingService.StartRecording()

4. domain/recording/service.go → StartRecording()
   ↓ Validate room exists and is active

   ↓ Check if already recording:
     queries.GetActiveRecordingByRoom(roomID)
     if exists → error "Already recording"

   ↓ Check tenant recording limits:
     queries.GetTotalRecordingStorageByTenant(tenantID)
     if exceeds limit → error

   ↓ Start recording in Cloudflare:
     cfClient.StartRecording(ctx, StartRecordingRequest{
       MeetingID: room.CloudflareMeetingID,
     })
     ← Returns { recordingID: "cf-rec-123" }

   ↓ Save to database:
     queries.CreateRecording(ctx, CreateRecordingParams{
       RoomID:                roomID,
       CloudflareRecordingID: "cf-rec-123",
       Status:                "recording",
       StartedAt:             now,
     })

   ↓ Update Redis:
     roomState.SetRecordingActive(roomID, true)

   ↓ Broadcast:
     wsHub.BroadcastToRoom(roomID, {
       event: "recording.started",
       data: recording,
     })

5. Response
   {
     "id": "rec-abc...",
     "room_id": "abc123",
     "status": "recording",
     "started_at": "2026-01-06T10:40:00Z"
   }
```

---

## Flow 6: WebSocket Real-Time Updates

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:8081/ws?token=eyJhbGciOiJIUzI1NiIs...');
```

**Code Flow:**

```
1. router.go:92
   ↓ r.engine.GET("/ws", wsHandler.HandleWebSocket)

2. handlers/websocket.go → HandleWebSocket()
   ↓ Extract token from query param: c.Query("token")
   ↓ Validate JWT: jwtService.ValidateToken(token)
   ↓ Upgrade HTTP to WebSocket
   ↓ Create WebSocket client

3. websocket/hub.go → Register()
   ↓ Store client in hub.clients map
   ↓ Subscribe to tenant channel in Redis
   ↓ Subscribe to room channels if room_id in token

4. Message Loop
   ↓ Client → Server messages:
     - Ping/Pong heartbeat
     - Room state queries

   ↓ Server → Client messages:
     - participant.joined
     - participant.left
     - recording.started
     - recording.stopped
     - room.ended
```

**Redis Pub/Sub:**
```
When room.Create() happens:
  wsHub.BroadcastToTenant(tenantID, message)
    ↓ redisClient.Publish("tenant:550e8400", message)

WebSocket hub subscribed to:
  - "tenant:{tenant_id}"     ← All tenant events
  - "room:{room_id}"         ← Specific room events

All connected clients receive real-time updates
```

---

## Flow 7: Cloudflare Webhook (Recording Ready)

**Cloudflare sends webhook when recording finishes processing:**

```http
POST /api/v1/webhooks/cloudflare/recording
Content-Type: application/json
X-Cloudflare-Signature: abc123...

{
  "recording_id": "cf-rec-123",
  "status": "ready",
  "url": "https://cloudflare.com/recordings/cf-rec-123.mp4",
  "size_bytes": 1048576,
  "duration_seconds": 3600
}
```

**Code Flow:**

```
1. router.go:153
   ↓ v1.POST("/webhooks/cloudflare/recording", webhooks.HandleRecordingReady)

2. handlers/webhooks.go → HandleRecordingReady()
   ↓ Verify webhook signature (security)
   ↓ Parse webhook payload
   ↓ Call recordingService.HandleRecordingReady()

3. domain/recording/service.go → HandleRecordingReady()
   ↓ Find recording in database:
     queries.GetRecordingByCloudflareID("cf-rec-123")

   ↓ Download from Cloudflare to R2:
     storageR2.Upload(ctx, recordingID, cloudflareURL, "video/mp4")

   ↓ Update database:
     queries.CompleteRecording(ctx, CompleteRecordingParams{
       ID:              recordingID,
       StorageProvider: "r2",
       StoragePath:     "recordings/rec-abc.mp4",
       SizeBytes:       1048576,
       DurationSeconds: 3600,
       Status:          "ready",
     })

   ↓ Broadcast:
     wsHub.BroadcastToRoom(roomID, {
       event: "recording.ready",
       data: recording,
     })

   ↓ Schedule archival (R2 → S3 Glacier after 30 days):
     lifecycleManager will pick this up
```

---

## Flow 8: Download Recording

**Request:**
```http
GET /api/v1/recordings/rec-abc/download
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Code Flow:**

```
1. router.go:147
   ↓ recordingsGroup.GET("/:id/download", recordings.Download)

2. middleware/auth.go → RequireJWT()
   ↓ Validate token
   ↓ Check tenant_id matches recording's tenant

3. handlers/recordings.go → Download()
   ↓ Extract recording ID
   ↓ Call recordingService.GetDownloadURL()

4. domain/recording/service.go → GetDownloadURL()
   ↓ queries.GetRecording(ctx, recordingID)

   ↓ Check storage location:
     if recording.StorageProvider == "r2":
       storageR2.GetPresignedURL(recording.StoragePath, 1 hour)
     else if recording.StorageProvider == "s3_glacier":
       error "Archived, request restore first"

5. Response
   {
     "url": "https://r2.cloudflare.com/recordings/rec-abc.mp4?token=...",
     "expires_at": "2026-01-06T11:30:00Z"
   }
```

---

## Key Patterns Across All Flows

### 1. Middleware Chain
```
Request → CORS → Auth (JWT/API Key) → Handler → Service → Infrastructure
```

### 2. Context Propagation
```go
// Middleware stores data in context
c.Set("tenant_id", claims.TenantID)

// Handler retrieves it
tenantID := c.GetString("tenant_id")

// Passed to service
service.CreateRoom(ctx, tenantID, params)
```

### 3. Error Handling
```go
// Service returns error
if err != nil {
    return nil, fmt.Errorf("create room: %w", err)
}

// Handler translates to HTTP status
if errors.Is(err, ErrNotFound) {
    c.JSON(404, gin.H{"error": "Room not found"})
} else if errors.Is(err, ErrUnauthorized) {
    c.JSON(403, gin.H{"error": "Forbidden"})
} else {
    c.JSON(500, gin.H{"error": "Internal server error"})
}
```

### 4. Real-Time Updates
```go
// Any state change triggers WebSocket broadcast
wsHub.BroadcastToRoom(roomID, WebSocketMessage{
    Event: "participant.joined",
    Data:  participant,
})

// All connected clients receive immediately
```

### 5. Audit Trail
```go
// Every significant action logged
queries.CreateAuditLog(ctx, CreateAuditLogParams{
    TenantID:     tenantID,
    Action:       "room.created",
    ResourceType: "room",
    ResourceID:   roomID,
    Metadata:     marshal(details),
})
```

---

## Summary: Request Flow Layers

```
┌──────────────────────────────────────────────────┐
│ 1. HTTP Layer (Gin)                              │
│    - Route matching                              │
│    - Request parsing                             │
│    - Response formatting                         │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│ 2. Middleware                                    │
│    - Authentication (JWT/API Key)                │
│    - Authorization (role checks)                 │
│    - CORS                                        │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│ 3. Handlers                                      │
│    - Input validation                            │
│    - Context extraction                          │
│    - Service orchestration                       │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│ 4. Domain Services                               │
│    - Business logic                              │
│    - Multi-step orchestration                    │
│    - External API calls                          │
└────────────────┬─────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────┐
│ 5. Infrastructure                                │
│    - Database (sqlc queries)                     │
│    - Cloudflare API                              │
│    - Redis (state, pub/sub)                      │
│    - Storage (R2/S3)                             │
└──────────────────────────────────────────────────┘
```

Each layer has a specific responsibility - this is Clean Architecture in practice!
