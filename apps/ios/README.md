# Chalk iOS App (prototype)

Specs: `apps/native/SPEC.md`  
Tasks: `apps/native/TASKS.md`  
Progress log: `apps/native/PROGRESS.md`

This repo intentionally keeps iOS as apps-first. We are not publishing an iOS SDK yet.

## What exists here

- `apps/ios/ChalkMeetingKit` Swift Package: MeetingKit (WS + RTK wrapper + state)
- `apps/ios/ChalkNativeApp` Xcode project + sample SwiftUI app

## Run (Xcode)

1) Open `apps/ios/ChalkNativeApp/ChalkNativeApp.xcodeproj`
2) Select scheme: `ChalkNativeApp`
3) Select destination: iOS Simulator (arm64)
4) Run

## Run (CLI)

Build:
```bash
bun run ios:build
```

Build + install + launch in Simulator:
```bash
bun run ios:run
```

## Note: Simulator arch

RealtimeKit SPM artifact currently missing `x86_64` iOS Simulator slice; default "universal" Simulator builds will fail.

Use:
- arm64 Simulator (Apple Silicon)
- or the scripts above (force `ARCHS=arm64`)

## Join payload

Join flow (for now): paste a join payload (from backend) containing:
- `wsUrl` (e.g. `wss://chalk-api.q9labs.ai/ws`)
- `accessToken` (Chalk WS token)
- `rtcToken` (RealtimeKit auth token)
- `roomId`, `participantId`, `displayName`
