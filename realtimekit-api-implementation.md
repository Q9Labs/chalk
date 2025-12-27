# Cloudflare RealtimeKit API Implementation

Go backend implementation for Cloudflare RealtimeKit integration.

---

## Cloudflare RealtimeKit Overview

**RealtimeKit** is a programmable communication platform built on **Dyte** that enables live video, voice, and interactive streaming.

- **Base URL:** `https://api.cloudflare.com/client/v4/accounts/{account_id}/realtime/kit/`
- **Auth:** Bearer token via `Authorization: Bearer <API_TOKEN>`
- **Compliance:** SOC 2, HIPAA, GDPR

---

## API Integration Details

### Endpoint Mapping (Chalk API → RealtimeKit API)

| Chalk API | RealtimeKit API | Purpose |
|-----------|-----------------|---------|
| `POST /rooms` | `POST /{app_id}/meetings` | Create meeting |
| `GET /rooms/:id` | `GET /{app_id}/meetings/{meeting_id}` | Get meeting details |
| `DELETE /rooms/:id` | `PATCH /{app_id}/meetings/{meeting_id}` (status: ENDED) | End meeting |
| `POST /rooms/:id/participants` | `POST /{app_id}/meetings/{meeting_id}/participants` | Add participant, get authToken |
| `DELETE /rooms/:id/participants/:pid` | `DELETE /{app_id}/meetings/{meeting_id}/participants/{participant_id}` | Remove participant |
| `POST /rooms/:id/participants/:pid/token` | `POST /{app_id}/meetings/{meeting_id}/participants/{participant_id}/token` | Refresh token |
| `POST /rooms/:id/recordings/start` | `POST /{app_id}/recordings` | Start recording |
| `POST /rooms/:id/recordings/stop` | `PUT /{app_id}/recordings/{recording_id}` (action: STOP) | Stop recording |

### Create Meeting API

```
POST /accounts/{account_id}/realtime/kit/{app_id}/meetings
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

Request:
{
  "title": "Room Name",
  "record_on_start": false,
  "persist_chat": true,
  "recording_config": {
    "codec": "H264",
    "audio_codec": "OPUS",
    "storage": "S3",
    "s3_bucket": "chalk-recordings",
    "s3_region": "us-east-1"
  }
}

Response (200):
{
  "success": true,
  "data": {
    "id": "meeting_uuid",
    "created_at": "2024-01-01T00:00:00Z",
    "status": "ACTIVE",
    "title": "Room Name"
  }
}
```

### Add Participant API

```
POST /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/participants
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

Request:
{
  "name": "John Doe",
  "preset_name": "group_call_host",  // or "group_call_participant"
  "client_specific_id": "user_external_id"
}

Response (200) - Contains authToken for SDK:
{
  "success": true,
  "data": {
    "id": "participant_uuid",
    "name": "John Doe",
    "preset_name": "group_call_host",
    "client_specific_id": "user_external_id",
    "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Important:** The `token` field from this response is the **authToken** required to initialize the client SDK.

---

## Go Backend Implementation

### 1. Cloudflare Client (infrastructure/cloudflare/client.go)

```go
package cloudflare

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

type Client struct {
    httpClient *http.Client
    baseURL    string
    accountID  string
    appID      string
    apiToken   string
}

type Config struct {
    AccountID string
    AppID     string
    APIToken  string
}

func NewClient(cfg Config) *Client {
    return &Client{
        httpClient: &http.Client{Timeout: 30 * time.Second},
        baseURL:    "https://api.cloudflare.com/client/v4",
        accountID:  cfg.AccountID,
        appID:      cfg.AppID,
        apiToken:   cfg.APIToken,
    }
}

func (c *Client) endpoint(path string) string {
    return fmt.Sprintf("%s/accounts/%s/realtime/kit/%s%s",
        c.baseURL, c.accountID, c.appID, path)
}

// CreateMeeting creates a new meeting in Cloudflare RealtimeKit
func (c *Client) CreateMeeting(ctx context.Context, req CreateMeetingRequest) (*Meeting, error) {
    body, _ := json.Marshal(req)
    httpReq, _ := http.NewRequestWithContext(ctx, "POST", c.endpoint("/meetings"), bytes.NewReader(body))
    httpReq.Header.Set("Authorization", "Bearer "+c.apiToken)
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("cloudflare request failed: %w", err)
    }
    defer resp.Body.Close()

    var result CloudflareResponse[Meeting]
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decode response: %w", err)
    }

    if !result.Success {
        return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
    }
    return &result.Data, nil
}

// AddParticipant adds a participant and returns authToken for client SDK
func (c *Client) AddParticipant(ctx context.Context, meetingID string, req AddParticipantRequest) (*Participant, error) {
    body, _ := json.Marshal(req)
    path := fmt.Sprintf("/meetings/%s/participants", meetingID)
    httpReq, _ := http.NewRequestWithContext(ctx, "POST", c.endpoint(path), bytes.NewReader(body))
    httpReq.Header.Set("Authorization", "Bearer "+c.apiToken)
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := c.httpClient.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("cloudflare request failed: %w", err)
    }
    defer resp.Body.Close()

    var result CloudflareResponse[Participant]
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decode response: %w", err)
    }

    if !result.Success {
        return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
    }
    return &result.Data, nil
}

// Types

type CloudflareResponse[T any] struct {
    Success bool   `json:"success"`
    Data    T      `json:"data"`
    Errors  []struct {
        Code    string `json:"code"`
        Message string `json:"message"`
    } `json:"errors,omitempty"`
}

type CreateMeetingRequest struct {
    Title           string `json:"title"`
    RecordOnStart   bool   `json:"record_on_start"`
    PersistChat     bool   `json:"persist_chat"`
    RecordingConfig struct {
        Codec      string `json:"codec"`
        AudioCodec string `json:"audio_codec"`
        Storage    string `json:"storage"`
        S3Bucket   string `json:"s3_bucket"`
        S3Region   string `json:"s3_region"`
    } `json:"recording_config,omitempty"`
}

type Meeting struct {
    ID        string    `json:"id"`
    CreatedAt time.Time `json:"created_at"`
    UpdatedAt time.Time `json:"updated_at"`
    Status    string    `json:"status"` // ACTIVE, ENDED
    Title     string    `json:"title"`
}

type AddParticipantRequest struct {
    Name             string `json:"name"`
    PresetName       string `json:"preset_name"`
    ClientSpecificID string `json:"client_specific_id"`
}

type Participant struct {
    ID               string `json:"id"`
    Name             string `json:"name"`
    PresetName       string `json:"preset_name"`
    ClientSpecificID string `json:"client_specific_id"`
    Token            string `json:"token"` // AuthToken for SDK
}
```

### 2. Domain Types (domain/room.go)

```go
package domain

import "time"

type Room struct {
    ID                  string     `json:"id"`
    TenantID            string     `json:"tenant_id"`
    CloudflareMeetingID string     `json:"cloudflare_meeting_id"`
    Name                string     `json:"name"`
    Status              RoomStatus `json:"status"`
    Config              RoomConfig `json:"config"`
    StartedAt           *time.Time `json:"started_at,omitempty"`
    EndedAt             *time.Time `json:"ended_at,omitempty"`
    CreatedAt           time.Time  `json:"created_at"`
}

type RoomStatus string

const (
    RoomStatusActive RoomStatus = "active"
    RoomStatusEnded  RoomStatus = "ended"
)

type RoomConfig struct {
    MaxParticipants  int  `json:"max_participants"`
    RecordingEnabled bool `json:"recording_enabled"`
    ChatEnabled      bool `json:"chat_enabled"`
}

type Participant struct {
    ID                      string          `json:"id"`
    RoomID                  string          `json:"room_id"`
    CloudflareParticipantID string          `json:"cloudflare_participant_id"`
    ExternalUserID          string          `json:"external_user_id,omitempty"`
    DisplayName             string          `json:"display_name"`
    Role                    ParticipantRole `json:"role"`
    JoinedAt                *time.Time      `json:"joined_at,omitempty"`
    LeftAt                  *time.Time      `json:"left_at,omitempty"`
}

type ParticipantRole string

const (
    RoleHost        ParticipantRole = "host"
    RoleParticipant ParticipantRole = "participant"
)
```

### 3. Use Case Layer (usecase/room.go)

```go
package usecase

import (
    "context"
    "fmt"
    "time"

    "chalk/internal/domain"
    "chalk/internal/infrastructure/cloudflare"
    "github.com/google/uuid"
)

type RoomUseCase struct {
    cfClient          *cloudflare.Client
    roomRepo          domain.RoomRepository
    participantRepo   domain.ParticipantRepository
    jwtService        *JWTService
}

type CreateRoomInput struct {
    TenantID string
    Name     string
    Config   domain.RoomConfig
}

type CreateRoomOutput struct {
    Room *domain.Room
}

func (uc *RoomUseCase) CreateRoom(ctx context.Context, input CreateRoomInput) (*CreateRoomOutput, error) {
    // 1. Create meeting in Cloudflare
    cfMeeting, err := uc.cfClient.CreateMeeting(ctx, cloudflare.CreateMeetingRequest{
        Title:         input.Name,
        RecordOnStart: false,
        PersistChat:   input.Config.ChatEnabled,
    })
    if err != nil {
        return nil, fmt.Errorf("create cloudflare meeting: %w", err)
    }

    // 2. Store room in database
    room := &domain.Room{
        ID:                  uuid.New().String(),
        TenantID:            input.TenantID,
        CloudflareMeetingID: cfMeeting.ID,
        Name:                input.Name,
        Status:              domain.RoomStatusActive,
        Config:              input.Config,
        CreatedAt:           time.Now(),
    }

    if err := uc.roomRepo.Create(ctx, room); err != nil {
        return nil, fmt.Errorf("store room: %w", err)
    }

    return &CreateRoomOutput{Room: room}, nil
}

type JoinRoomInput struct {
    RoomID         string
    ExternalUserID string
    DisplayName    string
    Role           domain.ParticipantRole
}

type JoinRoomOutput struct {
    Participant *domain.Participant
    ChalkJWT    string // JWT for Chalk WebSocket
    AuthToken   string // Cloudflare authToken for SDK
}

func (uc *RoomUseCase) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
    // 1. Get room
    room, err := uc.roomRepo.GetByID(ctx, input.RoomID)
    if err != nil {
        return nil, fmt.Errorf("get room: %w", err)
    }

    // 2. Map role to Cloudflare preset
    presetName := "group_call_participant"
    if input.Role == domain.RoleHost {
        presetName = "group_call_host"
    }

    // 3. Add participant to Cloudflare
    cfParticipant, err := uc.cfClient.AddParticipant(ctx, room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
        Name:             input.DisplayName,
        PresetName:       presetName,
        ClientSpecificID: input.ExternalUserID,
    })
    if err != nil {
        return nil, fmt.Errorf("add cloudflare participant: %w", err)
    }

    // 4. Store participant in database
    participant := &domain.Participant{
        ID:                      uuid.New().String(),
        RoomID:                  room.ID,
        CloudflareParticipantID: cfParticipant.ID,
        ExternalUserID:          input.ExternalUserID,
        DisplayName:             input.DisplayName,
        Role:                    input.Role,
    }

    if err := uc.participantRepo.Create(ctx, participant); err != nil {
        return nil, fmt.Errorf("store participant: %w", err)
    }

    // 5. Generate Chalk JWT (wraps Cloudflare token)
    chalkJWT, err := uc.jwtService.GenerateParticipantToken(participant, cfParticipant.Token)
    if err != nil {
        return nil, fmt.Errorf("generate jwt: %w", err)
    }

    return &JoinRoomOutput{
        Participant: participant,
        ChalkJWT:    chalkJWT,
        AuthToken:   cfParticipant.Token, // Direct Cloudflare token for SDK
    }, nil
}
```

### 4. HTTP Handler (interfaces/http/room_handler.go)

```go
package http

import (
    "github.com/gin-gonic/gin"
    "chalk/internal/domain"
    "chalk/internal/usecase"
)

type RoomHandler struct {
    roomUC *usecase.RoomUseCase
}

func (h *RoomHandler) CreateRoom(c *gin.Context) {
    var req CreateRoomRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }

    tenantID := c.GetString("tenant_id") // From auth middleware

    output, err := h.roomUC.CreateRoom(c.Request.Context(), usecase.CreateRoomInput{
        TenantID: tenantID,
        Name:     req.Name,
        Config: domain.RoomConfig{
            MaxParticipants:  req.Config.MaxParticipants,
            RecordingEnabled: req.Config.RecordingEnabled,
            ChatEnabled:      req.Config.ChatEnabled,
        },
    })
    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    c.JSON(201, output.Room)
}

func (h *RoomHandler) JoinRoom(c *gin.Context) {
    roomID := c.Param("id")
    var req JoinRoomRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }

    role := domain.RoleParticipant
    if req.Role == "host" {
        role = domain.RoleHost
    }

    output, err := h.roomUC.JoinRoom(c.Request.Context(), usecase.JoinRoomInput{
        RoomID:         roomID,
        ExternalUserID: req.ExternalUserID,
        DisplayName:    req.DisplayName,
        Role:           role,
    })
    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    c.JSON(200, gin.H{
        "participant": output.Participant,
        "token":       output.ChalkJWT,
        "auth_token":  output.AuthToken, // For SDK initialization
    })
}

type CreateRoomRequest struct {
    Name   string `json:"name" binding:"required"`
    Config struct {
        MaxParticipants  int  `json:"max_participants"`
        RecordingEnabled bool `json:"recording_enabled"`
        ChatEnabled      bool `json:"chat_enabled"`
    } `json:"config"`
}

type JoinRoomRequest struct {
    ExternalUserID string `json:"external_user_id" binding:"required"`
    DisplayName    string `json:"display_name" binding:"required"`
    Role           string `json:"role" binding:"required,oneof=host participant"`
}
```

---

## Configuration & Environment

```bash
# Cloudflare RealtimeKit
CLOUDFLARE_ACCOUNT_ID=xxx          # Cloudflare Account ID
CLOUDFLARE_APP_ID=xxx              # RealtimeKit App ID (created in dashboard)
CLOUDFLARE_API_TOKEN=xxx           # Cloudflare API Token (from Cloudflare dashboard)

# Database
DATABASE_URL=postgres://user:pass@host:5432/chalk

# Redis
REDIS_URL=redis://host:6379

# JWT
JWT_SIGNING_KEY=xxx                # For signing Chalk JWTs
JWT_EXPIRY_MINUTES=60

# Server
PORT=8080
ENV=development
```

---

## Key Implementation Notes

### Authentication Flow

1. **Server-to-Server (Recommended):**
   - Consumer App Backend → Chalk API: `POST /rooms` (with API Key)
   - Chalk API → Cloudflare: Create meeting via `CreateMeeting()`
   - Consumer App Backend → Chalk API: `POST /rooms/:id/participants` (with API Key)
   - Chalk API → Cloudflare: Add participant via `AddParticipant()` → Get `token` (authToken)
   - Chalk API → Consumer Backend: Return Chalk JWT wrapping the authToken
   - Consumer Frontend receives Chalk JWT
   - SDK initializes with `authToken` extracted from JWT

### Preset Mapping

Map Chalk participant roles to Cloudflare RealtimeKit presets:
- Chalk `host` → Cloudflare `group_call_host` preset
- Chalk `participant` → Cloudflare `group_call_participant` preset

### Recording Storage

Configure in `CreateMeeting` request:
- **Hot Storage (0-7 days):** Cloudflare R2 or S3
- **Archive (7+ days):** S3 Glacier (configure lifecycle policies)

### Error Handling

All Cloudflare API responses have this structure:
```json
{
  "success": bool,
  "data": { /* ... */ },
  "errors": [ { "code": "...", "message": "..." } ]
}
```

Always check `success` field and handle error array appropriately.

---

## References

- [Cloudflare Realtime Docs](https://docs.realtime.cloudflare.com/)
- [RealtimeKit API Reference](https://developers.cloudflare.com/api/resources/realtime_kit/)
