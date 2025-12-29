# Phase 2: React SDK UI Implementation Plan

## Overview

This document outlines the implementation plan for the Chalk React SDK UI components. The goal is to provide beautiful, styled, accessible, and optimized components that enable rapid integration of video conferencing functionality.

## Design Principles

1. **Hybrid Component Philosophy**: Styled defaults with full customization via CSS variables
2. **Progressive Complexity**: Atomic → Composite → Full Integration components
3. **Accessibility First**: Keyboard navigation, ARIA labels, focus management
4. **Responsive**: Desktop and mobile layouts out of the box
5. **Themeable**: Light/dark mode, full control over colors, spacing, typography, shadows

---

## Theming System

### CSS Variables (Consumer Override)

```css
:root {
  /* Colors */
  --chalk-bg-primary: theme('colors.gray.900');
  --chalk-bg-secondary: theme('colors.gray.800');
  --chalk-bg-tertiary: theme('colors.gray.700');
  --chalk-text-primary: theme('colors.white');
  --chalk-text-secondary: theme('colors.gray.300');
  --chalk-text-muted: theme('colors.gray.500');
  --chalk-accent: theme('colors.blue.500');
  --chalk-accent-hover: theme('colors.blue.400');
  --chalk-danger: theme('colors.red.500');
  --chalk-success: theme('colors.green.500');
  --chalk-warning: theme('colors.yellow.500');
  
  /* Spacing */
  --chalk-spacing-xs: 0.25rem;
  --chalk-spacing-sm: 0.5rem;
  --chalk-spacing-md: 1rem;
  --chalk-spacing-lg: 1.5rem;
  --chalk-spacing-xl: 2rem;
  
  /* Typography */
  --chalk-font-family: system-ui, -apple-system, sans-serif;
  --chalk-font-size-xs: 0.75rem;
  --chalk-font-size-sm: 0.875rem;
  --chalk-font-size-md: 1rem;
  --chalk-font-size-lg: 1.125rem;
  --chalk-font-size-xl: 1.25rem;
  --chalk-font-weight-normal: 400;
  --chalk-font-weight-medium: 500;
  --chalk-font-weight-semibold: 600;
  
  /* Borders & Radius */
  --chalk-border-radius-sm: 0.25rem;
  --chalk-border-radius-md: 0.5rem;
  --chalk-border-radius-lg: 0.75rem;
  --chalk-border-radius-xl: 1rem;
  --chalk-border-radius-full: 9999px;
  --chalk-border-color: theme('colors.gray.700');
  
  /* Shadows */
  --chalk-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --chalk-shadow-md: 0 4px 6px rgba(0, 0, 0, 0.4);
  --chalk-shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.5);
  --chalk-shadow-xl: 0 20px 25px rgba(0, 0, 0, 0.6);
  
  /* Transitions */
  --chalk-transition-fast: 150ms ease;
  --chalk-transition-normal: 250ms ease;
  --chalk-transition-slow: 350ms ease;
}

/* Light Mode Override */
[data-chalk-theme="light"] {
  --chalk-bg-primary: theme('colors.white');
  --chalk-bg-secondary: theme('colors.gray.50');
  --chalk-bg-tertiary: theme('colors.gray.100');
  --chalk-text-primary: theme('colors.gray.900');
  --chalk-text-secondary: theme('colors.gray.600');
  --chalk-text-muted: theme('colors.gray.400');
  --chalk-border-color: theme('colors.gray.200');
  --chalk-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --chalk-shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
}
```

### Tailwind Integration

Components use CSS variables with Tailwind fallbacks:
```tsx
<div className="bg-[var(--chalk-bg-primary)] text-[var(--chalk-text-primary)]">
```

---

## Component Hierarchy

### Level 1: Atomic Components (24 Total)

Individual building blocks with single responsibilities.

#### Core Display Components

| Component | Purpose | Props |
|-----------|---------|-------|
| `VideoTile` | Single participant video display | `participant`, `mirror`, `showName`, `showStatus`, `aspectRatio` |
| `Avatar` | Fallback when video off | `name`, `src`, `size`, `status` |
| `NameTag` | Participant name + role badge | `name`, `role`, `isLocal`, `size` |
| `StatusBadge` | Recording/Live/Transcribing indicator | `status`, `pulse`, `size` |
| `ConnectionQuality` | Signal strength bars (1-4) | `quality`, `showLabel` |
| `Thumbnail` | Smaller video preview | `track`, `muted`, `size` |

#### Audio & Visual Indicators

| Component | Purpose | Props |
|-----------|---------|-------|
| `AudioIndicator` | Mic level visualization / muted state | `level`, `muted`, `size`, `variant` |
| `Waveform` | Audio visualization bars | `levels`, `color`, `animated` |
| `HandRaiseIndicator` | Raised hand with animation | `raised`, `animated`, `position` |
| `ReactionBubble` | Floating emoji reaction | `emoji`, `onComplete`, `duration` |

#### Interactive Elements

| Component | Purpose | Props |
|-----------|---------|-------|
| `ControlButton` | Icon button with tooltip | `icon`, `label`, `active`, `danger`, `disabled`, `size` |
| `IconButton` | Simple icon-only button | `icon`, `size`, `variant`, `onClick` |
| `Toggle` | On/off switch | `checked`, `onChange`, `label`, `disabled` |
| `Tooltip` | Accessible tooltip wrapper | `content`, `position`, `delay` |

#### Form Elements

| Component | Purpose | Props |
|-----------|---------|-------|
| `Input` | Styled text input | `value`, `onChange`, `placeholder`, `error`, `icon` |
| `Textarea` | Multiline text input | `value`, `onChange`, `placeholder`, `rows`, `maxLength` |
| `Select` | Dropdown selection | `options`, `value`, `onChange`, `placeholder` |
| `VolumeSlider` | Audio level control | `value`, `onChange`, `muted`, `onMuteToggle` |

#### Feedback & Loading

| Component | Purpose | Props |
|-----------|---------|-------|
| `Spinner` | Loading indicator | `size`, `color` |
| `Skeleton` | Content placeholder | `width`, `height`, `variant` |
| `ProgressBar` | Progress indicator | `value`, `max`, `showLabel`, `variant` |
| `Toast` | Notification message | `message`, `type`, `duration`, `onDismiss` |
| `Badge` | Count or status badge | `count`, `variant`, `max` |

#### Tour & Guidance

| Component | Purpose | Props |
|-----------|---------|-------|
| `TourTooltip` | Tour step tooltip with arrow | `title`, `description`, `step`, `totalSteps`, `onNext`, `onPrev`, `onSkip` |
| `TourHighlight` | Spotlight overlay for tour target | `targetRef`, `padding`, `borderRadius` |

#### Transcription

| Component | Purpose | Props |
|-----------|---------|-------|
| `TranscriptLine` | Single transcription entry | `speaker`, `text`, `timestamp`, `isInterim`, `confidence` |
| `CaptionLine` | Live caption display | `text`, `speaker`, `position` |

---

### Level 2: Composite Components (18 Total)

Assembled from atomic components.

#### Video & Layout

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `VideoGrid` | Responsive participant grid | `VideoTile[]` with layout logic |
| `ScreenShareView` | Screen share with thumbnails | Large view + `VideoTile[]` strip |
| `LayoutSwitcher` | Grid/spotlight/sidebar toggle | `IconButton[]` group |
| `MediaPreview` | Camera/mic preview | `VideoTile` + `AudioIndicator` + controls |

#### Controls & Actions

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `ControlBar` | Meeting controls row | `ControlButton[]` with grouping |
| `MobileControlSheet` | Bottom sheet for mobile | Expandable `ControlBar` variant |
| `ReactionPicker` | Emoji reaction selector | Grid of emoji buttons + recent |
| `RecordingControls` | Recording UI with timer | `StatusBadge` + `Timer` + controls |

#### Panels & Sidebars

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `ParticipantList` | Sidebar participant list | `Avatar`, `NameTag`, `AudioIndicator` per participant |
| `ChatPanel` | Messages + input | `MessageBubble[]` + `Textarea` + emoji picker |
| `TranscriptionPanel` | Live transcription view | `TranscriptLine[]` + search + export |
| `SettingsPanel` | Audio/Video settings | `DeviceSelector[]` + toggles |
| `WaitingRoom` | Pre-admit participant list | `Avatar`, `NameTag`, admit/deny buttons |

#### Device & Media

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `DeviceSelector` | Camera/Mic/Speaker dropdowns | `Select` + preview + level indicator |
| `BackgroundEffectsPicker` | Virtual background selection | Thumbnail grid + upload |
| `NoiseSuppressionToggle` | Audio enhancement controls | `Toggle` + `Select` |

#### Overlays & Feedback

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `NotificationStack` | Toast notifications container | `Toast[]` with stacking |
| `ConnectionLostOverlay` | Reconnection UI | Spinner + message + retry button |

#### Headers & Info

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `MeetingHeader` | Top bar with room info | Room name + `Timer` + `StatusBadge` + `LayoutSwitcher` |
| `InviteModal` | Share meeting link | Link display + copy button + share options |

#### Chat Components

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `MessageBubble` | Single chat message | Avatar + content + timestamp |
| `TypingIndicator` | Who's typing | Animated dots + names |
| `PinnedMessageBanner` | Pinned message display | Message preview + unpin button |

#### Tour

| Component | Purpose | Composition |
|-----------|---------|-------------|
| `TourOverlay` | Full tour experience | `TourHighlight` + `TourTooltip` + backdrop |

---

### Level 3: Full Integration Components (4 Total)

Complete experiences, one-liner integration.

| Component | Purpose | Features |
|-----------|---------|----------|
| `PreJoinLobby` | Device preview before joining | Camera preview, name input, device selection, A/V toggles, join button |
| `MeetingRoom` | Complete meeting UI | VideoGrid, ControlBar, ChatPanel, ParticipantList, TranscriptionPanel, all interactions |
| `EndScreen` | Post-meeting summary | Duration, feedback prompt, rejoin option, recording download |
| `GuidedTour` | Interactive onboarding tour | Step-by-step UI walkthrough with `TourOverlay` |

---

## Component Specifications

### VideoTile

```tsx
interface VideoTileProps {
  participant: Participant;
  mirror?: boolean;
  showName?: boolean;
  showStatus?: boolean;
  aspectRatio?: '16:9' | '4:3' | '1:1';
  onClick?: () => void;
  onDoubleClick?: () => void;
  pinned?: boolean;
  className?: string;
}
```

**States**: Video on, Video off (Avatar), Speaking (glow), Muted, Screen sharing, Hand raised, Poor connection, Pinned

### TranscriptionPanel

```tsx
interface TranscriptionPanelProps {
  transcripts: TranscriptEntry[];
  isLive?: boolean;
  showSpeakerNames?: boolean;
  showTimestamps?: boolean;
  showConfidence?: boolean;
  searchable?: boolean;
  onExport?: (format: 'txt' | 'srt' | 'vtt') => void;
  onClose?: () => void;
  position?: 'right' | 'bottom';
  className?: string;
}

interface TranscriptEntry {
  id: string;
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  language?: string;
}
```

**Features**:
- Real-time transcript updates with interim results
- Speaker identification with colors
- Search/filter functionality
- Export to TXT, SRT, VTT formats
- Auto-scroll with "new content" indicator
- Confidence highlighting (low confidence = muted)

### TourOverlay / GuidedTour

```tsx
interface GuidedTourProps {
  steps: TourStep[];
  isOpen: boolean;
  onComplete: () => void;
  onSkip?: () => void;
  startStep?: number;
  showProgress?: boolean;
  showSkip?: boolean;
  backdropOpacity?: number;
  className?: string;
}

interface TourStep {
  target: string;           // CSS selector or ref
  title: string;
  description: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  action?: 'click' | 'hover' | 'focus';
  nextTrigger?: 'button' | 'action' | 'auto';
  delay?: number;
  spotlight?: boolean;
}
```

**Default Tour Steps for MeetingRoom**:
1. **Video Grid**: "This is where you'll see all participants"
2. **Your Video**: "Your camera preview. Click to pin yourself"
3. **Mute Button**: "Press M or click to mute/unmute"
4. **Video Button**: "Press V or click to toggle your camera"
5. **Screen Share**: "Share your screen or a specific window"
6. **Chat**: "Send messages to everyone in the meeting"
7. **Participants**: "See who's in the meeting and manage participants"
8. **Reactions**: "Send emoji reactions visible to everyone"
9. **Leave**: "Click here when you're ready to leave"

### ControlBar

```tsx
interface ControlBarProps {
  position?: 'bottom' | 'top';
  variant?: 'floating' | 'fixed' | 'minimal';
  showLabels?: boolean;
  buttons?: ControlBarButton[];
  moreMenuItems?: MenuItem[];
  // ... all toggle callbacks
  className?: string;
}

type ControlBarButton = 
  | 'mic' | 'video' | 'screenshare' | 'record' 
  | 'chat' | 'participants' | 'transcription'
  | 'handraise' | 'reactions' | 'settings' 
  | 'more' | 'leave';
```

**Default Buttons** (left to right):
1. Microphone toggle
2. Video toggle  
3. Screen share
4. Record (if enabled)
5. **Transcription toggle** ← NEW
6. Hand raise
7. Reactions (popover)
8. Chat toggle
9. Participants toggle
10. More options (dropdown)
11. Leave (danger, right-aligned)

### MeetingRoom (Updated)

```tsx
interface MeetingRoomProps {
  roomId: string;
  token: string;
  displayName: string;
  
  // Feature flags
  enableChat?: boolean;
  enableRecording?: boolean;
  enableScreenShare?: boolean;
  enableHandRaise?: boolean;
  enableReactions?: boolean;
  enableTranscription?: boolean;      // NEW
  enableTour?: boolean;               // NEW
  
  // Layout
  defaultLayout?: 'grid' | 'spotlight' | 'sidebar';
  defaultChatOpen?: boolean;
  defaultParticipantsOpen?: boolean;
  defaultTranscriptionOpen?: boolean; // NEW
  
  // Tour
  showTourOnFirstVisit?: boolean;     // NEW
  tourSteps?: TourStep[];             // NEW (custom steps)
  
  // Callbacks
  onLeave?: () => void;
  onError?: (error: ChalkError) => void;
  onTourComplete?: () => void;        // NEW
  
  // Customization
  theme?: 'light' | 'dark' | 'system';
  className?: string;
}
```

---

## Sound Effects

### Sound Assets (✅ Ready)

| Sound | Trigger | File |
|-------|---------|------|
| `join.mp3` | Participant joins | Soft chime |
| `leave.mp3` | Participant leaves | Subtle exit tone |
| `message.mp3` | Chat message received | Notification pop |
| `hand-raise.mp3` | Hand raised | Attention sound |
| `recording-start.mp3` | Recording begins | Confirmation beep |
| `recording-stop.mp3` | Recording ends | Completion tone |
| `click.mp3` | Button press | Subtle click |
| `error.mp3` | Error occurs | Warning tone |
| `transcription-ready.mp3` | Transcription available | Subtle notification |
| `tour-step.mp3` | Tour step advance | Soft pop |

### useSoundEffects Hook

```tsx
interface UseSoundEffectsOptions {
  enabled?: boolean;
  volume?: number;
}

function useSoundEffects(options?: UseSoundEffectsOptions): {
  playJoin: () => void;
  playLeave: () => void;
  playMessage: () => void;
  playHandRaise: () => void;
  playRecordingStart: () => void;
  playRecordingStop: () => void;
  playClick: () => void;
  playError: () => void;
  playTranscriptionReady: () => void;  // NEW
  playTourStep: () => void;            // NEW
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
}
```

---

## Animations

### Animation Triggers

| Element | Animation | Trigger |
|---------|-----------|---------|
| VideoTile | Scale in | Participant joins |
| VideoTile | Fade out | Participant leaves |
| VideoTile border | Pulse glow | Speaking |
| ControlButton | Scale bounce | Click |
| ChatPanel | Slide right | Toggle open/close |
| TranscriptionPanel | Slide right | Toggle open/close |
| ReactionBubble | Float up + fade | Reaction sent |
| HandRaiseIndicator | Bounce | Hand raised |
| StatusBadge | Pulse | Recording/transcribing active |
| Tooltip | Fade + slight scale | Hover |
| TourHighlight | Fade in + pulse | Tour step |
| TourTooltip | Scale in from target | Tour step |
| TranscriptLine | Fade in + slide | New transcript |
| Toast | Slide in from edge | Notification |

---

## Accessibility Requirements

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `M` | Toggle mute |
| `V` | Toggle video |
| `S` | Toggle screen share |
| `H` | Raise/lower hand |
| `C` | Toggle chat |
| `P` | Toggle participants |
| `T` | Toggle transcription |
| `?` | Show keyboard shortcuts |
| `Esc` | Close panels/modals, exit tour |
| `Tab` | Navigate controls |
| `Arrow keys` | Navigate video grid |
| `Enter/Space` | Activate focused element |
| `N` | Next tour step (during tour) |
| `B` | Previous tour step (during tour) |

### ARIA Labels

```tsx
// VideoTile
<div role="img" aria-label="John Doe, muted, video on, speaking">

// TranscriptionPanel
<div role="log" aria-label="Live transcription" aria-live="polite">

// TourTooltip
<div role="dialog" aria-label="Tour step 3 of 9">

// CaptionLine
<div role="status" aria-live="polite" aria-atomic="true">
```

### Screen Reader Announcements

- Participant joined/left
- Hand raised/lowered
- Recording started/stopped
- **Transcription started/stopped**
- **New transcript from [speaker]**
- Chat message received
- **Tour step: [title]**

---

## File Structure

```
packages/sdk-react/src/
├── components/
│   ├── atomic/
│   │   ├── VideoTile/
│   │   ├── Avatar/
│   │   ├── NameTag/
│   │   ├── StatusBadge/
│   │   ├── ConnectionQuality/
│   │   ├── Thumbnail/
│   │   ├── AudioIndicator/
│   │   ├── Waveform/
│   │   ├── HandRaiseIndicator/
│   │   ├── ReactionBubble/
│   │   ├── ControlButton/
│   │   ├── IconButton/
│   │   ├── Toggle/
│   │   ├── Tooltip/
│   │   ├── Input/
│   │   ├── Textarea/
│   │   ├── Select/
│   │   ├── VolumeSlider/
│   │   ├── Spinner/
│   │   ├── Skeleton/
│   │   ├── ProgressBar/
│   │   ├── Toast/
│   │   ├── Badge/
│   │   ├── TourTooltip/
│   │   ├── TourHighlight/
│   │   ├── TranscriptLine/
│   │   └── CaptionLine/
│   ├── composite/
│   │   ├── VideoGrid/
│   │   ├── ScreenShareView/
│   │   ├── LayoutSwitcher/
│   │   ├── MediaPreview/
│   │   ├── ControlBar/
│   │   ├── MobileControlSheet/
│   │   ├── ReactionPicker/
│   │   ├── RecordingControls/
│   │   ├── ParticipantList/
│   │   ├── ChatPanel/
│   │   ├── TranscriptionPanel/
│   │   ├── SettingsPanel/
│   │   ├── WaitingRoom/
│   │   ├── DeviceSelector/
│   │   ├── BackgroundEffectsPicker/
│   │   ├── NoiseSuppressionToggle/
│   │   ├── NotificationStack/
│   │   ├── ConnectionLostOverlay/
│   │   ├── MeetingHeader/
│   │   ├── InviteModal/
│   │   ├── MessageBubble/
│   │   ├── TypingIndicator/
│   │   ├── PinnedMessageBanner/
│   │   └── TourOverlay/
│   └── full/
│       ├── PreJoinLobby/
│       ├── MeetingRoom/
│       ├── EndScreen/
│       └── GuidedTour/
├── hooks/
│   ├── useSoundEffects.ts
│   ├── useKeyboardShortcuts.ts
│   ├── useAnnouncer.ts
│   ├── useGridLayout.ts
│   ├── useTour.ts                    # NEW
│   ├── useTranscription.ts           # NEW
│   └── useMediaQuery.ts              # NEW
├── styles/
│   ├── variables.css
│   ├── animations.css
│   └── base.css
├── assets/
│   └── sounds/
│       ├── join.mp3
│       ├── leave.mp3
│       ├── message.mp3
│       ├── hand-raise.mp3
│       ├── recording-start.mp3
│       ├── recording-stop.mp3
│       ├── click.mp3
│       ├── error.mp3
│       ├── transcription-ready.mp3   # NEW
│       └── tour-step.mp3             # NEW
└── index.ts
```

---

## Implementation Tasks

### Phase 2.1: Foundation (3 days)

- [ ] Set up CSS variables theming system
- [ ] Create base styles and animations
- [ ] Implement `useSoundEffects` hook
- [ ] Implement `useKeyboardShortcuts` hook
- [ ] Implement `useAnnouncer` hook
- [ ] Implement `useMediaQuery` hook
- [ ] Set up Storybook

### Phase 2.2: Atomic Components (5 days)

- [ ] Core Display: `VideoTile`, `Avatar`, `NameTag`, `StatusBadge`, `ConnectionQuality`, `Thumbnail`
- [ ] Audio/Visual: `AudioIndicator`, `Waveform`, `HandRaiseIndicator`, `ReactionBubble`
- [ ] Interactive: `ControlButton`, `IconButton`, `Toggle`, `Tooltip`
- [ ] Form: `Input`, `Textarea`, `Select`, `VolumeSlider`
- [ ] Feedback: `Spinner`, `Skeleton`, `ProgressBar`, `Toast`, `Badge`
- [ ] Tour: `TourTooltip`, `TourHighlight`
- [ ] Transcription: `TranscriptLine`, `CaptionLine`

### Phase 2.3: Composite Components (6 days)

- [ ] Video/Layout: `VideoGrid`, `ScreenShareView`, `LayoutSwitcher`, `MediaPreview`
- [ ] Controls: `ControlBar`, `MobileControlSheet`, `ReactionPicker`, `RecordingControls`
- [ ] Panels: `ParticipantList`, `ChatPanel`, `TranscriptionPanel`, `SettingsPanel`, `WaitingRoom`
- [ ] Device/Media: `DeviceSelector`, `BackgroundEffectsPicker`, `NoiseSuppressionToggle`
- [ ] Overlays: `NotificationStack`, `ConnectionLostOverlay`, `TourOverlay`
- [ ] Headers/Info: `MeetingHeader`, `InviteModal`
- [ ] Chat: `MessageBubble`, `TypingIndicator`, `PinnedMessageBanner`

### Phase 2.4: Full Integration (4 days)

- [ ] `PreJoinLobby` complete flow
- [ ] `MeetingRoom` with all features including transcription
- [ ] `EndScreen` summary view
- [ ] `GuidedTour` with default steps
- [ ] Error boundaries and loading states
- [ ] Integration tests

### Phase 2.5: Polish & Documentation (3 days)

- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Performance optimization (lazy loading, memoization)
- [ ] Storybook documentation for all components
- [ ] Usage examples and code snippets
- [ ] README and API documentation

---

## Desktop Mockup Reference

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  CHALK  │  Room Name  │  00:12:45  │  ● REC  │  ◉ CC                              [ ⊞ Layout v ]   │
├────────────────────────────────────────────────────────────────────────┬─────────────────────────────┤
│                                                                        │ TRANSCRIPTION               │
│  ┌─────────────────────┐  ┌─────────────────────┐                      │ ───────────────────────────│
│  │                     │  │                     │                      │ [10:02] Jessica:            │
│  │      (Video)        │  │      (Video)        │                      │ Let's start with the        │
│  │                     │  │                     │                      │ quarterly review.           │
│  │   Jessica (Host)    │  │      Marcus         │                      │                             │
│  └─────────────────────┘  └─────────────────────┘                      │ [10:03] Marcus:             │
│                                                                        │ I have the slides ready.    │
│  ┌─────────────────────┐  ┌─────────────────────┐                      │                             │
│  │   (Speaking glow)   │  │                     │                      │ [10:03] Alexander:          │
│  │      (Video)        │  │      (Avatar)       │                      │ Great, let me share my      │
│  │                     │  │        JD           │                      │ screen...                   │
│  │    Alexander  ▂▃    │  │       John          │                      │                             │
│  └─────────────────────┘  └─────────────────────┘                      │ [  Search transcripts...  ] │
├────────────────────────────────────────────────────────────────────────┴─────────────────────────────┤
│    [🎤]  [📹]  [🖥️]  [⏺]  [📝]  [✋]  [😀]      [💬]  [👥]  [⚙️]  [•••]           [Leave]          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Tour Mockup Reference

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ (Dimmed backdrop) ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░ ╔════════════════════════════════════════╗ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░ ║        (Highlighted Video Grid)        ║ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░ ║                                        ║ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░ ╚════════════════════════════════════════╝ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ ┌───┴────────────────────────┐ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  📺 Video Grid              │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │                             │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  This is where you'll see   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  all meeting participants.  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  Click any tile to pin it.  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │                             │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  ○ ○ ● ○ ○ ○ ○ ○ ○  (1/9)   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ │  [Skip]           [Next →]  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ░░░░░░░░░░░░░░░░ └─────────────────────────────┘ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Success Criteria

1. **All 46 components render correctly** in light and dark modes
2. **Responsive layouts** work on desktop, tablet, and mobile
3. **Keyboard navigation** allows full meeting participation without mouse
4. **Screen readers** can announce all participant actions
5. **Animations** are smooth (60fps) and respect `prefers-reduced-motion`
6. **Sound effects** play reliably with user-controlled volume
7. **Theming** allows full customization via CSS variables
8. **Transcription** displays real-time with speaker identification
9. **Tour** guides new users through all major features
10. **Bundle size** stays reasonable (< 60KB gzipped for core components)
11. **Test coverage** > 80% for all components
12. **Storybook** documents all components with interactive examples
