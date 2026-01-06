# Business Logic Analysis - Chalk API

**Date**: January 6, 2026
**Goal**: Understand current implementation + identify bugs for 3-hour sprint

---

## 🎯 Architecture Summary

**Clean Architecture Pattern** (Domain-driven design):

```
Handler → Domain Service → Infrastructure
   ↓           ↓                ↓
Parse      Business         Database
Validate   Logic            Cloudflare
Format     Orchestration    Redis
                            Storage
```

**Dependency Injection**: Services receive interfaces, not concrete implementations.

---

## 📦 Room Service Analysis

### **What It Does**:
- Creates rooms (Cloudflare meeting + DB entry)
- Ends rooms (Cloudflare + DB + Redis cleanup)
- Lists/counts rooms by tenant
- Tracks participant count via queries

### **Current Flow**:

```go
CreateRoom:
  1. Call Cloudflare API → get meeting ID
  2. Insert to database with meeting ID
  3. Return room object

EndRoom:
  1. Lookup room in DB
  2. Call Cloudflare EndMeeting (ignores error)
  3. Update DB: status='ended', ended_at=NOW()
  4. Clear Redis room state
```

### **✅ What's Good**:
- Simple, focused responsibility
- Proper error wrapping
- Uses interfaces (mockable for testing)
- Redis is optional (nil checks)

### **❌ Critical Bugs**:

#### **BUG #1: No Tenant Limit Validation**
**File**: `room/service.go:60` (CreateRoom)

**Issue**: No check if tenant has reached `max_concurrent_rooms`

**Expected**:
```go
func (s *Service) CreateRoom(ctx context.Context, input CreateRoomInput) (*CreateRoomOutput, error) {
    // MISSING: Check tenant limits
    tenant, _ := s.db.GetTenant(ctx, input.TenantID)

    activeCount, _ := s.db.CountActiveRoomsByTenant(ctx, input.TenantID)
    if activeCount >= tenant.MaxConcurrentRooms {
        return nil, errors.New("tenant room limit reached")
    }

    // ... create room
}
```

**Impact**: Tenants can create unlimited rooms, bypass quota

---

#### **BUG #2: Cloudflare Failure Leaves Orphaned DB Entry**
**File**: `room/service.go:61-66`

**Issue**: If Cloudflare succeeds but DB insert fails, Cloudflare meeting orphaned

**Current**:
```go
cfMeeting, err := s.cfClient.CreateMeeting(ctx, ...)  // Succeeds
room, err := s.db.CreateRoom(ctx, ...)               // Fails
return nil, err  // Cloudflare meeting never cleaned up!
```

**Fix**: Rollback pattern
```go
cfMeeting, err := s.cfClient.CreateMeeting(ctx, ...)
if err != nil {
    return nil, fmt.Errorf("cloudflare failed: %w", err)
}

room, err := s.db.CreateRoom(ctx, ...)
if err != nil {
    // Rollback: Delete Cloudflare meeting
    _ = s.cfClient.EndMeeting(ctx, cfMeeting.ID)
    return nil, fmt.Errorf("database failed: %w", err)
}
```

**Impact**: Wasted Cloudflare resources, confused state

---

#### **BUG #3: EndRoom Silently Ignores Cloudflare Errors**
**File**: `room/service.go:147`

```go
_, _ = s.cfClient.EndMeeting(ctx, room.CloudflareMeetingID)  // ❌ Ignores error
```

**Issue**: If Cloudflare fails, DB shows "ended" but meeting still active

**Fix**: Log errors, don't ignore
```go
if err := s.cfClient.EndMeeting(ctx, room.CloudflareMeetingID); err != nil {
    log.Printf("Warning: Cloudflare end meeting failed: %v", err)
    // Continue anyway - DB is source of truth
}
```

---

#### **BUG #4: No WebSocket Broadcast on Room Events**
**File**: `room/service.go:60-83` (CreateRoom), `room/service.go:141-159` (EndRoom)

**Issue**: No WebSocket events for room lifecycle

**Missing**:
```go
// In CreateRoom:
if s.hub != nil {
    message := json.Marshal(map[string]interface{}{
        "event": "room.created",
        "room_id": room.ID,
        "tenant_id": input.TenantID,
    })
    s.hub.BroadcastToTenant(input.TenantID, message)
}

// In EndRoom:
if s.hub != nil {
    message := json.Marshal(map[string]interface{}{
        "event": "room.ended",
        "room_id": roomID,
    })
    s.hub.BroadcastToRoom(roomID, message, "")
}
```

**Impact**: Clients don't know when rooms created/ended in real-time

---

## 📦 Participant Service Analysis

### **What It Does**:
- Joins participants to rooms (Cloudflare + DB)
- Generates JWT tokens with Cloudflare auth token embedded
- Tracks participant metadata in Redis + WebSocket hub
- Handles leave, kick, token refresh

### **Current Flow**:

```go
JoinRoom:
  1. Validate room is active
  2. Call Cloudflare AddParticipant → get CF token
  3. Insert participant to DB
  4. Store metadata in Redis (optional)
  5. Register with WebSocket hub (optional)
  6. Generate JWT token with CF token inside
  7. Return participant + token pair
```

### **✅ What's Good**:
- Token pair generation (access + refresh)
- Cloudflare auth token embedded in JWT claims
- Proper role handling (host vs participant)
- Redis/WebSocket are optional (graceful degradation)

### **❌ Critical Bugs**:

#### **BUG #5: No Duplicate Participant Check**
**File**: `participant/service.go:76` (JoinRoom)

**Issue**: Same `external_user_id` can join multiple times

**Fix**:
```go
func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
    room, err := s.db.GetRoom(ctx, input.RoomID)
    if err != nil || room.Status != "active" {
        return nil, ErrRoomNotAvailable
    }

    // CHECK: Is this user already in room?
    existing, err := s.db.GetParticipantByExternalUserAndRoom(ctx, db.GetParticipantByExternalUserAndRoomParams{
        RoomID:         input.RoomID,
        ExternalUserID: strPtr(input.ExternalUserID),
    })

    if err == nil && existing.LeftAt.Valid == false {
        // Already in room, return existing (allow multi-device)
        // OR return error if policy is block
        return s.RefreshToken(ctx, existing.ID)  // Reuse existing
    }

    // ... continue with new participant creation
}
```

**Decision Needed**: Allow multi-device or block?
- **Allow**: Return existing participant with new token
- **Block**: Return error "Already in room"

**Impact**: Duplicate participants, incorrect counts, wasted Cloudflare calls

---

#### **BUG #6: No Participant Limit Check**
**File**: `participant/service.go:76`

**Issue**: No enforcement of room's `max_participants_per_room`

**Fix**:
```go
func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
    room, err := s.db.GetRoom(ctx, input.RoomID)
    if err != nil || room.Status != "active" {
        return nil, ErrRoomNotAvailable
    }

    // CHECK: Room full?
    tenant, _ := s.db.GetTenant(ctx, room.TenantID)
    activeCount, _ := s.db.CountActiveParticipantsByRoom(ctx, input.RoomID)

    if activeCount >= int64(tenant.MaxParticipantsPerRoom) {
        return nil, ErrRoomFull
    }

    // ... continue
}
```

**Impact**: Rooms exceed capacity, Cloudflare might reject

---

#### **BUG #7: No WebSocket Broadcast on Participant Join/Leave**
**File**: `participant/service.go:76-144` (JoinRoom), `participant/service.go:146-161` (LeaveRoom)

**Missing broadcast**:
```go
// In JoinRoom (after participant created):
if s.hub != nil {
    message := json.Marshal(map[string]interface{}{
        "event": "participant.joined",
        "participant_id": participant.ID,
        "room_id": input.RoomID,
        "display_name": input.DisplayName,
        "role": role,
    })
    s.hub.BroadcastToRoom(input.RoomID, message, "")
}

// In LeaveRoom:
if s.hub != nil {
    message := json.Marshal(map[string]interface{}{
        "event": "participant.left",
        "participant_id": participantID,
        "room_id": roomID,
    })
    s.hub.BroadcastToRoom(roomID, message, "")
}
```

**Impact**: UIs don't update when participants join/leave

---

#### **BUG #8: Token Refresh Race Condition**
**File**: `participant/service.go:239` (RefreshToken)

**Issue**: If participant refreshes token while leaving, undefined behavior

**Scenario**:
1. Goroutine A: Calls RefreshToken
2. Goroutine B: Calls LeaveRoom (sets left_at)
3. Goroutine A: Generates new token for participant who just left

**Fix**: Check participant is still active before refreshing
```go
func (s *Service) RefreshToken(ctx context.Context, participantID uuid.UUID) (*JoinRoomOutput, error) {
    participant, err := s.db.GetParticipant(ctx, participantID)
    if err != nil {
        return nil, ErrParticipantNotFound
    }

    // CHECK: Participant still active?
    if participant.LeftAt.Valid {
        return nil, errors.New("participant has left the room")
    }

    // ... continue
}
```

---

## 📦 Recording Service Analysis

### **What It Does**:
- Starts/stops recordings (Cloudflare + DB)
- Uploads recordings to R2 when Cloudflare webhook arrives
- Archives recordings (R2 → S3 Glacier)
- Generates presigned download URLs
- Hard deletes recordings from storage

### **Current Flow**:

```go
StartRecording:
  1. Get room from DB
  2. Call Cloudflare StartRecording
  3. Insert recording to DB (status='recording')
  4. Update Redis room state (isRecording=true)
  5. Broadcast to WebSocket hub

StopRecording:
  1. Get active recording for room
  2. Call Cloudflare StopRecording
  3. Update DB (status='processing')
  4. Update Redis/WebSocket

Webhook (recording.ready):
  1. Receive webhook from Cloudflare
  2. Find recording in DB
  3. Download video from Cloudflare URL
  4. Upload to R2
  5. Update DB (status='ready', storage_path, size, duration)
```

### **✅ What's Good**:
- Proper status transitions: recording → processing → ready
- Hard delete from storage (GDPR compliant!)
- Archive logic (R2 → S3 Glacier)
- Presigned URLs for secure downloads

### **❌ Critical Bugs**:

#### **BUG #9: NO WEBHOOK SIGNATURE VERIFICATION** 🚨
**File**: `webhooks.go:33`

**Issue**: ANYONE can POST fake webhooks!

**Current**:
```go
func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
    var webhook RecordingReadyWebhook
    c.ShouldBindJSON(&webhook)  // ❌ No signature check!

    // Processes webhook blindly...
}
```

**Fix** (CRITICAL P0):
```go
func (h *WebhookHandler) HandleRecordingReady(c *gin.Context) {
    // VERIFY SIGNATURE
    signature := c.GetHeader("X-Cloudflare-Signature")
    if signature == "" {
        c.JSON(401, gin.H{"error": "Missing signature"})
        return
    }

    body, _ := c.GetRawData()
    if !verifyCloudflareSignature(body, signature, cfWebhookSecret) {
        c.JSON(401, gin.H{"error": "Invalid signature"})
        return
    }

    // Parse verified payload
    var webhook RecordingReadyWebhook
    json.Unmarshal(body, &webhook)

    // ... process
}
```

**Impact**: CRITICAL SECURITY VULNERABILITY

---

#### **BUG #10: No Recording Already Active Check**
**File**: `recording/service.go:64` (StartRecording)

**Issue**: Can start multiple recordings for same room

**Fix**:
```go
func (s *Service) StartRecording(ctx context.Context, roomID uuid.UUID) (*db.Recording, error) {
    room, err := s.db.GetRoom(ctx, roomID)
    if err != nil {
        return nil, ErrRoomNotFound
    }

    // CHECK: Already recording?
    _, err = s.db.GetActiveRecordingByRoom(ctx, roomID)
    if err == nil {
        return nil, errors.New("recording already in progress")
    }

    // ... start recording
}
```

**Impact**: Multiple Cloudflare recordings, confused state

---

#### **BUG #11: No Webhook Processing Timeout**
**File**: `webhooks.go:51-66`

**Issue**: If webhook never arrives, recording stuck in "processing" forever

**Fix**: Background job to check stalled recordings
```go
// Run every 30 minutes
func CheckStalledRecordings(ctx context.Context) {
    // Find recordings in "processing" for > 1 hour
    recordings, _ := queries.ListRecordingsByStatus(ctx, "processing", 100, 0)

    for _, rec := range recordings {
        if time.Since(rec.UpdatedAt) > 1*time.Hour {
            // Poll Cloudflare API for status
            cfRec, err := cfClient.GetRecording(ctx, *rec.CloudflareRecordingID)

            if err != nil || cfRec.Status == "failed" {
                // Mark as failed
                queries.MarkRecordingFailed(ctx, rec.ID)
                alertAdmin(rec)
            } else if cfRec.Status == "ready" {
                // Webhook missed, process now
                handleRecordingReady(ctx, rec.ID, cfRec)
            }
        }
    }
}
```

**Impact**: Recordings lost forever if webhook fails

---

#### **BUG #12: No Recording Access Audit Log**
**File**: `recording/service.go:191` (GetDownloadURL)

**Issue**: No audit log when presigned URL generated

**Fix** (GDPR requirement):
```go
func (s *Service) GetDownloadURL(ctx context.Context, recordingID uuid.UUID, actorID, ipAddress string) (string, error) {
    recording, err := s.db.GetRecording(ctx, recordingID)
    if err != nil {
        return "", ErrRecordingNotFound
    }

    // AUDIT LOG
    s.db.CreateAuditLog(ctx, db.CreateAuditLogParams{
        RoomID:       pgtype.UUID{Bytes: recording.RoomID, Valid: true},
        ActorID:      &actorID,
        Action:       "recording.downloaded",
        ResourceType: strPtr("recording"),
        ResourceID:   pgtype.UUID{Bytes: recordingID, Valid: true},
        IpAddress:    parseIP(ipAddress),
        Metadata:     json.Marshal(map[string]interface{}{
            "size_bytes": recording.SizeBytes,
            "duration": recording.DurationSeconds,
        }),
    })

    // ... generate URL
}
```

**Impact**: GDPR violation, no forensics

---

#### **BUG #13: DeleteRecording is Soft Delete, Not Hard**
**File**: `recording/service.go:267-291`

**Issue**: Calls `MarkRecordingDeleted` (soft delete), but GDPR requires hard delete

**Current**:
```go
func (s *Service) DeleteRecording(ctx context.Context, recordingID uuid.UUID) error {
    // ... delete from storage (good!)

    _, err = s.db.MarkRecordingDeleted(ctx, recordingID)  // ❌ Soft delete
    return err
}
```

**Check SQL**:
```sql
-- Is this a soft delete (sets deleted_at) or hard delete (DELETE)?
-- Need to verify: db/queries/recordings.sql
```

**If soft delete, fix**:
```go
// Hard delete from DB
err = s.db.DeleteRecording(ctx, recordingID)  // Actual DELETE query
```

**Impact**: GDPR violation, data not actually deleted

---

## 🎯 Summary: Critical Bugs Found

| # | Bug | Service | Priority | Effort | File |
|---|-----|---------|----------|--------|------|
| 1 | No tenant limit check | Room | P0 | 15min | room/service.go:60 |
| 2 | Cloudflare orphan on DB fail | Room | P1 | 20min | room/service.go:61 |
| 3 | EndRoom ignores errors | Room | P2 | 5min | room/service.go:147 |
| 4 | No room WebSocket events | Room | P1 | 30min | room/service.go:60,141 |
| 5 | No duplicate participant check | Participant | P0 | 30min | participant/service.go:76 |
| 6 | No participant limit check | Participant | P0 | 15min | participant/service.go:76 |
| 7 | No participant WebSocket events | Participant | P0 | 30min | participant/service.go:76,146 |
| 8 | Token refresh race condition | Participant | P2 | 10min | participant/service.go:239 |
| 9 | **NO WEBHOOK SIGNATURE** | Recording | **P0** | **30min** | webhooks.go:33 |
| 10 | No active recording check | Recording | P1 | 10min | recording/service.go:64 |
| 11 | No webhook timeout fallback | Recording | P0 | 45min | New file |
| 12 | No recording access audit log | Recording | P0 | 20min | recording/service.go:191 |
| 13 | Soft delete, not hard | Recording | P0 | 15min | recording/service.go:286 |

**Total**: 13 bugs, ~4 hours to fix all

---

## ⚡ 3-Hour Sprint Plan (Prioritized)

### **Hour 1: P0 Security & Compliance**
1. ✅ Bug #9: Webhook signature (30min) - **CRITICAL**
2. ✅ Bug #12: Recording audit logs (20min) - GDPR
3. ✅ Bug #13: Hard delete verification (10min) - GDPR

### **Hour 2: P0 Data Integrity**
4. ✅ Bug #1: Tenant limit check (15min)
5. ✅ Bug #5: Duplicate participant check (30min)
6. ✅ Bug #6: Participant limit check (15min)

### **Hour 3: P0 Real-Time + Fallback**
7. ✅ Bug #7: Participant WebSocket events (30min)
8. ✅ Bug #11: Recording timeout fallback (30min)

**Total: 3 hours exactly**

Deferred to next sprint:
- Bug #2, #3, #4, #8, #10 (P1/P2 issues)

---

## 💡 Key Insights for You

### **Good News**:
1. ✅ Architecture is solid (Clean Architecture, DDD)
2. ✅ Services are focused, single responsibility
3. ✅ Interfaces used everywhere (testable, mockable)
4. ✅ Error handling is consistent
5. ✅ Hard delete is already implemented (line 282)!
6. ✅ Redis/WebSocket optional (graceful degradation)

### **What's Missing**:
1. ❌ Business rule validation (tenant limits, room capacity)
2. ❌ WebSocket event broadcasts (real-time updates)
3. ❌ Webhook security (signature verification)
4. ❌ Audit logging for sensitive operations
5. ❌ Duplicate/race condition handling
6. ❌ Fallback for webhook failures

### **Your Instinct Was Right**:
- ✅ Billable time should be SDK-controlled (Chalk just emits events)
- ✅ Config should be tenant-level (force recording, etc.)
- ✅ Metadata should be separate from config
- ✅ Consumers need flexible control

---

## 🚀 Next: Let's Fix These Bugs!

Want me to start writing the fixes? Pick any bug and I'll give you the complete implementation!

Or should we verify #13 first (is DeleteRecording actually hard delete)?
