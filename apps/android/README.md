# Chalk Android App (prototype)

Specs: `apps/native/SPEC.md`  
Tasks: `apps/native/TASKS.md`  
Progress log: `apps/native/PROGRESS.md`

## Dev run (local)

1) Open `apps/android` in Android Studio.
2) Run the `app` configuration on a device/emulator.

## Dev run (CLI)

Build APK:
```bash
bun run android:assemble
```

Install to a connected device/emulator:
```bash
bun run android:install
```

Install + launch:
```bash
bun run android:run
```

## Join payload

Join flow (for now): paste a join payload (from backend) containing:
- `wsUrl` (e.g. `wss://chalk-ws.q9labs.ai/ws`)
- `accessToken` (Chalk WS token)
- `rtcToken` (RealtimeKit auth token)
- `roomId`, `participantId`, `displayName`
