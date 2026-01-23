# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.39] - 2026-01-23

### Added

- **Meeting End page** - Post-meeting summary screen at `/room/end`
  - Shows meeting duration and participant count (from localStorage data)
  - Star rating feedback form with hover interactions
  - Action buttons: Rejoin, New Meeting, Home
  - Follows app theme system (light/dark mode support)
  - Room page now navigates here on meeting end

- **shadcn/ui components** - Added base-nova style shadcn components
  - Button, Card, Input, Badge, Tooltip, Toggle, ToggleGroup
  - Available via `ui` namespace: `import { ui } from '@q9labs/chalk-react'`
  - Uses `@base-ui/react` primitives with `class-variance-authority`
  - MeetingRoom layout switcher now uses shadcn Toggle + Tooltip
  - ChatPanel and ParticipantList use shadcn Button

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

- **WhiteboardPanel state persistence** - Close no longer destroys whiteboard state
  - Added `isVisible` prop to control visibility without unmounting
  - MeetingRoom now keeps WhiteboardPanel mounted (hidden) instead of conditional render
  - Drawings persist locally when closing and reopening whiteboard

- **WhiteboardPanel branding** - Removed Excalidraw branding from UI
  - Added `renderTopRightUI: () => null` to hide help button and social links

- **WhiteboardPanel header** - Redesigned with floating glassmorphism pills
  - Removed solid header bar for cleaner canvas-first experience
  - Top-left: Title pill with pencil icon
  - Top-right: Actions pill with permission controls (host) and close button
  - Bottom-left: Status pill showing "You can draw" or "View only" with teal/red indicator dot
  - Matches MeetingRoom aesthetic (backdrop-blur-md, bg-black/50, border-white/10)

- **Favicon** - Updated to Chalk icon (colorful chalk sticks)

- **MeetingRoom UI revamp** - Aligned with PreJoinLobby design patterns
  - Layout switcher: Replaced text buttons with icon buttons (Grid, Spotlight, Sidebar) with tooltips
  - Active layout state uses brand teal (#1bb6a6) background
  - Hand icon: Changed from pointing down to waving hand (raised hand gesture)
  - Muted state: Updated red color from #EF4444 to #dc2626 (darker, more cohesive)
  - Removed "More" and "Info" buttons from desktop ControlBar
  - Side panels: Applied glassmorphism (bg-card/80 backdrop-blur-xl) with rounded-2xl corners

- **Teal-themed color palette** - Updated video tile accents and avatars
  - colorGenerator: Replaced mixed color palettes with teal/cyan spectrum
  - Avatar gradients: Updated pairs to teal-themed options (brand teal, emerald, cyan, etc.)

- **Panel UI modernization** - ChatPanel, TranscriptionPanel, ParticipantsPanel
  - Transparent backgrounds to work with glassmorphic parent container
  - ChatPanel: Teal-themed empty state icon, improved input field with focus ring
  - TranscriptionPanel: Custom teal "Live" badge, styled empty state
  - ParticipantList: Semantic color tokens, teal "Add people" button with shadow

- **Landing page redesign** - Consumer-ready landing page replacing developer-focused design
  - Hero section with inline meeting join flow and `/public/devices-with-video.png` illustration
  - Trust bar with encryption, HD video, browser-based, and free messaging
  - 4 feature cards: Crystal Clear Quality, One-Click Meetings, Private & Secure, Works Everywhere
  - How It Works: 3-step process (Click Start, Share Link, Start Talking)
  - Use Cases: Remote Work, Education, Stay Connected
  - Final CTA section with prominent "Start Your Free Meeting" button
  - Updated primary color to #1bb6a6 (custom teal)
  - Removed developer content (GitHub link, code snippets, SDK references)
  - Start Meeting buttons open room in new tab

- **Theme toggle improvements** - Moved below header (top-20) with higher z-index, replaced lucide Sun/Moon with hugeicons

- **React SDK shadcn migration** - Migrated components to shadcn design patterns
  - **Tier 1 (Atomic)**: Badge, Input, Textarea, Select, Toggle, Tooltip, Toast, ProgressBar, Skeleton, Spinner, IconButton
  - **Tier 2 (Composite)**: ControlButton, StatusBadge, VolumeSlider, InviteModal, SettingsPanel, ChatPanel, TranscriptionPanel, NotificationStack, DeviceSelector, MeetingHeader, MessageBubble, WaitingRoom, BackgroundEffectsPicker, ReactionPicker
  - **Tier 3 (Domain)**: VideoTile, Avatar, TourTooltip, ScreenShareView, MobilePanel, MobileControlSheet
  - New dependencies: `@base-ui/react`, `@hugeicons/react`, `@hugeicons/core-free-icons`, `sonner`, `tw-animate-css`
  - Icon wrapper utility at `src/utils/icons.tsx` for HugeIcons compatibility
  - CSS variables updated to shadcn oklch color system with chalk fallbacks
  - All components maintain backward compatibility with existing APIs
  - Added `toast` export from NotificationStack for programmatic toast triggering

- **CSS consolidated into single styles.css** - Simplified CSS architecture
  - Merged `variables.css`, `base.css`, `animations.css`, `bundled.css` into single `styles.css`
  - Import path: `@q9labs/chalk-react/styles.css`
  - Uses shadcn oklch color system with teal primary (`oklch(0.60 0.10 185)`)
  - Semantic tokens: `--primary`, `--foreground`, `--card`, `--muted`, `--destructive`, `--success`, `--warning`
  - Video-specific variables preserved: `--chalk-bg-stage`, `--chalk-bg-tile`, `--chalk-accent-speaking`, `--chalk-shadow-*`, `--chalk-pill-*`

### Fixed

- **Transcription pipeline** - Fixed end-to-end transcription from Cloudflare RTK to UI
  - Fixed field mapping in `room.ts` - Cloudflare sends `transcript`, `isPartialTranscript`, `peerId`, `name`, `date` but SDK expected `text`, `isInterim`, `participantId`, `speakerName`, `timestamp`
  - Connected `useTranscripts` hook output to `MeetingRoom` component via `VideoConference`
  - Backend persistence: Final transcripts sent to Go API via WebSocket for database storage

- **WhiteboardPanel CSS flash** - Added CSS load tracking to prevent unstyled flash
  - Loader now shows until both Excalidraw and CSS are fully loaded
  - CSS load state tracked via `onload` handler

- **PreJoinLobby theme toggle** - Now syncs with document.documentElement so theme changes work when used within apps that have ThemeProvider

- **Light mode support for panels** - Fixed ParticipantList, ChatPanel, and TranscriptionPanel for light mode:
  - ParticipantList: Replaced hardcoded dark background with semantic `bg-card`
  - TranscriptionPanel: Updated speaker colors from white to colors visible on both light/dark backgrounds

- **Whiteboard canvas** - Now defaults to dark background (#121212) for better drawing experience regardless of app theme

- **RTK room join reliability** - Increased timeout and added retry logic
  - Timeout increased from 10s to 30s per attempt
  - Added exponential backoff retries (500ms, 1s, 2s delays) for up to 4 total attempts
  - Reduces user-facing errors from transient network issues during room join

- **Faster room join** - Parallelized WebSocket and RTK connections
  - WebSocket now connects in parallel with RTK join instead of sequentially
  - Reduced retry delays from (2s, 4s, 8s) to (500ms, 1s, 2s)
  - Saves 100-500ms on typical join, up to 10s on retries

- **Recording recovery for missed webhooks** - Recordings are now automatically recovered when Cloudflare webhook is missed
  - Root cause: `RecordingChecker` job detected ready recordings in Cloudflare but only logged a TODO instead of downloading them
  - Symptom: Recordings stuck in "processing" status forever, video files never persisted to R2
  - Fix: Added `RecoverRecording` method to recording service that downloads from Cloudflare and uploads to R2
  - The background job now automatically recovers stalled recordings older than 1 hour

- **WebSocket heartbeat timeout** - Server now responds to client ping messages with pong
  - Root cause: SDK client sends pings expecting pong response, but server only sent pings (didn't respond to them)
  - Symptom: "Heartbeat timeout - no pong received" after 75 seconds
  - Fix: Added `ping` message handler in WebSocket client that responds with `pong`

## [0.0.38] - 2026-01-21

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
