# Tuition Highway - Chalk Integration User Stories

## Company Overview
- **Type**: Online tutoring platform
- **Users**: Tutors, Students, Parents, Admins
- **Current**: LMS with Jitsi integrated
- **Migration**: Replace Jitsi with Chalk (hosted version)
- **Key Needs**: Low latency, good bandwidth usage, reliable recording

---

## User Story 1: Tutor Creates Live Class Session

### Actors
- **Primary**: Tutor (Sarah, teaches Math to high school students)
- **System**: Tuition Highway LMS Backend

### Preconditions
- Tuition Highway has Chalk tenant account
- Tuition Highway backend has API key stored securely
- Sarah is logged into Tuition Highway LMS
- Sarah has scheduled class "Algebra 101" in LMS

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Sarah clicks "Start Class" in LMS                            │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Tuition Highway Backend                                      │
│    → POST /api/v1/auth/token                                   │
│      {                                                           │
│        "api_key": "ck_live_tuitionhighway_...",                │
│        "display_name": "Sarah (Tutor)",                        │
│        "role": "host",                                          │
│        "room_id": null                                          │
│      }                                                           │
│    ← { "token": "eyJhbG...", "tenant_id": "..." }              │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Tuition Highway Backend                                      │
│    → POST /api/v1/rooms                                        │
│      Authorization: Bearer eyJhbG...                            │
│      {                                                           │
│        "name": "Algebra 101 - Jan 6, 2026",                    │
│        "config": {                                              │
│          "recording_enabled": true,                            │
│          "max_participants": 30,                               │
│          "tuition_highway_class_id": "class-123",              │
│          "tuition_highway_tutor_id": "tutor-sarah-42"          │
│        }                                                         │
│      }                                                           │
│    ← {                                                          │
│        "id": "room-abc123",                                     │
│        "cloudflare_meeting_id": "cf-meeting-xyz",              │
│        "status": "active"                                       │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Tuition Highway Backend                                      │
│    → POST /api/v1/rooms/room-abc123/participants               │
│      {                                                           │
│        "external_user_id": "tutor-sarah-42",                   │
│        "display_name": "Sarah (Tutor)",                        │
│        "role": "host"                                           │
│      }                                                           │
│    ← {                                                          │
│        "id": "participant-def456",                              │
│        "token": "eyJhbG... (participant-specific JWT)",         │
│        "joined_at": "2026-01-06T10:00:00Z"                     │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Tuition Highway Frontend (Sarah's browser)                   │
│    - Initialize @q9labs/chalk-react SDK                        │
│    - Connect with participant token                             │
│    - Enable camera/microphone                                   │
│    - Display "Waiting for students..." UI                       │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria
- ✅ Room created in Chalk with "active" status
- ✅ Sarah connected as "host" role
- ✅ Room ID stored in Tuition Highway database linked to class-123
- ✅ Sarah sees video preview and can test audio

### Edge Cases to Handle
- ❌ **Tenant limit reached**: "You have reached maximum concurrent rooms (100). Please end an active session first."
- ❌ **Cloudflare API down**: Retry 3 times, then show error + allow manual retry
- ❌ **Sarah's browser denies camera/mic**: Show clear permission instructions
- ❌ **Token expires during class**: Auto-refresh token via `/api/v1/auth/refresh`

### Questions/Gaps Identified
1. ✅ Can we store `external_user_id` and custom config? **YES** - Both supported
2. ❓ **MISSING**: No automatic recording start when room created with `recording_enabled: true`
   - Currently: Host must manually start recording
   - **Needed**: Auto-start if config says `recording_enabled: true`
3. ❓ **MISSING**: No room "scheduled start time" field
   - Tuition Highway schedules classes in advance
   - **Needed**: `scheduled_start_time` field to track scheduled vs actual start

---

## User Story 2: Student Joins Live Class

### Actors
- **Primary**: Student (Alex, 10th grade, joining Algebra class)
- **Secondary**: Tutor (Sarah, already in room as host)

### Preconditions
- Sarah has started class (room-abc123 is active)
- Alex is enrolled in "Algebra 101" in Tuition Highway LMS
- Alex is logged into Tuition Highway

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Alex clicks "Join Class" button in LMS dashboard             │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Tuition Highway Backend                                      │
│    - Lookup room_id for class-123 in local DB                   │
│    - room_id = "room-abc123"                                     │
│    - Check enrollment: Is Alex enrolled in class-123? ✅        │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Tuition Highway Backend                                      │
│    → POST /api/v1/rooms/room-abc123/participants               │
│      Authorization: Bearer <tenant JWT>                         │
│      {                                                           │
│        "external_user_id": "student-alex-99",                  │
│        "display_name": "Alex Johnson",                         │
│        "role": "participant"                                    │
│      }                                                           │
│    ← {                                                          │
│        "id": "participant-ghi789",                              │
│        "token": "eyJhbG... (Alex's participant JWT)",           │
│        "joined_at": "2026-01-06T10:05:00Z"                     │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Tuition Highway Frontend (Alex's browser)                    │
│    - Initialize Chalk SDK with Alex's token                     │
│    - Connect to room-abc123                                      │
│    - Enable camera/microphone (ask permission)                  │
│    - Display Sarah's video + other students                     │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. WebSocket Real-Time Updates                                  │
│    - Sarah's browser receives: "participant.joined" event       │
│    - UI shows: "Alex Johnson joined the class"                  │
│    - Participant count updates: 1 → 2                           │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria
- ✅ Alex connects successfully as "participant" role
- ✅ Sarah sees Alex's video tile appear
- ✅ Other students see Alex join notification
- ✅ Alex can see Sarah and other students

### Edge Cases
- ❌ **Room is full (30/30 participants)**: Show "Class is full. Please contact support."
- ❌ **Room ended before Alex joined**: "This class has ended. Recording will be available soon."
- ❌ **Alex already in room**: Check if `external_user_id` already exists → return existing token
- ❌ **Network drops during join**: Automatic reconnection with same token
- ❌ **Student joins from 2 devices**: Allow or block? **DECISION NEEDED**

### Questions/Gaps Identified
1. ❓ **MISSING**: No check for duplicate `external_user_id` in same room
   - What if Alex joins from laptop AND phone?
   - **Needed**: `GetParticipantByExternalUserAndRoom` query exists ✅
   - **Needed**: Handler should check and either:
     - Option A: Return existing participant + token (allow multi-device)
     - Option B: Reject with "Already joined from another device"
   - **RECOMMENDATION**: Option A (allow multi-device, common use case)

2. ❓ **MISSING**: No "waiting room" concept
   - Some tutors want to approve students before they join
   - **Needed**: `waiting_room_enabled` config + `participant.status` field
   - **Current**: All participants auto-join immediately

3. ✅ **GOOD**: `external_user_id` allows linking Chalk participants to LMS users

---

## User Story 3: Tutor Starts Recording

### Actors
- **Primary**: Tutor (Sarah)
- **Context**: Class in progress, 15 students connected

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Sarah clicks "Start Recording" button in UI                  │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Tuition Highway Frontend                                     │
│    → POST /api/v1/rooms/room-abc123/recordings/start           │
│      Authorization: Bearer <Sarah's host JWT>                   │
│    ← {                                                          │
│        "id": "recording-rec123",                                │
│        "status": "recording",                                   │
│        "started_at": "2026-01-06T10:10:00Z"                    │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Chalk Backend                                                 │
│    → Cloudflare API: Start recording for cf-meeting-xyz        │
│    → DB: INSERT INTO recordings (status='recording')           │
│    → Redis: roomState.SetRecordingActive(room-abc123, true)    │
│    → WebSocket: Broadcast to all participants                   │
│      { event: "recording.started", data: {...} }                │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. All Participants' Browsers                                    │
│    - Receive WebSocket message                                   │
│    - Show red "REC" indicator in UI                             │
│    - Display: "This class is being recorded"                    │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria
- ✅ Recording starts in Cloudflare
- ✅ Database row created with status="recording"
- ✅ All participants notified in real-time
- ✅ UI shows recording indicator

### Edge Cases
- ❌ **Already recording**: "Recording already in progress"
- ❌ **Not host**: Only host role can start recording (403 Forbidden)
- ❌ **Tenant recording limit exceeded**: "Storage quota exceeded. Please upgrade plan."
- ❌ **Cloudflare API fails**: Retry + show error to tutor

### Questions/Gaps Identified
1. ❓ **MISSING**: No recording duration limit check before starting
   - Tenant has `max_recording_duration_minutes: 120`
   - **Needed**: Auto-stop recording after 2 hours? Or just warn?

2. ❓ **MISSING**: Recording consent flow
   - Legal requirement: Inform participants BEFORE recording starts
   - **Needed**: Room config `require_recording_consent: true`
   - If enabled: Show modal to participants, they must click "I consent"
   - **WORKAROUND**: Tuition Highway can show consent in their UI before joining

3. ✅ **GOOD**: WebSocket broadcast ensures all participants know recording started

---

## User Story 4: Class Ends & Recording Processes

### Actors
- **Primary**: Tutor (Sarah ends class)
- **Background**: Cloudflare processes recording
- **Background**: Chalk webhook receives completion
- **Background**: Recording archives to R2

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Sarah clicks "End Class" button                              │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Tuition Highway Frontend                                     │
│    → POST /api/v1/rooms/room-abc123/recordings/stop            │
│    → POST /api/v1/rooms/room-abc123/end                        │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Chalk Backend                                                 │
│    → Cloudflare API: Stop recording                             │
│    → DB: UPDATE recordings SET status='processing'              │
│    → Cloudflare API: End meeting                                │
│    → DB: UPDATE rooms SET status='ended', ended_at=NOW()       │
│    → DB: UPDATE participants SET left_at=NOW()                  │
│    → WebSocket: Broadcast "room.ended" to all participants      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. All Participants Disconnected                                 │
│    - WebSocket receives "room.ended"                            │
│    - Show "Class has ended. Thank you for attending!"          │
│    - Redirect to LMS dashboard after 5 seconds                  │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Cloudflare Processing (Background - 5-15 minutes)            │
│    - Cloudflare processes recording                              │
│    - Converts to MP4                                             │
│    - Generates thumbnail                                         │
│    - Calculates duration/size                                    │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Cloudflare → Chalk Webhook                                   │
│    POST /api/v1/webhooks/cloudflare/recording                   │
│    {                                                             │
│      "recording_id": "cf-rec-xyz",                              │
│      "status": "ready",                                          │
│      "url": "https://cloudflare.com/.../video.mp4",            │
│      "size_bytes": 524288000,  // 500 MB                        │
│      "duration_seconds": 3600   // 1 hour                       │
│    }                                                             │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Chalk Backend Webhook Handler                                │
│    → Find recording in DB by cf-rec-xyz                         │
│    → Download from Cloudflare URL                               │
│    → Upload to R2 storage: storageR2.Upload(...)               │
│    → DB: UPDATE recordings SET                                  │
│         status='ready',                                          │
│         storage_provider='r2',                                   │
│         storage_path='recordings/rec123.mp4',                   │
│         size_bytes=524288000,                                    │
│         duration_seconds=3600                                    │
│    → WebSocket: Broadcast "recording.ready"                     │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. Tuition Highway Backend (Listening to WebSocket/Polling)     │
│    - Receives "recording.ready" notification                     │
│    - GET /api/v1/recordings/rec123                             │
│    - Store recording metadata in LMS database                    │
│    - Link to class-123                                           │
│    - Send email to enrolled students: "Recording available"     │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria
- ✅ Room ends gracefully
- ✅ All participants disconnected with notification
- ✅ Recording processes in background
- ✅ Recording uploaded to R2 (hot storage)
- ✅ Tuition Highway LMS notified when ready
- ✅ Students can access recording via LMS

### Edge Cases
- ❌ **Cloudflare processing fails**: Recording stuck in "processing" status
  - **NEEDED**: Timeout check (if processing > 30 min, mark as "failed")
- ❌ **Webhook never arrives**: Polling fallback needed?
  - **NEEDED**: Cron job to check recordings in "processing" status > 1 hour
- ❌ **R2 upload fails**: Retry logic? Store URL as fallback?
- ❌ **Network issue during upload**: Partial file in R2?

### Questions/Gaps Identified
1. ❓ **MISSING**: No webhook signature verification in code review
   - Security risk: Anyone can POST to /webhooks/cloudflare/recording
   - **NEEDED**: Verify X-Cloudflare-Signature header
   - **CHECK CODE**: handlers/webhooks.go

2. ❓ **MISSING**: No retry mechanism for failed R2 uploads
   - If upload fails, recording lost?
   - **NEEDED**: Retry queue (BullMQ mentioned in docs but not visible)

3. ❓ **UNCLEAR**: How does Tuition Highway know recording is ready?
   - Option A: Poll GET /api/v1/recordings/rec123 every 30s
   - Option B: Listen to WebSocket for "recording.ready" event
   - Option C: Webhook from Chalk to Tuition Highway backend
   - **RECOMMENDATION**: Option B (WebSocket) is already implemented ✅

4. ❓ **MISSING**: No automatic archival to S3 Glacier
   - lifecycle manager mentioned in main.go (lines 121-131)
   - **CHECK**: Does it actually run? What's the schedule?
   - After 30 days in R2 → move to S3 Glacier (cold storage, cheaper)

---

## User Story 5: Student Views Recording (Next Day)

### Actors
- **Primary**: Student (Alex, wants to review Algebra class)

### Preconditions
- Recording is ready (status="ready", storage_provider="r2")
- Alex is enrolled in class-123

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Alex logs into Tuition Highway LMS                           │
│    - Navigates to "Algebra 101" course page                     │
│    - Sees list of past classes with "View Recording" buttons    │
│    - Clicks "View Recording" for Jan 6 class                    │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Tuition Highway Backend                                      │
│    - Verify Alex is enrolled in class-123 ✅                    │
│    - Lookup recording_id from local DB                           │
│    → GET /api/v1/recordings/rec123/download                    │
│      Authorization: Bearer <tenant JWT>                         │
│    ← {                                                          │
│        "url": "https://r2.cloudflare.com/.../rec123.mp4?sig=...",│
│        "expires_at": "2026-01-06T12:00:00Z"  // 1 hour         │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Tuition Highway Frontend                                     │
│    - Redirect Alex to presigned R2 URL                          │
│    - OR embed in custom video player                            │
│    - Show video with playback controls                          │
│    - Track progress (for LMS analytics)                         │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria
- ✅ Alex can watch recording
- ✅ Presigned URL expires after 1 hour (security)
- ✅ Video plays in browser without download
- ✅ Tuition Highway tracks view analytics

### Edge Cases
- ❌ **Recording archived to S3 Glacier**: "Recording archived. Requesting restore (takes 3-5 hours)."
- ❌ **Recording deleted**: "Recording no longer available"
- ❌ **Alex not enrolled**: 403 Forbidden from Tuition Highway backend
- ❌ **URL expired**: Request new presigned URL

### Questions/Gaps Identified
1. ❓ **MISSING**: No recording view analytics
   - Tuition Highway wants: Who watched? How much? When?
   - **NOT CHALK'S JOB**: Chalk only provides download URL
   - Tuition Highway must track views in their system

2. ❓ **UNCLEAR**: Presigned URL expiration time
   - Code shows 1 hour expiry
   - Is this configurable? What if student watches 2-hour recording?
   - **NEEDED**: Configurable expiry or auto-refresh mechanism

3. ✅ **GOOD**: Presigned URLs prevent direct R2 access (security)

---

## Integration Architecture: Tuition Highway ↔ Chalk

```
┌────────────────────────────────────────────────────────────────┐
│                  Tuition Highway LMS                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Frontend (React)                                          │  │
│  │  - @q9labs/chalk-react SDK                               │  │
│  │  - Video UI components                                    │  │
│  │  - WebSocket connection to Chalk                         │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   ↓                                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Backend (Node.js/Python/Go)                              │  │
│  │  - Stores Chalk tenant API key (ck_live_...)            │  │
│  │  - Calls Chalk API to create rooms/participants          │  │
│  │  - Receives participant tokens for students              │  │
│  │  - Passes tokens to frontend                             │  │
│  │  - Stores room_id ↔ class_id mapping                    │  │
│  │  - Listens for WebSocket events (recording.ready)       │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   ↓                                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Database                                                  │  │
│  │  - classes table (id, name, tutor_id, schedule, ...)    │  │
│  │  - enrollments table (student_id, class_id)             │  │
│  │  - chalk_rooms table (class_id, chalk_room_id, ...)     │  │
│  │  - recordings table (class_id, chalk_recording_id, ...) │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬───────────────────────────────────┘
                             ↓
                    HTTPS / WebSocket
                             ↓
┌────────────────────────────┴───────────────────────────────────┐
│                      Chalk API (Hosted)                         │
│  - Rooms, Participants, Recordings management                   │
│  - Cloudflare RealtimeKit integration                          │
│  - R2/S3 storage                                                │
│  - WebSocket real-time updates                                 │
│  - JWT token generation                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Missing Features for Tuition Highway

### Priority 1 (Blocking for Production)
1. ❌ **Auto-start recording when `recording_enabled: true`**
   - Current: Manual start required
   - Needed: Auto-start when room created with flag

2. ❌ **Duplicate participant handling**
   - Current: No check for same external_user_id joining twice
   - Needed: Allow multi-device OR reject duplicate

3. ❌ **Webhook signature verification**
   - Current: Unverified webhook endpoint (security risk)
   - Needed: Verify Cloudflare signature

4. ❌ **Recording processing timeout handling**
   - Current: Recording stuck in "processing" forever if webhook fails
   - Needed: Timeout + retry + fallback polling

### Priority 2 (Nice to Have)
5. ⚠️ **Waiting room feature**
   - Current: Students auto-join
   - Needed: Tutor approval flow (optional)

6. ⚠️ **Recording consent tracking**
   - Current: No consent mechanism
   - Needed: Store participant consent status

7. ⚠️ **Scheduled start time field**
   - Current: Only actual start time tracked
   - Needed: Schedule vs actual start comparison

8. ⚠️ **Presigned URL expiry configuration**
   - Current: Hardcoded 1 hour
   - Needed: Configurable per tenant

### Priority 3 (Future Enhancement)
9. 💡 **Recording thumbnails/previews**
10. 💡 **Chat transcript storage**
11. 💡 **Breakout rooms for group work**
12. 💡 **Whiteboard/screen sharing metadata**

---

## Summary: Tuition Highway Integration Checklist

### Backend Integration
- [ ] Store Chalk API key securely
- [ ] Implement room creation on class start
- [ ] Implement participant joining flow
- [ ] Handle WebSocket connection for real-time updates
- [ ] Store room_id ↔ class_id mapping
- [ ] Handle recording.ready event
- [ ] Generate presigned URLs for students
- [ ] Implement enrollment checks before joining

### Frontend Integration
- [ ] Install @q9labs/chalk-react SDK
- [ ] Build video UI components
- [ ] Handle camera/microphone permissions
- [ ] Show recording indicator
- [ ] Handle reconnection on network drop
- [ ] Display participant list
- [ ] Implement chat UI (if needed)

### Testing Scenarios
- [ ] Tutor creates class with 30 students
- [ ] Student joins from mobile device
- [ ] Network interruption during class
- [ ] Recording playback next day
- [ ] Multiple concurrent classes
- [ ] Tenant limit (100 rooms) reached
- [ ] Recording storage quota exceeded

### Production Readiness
- [ ] Load testing (100 concurrent rooms, 3000 participants)
- [ ] Webhook reliability testing
- [ ] Recording archival testing (R2 → S3 Glacier)
- [ ] Token refresh testing (15-min expiry)
- [ ] Error handling for all Cloudflare API failures
- [ ] Monitoring/alerting setup
