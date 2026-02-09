# Chalk iOS App (prototype)

Specs: `apps/native/SPEC.md`  
Tasks: `apps/native/TASKS.md`  
Progress log: `apps/native/PROGRESS.md`

This repo intentionally keeps iOS as apps-first. We are not publishing an iOS SDK yet.

## What exists here

- `apps/ios/ChalkMeetingKit` Swift Package: MeetingKit (WS + RTK wrapper + state)
- `apps/ios/ChalkNativeApp` sample SwiftUI app code (drop into an Xcode iOS app target)

## Create the Xcode app target (one-time)

1) Xcode: File -> New -> Project -> iOS -> App
2) Name: `ChalkNativeApp`
3) Add local package dependency:
   - Add Package -> Add Local -> `apps/ios/ChalkMeetingKit`
4) Add RTK dependency (SPM):
   - Package URL: `https://github.com/dyte-in/RealtimeKitCoreiOS.git`
5) Info.plist:
   - Camera, Microphone, Bluetooth usage strings

Join flow (for now): paste a join payload (from backend) containing:
- `wsUrl` (e.g. `wss://chalk-api.q9labs.ai/ws`)
- `accessToken` (Chalk WS token)
- `rtcToken` (RealtimeKit auth token)
- `roomId`, `participantId`, `displayName`

