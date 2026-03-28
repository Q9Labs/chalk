## 2026-03-28 17:55 PKT

- Investigated repeated in-meeting `Connection Failed` / `ice connection failed` / `transport not connected` reports plus noisy `WS_PARSE_ERROR` logs.
- Root cause 1: Chalk SDK manually called `rtkClient.join()` after RTK `roomLeft`, but RTK 1.2.x already has its own reconnect state machine (`roomLeft` disconnected -> internal socket/media recovery -> `roomJoined { reconnected: true }` or terminal `roomLeft failed`). The extra join loop could race RTK recovery and amplify transport failures into permanent overlays.
- Root cause 2: selected virtual-background middleware stayed attached across transport loss and could keep surfacing unhandled rejection noise from the RTK virtual-background package after disconnects.
- Root cause 3: local API websocket broadcasts still emitted some legacy `event/data` envelopes (`participant.left`, `participant.joined`, `room.ended`) while the SDK decoder expected canonical `type/payload`, producing `WS_PARSE_ERROR` and dropping those events.
- Fixes:
  - `sdk-core`: removed manual RTK reconnect loop; map RTK `roomLeft` disconnected -> Chalk `reconnecting`, `roomLeft` failed -> Chalk `failed`.
  - `sdk-core`: suspend/reapply background middleware across reconnects and set RTK middleware global config best-effort for the background transformer.
  - `sdk-core`: decoder now accepts legacy `event/data` websocket envelopes and normalizes legacy `participant.joined` payloads.
  - `apps/api`: participant join/leave and room-ended broadcasts now emit canonical `type/payload` websocket messages.
- Regression coverage:
  - RTK reconnect state tests
  - background suspend/reapply test
  - websocket legacy-envelope compatibility tests
  - Go participant leave websocket-envelope test

## 2026-03-28 18:36 PKT

- Follow-up from fresh browser log: join completed successfully with `audio=false` / `video=false`, then a persisted background effect still applied and RTK virtual-background started throwing repeated `UnhandledRejection ... ice connection failed`.
- Root cause 4: Chalk treated “selected background effect” as “safe to attach middleware now”, even when the local camera was disabled and there was no live local video track.
- Fixes:
  - `sdk-core`: background controller now stores the selected effect first, but defers middleware attachment until `self.videoEnabled === true` and `self.videoTrack` is live+enabled.
  - `sdk-core`: toggling camera off now suspends background middleware immediately while preserving the selected effect for later reapply.
  - `sdk-core`: background apply telemetry now includes local video-track diagnostics for faster future triage.
- Regression coverage:
  - background controller test proving selection while camera-off does not initialize RTK middleware, but later reapplies once a live video track exists
- Browser verification:
  - `npx -y agent-browser` against `http://localhost:3070`
  - joined room with camera off
  - opened Settings -> Video -> selected Blur
  - waited 5s; no `Connection Failed` dialog surfaced
  - screenshots: `scratchpad/agent-browser-shots/screenshot-1774701292341.png`, `scratchpad/agent-browser-shots/screenshot-1774701320660.png`

## 2026-03-28 18:52 PKT

- User still reported `chunk-TFHWZHIZ.js ... TransportConnectionError ... ice connection failed` after the earlier camera-off deferral patch.
- Extra root cause: the RTK virtual-background package renders from `meeting.self.rawVideoTrack`, not just `meeting.self.videoTrack`. Our previous guard only checked the published/local track, so a stale or unavailable raw camera track could still leave middleware eligible and keep the render loop alive into ICE failure.
- Fixes:
  - `sdk-core`: background controller now also requires a live+enabled `rawVideoTrack` when RTK exposes one, and if that precondition is not met it actively suspends stale middleware while preserving the selected effect.
  - `sdk-core`: RTK local `videoUpdate` now suspends background middleware when local video becomes unavailable and reapplies it when RTK publishes a fresh live local video track.
- Regression coverage:
  - background controller test now proves a dead `rawVideoTrack` still defers middleware init
  - RTK room tests now prove local `videoUpdate` suspends/reapplies background effects
