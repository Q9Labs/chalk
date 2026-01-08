# CollabEZ - Chalk Integration User Stories

## Company Overview

- **Type**: Software house / Development agency
- **Users**: Employees, Team Leads, HR, Admins, External Clients
- **Current**: Employee Management System with Jitsi for internal video conferencing
- **Migration**: Replace Jitsi with Chalk (hosted version, maybe self-host later)
- **Key Needs**: Team standups, client calls, all-hands meetings, 1-on-1s, screen sharing

---

## User Story 1: Daily Standup (Recurring Team Meeting)

### Actors

- **Primary**: Team Lead (Mike, leads a team of 8 developers)
- **Secondary**: 8 team members

### Preconditions

- CollabEZ has Chalk tenant account
- Standup scheduled in EMS (Employee Management System) for 9:00 AM daily
- Team members have CollabEZ employee accounts

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. 8:55 AM - EMS Scheduled Job Runs                             │
│    - Finds upcoming standup meeting (team-alpha-standup)        │
│    - Creates Chalk room 5 minutes before scheduled time         │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. CollabEZ Backend (Cron Job)                                  │
│    → POST /api/v1/auth/token                                   │
│      { "api_key": "ck_live_collabez_..." }                     │
│    ← { "token": "eyJ...", "tenant_id": "..." }                 │
│                                                                  │
│    → POST /api/v1/rooms                                        │
│      {                                                           │
│        "name": "Team Alpha Daily Standup - Jan 6",             │
│        "config": {                                              │
│          "recording_enabled": false,  // Standups not recorded │
│          "max_participants": 10,                               │
│          "collabez_meeting_id": "meeting-standup-456",         │
│          "collabez_team_id": "team-alpha"                      │
│        }                                                         │
│      }                                                           │
│    ← { "id": "room-xyz789", ... }                              │
│                                                                  │
│    - Store room_id in EMS meetings table                        │
│    - Send Slack notification: "Standup room ready! Join here: [Link]" │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria

- ✅ Room auto-created before meeting time
- ✅ Team notified via Slack with join link
- ✅ Room stays active even if no one joins immediately

### Edge Cases

- ❌ **Room creation fails**: Retry 3 times, escalate to #dev-ops Slack channel
- ❌ **Tenant limit reached**: Alert admin, create room when slot available
- ❌ **Slack notification fails**: Show in-app notification as fallback

### Questions/Gaps Identified

1. ❓ **MISSING**: No "empty room timeout"
   - If no one joins standup, room stays active forever
   - **NEEDED**: Auto-end room if empty for 30 minutes
   - **WORKAROUND**: CollabEZ cron job checks and ends empty rooms

2. ❓ **MISSING**: No recurring meeting concept in Chalk
   - CollabEZ must manage recurrence logic
   - Must create new room each day
   - **NOT CHALK'S JOB**: Chalk is session-based, not calendar-based ✅

3. ✅ **GOOD**: `config` JSONB field allows storing `collabez_meeting_id` for linking

---

## User Story 2: Emergency All-Hands Meeting

### Actors

- **Primary**: CEO (Jane, needs to address entire company - 150 people)
- **Context**: Urgent announcement, everyone must join NOW

### Preconditions

- CollabEZ has 150 employees
- Tenant `max_participants_per_room: 200`

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Jane clicks "Start All-Hands Meeting" in EMS                │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. CollabEZ Backend                                              │
│    → POST /api/v1/rooms                                        │
│      {                                                           │
│        "name": "🚨 Emergency All-Hands - Jan 6",               │
│        "config": {                                              │
│          "recording_enabled": true,  // Important announcements│
│          "max_participants": 200,                              │
│          "presenter_mode": true,     // Only Jane can speak    │
│          "collabez_meeting_type": "all-hands"                  │
│        }                                                         │
│      }                                                           │
│    ← { "id": "room-allhands-001", ... }                        │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. CollabEZ Backend - Add Jane as Host                          │
│    → POST /api/v1/rooms/room-allhands-001/participants         │
│      {                                                           │
│        "external_user_id": "employee-jane-ceo",                │
│        "display_name": "Jane (CEO)",                           │
│        "role": "host"                                           │
│      }                                                           │
│    ← { "token": "eyJ... (Jane's token)" }                      │
│                                                                  │
│    → POST /api/v1/rooms/room-allhands-001/recordings/start     │
│      (Auto-start recording immediately)                         │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. CollabEZ Backend - Notify All Employees                      │
│    - Send push notification to all 150 employees                │
│    - Send email with join link                                  │
│    - Show banner in EMS: "JOIN ALL-HANDS NOW"                  │
│    - Post in #general Slack channel                             │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Employees Click "Join" (Staggered - 150 joins in 2 minutes) │
│    For each employee:                                            │
│      → POST /api/v1/rooms/room-allhands-001/participants       │
│        { "external_user_id": "employee-123", "role": "participant" }│
│      ← { "token": "eyJ..." }                                    │
│                                                                  │
│    Chalk handles 150 concurrent participant add requests        │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria

- ✅ 150 employees join successfully within 2 minutes
- ✅ Jane's video/audio works (host)
- ✅ Recording auto-started
- ✅ Participants can see/hear Jane but muted by default
- ✅ No lag or dropped connections

### Edge Cases

- ❌ **151st employee tries to join**: "Meeting is full (200/200 participants)"
- ❌ **Cloudflare rate limiting**: 150 concurrent API calls to add participants
- ❌ **Some employees on slow networks**: Progressive join, don't block others
- ❌ **Recording fails to start**: Alert Jane, show error in UI

### Questions/Gaps Identified

1. ❓ **CRITICAL**: Rate limiting for concurrent participant adds
   - 150 employees clicking "Join" at same time = 150 API calls in seconds
   - Does Chalk/Cloudflare handle this burst?
   - **NEEDED**: Load testing with 200 concurrent participant adds
   - **NEEDED**: Rate limit documentation (per tenant, per room)

2. ❓ **MISSING**: "Presenter mode" / "Webinar mode"
   - Only host can speak, participants view-only
   - **NOT IN CHALK**: This is WebRTC configuration
   - **WORKAROUND**: CollabEZ frontend disables mic/camera for participants
   - Participants can still enable if they know how (browser controls)

3. ❓ **MISSING**: Bulk participant add API
   - Current: 1 API call per participant
   - Optimization: `POST /api/v1/rooms/:id/participants/bulk`
   - Body: `[{ external_user_id, display_name, role }, ...]`
   - Returns: `[{ id, token }, ...]`
   - **NEEDED**: Reduces 150 API calls → 1 API call

4. ❓ **MISSING**: Participant capacity warnings
   - At 180/200, show warning: "Room almost full"
   - At 195/200, stop sending invites
   - **NOT IN CHALK**: CollabEZ must track count

---

## User Story 3: Client Project Kickoff Call

### Actors

- **Primary**: Project Manager (Sarah, CollabEZ employee)
- **Secondary**: 3 CollabEZ developers (internal)
- **Secondary**: 2 client representatives (external, no CollabEZ accounts)

### Preconditions

- Client "Acme Corp" is in CollabEZ CRM
- Meeting scheduled in EMS calendar

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Sarah schedules meeting in EMS                               │
│    - Internal: dev-alice, dev-bob, dev-charlie (CollabEZ)      │
│    - External: john@acme.com, lisa@acme.com (Acme Corp)        │
│    - Recording: Enabled (client requested)                      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. 5 minutes before meeting - EMS creates room                  │
│    → POST /api/v1/rooms                                        │
│      {                                                           │
│        "name": "Acme Corp - Project Kickoff",                  │
│        "config": {                                              │
│          "recording_enabled": true,                            │
│          "max_participants": 10,                               │
│          "collabez_client_id": "client-acme",                  │
│          "collabez_project_id": "project-789"                  │
│        }                                                         │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Add Sarah as Host                                            │
│    → POST /api/v1/rooms/:id/participants                       │
│      { "external_user_id": "employee-sarah", "role": "host" }  │
│    ← { "token": "eyJ..." }                                     │
│    - Send to Sarah's browser                                    │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Add Internal Participants (CollabEZ Employees)               │
│    For alice, bob, charlie:                                      │
│      → POST /api/v1/rooms/:id/participants                     │
│        { "external_user_id": "employee-{name}", "role": "participant" }│
│      ← { "token": "eyJ..." }                                    │
│    - Send join link via EMS in-app notification                 │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Add External Participants (Clients - NO ACCOUNTS)            │
│    For john@acme.com, lisa@acme.com:                            │
│      → POST /api/v1/rooms/:id/participants                     │
│        {                                                         │
│          "external_user_id": "guest-john@acme.com",  // Email  │
│          "display_name": "John (Acme Corp)",                   │
│          "role": "participant"                                  │
│        }                                                         │
│      ← { "token": "eyJ...", "id": "participant-abc" }          │
│                                                                  │
│    - Generate anonymous join link:                              │
│      https://collabez.com/join/room-xyz?token=eyJ...           │
│    - Send via email to john@acme.com, lisa@acme.com            │
│    - Link valid for 24 hours (JWT expiry)                      │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria

- ✅ Internal employees join via EMS
- ✅ External clients join via email link (no login required)
- ✅ Recording auto-starts
- ✅ Everyone can see/hear each other

### Edge Cases

- ❌ **Client's JWT token expires during meeting**: Auto-refresh or show "Session expired, rejoin"
- ❌ **Client joins from link multiple times**: Allow or block?
- ❌ **Malicious user shares link**: Link is bearer token, anyone can use it
  - **MITIGATION**: Short expiry (1 hour), room auto-ends when host leaves
- ❌ **Client's email blocks join link**: Provide fallback (meeting code to enter manually)

### Questions/Gaps Identified

1. ❓ **SECURITY RISK**: JWT tokens in URL
   - Join link: `https://collabez.com/join/room-xyz?token=eyJ...`
   - Token visible in browser history, server logs, analytics
   - **BETTER**: Use one-time join codes
   - `/join/ABC-DEF-GHI` → Backend exchanges code for token → Frontend uses token

2. ❓ **MISSING**: Token expiry vs meeting duration
   - JWT expires in 15 minutes (default)
   - Client calls are often 1-2 hours
   - **NEEDED**: Auto token refresh in SDK
   - **CHECK SDK**: Does @q9labs/chalk-react auto-refresh?

3. ❓ **MISSING**: Guest participant tracking
   - No CollabEZ account, just email
   - How to prevent same guest joining twice?
   - **CURRENT**: `external_user_id: "guest-john@acme.com"` works ✅
   - **ISSUE**: What if John joins from laptop AND phone?

4. ❓ **MISSING**: Room access control
   - Anyone with token can join
   - No password protection
   - **WORKAROUND**: CollabEZ validates invitations before generating tokens

---

## User Story 4: Screen Sharing in Code Review

### Actors

- **Primary**: Developer (Alice, sharing code on screen)
- **Secondary**: Senior Dev (Bob, reviewing code)

### Preconditions

- 1-on-1 meeting room already created
- Both Alice and Bob connected

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Alice clicks "Share Screen" in Chalk UI                      │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Browser asks permission to share screen                      │
│    - Alice selects "Entire Screen" or "Application Window"     │
│    - Chrome/Firefox shows native picker                         │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Chalk SDK (@q9labs/chalk-react)                              │
│    - Calls navigator.mediaDevices.getDisplayMedia()            │
│    - Adds screen share track to WebRTC connection               │
│    - Cloudflare RealtimeKit relays to Bob                       │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Bob's Browser                                                 │
│    - Receives screen share track                                │
│    - Displays Alice's screen in large video tile               │
│    - Alice's camera shrinks to small tile (PiP)                │
└─────────────────────────────────────────────────────────────────┘
```

### Success Criteria

- ✅ Screen share starts within 2 seconds
- ✅ Bob sees Alice's screen clearly (readable code text)
- ✅ Low latency (<500ms delay)
- ✅ No freezing or dropped frames

### Questions/Gaps Identified

1. ❓ **NOT CHALK ISSUE**: Screen sharing is WebRTC native
   - Cloudflare RealtimeKit handles media relay
   - Chalk SDK just wraps WebRTC APIs
   - **NO BACKEND CHANGES NEEDED** ✅

2. ❓ **ANALYTICS**: Track screen share usage?
   - CollabEZ wants metrics: "How often do teams use screen share?"
   - **NOT IN CHALK**: No screen share events tracked
   - **WORKAROUND**: CollabEZ frontend tracks in their analytics

---

## User Story 5: Recording Compliance (GDPR)

### Actors

- **Primary**: HR Manager (needs to review employee conduct in recorded meeting)
- **Context**: Employee filed complaint about meeting behavior
- **Compliance**: EU employees, GDPR applies

### Preconditions

- Meeting was recorded last week
- Recording stored in R2 (Cloudflare EU region)

### Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. HR Manager requests recording access                         │
│    - Logs into EMS                                               │
│    - Navigates to "Meeting: Team Retro - Dec 30"               │
│    - Clicks "View Recording" (requires HR role)                 │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. CollabEZ Backend (Authorization Check)                       │
│    - Verify user has "HR" or "Admin" role ✅                    │
│    - Check if recording still exists (not deleted)              │
│    - Audit log: "HR-jane accessed recording rec-123"           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. CollabEZ Backend → Chalk API                                 │
│    → GET /api/v1/recordings/rec-123/download                   │
│      Authorization: Bearer <tenant JWT>                         │
│    ← {                                                          │
│        "url": "https://r2.cloudflare.com/.../rec-123.mp4?sig=...",│
│        "expires_at": "...",                                     │
│        "storage_provider": "r2",                                │
│        "size_bytes": 524288000,                                 │
│        "duration_seconds": 3600                                 │
│      }                                                           │
└────────────────┬────────────────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. HR Manager Views Recording                                   │
│    - Watches in browser                                          │
│    - Takes notes for investigation                              │
│    - Does NOT download (policy)                                 │
└─────────────────────────────────────────────────────────────────┘
```

### GDPR Compliance Requirements

1. **Right to Access**: Employees can request their own recordings
2. **Right to Deletion**: Employees can request recording deletion
3. **Data Retention**: Auto-delete after 90 days (company policy)
4. **Access Logs**: Track who accessed what recording
5. **Data Location**: Store in EU region only

### Questions/Gaps Identified

1. ❓ **MISSING**: Recording retention policy enforcement
   - Tenant has `max_recording_duration_minutes` but no retention days
   - **NEEDED**: `recording_retention_days: 90` tenant config
   - **NEEDED**: Lifecycle manager auto-deletes after 90 days
   - **CHECK CODE**: Does lifecycle manager support this?

2. ❓ **MISSING**: Data region selection
   - R2 and S3 store recordings
   - No way to specify region (EU vs US)
   - **NEEDED**: Tenant config `data_region: "eu"` or `"us"`
   - Pass to Cloudflare API and storage clients

3. ❓ **MISSING**: Recording access audit log
   - Chalk creates audit logs for room.created, participant.joined
   - **NOT CREATED**: No audit log for `GET /api/v1/recordings/:id/download`
   - **NEEDED**: Log every recording access (who, when, from what IP)

4. ❓ **MISSING**: Recording deletion API
   - Endpoint exists: `DELETE /api/v1/recordings/:id`
   - Does it mark as deleted or hard delete?
   - **GDPR REQUIRES**: Hard delete from storage (R2/S3)
   - **CHECK CODE**: handlers/recordings.go Delete method

---

## User Story 6: Self-Hosting Migration (Future)

### Context

- CollabEZ grows to 500 employees
- Video usage explodes (200 hours/month)
- Chalk hosted costs too high
- Decision: Self-host Chalk on AWS

### Migration Checklist

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Infrastructure Setup                                          │
│    - Deploy Chalk API to AWS ECS (terraform in repo)           │
│    - Set up RDS PostgreSQL database                             │
│    - Set up ElastiCache Redis                                   │
│    - Set up S3 for recordings (replace R2)                      │
│    - Configure Cloudflare RealtimeKit with new API URL          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 2. Data Migration                                                │
│    - Export tenant data from hosted Chalk                        │
│    - Import into self-hosted PostgreSQL                         │
│    - Copy recordings from Chalk R2 to CollabEZ S3              │
│    - Update recording.storage_path in database                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 3. Configuration Changes                                         │
│    - Update EMS backend API_URL to self-hosted Chalk            │
│    - Rotate tenant API key                                       │
│    - Update SDK initialization in frontend                       │
│    - Test WebSocket connection to new URL                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 4. Gradual Rollout                                               │
│    - Phase 1: New meetings use self-hosted (test with 10%)     │
│    - Phase 2: All new meetings use self-hosted (monitor)        │
│    - Phase 3: Old recordings still accessible from hosted       │
│    - Phase 4: Migrate all old recordings, shut down hosted      │
└─────────────────────────────────────────────────────────────────┘
```

### Questions/Gaps Identified

1. ❓ **UNCLEAR**: Multi-tenant support in self-hosted
   - CollabEZ is one tenant
   - But they might want sub-tenants (per department/project)
   - **CURRENT**: Chalk supports multi-tenant ✅
   - CollabEZ can create multiple tenants if needed

2. ❓ **MISSING**: Export/import tools
   - No documented way to export tenant data
   - No import script for self-hosted
   - **NEEDED**: `chalk-cli export --tenant-id=... --output=backup.sql`
   - **NEEDED**: `chalk-cli import --file=backup.sql`

3. ✅ **GOOD**: Infrastructure as Code (Terraform) already in repo
   - `infrastructure/terraform/` has ECS, RDS, ElastiCache
   - CollabEZ can customize for their AWS account

---

## Integration Architecture: CollabEZ ↔ Chalk

```
┌────────────────────────────────────────────────────────────────┐
│                  CollabEZ EMS (Employee Management System)      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Frontend (React)                                          │  │
│  │  - @q9labs/chalk-react SDK                               │  │
│  │  - Custom video UI matching CollabEZ branding            │  │
│  │  - WebSocket for real-time updates                       │  │
│  │  - Screen share controls                                 │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   ↓                                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Backend (Node.js Express)                                │  │
│  │  - Chalk API key stored in env vars                      │  │
│  │  - Cron jobs for scheduled meeting rooms                 │  │
│  │  - Authorization: Check employee roles before tokens     │  │
│  │  - Guest participant link generation                      │  │
│  │  - Recording access control (HR/Admin only)             │  │
│  │  - Audit logging (separate from Chalk audit logs)       │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   ↓                                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Database (PostgreSQL)                                     │  │
│  │  - employees (id, name, email, role, ...)               │  │
│  │  - meetings (id, type, scheduled_time, room_id, ...)    │  │
│  │  - meeting_participants (meeting_id, employee_id, ...)  │  │
│  │  - chalk_rooms (meeting_id, chalk_room_id, ...)         │  │
│  │  - recordings (meeting_id, chalk_recording_id, ...)     │  │
│  │  - clients (id, company_name, contacts, ...)            │  │
│  │  - projects (id, client_id, team_members, ...)          │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬───────────────────────────────────┘
                             ↓
                    HTTPS / WebSocket
                             ↓
┌────────────────────────────┴───────────────────────────────────┐
│                      Chalk API (Hosted)                         │
│  - Multi-tenant rooms management                                │
│  - Cloudflare RealtimeKit for WebRTC                           │
│  - R2 hot storage → S3 Glacier cold storage                    │
│  - Real-time WebSocket events                                   │
│  - JWT token generation with auto-refresh                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Missing Features for CollabEZ

### Priority 1 (Blocking for Production)

1. ❌ **Bulk participant add API**
   - Current: 1 API call per participant
   - Needed: Add 150 employees in 1 API call (all-hands)
   - Impact: Rate limiting, slow join times

2. ❌ **Empty room auto-cleanup**
   - Current: Rooms stay active forever if unused
   - Needed: Auto-end after 30 min of no participants
   - Impact: Wastes tenant room quota

3. ❌ **Recording access audit logs**
   - Current: No log when recordings downloaded
   - Needed: GDPR compliance, track who accessed what
   - Impact: Legal/compliance risk

4. ❌ **Recording deletion (hard delete)**
   - Current: Unclear if DELETE actually removes from storage
   - Needed: GDPR right to deletion, remove from R2/S3
   - Impact: Legal/compliance risk

5. ❌ **Token auto-refresh in SDK**
   - Current: 15-min JWT expiry, manual refresh needed
   - Needed: SDK auto-refreshes before expiry
   - Impact: Participants kicked out of long meetings

### Priority 2 (Important)

6. ⚠️ **Data region configuration**
   - Current: No control over where data stored
   - Needed: EU tenant → EU Cloudflare + EU R2 + EU S3
   - Impact: GDPR compliance

7. ⚠️ **Recording retention policy**
   - Current: Recordings kept forever
   - Needed: Auto-delete after X days (tenant config)
   - Impact: Storage costs, compliance

8. ⚠️ **One-time join codes (instead of JWT in URL)**
   - Current: JWT tokens in URL (security risk)
   - Needed: `/join/ABC-DEF` → exchange for token
   - Impact: Token leakage in logs/history

9. ⚠️ **Rate limiting documentation**
   - Current: Unknown limits
   - Needed: Clear docs on API rate limits per tenant
   - Impact: All-hands meetings might fail

### Priority 3 (Nice to Have)

10. 💡 **Waiting room / knock to join**
11. 💡 **Meeting rooms (persistent, not session-based)**
12. 💡 **Export/import tools for self-hosting migration**
13. 💡 **Breakout rooms for team sessions**
14. 💡 **Polls / reactions during meetings**

---

## Key Differences: CollabEZ vs Tuition Highway

| Feature                | Tuition Highway         | CollabEZ                     |
| ---------------------- | ----------------------- | ---------------------------- |
| **Primary Use**        | Online education        | Internal collaboration       |
| **User Type**          | Tutors + Students       | Employees + Clients          |
| **Meeting Size**       | Medium (10-30)          | Small (2-10) OR Large (150+) |
| **Recording**          | Always on               | Selective                    |
| **Guest Access**       | Rare                    | Common (clients)             |
| **Compliance**         | Educational privacy     | GDPR / Employee data         |
| **Self-Host**          | Unlikely                | Likely (future)              |
| **Recurring Meetings** | Yes (scheduled classes) | Yes (standups, 1-on-1s)      |
| **Integration**        | Deep (LMS)              | Medium (EMS)                 |

---

## Summary: CollabEZ Integration Checklist

### Backend Integration

- [ ] Implement scheduled meeting room creation (cron jobs)
- [ ] Guest participant link generation with one-time codes
- [ ] HR/Admin authorization for recording access
- [ ] Audit logging for recording access (GDPR)
- [ ] Employee role-based access control
- [ ] Handle empty room cleanup
- [ ] Implement token refresh endpoint

### Frontend Integration

- [ ] @q9labs/chalk-react SDK integration
- [ ] Custom UI matching CollabEZ branding
- [ ] Screen share controls
- [ ] Recording indicator
- [ ] Guest join flow (no login)
- [ ] Multi-device support testing
- [ ] Network reconnection handling

### Compliance & Security

- [ ] GDPR data retention policy (90 days)
- [ ] EU data region configuration
- [ ] Recording hard delete verification
- [ ] Access audit logs for all recordings
- [ ] Token security (no JWT in URLs)
- [ ] Role-based access (HR, Admin, Employee)

### Testing Scenarios

- [ ] Daily standup (8 people, recurring)
- [ ] All-hands (150 people, bulk join)
- [ ] Client call (3 internal + 2 external guests)
- [ ] 1-on-1 with screen share
- [ ] Recording playback (authorized access only)
- [ ] Empty room auto-cleanup
- [ ] Token expiry during 2-hour meeting
- [ ] Guest joining from email link

### Production Readiness

- [ ] Load test: 150 concurrent participant adds
- [ ] Load test: 20 concurrent rooms
- [ ] GDPR compliance audit
- [ ] Recording retention automation
- [ ] Self-hosting migration plan
- [ ] Monitoring & alerting
- [ ] Incident response plan
