# Changelog

## 5.0.0

- Remove unused icon wrappers: `ArrowLeft02Icon`, `ArrowUp01Icon`, `Calendar01Icon`, `Mail01Icon`, `PictureInPictureIcon`, `ZoomInIcon`, `ZoomOutIcon`.

- Fold Classic implementations into plain component names; remove Classic-prefixed modules and symbols.
- Remove SettingsDialog, SettingsPanel, DeviceSelector, NoiseSuppressionToggle, and their props, types, and lazy exports.
- Remove SpaceInfoDialog, its opener, `features.info`, `infoDialog`, and `spaceDescription`.
- Remove the header Invite button, InviteDialog, and `inviteDialog` / `inviteLink` props.
- Remove React Entrance, its types and preview fixture, and the `entrance` prop; Chalk joins directly through CallLimbo.
- Remove the header logo and `logoUrl` from Chalk, SpaceView, and SpaceHeader.
- Remove the unused dock `position`, `placement`, `showLabels`, and `duration` props.
- Remove the inline dock layout and unused PiP, More, settings, info, transcription, and thumbs-up control values and callbacks.
- Remove screen-share thumbnails, zoom, and rotation, including `showThumbnails`, `thumbnailPosition`, and `enableZoom`.
- Remove the unreachable TranscriptPanel drawer, behavior, lazy exports, and `SpacePanel` transcript value.
- Remove unused CaptionLine, TranscriptLine, ConnectionQuality, TourTooltip, TourHighlight, WhatsNewTrigger, and ReleaseBadge atoms and their props.
- Remove the offline-actions decision dialog and stored policy setting; queued actions send automatically on reconnection.

- Add shared call limbo for joining and reconnection. Connection recovery now blurs the call after a two-second grace instead of escalating to a modal.
- Remove the `presentation` layout. Spotlight prioritizes shared content; Grid preserves the selected layout and renders the real board.
