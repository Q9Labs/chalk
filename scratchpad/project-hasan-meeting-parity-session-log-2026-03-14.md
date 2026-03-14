# Chalk meeting parity session log

## 2026-03-14 14:17:11 PKT

- task: read SDK React pre-join lobby, loading screen, meeting room, surrounding web/core flow
- goal: write durable parity spec for cloning web behavior into mobile
- notes:
  - used parallel code reads + explorer subagents for prejoin, meeting room, and end-to-end flow
  - avoided unrelated dirty work in `apps/mobile` and `bun.lock`
  - output target: `docs/web-mobile-meeting-parity-spec.md`

## 2026-03-14 16:57:00 PKT

- scope expansion: Hasan asked for deeper parity audit across SDKs, logic, functionality, behavior, UI, UX
- findings so far:
  - web room route is thin; most maturity lives in `packages/sdk-react` turnkey flow
  - mobile app has custom `HomeScreen` / `LobbyScreen` / `RoomScreen` shell plus lightweight `packages/sdk-react-native`
  - parity gap likely split between missing native SDK surfaces and app-level placeholder UI
- next:
  - trace `useVideoConferenceController`, `PreJoinLobby`, `MeetingRoom`, session hooks
  - trace `sdk-react-native` provider/hooks + compare exposed capabilities vs web

## 2026-03-14 17:26:00 PKT

- discussion point: Hasan called out architectural inconsistency between web and mobile meeting flows
- confirmed:
  - `sdk-react-native` does use `ChalkSession` today via `ChalkNativeProvider`
  - inconsistency is not “mobile bypasses ChalkSession”; it is “web has provider + turnkey meeting UI stack, mobile has provider + manual app screens”
  - `ChalkProvider` from `sdk-react` has web-only concerns like HMR session cache and `beforeunload` cleanup
  - `ChalkSession` is mostly safe/cross-platform, but some subfeatures inside core are browser-aware or browser-only
- browser-specific / guarded areas noted:
  - `ChalkProvider` uses `window.beforeunload`
  - `UIManager` listens to `window.resize` and toggles `document.fullscreen`
  - background effects depend on browser virtual-background support and `window`
- architecture conclusion:
  - keep `ChalkSession` as shared core seam
  - do not try to reuse `sdk-react` turnkey components/provider directly in mobile
  - amend mobile toward a native turnkey layer in `sdk-react-native` analogous to web `sdk-react`

## 2026-03-14 17:14:43 PKT

- implementation started: converting parity audit into package-first native meeting architecture
- package work in flight:
  - added first-pass native hooks for room/media/devices/interactions/recording/screen share/layout/panels/whiteboard
  - added initial turnkey building blocks: `NativeMediaView`, `NativePreJoinLobby`, `NativeJoiningLoadingScreen`, `NativeEndScreen`
- current implementation target:
  - finish `NativeMeetingRoom` and `NativeVideoConference`
  - expand `sdk-react-native` exports so apps can consume a turnkey flow instead of manual screens
  - thin `apps/mobile` down to route/deeplink/token-provider glue plus home screen

## 2026-03-14 19:02:00 PKT

- implementation complete:
  - `sdk-react-native` now exports a native meeting facade: provider alias, full hook surface, `NativeVideoConference`, `NativeMeetingRoom`, `NativeMeetingPanel`, `NativePreJoinLobby`, `NativeMediaView`, joining and end screens
  - `apps/mobile` now renders the turnkey package meeting flow and only keeps deep link parsing, token-provider/auth glue, route state, and home entry locally
  - added RN WebRTC ambient typing shims needed because the mobile app typechecks package source directly from workspace paths
- verification:
  - `bun run --cwd packages/sdk-react-native check-types`
  - `bun run --cwd apps/mobile check-types`
  - `bun run check-types`
  - `bun run lint`
  - `bun run test`
