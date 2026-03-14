# Chalk Official RN Mobile App V1 Plan

## Scope Reset — 2026-03-14

Mobile V1 is now meeting-only.

Removed from the active plan:

- native Google auth
- dashboard
- meeting history
- transcript detail outside the room
- public share-link viewing
- account surfaces

Focus now:

- join an existing meeting
- create a new meeting
- lobby / prejoin
- live meeting room
- transport correctness
- room UX around connection, participants, chat, transcripts, and moderation

## Summary

Build `apps/mobile` as the official React Native app on `Expo custom dev client`, while keeping Chalk's existing realtime/session model as the source of truth.

Locked decisions:

- `packages/sdk-core` stays the canonical join/runtime engine
- use `Cloudflare RealtimeKit React Native Core`, not the RN UI kit
- add `packages/sdk-react-native` as the mobile adapter/UI layer
- meeting UI enters once `RTK` is connected; `WS` features hydrate after
- if RTK drops, keep users in the meeting and show reconnecting/failure states in place
- auth-less by default
- no dashboard/auth/account work in V1
- `chat` in V1
- `live transcripts in-room` in V1
- `whiteboard` deferred
- `no push notifications` in V1
- `no in-room recording controls` in V1
- `screen share` can be started by any participant/host on both `iOS + Android`
- background behavior is `audio stays alive` where platform rules allow
- audio output gets a `simple route switcher`
- host gets `basic moderation`

## Product Shape

Primary surfaces only:

- `Home`
  - join link / paste destination
  - enter room ID
  - create new meeting
- `Lobby`
  - display name
  - mic toggle
  - camera toggle
  - join CTA
  - waiting / countdown states where applicable
- `Meeting room`
  - participant grid / active speaker
  - participant list
  - chat
  - live transcript panel
  - reactions / hand raise
  - reconnect / degraded-state UX
  - leave / end meeting

Explicitly out of scope:

- dashboard shell
- history
- recordings library
- transcript summary/action-items views outside the room
- account/settings beyond minimal local device controls

## Runtime Architecture

- Refactor `sdk-core` only enough to make the RTK dependency injectable behind a platform adapter seam; do not fork `ChalkSession`, `ConferenceSession`, or the join/session state machine.
- Keep these flows canonical in shared code:
  - `createSession`
  - `addParticipant` / token exchange
  - `ChalkSession.join`
  - `ConferenceSession`
  - RTK join retry policy
  - WS event model
  - reconnect-in-place behavior
  - participant/chat/transcript/reaction state
- Add `sdk-react-native` to own:
  - RN provider/hooks around `ChalkSession`
  - RTK RN Core integration
  - native media rendering and track views
  - device permissions
  - audio route/interruption bridge
  - screen-share bridge
  - app lifecycle hooks

## Join and Meeting Flows

### Join existing meeting

1. Resolve entry:
   - join link `/j/:joinToken`
   - direct room `/room/:roomId`
   - pasted destination in app
2. Acquire room access via existing backend path.
3. Call `addParticipant` and receive:
   - `participantId`
   - `role`
   - `accessToken`
   - `rtcToken`
   - room info
4. Initialize RTK with `rtcToken`.
5. Connect WS in parallel with `accessToken`.
6. Enter meeting UI when RTK is live.
7. Hydrate WS-driven features progressively:
   - chat
   - transcripts
   - reactions
   - hand raise
   - moderation events
8. If RTK disconnects:
   - stay in meeting UI
   - show reconnecting state
   - preserve visible room/chat/transcript state
   - escalate to in-meeting failure state only after reconnect policy exhausts

### Create new meeting

1. Tap `Create meeting` from home.
2. Call shared `createSession`.
3. Land in lobby or directly in meeting depending on current web behavior and backend contract.
4. Host can invite others via copied room/join link.

## Meeting-Room Behavior

Ship in V1:

- prejoin device preview
- waiting-room countdown
- participant grid / active speaker
- participant list
- chat
- live transcription view
- reactions
- hand raise
- reconnect/degraded-state UX
- host basic moderation:
  - mute participant
  - remove participant
  - end room

Do not ship in V1:

- whiteboard implementation
- in-room recording controls
- push/wake/call-style semantics
- post-meeting experiences

## Screen Share, Background, Audio

- Support screen-share viewing for all users.
- Support mobile-originated screen share on both platforms:
  - iOS via ReplayKit/broadcast extension
  - Android via MediaProjection
- If originating screen share is unavailable on a device/config, show explicit unsupported/permission state.
- Background/lock behavior:
  - keep meeting audio alive where allowed
  - degrade video as required by platform/app state
  - restore full media on foreground
- Expose a simple output route switcher:
  - speaker
  - earpiece
  - wired
  - Bluetooth

## Public APIs / Interfaces

- Add `packages/sdk-react-native` as a public package for RN bindings.
- Introduce an RTK runtime adapter seam in `sdk-core` so web and RN can share `ChalkSession` without duplicating join/runtime logic.
- Keep backend HTTP contracts unchanged for:
  - `createSession`
  - room join / add participant
  - realtime WS access
- Keep deep-link contract aligned to current meeting path semantics:
  - `/j/:joinToken`
  - `/room/:roomId`
- Keep neutral terms consistent with the codebase:
  - `participant`
  - `host`
  - `guest` only as fallback
  - `meeting` / `room` / `session`

## Runtime Spike Gate

Before broader UI work, prove on real devices:

- open app successfully
- join room on iOS and Android
- create a room on iOS and Android
- two-way audio/video works
- RTK reconnect works in place
- WS chat/transcript/reaction events hydrate correctly after RTK join
- local mobile screen share works on both platforms
- background audio survives app lock/background where expected
- Bluetooth/speaker route switching works

If this spike fails, keep `sdk-core` shared but narrow the RTK adapter seam further; do not fork the session model.

## Test Plan

### Automated

- Unit tests for:
  - RTK adapter injection into shared runtime
  - join-context persistence/expiry
  - deep-link parsing and route dispatch
  - create-meeting flow orchestration
  - reconnect state transitions
  - route-switcher state handling
- Integration tests for:
  - join-link flow
  - direct room flow
  - create-meeting flow
  - host moderation commands
  - screen-share capability gating

### Device acceptance

- iOS + Android real-device checks for:
  - prejoin permissions
  - create meeting
  - meeting join
  - hear/see remote participant
  - chat
  - live transcripts
  - reactions / hand raise
  - screen-share receive and originate
  - background audio continuity
  - reconnect-in-place after network interruption
  - simple route switching
  - host moderation actions

## Assumptions and Defaults

- React Native stack uses `Expo custom dev client`.
- Cloudflare RN support is present but young; runtime spike is mandatory before broader UI work.
- Chalk owns the mobile meeting UI; Cloudflare RN UI kit is not part of the V1 architecture.
- `RTK connected` is the threshold for entering the meeting UI; WS sync is progressive.
- `No push`, `no whiteboard implementation`, `no dashboard`, and `no recording controls` in V1.
- Mobile should stay product-wise close to the web meeting experience, but runtime correctness wins over parity outside the meeting surface.
