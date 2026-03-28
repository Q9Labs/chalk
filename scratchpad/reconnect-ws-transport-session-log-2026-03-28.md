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
