# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.0.48] - 2025-01-28

### Added

- **[chalk] debug logging prefix** - All post-meeting flow logs now use `[chalk]` prefix for easy filtering and tracing
  - Webhook handler: cloudflare webhook receive, recording download/upload, completion status
  - Post-meeting service: trigger, transcription queueing, webhook preparation
  - Transcription service: queue, process, presigned URL generation, API calls
  - Transcription worker: job processing, AI summary generation, webhook send
  - Webhook worker: delivery start, retry scheduling, success/failure tracking
  - Webhook service: payload building, delivery queueing
  - AI service: generation start, provider calls, result storage
  - OpenRouter provider: API request/response with timing
  - Groq provider: transcription request/response with timing

- **Cloudflare webhook registration** - API now registers webhooks with Cloudflare RealtimeKit
  - New `setup-webhook` CLI command (`go run ./cmd/setup-webhook`) for one-time webhook registration
  - Startup check logs warning if no webhook is configured (recordings will not be processed)
  - Webhook CRUD methods added to Cloudflare client (CreateWebhook, ListWebhooks, DeleteWebhook)
  - New config: `API_PUBLIC_URL`, `CLOUDFLARE_WEBHOOK_SECRET`

- **Comprehensive recording flow logging** - Debug and trace recording processing via Axiom
  - Webhook handler: signature verification, download/upload timing, completion status
  - R2 storage: upload/download with duration tracking
  - Recording service: start/stop with Cloudflare IDs
  - Transcription service: queue/process with provider and timing
  - Post-meeting orchestration: decision logging with config details
  - Workers: webhook delivery timing and retry tracking

- **Whisper GPU infrastructure** - Self-hosted transcription on EC2 GPU instances
  - Whisper module instantiated in production environment
  - ECR repository for whisper-worker Docker image
  - GitHub Actions workflow for whisper-worker builds
  - Secrets Manager integration for Redis auth token at runtime
  - Auto-scaling based on queue depth
  - Security group rule for Redis access

### Changed

- **API CI/CD optimization** - Reduced workflow time from ~4min to ~2min
  - Split `lint-and-test` into parallel `lint` and `test` jobs
  - Removed `-v` verbose flag from tests (failures still show full output)
  - Race detection (`-race`) now conditional: enabled on PRs only, skipped on master push
  - Added `.golangci.yml` with lean linter config (6 essential linters vs all defaults)

- **Documentation overhaul** - Complete rewrite of developer documentation
  - **New API docs**: Tenants (CRUD + config), Authentication (token/refresh), Transcription (post-meeting)
  - **Rewritten API docs**: Recordings (all 9 endpoints), Webhooks (comprehensive with signature verification examples), Rooms, Participants (with bulk and token refresh)
  - **Rewritten SDK docs**: VideoConference turnkey component with full TypeScript types
  - **Removed**: React Native, Core SDK, Testing, Pricing, Architecture docs (per plan)
  - **Updated**: Getting started guides with accurate auth flow and X-API-Key header

### Fixed

- **Audio breaking/cutting out during calls** - `AudioRenderer` cleanup effect was running on every participant update (video, speaking, transcription events), causing `srcObject=null` and `pause()` on each render. Moved cleanup to unmount-only effects to prevent audio interruptions
- **Missing database tables in production** - Embedded migration in `postgres.go` was missing tables from migrations 005-007 (transcripts, post_meeting_transcripts, webhook_deliveries, failed recording status)
- **post_meeting_webhook config now persists** - PATCH /api/v1/tenants/{id}/config was silently ignoring `post_meeting_webhook` field (missing from request struct and merge logic)

## [0.0.47] - 2026-01-26

### Added

- **Post-meeting transcription & webhooks** - Complete pipeline for post-meeting processing
  - **Multi-provider transcription**: Groq API (cloud, $0.04/hour) with BYOK support, self-hosted Whisper (optional)
  - **AI summaries**: OpenRouter integration for automatic meeting summaries and action items
  - **Webhook delivery**: HMAC-SHA256 signed webhooks with exponential backoff retry (5 attempts)
  - **Tenant configuration**: Per-tenant settings for `include_recording`, `include_transcript`, `include_summary`, `include_action_items`
  - **SDK webhook handler**: TypeScript utilities for signature verification (`createWebhookHandler`, `chalkWebhookMiddleware`)
  - **Terraform secrets**: Groq and OpenRouter API keys in AWS Secrets Manager
  - Database: `post_meeting_transcripts` and `webhook_deliveries` tables
  - New endpoints: `GET /api/v1/transcription/providers`, transcript status APIs

- **Mobile rebuild (apps/mobile2)** - New crash-resistant mobile app replacing apps/mobile
  - Locked architecture: New Architecture OFF, Hermes ON, Reanimated v3 only
  - Direct SDK imports (no lazy loading) for simpler debugging
  - Custom metro resolver blocking node: protocol imports
  - React-native export condition in sdk-react-native for browser-targeted RN builds
  - Verification script: `bun run mobile:verify` checks for common crash causes
  - Root scripts: `mobile:ios`, `mobile:android`, `mobile:start`, `mobile:prebuild`

### Changed

- **sdk-react: Sounds bundled as data URLs by default** - Zero-config sound effects
  - Base64 data URLs embedded in bundle (~690KB), no file copying needed
  - Works out of the box in Next.js and all frameworks
  - Optional `basePath` prop to use custom sound files instead

- **sdk-react-native: Dual build targets** - Now outputs both Node and React Native builds
  - `dist/index.js` - Node target (for testing, bundlers)
  - `dist/react-native/index.js` - Browser target (no node: imports, Metro-compatible)
  - Package exports include `react-native` condition for automatic resolution
  - Pinned reanimated peer dep from `>=3.0.0` to `^3.0.0` to block v4

- **sdk-react: Enhanced MeetingEndData** - Richer data for post-meeting processing
  - `participants[]` - Full participant history with join/leave times and roles
  - `totalParticipants` - Unique participant count (vs `participantCount` for peak concurrent)
  - `stats` - Feature usage (chat messages, reactions, hand raises, screen shares, whiteboard opens)
  - `startedAt`/`endedAt` timestamps and `hostId` for session context

- **sdk-react: In-meeting theme toggle** - Switch light/dark mode during calls
  - Sun/moon icon button in header controls bar
  - Smooth 300ms transitions on all color properties (`chalk-theme-transition` CSS class)
  - Persists to document.documentElement for app-wide sync

- **sdk-react: Video loading states** - Smoother video appearance
  - VideoTile: Shows avatar until video track is fully loaded
  - ScreenShareView: Loading spinner with "Connecting to screen..." message
  - Fade-in transition (700ms) when video becomes ready

- **sdk-react: New animations** - Polish for meeting transitions
  - `chalk-dock-slide-up/down` - Control bar entrance/exit with spring easing
  - `chalk-tile-pop-in` - Staggered tile appearance
  - `chalk-void-exit` - Shrink + blur effect for leaving participants
  - `chalk-harmonic-pulse` - Speaking indicator glow
  - `chalk-button-tactile` - Hover/active microinteractions

- **chalk-whiteboard: SyncEngine improvements** - More reliable collaboration
  - Separate local/remote sequence numbers for proper ordering
  - Pasted images now sync correctly (file references re-included with changed elements)
  - Pending updates stored in Map for deduplication

### Fixed

- **"Room is full" false positives after participant disconnect** - WebSocket disconnects now properly decrement active participant count
  - Root cause: `hub.unregisterClient()` removed participants from memory but never called `LeaveRoom()` to update database
  - The `CountActiveParticipantsByRoom()` query checks `left_at IS NULL`, so disconnected participants stayed in the count
  - Fix: Hub now calls participant service's `LeaveRoom()` on WebSocket disconnect, marking `left_at` in database

## [0.0.45] - 2026-01-25

### Added

- **sdk-react: Bundled sounds & logos** - Assets now included in SDK distribution
  - Added `useBundled` option to `useSoundEffects` hook for zero-config usage
  - 9 sound files bundled at `@q9labs/chalk-react/sounds/*`
  - 2 logo files bundled at `@q9labs/chalk-react/logos/*`
  - Exported `SOUND_FILES` and `LOGO_FILES` constants from SDK
  - Backward compatible: `useBundled: false` (default) uses `/sounds/` path
- **Dynamic tenant CORS origins** - Tenants can configure allowed CORS domains
  - API: `PATCH /api/v1/tenants/:id/config` now accepts `allowed_origins` array
  - Validation: Max 20 origins, http/https only, no wildcards (except localhost)
  - S3 aggregation: Tenant origins uploaded to S3 for Terraform consumption
  - API Gateway: CORS origins read from S3 bucket (updated via GitHub Actions)
  - Defense in depth: App-level CORS middleware with tenant-aware checking
  - WebSocket: Origin validation against tenant config after JWT authentication
  - New Terraform module: `cors-origins` with S3 bucket and IAM policies
  - GitHub Actions: `cors-sync.yml` workflow triggered by `repository_dispatch`

### Changed

### Fixed

- **sdk-react: Toast notifications invisible for SDK consumers** - Sonner toasts were using CSS variables only defined inside `[data-chalk]` scope, but toasts portal to `document.body`. Switched to sonner's built-in dark theme for consistent styling.
- **CORS for tenant domains** - Enable S3-based CORS origins in API Gateway
  - Set `enable_s3_cors_origins = true` in prod environment
  - API Gateway now reads CORS origins from S3 (includes TuitionHighway domains)
- **Terraform formatting** - Fix HCL alignment in cors-origins module
- **Terraform plan errors** - Fix count/for_each with unknown values at plan time
  - api-gateway: Add `enable_s3_cors_origins` boolean (known at plan time)
  - ecs: Use count instead of for_each for policy attachments

## [0.0.44] - 2026-01-24

### Changed

- **CI install performance** - Added proper dependency caching to GitHub Actions
  - Cache `~/.bun/install/cache` (Bun's global package cache)
  - Cache `node_modules` directories across monorepo
  - Skip `bun install` entirely on cache hits
  - Expected improvement: 3.4 min → ~20-30 seconds on cache hits

### Fixed

- **sdk-react: Reactions not displaying** - `activeReactions` from `useInteractions` hook was never rendered
  - Added `activeReactions` prop to `MeetingRoom` component
  - Render `ReactionBubble` components in floating container over video grid
  - Pass `activeReactions` from `VideoConference` to `MeetingRoom`

- **sdk-react: Sound effects not playing** - `autoSubscribe` was disabled by default
  - Enable `autoSubscribe: true` in `VideoConference`'s `useSoundEffects` hook
  - Add missing reaction event listener in `useSoundEffects` auto-subscribe

- **sdk-react: SSR crash in ReactionPicker** - Direct `document` access during server rendering
  - Add `typeof window === 'undefined'` guard to escape key listener effect

## [0.0.43] - 2025-01-24

### Changed

- **Logging optimizations** - Reduced noise and improved error context
  - Skip `/health` endpoint logging (reduces ~50% log volume)
  - 4xx responses logged as `warn` level with error message
  - 5xx responses logged as `error` level with stack trace
  - Stack traces are condensed (function:line format, skip runtime internals)

- **Reactions overhaul** - Enhanced picker with categories and improved animations
  - ReactionPicker: 6 emoji categories (Smileys, Gestures, Hearts, Celebration, Objects) with 150+ emojis
  - ReactionPicker: Teal-themed design with header, tabs, scrollable grid, footer hints
  - ReactionBubble: Randomized float paths (horizontal offset, rotation, scale variation)
  - ReactionBubble: Bouncy entrance animation with elastic easing
  - ReactionBubble: Particle burst effects for celebration emojis (🎉, 🔥, ⭐, etc.)
  - ReactionBubble: Optional participant name badge
  - New CSS animations: `chalk-reaction-float`, `chalk-reaction-bounce-in`, `chalk-reaction-wiggle`, `chalk-particle-burst`

### Fixed

- **Hand raise indicator not showing** - Local participant's hand raise state now syncs to UI

### Developer Experience

- **Release skill improvements** - macOS-compatible commands, merged analyze+ask phase, explicit Haiku prompt template
  - Core: `Room.raiseHand()` and `lowerHand()` now emit `participant-updated` event
  - This allows React's `useParticipants` to reflect the updated `handRaised` state

## [0.0.42] - 2026-01-24

### Changed

- **What's New dialog redesign** - Multi-release navigation with enhanced UX
  - Backend: `GET /api/v1/whats-new/releases` endpoint fetching up to 10 releases
  - Backend: Release type derivation (major/minor/patch) from semver comparison
  - React SDK: `useWhatsNew` hook extended with `releases[]`, `currentIndex`, `next`, `prev`, `markAllAsSeen`, `later`
  - React SDK: `WhatsNewDialog` redesigned with 40/60 layout (image/content), pagination dots, keyboard navigation
  - React SDK: `ReleaseBadge` atomic component showing release type (major=red, minor=blue, patch=gray)
  - Footer: "Later" (close without marking), "Skip All" (mark all seen), "Next/Done" (primary action)
  - Keyboard: Arrow keys for navigation, Esc to close

### Added

- **Invite toast on join** - Google Meet-style popup prompting users to share meeting link
  - React SDK: `InviteToast` composite component with auto-dismiss (8s), copy link, close button
  - React SDK: `MeetingRoom` prop `showInviteToastOnJoin` (default: true)
  - Hidden during guided tour to avoid UI overlap

- **Sound effects for reactions and hand raise** - Audio feedback for interactions
  - React SDK: Added `reaction` sound effect type and `playReaction` helper
  - React SDK: Hand raise and reactions now trigger sounds in VideoConference
  - Web: Added `reaction.mp3` sound file

- **Structured logging with Axiom integration** - Upgraded to `slog` with Axiom backend for searchable, filterable logs
  - Backend: `logging` package with graceful fallback to JSON stdout
  - Backend: Request ID middleware for correlation across services
  - Backend: Structured fields: `request_id`, `tenant_id`, `room_id`, `participant_id`, `latency_ms`, `status`
  - Environment: `AXIOM_TOKEN` (required for Axiom), `AXIOM_DATASET` (default: `chalk-api`)

### Fixed

### Developer Experience

- **Consolidated release skill** - Merged SKILL.md and RELEASE_GUIDE.md into single 147-line file with Opus+Haiku architecture

## [0.0.41] - 2026-01-24

### Added

- **What's New dialog** - Shows users recent release notes with auto-open on updates
  - Backend: `GET /api/v1/whats-new` endpoint proxying GitHub Releases API with Redis caching
  - React SDK: `useWhatsNew` hook for fetch + localStorage state management
  - React SDK: `WhatsNewDialog` composite component with markdown rendering
  - React SDK: `WhatsNewTrigger` atomic button with notification badge
  - Terraform: GitHub token secret for API authentication
  - Release body format: `<!-- whats-new -->` tags for user-visible content, `<!-- image: KEY -->` for R2 images
  - First-time visitors: No auto-open; only shows after user has dismissed once

## [0.0.40] - 2026-01-24

### Changed

- **Transcript panel redesign** - Complete UI overhaul for the transcription experience
  - **Speaker experience**: Avatars with initials, role badges (Host/You), speaker grouping with turn separators
  - **Search & navigation**: Cmd/Ctrl+F shortcut, text highlighting, match counter (N of M), prev/next navigation
  - **Real-time polish**: Typing dots for interim transcripts, subtle pulse animation, slide-in entry animations
  - **Export dropdown**: Download as TXT/SRT/VTT/JSON, copy all to clipboard
  - **Empty state**: Illustration with animated dots waiting indicator
  - **Low confidence visualization**: Dotted underlines with warning icon for uncertain text
  - **Click-to-copy timestamps**: Click timestamp to copy to clipboard
  - `useTranscripts` hook: Added `copyToClipboard()`, `downloadTranscript()`, JSON export format

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
