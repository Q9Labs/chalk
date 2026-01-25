# Chalk Mobile Rebuild Plan (Expo Dev Client, iOS + Android)


## Goals

- Keep **Expo dev-client** (native modules supported).
- Support **iOS + Android simultaneously**.
- Preserve Chalk’s core functionality/value prop:
  - Create or join a room
  - Request permissions
  - Pre-join lobby (preview + device selection)
  - Join call + in-call UI
- Keep **business logic in packages**, not demo apps (`apps/*`).
- Make the system **boringly stable**: no uncaught JS exceptions, no Hermes native crashes, reproducible native builds.

## Non-goals

- Adding new product features.
- Fixing unrelated lint/test failures outside the mobile + RN SDK surface.

---

# Phase 0 — Guardrails (do first)

1. **Create a working branch**

- `git checkout -b rebuild-mobile`

2. **Snapshot the current state**

- Record:
  - `apps/mobile/package.json`
  - `packages/sdk-react-native/package.json`
  - Expo/RN versions (`npx expo --version`)
  - Xcode version, Android SDK/Gradle versions

3. **Decide replacement strategy**

- Recommended: build in `apps/mobile2` and only swap once stable.
- Alternative: replace `apps/mobile` in-place, but move old one to `apps/mobile.old`.

---

# Phase 1 — Enforce a stable dependency matrix (workspace-wide)

## Goal

Eliminate the crash-prone cross-product of:
`New Architecture × Hermes × Reanimated(worklets) × native WebRTC/RealtimeKit`.

## Actions

1. **Force New Architecture OFF**

- Ensure the Expo app config includes:
  - `expo.newArchEnabled = false`
- Ensure iOS and Android native config reflect it after prebuild.

2. **Keep Hermes ON**

- `expo.jsEngine = "hermes"`

3. **Pin Reanimated major to v3 everywhere**

- Pin `react-native-reanimated` to `~3.19.x` in:
  - `apps/<mobile>/package.json`
  - `packages/sdk-react-native/package.json` (devDependency + peer range)
- Add a repo-level override if supported (Bun `overrides`) to prevent v4 from being pulled.

## Verification

- Search lockfiles for `react-native-reanimated@4`.
- Ensure no workspace package introduces v4.

---

# Phase 2 — Rebuild `packages/sdk-react-native` as Metro/RN-first

## Goal

The RN SDK must execute under Metro/Hermes without Node-target build artifacts and without brittle `.default` assumptions.

## Key design constraints

- The **demo app must remain thin**. All RTC and meeting logic belongs in the SDK.
- Avoid **Node-specific output** (e.g. `node:` imports, `createRequire`) for the RN runtime entrypoint.

## Packaging strategy (pick one)

### Option A (recommended): “RN uses source entry”

- Provide an `exports` condition (or `react-native` field) that points Metro to `./src/index.ts`.
- Keep `dist/` for publishing, but Metro consumes source in this monorepo.
- Pros: eliminates bundler interop problems during dev; simplest.
- Cons: published package still needs `dist/` built correctly for external consumers.

### Option B: “RN uses RN-targeted dist”

- Produce `dist/react-native/index.js` built for RN runtime (no Node wrappers).
- Use conditional exports so Metro resolves to `dist/react-native/*`.
- Pros: matches published behavior more closely.
- Cons: more work; build pipeline must guarantee no Node-only output.

## Actions (for either option)

1. **Add conditional exports**

- Update `packages/sdk-react-native/package.json`:
  - Add `"react-native"` export condition (or `"react-native"` field).
  - Keep `"types"` pointing to `.d.ts`.

2. **Remove/avoid Node-target bundling for RN runtime**

- Do not build the RN runtime entry with `--target node`.
- If producing a dist bundle, ensure build output contains no `node:` imports.

3. **Centralize module-shape interop**

- Add `unwrapDefaultExport()` helper in a shared utility module (e.g. `src/utils/interop.ts`).
- Replace any `require("x").default` usage with `unwrapDefaultExport(require("x"))`.
- Apply to dynamic imports of:
  - `@cloudflare/realtimekit-react-native`
  - `@gorhom/bottom-sheet`
  - `@cloudflare/react-native-webrtc` (MediaStream/mediaDevices access)

4. **Harden all native boundary surfaces**

- `RTCManager.enumerateDevices()`:
  - Never throw; always return `MediaDeviceInfo[]`.
  - Simulator/no-native: return safe empty list or mock list (and document behavior).
- `useDevices()`:
  - Treat enumeration output as untrusted (validate array, normalize fields).
- `useLocalStream()`:
  - Must degrade gracefully (no camera on simulator, permission denied).
  - Must not crash rendering.

## Verification

- `cd packages/sdk-react-native && bun run clean && bun run build && bun run check-types`
- Inspect the RN runtime entry file for `node:` imports.

---

# Phase 3 — Create a minimal Expo dev-client app (thin harness)

## Goal

`apps/<mobile>` should only do:
routing + env/config injection + minimal UI for create/join.

## Actions

1. **Create the app**

- Preferred: create `apps/mobile2` (router template acceptable).
- Wire it into the monorepo/workspaces.

2. **Stabilize Metro entrypoint under Bun**

- In `apps/mobile2/package.json`: `"main": "./index.js"`
- Add `apps/mobile2/index.js`:
  - `import "react-native-reanimated";` (must be first)
  - `import "expo-router/entry";`

3. **Routes**

- `app/_layout.tsx`:
  - Wrap in `GestureHandlerRootView`.
  - Provide `ChalkProvider` with env/token provider.
- `app/index.tsx`:
  - Inputs: `roomId`, `displayName`
  - Buttons: Start (create), Join
- `app/call.tsx`:
  - Render SDK `VideoConference` (or a single “CallExperience” component).

4. **Env + token provider**

- `apps/mobile2/lib/env.ts` reads `EXPO_PUBLIC_*` vars.
- `apps/mobile2/lib/token-provider.ts` implements API key → JWT exchange (if used).
- App passes: `apiUrl`, `wsUrl`, `tokenProvider` into SDK.

5. **Permissions**

- `apps/mobile2/app.json` iOS `infoPlist` keys:
  - `NSCameraUsageDescription`
  - `NSMicrophoneUsageDescription`
  - `NSBluetoothAlwaysUsageDescription` (only if required)
- Android: confirm runtime permission code exists in SDK; add manifest/plugins only if needed.

---

# Phase 4 — Generate native projects cleanly (iOS + Android)

## Goal

Eliminate native drift and make “regen + build” deterministic.

## Actions

1. **Clean prebuild**

- `cd apps/mobile2 && npx expo prebuild --clean`

2. **iOS Podfile hardening**
   In `apps/mobile2/ios/Podfile` `post_install`:

- Fix `.xcprivacy` build phase misclassification:
  - Ensure `*.xcprivacy` is not in “Compile Sources”.
  - Ensure it is included as a resource if required.
- Fix Yoga header search paths if needed:
  - Ensure Yoga target has correct `HEADER_SEARCH_PATHS`.
- Ensure New Arch stays off:
  - `RCT_NEW_ARCH_ENABLED=0`.

Then:

- `cd apps/mobile2/ios && pod install`

3. **Android configuration**

- Ensure New Arch disabled (gradle property / Expo-generated config).
- Ensure Hermes enabled.

---

# Phase 5 — Build dev clients + smoke test (both platforms)

## Goal

Prove “open → lobby → join → in-call UI” without crashes.

## Actions

1. **Build the dev clients**

- `cd apps/mobile2 && npx expo run:ios`
- `cd apps/mobile2 && npx expo run:android`

2. **Run Metro**

- `cd apps/mobile2 && npx expo start --dev-client --clear`

3. **Manual smoke tests**

- Home loads.
- Navigate to `/call?roomId=test`.
- Lobby renders.
- Permission request flow works.
- Joining shows explicit “joining” state.
- Failure surfaces are shown in-app (not router error boundary).
- Leave returns safely.

## Simulator expectations

- iOS simulator may not provide real camera input; SDK must degrade gracefully.
- Android emulator may vary; do not crash if no camera.

---

# Phase 6 — Reintroduce Chalk UI components safely (SDK-side)

## Goal

Preserve intended Chalk SDK experience while remaining stable.

## Actions

1. **Bottom sheet and gesture handler**

- Bottom sheet must load lazily and never assume `.default`.
- Ensure any bottom sheet usage occurs after `GestureHandlerRootView` is mounted.

2. **Error containment**

- SDK screens should catch errors and render error UI + retry.
- Avoid letting errors bubble to Expo Router error boundary.

3. **Native boundary protections**

- Wrap all native calls with:
  - permission checks
  - platform guards
  - try/catch returning safe values

---

# Phase 7 — Docs + anti-regression checks

## Goal

Future contributors don’t rediscover these problems.

## Actions

1. **App README**

- Add `apps/mobile2/README.md`:
  - Setup
  - Env vars
  - Build commands
  - Simulator limitations
  - “New Arch must remain off” rationale

2. **Repo scripts**

- Add root scripts:
  - `bun run mobile:ios` → `cd apps/mobile2 && npx expo run:ios`
  - `bun run mobile:android` → `cd apps/mobile2 && npx expo run:android`
  - `bun run mobile:start` → `cd apps/mobile2 && npx expo start --dev-client --clear`
  - `bun run mobile:verify` → checks for forbidden versions (e.g. reanimated v4) and newArch enabled.

3. **Quick static checks**

- Grep the RN SDK runtime entry for Node built-ins (`node:`).
- Fail CI (or at least print warnings) if present.

---

# Acceptance Criteria (definition of done)

1. `expo run:ios` and `expo run:android` succeed from a clean prebuild.
2. App opens in dev-client on both platforms without “problem loading project”.
3. Navigating to call/lobby never crashes; no uncaught exceptions.
4. Join flow results in either:

- successful connection, or
- a controlled, user-facing error state (not a router error boundary).

5. The SDK RN runtime entrypoint does not rely on Node-only imports/APIs.

---

# Execution Decisions Required Up Front

- **App strategy:** `apps/mobile2` (recommended) vs replace `apps/mobile`.
- **SDK packaging:** Option A (RN uses source) vs Option B (RN uses RN dist).
- **Demo/offline mode:** required or not (affects join/create flow in SDK).
