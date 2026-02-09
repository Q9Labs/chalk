# Chalk Android App (prototype)

Specs: `apps/native/SPEC.md`  
Tasks: `apps/native/TASKS.md`  
Progress log: `apps/native/PROGRESS.md`

## Dev run (local)

1) Open `apps/android` in Android Studio.
2) Run the `app` configuration on a device/emulator.

Join flow (for now): paste a join payload (from backend) containing:
- `wsUrl` (e.g. `wss://chalk-api.q9labs.ai/ws`)
- `accessToken` (Chalk WS token)
- `rtcToken` (RealtimeKit auth token)
- `roomId`, `participantId`, `displayName`

