## 2026-03-26

### 2026-03-26T00:00:00+05:00
- Task: deep startup analysis; discuss patch options before implementing.
- Parallelized 3 GPT-5.4 high audits: mobile, web, cross-cutting shared packages.
- Local evidence:
- `apps/web` production build emits `main-*.js` at ~2.99 MB minified / ~1.03 MB gzip.
- Vite warns dynamic imports are defeated for `@cloudflare/realtimekit` and several sdk-react lazy components.
- `apps/web/src/routeTree.gen.ts` statically imports every route, including docs + room + dashboard.
- Main web chunk string scan includes `whiteboard`, `Excalidraw`, `mdx`, `posthog`, `Dashboard`, `ChatPanel`, `SettingsPanel`, `TranscriptionPanel`, `DocsLayout`.
- `apps/mobile` imports meeting stack from root `App.tsx`; no visible Metro startup tuning beyond custom resolver.
- Mobile likely pays conference stack parse cost before entering a room.

### 2026-03-26T00:25:00+05:00
- Reconfirmed target with Hasan: startup should feel instant.
- Working definition:
- Web:
  - landing/docs/dashboard shell should paint immediately
  - invite/join flow should avoid full reloads
  - room join should minimize serial waterfalls
- Mobile:
  - cold boot should show branded shell immediately
  - home screen must not pay meeting stack cost
  - deep links should resolve in a dedicated bootstrap state, not flash home first

### Consolidated Findings

#### Web

- Root app boot is too heavy.
- `apps/web/src/routes/__root.tsx` mounts `ChalkProvider`, `WhatsNew`, and `DebugDialog` globally.
- `packages/sdk-react/src/context/chalk-provider.tsx` creates `ChalkSession` immediately on mount.
- `packages/sdk-core/src/session/chalk-session.ts` eagerly constructs conference client, Effect runtime, managers, incident pipeline, bridges.
- Result: non-meeting routes still pay meeting runtime startup tax.

- Route/code splitting is undercut.
- `apps/web/src/routeTree.gen.ts` statically imports all route modules.
- Current build still ships a giant main chunk.
- TanStack Router can support better automatic route splitting, but current import shapes and route organization are preventing the intended result.

- Lazy boundaries are fake in several places.
- `packages/sdk-react/src/components/lazy.tsx` lazy-loads heavy panels.
- `packages/sdk-react/src/components/composite/index.ts` statically re-exports those same panels.
- Build warning confirms split is defeated for:
  - `ChatPanel`
  - `TranscriptionPanel`
  - `SettingsPanel`
  - `BackgroundEffectsPicker`

- RealtimeKit lazy loading is partly defeated.
- `packages/sdk-react/src/context/chalk-provider.tsx` statically imports `RealtimeKitProvider`.
- Core runtime tries to lazy import RTK, but the static provider path neutralizes the win.

- Optional features are landing too early.
- Global What's New fetch runs on every boot.
- Debug dialog is eagerly imported from root.
- Sound data is bundled as base64 and wired into conference startup.
- Background effects and whiteboard paths still leak into main graphs earlier than necessary.

- Join flow pays extra cost.
- `apps/web/src/routes/j/$joinToken.tsx` uses `window.location.replace(...)`.
- `apps/web/src/routes/demo.tsx` also hard reloads.
- `/new` -> `/room/$roomId` path still does extra room metadata and join-link work after navigation.

#### Mobile

- Cold boot graph is too large.
- `apps/mobile/App.tsx` imports Chalk meeting stack at root.
- `packages/sdk-react-native/src/index.ts` is a broad barrel.
- `NativeVideoConference` statically imports both meeting room and lobby branches.
- Current exported Hermes bundles are around `10M` for both Android and iOS.

- Meeting startup starts too much too early.
- `ChalkNativeProvider` creates `ChalkSession` eagerly.
- `NativePreJoinLobby` starts camera preview immediately via `getUserMedia`.
- This slows time-to-first-interaction for users just entering lobby.

- Deep-link startup is not polished.
- `Linking.getInitialURL()` resolves after initial render.
- If join token resolution is needed, app can render home first, then pivot into lobby.
- This feels slow even if total time is not huge.

- Some startup work is non-critical but still early.
- Clipboard invite suggestion checks run on home mount.
- Dev diagnostics code is imported at root even though only useful in dev paths.
- Metro config does not currently show explicit startup-focused tuning like `inlineRequires`.

### Ranked Execution Plan

#### P0: Structural wins first

1. Web: remove `ChalkProvider` from app root.
- Mount it only on routes that truly need live conference/session runtime.
- Likely `/room/*`, maybe `/dashboard`, maybe share/playback routes if they use SDK hooks.
- Keep app root limited to theme, error, router shell.
- Expected outcome:
  - landing/docs startup much faster
  - avoids constructing `ChalkSession` on pages that do not need it

2. Mobile: split app shell from meeting shell.
- Keep `apps/mobile/App.tsx` tiny.
- Move meeting path into a separately loaded module.
- Home boot should not import RTK/WebRTC/meeting room tree.
- Expected outcome:
  - near-instant home shell paint
  - lower parse/eval cost on cold boot

3. Web: eliminate hard reloads in join/demo flow.
- Replace `window.location.replace(...)` / `window.location.assign(...)` with SPA navigation.
- Expected outcome:
  - join links stop paying full app startup twice
  - instant-feeling transition into room/bootstrap route

#### P1: Make lazy actually lazy

4. Fix fake-lazy panel exports.
- Stop statically re-exporting heavy panel modules from eager barrels.
- Introduce dedicated lazy/heavy entrypoints if needed.

5. Unblock RTK splitting.
- Remove static `RealtimeKitProvider` path from always-loaded provider graph.
- Load RTK bridge only when there is an active RTK meeting.

6. Narrow package entrypoints.
- Add subpath exports for:
  - provider
  - video conference
  - what's new
  - hooks
  - selected UI primitives
- Migrate app internals away from root barrels.

#### P2: Cleanup and polish

7. Mobile: add explicit `booting` state.
- Deep links should remain on branded bootstrap while token/room resolution happens.
- No home flash.

8. Mobile: delay prejoin camera preview.
- Start preview after first frame, after short idle, or only once user opts into camera.
- Preserve a fast-feeling lobby shell first.

9. Web: make What's New and DebugDialog idle/lazy.
- No startup fetch or markdown/runtime cost on every page load.

10. Defer optional subsystems.
- Sounds
- background effects
- whiteboard helpers
- notification stack if unused

11. Verify Metro startup tuning.
- Check/enable `inlineRequires` carefully for Expo/Metro startup wins.

### Success Criteria

- Web:
  - main startup chunk materially reduced
  - landing/docs render without conference runtime init
  - join links stay SPA
  - room path starts useful UI earlier with fewer blocking fetches

- Mobile:
  - cold boot paints branded shell immediately
  - home route does not import meeting stack
  - deep links show bootstrap, not home flash
  - prejoin feels immediate even before camera wakes up

### Proposed Implementation Order

1. Web root/provider split
2. Mobile shell/meeting split
3. Web SPA join flow
4. Fix lazy panel export leaks
5. Unblock RTK lazy path
6. Deep-link/mobile bootstrap polish
7. Optional subsystem deferral
8. Package entrypoint cleanup

### Notes For Implementation

- We should measure after each P0/P1 step.
- Add lightweight timing marks around:
  - app root mount
  - provider init
  - session constructor
  - first shell paint
  - room route visible
  - RTK loaded
  - meeting visible
- Goal is not theoretical perfection; goal is immediate perceived response.
- Main principle:
  - do not import meeting code until user is truly on a meeting path

### 2026-03-26 22:18 PKT - Mobile P0 shell/meeting split

- Kept `apps/mobile/App.tsx` as app shell/router/diagnostics only.
- Moved meeting-heavy runtime (`ChalkNativeProvider`, `NativeVideoConference`, `useSession`) into new `apps/mobile/src/meeting/MobileMeetingScreen.tsx`.
- Loaded the meeting module via runtime `import()` only when route enters `lobby`.
- Added `apps/mobile/src/components/AppBootstrapScreen.tsx` for initial boot + meeting-module handoff.
- Added initial `isBooting` state so deep links resolve before home renders; removes home flash on cold-start deep-link open.
- Verification:
  - `bun run --cwd apps/mobile check-types`
  - `bun run --cwd apps/mobile build`
## 2026-03-26 22:47 PKT

- implemented web P0 provider split
- root route no longer mounts `ChalkProvider` / `ChalkSession` path
- added route-scoped `WebChalkRuntime` wrapper for `/dashboard` and active `/room/$roomId` conference UI
- kept lightweight room token priming in root to preserve first-join auth warmup
- verified `bun run --cwd apps/web build` passes
- note: client main bundle size still essentially unchanged; next win is route/code splitting + SDK lazy fixes

## 2026-03-26 23:03 PKT

- integrated all three P0 startup cuts into the same tree
- web:
  - `/j/$joinToken` and `/demo` now navigate through TanStack Router instead of full document reloads
  - root no longer boots Chalk runtime globally
  - root token warmup now stays on the room-scoped web token provider
- mobile:
  - app shell stays light on cold boot
  - meeting runtime loads on demand from `src/meeting/MobileMeetingScreen.tsx`
  - branded bootstrap screen covers initial deep-link resolution and meeting handoff
  - enabled Metro `inlineRequires` to defer more module evaluation on startup
- verify:
  - `bun run --cwd apps/web build`
  - `bun run --cwd apps/mobile lint`
  - `bun run --cwd apps/mobile build`

## 2026-03-26 23:24 PKT

- fixed follow-up mobile warnings after the startup pass
- deferred dev diagnostics store notifications to a microtask so diagnostics subscribers do not update during `ChalkNativeProvider` render/setup
- hardened `NativeMeetingPanel` list keys for messages, participants, transcripts, and device rows
- replaced direct `crypto.randomUUID()` usage in sdk-core with a guarded helper so RN debugger paths fall back cleanly when secure crypto APIs are missing
- verify:
  - `bun run --cwd apps/mobile lint`
  - `bun run --cwd apps/mobile build`
