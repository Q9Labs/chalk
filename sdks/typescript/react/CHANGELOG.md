# Changelog

## 5.2.0

### board-draw-policy

Add a call-wide drawing policy for the board: everyone, only hosts, or picked people.
Hosts set it with `setDrawPolicy` on the whiteboard transport and pick people with the
existing `setDrawPermission`. Sync computes each person's permission and sends it with
the policy over the new `draw_policy_v1` extension, so the summary and
`useWhiteboard().access` now carry `canDraw`, `drawPolicy` and the host's per-person
choices. The React board follows that permission instead of the role capability, and
hosts get a "Who can draw" section with a person picker in the board menu.

The whiteboard client now steps its hello down only when Sync can't decode it (close
1009). A rejected token or a late hello (close 1008) is retried at the same level up to
four times, so a brief token problem no longer hides the drawing policy for the rest of
the connection. On a Sync without the drawing policy, a host's waiting policy change is
refused as `unavailable`, and also reported on the summary, instead of being replayed.

### board-frame-clock

Keep Follow active when Bring everyone moves to a wider board view, without a brief zoom overshoot at the start of the animation.

### board-stage-motion

Keep the live whiteboard free of stage translation and scaling animations so
switching between a participant and the board preserves the full canvas and
accurate drawing coordinates. Other stage tiles keep their existing motion.

### brand-single-chalk-mark

Replace the retired colourful four-stick logo with the monochrome single chalk stick and dust in the distributed SVG assets and React Logo variants. Preserve existing asset filenames and component props. The React Logo now takes its default colour from the surrounding text colour.

### follow-view-owner

Converge Follow views on one Episode owner, recover from its canonical snapshot,
and preserve real camera moves during recovery and tab switches. Zoom controls
and keyboard moves now consistently leave Follow and lead the person's view.

Keep all 500 active people's views using internal schema-generated limits in the client and React caches. The client's public bounds, event unions and decoded-frame unions are unchanged. The client now exports `ChalkWhiteboardViewVersions`, which the React SDK uses to order view moves, and whiteboard view events now carry `ownerId`, `ownerSequence` and `originEpoch`, so both releases are minor.

### phone-board-notices-next-release

Float faces over a phone board, and keep call notices off the call's controls.
On a phone, an open board now fills the stage and up to three faces float at
its right edge, with short name tags. Notices sit between the header and the
controls under them. A call shorter than 620px, such as a landscape phone or a
short embedded call, puts every notice in a notice button in the header, which
lists each one whole and announces it once to screen readers; a taller call
shows the newest three and puts older ones in the button. A notice in the
button starts its timer only once it shows. The header stays visible while
the button holds notices. Long names, links and error tokens wrap inside
their notice, and a long call name shortens to make room for the timer and
the notice button. A screen share beside a short board always keeps its own
tile when there is no explicit cap. A capped strip or floating column counts
shared content and its overflow button against that cap; folded shares stay
readable in the shared-content overflow. One text-only announcer handles
notice speech independently of its stage or header presentation.

New optional props: `ToastStackProps.onFold` reports the ids of the notices
the stage has no room for, `ChalkToastProps.announce` lets a host that already
announced a notice keep its toast quiet, and `SpaceHeaderProps.notices` places
a control before the people button.

### problem-reporting

Add the problem-report API contract and reusable report dialog, with opt-in diagnostics,
editable delivery failures and bounded Unicode input. Call details and failed or ended
call screens can expose reporting when an integration supplies a delivery callback.
Use `reportUnavailableReason` to show expired access inside an editable report.
Live report drafts survive call termination. Integrations with their own terminal
screens can use `onOpenReportProblem` to keep one app-owned dialog across those screens.
Give `ReportProblemDialog` a `focusScope` containing the current call or terminal screen,
so closing it returns focus to its usable opener, or to a visible current control
when the opener has disappeared. Hidden, inert and disabled targets are skipped.

### recording-auto-render

Expose recording expiry reasons through additive failure fields while preserving the existing export status enum.

Add the Tenant recording_render_mode setting, defaulting to on_demand, with opt-in automatic MP4 rendering.

### safe-media-command-guidance

Show safe, source-aware guidance for media command failures across call controls,
keyboard shortcuts, screen sharing, and media request dialogs. Preserve the
existing onCommandError MediaSource argument and provide extended media context
in an optional third argument. Keep disable-failure wording neutral and explain
unsupported speaker selection without suggesting a retry. Preserve start/stop
intent in failure guidance and retries; show terminal guidance for withdrawn
media requests and other non-recoverable failures.

Distinguish device selection, speaker tests, and incoming requests in media error
guidance. Cover every client failure code with an operation-aware policy and only
offer retry when the exact failed media command can be replayed.

Preserve request context in the integrated Chalk dialog and show safe terminal
guidance without retry for unknown runtime failure codes.

### sync-connect-diagnostics

Report Sync connection failures with the existing `connection.sync_hello_timeout` code without adding values to the public `ErrorCode` union. Add the current attempt's safe diagnostics to client errors, telemetry, and the call failure reference: opening/hello stage, close code and bounded reason, whether the socket opened, and elapsed time. Earlier attempts remain in the diagnostic history. Browsers do not expose DNS, TCP, or TLS progress. Unrecognized peer reasons are redacted. This is a compatible patch for the next client and React releases; released 5.1.0 files are unchanged.

## 5.1.0

- Add optional `CallLimbo.className` for the message card, so a host can size the card around a form.
- Route private camera previews through the SDK so granting permission refreshes the camera menu. Standalone `DevicePopover` and `ControlBarSurface` consumers can supply `captureCameraPreview`.
- Preview the chosen camera privately when the call camera is off; while it is active, preview the published call track rather than an unpublished device selection.
- Keep keyboard-shortcut dialog content fixed while opening and closing. Report a problem remains unchanged and appears only when a host supplies `onReportProblem`.
- Add optional `ChalkMenu.onOpenChange` for hosts that need to coordinate menu and dialog visibility.
- Show stage-specific failed-entry guidance with a public error-code reference. Keep recoverable device capture warnings in the live call.
- The call board now shows Chalk's own controls instead of the stock Excalidraw ones, with Follow and Bring everyone. `Stage` adds optional `followingId`, `onFollowChange` and `clickAction` (`"pin"` or `"follow"`); `SpaceStage` adds `colorScheme` and `onCloseBoard`; `SpaceView` shares and follows board views through the client's `sendView`.
- Keep Follow, Clear and Undo on the board scene where they started, so a scene change cannot restore or follow into another scene. Redo brings back undone text, and small drawings open at 100% zoom at most.
- Label screen shares of unknown surfaces plainly instead of guessing what is being shared.
- Lift call notices clear of an open reaction tray, so the tray and the notices stay readable together.
- Keep chat messages still while the clock ticks instead of re-rendering and jumping the scroll position.
- Show recovery notices without blocking the call, keep chat readable, and disable reaction sending and media enable controls until Sync is live. Local mute, private camera preview, device menus, and hand controls stay available.
- Omit the reference when the host has no known error code instead of inventing an internal-error reference.

## 5.0.0

- Keep chat history available to observers and custom read-only roles; gate the composer, attachments, and message reactions on `sendChat`.
- Use `endEpisode` authority for Host badges and host-transfer notices, including `owner` and custom roles. Add `ParticipantListParticipant.isHost` for presentation-only lists.
- Play a short, quiet synthesized reaction sound while Sounds is enabled.
- Restore local ownership, capture details, and Stop/Change actions in the connected `ScreenShareView`.
- Avoid stopping already-ended screen capture tracks again when publication fails.
- Remove the unused `ToastStack.position` prop; call toasts use the responsive position defined by the call layout.

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
