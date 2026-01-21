# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.38] - 2026-01-21

### Added

- **Health endpoint uptime** - `/health` response now includes `uptime` field showing server uptime in seconds

### Fixed

- **WebSocket disconnect bug** - Fixed premature WebSocket disconnection (~628ms after connection)
  - Root cause: WebSocket context was derived from `c.Request.Context()` (HTTP request lifecycle)
  - When HTTP upgrade completed, context canceled, terminating `conn.Read(ctx)` immediately
  - Fix: Use `context.Background()` to decouple WebSocket lifetime from HTTP request
  - Added context cancellation logging to readPump/writePump for future debugging

- **SDK WebSocket error logging** - Improved error visibility for debugging connection issues
  - `onclose`: Now logs close code with human-readable description, wasClean flag, and connection state
  - `onerror`: Extracts ErrorEvent details (message, filename, lineno, error) when available
  - Connection errors now include full stack traces and context (roomId, URL)

- **WebSocket infrastructure** - Fixed WebSocket connections not reaching backend
  - Root cause 1: VPC Link V2 (HTTP API) doesn't support WebSocket upgrade
  - Root cause 2: API Gateway doesn't allow mixing WebSocket and HTTP APIs on same custom domain
  - Fix: Created separate WebSocket subdomain (`chalk-ws.q9labs.ai`) pointing directly to ALB
  - WebSocket traffic now flows: Cloudflare → ALB → ECS (bypasses API Gateway)
  - HTTP traffic still flows: Cloudflare → API Gateway → ALB → ECS

- **Excalidraw fonts 404** - Fixed missing font files for whiteboard component
  - CSS referenced relative font paths (`./fonts/Assistant/*.woff2`) that weren't being copied
  - Updated `postinstall` to copy fonts directory alongside CSS

- **Excalidraw CSS loading for SDK consumers** - WhiteboardPanel now loads CSS from CDN by default
  - Changed default `excalidrawCssPath` from `/vendor/excalidraw.css` to jsDelivr CDN
  - Fonts load automatically via relative paths in the CDN-hosted CSS
  - Consumers can still self-host by passing a custom `excalidrawCssPath` prop
  - Exported `EXCALIDRAW_CSS_CDN` constant for reference

### Changed

- **Mobile call screen** - Created call screen using VideoConference component
  - Reads roomId and create flag from useLocalSearchParams
  - If create=true, creates room first via useChalk().createRoom()
  - Renders VideoConference component with onLeave returning to landing page
  - Loading state while creating room, error handling for failures

- **Mobile app landing page** - Created landing page for mobile app
  - App branding with Chalk logo and tagline
  - "Start Meeting" button generates UUID and navigates to /call?roomId=xxx&create=true
  - "Join Meeting" button reveals TextInput for room ID entry
  - Settings gear icon in header navigates to /settings
  - Dark theme consistent with mobile app design

- **Mobile app navigation structure** - Updated root layout for new consumer flow
  - Stack navigator with index, call, settings screens
  - Header hidden for call screen (fullscreen video experience)
  - ChalkProvider wrapper preserved with tokenProvider

- **Mobile app test harness cleanup** - Removed test harness screens from mobile demo app
  - Deleted `apps/mobile/app/(tabs)/` - tabs navigation and test screens
  - Deleted `apps/mobile/app/hooks/` - individual hook test screens
  - Deleted `apps/mobile/app/components/` - component test screens
  - Deleted `apps/mobile/app/e2e/` - end-to-end flow test screens
  - Deleted `apps/mobile/components/test/` - test utilities
  - Updated `_layout.tsx` to use Stack with single index route
  - Added placeholder `index.tsx` for landing page (to be implemented)

### Added

- **`VideoConference` component** - Turnkey orchestrator component for React Native SDK
  - State machine: lobby → joining → connected → ended
  - Combines PreJoinLobby and MeetingRoom into single entry point
  - Props: roomId (string), displayName (optional string), onLeave (() => void)
  - Error handling with retry option
  - Loading state during room join

- **`MeetingRoom` component** - Turnkey meeting room screen for React Native SDK
  - VideoGrid showing all participants with responsive layout
  - ControlBar at bottom wired to useMedia toggles
  - ChatPanel in @gorhom/bottom-sheet, toggled via chat button
  - ScreenShareView shown prominently when screen share is active
  - Uses useParticipants, useMedia, useChat, and useScreenShare hooks
  - onLeave callback when user leaves the meeting

- **`PreJoinLobby` component** - Turnkey pre-call setup screen for React Native SDK
  - Camera preview using VideoView or Avatar fallback
  - Device selector buttons for camera and microphone
  - Display name TextInput
  - Join button disabled until permissions granted and name entered
  - Uses usePermissions, useDevices, and useLocalStream hooks
  - Pure StyleSheet implementation

- **`@gorhom/bottom-sheet` dependency** - Added as peer dependency to React Native SDK for turnkey components
  - Also added `react-native-gesture-handler` as peer dependency (required by bottom-sheet)
  - Build script updated to externalize both packages

- **`DeviceSelector` component** - Modal device picker for React Native SDK
  - Modal with list of available camera or microphone devices
  - Each row shows device name with checkmark if selected
  - Tap selects device and closes modal
  - Header: "Select Camera" or "Select Microphone" based on type
  - Pure StyleSheet implementation with no external dependencies

- **`ChatPanel` component** - Chat message panel for React Native SDK
  - FlatList of messages with sender name, content, and timestamp
  - Local user messages right-aligned blue, others left-aligned gray
  - Bottom TextInput with send button
  - Auto-scrolls to bottom on new messages
  - Keyboard-aware layout using KeyboardAvoidingView

- **`ControlBar` component** - Horizontal meeting control bar for React Native SDK
  - 5 buttons: mic, video, screen-share, chat, leave
  - Active states show filled icons, inactive show outlined with slash
  - Pure StyleSheet implementation with no external icon dependencies
  - Configurable callbacks for all controls

- **`StatusBadge` component** - Circular status badges for React Native SDK
  - Three types: muted (red mic-off), speaking (green waveform), hand-raised (yellow hand)
  - Pure StyleSheet implementation with no external dependencies
  - Configurable size prop

- **`AudioIndicator` component** - Animated speaking visualization for React Native SDK
  - 3 vertical bars that animate based on audio level using react-native-reanimated
  - Green when active, gray when inactive
  - Configurable size prop

- **`demoMode` config option** - Separated demo API endpoint selection from debug logging
  - `debug` now only controls console logging output
  - `demoMode` controls whether to use `demoJoin` vs `addParticipant` API endpoints
  - Available in `ChalkClientConfig`, `ChalkSessionConfig`, and both React/React Native providers

- **Transcription support** - Native transcription for Chalk conferences using Cloudflare RealtimeKit AI
  - Per-tenant transcription config (enable/disable, language, profanity filter, keywords)
  - Automatic passing of `ai_config` to Cloudflare when creating meetings
  - Transcripts stored in database per room/participant with deduplication
  - Client SDK automatically sends final transcripts to backend via WebSocket
  - REST API endpoint: `GET /api/v1/rooms/:id/transcripts` for retrieving transcripts
  - New database migration: `006_transcription.sql`

## [0.0.37] - 2026-01-19

### Fixed

- **CSS comment syntax** - Removed quotes from chalk-ui CSS comment that caused PostCSS parse error

## [0.0.36] - 2026-01-19

### Fixed

- **CSS @layer compatibility** - Fixed pre-built CSS exports breaking in Next.js and other PostCSS environments
  - `@q9labs/chalk-react`: Now copies hand-crafted `bundled.css` without Tailwind's `@layer` wrappers
  - `@q9labs/chalk-ui`: Simplified CSS output without `@layer` directives
  - Consumers no longer get `@layer base is used but no matching @tailwind base` errors

## [0.0.35] - 2026-01-19

### Fixed

- **npm EUNSUPPORTEDPROTOCOL** - Switched SDK publish workflow from `npm publish` to `bun publish` to properly replace `workspace:^` references with actual version numbers

## [0.0.34] - 2026-01-19

### Added

- **Stress testing framework** - Comprehensive load testing infrastructure for Chalk API
  - k6 test scenarios: smoke, room-creation, participant-churn, large-room, ws-storm
  - Artillery WebSocket scenarios for chat and whiteboard load testing
  - Custom Go WebRTC client with Prometheus metrics for media stress testing
  - Terraform infrastructure for isolated stress test environment (ECS, Aurora, ElastiCache)
  - Execution scripts with auto-appending results to persistent markdown report
  - Scripts run from any directory (use `SCRIPT_DIR` / `PROJECT_ROOT` detection)
  - Prerequisites validation (k6, jq, terraform) with helpful error messages
  - Directory: `tests/load/` (k6, artillery, webrtc-client), `tests/infrastructure/terraform/stress-test/`

- **Mobile UI support in MeetingRoom** - Integrated MobilePanel for full-screen chat, participants, and transcription on mobile devices
  - Uses `useIsMobile()` hook for responsive detection
  - Full-screen swipe-to-dismiss panels replace desktop sidebar on mobile
  - Adjusted padding and hidden layout switcher on mobile
  - Grid layout forced on mobile for optimal viewing

### Changed

- **CI/CD performance optimization** - Added caching to all workflows
  - SDK/Web workflows: Bun dependency caching (~60-90s savings per job)
  - Infrastructure workflow: Terraform provider caching (~30s savings per job)

### Fixed

- **Infrastructure CI/CD failure** - Removed invalid `cloudflare_sfu_app_id` output that referenced non-existent module attribute
- **API workflow force_deploy not working** - Jobs with `needs` dependencies skip before evaluating `if` conditions unless using `always()`. Added explicit checks for `docker` and `deploy` jobs so `force_deploy` works correctly from manual triggers

## [0.0.21-0.0.28] - 2026-01-17

_Versions 0.0.21-0.0.25 had CI/publish issues. First stable version: 0.0.26._

### Added

- **Pre-built CSS exports** - `@q9labs/chalk-ui/styles.css` and `@q9labs/chalk-react/styles.css` for Next.js compatibility

### Changed

- **CI runner optimization** - Switched non-Docker/Terraform jobs to `ubuntu-latest`

### Fixed

- **GitHub Packages publish auth** - Changed to `GITHUB_TOKEN` for publishing
- **Web build OOM** - Increased Node.js heap to 4GB for SSR builds
- **Web prerender failure** - Skip ChalkProvider during SSR
- **SDK CI/CD workflow** - Fixed GitHub Packages auth, workspace protocol, lockfile handling
- **npm peer dependency conflict** - Removed `react-native` and `typescript` from required peerDependencies
- **npm EUNSUPPORTEDPROTOCOL** - Changed to `bun publish` to handle `workspace:` protocol

## [0.0.20] - 2026-01-16

### Added

#### Mobile Test App

- **`apps/mobile`** - Expo bare workflow app for testing `@q9labs/chalk-react-native` SDK
  - Dashboard with grid navigation to all test screens
  - 14 hook test screens: useRoom, useMedia, useParticipants, useDevices, usePermissions, useChat, useRecording, useScreenShare, useAudioRouting, useCallKit, useForegroundService, useInteractions, useHandRaise, useLocalStream
  - 5 component test screens: VideoView, ScreenShareView, ParticipantTile, VideoGrid, AudioSession
  - 2 E2E flow screens: Pre-call flow (permissions, devices, preview), Full call flow (join, interact, leave)
  - Metro config for monorepo workspace resolution
  - iOS/Android native permissions configured for camera, microphone, VoIP background modes

#### SDK-Core

- **`createTokenProvider` utility** - Handles complete auth flow (API key → JWT with auto-refresh)
  - Browser support with `sessionStorage` (default) or `localStorage`
  - Custom `TokenStorage` interface for React Native (`AsyncStorage`) and SSR
  - Concurrent refresh request serialization
  - Automatic fallback to API key when refresh fails

#### API

- **`PATCH /api/v1/tenants/:id/config`** - Update tenant configuration via API
  - Supports `force_recording`, `auto_start_recording`, `allow_early_join`
  - Additional options: `empty_room_timeout_minutes`, `recording_retention_days`, `duplicate_participant_policy`
  - Requires API key authentication, enforces tenant ownership

#### SDK-React-Native

- **Cloudflare RTK integration** - Integrated `@cloudflare/realtimekit-react-native` for WebRTC signaling
  - ChalkProvider now uses RTK hooks for room joining and media streaming
  - Requires `@cloudflare/react-native-webrtc` instead of `react-native-webrtc`
  - APIClient from chalk-core exported for React Native use
  - All hooks updated to use RTK client for media controls and participant state
- **Remote audio handling** - CallScreen now wrapped in AudioSession for proper audio routing
  - iOS: AVAudioSession configured for PlayAndRecord mode
  - Android: Audio focus management enabled
  - React Native WebRTC auto-plays remote audio tracks (no AudioRenderer needed)

### Fixed

#### SDK-React-Native

- **iOS permission detection** - `usePermissions` now correctly detects granted camera/microphone permissions on iOS using native AVFoundation APIs via `PermissionsModule.swift`. Previously always showed "unavailable".
- **Swift compilation errors** - Fixed deprecated `nativeCallConferencingSupported` in CallKitModule and incorrect `AVAudioSession.Port` enum values in AudioSessionModule.
- **Infinite re-render loop** - Fixed `checkPermissions` callback causing "Maximum update depth exceeded" error due to `permissions` state in dependency array.

### Added

#### SDK-React-Native

- **PermissionsModule** (`packages/sdk-react-native/ios/PermissionsModule.swift`) - Native iOS module for checking/requesting camera and microphone permissions via AVFoundation
- **Native iOS modules** (`packages/sdk-react-native/ios/`)
  - `AudioSessionModule.swift` - AVAudioSession for VoIP, speaker/earpiece/bluetooth routing
  - `CallKitModule.swift` - Native call UI, lock screen integration, CarPlay support
  - `ChalkReactNative.podspec` - CocoaPods configuration
- **Native Android modules** (`packages/sdk-react-native/android/`)
  - `AudioSessionModule.kt` - AudioManager, audio focus, bluetooth SCO
  - `CallServiceModule.kt` - Foreground service for background audio
  - Gradle build configuration with Kotlin 1.9.22
- **New hooks**
  - `useCallKit` - iOS CallKit integration (reportIncomingCall, reportCallEnded, etc.)
  - `useForegroundService` - Android foreground service control
  - `useInteractions` - Hand raise and reactions
  - `useHandRaise` - Convenience wrapper for hand raise only
- **Updated components**
  - `AudioSession.tsx` - Now calls native modules for audio routing
  - `useBluetoothAudio` - Real device detection and routing
- **Example app** (`packages/sdk-react-native/example/`)
  - Full iOS and Android configuration for React Native 0.76.x
  - Three-screen flow: Home, PreCall (permissions), Call
  - Metro config for monorepo module resolution

#### SDK-Core

- Effect-based manager services: RoomService, ParticipantService, MediaService
  - SubscriptionRef for observable state (replaces StateContainer)
  - PubSub for typed events (replaces TypedEventEmitter internally)
  - Semaphore for concurrent operation protection (join/toggle serialization)
- Manager state schemas with type inference (`effect/schemas/manager-state.ts`)
- RoomInstanceService for shared Room reference across services
- Layer composition helpers (`makeManagerServicesLayer`, `makeManagerRuntime`)

### Changed

#### SDK-Core

- **ChalkSession** now uses Effect services internally (RoomService, ParticipantService, MediaService)
  - Same public API maintained for backwards compatibility
  - `room`, `participants`, `media` objects delegate to Effect services via ManagedRuntime
  - State updates via SubscriptionRef, events via PubSub

### Removed

#### SDK-Core

- `RoomManager` class - replaced by Effect-based RoomService
- `ParticipantManager` class - replaced by Effect-based ParticipantService
- `MediaManager` class - replaced by Effect-based MediaService

### Fixed

#### Tests

- Updated 12 handler tests to align with security fix behavior (auth checks, token types, CORS)
- Fixed handler order: JSON parsing before auth for proper 400 vs 403 responses

#### SDK-React

- Added type declarations for `@cloudflare/realtimekit-react` module
- Fixed false "Connection Failed" overlay showing on room join - `"disconnected"` status was incorrectly mapped to `"failed"`
- Fixed video/audio tracks not updating in UI - added state bridges from Room events to session state for React hooks
- Fixed HMR causing session destruction - sessions now cached and preserved across hot module replacement

#### SDK-Core

- Fixed missing state bridge between Effect services and session state objects - participant/media updates now properly propagate to React hooks

#### API - Critical

- Tenant ownership bypass: API endpoints now verify path ID matches authenticated tenant (API-CRIT-01)
- Cross-tenant access: Room/participant/recording handlers scope queries by JWT claims (API-CRIT-02)

#### API - High

- JWT hardcoded secret: Config now loaded from env; production fails fast on dev secrets (API-HIGH-01)
- Token type validation: `ValidateToken` enforces `TokenType == "access"` (API-HIGH-02)
- WebSocket CSWSH: Origin checking enabled; query param token deprecated (API-HIGH-03)
- Permission authorization: Host role required for grant/revoke operations (API-HIGH-04)
- Recording permissions: `RequireHost()` middleware added to start/stop/archive (API-HIGH-05)
- Recording status constraint: Migration adds 'failed' status (API-HIGH-06)
- Webhook body consumption: Body reset after signature verification (API-HIGH-07)
- Participant nil dereference: `GetParticipant` error now checked (API-HIGH-08)

#### API - Medium

- O(n) API key lookup: Paginated search replaces hard 1000 limit (API-MED-01)
- Demo tenant creation: Uses known name instead of arbitrary first tenant (API-MED-02)
- DB port config: Now parsed from environment instead of hardcoded 5432 (API-MED-03)
- S3/R2 error detection: Uses `errors.As` for proper NotFound handling (API-MED-05)
- CORS credentials: Only set when origin is allowed; added `Vary: Origin` (API-MED-06)
- Health endpoint: No longer exposes internal DB error details (API-MED-07)
- Cloudflare mocks: All client methods now have demo mode fallbacks (API-MED-08)
- Redis TTLs: Participant state uses pipeline with TTL on add (API-MED-09)
- Redis nil handling: `GetRecordingState` treats nil as "no recording" (API-MED-10)

#### SDK-Core - High

- Token fallback: Removed `authToken` fallback; throws `AUTH_FAILED` if missing (SDKCORE-HIGH-01)

#### SDK-Core - Medium

- Empty response handling: 204/empty responses handled before JSON parse (SDKCORE-MED-01)
- Refresh serialization: Concurrent refresh requests now share a single promise (SDKCORE-MED-02)
- Node.js compatibility: `isTokenExpired` uses `Buffer.from` fallback (SDKCORE-MED-03)
- Memory leak: Resize handler stored for proper cleanup (SDKCORE-MED-06)
- Toggle locks: Separate locks for audio/video operations (SDKCORE-MED-07)

#### SDK-Core - Low

- Heartbeat timeout: 2.5x interval without pong triggers reconnect (SDKCORE-LOW-01)

### Added

- Migration `005_add_failed_recording_status.sql` for recording status constraint
- Effect-TS foundation for SDK-Core internal async/state/validation patterns:
  - `src/effect/errors.ts`: Tagged error types with exhaustive matching
  - `src/effect/services.ts`: Context Tags for dependency injection (TokenService, LoggerService, etc.)
  - `src/effect/runtime.ts`: Bridge between Effect internals and Promise-based public API
  - `src/effect/token-service.ts`: Token management with exponential backoff retry
  - `src/effect/connection.ts`: Scoped resources with acquireRelease for RTK/WebSocket
  - `src/effect/websocket.ts`: Reconnect schedules, heartbeat fibers, message queues
  - `src/effect/schemas/ws-events.ts`: Runtime validation schemas for WS payloads
  - `src/effect/schemas/api.ts`: Runtime validation schemas for API responses

### Changed

- `client.ts`: Integrated Effect patterns into `joinRoom`:
  - Replaced `isJoining` boolean with `OperationLock` for serialized joins
  - Added `_initRealtimeKitEffect` for RTK init with typed `ConnectionError`
  - Added `_joinRealtimeKitEffect` for RTK join with `Effect.timeout` handling
  - Public API unchanged (still returns `Promise<Room>`)
