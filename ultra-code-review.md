# Chalk Web Code Review Findings (apps/web)

Scope: `apps/web` (code + config + docs + public assets). Binary assets (png/mp3/ico) were not inspected.

## Critical

- None found.

## High

- None found.

## Medium

- Debug logging is enabled by default in the demo room UX, which can leak room state, participant metadata, and error stacks in production sessions. This is controlled by query params/localStorage and is `true` by default. Consider gating with env-based flags and defaulting to off in production. Files: `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/room/$roomId.tsx`, `apps/web/src/features/room/utils/debug.ts`, `apps/web/src/features/room/components/ReactionBubbles.tsx`.
- Token refresh logic can return `undefined` when the refresh response is missing `accessToken`/`access_token`, but the function is typed as `Promise<string>`. This can cause downstream runtime errors or silent auth failures. Add validation and throw a controlled error if no access token is present. File: `apps/web/src/routes/__root.tsx`.
- Raw error messages are forwarded into the URL (`/room/error?message=...`) and displayed to the user. This can leak internal details, stack traces, or sensitive data if errors include them. Map errors to user‑safe messages and avoid placing raw errors in the URL. File: `apps/web/src/routes/room/$roomId.tsx`.
- Client tokens (refresh/access) are stored in `sessionStorage`, which is accessible to any injected script. If XSS occurs, tokens are exposed. Prefer HttpOnly cookies or an in‑memory token strategy, and ensure strict CSP. File: `apps/web/src/routes/__root.tsx`.
- Public OpenAPI spec exposes `/api/v1/demo/join`, which is explicitly unauthenticated. If demo mode is ever enabled in production, this becomes a trivial unauthenticated join/room‑creation vector. Ensure demo endpoints are disabled in prod or remove them from public docs. File: `apps/web/public/openapi.yaml`.
- OpenAPI server URLs (`https://api.chalk.io`) do not match the production base URL used elsewhere (`https://chalk-api.q9labs.ai`). This inconsistency can mislead integrators and cause SDK/client misconfiguration. File: `apps/web/public/openapi.yaml`.

## Low

- `wsUrl` derivation assumes `VITE_API_URL` is a valid URL. If an invalid value is set, `new URL(apiUrl)` throws and the app crashes on load. Add validation and fall back safely. File: `apps/web/src/routes/__root.tsx`.
- `CodeBlock` copy handler does not handle clipboard permission errors; `navigator.clipboard.writeText` can reject in insecure contexts, causing unhandled promise rejections. Wrap in `try/catch` and provide a fallback message or UI. File: `apps/web/src/features/docs/components/CodeBlock.tsx`.
- `CodeBlock` uses `setTimeout` without cleanup; unmounting before timeout fires can lead to state updates on unmounted components. Store the timer id and clear it in cleanup. File: `apps/web/src/features/docs/components/CodeBlock.tsx`.
- Internal docs links in `/docs/hooks` and `/docs/components` use `<a href>` instead of router `<Link>`, causing full page reloads and losing SPA navigation benefits. File: `apps/web/src/routes/docs/hooks.tsx`, `apps/web/src/routes/docs/components.tsx`.
- `styles.css` defines `font-family` on `body` and later applies `@apply font-sans` in the base layer, causing competing font stacks. Consolidate to a single source of truth to avoid inconsistent typography. File: `apps/web/src/styles.css`.
- `manifest.json` still uses the default TanStack app name (`Create TanStack App Sample`), which is inconsistent with Chalk branding. Update `name` and `short_name`. File: `apps/web/public/manifest.json`.
- `README.md` lists TanStack Query/Store, but those packages are not present in `apps/web/package.json`. This can mislead contributors. File: `apps/web/README.md`.
- `nitro` is pinned to `latest`, which makes builds non‑reproducible and can introduce breaking changes without review. Pin to a specific version. File: `apps/web/package.json`.
- `ComponentExample` and its helpers appear unused, and `components/ui/select.tsx` is entirely commented out. Consider removing or clearly marking these as intentionally retained examples to reduce dead code and maintenance overhead. Files: `apps/web/src/components/component-example.tsx`, `apps/web/src/components/example.tsx`, `apps/web/src/components/ui/select.tsx`.
- The demo route (`/demo`) creates a new random room on each visit. If exposed publicly, it is easy to generate unbounded rooms. Ensure backend rate‑limits, or reuse rooms for demo traffic. File: `apps/web/src/routes/demo.tsx`.

## Info

- The public OpenAPI spec includes demo/webhook schemas and endpoints; if these are not intended for external consumers, consider hiding them in published docs or marking them `x-internal`. File: `apps/web/public/openapi.yaml`.

# Chalk API + SDK Code Review Findings (apps/api, packages/sdk-core, packages/sdk-react)

Scope: `apps/api`, `packages/sdk-core`, `packages/sdk-react`. Source files only. Generated files were excluded (`apps/api/internal/infrastructure/postgres/db/*`, `packages/sdk-core/src/generated/**`, `packages/sdk-core/src/types/api/generated.ts`).

---

## ✅ Critical + High Issues Fixed (2025-01-12)

All **Critical (2)** and **High (10)** severity issues for `apps/api` and `packages/sdk-core` have been fixed:

| ID | Status | Fix Summary |
|----|--------|-------------|
| API-CRIT-01 | ✅ Fixed | Added tenant ownership check to `tenants.go` handlers comparing path ID to authenticated tenant |
| API-CRIT-02 | ✅ Fixed | Added tenant scoping to rooms/participants/recordings handlers via JWT claims verification |
| API-HIGH-01 | ✅ Fixed | JWT config now loaded from env via `config.Load()`; production fails fast on dev secrets |
| API-HIGH-02 | ✅ Fixed | `ValidateToken` now enforces `TokenType == "access"` and rejects refresh tokens |
| API-HIGH-03 | ✅ Fixed | WebSocket origin checking enabled; query param token deprecated with warning |
| API-HIGH-04 | ✅ Fixed | Permission grant/revoke requires host role check in `client.go` |
| API-HIGH-05 | ✅ Fixed | Added `RequireHost()` middleware to recording start/stop/archive endpoints |
| API-HIGH-06 | ✅ Fixed | Created migration `005_add_failed_recording_status.sql` adding 'failed' to constraint |
| API-HIGH-07 | ✅ Fixed | Webhook handler resets body after signature verification for JSON binding |
| API-HIGH-08 | ✅ Fixed | Participant add handler now checks `GetParticipant` error before dereferencing |
| SDKCORE-HIGH-01 | ✅ Fixed | Removed `authToken` fallback; throws `AUTH_FAILED` if no accessToken in response |

**Files modified:**
- `apps/api/internal/interfaces/http/handlers/tenants.go`
- `apps/api/internal/interfaces/http/handlers/rooms.go`
- `apps/api/internal/interfaces/http/handlers/participants.go`
- `apps/api/internal/interfaces/http/handlers/recordings.go`
- `apps/api/internal/interfaces/http/handlers/webhooks.go`
- `apps/api/internal/interfaces/http/handlers/websocket.go`
- `apps/api/internal/interfaces/http/router.go`
- `apps/api/internal/interfaces/http/middleware/auth.go`
- `apps/api/internal/interfaces/websocket/client.go`
- `apps/api/internal/infrastructure/auth/jwt.go`
- `apps/api/internal/config/config.go`
- `apps/api/cmd/main.go`
- `apps/api/db/migrations/005_add_failed_recording_status.sql` (new)
- `packages/sdk-core/src/api-client.ts`

---

## ✅ Medium + Low Issues Fixed (2025-01-12)

Additional **Medium (15)** and **Low (1)** severity issues for `apps/api` and `packages/sdk-core` have been fixed:

| ID | Status | Fix Summary |
|----|--------|-------------|
| API-MED-01 | ✅ Fixed | Paginated API key lookup replaces hard 1000 limit |
| API-MED-02 | ✅ Fixed | Demo tenant created by known name, not arbitrary first tenant |
| API-MED-03 | ✅ Fixed | DB port now parsed from config instead of hardcoded 5432 |
| API-MED-05 | ✅ Fixed | S3/R2 `errors.As` used to detect `NoSuchKey`/`NotFound` |
| API-MED-06 | ✅ Fixed | CORS credentials header only set when origin is allowed; added `Vary: Origin` |
| API-MED-07 | ✅ Fixed | Health endpoint no longer exposes DB error details |
| API-MED-08 | ✅ Fixed | All Cloudflare client methods now have mock implementations |
| API-MED-09 | ✅ Fixed | Redis participant state uses pipeline with TTL on add |
| API-MED-10 | ✅ Fixed | `GetRecordingState` treats `redis.Nil` as "no recording" |
| SDKCORE-MED-01 | ✅ Fixed | Empty/204 responses handled before `response.json()` |
| SDKCORE-MED-02 | ✅ Fixed | Concurrent refresh requests now serialize via shared promise |
| SDKCORE-MED-03 | ✅ Fixed | `isTokenExpired` uses `Buffer.from` fallback for Node.js |
| SDKCORE-MED-06 | ✅ Fixed | Bound resize handler stored for proper cleanup |
| SDKCORE-MED-07 | ✅ Fixed | Separate locks for audio/video toggle operations |
| SDKCORE-LOW-01 | ✅ Fixed | Heartbeat timeout enforced (2.5x interval triggers reconnect) |

**Skipped (require larger refactoring):**
- API-MED-04: Migration schema execution (needs migration strategy redesign)
- SDKCORE-MED-04: Event naming standardization (needs coordinated client/server changes)
- SDKCORE-MED-05: Type consolidation (larger refactor)
- sdk-react issues: Not in scope for this pass

**Additional files modified:**
- `apps/api/internal/infrastructure/storage/s3.go`
- `apps/api/internal/infrastructure/storage/r2.go`
- `apps/api/internal/infrastructure/cloudflare/client.go`
- `apps/api/internal/infrastructure/redis/room_state.go`
- `packages/sdk-core/src/client.ts`
- `packages/sdk-core/src/ws-client.ts`
- `packages/sdk-core/src/managers/ui-manager.ts`
- `packages/sdk-core/src/managers/media-manager.ts`

---

## Critical

- API key–protected tenant endpoints do not verify that the provided API key belongs to the tenant ID in the path. Any valid API key can read/update/delete/rotate any tenant by ID. Files: `apps/api/internal/interfaces/http/handlers/tenants.go`, `apps/api/internal/interfaces/http/middleware/auth.go`.
- Room/participant/recording endpoints rely on JWT presence but do not verify the JWT claims’ tenant/room against path IDs. A token from one tenant/room can operate on arbitrary room/participant/recording IDs across tenants. Files: `apps/api/internal/interfaces/http/handlers/rooms.go`, `apps/api/internal/interfaces/http/handlers/participants.go`, `apps/api/internal/interfaces/http/handlers/recordings.go`, `apps/api/internal/domain/room/service.go`, `apps/api/internal/domain/participant/service.go`, `apps/api/internal/domain/recording/service.go`.

## High

- JWT validation uses `DefaultJWTConfig` (hard‑coded dev secret) and ignores config in `config.Load()`. This makes prod secrets easy to misconfigure and allows forged tokens if defaults are used. Files: `apps/api/internal/interfaces/http/router.go`, `apps/api/internal/infrastructure/auth/jwt.go`, `apps/api/internal/config/config.go`.
- `ValidateToken` does not enforce token type or issuer/audience; refresh tokens can be used as access tokens. Files: `apps/api/internal/infrastructure/auth/jwt.go`, `apps/api/internal/interfaces/http/middleware/auth.go`.
- WebSocket origin checks are disabled (`InsecureSkipVerify: true`) and tokens are passed via query string/subprotocol, enabling CSWSH and increasing token exposure in logs/proxies. Files: `apps/api/internal/interfaces/http/handlers/websocket.go`, `packages/sdk-core/src/ws-client.ts`.
- WebSocket permission changes (whiteboard grant/revoke) have no role/permission checks; any participant can grant or revoke permissions. File: `apps/api/internal/interfaces/websocket/client.go`.
- Recording endpoints lack role/permission enforcement (host‑only actions can be invoked by any JWT). Files: `apps/api/internal/interfaces/http/router.go`, `apps/api/internal/interfaces/http/handlers/recordings.go`.
- Recording status constraint excludes `"failed"` but code sets `"failed"` (job + service), leading to DB errors and stuck recordings. Files: `apps/api/db/migrations/001_initial_schema.sql`, `apps/api/internal/infrastructure/jobs/recording_check.go`, `apps/api/internal/domain/recording/service.go`.
- Webhook handler reads and consumes the body for signature verification, then attempts `ShouldBindJSON` on an empty body, causing valid webhooks to fail. File: `apps/api/internal/interfaces/http/handlers/webhooks.go`.
- Participant add ignores `GetParticipant` errors and dereferences a possibly nil pointer, causing panics when participant lookup fails. File: `apps/api/internal/interfaces/http/handlers/participants.go`.
- `transformJoinResponse` falls back to `authToken` (RTC token) as `accessToken`, which can silently swap RTC tokens for API tokens if `accessToken` is absent. File: `packages/sdk-core/src/api-client.ts`.

## Medium

- API key validation iterates up to 1000 tenants and bcrypt‑checks each on every request. This fails once tenant count >1000 and creates a hot path O(n) + bcrypt cost. Files: `apps/api/internal/interfaces/http/middleware/auth.go`, `apps/api/internal/interfaces/http/handlers/auth.go`.
- Demo tenant creation uses `ListTenants` with limit 1 and a constant `"demo-key-hash"`. This can return a non‑demo tenant or store a non‑bcrypt hash. File: `apps/api/internal/interfaces/http/handlers/demo.go`.
- DB port is hard‑coded to 5432, ignoring config. Server port defaults may not match Dockerfile health checks (Docker exposes 8080, config default is 8081). Files: `apps/api/cmd/main.go`, `apps/api/Dockerfile`, `apps/api/internal/config/config.go`.
- `RunMigrations` executes a full schema on startup despite having versioned migrations; this risks drift and repeated DDL in prod. File: `apps/api/internal/infrastructure/postgres/postgres.go`.
- S3/R2 NotFound handling checks `smithy.APIError` without `errors.As`, so `NoSuchKey/NotFound` detection is broken. Files: `apps/api/internal/infrastructure/storage/s3.go`, `apps/api/internal/infrastructure/storage/r2.go`.
- CORS always sets `Access-Control-Allow-Credentials: true` even when no `Access-Control-Allow-Origin` is set, yielding inconsistent behavior and potential policy confusion. File: `apps/api/internal/interfaces/http/middleware/cors.go`.
- `/health` returns DB error details directly, leaking internal information. File: `apps/api/internal/interfaces/http/handlers/health.go`.
- Cloudflare mock only handles a subset of methods; other calls still hit the API even when unconfigured, leading to inconsistent dev behavior. File: `apps/api/internal/infrastructure/cloudflare/client.go`.
- Redis room state never sets TTLs for participants; `SetParticipantTTL` is unused and participant hashes can grow unbounded. File: `apps/api/internal/infrastructure/redis/room_state.go`.
- `GetRecordingState` returns `redis.Nil` as an error instead of treating missing state as “no recording.” File: `apps/api/internal/infrastructure/redis/room_state.go`.
- `APIClient.request` always calls `response.json()` even for empty bodies/204 responses, which throws and converts success into “network error.” File: `packages/sdk-core/src/api-client.ts`.
- Concurrent requests during token refresh return a hard failure instead of waiting on the refresh result, causing transient auth errors. File: `packages/sdk-core/src/api-client.ts`.
- `ChalkClient.isTokenExpired` uses `atob`, which is undefined in Node environments (SSR/server usage). File: `packages/sdk-core/src/client.ts`.
- Event naming is inconsistent (`room.updated` vs `room:updated`), and the mapping helpers are unused, making client/server event alignment fragile. Files: `packages/sdk-core/src/events.ts`, `packages/sdk-core/src/types/events/*`.
- Core types are duplicated and inconsistent (`types.ts` vs `types/entities/*`), and `ChalkErrorCode` is defined twice with different values. This can cause runtime logic bugs and type confusion. Files: `packages/sdk-core/src/types.ts`, `packages/sdk-core/src/types/entities/participant.ts`, `packages/sdk-core/src/errors/chalk-error.ts`.
- `UIManager` binds a new function for `addEventListener`/`removeEventListener`, so resize listeners are never removed (memory leak). File: `packages/sdk-core/src/managers/ui-manager.ts`.
- `MediaManager` uses a single lock for both audio and video toggles; toggling one blocks the other until it completes, producing unexpected UX. File: `packages/sdk-core/src/managers/media-manager.ts`.
- `useTranscripts` only subscribes once to `session`; if `room` becomes available later it never hooks up to transcript events. File: `packages/sdk-react/src/hooks/features/useTranscripts.ts`.
- `useWhiteboard` ignores the `seq` argument when forwarding updates, which can break ordering/merge behavior. File: `packages/sdk-react/src/hooks/features/useWhiteboard.ts`.
- `useKeyboardShortcuts` ignores the `meta` flag and treats `ctrl` as `ctrl || meta`, preventing macOS‑specific bindings; it also returns a non‑reactive `enabled` value. File: `packages/sdk-react/src/hooks/useKeyboardShortcuts.ts`.
- `useDevices` and `MeetingRoom` access `window`/`navigator`/`localStorage` unguarded, which will crash in SSR environments. Files: `packages/sdk-react/src/hooks/stream/useDevices.ts`, `packages/sdk-react/src/components/full/MeetingRoom.tsx`.
- `DeviceSelector` “Test speakers” button never plays audio (no source + no `play()`), so the UX is misleading. File: `packages/sdk-react/src/components/composite/DeviceSelector.tsx`.
- `SettingsPanel` renders a `NoiseSuppressionToggle` but passes `onLevelChange={() => {}}`, so the level selector is effectively dead even when enabled. File: `packages/sdk-react/src/components/composite/SettingsPanel.tsx`.

## Low

- WebSocket heartbeat tracks `lastPongTime` but never enforces timeouts; stale connections can linger. File: `packages/sdk-core/src/ws-client.ts`.
- `MessageBubble` ignores `showSender` and `isFirstInGroup` props, so callers can’t control sender display as advertised. File: `packages/sdk-react/src/components/composite/MessageBubble.tsx`.
- `ParticipantsPanel.tsx` is an empty file (0 bytes), suggesting dead/unfinished component. File: `packages/sdk-react/src/components/composite/ParticipantsPanel.tsx`.
- `PreJoinLobby` ignores `roomName` (unused prop), and `onCancel` is declared but never used. File: `packages/sdk-react/src/components/full/PreJoinLobby.tsx`.
- Sound effect file names include `transcription-ready.mp3` and `tour-step.mp3`, but those assets do not exist in the SDK package. This produces silent failures. File: `packages/sdk-react/src/hooks/useSoundEffects.ts`.
- Several tests/stories are out of sync with component APIs and will fail type‑checking or assertions:
  - Tests expect labels/classes that no longer exist (e.g., “Join Meeting”, `bg-[var(--chalk-primary)]`, “Leave”). Files: `packages/sdk-react/src/__tests__/full/PreJoinLobby.test.tsx`, `packages/sdk-react/src/__tests__/composite/MessageBubble.test.tsx`, `packages/sdk-react/src/__tests__/composite/ControlBar.test.tsx`.
  - Stories pass invalid props (`label/url` instead of `name/thumbnail`, `content` instead of `description`, missing `speakerId`, wrong `joinedAt` field). Files: `packages/sdk-react/src/stories/composite/BackgroundEffectsPicker.stories.tsx`, `packages/sdk-react/src/stories/composite/TourOverlay.stories.tsx`, `packages/sdk-react/src/stories/composite/TranscriptionPanel.stories.tsx`, `packages/sdk-react/src/stories/composite/WaitingRoom.stories.tsx`.

## Remediation Checklist

Format: `[ID] Severity | Area | Fix | Files | Verify`

## Team Worklists
Use these tables to assign each checklist item to the appropriate team. IDs link to GitHub issues that were already opened.

### API Team
| ID | Severity | Fix | Issue |
| --- | --- | --- | --- |
| [API-CRIT-01](https://github.com/Q9Labs/chalk/issues/22) | Critical | enforce tenant ownership by comparing path `:id` to tenant from API key; reject mismatches | 22 |
| [API-CRIT-02](https://github.com/Q9Labs/chalk/issues/23) | Critical | enforce tenant/room ownership in handlers or middleware; scope DB queries by tenant/room from claims | 23 |
| [API-HIGH-01](https://github.com/Q9Labs/chalk/issues/24) | High | inject JWT config from env (require non-default secret); fail fast if missing | 24 |
| [API-HIGH-02](https://github.com/Q9Labs/chalk/issues/25) | High | enforce `TokenType == "access"` in `ValidateToken` and validate issuer/audience | 25 |
| [API-HIGH-03](https://github.com/Q9Labs/chalk/issues/26) | High | implement strict WS origin checks; avoid query-token auth (use short-lived WS ticket or subprotocol only) | 26 |
| [API-HIGH-04](https://github.com/Q9Labs/chalk/issues/27) | High | authorize permission grant/revoke via role/permission check (host only) | 27 |
| [API-HIGH-05](https://github.com/Q9Labs/chalk/issues/28) | High | add role/permission middleware for recording endpoints (host-only) | 28 |
| [API-HIGH-06](https://github.com/Q9Labs/chalk/issues/29) | High | update recordings status constraint to include `failed` (or stop writing `failed`) | 29 |
| [API-HIGH-07](https://github.com/Q9Labs/chalk/issues/30) | High | reuse request body for signature verification and JSON binding (buffer + reset body or bind from bytes) | 30 |
| [API-HIGH-08](https://github.com/Q9Labs/chalk/issues/31) | High | handle `GetParticipant` errors and avoid nil deref in `Add` | 31 |
| [API-MED-01](https://github.com/Q9Labs/chalk/issues/32) | Medium | replace O(n) API key checks with keyed lookup (prefix or key ID + hash); remove hard limit | 32 |
| [API-MED-02](https://github.com/Q9Labs/chalk/issues/33) | Medium | create or lookup a dedicated demo tenant by known ID/name and store proper bcrypt hash | 33 |
| [API-MED-03](https://github.com/Q9Labs/chalk/issues/34) | Medium | read DB port from config and align server port with Dockerfile/healthcheck | 34 |
| [API-MED-04](https://github.com/Q9Labs/chalk/issues/35) | Medium | replace schema-based startup with versioned migrations only | 35 |
| [API-MED-05](https://github.com/Q9Labs/chalk/issues/36) | Medium | use `errors.As` to detect `smithy.APIError` and check `ErrorCode()` | 36 |
| [API-MED-06](https://github.com/Q9Labs/chalk/issues/37) | Medium | set `Access-Control-Allow-Credentials` only for allowed origins; consider `Vary: Origin` | 37 |
| [API-MED-07](https://github.com/Q9Labs/chalk/issues/38) | Medium | hide internal DB errors in `/health` response; log server-side | 38 |
| [API-MED-08](https://github.com/Q9Labs/chalk/issues/39) | Medium | add mocks for all Cloudflare methods or hard-fail when config missing | 39 |
| [API-MED-09](https://github.com/Q9Labs/chalk/issues/40) | Medium | apply TTLs for participant state or cleanup on disconnect | 40 |
| [API-MED-10](https://github.com/Q9Labs/chalk/issues/41) | Medium | treat `redis.Nil` as “no recording” in `GetRecordingState` | 41 |

### SDK Team
| ID | Severity | Fix | Issue |
| --- | --- | --- | --- |
| [SDKCORE-HIGH-01](https://github.com/Q9Labs/chalk/issues/42) | High | require `accessToken` from join response; do not fall back to `authToken` | 42 |
| [SDKCORE-MED-01](https://github.com/Q9Labs/chalk/issues/43) | Medium | handle empty/204 responses before `response.json()` | 43 |
| [SDKCORE-MED-02](https://github.com/Q9Labs/chalk/issues/44) | Medium | serialize refresh requests (store in-flight promise and await) | 44 |
| [SDKCORE-MED-03](https://github.com/Q9Labs/chalk/issues/45) | Medium | use `Buffer.from(..., "base64")` when `atob` is unavailable | 45 |
| [SDKCORE-MED-04](https://github.com/Q9Labs/chalk/issues/46) | Medium | standardize event naming or apply mapping consistently | 46 |
| [SDKCORE-MED-05](https://github.com/Q9Labs/chalk/issues/47) | Medium | consolidate duplicate types and error codes; update references | 47 |
| [SDKCORE-MED-06](https://github.com/Q9Labs/chalk/issues/48) | Medium | store bound resize handler and remove with same reference | 48 |
| [SDKCORE-MED-07](https://github.com/Q9Labs/chalk/issues/49) | Medium | split toggle locks for audio/video or allow independent toggles | 49 |
| [SDKCORE-LOW-01](https://github.com/Q9Labs/chalk/issues/50) | Low | enforce heartbeat timeout (close/reconnect on stale pong) | 50 |
| [SDKR-MED-01](https://github.com/Q9Labs/chalk/issues/51) | Medium | re-subscribe to transcripts when room becomes available; include room in deps | 51 |
| [SDKR-MED-02](https://github.com/Q9Labs/chalk/issues/52) | Medium | pass `seq` through to whiteboard manager | 52 |
| [SDKR-MED-03](https://github.com/Q9Labs/chalk/issues/53) | Medium | handle `meta` separately and make `enabled` reactive | 53 |
| [SDKR-MED-04](https://github.com/Q9Labs/chalk/issues/54) | Medium | guard `window`/`navigator`/`localStorage` usage in SSR | 54 |
| [SDKR-MED-05](https://github.com/Q9Labs/chalk/issues/55) | Medium | implement real test audio playback (set `src` + `play()`) | 55 |
| [SDKR-MED-06](https://github.com/Q9Labs/chalk/issues/56) | Medium | wire `onLevelChange` to a real handler or hide level UI | 56 |
| [SDKR-LOW-01](https://github.com/Q9Labs/chalk/issues/57) | Low | respect `showSender`/`isFirstInGroup` props in `MessageBubble` | 57 |
| [SDKR-LOW-02](https://github.com/Q9Labs/chalk/issues/58) | Low | implement or remove empty `ParticipantsPanel` | 58 |
| [SDKR-LOW-03](https://github.com/Q9Labs/chalk/issues/59) | Low | render `roomName` or remove prop; wire `onCancel` or remove | 59 |
| [SDKR-LOW-04](https://github.com/Q9Labs/chalk/issues/60) | Low | add missing sound assets or remove from `SOUND_FILES` | 60 |
| [SDKR-LOW-05](https://github.com/Q9Labs/chalk/issues/61) | Low | update tests/stories to match component APIs | 61 |

### Web Team
| ID | Severity | Fix | Issue |
| --- | --- | --- | --- |
| [WEB-MED-01](https://github.com/Q9Labs/chalk/issues/7) | Medium | gate debug logging behind env (default off in prod) and remove localStorage default | 7 |
| [WEB-MED-02](https://github.com/Q9Labs/chalk/issues/8) | Medium | validate refresh response; throw if no `accessToken`/`access_token` | 8 |
| [WEB-MED-03](https://github.com/Q9Labs/chalk/issues/9) | Medium | map errors to user-safe messages; avoid putting raw errors in query string | 9 |
| [WEB-MED-04](https://github.com/Q9Labs/chalk/issues/10) | Medium | move tokens to HttpOnly cookies or in-memory storage; add CSP | 10 |
| [WEB-MED-05](https://github.com/Q9Labs/chalk/issues/11) | Medium | hide/demo endpoints in public spec or gate demo in prod | 11 |
| [WEB-MED-06](https://github.com/Q9Labs/chalk/issues/12) | Medium | align OpenAPI server URLs with production base URL | 12 |
| [WEB-LOW-01](https://github.com/Q9Labs/chalk/issues/13) | Low | validate `VITE_API_URL` before `new URL` and fallback safely | 13 |
| [WEB-LOW-02](https://github.com/Q9Labs/chalk/issues/14) | Low | wrap clipboard write in `try/catch` and show fallback UI | 14 |
| [WEB-LOW-03](https://github.com/Q9Labs/chalk/issues/15) | Low | store timeout id and clear on unmount | 15 |
| [WEB-LOW-04](https://github.com/Q9Labs/chalk/issues/16) | Low | use router `<Link>` for internal docs links | 16 |
| [WEB-LOW-05](https://github.com/Q9Labs/chalk/issues/17) | Low | consolidate font-family definitions to a single source | 17 |
| [WEB-LOW-06](https://github.com/Q9Labs/chalk/issues/18) | Low | update manifest name/short_name to Chalk | 18 |
| [WEB-LOW-07](https://github.com/Q9Labs/chalk/issues/19) | Low | pin `nitro` to a specific version | 19 |
| [WEB-LOW-08](https://github.com/Q9Labs/chalk/issues/20) | Low | remove unused example components or mark intentionally retained | 20 |
| [WEB-LOW-09](https://github.com/Q9Labs/chalk/issues/21) | Low | reuse demo rooms or add rate-limits | 21 |

### apps/web

- [WEB-MED-01] Medium | apps/web | Fix: gate debug logging behind env (default off in prod) and remove localStorage default. | Files: `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/room/$roomId.tsx`, `apps/web/src/features/room/utils/debug.ts`, `apps/web/src/features/room/components/ReactionBubbles.tsx` | Verify: prod build shows no debug logs unless explicitly enabled.
- [WEB-MED-02] Medium | apps/web | Fix: validate refresh response; throw if no `accessToken`/`access_token`. | Files: `apps/web/src/routes/__root.tsx` | Verify: refresh failures surface controlled error and do not return `undefined`.
- [WEB-MED-03] Medium | apps/web | Fix: map errors to user-safe messages; avoid putting raw errors in query string. | Files: `apps/web/src/routes/room/$roomId.tsx` | Verify: `/room/error` shows sanitized messages only.
- [WEB-MED-04] Medium | apps/web | Fix: move tokens to HttpOnly cookies or in-memory storage; add CSP. | Files: `apps/web/src/routes/__root.tsx` | Verify: tokens are not readable from `window` storage.
- [WEB-MED-05] Medium | apps/web | Fix: hide/demo endpoints in public spec or gate demo in prod. | Files: `apps/web/public/openapi.yaml` | Verify: published spec excludes demo join or marks it internal.
- [WEB-MED-06] Medium | apps/web | Fix: align OpenAPI server URLs with production base URL. | Files: `apps/web/public/openapi.yaml` | Verify: URLs match `VITE_API_URL` and production domain.
- [WEB-LOW-01] Low | apps/web | Fix: validate `VITE_API_URL` before `new URL` and fallback safely. | Files: `apps/web/src/routes/__root.tsx` | Verify: invalid env does not crash app.
- [WEB-LOW-02] Low | apps/web | Fix: wrap clipboard write in `try/catch` and show fallback UI. | Files: `apps/web/src/features/docs/components/CodeBlock.tsx` | Verify: no unhandled promise rejection in insecure contexts.
- [WEB-LOW-03] Low | apps/web | Fix: store timeout id and clear on unmount. | Files: `apps/web/src/features/docs/components/CodeBlock.tsx` | Verify: no state updates after unmount.
- [WEB-LOW-04] Low | apps/web | Fix: use router `<Link>` for internal docs links. | Files: `apps/web/src/routes/docs/hooks.tsx`, `apps/web/src/routes/docs/components.tsx` | Verify: SPA navigation preserved.
- [WEB-LOW-05] Low | apps/web | Fix: consolidate font-family definitions to a single source. | Files: `apps/web/src/styles.css` | Verify: consistent font stack.
- [WEB-LOW-06] Low | apps/web | Fix: update manifest name/short_name to Chalk. | Files: `apps/web/public/manifest.json` | Verify: PWA install shows correct branding.
- [WEB-LOW-07] Low | apps/web | Fix: pin `nitro` to a specific version. | Files: `apps/web/package.json` | Verify: lockfile diff is stable across installs.
- [WEB-LOW-08] Low | apps/web | Fix: remove unused example components or mark intentionally retained. | Files: `apps/web/src/components/component-example.tsx`, `apps/web/src/components/example.tsx`, `apps/web/src/components/ui/select.tsx` | Verify: no dead code warnings.
- [WEB-LOW-09] Low | apps/web | Fix: reuse demo rooms or add rate-limits. | Files: `apps/web/src/routes/demo.tsx` | Verify: repeated visits do not create unbounded rooms.

### apps/api

- [API-CRIT-01] Critical | apps/api | Fix: enforce tenant ownership by comparing path `:id` to tenant from API key; reject mismatches. | Files: `apps/api/internal/interfaces/http/handlers/tenants.go`, `apps/api/internal/interfaces/http/middleware/auth.go` | Verify: cross-tenant access returns 403.
- [API-CRIT-02] Critical | apps/api | Fix: enforce tenant/room ownership in handlers or middleware; scope DB queries by tenant/room from claims. | Files: `apps/api/internal/interfaces/http/handlers/rooms.go`, `apps/api/internal/interfaces/http/handlers/participants.go`, `apps/api/internal/interfaces/http/handlers/recordings.go`, `apps/api/internal/domain/*/service.go` | Verify: JWT from one tenant cannot access another tenant's room/recording.
- [API-HIGH-01] High | apps/api | Fix: inject JWT config from env (require non-default secret); fail fast if missing. | Files: `apps/api/internal/interfaces/http/router.go`, `apps/api/internal/infrastructure/auth/jwt.go`, `apps/api/internal/config/config.go` | Verify: startup fails when secret is default; tokens validate with configured issuer.
- [API-HIGH-02] High | apps/api | Fix: enforce `TokenType == "access"` in `ValidateToken` and validate issuer/audience. | Files: `apps/api/internal/infrastructure/auth/jwt.go` | Verify: refresh tokens are rejected on access endpoints.
- [API-HIGH-03] High | apps/api | Fix: implement strict WS origin checks; avoid query-token auth (use short-lived WS ticket or subprotocol only). | Files: `apps/api/internal/interfaces/http/handlers/websocket.go` | Verify: cross-site WS connections rejected; tokens not present in URL logs.
- [API-HIGH-04] High | apps/api | Fix: authorize permission grant/revoke via role/permission check (host only). | Files: `apps/api/internal/interfaces/websocket/client.go`, `apps/api/internal/domain/participant/service.go` | Verify: non-host cannot grant/revoke permissions.
- [API-HIGH-05] High | apps/api | Fix: add role/permission middleware for recording endpoints (host-only). | Files: `apps/api/internal/interfaces/http/router.go`, `apps/api/internal/interfaces/http/handlers/recordings.go` | Verify: participant role cannot start/stop/archive recordings.
- [API-HIGH-06] High | apps/api | Fix: update recordings status constraint to include `failed` (or stop writing `failed`). | Files: `apps/api/db/migrations/001_initial_schema.sql`, `apps/api/internal/domain/recording/service.go` | Verify: failed recordings persist without DB errors.
- [API-HIGH-07] High | apps/api | Fix: reuse request body for signature verification and JSON binding (buffer + reset body or bind from bytes). | Files: `apps/api/internal/interfaces/http/handlers/webhooks.go` | Verify: valid webhooks are accepted and parsed.
- [API-HIGH-08] High | apps/api | Fix: handle `GetParticipant` errors and avoid nil deref in `Add`. | Files: `apps/api/internal/interfaces/http/handlers/participants.go` | Verify: missing participant returns 404/500 without panic.
- [API-MED-01] Medium | apps/api | Fix: replace O(n) API key checks with keyed lookup (prefix or key ID + hash); remove hard limit. | Files: `apps/api/internal/interfaces/http/middleware/auth.go`, `apps/api/internal/interfaces/http/handlers/auth.go` | Verify: auth works with >1000 tenants and stays O(1).
- [API-MED-02] Medium | apps/api | Fix: create or lookup a dedicated demo tenant by known ID/name and store proper bcrypt hash. | Files: `apps/api/internal/interfaces/http/handlers/demo.go` | Verify: demo flow never reuses non-demo tenant.
- [API-MED-03] Medium | apps/api | Fix: read DB port from config and align server port with Dockerfile/healthcheck. | Files: `apps/api/cmd/main.go`, `apps/api/Dockerfile`, `apps/api/internal/config/config.go` | Verify: container healthcheck succeeds with configured port.
- [API-MED-04] Medium | apps/api | Fix: replace schema-based startup with versioned migrations only. | Files: `apps/api/internal/infrastructure/postgres/postgres.go` | Verify: startup does not reapply schema in prod.
- [API-MED-05] Medium | apps/api | Fix: use `errors.As` to detect `smithy.APIError` and check `ErrorCode()`. | Files: `apps/api/internal/infrastructure/storage/s3.go`, `apps/api/internal/infrastructure/storage/r2.go` | Verify: missing objects return 404/`ErrNotFound`.
- [API-MED-06] Medium | apps/api | Fix: set `Access-Control-Allow-Credentials` only for allowed origins; consider `Vary: Origin`. | Files: `apps/api/internal/interfaces/http/middleware/cors.go` | Verify: CORS responses are consistent.
- [API-MED-07] Medium | apps/api | Fix: hide internal DB errors in `/health` response; log server-side. | Files: `apps/api/internal/interfaces/http/handlers/health.go` | Verify: health returns generic failure without error details.
- [API-MED-08] Medium | apps/api | Fix: add mocks for all Cloudflare methods or hard-fail when config missing. | Files: `apps/api/internal/infrastructure/cloudflare/client.go` | Verify: dev runs without hitting external API unintentionally.
- [API-MED-09] Medium | apps/api | Fix: apply TTLs for participant state or cleanup on disconnect. | Files: `apps/api/internal/infrastructure/redis/room_state.go` | Verify: Redis room state does not grow unbounded.
- [API-MED-10] Medium | apps/api | Fix: treat `redis.Nil` as “no recording” in `GetRecordingState`. | Files: `apps/api/internal/infrastructure/redis/room_state.go` | Verify: missing state does not surface as error.

### packages/sdk-core

- [SDKCORE-HIGH-01] High | sdk-core | Fix: require `accessToken` from join response; do not fall back to `authToken`. | Files: `packages/sdk-core/src/api-client.ts` | Verify: missing access token returns error and does not use RTC token.
- [SDKCORE-MED-01] Medium | sdk-core | Fix: handle empty/204 responses before `response.json()`. | Files: `packages/sdk-core/src/api-client.ts` | Verify: 204 responses do not throw.
- [SDKCORE-MED-02] Medium | sdk-core | Fix: serialize refresh requests (store in-flight promise and await). | Files: `packages/sdk-core/src/api-client.ts` | Verify: concurrent 401s resolve after single refresh.
- [SDKCORE-MED-03] Medium | sdk-core | Fix: use `Buffer.from(..., "base64")` when `atob` is unavailable. | Files: `packages/sdk-core/src/client.ts` | Verify: SSR/Node usage no longer throws.
- [SDKCORE-MED-04] Medium | sdk-core | Fix: standardize event naming or apply mapping consistently. | Files: `packages/sdk-core/src/events.ts`, `packages/sdk-core/src/types/events/*` | Verify: client/server event names match.
- [SDKCORE-MED-05] Medium | sdk-core | Fix: consolidate duplicate types and error codes; update references. | Files: `packages/sdk-core/src/types.ts`, `packages/sdk-core/src/types/entities/*`, `packages/sdk-core/src/errors/chalk-error.ts` | Verify: single source of truth for types.
- [SDKCORE-MED-06] Medium | sdk-core | Fix: store bound resize handler and remove with same reference. | Files: `packages/sdk-core/src/managers/ui-manager.ts` | Verify: listener removed on dispose.
- [SDKCORE-MED-07] Medium | sdk-core | Fix: split toggle locks for audio/video or allow independent toggles. | Files: `packages/sdk-core/src/managers/media-manager.ts` | Verify: audio and video toggles can run concurrently.
- [SDKCORE-LOW-01] Low | sdk-core | Fix: enforce heartbeat timeout (close/reconnect on stale pong). | Files: `packages/sdk-core/src/ws-client.ts` | Verify: stale connections are closed after threshold.

### packages/sdk-react

- [SDKR-MED-01] Medium | sdk-react | Fix: re-subscribe to transcripts when room becomes available; include room in deps. | Files: `packages/sdk-react/src/hooks/features/useTranscripts.ts` | Verify: transcripts appear after delayed join.
- [SDKR-MED-02] Medium | sdk-react | Fix: pass `seq` through to whiteboard manager. | Files: `packages/sdk-react/src/hooks/features/useWhiteboard.ts` | Verify: update ordering respects seq.
- [SDKR-MED-03] Medium | sdk-react | Fix: handle `meta` separately and make `enabled` reactive. | Files: `packages/sdk-react/src/hooks/useKeyboardShortcuts.ts` | Verify: macOS shortcuts can be meta-only.
- [SDKR-MED-04] Medium | sdk-react | Fix: guard `window`/`navigator`/`localStorage` usage in SSR. | Files: `packages/sdk-react/src/hooks/stream/useDevices.ts`, `packages/sdk-react/src/components/full/MeetingRoom.tsx` | Verify: SSR render does not crash.
- [SDKR-MED-05] Medium | sdk-react | Fix: implement real test audio playback (set `src` + `play()`). | Files: `packages/sdk-react/src/components/composite/DeviceSelector.tsx` | Verify: test sound audibly plays on supported browsers.
- [SDKR-MED-06] Medium | sdk-react | Fix: wire `onLevelChange` to a real handler or hide level UI. | Files: `packages/sdk-react/src/components/composite/SettingsPanel.tsx` | Verify: level changes propagate or UI removed.
- [SDKR-LOW-01] Low | sdk-react | Fix: respect `showSender`/`isFirstInGroup` props in `MessageBubble`. | Files: `packages/sdk-react/src/components/composite/MessageBubble.tsx` | Verify: sender/timestamp visibility matches props.
- [SDKR-LOW-02] Low | sdk-react | Fix: implement or remove empty `ParticipantsPanel`. | Files: `packages/sdk-react/src/components/composite/ParticipantsPanel.tsx` | Verify: no empty exports remain.
- [SDKR-LOW-03] Low | sdk-react | Fix: render `roomName` or remove prop; wire `onCancel` or remove. | Files: `packages/sdk-react/src/components/full/PreJoinLobby.tsx` | Verify: props are used or deleted.
- [SDKR-LOW-04] Low | sdk-react | Fix: add missing sound assets or remove from `SOUND_FILES`. | Files: `packages/sdk-react/src/hooks/useSoundEffects.ts` | Verify: sound lookup does not 404.
- [SDKR-LOW-05] Low | sdk-react | Fix: update tests/stories to match component APIs. | Files: `packages/sdk-react/src/__tests__/full/PreJoinLobby.test.tsx`, `packages/sdk-react/src/__tests__/composite/MessageBubble.test.tsx`, `packages/sdk-react/src/__tests__/composite/ControlBar.test.tsx`, `packages/sdk-react/src/stories/composite/BackgroundEffectsPicker.stories.tsx`, `packages/sdk-react/src/stories/composite/TourOverlay.stories.tsx`, `packages/sdk-react/src/stories/composite/TranscriptionPanel.stories.tsx`, `packages/sdk-react/src/stories/composite/WaitingRoom.stories.tsx` | Verify: `bun run test` and Storybook type-check pass.
