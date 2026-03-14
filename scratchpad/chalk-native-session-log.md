# Chalk Native Apps — Session Log

Append-only. Short entries. Link commits. Keep everyone aligned.

## 2026-02-09

- **UI Implementation (Vertical Slice)**:
  - **iOS (SwiftUI)**:
    - Implemented `LobbyView` with device preview and controls.
    - Implemented `MeetingView` with dynamic participant grid (adapts to 1-2 vs 3+ users).
    - Implemented `PanelView` architecture for Chat/Participants/Whiteboard overlays.
    - Wired navigation in `ContentView`.
    - Added `Theme.swift` with Chalk brand colors.
  - **Android (Compose)**:
    - Implemented `LobbyScreen` matching iOS design.
    - Implemented `MeetingScreen` with `LazyVerticalGrid` and panel overlays.
    - Implemented `ParticipantTile` component.
    - Updated `Theme.kt` and `ChalkNativeApp.kt` to use the new flow.

- Kickoff: native apps direction locked (iOS + Android), apps-first strategy, RTK for media, Chalk WS for product sync.
- Research added: screenshare + background/audio + Excalidraw integration approach documented under `apps/native/RESEARCH_*`.
- Android scaffold: `apps/android` Gradle project + `:meetingkit` with Chalk WS (subprotocol token) + RTK join skeleton; `./gradlew :app:assembleDebug` passes.
- iOS scaffold: `apps/ios/ChalkMeetingKit` Swift Package (WS + RTK join skeleton) + sample SwiftUI code under `apps/ios/ChalkNativeApp/Sample`.
- Whiteboard host scaffold: `apps/native/whiteboard-web` WebView host (Excalidraw + collab engine bridge) + build script.
- Android whiteboard bridge: WebView screen (`WhiteboardWebView.kt`), MeetingKit encoder (`ChalkWhiteboardWebViewCodec.kt`), and Gradle build-time assets pipeline (`:app:buildWhiteboardWeb` + `:app:copyWhiteboardAssets`).

## 2026-03-12

- `2026-03-12 16:53 PKT` planning resumed for official mobile app. Direction locked to `React Native`; concern discussed: RN native bridge risk vs Flutter plugin/native risk. Current conclusion: RN acceptable if treated as `RN + deliberate native layer`, not pure-JS magic.
- `2026-03-12 16:54 PKT` product language correction captured: keep planning role-neutral; avoid `student` / `teacher`; prefer existing neutral terms already present in codebase/docs for consistency.
