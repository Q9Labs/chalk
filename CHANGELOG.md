# Changelog

## 5.1.0 (unreleased)

- Client: add `media.captureCameraPreview()` for unpublished camera capture with post-permission device refresh. It shares live or pending camera capture; callers release a preview handle.
- React: add optional `captureCameraPreview` to `DevicePopover` and `ControlBarSurface`, and optional `ChalkMenu.onOpenChange`. Fix camera-menu previews and the keyboard-shortcut dialog flash.
- These additive SDK APIs require the next synchronized minor release. Before publishing, use `pnpm run package:release -- --bump 5.1.0` to advance the coordinated package versions, workspace ranges, and lockfile. This PR does not bump versions or publish packages.

## 5.0.1 (unreleased)

- React Native: fix the Android 11 crash when joining a call by keeping API 31 audio listener types out of React Native module signatures.
- Advance the seven coordinated Chalk SDK packages to 5.0.1. `@q9labsai/recording-presentation` remains at 0.1.1.

## 5.0.0

- Keep the whiteboard reconnect watchdog running when an injected wall clock moves backward. Persisted operation timestamps still use wall time.
- Add package-local release notes for all eight public packages. Seven packages use 5.0.0; `@q9labsai/recording-presentation` advances independently to 0.1.1 for the 24-reaction validator.
- React participant tiles accept a normalized `audioLevel` for voice-responsive speaking rings and generated avatars.

- Align quick reactions with the call design: 👍 ❤️ 😂 😮 🎉 👏.
- React: ChalkCopyButton supports an optional visible label for diagnostics; icon-only defaults are unchanged.
- React: Export ControlBar and SpaceHeader at the package root. ControlBar command errors retain public `ClientFailure` codes and the originating media source; optional `callLinkOpen` and `onCallLinkToggle` props let the call-link card own its toggle.

### Added (React Native)

- Added a new React Native `Chalk` call view with `ChalkProps`: header, stage, dock, sheets, menus and toasts, drawn inside the safe area on phone and iPad.
- Added `colorScheme` and `onColorSchemeChange` to `Chalk`, with the `ColorScheme` and `Palette` types. The call is dark by default.
- Added call sounds and haptics to `Chalk`, with `soundsEnabled` and `onSoundsEnabledChange`.
- Added `onRejoin` to `Chalk`, which Rejoin and Try again on the status page call. The app gives the arrival back and renders `Chalk` with a new client, because the client that left or ended can't join again.
- `Chalk` lays out the call itself: Spotlight and Grid with justified rows and a "+N" tile, the active speaker moving into the spotlight, pinning, facehash tiles for cameras that are off, screen shares sized to their shape, and a shared board shown view-only. iPad uses the phone layout in 5.0.0.
- Added `inviteLink` to `Chalk`. The dock adds an audio output button with route choice. More adds raise hand, reactions, copy and share link, recording for hosts, Chat with an unread dot, and the Layout switch. Tapping the call name opens call details with the link, a QR code, appearance and sounds.
- `Chalk` adds the People and Chat sheet: waiting room, raised-hands queue, host mute and remove, chat with photos and files, a photo viewer and new-message notices.
- `Chalk` covers the call while it joins or reconnects, and shows a page when the call is over: you left, the call ended, it couldn't connect, or the host removed you, each with Rejoin or Try again and Home.
- Added `onOpenSettings` and `resumedAfterSettings` to `Chalk`. When the microphone or camera isn't allowed, the notice offers Open Settings, and after iOS restarts the app the call rejoins and says it can use the device now.
- Added `ChalkArrival` for the screens before a call lets someone in: asking to join, turned away, and the call is full.
- Added call notices for people joining and leaving, a host muting you, a request to unmute or turn on your camera, a new host, a share ending, recording starting and stopping, and a camera or microphone another app is using.
- Added the `@q9labsai/chalk-react-native/ui` entry: `ChalkUI` with the call's theme, icons and primitives, so an app's own screens can match the call.
- BREAKING: leaving no longer calls `onLeave` straight away. The "You left" page shows first, and its Home button calls `onLeave`.
- Added the development-only `@q9labsai/chalk-react-native/dev` entry: `setMeasurementRegistry` reports each call surface's frame and declared style by testID, and `setDevScenario` opens a sheet or menu and draws fake video in tiles. Require it behind `__DEV__` so release bundles leave it out.
- BREAKING: `@q9labsai/chalk-react-native` now needs `react-native-reanimated`, `react-native-worklets`, `react-native-gesture-handler`, `react-native-safe-area-context`, `expo-audio`, `expo-haptics`, `expo-clipboard`, `expo-document-picker` and `expo-file-system` as peers, and no longer needs `@hugeicons/core-free-icons` or `@hugeicons/react-native`.

### Mobile app

- The app is rebuilt on the new `Chalk` call view, with a new Home (recent calls, Start a call, Join with a link), name step, icon and splash, in Dark and Light.
- A call that asks the host first shows "Asking to join" and joins once you're let in, with Ask again after a refusal and Try again when the call is full.
- Pressing back on Android during a call keeps the call going.
- Status pages and recent calls show the call's name, or the link's code for a call without one.
- Phones can rotate, so the call works in landscape.
- Fixed a crash on every join in iOS builds: Expo's Babel object-spread assumption read the Effect library's `Exit` getters too early.

### Removed (React Native)

- Removed the React Native `ChalkFeatures` public export.
- Removed the React Native `ChalkTheme` public export.
- Removed the React Native `ChalkThemeTokens` public export.
- Removed the React Native `SpaceLayout` public export.
- Removed the React Native `Entrance` public export.
- Removed the React Native `EntranceProps` public export.
- Removed the React Native `EntranceSettings` public export.
- Removed the React Native `Logo` public export.
- Removed the React Native `LogoProps` public export.
- Removed the React Native `LogoVariant` public export.
- Removed the React Native `Theme` public export.
- Removed the React Native `createNativeTheme` public export.
- Removed the React Native `@q9labsai/chalk-react-native/android` entry point.
- Removed the React Native `@q9labsai/chalk-react-native/ios` entry point.
- Removed the React Native `@q9labsai/chalk-react-native/ios-phone` entry point.
- Removed the React Native `@q9labsai/chalk-react-native/ios-pad` entry point.
- Removed the React Native `@q9labsai/chalk-react-native/macos` entry point.
- Removed the React Native `@q9labsai/chalk-react-native/theme` entry point.

- BREAKING: removes Episode diagnostics producers, credentials, backend, CLI and the diagnostics-contracts package.
- Remove Episode Debugger launch and diagnostic-reference UI props from the React SDK. Local connection diagnostics and recording instrumentation remain.

- BREAKING: Classic is the only UI style. Removed the skin option, skin context, hand-drawn rendering helpers and drawing-only primitive props (`seed`, `roughness`, `filled`, `scribble`).
- BREAKING: Removed feedback report submission, UI, collection helpers and operator endpoints.
- BREAKING: removes client telemetry, preset palettes, textures, background-effect controls and icon animations. Light/dark mode, custom tokens and fun avatars remain.
- BREAKING: removes RealtimeKit, public status, Tenant invitations, audit-log and Users API operations and the regions catalog.
- BREAKING: leaving a call is instant. A guest leaves with no dialog and a host gets a menu with Leave call and End call for everyone, so the preview `LeaveDialog` and `JoinFailedScreen` are removed, along with `PreviewStatus` and `PreviewEpisodeEnded`.
- The pages shown before and after a call are one dark page with round icon actions. `Chalk` takes `onRejoin` and `onHome`; the page no longer shows the Episode id, timing or a "Leaving" screen.
- This release is not yet published. Existing v4 integrations stay on v4 until their applications upgrade.

All notable public changes to this project will be documented in this file.

This changelog starts from the public-source cleanup. Earlier internal release
notes were archived privately before publication because they included
deployment, customer, and incident-specific detail that is not appropriate for a
public repository.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.1.17] - 2026-10-13

### Fixed

- Normal Episode endings now reach `left` and emit `episodeEnded` once without an `error` callback; React fires `onEpisodeEnded` once and `onLeft` once without `onError`.
- Participant removal now closes locally in `left` without an Episode-ended or error callback, using the authoritative self-removal event or terminal recovery reason rather than absence from a roster.
- Joining an already-ended Episode rejects with `episode.ended`, remains `failed`, and reports the ended message; it does not fire joined, left, or Episode-ended callbacks.
- Connection failures caused by unavailable Access now expose `access.unavailable` in the connection snapshot and error callback. Failed scheduled refreshes keep retrying every five seconds, even after expiry, without changing connection state or emitting an error.
- Kept transient SDK recovery running in the background without blocking actions or uploads, and healed media failures that occur during Join.
- Rebuilt expired recovery transports and backed off exhausted recovery, access refresh, and publication discovery retries.
- Updated the Sync HTTP transport and workspace HTTP dependencies to patched releases.
- Classified `getAccess` HTTP 408, 425, 429, and 5xx responses as recoverable `access.unavailable` failures for scheduled-refresh retry, and clarified initial-join network and timeout failures. Other non-OK responses and malformed grants remain `access.invalid`.
- Updated the locked undici dependency to 7.29.1 to address GHSA-3wwx-pv8p-q78v.
- Updated transitive brace-expansion and fast-uri dependencies to their security-fixed releases.
- Dropped Capture RTP packets when the latest fenced Episode plan no longer authorizes their source, including while provider reconciliation is pending.
- Kept Space joins available when a camera or microphone is missing, busy, constrained, or permission-denied. Participants enter with working devices and receive one recoverable, device-specific capture error; React shows the warning after entry.
- Let a Participant muted by a moderator publish again without a reload: the request that `getAccess` receives now carries `replaceMediaConnection`, and `participants.issueAccess` takes that request.
- Fetched chat messages that arrived out of order, so every Participant sees the same history.
- Kept media state updating after many media changes in one Episode.
- Ended an empty Episode after its linger.
- Exported Recordings that contain whiteboard content, a camera that changes resolution, or a Participant whose media never arrived.
- Kept a Recording that reaches its time limit and a Recording whose tracks change while Capture starts.
- Bounded recorder fleet inventory polling so the provider request limit no longer blocks new Recordings.
- Moved the API and recorder services to Go 1.26.9 and cleared the open npm advisories.
- Stopped the whiteboard from uploading the whole board every 20 seconds: each change is sent once, the end of a stroke no longer arrives up to 25 seconds late, and a stroke drawn while the board loads is kept.
- Kept a writer's whiteboard syncing after one long continuous stroke: an element over the stored size is sent as a smaller copy, and an element that cannot be sent is reported once through `onSubmissionError` without holding back the rest.
- Kept the stacking order of whiteboard elements when a board is loaded: a browser that joined, returned or reconnected no longer gave about a quarter of the elements new order keys and sent them back to the class.
- Kept students receiving the whiteboard through a long handwriting class, and exported its Recording.
- Delivered whiteboard changes in order when two Participants write at the same moment, instead of reloading every board, and kept every whiteboard connected while a board copy is being sent.
- Painted freehand whiteboard strokes in Recordings, and exported a Recording whose whiteboard was presented before Capture was ready.
- Kept a camera's recorded clock true through a stall, so the recorded picture no longer runs ahead of the sound or freezes at the end.
- Completed Transcripts whose provider segments overlap in time.
- Started several Episodes of one Tenant at the same moment without a server error.

### Added

- Added the managed Cloudflare SFU recording capture runtime with fenced worker leases, Pion RTP capture, KMS envelope encryption, server-owned R2 bundle allocation and verification, durable Sync ready/stopped callbacks, and inspectable journey and trace signals.
- Added a `participant.left` Event with reason `episode_ended` for every Participant still present when an Episode ends.

## [4.1.16] - 2026-10-02

### Added

- Added SDK policies and React controls to hold offline actions and ask whether to send them after reconnecting.
- Added tab-scoped Episode rejoin helpers that preserve Participant identity and microphone and camera choices after reload, with a React audio-resume control when browser playback is blocked.
- Added camera simulcast for low-layer Capture while preserving Firefox camera quality and low-bandwidth frame rates.
- Added reconnect tracing across Sync, media, and browser and React Native connection recovery.
- Added typed server-only access refresh state and refreshed Recording and Transcript lifecycle Event contracts and integration documentation.
- Added generated API contracts for Tenant invitations, protected member removal, member names and emails, password reset, and retrying Recording Exports.
- Added Automatic Space Entrance preparation to pre-warm Capture before joining.

### Fixed

- Made Episode re-entry and reconnect recovery reliable, cleared stale Participant state, and fenced Whiteboard recovery traffic and scene resets.
- Showed a lightweight notice during short network drops and escalated it to a blocking React dialog after ten seconds of continuous disconnection, clearing both surfaces on recovery.
- Kept Episode toolbar controls visible and wrapped them on narrow screens, reserved space for the mobile self-view, and prevented mobile Entrance clipping.
- Allowed safe retries for failed Recording Exports from the React Recording history panel.
- Refreshed remote Cloudflare SFU publications on Sync media projection changes and reduced redundant recovery work, retaining periodic reconciliation as a backstop.
- Bounded Cloudflare SFU signaling, negotiation, and credential refresh deadlines so stalled media operations release controls and preserve recoverable timeout messages.
- Resumed camera and microphone media on existing publications after re-enable without exhausting media sections or losing remote playback.
- Paused media senders immediately, preserved rapid off/on command ordering, and restored sender state when Sync rejects a command.
- Closed forced-muted tracks, required fresh publications on re-enable, and recovered promptly without restoring other forced-off sources.
- Stopped receiver playback when projected media state is off, preserved self-paused state across coordinator recovery, and retried remote tracks when their media projection resumed.
- Preserved healthy remote streams, recovered ended tracks, and surfaced per-track pull failures with bounded retries for empty tracks.
- Updated generated API access contracts to match tightened authorization checks.

## [4.1.15] - 2026-08-25

### Fixed

- Bounded Cloudflare SFU recovery when a persisted remote publication no longer resolves to a provider track, while allowing a newer publication cursor to recover normally.
- Propagated the authoritative Episode start time to connected SDK surfaces so live duration displays advance correctly.
- Restored durable Episode diagnostic acknowledgements and production CLI inspection without weakening operator credential or HTTPS requirements.

## [4.1.14] - 2026-08-24

### Fixed

- Recovered public Space media connections after stale access grants while bounding Sync and Whiteboard reconnect backoff.
- Made production diagnostics references inspectable from the CLI when participant projections are empty.

## [4.1.13] - 2026-08-23

### Added

- Added durable, bounded diagnostics for Whiteboard transport recovery, browser RTC state, Cloudflare SFU failures, and Sync diagnostics export health.
- Added a fail-closed Sync diagnostics health check and a production uptime monitor that reports exporter degradation without stopping collaboration traffic.

### Fixed

- Recovered stale Cloudflare media sessions before negotiation and replaced sessions after retryable provider failures, so Participants can enable media after a dormant join.
- Reconnected a Whiteboard after its Sync transport closes, while preventing stale sockets and delayed callbacks from taking ownership of the recovered Board.
- Fixed Sync retention cleanup so expired Episode collaboration data no longer removes shared Space state that newer Episodes still use, and cleanup failures now report safe diagnostic classes.
- Kept Sync retention cleanup on the current Space chat prefix and allowed expired screen-share leases to be removed, so cleanup cannot create an interior message-sequence gap or remain blocked by stale leases.
- Kept public Space lifecycles active while an Episode still has a joining, active, or leaving Participant, so the creator leaving no longer ends the Episode for everyone else.
- Bound managed API and Sync telemetry identity to each release manifest so deployments cannot serve current images under stale release metadata.

## [4.1.12] - 2026-08-23

### Added

- Added Chalk Feedback across the React, React Native, web, mobile, and
  Dashboard surfaces. Bug reports, feature requests, and other feedback carry
  a removable screenshot plus bounded Journey, trace, runtime, and diagnostic
  evidence to a Chalk-only operator store and investigation CLI.
- Added public docs at `/docs` with Why Chalk, a working Quickstart,
  first-class TypeScript, React, and React Native guides, product concepts,
  feature guides, webhooks, public API guidance, local search, and responsive
  keyboard-friendly navigation.
- Added canonical metadata, structured data, a sitemap, crawler guidance,
  `llms.txt`, and a product-led social preview to the public web app.

- Added a shared animated `Logo` to the React and React Native SDKs. Its chalk
  sticks orbit by default and burst immediately on hover, focus, or press while
  the wordmark stays still; the web app now uses the same component.
- Added QR invite sharing, safe diagnostic references, optional Space
  descriptions, Entrance media-device selectors, capability-aware admission
  requests inside Participants, and Funavatars to the React SDK Space.
- Added `web` and `mobile` shipment targets to the affected-workspace gate, so
  shared SDK changes can validate one consumer lane without hiding shared,
  non-platform, global, or directly changed work.
- Added typed `classic` and `chalk` skins to the web React SDK theme. Classic is
  the default, the existing hand-drawn treatment remains available as Chalk,
  and either skin composes independently with every typed palette and texture.
- Added deterministic hand-drawn chalk controls across the React SDK Entrance
  and Space, plus public chalk buttons, fields, toggles, panels, menus, dialogs,
  alerts, sliders, badges, and loading primitives for custom SDK surfaces.
- Wired the React SDK sound cues: join, leave, chat, hand raise, and reaction
  cues from the shared assets play on Space changes, on by default behind the
  new `sounds` feature and a Settings toggle.
- Added a System, Light, and Dark theme choice to the dashboard account menu.
  The preference is remembered across visits and applied before the first
  paint, and it covers the dashboard, Space administration, and every chalk
  popup. Landing and legal pages stay on the paper palette.
- Added exact-SHA, component-aware managed release manifests and a manual
  release workflow that builds only the changed API or Sync image while
  carrying the stable component digest and provenance forward.
- Added a versioned SSM host deployment controller with fail-closed runtime
  inputs, health-gated promotion, automatic rollback, and exact secret restore
  after reboot.
- Added a local-first web release runner that builds one cached artifact,
  verifies staging by default, supports an explicit staging bypass, and reuses
  the same path as the CI fallback.
- Added a product-first landing journey for Account creation, dashboard entry,
  invite-link joining, and SDK discovery, backed by the official technology
  marks distributed through SVGL.
- Added an original responsive editorial illustration system to the landing
  page and distilled its shipped capabilities inventory into four readable
  groups.
- Added routed Space administration pages with readable configuration,
  Episode history, and separate details and Join Space actions.
- Added authenticated Dashboard Space entry by slug. Opening a Space now reuses
  its live Episode or starts one, admits the Dashboard Account as a stable
  Participant, and leaves only that Participant when the page closes.
- Added account-scoped Episode Debugger launch links to Episode details and the
  Developer page, with safe Episode references that resolve to canonical
  diagnostics only after tenant authorization.

### Changed

- Nested microphone input and speaker selection behind the Entrance microphone
  control and camera selection behind the camera control. The SDK preview now
  uses the same light defaults and deterministic device contract as the real
  Entrance, and its primary action keeps the same neutral primary color in
  light and dark themes.
- Reworked the React SDK Space controls, details, Settings, Participants,
  capability requests, Entrance, and exit surfaces into one consistent and
  responsive interaction system. Settings now has one visible surface with a
  combined Audio and video section, and Leave is separate from the
  capability-gated End Episode action.
- Removed the duplicate name-only Entrance, obsolete Settings groups, separate
  admission drawer, and unwired Transcript Space entry points while preserving
  the lower-level transcript contracts.
- Isolated the public Open a Space flow. Each new invite now gets its own
  one-hour Space, while invite joins reuse that Space. Cleanup archives it, so
  unrelated anonymous visitors no longer share durable chat or whiteboard data.
- Restored the React SDK’s pre-redesign Entrance and Space layouts as the
  Classic skin, and rebuilt the Chalk Entrance as a balanced responsive split
  between the camera preview and entry form.
- Rebuilt the React SDK Space stage on one measured renderer for both skins.
  Participants, each live screen share, and the open whiteboard are all stage
  tiles: any tile can be pinned or become the primary, spotlight shows one
  primary with a strip, and grid keeps tiles equal. Overflow pages instead of a
  "+N more" tile, tiles keep their video element across layout and page
  changes, and speaking and active-speaker come from sync presence. `Stage`,
  `buildStageItems`, `StageItem`, and `StageLayout` are exported; the
  `showScreenShareIndicator` and `screenShareContent` grid props are removed and
  `isVideoEnabled` now means the camera alone.
- Made the SDK preview gallery share a real captured canvas track and offer
  9- and 12-Participant rosters, so the stage renders live rather than behind a
  mock overlay.
- Brought `/sdk-preview` Entrance and Space states to production-surface parity
  with deterministic local media, device, whiteboard, lifecycle, admission,
  diagnostics, capability, feature, and theme controls. The tweaker now drives
  stable URLs while the visible Settings and End Episode controls exercise the
  same preview state.
- Replaced the React SDK Space side panels with one right-hand drawer in both
  skins. Chat, People, Transcript, and Admission dock as a full-height column
  that pushes the stage on wide screens and slide in as a sheet over a scrim on
  narrow ones; the drawer animates open and closed, honours reduced motion,
  closes on Escape, and returns focus to the control that opened it.
  `AdmissionPanel` gains an `onClose` prop and close button.
- Made React SDK Space grid tiles fill the stage: tiles now stretch to their
  whole cell instead of holding 16:9, so no band of empty stage is left around
  2, 9, or 12 Participants, and only absurdly tall or wide cells clamp to a
  3:4–21:9 range. `minTileHeight` joins the grid fit options and the aspect
  list is gone. Redesigned the tile name chip as one dark glass pill with the
  name, a red muted mark, and a yellow raised-hand mark, in both skins.
- Redesigned the React SDK Space chrome around the stage. The header is now a
  slim ghost bar with a Layout menu (Spotlight, Grid, Presentation) and Info
  next to Settings, the participants button leaves the header, the stage
  reaches further down under a floating control bar, and Share and Board
  join the bar. Presence is shown in the tile chip and as a soft halo on the
  avatar rather than a frame; the chip scales with the tile. Pager arrows sit
  at the strip edge with quiet dots, and the drawer docks as an inset card
  aligned with the stage. Reactions get a compact tray and a calmer float.
  The SDK preview gallery now enables the same features as the Space (share,
  whiteboard, sounds, info) and publishes a silent microphone track for
  unmuted Participants so speaking renders as it does live.
- Rebuilt the dashboard sidebar on a shadcn-style primitive: a chalkboard-dark
  panel with a collapsible icon rail, tooltips, a keyboard toggle, persisted
  state, and a drawer on small screens.
- Made the local API gate own its isolated migrated PostgreSQL database, expose
  every integration-test database alias, run independent checks in parallel,
  and avoid duplicate vet work in `go test`.
- Removed the unfinished standalone API performance harness. A replacement can
  return when it has stable workload, latency, and regression contracts.

### Fixed

- Made knock-mode Space arrivals create and replay their admission request from
  the locked arrival's Tenant and Space scope instead of returning a false
  idempotency conflict after the arrival was saved.
- Kept a newly created public Space admitted while its index URL becomes the
  canonical invite route, so that route ownership cannot leave the creator and
  archive the Space before another Participant arrives.
- Kept app-route fallbacks separate from public pages and static assets, so
  deep links load the SPA shell without redirect loops or incorrect asset
  content types.

- Removed the faint fill behind the floating Space controls and gave raised
  hover states enough vertical clip space to remain fully visible.
- Fixed Episode Debugger live evidence reconnect loops by replacing oversized
  streamed snapshots with compact refill directives and bounding every SSE data
  line to the browser decoder limit.
- Fixed the sidebar navigation labels, which the chalk reset drew over the
  utility classes that were meant to colour them, leaving them barely legible
  on the dark panel.
- Fixed the tenant switcher, which threw when it labelled its group of Tenants
  outside a menu group.
- Fixed chalk popups reading the theme once when they opened, so a menu, a
  tooltip, or a toast no longer keeps the old palette after the theme changes
  underneath it.
- Serialized web releases across SHAs, added guarded stale-lock recovery, and
  made manifest component ordering match runtime validation.
- Fixed the web release preflight, which read the pinned Wrangler version from
  the workspace before installing it and so failed on every fresh checkout.
- Fixed chat attachment reservation against the Space-scoped stream schema and
  corrected cleanup fixtures so historical Whiteboard scenes do not violate
  the one-current-scene constraint.
- Fixed named Dashboard joins so broker invite capabilities cannot silently
  connect Participants to a different Space, and ensured every Episode's
  authoritative start time, webhook Event, history row, and Episode Diagnostics
  root commit together.
- Stabilized the landing hero headline, removed decorative eyebrow labels from
  the primary product surfaces, and made the local SVGL marks valid standalone
  browser assets.
- Rebuilt the Dashboard and Episode Debugger into responsive, keyboard-friendly
  product surfaces with dependable navigation, readable tables and dialogs,
  complete-row affordances, and accessible mobile controls.
- Fixed Dashboard Space and Episode navigation so active Spaces are directly
  openable, Episode history links back to its Space, duplicate Space names show
  their slug, and empty diagnostic references no longer claim healthy evidence.
- Fixed server SDK AccessGrants dropping the optional diagnostics credential,
  which prevented browser Episode evidence from being captured.
- Fixed the hosted Episode Debugger so canonical diagnostic snapshots load
  directly after an alternate Episode reference resolves, including Episodes
  whose empty projections serialize required arrays.
- Fixed browser Sync startup recovery so a healthy connection is not replaced by
  stale queued snapshots, restored the Space Entrance, expanded the live Space
  across its host viewport, and made creator cleanup survive page unloads.
- Fixed the live Space diagnostics action so embedding apps can open the current
  Episode in the gated Episode Debugger on React and React Native.
- Fixed the guarded npm publish workflow for pnpm 10 and made release dispatches
  target `Q9Labs/chalk` explicitly.

## [4.1.11] - 2026-08-20

### Fixed

- Remounting Board refreshes the authoritative Sync snapshot even when an in-memory snapshot has the same revision.

## [4.1.10] - 2026-08-20

### Fixed

- Reopening Board refreshes the current durable scene instead of replaying a stale cached snapshot.

## [4.1.9] - 2026-08-20

### Fixed

- Made immediate Board reopen wait for replayed edits before loading its snapshot.

## [4.1.8] - 2026-08-20

### Fixed

- Preserved Board edits when a Participant closes the Board immediately after editing.

## [4.1.7] - 2026-08-20

### Added

- Added one `cspi1` public link and one API-owned arrival flow for every Space,
  including capability-first web and native clients, Dashboard link controls,
  `open` and `knock` admission, browser and native Guest credentials, and
  Cloudflare SFU and RealtimeKit media access.
- Added managed public Space creation with configurable bounded retention,
  durable cleanup and archive retries, and Episode-scoped Chat and Whiteboard
  content that cannot expose a prior Episode to a public Participant.

### Changed

- Made Space creation materialize its public invite in the same database
  transaction and made public arrival, refresh, leave, rotation, disablement,
  approval, denial, audit, tracing, and status use the API control plane.
- Added provider-neutral SDK media access and production RealtimeKit adapters
  for browsers and React Native while preserving the Cloudflare SFU path.

### Fixed

- Kept public invites compatible with browsers that send B3 tracing headers.

- Made managed migration repair apply only explicitly allowed missing
  checked-in migrations before the exact release target, while rejecting any
  other out-of-order gap.
- Kept managed release validation bound to the manifest migration target while
  accepting only the bounded missing-version arguments rendered by the release.

### Removed

- Removed both Episode broker workers, their public routes and cookies, the
  legacy 43-character invite format, and their runtime, monitor, development,
  mobile, and bootstrap configuration.

## [4.1.6] - 2026-08-20

### Fixed

- Kept the Board presentation command bound to its Whiteboard transport, so
  opening Board updates the shared Stage instead of failing before Sync sees it.
- Made managed releases apply their exact database migration target before API
  and Sync start, and made API readiness fail when the database schema is behind.
- Fetched managed runtime inputs in AWS SSM batches of at most 10, so releases
  can add required inputs without exceeding the service request limit.
- Created new Podman secrets without replacement mode on Podman 4.9, and removed
  candidate-only units when a managed release rolls back.
- Started the dedicated migration binary as the one-shot container entrypoint,
  so managed releases use the mounted owner database URL instead of API defaults.

## [4.1.5] - 2026-08-19

### Fixed

- Made Board presentation shared across every Participant in an Episode, focus
  it ahead of an active screen share, and keep the scene intact across
  close/reopen by flushing the final pending drawing before the canvas unmounts.
- Kept Board presentation safe during rolling upgrades and replay recovery:
  older Sync servers get the legacy handshake, older clients keep their exact
  wire shape, and a recovered connection refreshes shared presentation state.

## [4.1.4] - 2026-08-19

### Fixed

- Made the React SDK start and await the Whiteboard scene subscription before
  mounting its collaboration canvas, and made snapshot failures stay on the
  reported error path instead of escaping as uncaught synchronous errors.
- Made Cloudflare SFU failures retain an unknown provider error code, scrubbed
  provider message and fingerprint, request and response track counts, response
  size, and trace IDs without recording SDP, credentials, or media identifiers.
- Made managed host secret rotation use Podman's atomic replacement path and
  an actual input pipe, so Podman 4.9 can register new values without deleting
  the stable secret first.

## [4.1.3] - 2026-08-19

### Fixed

- Made React SDK Space sound cues recover when browser autoplay policy blocks
  the first attempt: the pending cue now retries on the next pointer, touch,
  click, or keyboard interaction. Cue audio also follows the selected speaker
  when the browser supports output-device routing.

## [4.1.2] - 2026-08-18

### Added

- Added `web` and `mobile` shipment targets to the affected-workspace gate, so
  shared SDK changes can validate one consumer lane without hiding shared,
  non-platform, global, or directly changed work.
- Wired the React SDK sound cues: join, leave, chat, hand raise, and reaction
  cues from the shared assets play on Space changes, on by default behind the
  new `sounds` feature and a Settings toggle.

### Changed

- Rebuilt the React SDK Space stage on one measured renderer for both skins.
  Participants, each live screen share, and the open whiteboard are all stage
  tiles: any tile can be pinned or become the primary, spotlight shows one
  primary with a strip, and grid keeps tiles equal. Overflow pages instead of a
  "+N more" tile, tiles keep their video element across layout and page
  changes, and speaking and active-speaker come from sync presence. `Stage`,
  `buildStageItems`, `StageItem`, and `StageLayout` are exported; the
  `showScreenShareIndicator` and `screenShareContent` grid props are removed and
  `isVideoEnabled` now means the camera alone.
- Made the SDK preview gallery share a real captured canvas track and offer
  9- and 12-Participant rosters, so the stage renders live rather than behind a
  mock overlay.
- Replaced the React SDK Space side panels with one right-hand drawer in both
  skins. Chat, People, Transcript, and Admission dock as a full-height column
  that pushes the stage on wide screens and slide in as a sheet over a scrim on
  narrow ones; the drawer animates open and closed, honours reduced motion,
  closes on Escape, and returns focus to the control that opened it.
  `AdmissionPanel` gains an `onClose` prop and close button.
- Made React SDK Space grid tiles fill the stage: tiles now stretch to their
  whole cell instead of holding 16:9, so no band of empty stage is left around
  2, 9, or 12 Participants, and only absurdly tall or wide cells clamp to a
  3:4–21:9 range. `minTileHeight` joins the grid fit options and the aspect
  list is gone. Redesigned the tile name chip as one dark glass pill with the
  name, a red muted mark, and a yellow raised-hand mark, in both skins.
- Redesigned the React SDK Space chrome around the stage. The header is now a
  slim ghost bar with a Layout menu (Spotlight, Grid, Presentation) and Info
  next to Settings, the participants button leaves the header, the stage
  reaches further down under a floating control bar, and Share and Board join
  the bar. Presence is shown in the tile chip and as a soft halo on the avatar
  rather than a frame; the chip scales with the tile. Pager arrows sit at the
  strip edge with quiet dots, and the drawer docks as an inset card aligned
  with the stage. Reactions get a compact tray and a calmer float. The SDK
  preview gallery now enables the same features as the Space (share,
  whiteboard, sounds, info) and publishes a silent microphone track for
  unmuted Participants so speaking renders as it does live.

### Fixed

## [4.1.1] - 2026-08-18

### Added

- Added typed `classic` and `chalk` skins to the web React SDK theme. Classic is
  the default, the existing hand-drawn treatment remains available as Chalk,
  and either skin composes independently with every typed palette and texture.
- Added deterministic hand-drawn chalk controls across the React SDK Entrance
  and Space, plus public chalk buttons, fields, toggles, panels, menus, dialogs,
  alerts, sliders, badges, and loading primitives for custom SDK surfaces.
- Added an environment-owned Cloudflare SFU default MediaPlane for new Spaces
  while keeping concrete Tenant-managed provider configuration authoritative.
- Enabled Google sign-in in the managed production API contract with a complete
  OAuth client triplet and the exact Chalk web callback.
- Added a System, Light, and Dark theme choice to the dashboard account menu.
  The preference is remembered across visits and applied before the first
  paint, and it covers the dashboard, Space administration, and every chalk
  popup. Landing and legal pages stay on the paper palette.
- Added exact-SHA, component-aware managed release manifests and a manual
  release workflow that builds only the changed API or Sync image while
  carrying the stable component digest and provenance forward.
- Added a versioned SSM host deployment controller with fail-closed runtime
  inputs, health-gated promotion, automatic rollback, and exact secret restore
  after reboot.
- Added a local-first web release runner that builds one cached artifact,
  verifies staging by default, supports an explicit staging bypass, and reuses
  the same path as the CI fallback.
- Added a product-first landing journey for Account creation, dashboard entry,
  invite-link joining, and SDK discovery, backed by the official technology
  marks distributed through SVGL.
- Added an original responsive editorial illustration system to the landing
  page and distilled its shipped capabilities inventory into four readable
  groups.
- Added routed Space administration pages with readable configuration,
  Episode history, and separate details and Join Space actions.
- Added authenticated Dashboard Space entry by slug. Opening a Space now reuses
  its live Episode or starts one, admits the Dashboard Account as a stable
  Participant, and leaves only that Participant when the page closes.
- Added account-scoped Episode Debugger launch links to Episode details and the
  Developer page, with safe Episode references that resolve to canonical
  diagnostics only after tenant authorization.
- Added one public Space invite contract for customer-managed and auto-created
  Spaces, with collaborator Guest admission, open and knock policies, durable
  rotation controls, browser and React Native clients, and SFU or RealtimeKit
  media grants.

### Changed

- Rebuilt the dashboard sidebar on a shadcn-style primitive: a chalkboard-dark
  panel with a collapsible icon rail, tooltips, a keyboard toggle, persisted
  state, and a drawer on small screens.
- Restored the React SDK’s pre-redesign Entrance and Space layouts as the
  Classic skin, and rebuilt the Chalk Entrance as a balanced responsive split
  between the camera preview and entry form.
- Made the local API gate own its isolated migrated PostgreSQL database, expose
  every integration-test database alias, run independent checks in parallel,
  avoid duplicate vet work in `go test`, and overlap PostgreSQL preparation
  with database-free checks.
- Made detached local web releases reuse the main checkout's Turbo cache while
  keeping web build inputs and the exact release SHA in the cache key.
- Moved public Space creation, admission, credential refresh, leave, and timed
  auto-Space archival into the API, so every canonical invite resolves an exact
  Tenant and Space before account or Guest identity is selected.
- Removed the unfinished standalone API performance harness. A replacement can
  return when it has stable workload, latency, and regression contracts.

### Fixed

- Fixed Episode Debugger live evidence reconnect loops by replacing oversized
  streamed snapshots with compact refill directives and bounding every SSE data
  line to the browser decoder limit.
- Fixed the dependency vulnerability gate under macOS's system Bash so its
  lockfile discovery no longer fails inside nested null-delimited reads.
- Fixed first join for newly created Spaces whose Tenant has no custom
  MediaPlane configuration, and added bounded resolver traces, metrics, and
  structured logs for the selected configuration source.
- Fixed the sidebar navigation labels, which the chalk reset drew over the
  utility classes that were meant to colour them, leaving them barely legible
  on the dark panel.
- Fixed the tenant switcher, which threw when it labelled its group of Tenants
  outside a menu group.
- Fixed chalk popups reading the theme once when they opened, so a menu, a
  tooltip, or a toast no longer keeps the old palette after the theme changes
  underneath it.
- Restored the landing hero's anonymous Space entry so its primary action opens
  the `/space` Entrance without Account authentication.
- Serialized web releases across SHAs, added guarded stale-lock recovery, and
  made manifest component ordering match runtime validation.
- Fixed the web release preflight, which read the pinned Wrangler version from
  the workspace before installing it and so failed on every fresh checkout.
- Fixed chat attachment reservation against the Space-scoped stream schema and
  corrected cleanup fixtures so historical Whiteboard scenes do not violate
  the one-current-scene constraint.
- Fixed named Dashboard joins so broker invite capabilities cannot silently
  connect Participants to a different Space, and ensured every Episode's
  authoritative start time, webhook Event, history row, and Episode Diagnostics
  root commit together.
- Stabilized the landing hero headline, removed decorative eyebrow labels from
  the primary product surfaces, and made the local SVGL marks valid standalone
  browser assets.
- Rebuilt the Dashboard and Episode Debugger into responsive, keyboard-friendly
  product surfaces with dependable navigation, readable tables and dialogs,
  complete-row affordances, and accessible mobile controls.
- Fixed Dashboard Space and Episode navigation so active Spaces are directly
  openable, Episode history links back to its Space, duplicate Space names show
  their slug, and empty diagnostic references no longer claim healthy evidence.
- Fixed server SDK AccessGrants dropping the optional diagnostics credential,
  which prevented browser Episode evidence from being captured.
- Fixed the hosted Episode Debugger so canonical diagnostic snapshots load
  directly after an alternate Episode reference resolves, including Episodes
  whose empty projections serialize required arrays.
- Fixed browser Sync startup recovery so a healthy connection is not replaced by
  stale queued snapshots, restored the Space Entrance, expanded the live Space
  across its host viewport, and made creator cleanup survive page unloads.
- Fixed the live Space diagnostics action so embedding apps can open the current
  Episode in the gated Episode Debugger on React and React Native.
- Fixed the guarded npm publish workflow for pnpm 10 and made release dispatches
  target `Q9Labs/chalk` explicitly.

## [4.1.0] - 2026-08-16

### Added

- Added `spaces.get`, `spaces.list`, `spaces.archive`, and `spaces.restore` to the
  `@q9labsai/chalk-client` server SDK, with `archived` and `archived_at` on the
  returned Space.
- Added sidebar and menu primitives to `@q9labsai/chalk-ui`.

### Changed

- Let a `getAccess` callback return the server-minted grant unchanged as the
  `Response` that carries it or as its decoded JSON (`AccessGrantSource`). The
  client validates the grant and fails the join with `Access was rejected`, so
  applications proxying their own join endpoint no longer need a cast.
- Refreshed the TypeScript SDK and API dependencies to their current releases.

### Fixed

- Fixed visitor Space access refresh so the browser forwards media proof to the
  broker. Proof-less renewals made the broker replace the media connection,
  which the client rejected at the first refresh window as an invalid grant.
- Fixed Dashboard Space access refresh so scheduled renewal preserves current
  media proof and rejected credentials recover with a replacement connection.
- Accepted PostgreSQL-formatted UUID values in the generated client schemas and
  preserved Episode conflict and upstream statuses in the generated HTTP API.

## [4.0.1] - 2026-08-09

### Fixed

- Hardened the Metro image-size dependency against the upstream-unfixed
  zero-length parser loops and added ESM/CJS regression coverage.

## [4.0.0] - 2026-08-08

> Recording and transcription hosted infrastructure is intentionally excluded
> from this release. Those hosted services are not part of 4.0.0.

### Added

- Added the public `@q9labsai/diagnostics-contracts@0.1.0` package for shared,
  versioned Episode Diagnostics validators, schemas, and fixtures. Publish it
  before `@q9labsai/chalk-client`, then publish `@q9labsai/chalk-react`; this
  manual order keeps the client's public runtime dependency resolvable.

- Added six labeled Home and Entrance mobile inspiration studies, including cardless, illustrated, bottom-sheet, and preview-first directions.

- Added a development-only, URL-addressable SDK state gallery for the Entrance and Space, including loading, waiting, empty, warning, retry, confirmation, timeout, failure, recovery, and ended states built from production React SDK components.

- Added a development-only, deep-linkable React Native mobile gallery built
  from canonical `<Entrance />` and `<Chalk />` fixtures over a local
  deterministic `SpaceClient`/`SpaceSnapshot`, with app-owned `PreviewStatus`;
  its permission-free, network-free Entrance and Space states expose only
  supported native knobs with lifecycle surface parity.

- Added a web `JoinFailedScreen` with retry and Entrance actions, plus an explicit zero-Participant state for `ParticipantGrid` across desktop and mobile layouts.

- Added the first fixture-backed Chalk dashboard slice in `apps/web`, with a responsive general-product shell, Home and Spaces routes, the New Space dialog, and routed foundations for Episodes, Artifacts, People, Developer, Activity, Tenant settings, and Account.

- Added the dashboard Account/Tenant foundation: self-scoped Tenant discovery, atomic idempotent owner onboarding, a hardened same-origin account boundary, sign-in and sign-up, resumable Tenant selection, Account and Tenant reads, generated client contracts, trace proof, and public boundary monitoring.

- Added an account- and Tenant-scoped Episode Diagnostics debugger for
  localhost and staging, with bounded SDK, Sync, and API evidence; redacted
  snapshots, projections, streams, and exports; web and CLI inspection tools;
  W3C journey correlation; and a safe capacity harness. Hosted enablement and
  deployment remain manual.

- Added the framework-neutral `SpaceClient` with one stable `SpaceSnapshot`
  store, typed events, opaque `AccessGrant` refresh, and namespaced media,
  chat, Participant, reaction, and whiteboard controllers.
- Added identical React and React Native bindings built around `<Chalk />`,
  `<Entrance />`, `<ChalkProvider>`, the closed nine-hook surface, capability-
  driven controls, lifecycle recovery, settings, layouts, and closed theme
  tokens.
- Added `@q9labsai/chalk-react-native/client` for advanced native
  `SpaceClient` construction with custom API and Sync endpoints.
- Added the Episode broker, managed-Episode runtime assets, and recorder
  transition guards. Deployment and hosted cutovers remain manual.
- Added end-to-end W3C journey propagation from the SDK Sync hello through every
  Sync server frame, plus the durable `sync.episode.event.committed` signal
  emitted after the Episode command and event are committed.
- Added credential- and PII-safe telemetry restoration and export. Persisted
  events are sanitized before requeue, re-persistence, and export while bounded
  journey metadata remains available for diagnosis.

### Changed

- Redesigned the React Native mobile experience around the Chalk Light system, with first-run onboarding, a new Spaces home, a responsive Entrance, polished live Space controls and progressive sheets, reduced-motion-aware transitions, and the current gradient Chalk launcher icon.

- Refined the React Native Home with illustrated cardless creation and history states plus a Create Space bottom sheet, increased the Entrance preview and safe-area spacing, and added all 15 React SDK palettes and three material textures as native appearance controls.

- Tightened the React Native Space and Entrance headers, removed the redundant Secure badge, softened the Participant count, and made every Space sheet cover the persistent control dock through the device safe area.

- Added independently composable palette and texture options to the React `SpaceView` and `<Chalk />`, including seven paired light and dark color families plus clean, paper, and slate materials. Appearance settings now switch the active surface immediately, and the SDK preview opens directly to that surface for visual comparison.

- Reworked the platform around durable Spaces, bounded Episodes, and
  per-Episode Participants across the database, API, Sync wire, SDKs, apps, and
  infrastructure.
- Replaced built-in authority roles with customer-defined Roles and one closed
  Capability vocabulary. UI authorization now derives only from Participant
  capabilities.
- Moved client access internals under `access` and lifecycle coordination under
  `connection`; the retired client lifecycle namespace and phase mirrors are
  gone.
- Moved the client media-plane interface into a neutral contract shared by Sync
  and provider adapters.
- Moved the first-party web and mobile entry flow to `/space`, app-owned
  identity arrival, opaque access grants, and canonical Participant-credential
  cleanup.
- Squashed the unreleased control-plane database history into a clean
  Space/Episode baseline and aligned generated contracts with it.
- Consolidated reusable React primitives under `@q9labsai/chalk-ui` while
  keeping the public SDK subpath and shared visual language aligned with the
  paper, cool-neutral, watercolor, and chalk-stick design language.
- Renamed observability-facing webhook, provider, and uptime vocabulary to the
  canonical Space/Episode/Participant and connection terms, and isolated the
  observability E2E stack with unique resources, dynamic ports, durable-event
  checks, and task-owned cleanup. Hosted dashboard, provider-rule, and uptime
  consumer cutovers remain manual; this entry does not imply a deployment.

### Breaking

- Replaced `ChalkSession` and `ParticipantAccess` with `SpaceClient` and opaque
  `AccessGrant`; feature commands now live under the canonical namespaced
  controllers.
- Replaced `VideoConference`, `ConferenceView`, and `PreJoinScreen` with
  `<Chalk />`, `SpaceView`, and `<Entrance />`. Legacy exports, props, hooks,
  compatibility aliases, and role booleans were removed.
- Renamed Go, OpenAPI, webhook, Sync, Whiteboard, route, event, schema, broker,
  and runtime vocabulary to Space, Episode, Participant, `EpisodeLease`, and
  `LeaseStore`. Compatibility fallbacks for the unreleased vocabulary were
  removed.
- Renamed the server SDK namespaces to `spaces` and `episodes`, with canonical
  Participant identifiers and generations.
- Replaced the broker's legacy routes, cookie, bindings, environment keys, and
  worker identity with `/participant-credentials`, `/access-grants`,
  `EPISODE_LEASES`, `CHALK_EPISODE_DEADLINE_SECONDS`, and
  `chalk-episode-broker`. Hosted rollout remains a manual cutover.

### Removed

- Removed built-in host/cohost authority, host-exit policy, and role-name-based
  UI decisions.
- Removed app-local mock collaboration flows and standalone demo behavior that
  duplicated SDK-owned lifecycle, chat, media, or whiteboard state.
