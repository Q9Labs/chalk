# Critical Issues, Bugs & Missing Features - Chalk API

**Date**: January 6, 2026
**Analyst**: Deep-dive user story analysis for Tuition Highway & CollabEZ integrations
**Status**: 🚨 **MUST FIX BEFORE PRODUCTION**

---

## 🔴 P0 - BLOCKING ISSUES (Cannot ship without these)

### 1. **Webhook Security Vulnerability**
**File**: `apps/api/internal/interfaces/http/handlers/webhooks.go`

**Issue**: Cloudflare webhook endpoint has NO signature verification

```go
// Current (INSECURE):
func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
    // Anyone can POST to this endpoint and inject fake recording data!
    var payload WebhookPayload
    c.BindJSON(&payload)
    // ... process without verification
}
```

**Impact**:
- ❌ Attacker can POST fake "recording ready" events
- ❌ Could trigger malicious file downloads
- ❌ Could corrupt recording metadata in database

**Fix Needed**:
```go
func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
    // Verify X-Cloudflare-Signature header
    signature := c.GetHeader("X-Cloudflare-Signature")
    if !h.cfClient.VerifyWebhookSignature(c.Request.Body, signature) {
        c.JSON(401, gin.H{"error": "Invalid signature"})
        return
    }
    // ... process verified payload
}
```

**TODO**:
- [ ] Add signature verification logic to `cloudflare/client.go`
- [ ] Test with actual Cloudflare webhooks
- [ ] Document signature algorithm in README

---

### 2. **Recording Processing Timeout (No Failure Handling)**
**File**: `apps/api/internal/domain/recording/service.go`

**Issue**: If Cloudflare webhook never arrives, recording stuck in "processing" forever

**Scenario**:
1. Recording stops → status="processing"
2. Cloudflare processes video (5-15 min)
3. **Webhook fails to deliver** (network issue, Cloudflare bug)
4. Recording stuck in "processing" **FOREVER**

**Impact**:
- ❌ Users can't access recording
- ❌ No error shown to user
- ❌ No retry mechanism
- ❌ No alerts to admin

**Fix Needed**:
```go
// Add cron job (runs every 30 minutes):
func (s *Service) CheckStalledRecordings(ctx context.Context) {
    // Find recordings in "processing" for > 1 hour
    stalled, _ := s.queries.ListStalledRecordings(ctx, 1*time.Hour)

    for _, recording := range stalled {
        // Poll Cloudflare API for status
        status, err := s.cfClient.GetRecordingStatus(ctx, recording.CloudflareRecordingID)

        if err != nil || status == "failed" {
            // Mark as failed, alert admin
            s.queries.MarkRecordingFailed(ctx, recording.ID)
            s.alertAdmin(recording)
        } else if status == "ready" {
            // Webhook missed, process now
            s.HandleRecordingReady(ctx, recording.ID, status)
        }
    }
}
```

**TODO**:
- [ ] Add `ListStalledRecordings` SQL query
- [ ] Add `MarkRecordingFailed` SQL query
- [ ] Add polling fallback in lifecycle manager
- [ ] Add admin alerting (email/Slack)
- [ ] Add "status" field to recordings enum: `'failed'`

---

### 3. **No Duplicate Participant Handling**
**File**: `apps/api/internal/domain/participant/service.go → AddParticipant()`

**Issue**: Same user can join room multiple times (multi-device OR duplicate clicks)

**Scenario**:
1. Alice joins from laptop → participant-1
2. Alice joins from phone → participant-2 (DUPLICATE!)
3. Room shows 2x "Alice Johnson"
4. Participant count wrong
5. Recording shows duplicate participants

**Current Code**:
```go
// No check for existing participant!
func (s *Service) AddParticipant(ctx context.Context, roomID uuid.UUID, params AddParticipantParams) (*Participant, error) {
    // Just creates new participant every time
    participant, err := s.queries.CreateParticipant(ctx, ...)
    return participant, err
}
```

**Fix Needed**:
```go
func (s *Service) AddParticipant(ctx context.Context, roomID uuid.UUID, params AddParticipantParams) (*Participant, error) {
    // Check if external_user_id already in this room
    existing, err := s.queries.GetParticipantByExternalUserAndRoom(ctx, GetParticipantByExternalUserAndRoomParams{
        ExternalUserID: params.ExternalUserID,
        RoomID:         roomID,
    })

    if err == nil && existing.LeftAt == nil {
        // Participant already active in room
        // Option A: Return existing participant + token (allow multi-device)
        newToken, _ := s.jwtService.GenerateToken(...)
        existing.Token = newToken
        return existing, nil

        // OR Option B: Reject duplicate
        return nil, ErrAlreadyInRoom
    }

    // Create new participant
    participant, err := s.queries.CreateParticipant(ctx, ...)
    return participant, err
}
```

**TODO**:
- [ ] **DECISION REQUIRED**: Allow multi-device (Option A) or block (Option B)?
- [ ] Implement chosen option
- [ ] Update API docs with behavior
- [ ] Test: Join from 2 devices simultaneously

---

### 4. **JWT Token Expires During Long Meetings**
**File**: `apps/api/internal/infrastructure/auth/jwt.go`

**Issue**: Tokens expire after 15 minutes, but meetings can last hours

**Scenario**:
1. User joins meeting with JWT token
2. Meeting lasts 2 hours
3. After 15 minutes, token expires
4. **WebSocket disconnects** (can't authenticate)
5. **API calls fail** (401 Unauthorized)
6. User kicked out of meeting

**Current Code**:
```go
// Hardcoded 15 minute expiry
ExpiresAt: time.Now().Add(15 * time.Minute)
```

**Impact**:
- ❌ Users disconnected from long meetings
- ❌ Poor UX (must rejoin manually)
- ❌ Recordings interrupted

**Fix Needed**:

**Option A**: Longer token expiry (simple but less secure)
```go
ExpiresAt: time.Now().Add(4 * time.Hour)  // Longer meetings
```

**Option B**: Auto-refresh in SDK (better, already partially implemented)
```typescript
// In @q9labs/chalk-react SDK
useEffect(() => {
    const refreshInterval = setInterval(() => {
        // Refresh token 5 min before expiry
        if (tokenExpiresIn < 5 * 60) {
            refreshToken()
        }
    }, 60 * 1000)  // Check every minute

    return () => clearInterval(refreshInterval)
}, [])
```

**Option C**: WebSocket-based refresh (best)
- Server sends "token_expiring_soon" event 5 min before expiry
- Client auto-refreshes via `/api/v1/auth/refresh`

**TODO**:
- [ ] **CHECK SDK**: Does auto-refresh exist in @q9labs/chalk-react?
- [ ] If not, implement Option B or C
- [ ] Test with 2-hour meeting
- [ ] Document token refresh behavior

---

### 5. **No Recording Access Audit Logs (GDPR Violation)**
**File**: `apps/api/internal/interfaces/http/handlers/recordings.go → Download()`

**Issue**: No audit log when someone downloads a recording

**GDPR Requirement**:
> Organizations must log who accessed personal data (video recordings), when, and why.

**Current Code**:
```go
func (h *RecordingHandler) Download(c *gin.Context) {
    recordingID := c.Param("id")
    recording, _ := h.service.GetRecording(ctx, recordingID)

    url, _ := h.service.GetDownloadURL(ctx, recording)

    c.JSON(200, gin.H{"url": url})
    // ❌ NO AUDIT LOG!
}
```

**Impact**:
- ❌ GDPR compliance failure
- ❌ Can't track who accessed recordings
- ❌ Security risk (no forensics if leak)

**Fix Needed**:
```go
func (h *RecordingHandler) Download(c *gin.Context) {
    recordingID := c.Param("id")
    tenantID := c.GetString("tenant_id")
    userID := c.GetString("user_id")  // From JWT claims

    recording, _ := h.service.GetRecording(ctx, recordingID)
    url, _ := h.service.GetDownloadURL(ctx, recording)

    // ✅ CREATE AUDIT LOG
    h.queries.CreateAuditLog(ctx, db.CreateAuditLogParams{
        TenantID:     pgtype.UUID{Bytes: tenantID, Valid: true},
        RoomID:       pgtype.UUID{Bytes: recording.RoomID, Valid: true},
        ActorID:      &userID,
        Action:       "recording.downloaded",
        ResourceType: stringPtr("recording"),
        ResourceID:   pgtype.UUID{Bytes: recordingID, Valid: true},
        IpAddress:    ipAddrPtr(c.ClientIP()),
        Metadata:     jsonMarshal(map[string]interface{}{
            "recording_id": recordingID,
            "file_size":    recording.SizeBytes,
            "duration":     recording.DurationSeconds,
        }),
    })

    c.JSON(200, gin.H{"url": url})
}
```

**TODO**:
- [ ] Add audit log to Download handler
- [ ] Add audit log to Get handler (viewing metadata)
- [ ] Add audit log to List handler (browsing recordings)
- [ ] Test GDPR compliance with legal team

---

### 6. **Recording Delete: Soft or Hard?**
**File**: `apps/api/internal/interfaces/http/handlers/recordings.go → Delete()`

**Issue**: Unclear if DELETE removes from storage (GDPR requires hard delete)

**Need to check**:
```go
func (h *RecordingHandler) Delete(c *gin.Context) {
    // Does this:
    // A) Mark as deleted in DB (soft delete) - NOT GDPR compliant
    // B) Delete from R2/S3 storage (hard delete) - GDPR compliant
    // ???
}
```

**GDPR Requirement**:
> Right to deletion: User requests deletion → must delete from ALL systems (DB + storage)

**TODO**:
- [ ] **CHECK CODE**: Read the actual Delete implementation
- [ ] If soft delete, change to hard delete
- [ ] Ensure R2 + S3 files deleted
- [ ] Add audit log: "recording.deleted"
- [ ] Test: Verify file gone from storage after delete

---

## 🟠 P1 - CRITICAL (Ship blocker for specific use cases)

### 7. **Bulk Participant Add API Missing**
**Impact**: All-hands meetings with 150+ people fail

**Scenario** (CollabEZ):
1. CEO starts all-hands meeting
2. System tries to add 150 employees
3. **150 sequential API calls** to `/api/v1/rooms/:id/participants`
4. Takes 30+ seconds
5. Rate limiting might trigger
6. Poor user experience

**Fix Needed**:
```go
// New endpoint: POST /api/v1/rooms/:id/participants/bulk
type BulkAddParticipantsRequest struct {
    Participants []struct {
        ExternalUserID string `json:"external_user_id"`
        DisplayName    string `json:"display_name"`
        Role           string `json:"role"`
    } `json:"participants"`
}

type BulkAddParticipantsResponse struct {
    Participants []struct {
        ID    string `json:"id"`
        Token string `json:"token"`
    } `json:"participants"`
    Errors []struct {
        ExternalUserID string `json:"external_user_id"`
        Error          string `json:"error"`
    } `json:"errors"`  // Partial success handling
}
```

**TODO**:
- [ ] Add bulk endpoint to router
- [ ] Implement handler with transaction
- [ ] Add rate limiting (max 200 per request)
- [ ] Test with 150 simultaneous adds
- [ ] Update OpenAPI spec

---

### 8. **Empty Room Auto-Cleanup Missing**
**Impact**: Wasted tenant room quota

**Scenario** (CollabEZ):
1. System creates standup room at 8:55 AM
2. Team forgot about standup (happens!)
3. Room stays "active" with 0 participants
4. **Wastes 1 of 100 room quota**
5. Eventually tenant hits limit due to ghost rooms

**Fix Needed**:
```go
// Lifecycle manager checks every 10 minutes
func (m *LifecycleManager) CleanupEmptyRooms(ctx context.Context) {
    // Find active rooms with 0 participants for > 30 min
    emptyRooms, _ := m.queries.ListEmptyActiveRooms(ctx, 30*time.Minute)

    for _, room := range emptyRooms {
        // Auto-end room
        m.roomService.EndRoom(ctx, room.ID)

        // Audit log
        m.queries.CreateAuditLog(ctx, CreateAuditLogParams{
            Action: "room.auto_ended_empty",
            RoomID: room.ID,
        })
    }
}
```

**TODO**:
- [ ] Add `ListEmptyActiveRooms` SQL query (JOIN with participants, COUNT)
- [ ] Add cleanup to lifecycle manager
- [ ] Make timeout configurable (tenant-level)
- [ ] Test: Create room, don't join, verify auto-end

---

### 9. **No Data Region Configuration (GDPR)**
**Impact**: EU customers can't ensure EU data residency

**Issue**:
- Cloudflare RealtimeKit: Which region?
- R2 storage: Which region?
- S3 storage: Which region?
- **No way to configure!**

**GDPR Requirement**:
> EU citizen data must stay in EU

**Fix Needed**:
```go
// Add to tenant table:
type Tenant struct {
    // ... existing fields
    DataRegion string  // "eu" or "us"
}

// Pass to Cloudflare API
cfClient.CreateMeeting(ctx, CreateMeetingRequest{
    Name:   "My Room",
    Region: tenant.DataRegion,  // "eu"
})

// Pass to storage clients
r2Client := storage.NewR2Client(storage.R2Config{
    Region:     tenant.DataRegion,  // "eu"
    BucketName: fmt.Sprintf("chalk-recordings-%s", tenant.DataRegion),
})
```

**TODO**:
- [ ] Add `data_region` to tenants table migration
- [ ] Update CreateTenant to accept region
- [ ] Pass region to Cloudflare API
- [ ] Create separate R2 buckets per region
- [ ] Create separate S3 buckets per region
- [ ] Update docs with regional endpoints

---

### 10. **No Recording Retention Policy**
**Impact**: Storage costs explode, GDPR compliance issues

**Issue**:
- Recordings never auto-delete
- Storage costs grow forever
- GDPR: "Data minimization" - don't keep data longer than needed

**Tenant wants**:
- Auto-delete after 90 days (company policy)
- Archive to Glacier after 30 days
- Permanent delete after 90 days

**Fix Needed**:
```go
// Add to tenant table:
type Tenant struct {
    // ... existing
    RecordingRetentionDays int32  // Default: 90
}

// Lifecycle manager job (daily):
func (m *LifecycleManager) EnforceRetentionPolicy(ctx context.Context) {
    tenants, _ := m.queries.ListTenants(ctx)

    for _, tenant := range tenants {
        cutoffDate := time.Now().AddDate(0, 0, -int(tenant.RecordingRetentionDays))

        // Find recordings older than retention period
        oldRecordings, _ := m.queries.ListRecordingsOlderThan(ctx, tenant.ID, cutoffDate)

        for _, recording := range oldRecordings {
            // Delete from storage (R2/S3)
            m.storage.Delete(ctx, recording.StoragePath)

            // Hard delete from database
            m.queries.DeleteRecording(ctx, recording.ID)

            // Audit log
            m.queries.CreateAuditLog(ctx, CreateAuditLogParams{
                Action: "recording.auto_deleted_retention_policy",
            })
        }
    }
}
```

**TODO**:
- [ ] Add `recording_retention_days` to tenants table
- [ ] Add `ListRecordingsOlderThan` SQL query
- [ ] Implement daily retention job
- [ ] Test: Create old recording, verify deletion
- [ ] Add admin override (preserve specific recordings)

---

## 🟡 P2 - IMPORTANT (Should fix before production)

### 11. **JWT Tokens in URL (Security Risk)**
**Impact**: Token leakage in logs, browser history, analytics

**Current**: Guest join links
```
https://collabez.com/join/room-xyz?token=eyJhbGciOiJIUzI1NiIs...
```

**Problems**:
- ❌ Token visible in browser address bar
- ❌ Saved in browser history
- ❌ Logged by proxy servers, CDNs
- ❌ Sent to analytics (Google Analytics, etc.)
- ❌ If leaked, anyone can join room

**Fix**: One-time join codes
```
https://collabez.com/join/ABC-DEF-GHI

Frontend:
  POST /api/v1/join-codes/ABC-DEF-GHI/exchange
  ← { "token": "eyJ..." }  // Use token in memory only

Backend:
  - Codes single-use (deleted after exchange)
  - Codes expire after 24 hours
  - Codes tied to specific room + participant
```

**TODO**:
- [ ] Create `join_codes` table
- [ ] Add `GenerateJoinCode` API
- [ ] Add `ExchangeJoinCode` API
- [ ] Update SDK to use codes instead of tokens
- [ ] Migrate existing integrations

---

### 12. **No Rate Limiting Documentation**
**Impact**: Unknown API limits, might fail at scale

**Questions**:
- How many API calls per second per tenant?
- How many concurrent rooms per tenant?
- How many participants can join in 1 minute?
- What's the Cloudflare RealtimeKit limit?

**Needed**:
- Document all rate limits
- Add rate limit headers to responses:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 73
  X-RateLimit-Reset: 1641484800
  ```
- Return 429 Too Many Requests when exceeded

**TODO**:
- [ ] Add rate limiting middleware
- [ ] Document limits in API docs
- [ ] Test: Trigger rate limits intentionally
- [ ] Add backoff logic to SDK

---

### 13. **Auto-Start Recording Not Implemented**
**Impact**: Tutors must manually start recording (extra step)

**User Story** (Tuition Highway):
> When creating room with `"recording_enabled": true`, automatically start recording when host joins

**Current**:
```go
// Room created with config:
{ "recording_enabled": true }

// But recording doesn't start automatically!
// Host must click "Start Recording" button
```

**Fix**:
```go
func (s *Service) AddParticipant(ctx context.Context, roomID, params) {
    // ... create participant

    // If first host joining + recording_enabled = true
    if participant.Role == "host" {
        room, _ := s.queries.GetRoom(ctx, roomID)

        var config RoomConfig
        json.Unmarshal(room.Config, &config)

        if config.RecordingEnabled {
            // Auto-start recording
            s.recordingService.StartRecording(ctx, roomID)
        }
    }
}
```

**TODO**:
- [ ] Implement auto-start logic
- [ ] Test: Create room with flag, join as host, verify recording starts
- [ ] Add config option to disable auto-start

---

## 📋 Complete Bugs & Missing Features Summary

| Priority | Issue | Impact | Effort | Status |
|----------|-------|--------|--------|--------|
| P0 | Webhook signature verification | Security | 2 days | ❌ Not started |
| P0 | Recording processing timeout | Data loss | 3 days | ❌ Not started |
| P0 | Duplicate participant handling | Data integrity | 1 day | ❌ Not started |
| P0 | JWT token expiry in meetings | UX blocker | 2 days | ⚠️ Partial (refresh exists?) |
| P0 | Recording access audit logs | GDPR | 1 day | ❌ Not started |
| P0 | Recording hard delete | GDPR | 2 days | ❓ Need to check |
| P1 | Bulk participant add API | Scale blocker | 3 days | ❌ Not started |
| P1 | Empty room cleanup | Resource waste | 2 days | ❌ Not started |
| P1 | Data region configuration | GDPR | 4 days | ❌ Not started |
| P1 | Recording retention policy | Storage cost | 3 days | ❌ Not started |
| P2 | JWT in URL security | Security | 3 days | ❌ Not started |
| P2 | Rate limiting docs | Stability | 2 days | ❌ Not started |
| P2 | Auto-start recording | UX | 1 day | ❌ Not started |

**Total Estimated Effort**: ~30 days (1 month for solo dev)

---

## 🎯 Recommended Action Plan

### Week 1: P0 Security & Compliance
- [ ] Day 1-2: Webhook signature verification
- [ ] Day 3: Recording access audit logs
- [ ] Day 4-5: Recording hard delete + GDPR testing

### Week 2: P0 Stability & UX
- [ ] Day 1-2: Recording processing timeout + polling fallback
- [ ] Day 3: Duplicate participant handling
- [ ] Day 4-5: JWT token auto-refresh (verify SDK or implement)

### Week 3: P1 Scale & Compliance
- [ ] Day 1-2: Bulk participant add API
- [ ] Day 3: Empty room cleanup
- [ ] Day 4-5: Data region configuration (Cloudflare + storage)

### Week 4: P1 Storage & P2 Polish
- [ ] Day 1-2: Recording retention policy
- [ ] Day 3: Auto-start recording
- [ ] Day 4-5: Rate limiting + documentation

---

## 🚀 Ship Strategy

**Option A: Ship MVP, iterate fast**
- Fix P0 issues only (2 weeks)
- Ship to Tuition Highway with limited features
- Fix P1/P2 based on real usage

**Option B: Ship production-ready (recommended)**
- Fix P0 + P1 (3-4 weeks)
- Ship to both companies with confidence
- P2 issues in next sprint

**Option C: Ship perfect product**
- Fix everything (1 month)
- Risk: Delays, feature creep
- Benefit: Zero tech debt

**RECOMMENDATION**: **Option B** - Fix critical issues, ship solid foundation, iterate on feedback.
