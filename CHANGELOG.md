# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Live transcription support** - Enables transcription via Cloudflare RealtimeKit presets
  - Backend: `transcription_enabled` field now sent to Cloudflare `AddParticipant` when tenant config has it enabled
  - React SDK: `onEnd` callback on `VideoConference` fires when meeting ends (leave or disconnect)
  - `MeetingEndData` includes `transcripts`, `duration`, `recordingId`, `participantCount` for consumers to persist

- **Role support for participants** - Added `role` prop to control participant permissions
  - SDK Core: `JoinOptions` and `RoomConfig` now accept `role?: "host" | "participant"`
  - React SDK: `VideoConference` accepts `role` prop, passed through to join
  - Host role triggers `force_recording` when configured in tenant settings

- **Auto-host for first participant** - New tenant config `first_participant_is_host`
  - When enabled, first participant to join a room automatically becomes host
  - Combined with `force_recording`, this auto-starts recording for every meeting

- **Manual recording recovery endpoint** - `POST /api/v1/recordings/:id/recover`
  - Manually triggers download from Cloudflare and upload to R2
  - Useful for local development where webhooks can't reach localhost
  - Returns recording status from Cloudflare if not yet ready

- **Recording sync from Cloudflare** - `POST /api/v1/rooms/:id/recordings/sync`
  - Imports recordings from Cloudflare that don't exist in our database
  - Handles `record_on_start` auto-recordings that bypassed our API
  - Returns list of synced recordings with their IDs for subsequent recovery

### Changed

- **React SDK shadcn migration** - Migrated components to shadcn design patterns
  - **Tier 1 (Atomic)**: Badge, Input, Textarea, Select, Toggle, Tooltip, Toast, ProgressBar, Skeleton, Spinner, IconButton
  - **Tier 2 (Composite)**: ControlButton, StatusBadge, VolumeSlider, InviteModal, SettingsPanel, ChatPanel, TranscriptionPanel, NotificationStack, DeviceSelector, MeetingHeader, MessageBubble, WaitingRoom, BackgroundEffectsPicker, ReactionPicker
  - **Tier 3 (Domain)**: VideoTile, Avatar, TourTooltip, ScreenShareView, MobilePanel, MobileControlSheet
  - New dependencies: `@base-ui/react`, `@hugeicons/react`, `@hugeicons/core-free-icons`, `sonner`, `tw-animate-css`
  - Icon wrapper utility at `src/utils/icons.tsx` for HugeIcons compatibility
  - CSS variables updated to shadcn oklch color system with chalk fallbacks
  - All components maintain backward compatibility with existing APIs
  - Added `toast` export from NotificationStack for programmatic toast triggering

### Fixed

- **Recording recovery for missed webhooks** - Recordings are now automatically recovered when Cloudflare webhook is missed
  - Root cause: `RecordingChecker` job detected ready recordings in Cloudflare but only logged a TODO instead of downloading them
  - Symptom: Recordings stuck in "processing" status forever, video files never persisted to R2
  - Fix: Added `RecoverRecording` method to recording service that downloads from Cloudflare and uploads to R2
  - The background job now automatically recovers stalled recordings older than 1 hour

## [0.0.39] - 2026-01-21

### Fixed

- **WebSocket heartbeat timeout** - Server now responds to client ping messages with pong
  - Root cause: SDK client sends pings expecting pong response, but server only sent pings (didn't respond to them)
  - Symptom: "Heartbeat timeout - no pong received" after 75 seconds
  - Fix: Added `ping` message handler in WebSocket client that responds with `pong`

### Changed

- **React SDK visual polish** - Refined design system for a more premium, polished feel
  - **Color palette**: Richer dark mode with subtle blue/purple undertones (`#0A0A0C`, `#12121A`)
  - **Glass effects**: New CSS variables for backdrop-blur surfaces (`--chalk-bg-glass`, `--chalk-bg-control`)
  - **Control buttons**: Glass morphism with layered shadows and smooth hover scale (1.04x)
