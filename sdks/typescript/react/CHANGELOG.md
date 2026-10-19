# Changelog

## 5.0.0

- Remove `LeaveDialog`, `PreviewEpisodeEnded`, and `PreviewStatus` from the `/preview` entry point.
- Change `ControlBar.onCommandError` from a message string callback to `(failure: ClientFailure | null, source?: MediaSource) => void`.
- Require `ChalkMenu.trigger` and `ChalkMenu.children`; remove its forwarded div ref, `tone`, and inherited HTML attributes other than `className`.
- Require `ChalkMenuItem.children`; remove its forwarded div ref, `tone`, and inherited HTML attributes. Its `onClick` callback no longer receives a DOM event.
- Remove `ToastStack.participantColorSeed` and `participantGradientPreference`; make its `toasts` array and `Toast` fields readonly, and widen `Toast.message` from `string` to `ReactNode`.
- Remove `ScreenShareView.onStopShare`; `ScreenShareViewProps` now contains only `className`.
- Remove `features.settings`, `settingsDialog`, and `onOpenSettings` from the call view contracts, and remove `"settings"` from the `/preview` `SpacePanel` type.
- Remove the props types for `ChalkCheckbox`, `ChalkControlGroup`, `ChalkRadio`, `ChalkSelect`, `ChalkSlider`, and `ChalkTooltipPanel` along with their components.
- Require `primary` in the render contexts passed to `Stage.renderParticipant` and `Stage.renderContentTile`.
- Require the new `ChalkThemeTokens` fields: `raised`, `hover`, `pressed`, `lineStrong`, `dangerHover`, `dangerPressed`, `dangerText`, `warning`, `tile`, `popover`, `textStrong`, `softText`, `wash`, `washStrong`, `overlay`, `overlayStrong`, `overlayHover`, `onOverlay`, `overlayWarning`, `overlayDanger`, and `scrim`. `ChalkTheme.tokens` remains partial.
- Replace the `/ui` `DEFAULT_QUICK_REACTIONS` tuple's final `😢`, `🎉` entries with `🎉`, `👏`; update consumers of its inferred literal types.
- Add `"reactToMessage"` to `/preview` `PreviewClientCommand`; exhaustive command handlers must handle the new variant.
- Persist the local self-view mirror preference across reloads and share it between camera previews and local participant tiles. Add controlled `ControlBar.mirrored` / `onMirrorChange` props; `ParticipantTile.mirror` still overrides the preference. Photo viewer downloads now save the original filename without opening a tab, while previews remain inline.

- Replace stage paging with justified Grid rows and a +N People tile; make shared screens double-width and Spotlight content-aware. Add participant hand-order, share-audio, share-aspect and share-state presentation fields. Preserve keyed video elements through 220 ms transform-only layout moves and add the two-person phone picture-in-picture.
- Unify screen and person tile chrome; show speaking rings, bold Facehash avatars, weak signal bars, local share previews and share controls. `Stage` accepts `onOverflowClick`, and content render contexts identify the primary tile.

- Replace phone device choices with Flip camera when two or more cameras are available; audio stays with the operating system.

- Make the desktop layout control a direct Spotlight/Grid toggle. Let `ChalkMenuItem.closeOnClick` keep device choices open, and `ChalkSheet.accessibleLabel` retain a stable accessible name while showing the call name.

- Add call-link QR sharing, diagnostics copy, keyboard shortcuts, and optional `Chalk`/`SpaceView` `shareUrl` and `onReportProblem` callbacks. Rebuild the call dock with device and screen-source split controls, tab-audio capture, and phone More actions.
- Add optional diagnostics, people, connection-warning and shortcut inputs to `SpaceHeader`; `ChalkPopover.tooltip` composes a tooltip with its trigger. Call reaction pickers accept raised-hand state and its action.
- Rebuild the call card with People and Chat tabs, message reactions, attachment previews and a dark photo viewer.
- Unify call status pages, add optional report/terminal-state integration, a share-ready card, recorded joining consent and accessible call-event toasts.

- Publish and play shared tab audio separately from microphones, with share-audio state and coupled screen-share lifecycle.

- Keep layout changes interactive when `layout` is supplied without `onLayoutChange`; the prop initializes local state in that case. A paired prop and handler remain controlled. Add Spotlight/Grid to the phone dock's More sheet.

- Default calls to Dark; `ChalkColorScheme` is now `"light" | "dark"`. Add `Chalk.onColorSchemeChange` and `SpaceView.onColorSchemeChange` for controlled appearance.
- Replace the call theme tokens with role-based mockup palettes, and share the inset-card frame with recordings.
- Rebuild call buttons, menus, popovers, tooltips, switches, segmented controls, copy feedback, focus-trapped sheets and toasts. Remove the unused `ChalkCheckbox`, `ChalkControlGroup`, `ChalkRadio`, `ChalkSelect`, `ChalkSlider`, and `ChalkTooltipPanel` exports. `ChalkMenu` now accepts a trigger; its items accept checked state.
- Add `captureFlip` for transform-only, reduced-motion-aware moves that preserve the mounted element.
- Use synthesized call sounds with a persistent Sounds switch; remove the unused Sonner `toast` re-export from the toast stack.

- Expose per-message reactions, count, participant IDs, `isMine`, and `react(input)` from `useChat()`; export the shared 24-emoji set and reaction types.

- Add `useScreenShare()` and screen source hint/capture types, without changing UI.

- Remove unused icon wrappers: `ArrowLeft02Icon`, `ArrowUp01Icon`, `Calendar01Icon`, `Mail01Icon`, `PictureInPictureIcon`, `ZoomInIcon`, `ZoomOutIcon`, `Link01Icon`, `MoreHorizontalIcon`, `Settings01Icon`, `SparklesIcon`, `UserAdd01Icon`.

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
