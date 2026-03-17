# Chalk Official RN Mobile App Plan

## Reality Check — 2026-03-15

Architecture has converged in the right direction:

- `apps/mobile` is now a thin shell
- `packages/sdk-react-native` owns the actual RN meeting experience
- `packages/sdk-core` remains the source of truth for room/session/runtime logic

So the plan is no longer "build a mobile app from scratch."

It is now:

- stabilize the existing package-first RN meeting stack
- close the remaining realtime/native gaps
- polish the meeting UX until it feels like Chalk

## Current Architecture

### Thin app shell

`apps/mobile` currently owns:

- app boot
- deep link intake
- local env / API / WS resolution
- home screen
- route state: `home | lobby`
- provider wiring into the RN SDK package

### RN SDK surface

`packages/sdk-react-native` currently owns:

- `ChalkNativeProvider`
- `NativeVideoConference`
- `NativePreJoinLobby`
- `NativeJoiningLoadingScreen`
- `NativeMeetingRoom`
- `NativeMeetingPanel`
- `NativeMediaView`
- RN hooks for:
  - connection
  - room
  - participants
  - media
  - devices
  - chat
  - transcripts
  - interactions
  - panels
  - layout
  - recording
  - screen share
  - whiteboard

### Shared runtime

`packages/sdk-core` still owns:

- `ChalkSession`
- `ConferenceSession`
- room lifecycle
- join/create flow
- RTK loader seam
- WS hydration
- participant/chat/transcript/reaction state
- host actions

## Grounded Status

### Done

- RN runtime seam exists; web/native can share `ChalkSession`
- app boots on Android dev client
- mobile local-dev API/WS resolution is fixed for device testing
- home screen exists
- create-meeting path exists
- join-link resolution exists
- prejoin lobby exists inside `sdk-react-native`
- native camera preview exists in lobby
- joining transition exists
- room join works at least to first connected room
- native RTC media view component exists
- meeting room shell exists
- participant state hooks exist
- chat hook exists
- transcript hook exists
- reactions / hand raise hooks exist
- device selection hooks exist
- screen share hook exists
- whiteboard state hook exists
- host moderation plumbing exists in RN package

### Partially done

- room UI is real, but still in active composition/polish phase
- chat / participants / transcripts are wired into panels, but not yet proven deeply on-device
- screen share hook exists, but device-level proof is still needed
- device switching UI exists, but route/speaker behavior still needs real-hardware verification
- whiteboard state exists, but mobile whiteboard UX is not a finished product surface
- recording hook exists, but recording is not a V1 product focus
- end / leave lifecycle is much better, but still deserves repeat device verification

### Not done

- iOS device proof
- robust end-to-end create/join test matrix
- proof of two-way audio/video across multiple real devices
- reconnect / network-drop validation
- background audio validation
- Bluetooth / earpiece / speaker validation
- screen share originate validation on real devices
- host moderation validation on real devices
- meeting-quality visual polish
- confidence that all package features are product-ready rather than exposed-only

## V1 Scope

Meeting-only. No dashboard drift.

Ship:

- create meeting
- join existing meeting
- prejoin lobby
- in-room meeting experience
- participant video/audio presence
- participant list
- chat
- live transcripts
- hand raise
- reactions
- leave meeting
- host end-for-all / mute / remove
- reconnect states
- basic device settings

Do not treat as V1 goals:

- auth
- dashboard
- meeting history
- transcript detail outside the room
- recording library
- account settings
- push notifications

## What The Codebase Is Actually Telling Us

### Strong signal

- package-first architecture is working
- mobile is no longer a fake app or throwaway prototype
- RN SDK has real breadth now
- the hardest repeated infra/dev issue (`localhost` on physical Android) has a root-cause fix

### Weak signal

- breadth is ahead of proof
- many hooks/components exist, but not all have been verified under real multi-device usage
- some features may still be "plumbed" more than "finished"

That means the next phase should be proof + tightening, not adding more surface area.

## Updated Execution Plan

### Phase 1 — prove meeting correctness

- prove `create -> lobby -> room`
- prove `join link -> lobby -> room`
- prove two participants can hear/see each other
- prove participant list updates live
- prove chat events arrive live
- prove transcript events arrive live

### Phase 2 — prove mobile-native behavior

- prove camera preview stability
- prove mic/cam toggles work repeatedly
- prove leave/end flows stay correct
- prove speaker / earpiece / Bluetooth switching
- prove background / foreground behavior
- prove reconnect after network interruption

### Phase 3 — polish the room

- tighten lobby fidelity
- tighten room composition
- improve panel ergonomics
- improve stage/grid logic
- improve empty / loading / error states

### Phase 4 — optional deeper meeting features

- screen share production hardening
- host moderation refinement
- whiteboard decision: defer or build properly

## Immediate Next Tasks

1. Real multi-device join proof
2. Verify chat + transcripts live in-room
3. Verify actual remote media rendering
4. Verify host actions
5. Verify reconnect / leave / end
6. Only then continue room polish

## Success Criteria

Call this mobile V1 healthy when all are true:

- app boots consistently on device
- user can create or join a room without debugging steps
- lobby preview is stable
- room connects reliably
- remote participants can hear and see each other
- chat and transcripts update live
- leave/end behave predictably
- core controls feel native and trustworthy

## Current Strategic Advice

Do not expand scope.

Do not go back to dashboard/auth/history.

Stay locked on:

- meeting correctness
- device proof
- room polish

That is the shortest path to an official Chalk mobile app that is actually real.

## Release Stabilization Addendum

Current release truth:

- Android internal/alpha distribution is live and repeatable.
- Release transport config is fixed: production builds must force Chalk prod API/WS endpoints and never honor device-local `localhost` envs.
- The remaining active release blocker for `New Meeting` is valid prod host auth, not CORS or WebSocket routing.

What changed in understanding:

- `apps/web` production is not a reliable source of truth for host-key behavior.
- Web prod currently falls back to internal/session auth and join-token flows.
- Mobile `host/create meeting` needs its own valid build-time host key path.

Current release plan:

1. Build mobile release artifacts only from secret-backed prod config.
2. Inject `EXPO_PUBLIC_CHALK_API_KEY` from GitHub secret `VITE_CHALK_API_KEY` during release builds; never depend on local `.env` host-key values for store builds.
3. Publish fresh Android internal builds from that workflow until a tester-verified prod `New Meeting` succeeds.
4. After host auth is green, return focus to meeting proof: multi-participant media, chat, transcripts, reconnect, and room polish.
