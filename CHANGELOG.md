# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

- **Mobile release: host-key verification now blocks bad bundles before ship** — release tooling now proves the supplied prod mobile host key can exchange against `POST /api/v1/auth/token` before any uploadable bundle/archive is produced, Android closed/prod builds are explicitly treated as CI-artifact-only, and the next hotfix lane advances to `0.0.15 / 15`.

## [0.0.79] - 2026-03-23

### Added

- **Mobile tooling: wireless adb + launch shortcuts** — added a repo-local `chalk-mobile-wireless-debug` skill with reusable wireless adb reconnect/launch helpers, plus root `bun run mobile:connect`, `bun run mobile:launch`, and `bun run mobile:logs` shortcuts so real-device Chalk Android debugging can be recovered quickly without rediscovering the MIUI/Expo flow each session.
- **Mobile home can suggest copied invite links** — added Expo clipboard support plus a one-tap “Join copied invite” suggestion on the mobile home screen whenever the clipboard already contains a valid Chalk `/j/:token` link.
- **SDK invite-link joins now have first-class APIs** — added `joinWithJoinToken`, `joinWithInviteLink`, and cached join-token token providers in Chalk core/React so consumers can join canonical rooms without smuggling friendly codes through `roomId`.

### Changed

- **First-party meeting identity now resolves by workspace + room UUID** — Chalk web/internal auth now provisions personal workspaces inside a shared first-party tenant instead of creating per-user internal tenants, dashboard joins preserve canonical `room_id` through signed join-link exchange, and in-room invite UI now surfaces the real guest `/j/:token` link rather than reusing the host page URL.
- **Meeting entry is now invite-link-first across Chalk surfaces** — web landing no longer accepts raw room codes, mobile join input now only accepts signed invite links, and Android app links only claim `/j/*` so arbitrary `/room/*` or typed codes stop acting like a product contract.
- **Mobile: Android release path now reflects the actual V1 contract** — Android app links now cover both `/j/*` and `/room/*`, release docs/checklists now document clipboard-invite behavior without adding a manifest permission, and the current no-Android-screen-share V1 no longer requests media-projection release permission by default.
- **Mobile/Android: post-upload release ops now match internal track `10`** — Android release docs now include checksum and `gplay` track/bundle verification commands, and `apps/mobile/android/app/build.gradle` fallback version metadata now stays aligned at `0.0.10` / `versionCode 10` with Expo config and checked-in Gradle properties.
- **Mobile/iOS: V1 release contract now disables local screen-share start** — the iOS app shell no longer advertises local mobile-originated screen sharing before ReplayKit/app-group work exists, and the release checklist now treats iOS V1 as receive-only for screen-share until a dedicated native pass lands.
- **Mobile/iOS: raw TestFlight path is now the documented release lane** — mobile release docs no longer rely on Expo/EAS ownership, and the repo now treats Xcode signing + archive + App Store Connect upload as the canonical iOS publishing path.

### Fixed

- **Mobile auth/release: prod builds can no longer bootstrap local host tenants** — mobile host bootstrap now keys off the resolved runtime API URL instead of raw env, refuses `/api/v1/tenants` on non-local targets, surfaces stale prod host-key failures loudly, and local Android/iOS prod builds now have a guarded wrapper that strips `.env.local` and forces prod API/WS env before bundling.
- **Mobile/Android: closed test `Gamma` now carries the room-join fix build** — bumped native/release metadata to `0.0.13 / versionCode 13`, rebuilt the signed AAB, and rolled the closed testing track forward so testers get the canonical-room join fix instead of the broken `12` build.
- **Mobile/SDK-Core: faster native join failures + canonical invite rooms** — mobile join-token exchange now requires the server-provided canonical `room_id` instead of falling back to room names, React Native RTK join retries now create a fresh native join per attempt with a tighter native timeout budget, and the raw iOS lane successfully uploaded `0.0.12 (12)` to TestFlight processing while preserving the current dSYM warning breadcrumbs.
- **Mobile host meetings now create real backend rooms before lobby join** — mobile `New meeting` now mirrors web by creating a backend room first and carrying the returned canonical UUID into the lobby, replacing the old client-only `instant-meeting-*` ids that could never be shared safely across app boundaries.
- **Mobile/Release: first signed internal Android upload proven** — repaired a mangled `build.gradle` version fallback that blocked `bundleRelease`, bumped the native build to `0.0.10` / `versionCode 10`, built the signed AAB locally, and successfully committed it to the Play internal track after dropping the unsupported `--changes-not-sent-for-review` flag for this app’s review mode.
- **Prod app auth: web now receives the same host API key secret as mobile** — created a fresh prod external tenant cloned from the active first-party Chalk limits/config shape, rotated repo secret `VITE_CHALK_API_KEY` to that tenant, and updated web CI to inject the same secret mobile release already uses so host-key-backed app routes share one explicit prod tenant instead of drifting between internal claim tenants and stale release secrets.
- **Web/dashboard: scheduled sessions now load and render from the real rooms API** — the dashboard now uses internal auth for its Chalk SDK session, isolates that auth state from the generic app cache, and actually fetches scheduled/active rooms for the Scheduled Sessions panel so `POST /api/v1/rooms/schedule` results appear in the UI immediately instead of disappearing behind an empty stub list.
- **CI/Web: pruned installs no longer crash on missing mobile patch script** — root `postinstall` now skips cleanly when `scripts/patch-realtimekit-react-native.ts` is absent from a pruned workspace, so web CI can install the trimmed repo without failing before build steps.
- **Infra: R2 recordings no longer auto-transition to Infrequent Access** — removed the 7-day R2 lifecycle storage-class transition for the lean recordings bucket while keeping the 30-day delete rule, because IA operation charges outweighed the tiny storage savings at current bucket size.

## [0.0.78] - 2026-03-17

### Added

- **SDK-Core: strict Chalk webhook Express adapter** — `@q9labs/chalk-core` now ships a hardened Express webhook adapter with exact 400/401/413/415 responses, parser-error middleware, raw-hex signature normalization, and request-attached delivery/body metadata so consumers do not have to hand-roll verification plumbing.

### Changed

### Fixed

- **API: webhook delivery logs now expose final payload presence** — final Chalk post-meeting webhook delivery logs now include whether the delivered payload actually contained recording, transcript, summary, action items, and errors, making tenant incident triage possible from the last delivery event alone.
- **SDK release CI: pruned publish installs no longer crash on mobile-only postinstall work** — the RealtimeKit Android patch script now cleanly skips when `apps/mobile` or the native package is absent, so SDK release publishes can install the pruned workspace without failing before the actual package build/publish steps.

## [0.0.77] - 2026-03-17

### Added

- **SDK-Core: strict Chalk webhook Express adapter** — `@q9labs/chalk-core` now ships a hardened Express webhook adapter with exact 400/401/413/415 responses, parser-error middleware, raw-hex signature normalization, and request-attached delivery/body metadata so consumers do not have to hand-roll verification plumbing.
- **Mobile/E2E: Maestro Android new-meeting flow scaffold** — added repo-local Maestro flows for `ai.q9labs.chalk.mobile` that reset camera/mic permissions, drive `New meeting -> lobby -> Join Meeting`, and capture numbered screenshots into a stable local test-output directory for emulator verification.
- **API/Admin: durable Whisper job history + live processing visibility** — Whisper queue submissions now persist per-job metadata and terminal outcomes in Postgres (`whisper_transcription_jobs`) without storing presigned audio URLs, and admin endpoints now expose paginated history, live processing job metadata, and queue/processing counts for practical ops visibility without external analytics tooling.
- **SDK-Core: local mutation-testing harness for participant avatar recipe** — `packages/sdk-core` now includes a focused Stryker + Vitest harness for `src/utils/participant-colors.ts` plus dedicated mutation specs around the shared avatar recipe contract, improving the targeted mutation score from `42.48%` to `84.97%`.
- **Mobile/Android: Play upload lane scaffolded** — `apps/mobile` now has real release signing config, ignored local keystore paths, a generated upload keystore + repo-local `gplay` auth scaffold, Android splash image generation from Expo config, and release docs that name the exact Google Cloud project/service account needed for Play uploads.
- **Mobile: Android+iOS release scaffolding** — `apps/mobile` now ships production-aware Expo config (`app.config.ts`), EAS profiles, Android release-signing scaffold, debug-only cleartext handling, iOS prebuild project files, mobile runtime helper tests, and release checklist docs so internal alpha/store-prep work can happen from a consistent native baseline instead of an ad-hoc dev-client setup.
- **Repo skill: Chalk mobile release workflow** — added a dedicated `chalk-mobile-release` skill covering Android/iOS release flow, Play internal testing, `gplay`/Play Console workarounds, Helium browser guidance, and Chalk-specific mobile release pitfalls so future release passes reuse the same proven process.

### Changed

- **Mobile/Android: internal release advanced to build 4** — bumped the Expo/app-store version metadata to `0.0.4` / Android `versionCode 4` / iOS `buildNumber 4` so a fresh internal-testing upload can carry the release URL fallback fix after Play burned version code `3` during the first successful bundle upload attempt.

### Fixed

- **API: webhook delivery logs now expose final payload presence** — final Chalk post-meeting webhook delivery logs now include whether the delivered payload actually contained recording, transcript, summary, action items, and errors, making tenant incident triage possible from the last delivery event alone.
- **SDK-Core: screen-share diagnostics now keep the real browser failure** — screen-share start errors now preserve the original DOMException as the emitted `cause`/details, and the manager no longer emits a second generic `Failed to start screen sharing` error that was masking the first useful failure in copied diagnostics.
- **Mobile/local-dev: host auth now self-heals at join time** — when a local simulator/device build still carries a stale `EXPO_PUBLIC_CHALK_API_KEY`, the mobile host token provider now detects `invalid API key` from the local API, mints a fresh local tenant key on the fly, stores it in SecureStore, and retries so host joins stop failing in lobby with `Token exchange failed: {"error":"invalid API key"}`.
- **Mobile/local-dev: stale mobile host keys now self-heal from local web env** — added `bun run mobile:sync-local-env`, which validates the local Chalk host key against `http://localhost:8080`, reuses the valid key from `apps/web/.env.local` when present, or mints a fresh local tenant key and syncs both web/mobile env files so `New meeting` stops failing in simulator/device local runs from env drift.
- **Mobile/Android: release builds now source the prod host key from CI secrets** — Android release automation now injects `EXPO_PUBLIC_CHALK_API_KEY` from GitHub Actions secret `VITE_CHALK_API_KEY` alongside forced production API/WS URLs, so Play internal builds can create new meetings in prod without relying on stale local env files.
- **Mobile: production builds now hard-block device-local API/WS envs** — Android/iOS release builds now force Chalk production API and WebSocket endpoints whenever `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` still point at `localhost`, so store builds cannot regress into `New Meeting -> Network Error` from leaked local env files.
- **Mobile/Android: release APK builds no longer fail inside RealtimeKit resources** — added a repo-level postinstall patch that injects the missing `blob_provider_authority` string resource into `@cloudflare/realtimekit-react-native`, so signed `assembleRelease` builds stop failing in `:cloudflare_realtimekit-react-native:verifyReleaseResources` on fresh installs.
- **SDK-React-Native: release bundle no longer references uncommitted meeting helpers** — added the missing `NativeReactionPicker` component and `pickStageParticipant` utility/test that the committed native meeting room already imported, unblocking clean Android release bundles from failing during JS bundling on `./NativeReactionPicker`.
- **Mobile: release builds no longer ship dead localhost API/WS endpoints** — the React Native runtime now treats `localhost`/`127.0.0.1` mobile env URLs as dev-only, rewrites them to the Metro host during local device sessions, and falls back to Chalk production API/WebSocket endpoints when no Metro host exists so Play/TestFlight builds stop failing `New Meeting` with `Network request failed`.
- **SDK-React-Native/mobile: duplicate lobby joins now ignored locally** — the native prejoin flow now latches the first join intent, disables the join CTA immediately, and blocks any second `session.join()` attempt while a join is already pending/connecting, preventing lobby fallbacks like `Already connected to a room` from accidental duplicate submits.
- **SDK-Core/mobile: safe DOMException handling in React Native** — shared error normalization now guards the browser-only `DOMException` global and still maps DOMException-shaped media/join errors on React Native, preventing native join failures from bouncing users back to lobby with `property DOMException doesn't exist`.
- **Mobile: stale host-token self-heal for new meetings** — `apps/mobile` now scopes cached host auth by API URL + key fingerprint and, if room creation still returns `host role required`, clears the stored host auth state and retries once so previously cached bad tenant tokens stop blocking `New meeting`.
- **API: embedded screen-annotation migration restored** — added runtime migration `013` back into the embedded Postgres bootstrap so local/prod boot paths create `rooms.screen_annotation_state` before generated room queries reference it, preventing add-participant/join failures from schema drift.
- **SDK-Core/SDK-React/SDK-React-Native: shared avatar recipe contract** — introduced a single `sdk-core` participant avatar recipe derived from the web FaceHash treatment, then switched web avatar rendering, profile-gradient preview initials, and native avatar/self-pill surfaces to consume the same initials, face colors, and darker/avatar gradient semantics instead of rebuilding them per platform.
- **SDK-Core/SDK-React/SDK-React-Native: shared participant identity visuals** — moved the name-hashed participant gradient/avatar palette logic into `sdk-core`, re-exported it for web, and wired the same generated gradients into native lobby/joining/meeting identity surfaces so mobile now follows the web avatar color rules.
- **SDK-React-Native/mobile: animated native avatar + lobby preview path** — the native lobby/joining/meeting fallback avatar now blinks and pulses like the web facehash treatment, the mobile-only extra preview control was removed, and the native prejoin flow now opens a real `react-native-webrtc` local camera preview stream with stricter video-track validation.
- **SDK-React-Native/mobile: leave flow end-screen handoff** — leaving a native room now finalizes into the end screen through a normal screen swap instead of a modal layered over the RTC surface, reducing the Android case where the call visually stayed mounted after disconnect while controls were already dead.
- **SDK-React-Native/mobile: native leave no longer re-enters the room** — the native conference shell now only auto-promotes from `joining -> meeting` once the room actually finishes joining, so tapping the red end button cannot race back into the live meeting view while the transport is still briefly connected.
- **SDK-React-Native/mobile: room shell imports the native platform helper again** — restored the missing React Native `Platform` import used by the room dock spacing, clearing the immediate `Platform doesn't exist` runtime/build failure in the native meeting room.

## [0.0.76] - 2026-03-15

### Added

- **Web: first local mutation-testing rep for avatar gradients** — `apps/web` now includes a focused Stryker + Vitest mutation-testing harness for `src/lib/avatarGradient.ts`, plus broader unit coverage around fallback initials, storage/event helpers, and exact derived/preset gradient resolution so the first mutation pass improved from `40.4%` to `85.43%` on that target.

### Changed

### Fixed

- **SDK-React: tighter host-app style isolation** — Chalk roots now apply a stronger scoped reset under `[data-chalk]` / `.chalk-root` so consumer app typography, list, form-control, media, and button base rules are less likely to bleed into Chalk surfaces.
- **SDK-Core: background images normalized before virtual-background apply** — image backgrounds now resolve through a local object-URL step before passing into the RealtimeKit transformer, reducing cross-origin/canvas-taint failures and correctly revoking temporary object URLs on clear/swap.
- **UI: portaled Chalk surfaces keep their own theme** — settings, selects, dropdowns, dialogs, and tooltips now carry explicit Chalk scope/theme when rendered through portals so host app styles and light/dark defaults do not leak in.
- **SDK-React-Native/mobile: Hugeicons prejoin lobby patched** — aligned the mobile app and native SDK on Hugeicons core `4.x`, replaced stale prejoin icon symbols with the current exported names, and deferred join/cancel screen swaps until after keyboard/interaction teardown so the Hugeicons-backed lobby stays stable on Expo Android.
- **Mobile/Expo: Hugeicons singleton resolution** — the Expo Metro config now pins Hugeicons and `react-native-svg` imports to the app-local install, preventing workspace package duplicates from loading separate native icon stacks during the lobby render path.
- **Mobile/Expo: blank dev-client launch path** — the Android dev client boot path now includes the missing Expo/Metro runtime pieces (`expo-splash-screen`, `@babel/runtime`) and keeps Hugeicons/SVG native ownership app-local: Metro blocks both workspace-local and Bun-store nested `react-native-svg` copies while still resolving Expo internals, fixing the splash crash, bundle failures, and duplicate `RNSVG*` registration that left the dev client on a blank surface before the Chalk UI mounted.

## [0.0.75] - 2026-03-14

### Added

- **Web/SDK-React: PWA install + update support** — `apps/web` now ships a real Chalk web app manifest, root service worker, install/update/offline prompt shell, and a reusable `usePwaInstall` hook in `@q9labs/chalk-react` so host apps can detect installability and standalone mode without app-specific browser wiring.
- **Docs: canonical Chalk design system reference** — added `docs/design-system/chalk-design-system.md` as the source-of-truth doc for Chalk's current design system, including `sdk-react` core ownership, `apps/web` brand-layer ownership, current mobile drift, and the normalized token model future work should converge toward.
- **Docs: Chalk Pencil design-system file** — added `docs/design-system/chalk-design-system.pen` as a dedicated Pencil artifact with separate Core and Brand system sections, reusable primitives, and composition shells for design-system assembly work.
- **SDK-React-Native: initial workspace scaffold** — added `@q9labs/chalk-react-native`, React Native runtime shims in `sdk-core`, and a new Expo-based `apps/mobile` demo app for native Chalk integration work.
- **SDK-React-Native: turnkey native meeting flow** — `@q9labs/chalk-react-native` now exports parity-oriented native hooks plus turnkey `NativeVideoConference`, `NativePreJoinLobby`, `NativeMeetingRoom`, `NativeMeetingPanel`, `NativeMediaView`, joining, and end-screen components so native apps can compose Chalk meeting UX from the package instead of rebuilding room flow in-app.

### Changed

- **Repo: local artifact ignore rules** — root ignore rules now cover Codex/browser caches, Go/build scratch dirs, Turbo prune output, and Expo-generated temp/export folders so routine local work stops polluting `git status`.
- **Web: route fallback + room end flow refresh** — refreshed TanStack fallback surfaces and room end/index route wiring, including updated web hero assets and generated route tree updates.
- **API: internal auth flow migrated to Google OAuth** — internal dashboard auth now exchanges Google auth codes, serves session/logout endpoints, and removes the previous magic-link email dependency.
- **Web: dashboard shell redesign** — `apps/web` dashboard and root shell received a darker editorial visual refresh, with simplified web-app meta handling and updated empty/loading surfaces.
- **Docs: site brand refresh + design-system expansion** — the Astro docs splash, assets, and custom theme styling now align with the current Chalk brand direction, and the design-system doc adds tactile, layering, shell, and status guidance for core UI work.
- **CI: web build auth envs** — the web workflow now clears stray local env files before building and injects the Google client ID needed by the updated internal auth flow.
- **Mobile app: package-first meeting wiring** — `apps/mobile` now keeps room auth/deeplink routing in-app but delegates lobby, joining, room, panels, and end-state UX to `@q9labs/chalk-react-native` turnkey components, matching the web app’s thin-consumer architecture more closely.
- **Mobile app: legacy manual meeting path removed** — deleted the old app-local `LobbyScreen`, `RoomScreen`, and joining-screen implementation plus obsolete room-route helpers, leaving the Expo app with a single SDK-driven meeting path.

### Fixed

- **SDK-React: mobile pre-join camera toggle fallback** — the pre-join lobby now ignores stale stored device ids when live device lists disagree, and first-run camera/mic activation falls back to the browser default device instead of flickering back off after an exact-device `getUserMedia` failure on mobile browsers.
- **Whisper worker: expire replayed jobs + harden long-job lock liveness** — worker now fails over-age queued/recovered jobs before re-downloading/transcribing them, refreshes processing locks from a separate heartbeat process instead of an in-process thread, and lean prod whisper defaults are restored to `c7i.xlarge` with `4` CPU threads to reduce long-recording stalls on `c7i.large`.
- **Whisper worker: modular runtime + packaged layout + local transcription smoke path** — split the Python worker into focused queue, metrics, and job-processing modules under a dedicated `whisper_worker/` package, added regression coverage for successful job cleanup plus HTTP download diagnostics, and introduced a local `transcribe_file.py` smoke harness used to verify real audio transcription output on CPU.
- **React: aligned local pins to the latest safe 19.2.x line** — moved `packages/sdk-react` test-time `react`/`react-dom` pins and `apps/web`'s exact React pins to `19.2.4` so local installs stay on the patched line while preserving version alignment during workspace tests.
- **Infra: singleton whisper spot self-healing** — the lean whisper worker now runs behind a 1x1x1 Auto Scaling Group backed by one-time spot launch templates, so interrupted capacity is replaced automatically without leaving duplicate workers running at the same time.
- **Web: PWA browser chrome + cache safety** — Chalk now keeps `theme-color` in sync with light/dark/nord theme changes, avoids service-worker caching of API/WebSocket traffic, and serves the manifest/service worker with revalidation-friendly cache headers.
- **Web: Chalk favicon + mobile PWA icons** — the web shell, install manifest, and Apple touch icon now all use the official Chalk mark instead of the leftover starter raster assets.
- **Web/SDK-React: richer PWA polish** — Chalk now ships dedicated Android maskable icons, per-shortcut launcher art, platform-aware install instructions (desktop install vs Safari Add to Dock/Add to Home Screen), and update toasts that read the waiting service worker’s build metadata instead of guessing.

## [0.0.74] - 2026-03-12

### Added

### Changed

- **SDK-React: fun avatar toggle + richer FaceHash styling** — meeting Appearance settings now let each participant switch generated FaceHash avatars on or off locally, and the generated avatar fallback now requests dramatic 3D intensity with blinking enabled.
- **SDK-React: interactive FaceHash fallback** — avatar fallbacks now render via FaceHash's React component instead of the static image endpoint, so the generated avatars keep their hover interaction while preserving the same local toggle, dramatic 3D intensity, and blink settings.
- **SDK-React: pre-join floating controls polish** — lobby camera/microphone controls now reuse the tighter PiP-style button sizing, clearer camera/mic labels, and inline device dropdown affordances.

### Fixed

- **SDK-React: leave confirmation dialog destructive CTA** — the leave-confirmation modal now uses the same vivid red button treatment as the in-room dock leave control, so destructive actions read consistently in dark surfaces.

## [0.0.73] - 2026-03-12

### Added

- **SDK-React: in-room media device switching** — the desktop meeting control bar now includes inline dropdowns for microphone input, speaker output, and camera device selection beside the existing mic/video controls.
- **SDK-React: in-room settings dialog** — meeting rooms now ship a searchable settings modal with left-rail navigation for audio, video, appearance, and entry preferences, backed by browser-local persistence.
- **SDK-React: settings hotkey** — meeting rooms now open the settings dialog with `Cmd+K` on macOS and `Ctrl+K` on Windows/Linux, while ignoring editable fields.
- **SDK-React: browser haptics support** — add a new `useHaptics` hook backed by `web-haptics` and wire tactile feedback into core meeting controls, reaction picker actions, and pre-join UI actions on supported browsers.
- **SDK-React: Document Picture-in-Picture** — add Document PiP support for pre-join and in-room views, with a `usePictureInPicture` hook and controls to open/close the floating window on supported browsers.
- **SDK: local video backgrounds** — add web-only background effects with blur, Cloudflare-hosted presets, and custom local uploads, plus meeting settings persistence and feature-flagged in-room controls.
- **SDK: web screen annotations** — add Zoom-style shared-screen annotations with a dedicated `annotation.*` websocket protocol, per-share-session state, host access controls, and a web SVG overlay/toolbar aligned to the shared screen.
- **API: magic-link verify route restored for email clicks** — mount `GET /api/v1/internal/auth/verify` alongside the existing POST handler so dashboard auth emails no longer 404 before redirecting back to the app.

- **Web: dashboard avatar gradient controls** — the dashboard Appearance settings now let users keep a name-derived profile gradient or click through preset avatar blends, with browser-local persistence, one shared resolver hook, and live header-avatar updates.
- **SDK-React: local profile gradient controls** — the meeting Appearance settings now let each user keep their name-derived gradient or switch to a custom two-color profile gradient, persisted locally and applied across their local pre-join/in-room identity surfaces.

### Changed

- **Repo: session-log housekeeping** — moved root/native progress notes into `scratchpad/` and renamed them with Chalk-flavored `session-log` filenames for cleaner workspace organization.
- **Repo: native surface removal** — removed the iOS app, Android app, React Native SDK/package, native helper scripts, native planning artifacts, and related workspace/CI/docs wiring so Chalk is now web/package-only in-repo.
- **Repo: app/test surface reduction** — removed the admin app, E2E harness, Next.js pages demo, and repo-owned stress tooling/artifacts so active workspace scope now centers on API, docs, web, and core packages.
- **SDK-React: joining-room loading headlines** — the pre-join loading screen now rotates reassuring join-progress messages in the main headline slot instead of leaving a single static “Joining room...” label.
- **SDK-React: Full-bleed Picture-in-Picture** — redesigned the Document PiP window to feature a full-bleed video stage, floating glassmorphism controls, and refined typography for maximum use of small space.
- **SDK-React: adaptive PiP participant layouts** — meeting PiP now switches between single, split, 2x2, and screen-share-first layouts, prioritizes active/remote participants over the local fallback, adds overflow handling for larger rooms, supports read-only whiteboard viewing in PiP, and keeps the stage full-bleed without nested card chrome.
- **SDK/API: remove screen annotations from screen sharing** — strip the incomplete shared-screen annotation protocol, state managers, React overlay/tooling, and demo flag wiring so screen sharing falls back to the stable non-annotated path.

### Fixed

- **Whisper worker: stale-only processing recovery + duplicate job guard** — startup/periodic processing recovery now requeues only stale unlocked jobs, completed `job_id`s are pruned instead of replayed, active jobs hold renewable Redis locks, and API-side Whisper timeout default is raised to `4h` to better tolerate long recordings while queue churn burns down.

- **Web/API: scheduled dashboard joins stay pinned to the right room/workspace** — internal auth now prefers the cached localhost workspace during session-backed dashboard use, join-link create/exchange validates the target room still exists for that tenant, dashboard entry clears stale invite-mode auth, and the room route now gates scheduled access via the authenticated room endpoint instead of a missing public metadata path.
- **Web/API: localhost room auth now ignores stale shared loopback workspaces after login** — session-backed internal auth only reuses the loopback bootstrap when it can still be claimed for the current user; otherwise it falls back to the user’s actual owned tenant so fresh room IDs stop returning false `room not found` errors.
- **SDK-React: whiteboard/chat panel resize stability** — opening the desktop chat panel while the whiteboard is already mounted now keeps the stage constrained, preserves the whiteboard viewport, and triggers a post-layout resize so the canvas does not overflow or jump upward.
- **SDK-React: local avatar gradient consistency** — in-room Appearance now uses clearer preset gradient swatches with a more obvious Auto/default option plus expanded colorways, and the same stored local profile gradient now flows through meeting tiles, joining/loading states, and Picture-in-Picture for the local participant.
- **Web: TanStack fallback route import crash** — corrected `TanStackFallbacks` to import `Link` from `@tanstack/react-router` and added a smoke test for the fallback module so broken router imports fail in tests instead of surfacing as a runtime `500` / `HTTPError`.
- **SDK-React: shared PiP render-loop fix** — hoisted stable omitted-prop defaults for `MeetingRoom` and `PreJoinLobby`, and made shared Picture-in-Picture registration idempotent so shared PiP no longer spirals into `Maximum update depth exceeded`.
- **SDK-React: PiP meeting tile key stability** — meeting Picture-in-Picture tiles now derive composite keys from source kind/id/order so React no longer warns when compact PiP layouts receive repeated participant ids.
- **Repo: low-signal test cleanup** — removed legacy/trivial UI smoke tests, meta/policy-only sdk-core tests, and the placeholder webhook E2E harness so the repo’s test surface better reflects active behavior.
- **SDK-Core: background-effects support state sync** — room attachment now pushes the media service’s computed state into session state, so Chromium-capable browsers no longer stay stuck on the default “unsupported” background-effects message.
- **SDK background presets: localhost CORS breakage** — preset image backgrounds now ship as local SDK assets instead of loading from the Cloudflare RTK asset host, and failed image loads now report a concrete `BACKGROUND_IMAGE_LOAD_FAILED` error instead of opaque `[object Event]` telemetry.
- **Web/API: localhost dashboard auth + SDK toast export** — restore the `toast` export on `@q9labs/chalk-react`, allow `X-Chalk-Local-Client-ID` through API CORS preflight, and default the local room route to camera/mic off unless stored join prefs explicitly opt in.
- **SDK-React: pre-join camera/mic defaults** — the lobby now starts with camera and microphone off unless callers explicitly opt in via `defaults` or `initial*Enabled` props.
- **SDK-React: meeting stage symbol regression** — restore the missing React/state imports used by the in-room stage so `useMemo`-driven whiteboard/stage state no longer crashes at runtime.
- **SDK-Core: screen-share cancel loop + stale active state** — canceling the browser screen-share picker now stops immediately without retrying alternate capture constraints, and failed/canceled starts reset transient local share state so the UI does not flip into a false “sharing” state.
- **SDK-React: settings hotkey cross-platform coverage** — the `Cmd+K` / `Ctrl+K` meeting-settings shortcut now has explicit macOS/Windows test coverage and stable hotkey-manager reset logic in the SDK React test harness.
- **Web/API: same room code now stays in the same room on localhost** — localhost room joins now reuse the same temporary tenant across tabs, ignore stale join-link session context when the current `/room/$roomId` does not match, and recover cleanly if two joins race to create the same slug-backed room.
- **SDK-Core: screen-share audio default restored on supported browsers** — screen sharing now requests system audio by default on Chrome-like browsers again, while Safari/WebKit keeps the safer no-audio default unless callers explicitly opt in.
- **SDK screen share: self-mirror guard** — Chromium capture requests now exclude the current Chalk tab when possible, and the local sharer’s main window / PiP stop rendering their own shared screen back into the app so opening the meeting window no longer creates the hall-of-mirrors loop.
- **SDK screen annotations: local sharer visibility** — screen annotation sessions now become active locally as soon as a share starts, so the sharer immediately sees the annotation affordance instead of waiting for the websocket echo.
- **SDK screen annotations: launcher fallback** — the annotation launcher now stays visible during active screen share while session state syncs, requests a fresh sync automatically, and lets the local sharer bootstrap the session if the first signal is late.
- **SDK screen annotations: stable open toolbar** — the annotation toolbar now stays open through late `annotation.session.ended` sync replies, and the launcher is promoted to a stronger bottom-left control instead of the old top-left text button.
- **SDK screen annotations: local-start sync race** — the local sharer no longer requests an immediate annotation snapshot after optimistically starting a session, avoiding the server-side `annotation.session.ended` fallback that kept the toolbar stuck on “Connecting annotations...” and blocked drawing.
- **SDK screen annotations: owner-session sync loop** — the local sharer now skips self-sync while already owning the active annotation session, and the local bootstrap fallback can recover after a stale session drop instead of getting stuck in permanent “Connecting annotations...” mode.
- **SDK/API: annotation incident logging** — added browser wide-events, incident breadcrumbs, and websocket-side structured annotation logs for start/sync/update/clear/access flows so stuck “Connecting annotations...” repros now carry `share_session_id`, access state, and rejection reasons end-to-end.
- **SDK screen annotations: duplicate local share-start dedupe** — screen-share startup no longer emits two local `started` events during the same share, so annotations keep a single `shareSessionId` instead of self-ending into permanent “Connecting annotations...” mode.
- **SDK screen annotations: websocket-aware session bootstrap** — annotation session start now waits for a real WS `connected` state instead of silently dropping on a connecting socket, and sync requests now report/skip when the annotation socket is not yet ready.
- **SDK-React screen annotations: local-share bootstrap by sharer id** — the annotation toolbar now starts a local session whenever the active share owner id matches the local participant, even if the derived `isLocalSharing` boolean lags behind for a render.
- **Web/SDK: instant room start + in-meeting self rename** — added `/new` instant-room creation with auto-join into the room flow, and wired participant self-renames through the SDK plus the API websocket contract so name changes propagate live inside the participants panel.
- **Web/Internal auth: prod navigation + magic-link callback targeting** — landing-page header links now route through TanStack navigation, `/documentation` now aliases docs, and internal auth magic links now default to redirecting verified users to `/dashboard` instead of hard-wiring `/auth/callback`.
- **SDK-React: persistent room preferences** — saved room settings now re-apply device choices when available, preserve layout/theme/filmstrip defaults between visits, and scale remote playback volume consistently inside the meeting room.
- **SDK-React: settings device discovery and speaker test** — in-room settings now fall back to `navigator.mediaDevices.enumerateDevices()` when controller lists arrive empty, keep device pickers fresh on `devicechange`, and the speaker test button now plays an audible routed tone instead of only animating the icon.
- **SDK-React: stable settings modal sizing** — the in-room settings dialog now keeps a fixed shell height while section content scrolls internally, avoiding resize flicker when switching between short and long settings pages.
- **SDK-React: desktop dock device controls** — the live meeting dock now refreshes devices on join, hydrates from browser enumeration when controller lists are empty, renders inline mic/speaker/camera pickers beside the media controls, and gives reactions/settings the same elevated light-mode styling as neighboring buttons.

## [0.0.72] - 2026-03-08

### Added

- **Room chat: durable history, attachments, and read receipts** — room chat now persists across reconnects, supports private file/image/document sharing up to `25 MB` per file, and shows sender-only read receipts when other participants open chat.

### Changed

- **Web: homepage and dashboard visual refresh** — refreshed the local web app shell with shared Chalk branding, new edge-network/meeting illustrations, and a more polished landing/dashboard presentation.
- **Web/SDK local dev resolution** — local web now resolves Chalk SDK packages straight from source during dev so fresh SDK fixes are reflected without stale package output.

### Fixed

- **Room chat: browser upload reliability** — chat attachments now upload through the API before landing in R2, avoiding direct browser-to-R2 CORS failures while keeping files private.
- **Room chat: local message ownership** — chat bubbles now correctly identify the local sender for receipt/status rendering even when media participant ids and auth/user ids differ.
- **Web: local route/type stability** — restored the `/room/end` route export, aligned route search validation with current TanStack router expectations, and fixed icon/button typing so web builds and typechecks pass cleanly again.
- **Web: dashboard icon/runtime cleanup** — routed Hugeicons dashboard glyphs through `HugeiconsIcon`, removed invalid button sizing, and tightened meeting selection state so the local dashboard no longer throws invalid-element/TypeScript errors during dev.
- **Internal auth: localhost magic-link flow** — magic links now verify through the API before redirecting back to the app, callback finalization accepts both client-verify and server-redirect flows, and localhost web now prefers local API/WS config instead of accidentally falling back to production endpoints.
- **Internal dashboard: localhost no-auth dev flow** — unclaimed internal tenants can now load `/api/v1/internal/meetings` when the API request itself is served from loopback/`.localhost`, so local dashboard use no longer bounces into email sign-in while hosted environments still require claimed ownership.

## [0.0.71] - 2026-03-08

### Added

- **SDK-Core: room listing + join-token APIs** — add typed `listRooms`, `createJoinToken`, and `exchangeJoinToken` client/session APIs so consumers can use SDK-first flows instead of manual HTTP calls.
- **Web: scheduled classes panel** — add dashboard UI to create scheduled classes, list upcoming/live classes, and generate join links through SDK methods.

### Changed

- **Infra: remove deprecated Terraform prod environment** — deleted `infrastructure/terraform/environments/prod` and updated infra docs/ops guides to standardize on `prod-lean` workflows only.
- **API: room list status filtering** — `GET /api/v1/rooms` now supports multi-status filters (`scheduled|active|ended`) and returns participant counts for filtered listings.
- **Web: join-link preflight behavior** — join-link flow now checks schedule window and shows a “not meeting time yet” waiting state with countdown before auto-entering.
- **SDK-React: participant-color theming expansion** — meeting controls, chat, transcription, participant panels, pickers, and overlay affordances now inherit the local participant’s generated theme color instead of falling back to brand teal.

### Fixed

- **Web: localhost auth callback dedupe** — dedupe in-tab magic-link verification requests so local dev callback pages don’t burn single-use tokens twice during duplicate mount/effect flows.
- **Internal auth: localhost session continuity** — production auth cookies now use `SameSite=None; Secure` and magic-link callback origin parsing accepts loopback/`.localhost` hosts, so localhost dashboard login can finish against the hosted API without bouncing back to hosted-only auth flow.
- **Infra: R2 browser uploads/downloads CORS** — configure `cloudflare_r2_bucket_cors` on recordings bucket with browser-safe rules (`GET/HEAD/PUT`, wildcard headers/origins by default, preflight cache TTL) so whiteboard/image presigned URL uploads no longer fail preflight (`No 'Access-Control-Allow-Origin' header`).
- **SDK-React/Whiteboard: image sync progress UX** — add live whiteboard file-sync states (`uploading`, `awaiting remote upload`, `downloading`, `error`) and a top-center status pill so the 3–5s peer propagation window feels in-progress instead of failed.
- **Internal auth: localhost magic-link callback support** — internal auth start now accepts a safe callback override (configured app origin + localhost) and `apps/web` sends its current callback URL, so local dev login links open the local app callback instead of forcing hosted-only flow.
- **SDK-React: tighter bundled sound starts** — trim leading silence from bundled join/leave/message/reaction/hand-raise/nudge effects and regenerate baked-in base64 audio so alerts fire immediately.
- **SDK hand raise sync** — replay pending `hand.raise`/`hand.lower` commands after WebSocket reconnect, derive participant hand indicators from interaction state when participant snapshots lag, and remove the local-only hand-raise sound shortcut so remote participants reliably see and hear raises too.
- **SDK reactions sync** — stop optimistic local reaction duplication, enrich echoed reaction names from participant state instead of showing `Unknown`, and remove the local-only reaction sound shortcut so each reaction renders and sounds once.
- **SDK chat alignment** — chat bubbles now reliably right-align the local participant’s messages and keep incoming messages on the left by falling back to the local participant id when explicit `isLocal` flags are missing.

## [0.0.70] - 2026-03-07

### Added

- **API: Room scheduling endpoint** — add `POST /api/v1/rooms/schedule` for scheduled room creation with start/end windows and early-join controls.
- **SDK-Core: Room scheduling APIs** — add room scheduling support in the SDK client API so app integrations can create and manage scheduled rooms directly.

### Changed

- **SDK-React: Pre-join loading experience refresh** — loading screen now supports participant-aware gradients and richer animated visual states during room join.
- **Ops: Agent guidance update** — artsy communication mode is now explicitly opt-in and defaults to concise engineering mode.

### Fixed

## [0.0.69] - 2026-03-07

### Added

- **Infra: Lean control-plane stack** — add `prod-lean` Terraform environment for EC2 `t4g.micro` + PlanetScale Postgres + Upstash Redis + Cloudflare R2, with SSM-backed runtime env management.
- **Infra: Lean EC2 runtime module** — add `ec2-api-lean` module (arm64 host bootstrap, Docker runtime, Caddy reverse proxy/TLS, minimal CloudWatch alarms, SSM/ECR IAM wiring).
- **CI: Lean infrastructure workflow** — add `.github/workflows/infra-lean.yml` with plan/apply/destroy for `prod-lean`.
- **CI: Lean API deploy workflow** — add `.github/workflows/api-lean.yml` with arm64 image build/push and EC2 restart through SSM.
- **Docs: Lean migration operations** — add cost baseline and cutover runbook docs for migration, rollback, and decommission sequencing.
- **API: Client incident telemetry endpoint** — add `POST /api/v1/debug/client-incident` (API-key protected) for browser-side incident ingestion.
- **SDK-Core/SDK-React: PostHog session replay integration** — add optional `posthog` config to auto start/stop replay on Chalk room lifecycle and emit replay-friendly lifecycle events (`session_joined`, `session_join_failed`, `session_left`).
- **Testing: Agent-browser room join stress runner** — add `tests/load/agent-browser` runner + wrapper script for multi-room join latency/error analysis (`--count` default `100`, configurable concurrency), with per-attempt artifacts and summary report outputs.

### Changed

- **SDK-Core: dead branch cleanup + type barrel consolidation** — remove unreachable Effect/helper barrels, trim unused manager-layer exports, route `types/api` through the current generated OpenAPI file, and fix sdk-core bridge/websocket compile blockers uncovered during verification.
- **SDK-Core: RTK signaling modularization** — split `conference-session/rtk-signaling.ts` into focused identity, participant-sync, chat, transcript, and shared-deps helpers while keeping `setupConferenceSessionRtkSignaling` behavior and API stable.
- **SDK-Core: ChalkSession state composition cleanup** — extract room/participant/media state API construction into `session/chalk-session-state.ts`, remove `as any` updater plumbing, and centralize leave/reset state cleanup through typed session updaters.
- **API: DB pool tunables via env** — support `DATABASE_MAX_CONNS` and `DATABASE_MIN_CONNS` with validation so lean `t4g.micro` can run lower connection pressure safely.
- **API Docker: Multi-arch build support** — Dockerfile now honors `TARGETARCH` for arm64-compatible builds used by lean EC2 deploys.
- **CI: Terraform validate scope** — include `ec2-api-lean` module in legacy infra validation loop.
- **API: WebSocket auth observability** — enrich websocket auth logs with token source + room query diagnostics (invalid/mismatch visibility) and expiry context.
- **API: Incident log schema** — emit structured `client.incident` events with tenant/request/client metadata for Axiom correlation.
- **API: Join-path observability + timeout budgeting** — participant join now emits step-level timing telemetry (`participant.join_room`), includes `join_duration_ms` in join errors, and uses tighter add-participant timeout/retry budgets for interactive joins.
- **API: Cloudflare add-participant response handling** — keep add-participant attempt context alive until response body read completes; fixes intermittent false join failures where upstream returned `201` but client recorded `context canceled`.
- **Web: PostHog wiring for Chalk replay lifecycle** — `apps/web` now initializes optional PostHog from `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST` and passes it to `ChalkProvider.posthog` so replay starts/stops with Chalk room lifecycle events.
- **Web: Client incident transport wiring** — `apps/web` now configures `ChalkProvider.incident.reporter` using `createHttpIncidentReporter` to send support-code incidents to `POST /api/v1/debug/client-incident` (API-key header + keepalive beacon fallback).
- **Tooling: Oxfmt formatting setup** — add repo-wide `oxfmt` formatter with root scripts (`format`, `format:check`) and shared `.oxfmtrc.json` defaults (`printWidth: 300`) for consistent code style.
- **SDK-React: VideoConference composition refactor** — split `VideoConference` internals into focused modules (`join-errors`, `useJoinFlow`, `useLobbyDevices`, `useMeetingStats`, `useSessionEvents`, `useChatNotifications`, `useConferenceErrorReporter`, shared `types`) to reduce component size and isolate orchestration concerns without changing public behavior.
- **SDK-React: VideoConference shell slimming + effect isolation** — further decompose meeting controls, connection state derivation, participant moderation, and meeting-room view-model mapping into dedicated hooks; remove phase-based session event re-subscriptions by using `phaseRef` for in-callback gating.
- **SDK-React: VideoConference feature/props orchestration cleanup** — extract feature-flag resolution (`useConferenceFeatureFlags`) and meeting-room prop composition (`useMeetingRoomProps`), replacing in-component ad-hoc wiring with typed, memoized composition boundaries.
- **SDK-React: VideoConference controller-view split** — reduce `VideoConference.tsx` to a facade component and move orchestration/view-prop assembly into `useVideoConferenceController`, `useVideoConferenceMeetingRoomProps`, and `view-state` helpers for clearer composition boundaries and safer incremental edits.
- **SDK-React: Join-flow hook decomposition** — split `useJoinFlow` support concerns into focused helpers (`useRealtimeKitPreload`, `useJoinFlowTelemetry`, `join-flow-device-tasks`) so the hook stays orchestration-focused while preserving join/retry behavior.
- **SDK-React: Session-events error handling cleanup** — extract error classification and diagnostic payload shaping into `session-events-error-utils`, simplifying `useSessionEvents` event wiring and maintaining existing toast/error semantics.
- **SDK-React: PreJoinLobby composition refactor** — split lobby responsibilities into focused hooks/components (`usePreJoinUiState`, `usePreJoinTheme`, `usePreJoinMedia`, `usePreJoinAudioMeter`, modal/header/preview/panel sections), reducing the root component to a small orchestration shell while preserving props compatibility.
- **SDK-React: MeetingRoom composition refactor** — extract meeting-room state/effects/render sections into a `meeting-room/` module set (`types`, lifecycle/theme/ui/derived hooks, stage/panels/controls/overlays/top-bar sections), shrinking the root file to a concise conductor component without behavior changes.
- **SDK-React: EndScreen composition split** — decompose `EndScreen` into focused feedback/download/actions modules and shared duration utility for cleaner structure without changing user-facing flow.
- **SDK-Core: Session-first naming overhaul (breaking)** — rename core SDK vocabulary to `ConferenceClient`/`ConferenceSession` with `JoinSessionConfig`, `SessionInfo`, and `SessionConnectionState`; rename lifecycle APIs to `joinSession`, `createSession`, and `endSession`, and align `sdk-react` / `sdk-react-native` imports/re-exports/providers with the new naming.
- **SDK-Core: ConferenceSession event contract redesign (breaking)** — migrate room event names to dot notation (`connection.state.changed`, `participant.joined|left|updated`, `speaker.active.changed`, `chat.message`, `hand.*`, `recording.*`, `whiteboard.*`) and update all manager/effect/session listeners plus tests to the new event grammar.
- **SDK-Core: structural composition pass for session/client internals** — split legacy `room.ts` and `client.ts` monoliths into focused composition modules (`conference-session/*`, `conference-client/*`) while preserving public API behavior and resilience/test seams.
- **SDK-Core: listener teardown lifecycle hardening** — standardize unsubscribe cleanup across WS signaling, session state bridges, and room-attached managers (`chat`, `recording`, `interaction`, `screen-share`, `whiteboard`) so repeated room attachments/leaves do not accumulate duplicate listeners.
- **SDK-Core/SDK-React-Native: auth expiry event dot-notation (breaking)** — replace legacy auth event names (`token-expired`, `token:expired`) with canonical `token.expired` across emitters/listeners, schemas, and tests.
- **SDK/Core+React+API: whiteboard wire contract locked to v2 (breaking)** — removed v1 `whiteboard.update` send APIs and dual-path UI wiring, made outbound/inbound schemas require v2 fields (`schemaVersion=2`, `sceneId`, `syncAll`), and simplified whiteboard sync/render flows to a single collab-v2 pipeline.
- **API: whiteboard snapshot/data payloads normalized to required v2 fields** — websocket payload structs now emit non-optional v2 metadata and persistence restore now accepts only v2 state blobs.
- **SDK-Core/SDK-React/API: whiteboard contract naming + strictness cleanup** — tightened collab engine remote payloads to require v2 epoch fields (`sceneId`, `syncAll`) and renamed API websocket internal update struct from `WhiteboardUpdateV2Payload` to protocol-neutral `WhiteboardUpdatePayload` while still enforcing `schema_version=2`.

### Fixed

- **SDK-React: Join-flow resilience + retry observability** — `VideoConference` now retries transient join failures before surfacing lobby errors, preserves last join settings for in-call reconnect retries (`ConnectionLostOverlay` CTA), and emits enriched `onError` details (`stage`, attempt metadata, join retry exhaustion context) for downstream incident telemetry.
- **SDK-React: Error support code surfacing** — join and connection-failure modals now show a user-visible `Support Code`, and emitted errors include `details.supportCode` for backend correlation.
- **SDK-Core/SDK-React: SDK-native incident pipeline** — add canonical incident schema + HTTP reporter (`createHttpIncidentReporter`), thread provider/session incident config (`incident`, `onIncident`, `incidentReporter`, breadcrumb cap), and auto-emit incidents for surfaced SDK errors with support-code/trace correlation.
- **API: client incident envelope compatibility** — `POST /api/v1/debug/client-incident` now accepts both legacy flat payloads and SDK envelope payloads (`{ incident, reportedAt }`) so incident ingestion no longer drops with `400`.
- **SDK-React: join race suppression** — pre-join flow now dedupes rapid join clicks and treats `Already joining a room` as a non-fatal race instead of surfacing a blocking modal.
- **SDK-Core: stronger RTK join retries** — increase RTK join retry budget from 4 total attempts to 5 total attempts with progressive backoff to reduce transient `RoomSocketHandler.joinRoom failed` failures.
- **SDK-Core: wide-events SDK version source-of-truth** — replace hardcoded `sdk.version` with `packages/sdk-core/package.json` version and add regression coverage to prevent stale telemetry versions in production bundles.
- **SDK-Core: cohort-aware RTK join policy telemetry** — select RTK join timeout/backoff by runtime cohort (`platform`, browser `effectiveType`, `saveData`) and emit selected policy/cohort in `room.join` wide events for targeted tuning.
- **SDK-Core: post-click RTK/sync attribution telemetry** — emit per-attempt `room.join.rtk.attempt` events (attempt duration, timeout/error classification, delay, policy) and one-shot `room.sync.ready` when first RTK/WS snapshot arrives to pinpoint non-API post-click delays.
- **SDK-Core/SDK-React: RTK bundle preload before join click** — add safe `preloadRealtimeKit()` API in `ChalkClient`, reuse cached RTK module during join init, and trigger preload from `VideoConference` lobby lifecycle so join stays non-blocking even when preload fails.
- **SDK-React: join UI/media transition telemetry** — emit `ui.join.click`, `ui.join.phase_transition`, and `ui.media.device_selection` (post-click device select timing/outcome) without changing best-effort/non-blocking device selection behavior.
- **Newton observability: join-path correlation + retry telemetry** — API join logs now include `trace_id`, room slug, Cloudflare per-operation attempt/retry/timeout stats; Cloudflare client emits attempt events for create-meeting/add-participant retries; SDK API events expose `x-request-id`/`x-chalk-trace-id`/`cf-ray`; and agent-browser stress tooling now emits attempt↔backend correlation maps for incident triage.
- **API + SDK-Core: State mismatch recovery hardening** — websocket hub now fans out authoritative `room.snapshot` on participant join/leave and resolves snapshot participants from shared room-state across instances, while RTK participant handling now reconciles from `participantsUpdate`/`participantsCleared` to recover missed join/screen-share deltas.
- **SDK-Core: RTK participant reconciliation canary + fallback hardening** — participant self-healing now reads RTK snapshots from `participants.toArray()`/`joined.toArray()` in addition to map iterators, listens on both RTK participant emitters for `participantsUpdate`/`participantsCleared`, and retries reconciliation after clear events; regression tests now cover missed join + missed screen-share recovery on this fallback path.
- **SDK-Core: Participant roster self-healing on missed RTK join deltas** — remote `videoUpdate`/`audioUpdate`/`screenShareUpdate` now upsert participants when `participantJoined` is missed, and session participant state now upserts unknown `participant-updated` events to prevent one-way room visibility mismatches.
- **SDK-Core: RTK join token safety + retries regression coverage** — stop substituting `rtcToken` with `tokenProvider()` output during room join, harden JWT base64url expiry parsing, and add join-path regression tests for token mismatch, missing RTC token, and retry behavior.
- **CI: Legacy prod destroy resilience** — make infra destroy tolerant of stale state/manual deletes by using `terraform destroy -refresh=false` and non-blocking R2 lifecycle state cleanup.
- **Web CI: SPA fallback artifact check** — ensure `apps/web/scripts/prepare-pages-spa.mjs` emits both `index.html` and `404.html` from `_shell.html` for Cloudflare Pages fallback validation.
- **Post-meeting transcription timeout tuning** — raise Whisper timeout from `30m` to `2h` and include queue-depth diagnostics in timeout errors to avoid false failures under backlog.
- **Whisper stability under backlog** — disable aggressive batched inference by default on CPU workers and add OOM fallback from batched to single-mode transcription while retaining `c7i.large` spot sizing.
- **Infra: Lean whisper spot self-healing** — switch lean whisper worker spot mode to persistent requests so interruptions relaunch capacity automatically on `c7i.large` spot.
- **CI: API ECS deploy skip behavior** — handle missing ECS task definition gracefully in `api.yml` instead of failing deploy stage when legacy ECS stack is absent.
- **API: Eman Time CORS allowlist** — add `https://app.emantime.com` and `https://dev-app.emantime.com` to platform CORS origins so browser preflight requests can receive `Access-Control-Allow-Origin`.
- **API: WebSocket origin allowlist** — add Eman Time origins (`app`, `dev-app`, `portal`) to the WebSocket origin patterns to avoid handshake rejections from strict origin checks.
- **API: WebSocket tenant-origin handshake** — when an origin is validated against tenant `allowed_origins`, lock WS upgrade checks to that origin (with host-only compatibility for API Gateway/ALB forwarded Origin headers) so newly added tenant domains work without static allowlist updates.
- **Docs: WebSocket endpoint examples** — update native/android/iOS docs to use `wss://chalk-ws.q9labs.ai/ws` instead of `wss://chalk-api.q9labs.ai/ws`.
- **API: Meeting preset transcription override** — force Cloudflare participant join requests to send `transcription_enabled=false` so in-meeting preset transcription stays disabled.
- **SDK-React: PreJoinLobby device selection** — camera/microphone/speaker picks now persist during lobby and are applied after room join, fixing `NOT_IN_ROOM` failures from pre-join device changes.
- **SDK-React: Speaker output routing in meeting audio** — thread selected speaker device through `VideoConference` → `MeetingRoom` → `AudioRenderer` and apply `setSinkId` for remote mic/screen-share playback when supported.
- **SDK-React: Mobile mic-control tap reliability** — raise meeting control bar layer priority, keep pre-join controls touch-friendly, and keep invite toast away from mobile bottom controls to prevent blocked taps.
- **SDK-Core/SDK-React: PostHog session replay integration** — add optional `posthog` config on `ChalkClient`, `ChalkSession`, and `ChalkProvider` to start/stop session recording and emit `chalk_sdk_session_joined|join_failed|left` lifecycle events without introducing a hard `posthog-js` dependency.

### Removed

- **SDK-Core: whiteboard v1 outbound API surface** — removed `sendWhiteboardUpdate(elements, files, seq)` from websocket client/session action chain.
- **SDK-React + chalk-whiteboard: legacy SyncEngine branch** — removed `useV2` toggles and root `SyncEngine` export path in favor of collab-v2-only runtime.
- **chalk-whiteboard: legacy root type surface** — removed unused v1-oriented root types module and now re-export root whiteboard types directly from collab-v2.
- **API: whiteboard v1 protocol artifacts** — removed v1 compatibility handling and persisted-state v1 restore fallback; websocket updates now only accept/emit the v2 shape (`schema_version=2`).

## [0.0.59] - 2026-02-22

### Added

### Changed

- **Infra: Whisper aggressive cost mode** — downsize prod Whisper worker from `c7i.xlarge` to single Spot `c7i.large` and reduce `WHISPER_CPU_THREADS` to `2`.

### Fixed

- **SDK-Core/SDK-React: Whiteboard open/close sync** — remote whiteboard open/close events now update local state without re-broadcasting.

### Removed

## [0.0.58] - 2026-02-22

### Added

- **Native: File-based logs (iOS/Android)** — write app + MeetingKit events/errors to `chalk.log`, `chalk.debug.log`, `chalk.error.log`, and add in-app “Share logs” so errors are copyable.
- **Native: Dev build/run scripts** — add `bun run ios:*` and `bun run android:*` helpers for consistent local build/install/launch.
- **API: Debug diagnostics endpoints** — add endpoints to inspect auth/server/build health for system health checks.
- **API: Internal tenant auth groundwork** — add internal tenant identity structures and schema so hosted apps can support email login and cross-device usage.
- **API: Internal auth + dashboard** — add internal sign-in paths and meetings dashboard listing for Chalk-hosted apps.
- **API: Opaque join + share links** — add host-only room joins and shareable recording links with public exchange helpers.
- **API: Internal retention job** — auto-remove old internal tenant recordings after 7 days.
- **Web: Host dashboard + share pages** — add dashboard, share, and callback routes for invite/room flows.
- **Stress Tests: Infra capacity snapshots** — capture ECS/ALB/Aurora/Redis metrics during VU sweeps for capacity planning.

### Changed

- **Infra: Monitoring dashboard + alarms for whisper/capacity** — expand dashboards and alarms to surface pressure points during stress and production.
- **Infra: Cloudflare + WebSocket read observability alarms** — add logs and alarms for join and websocket read failures plus shared metric visibility.
- **CI: API pipeline lint gate disabled** — skip lint in API CI while keeping test/build/deploy active.
- **CI: Infra plan/apply artifact handoff** — fix infra artifact flow so apply steps use the generated plan.
- **Whisper Worker: Observability** — export processing metrics for RTF, queue times, and GPU utilization.
- **Infra: Whisper CPU canary profile** — run production worker on controlled `c7i.xlarge` CPU profile with focused RTF alarm coverage.
- **Web: Room UI** — remove host overlay copy link button.

### Fixed

- **API: Transcription default provider** — default now prefers whisper when provisioned and falls back to groq.
- **API: Join room latency** — reduce query count and add a regression test for participant join.
- **API: Cloudflare meeting/participant resilience** — add resilient retries and map upstream failures to friendlier 502/503 handling.
- **API: Redis shutdown races** — drain background workers before shutdown to avoid close-order errors.
- **API: WebSocket read EOF noise** — separate expected disconnects from internal failures in metrics.
- **SDK-React: Remote audio autoplay recovery** — recover remote audio after interaction on browsers that block autoplay.
- **SDK-React: Pre-join media hardening** — handle missing media APIs and stricter audio gesture restrictions.
- **iOS: Meeting grid tile distortion** — force square participant tiles.
- **iOS: Lobby join button blocked** — prevent overlays from blocking “Ask to join”.
- **Web: SPA deep links** — add fallback pages so direct room/share routes don't hard 404.
- **API: Recording endpoint access** — require `CanRecord` for recordings routes.
- **API: WebSocket observability** — add richer lifecycle/error logs and split-brain diagnostics.
- **API: WebSocket error coverage** — emit structured websocket errors and redis pub/sub lifecycle logs.
- **API: WebSocket hijack log spam** — stop logger warnings on upgraded websocket responses.
- **API: Whisper transcription timeout** — make transcription timeout configurable with higher default.
- **Whisper Worker: Queue/throughput observability** — publish more detailed transcription and queue processing metrics.

### Removed

- **Web: Whiteboard agent (tool-calling)** — remove the OpenRouter-backed whiteboard agent and overlay.

## [0.0.57] - 2026-02-08

### Added

### Changed

### Fixed

- **Infra: Aurora headroom + alarms** — increase prod Aurora Serverless v2 max capacity and add CloudWatch alarms for ACU nearing the ceiling; fix Redis and Whisper alarms/metrics so they stop showing `INSUFFICIENT_DATA`.
- **Infra: CORS auto-heal + tracing headers** — add hourly `cors-sync` reconcile, improve S3 origins upload determinism + dispatch retry logging, and allow common tracing headers (`baggage`, `sentry-trace`, `traceparent`) so tenant portals don’t hit preflight CORS failures.
- **SDK-React: Participant volume slider drag** — fix per-participant volume slider to be continuously adjustable (single-value slider now uses `value={number}` instead of range-mode array).
- **SDK-React: Participant volume UX** — move per-participant volume controls into the 3-dot options menu so it’s usable on mobile (no hover).
- **SDK-React: VideoConference roomName prop** — add `roomName` prop and thread it through to `PreJoinLobby` + `MeetingRoom` (displayed as the room title instead of `roomId`).
- **SDK-React: Pre-join lobby display name** — allow clearing the default "Guest" name without it reappearing.
- **SDK-React: Layout switcher icon visibility** — increase layout option icon contrast (less washed out on dark background).
- **SDK-React: Whiteboard default stroke color** — default Excalidraw stroke color is now blue.
- **SDK: iPad screen share feedback + WebKit patching** — show an in-meeting toast with a `Copy error` action (no silent click), guard missing `getDisplayMedia`, and patch non-writable `getDisplayMedia` via `defineProperty` where possible.
- **SDK-React: Invite modal Copy Link feedback** — show a brief "Copied" state after clicking.

## [0.0.55] - 2026-02-06

### Added

- **Docs: Excalidraw sync notes** — add deep-dive sync reference notes for upcoming whiteboard work.
- **Whiteboard: Sync v2 (Excalidraw-native)** — new collab engine using Excalidraw primitives (`restoreElements`/`reconcileElements`), pointer-up flush, periodic full-scene heal, and cursor presence forwarding.
- **API: Whiteboard file presign** — add R2 presigned upload/download endpoints for image sync (no WS data URLs).

### Changed

- **SDK-Core: WSClient refactor (schema-first)** — modular ws-client (decoder/transforms/outbound), runtime payload validation via Effect Schema, typed outbound messages, transcript payload casing fix, and `room-sync` event renamed to `room.sync`.
- **API: Whiteboard WS hub** — relay-only v2 updates with reliable backpressure handling, snapshot persistence (tombstones + `versionNonce` tie-break), and scene epoch semantics for clear.

### Fixed

- **Whiteboard: AppState type import** — align AppState with Excalidraw’s public types export so schema/type resolution works.
- **Whisper Worker: Temp file cleanup NameError** — add missing `os` import so worker can delete downloaded audio files safely.
- **Whisper Worker: Multilingual code-switching** — enable per-segment language detection (shorter chunking) and disable prompt carryover in multilingual mode to prevent missing later-language speech.
- **Whisper Worker: Redis timeout handling** — configure Redis socket timeouts and retry-on-timeout so transient connection timeouts don’t crash the worker loop.
- **Whisper Worker: BRPOP socket timeout** — default Redis socket timeout now exceeds BRPOP poll timeout to avoid spurious read timeouts.
- **Infra: Axiom dataset for API** — default prod `AXIOM_DATASET` to `chalk-api-prod` so Axiom ingest doesn’t 404.
- **API: Axiom ingest guardrail** — if the configured dataset is missing/unauthorized, disable Axiom handler to prevent stderr retry spam.
- **API: Gin release mode** — force Gin into release mode when `ENV=production` so ECS runs without verbose debug/preview logging.
- **CI/CD: Runner stability (Depot fallback)** — switch workflows back to GitHub-hosted runners and Docker Buildx so CI/CD keeps working when Depot runners/builds are unavailable (trial/billing/outages).
- **Infra: Redis ingress for Whisper** — stop ElastiCache SG ingress drift so the Whisper→Redis security group rule is not revoked, preventing Redis connection timeouts in the worker.

## [0.0.53] - 2026-02-03

### Added

- **Whisper Worker: Axiom wide-event logging** — emits one structured wide event per job (`whisper.transcription`) plus periodic queue depth (`whisper.queue_depth`) for fast debugging and analytics.
- **Whisper Worker: Transcript logging (testing)** — include transcript text (capped) in `whisper.transcription` events when enabled.
- **Whisper Worker: Observability guardrails** — Axiom logging failures no longer abort transcription jobs; events fall back to stdout JSON.
- **Stress Tests: VU sweep runner (200→750)** — adds `run-sweep.sh` to automate incremental capacity checks without manually rerunning scenarios.

### Changed

- **Webhooks: Include participant metadata + external IDs in tenant payloads** — post-meeting webhook payloads now include participant metadata (from VideoConference join) plus `external_id`/`external_user_id` for easier tenant identification; sdk-core webhook schema updated accordingly.
- **Infra: Whisper Worker Axiom wiring** — pass `AXIOM_TOKEN` from Secrets Manager (seeded via SSM `/chalk/prod/axiom-token`) and set `AXIOM_DATASET=chalk-whisper-worker` without leaking secrets into EC2 user-data command lines.
- **SDK-React: Remove Storybook from package** — drop Storybook config/stories and simplify SDK surface for consumers.
- **SDK-React/UI: Dev scripts** — ensure `dev` builds include CSS/assets to prevent missing styles in local SDK builds.
- **SDK-React/UI: Meeting room polish** — draggable room-name pill plus ControlBar/PreJoinLobby interaction + accessibility tweaks.

### Fixed

- **Infra: Whisper Worker secrets decrypt** — grant `kms:Decrypt` for Secrets Manager KMS key so worker can read Axiom token during boot.
- **Stress Tests: Fix large-room broadcast latency measurement** — restores deterministic sender-echo detection (no substring matching) and prevents skewed p95/p99 from flaky parsing.
- **Stress Tests: Align ws-storm short runs to active VUs** — short runs now use the target VU count and correct storm duration.
- **Stress Tests: WS token handling + debug logs** — k6 scenarios now guard missing websocket tokens and only log failures in debug mode.
- **Stress Tests: Persist per-run artifacts** — k6 now writes `.jsonl` output plus `-summary.json` exports and results link to both for debugging.
- **Admin: Persist production secret across reloads** — production admin API calls now keep the secret in local storage so refreshes don't drop auth.
- **API Gateway: Allow admin localhost origin for CORS** — add `http://localhost:3090`/`127.0.0.1:3090` to aggregated origins so local admin can call prod API.
- **API Gateway: Allow X-Admin-Secret header for CORS** — preflight now allows admin secret header to reach prod API.
- **Admin: Temporarily disable IP allowlist** — removes IP restriction so admin access is not blocked.

## [0.0.52] - 2026-02-02

### Changed

- **API: Record webhook payload and gate downloadable statuses** — webhook handler now stores the raw Cloudflare request body in the wide event log and only begins download/upload once the recording status reaches `UPLOADED`/`COMPLETED`, which matches RealtimeKit’s documented lifecycle and prevents missing the download URL.

- **CI/CD: Migrate to Depot** — Replace GitHub-hosted runners and Docker buildx with Depot runners (`depot-ubuntu-latest`) and Depot build-push-action for persistent build cache and faster CI. Applies to `api.yml` and `whisper-worker.yml` workflows. Auth via OIDC (no secrets needed).
- **CI/CD: Use full SHA tags for API images** — Avoids ECR immutable tag collisions during force deploy.
- **API: Log missing R2 env vars at startup** — Clear warning when storage credentials/bucket config are absent.
- **Infra: Require R2 credentials in prod when Cloudflare enabled** — Prevents silent misconfig in production.
- **Infra: Pass R2 credentials in workflow** — Terraform CI now injects R2 access/secret keys and falls back to GitHub secret for webhook secret.
- **API: Restore Cloudflare mock config** — Keeps local/tests working when Cloudflare credentials are absent.

### Added

- **SDK-React-Native: Wide-event logging system** — Comprehensive structured logging following canonical log line best practices
  - New `src/logger.ts` with singleton `logger` and `createLogger()` factory
  - Auto-injected environment context: platform, platformVersion, sdkVersion, isSimulator, debug mode
  - Session context tracking: roomId, participantId, displayName (set on room join, cleared on leave)
  - JSON structured output prefixed with `[Chalk]` for easy filtering
  - Respects `debug` prop from ChalkProvider (info logs only when debug=true, errors always logged)
  - Exports: `logger`, `createLogger`, `ChalkLogger` type
  - Event naming convention: `{domain}.{action}[.{phase}]` (e.g., `room.join.start`, `media.video.toggle`)
  - Coverage: ChalkProvider (room ops), RTCManager (WebRTC ops), useMedia, useParticipants, useLocalStream, usePermissions, useRecording
- **API: Local post-meeting webhook receiver** — Test-only endpoint for self-call webhook delivery verification

### Changed

### Fixed

- **Whisper Worker: Silence-safe transcription + faster-whisper v1.2.1** — upgraded worker to `faster-whisper==1.2.1`, added batched inference for queue backlogs (OOM-safe batch fallback), switched container installs to `uv`, and treat silent/near-silent recordings as `completed` with empty transcript instead of failing.

- **API: Parse Cloudflare webhook list response** — Support `data` response shape to avoid empty webhook lists.
- **SDK-Core: iPadOS/Safari screen share reliability** — `getDisplayMedia` now retries with safer constraints (no-audio, then video-only) to support iPadOS/Safari/WebKit while preserving Chrome/Firefox behavior
- **API: Stop recordings when rooms end** — `EndRoom()` now calls `StopRecording()` on Cloudflare before ending the meeting, preventing recordings from staying stuck in "recording" status forever
- **API: Webhook recording processing survives API Gateway timeout** — Recording download+upload now runs in a background goroutine with `context.Background()` instead of the request context, so API Gateway's 30s connection timeout no longer kills the transfer
- **API: Normalize Cloudflare webhook field casing** — Recording webhook payloads now accept camelCase fields (e.g., `downloadUrl`, `outputFileName`, `roomUUID`) so UPLOADED events reliably include the download URL.
- **API Gateway 503 timeout investigation** — Documented HTTP API timeout limitation
  - Investigation revealed intermittent 30-second timeouts from API Gateway
  - HTTP API has a **hard limit of 30 seconds** (cannot be increased)
  - VPC_LINK requires internal ALB (incompatible with WebSocket direct access)
  - Added `vpc_link_security_group_id` output to api-gateway module for future use
  - Next steps: Investigate why some requests take >30s to respond
- **API: Prevent room join hangs from WebSocket backpressure** — `Client.Send()` now drops messages when the per-client buffer is full (instead of blocking request handlers)
- **Monitoring: WebSocket backpressure observability** — Periodic `ws.metrics` log line + CloudWatch metric filters/alarms/dashboard for drops/errors/clients/rooms
- **Monitoring: Fix Terraform CloudWatch metric filters** — Split WebSocket log metric filters into single-metric resources to satisfy provider constraints (unblocks prod apply)
- **Infra: Fix ALB access logs S3 permissions** — Allow ALB to write access logs to the configured S3 prefix (unblocks prod apply)
- **Infra: ALB access logs principal** — Use `aws_elb_service_account` in bucket policy to satisfy AWS log delivery requirements
- **SDK-React: Participant volume slider + mute icon** — Slider drag now updates volume, and mute icon instantly sets participant volume to 0

- **Whiteboard React instance conflict in production** — Externalized `@excalidraw/excalidraw` from sdk-react bundle to prevent duplicate React instances
  - Root cause: Excalidraw was bundled into sdk-react, causing `ReactCurrentOwner` undefined errors in production
  - Added `--external @excalidraw/excalidraw` to sdk-react build
  - Added `@excalidraw/excalidraw` to vite dedupe list and sdk-react peer dependencies
  - Reduced sdk-react bundle size by ~70% (342k → 104k lines)

## [0.0.50] - 2026-01-28

### Changed

- **SDK-Core: Wide Events logging** — Replaced 250+ scattered log calls with canonical "wide events" pattern
  - Each operation emits ONE context-rich event at completion with full timing breakdown
  - New `wideEvents` API: `wideEvents.start("room.join")` → accumulate context → `ctx.complete("success")`
  - Phase timing: `ctx.markPhase("api")`, `ctx.markPhase("rtk.join")` tracks where time is spent
  - Configurable via `ChalkClientConfig.wideEvents`: `{ enabled, handler, includeDebugInfo }`
  - Custom handler support for analytics/logging services: `handler: (event) => analytics.track(event)`
  - Exports: `wideEvents`, `WideEvent`, `WideEventConfig`, `WideEventContext`
  - Removed: `createLogger`, `configureLogger`, `initLogging`, `isLoggingEnabled`, `Logger` types
  - Event types: `room.join`, `room.leave`, `api.request`, `media.toggle`, `screenshare.start/stop`, `websocket.connect/disconnect`, `session.init/dispose`

- **Unified slog-based logging** — Migrated all Go API logging from scattered `log.Printf()` to structured `slog` with wide events pattern
  - New `internal/version` package with build-time variables (CommitSHA, Version, BuildTime)
  - Enhanced central logger adds environment context (service, version, commit_sha, env, region) to all log events
  - Migrated background jobs: `room_cleanup.go`, `recording_check.go`, `storage/lifecycle.go` with injected loggers
  - Migrated WebSocket package: removed verbose per-message logging, kept lifecycle/error events only
  - Migrated remaining files: router, handlers, redis, s3/cors_origins
  - All constructors now accept optional `*slog.Logger` parameter with `slog.Default()` fallback

## [0.0.49] - 2025-01-28

### Added

- **Whiteboard sync for late joiners** — Server now maintains in-memory whiteboard state per room. New participants receive full snapshot on `whiteboard.sync` request instead of empty state.
  - New `WhiteboardState` struct tracks elements (by ID/version), files, appState, and lastSeq
  - `whiteboard.snapshot` message type delivers full state to requesting client
  - Debounced DB persistence (750ms) via `WhiteboardStateStore` interface
  - State cleaned up when last participant leaves room

- **Collaborative cursors** — Participants see each other's cursors with color-coded names
  - 8 distinct cursor colors assigned by participant ID hash
  - Stale cursor cleanup (10s timeout)
  - Cursor position updates sent even when not drawing

- **Large file batching** — Whiteboard images split into batches to prevent WebSocket message size limits
  - New config: `maxPayloadBytes` (32MB default), `maxFileBytes` (32MB default)
  - Files exceeding `maxFileBytes` are skipped
  - Batches sent sequentially with elements only in first batch

### Changed

- **Per-participant sequence tracking** — SyncEngine now tracks sequence numbers per participant instead of globally
  - Prevents cross-participant deduplication issues (participant A's seq 5 no longer blocks participant B's seq 3)
  - `remoteSeqBySource` map replaces single `remoteSeq` counter
  - Snapshot load resets all per-participant sequences

- **WebSocket read limit increased** — Default read limit raised from 32KB to 32MB for large whiteboard payloads
  - Configurable via `CHALK_WS_READ_LIMIT_BYTES` environment variable

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
- **Test pipeline resource fix** - stop forcing workspace builds before `turbo test`, so running tests no longer fans out into `docs`/`admin`/`web` builds and unnecessary parallel memory pressure.

## Unreleased

- build(mobile): bump Android/iOS mobile build to `0.0.2` / `2` after first Play upload reserved version code `1`
- fix(web): add static privacy policy pages under `/privacy` and `/privacy-policy` so external checks receive `200` instead of a SPA deep-link `404`

### Fixed

- Web join routes now force room-scoped auth instead of reusing the dashboard/demo API-key token provider, and the React SDK provider can rotate its cached session by route context so invite links no longer land on prejoin with a hidden `room not found` auth mismatch.
- Web `New meeting` now creates a real backend room before redirecting, so first-party host flows stop generating dead `instant-meeting-*` ids and land directly on a canonical `/room/<uuid>?auth=internal` route that guests can join.
- Mobile `New meeting` now mirrors web by generating the instant-meeting route locally and entering the lobby immediately instead of failing early on a pre-create API call from the home screen. Added regression coverage for the pure route generator.
- Mobile local host bootstrap no longer depends on `__DEV__`; any build still pointed at a local API can now self-heal stale host keys at join time instead of bouncing the lobby with `Token exchange failed: {"error":"invalid API key"}`.
- Mobile Hugeicons setup now installs the free icon pack and `react-native-svg`, and the Android mobile lobby/room screens stay on the stable Expo icon components to avoid the native LobbyScreen crash seen with the Hugeicons renderer path.
- Mobile host meeting creation now pre-creates the room with a friendly human-readable name and carries the returned room UUID separately, so lobby UI no longer shows the old opaque `instant-meeting-*` identifier as the room title.
- Join-token exchange now returns both the canonical room UUID and the friendly room name, so mobile can display intelligible titles without treating the room label as the room identifier.
- Tenant access-token minting now stamps `role=host` as well as host permissions, so mobile `New meeting` can create rooms again after the room pre-create flow started using the host-only `/rooms` endpoint. Mobile host token cache key bumped to evict stale no-role tokens on device.
- Mobile host meeting creation now self-heals one stale `host role required` failure by clearing the cached host JWT set and retrying room creation once, so already-stored pre-fix tokens stop blocking `New meeting`.
- Mobile/native join now latches duplicate submit attempts, treats same-room `Already connected to a room` races as a successful join, and clears stale connected room state before retrying, so host create-and-join no longer bounces back with a misleading prejoin error before entering the meeting room.

### Changed

- Removed the legacy Terraform dev environment and unused non-lean modules, keeping only `bootstrap`, `prod-lean`, and the modules they depend on.
- Trimmed root and Terraform README files down to stable orientation notes so active behavior stays defined by source files instead of drifting docs.
- mobile(android): bump release metadata to 0.0.7 / versionCode 7 while stripping Android foreground-service declarations from the alpha build to clear Play review blockers without policy video uploads
- api(webhooks): enrich final webhook delivery logs with payload presence flags and identifiers so Axiom can prove whether recording, transcript, and summary were actually in the delivered Tuition Highway payload
