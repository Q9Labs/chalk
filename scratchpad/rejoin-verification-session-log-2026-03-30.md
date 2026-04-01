
## 2026-03-30 14:27 PKT
- TH local server verified running on :4000 via `yarn dev` in th-lms-server.
- TH local client verified running on :3000 via `yarn dev` in th-lms-client.
- Local browser verification succeeded through admin login (`hasanshoaib@gmail.com` + bypass password) and dashboard/classes navigation.
- Browser flow blocked from full rejoin proof because dev dataset had no active sessions around now and direct class-room routes for sampled sessions rendered `Unable to Join Session` / `This session has already ended.`
- ET local client did not boot: missing `GITHUB_PACKAGES_TOKEN`, then Yarn/Corepack mismatch (`packageManager: yarn@4.13.0`, global Yarn 1.22.22).
- ET local server did not boot from simple `yarn dev`; package-manager resolution hit parent `/Users/macmini/package.json` pnpm config, and ET server env files in repo do not expose local DB vars.
- Helium browser binary not installed on this machine; used `agent-browser` against local TH instead.

## 2026-03-30 14:34 PKT
- Hypothesis refined: admin classes-page Chalk joins differ from teacher/student because admin uses hard link/new tab while teacher/student use same-tab `router.push`, preserving `sessionStorage`.
- Patched TH client `MeetingTracker` Chalk join path to use `window.location.assign(meetingLink)` instead of `router.push(meetingLink)`.
- Patched ET client `MeetingTracker` the same way for parity.

## 2026-03-30 15:57 PKT
- Assessed new incident file `/Users/macmini/Downloads/chalk-debug-1774866772844.txt`.
- Different failure family from prior 404: summary shows `rtc_join` / `RoomSocketHandler.joinRoom failed`, not `room not found`.
- Decoded TH JWT from report identifies role `teacher`, user id `6736357a0879c7e64529825d`.
- Debug report shows participant endpoint target `/api/v1/rooms/6998125b112fe246717d7c6d/participants`, same value as classroom route session id. In TH client, that implies `getChalkJoinRoomId()` likely fell back to `sessionData._id` because `sessionData.chalk_room_id` was absent/empty for this session.
- Report confirms auth token fetches succeeded (`/api/v1/auth/token` 200), so failure moved past auth into join/RTC stage.
- Secondary noise present: incident reporter 405s and Document PiP unhandled rejection.

## 2026-03-30 16:00 PKT
- Queried TH prod Mongo directly for session `6998125b112fe246717d7c6d`.
- Session is `meeting_account: chalk` but has no `chalk_room_id` and no `chalk_room_name`.
- No Chalk webhook fields populated either (`chalk_webhook_last_received_at`, `chalk_webhook_last_event`, `chalk_webhook_last_meeting_id`, `chalk_webhook_last_error` all null).
- This confirms the new teacher incident joined using fallback session id from route because canonical Chalk room id was absent.
- Session window: start `2026-03-30T10:30:38Z`, end `2026-03-30T11:30:38Z`.
- Teacher time logs remained null in the fetched record; student subdocument had session_time_logs activity ending at `2026-03-30T10:38:59.151Z` (interpret cautiously).

## 2026-03-30 18:59 PKT
- Implemented TH + ET server-side canonical Chalk room provisioning helper:
  - if `meeting_account !== chalk`, no-op
  - if `chalk_room_id` exists, return it
  - if missing, exchange Chalk API key for JWT via `/api/v1/auth/token`, create room via `/api/v1/rooms`, persist `chalk_room_id`/`chalk_room_name` with compare-and-set semantics, then return only the persisted canonical identity
- Patched TH + ET classroom clients to stop falling back from `chalk_room_id` to LMS session `_id`.
- TH local verification:
  - restarted local TH API on `:4000` and local TH client on `:3001`
  - found dev Chalk session `69957a5b44f81cc5de006666` with missing `chalk_room_id`
  - first browser load initially failed because resolver incorrectly used `X-API-Key` directly against `POST /api/v1/rooms`; Chalk API returned `401`
  - patched resolver to use `POST /api/v1/auth/token` first, then `Bearer <access_token>` for `POST /api/v1/rooms`
  - reloaded classroom page in `agent-browser`; prejoin loaded successfully instead of erroring
  - confirmed session document now has persisted canonical room identity:
    - `chalk_room_id: f00db826-29f0-e014-534d-bab62d6f5609`
    - `chalk_room_name: Schedule`
  - clicked `Join Now`; TH server logged `saveChalkSessionData` with canonical `roomId: f00db826-29f0-e014-534d-bab62d6f5609`, proving client join/save path is now using Chalk UUID, not session `_id`
- TH gate:
  - `th-lms-server`: `yarn ts.check` passed, `yarn build` passed
  - `th-lms-client`: `yarn lint` passed with pre-existing warnings only; `NEXT_PUBLIC_BASE_URL=https://portal.tuitionhighway.com yarn build` passed
- ET gate remains environment-blocked on this machine:
  - server typecheck/build blocked by missing installed deps / package-manager drift
  - client lint/build blocked by missing package install and private package token setup (`GITHUB_PACKAGES_TOKEN`)

## 2026-03-31 09:22 PKT
- Restart request from Hasan for TH + ET local stacks so he can test manually.
- TH repaired with `corepack yarn install --immutable` in both `th-lms-client` and `th-lms-server`.
- TH client started successfully on `http://localhost:3000`.
- TH server started successfully on `http://localhost:4000`.
- ET client start blocked: missing GitHub Packages auth for `@q9labs/chalk-core` during `yarn install --frozen-lockfile`.
- ET server deps installed with pnpm, but runtime boot blocked by missing VAPID env keys (`Missing VAPID keys in environment variables.`).
- Shared local admin creds remain the same for TH manual login: `hasanshoaib@gmail.com` / bypass password already known to Hasan.

## 2026-03-31 09:32 PKT
- Hasan reported two new local runtime errors during manual testing.
- TH/ET Chalk runtime overlay: `NotAllowedError: Failed to execute 'requestWindow' on 'DocumentPictureInPicture': Document PiP requires user activation`.
- ET client runtime overlay: `TypeError: Cannot read properties of undefined (reading 'replace')` in `src/contexts/socket/socket-context.tsx` from `process.env.NEXT_PUBLIC_BASE_URL`.
- Investigating SDK-first for PiP crash and app config guard for ET/TH socket context.

## 2026-03-31 10:20 PKT
- Hasan reported ET login posting to `http://localhost:3001/login` and returning 404.
- Root cause: ET local `et-lms-client/.env.local` was missing `NEXT_PUBLIC_BASE_URL`, so axios posted to the Next app origin instead of an API.
- Added `NEXT_PUBLIC_BASE_URL=https://dev-backend.emantime.com/api/v1` to local ET client `.env.local` and restarted the ET client on `:3001`.

## 2026-03-31 10:31 PKT
- Hasan hit ET class-room error screen: `Unable to Join Session` / `Chalk room is not configured for this session.`
- Suspected cause before verification: ET local client now requires canonical `chalk_room_id`, but remote ET dev backend/session may still be unhealed.

## 2026-03-31 10:35 PKT
- Hasan clarified ET should use the local backend, not remote dev.
- Investigating ET backend env acquisition from Elastic Beanstalk application environment because repo-local `.env.dev` lacks DB vars.

## 2026-03-31 10:40 PKT
- ET local stack switched fully local.
- ET client on `http://localhost:3000`.
- ET server on `http://localhost:5001` using EB dev environment vars pulled from AWS.
- Client `.env.local` updated to `NEXT_PUBLIC_BASE_URL=http://localhost:5001/api/v1`.

## 2026-03-31 11:15 PKT
- Reproduced ET local `500 timeout of 10000ms exceeded` on first-time Chalk room heal for session `69cb5dc94d8d1ac45d494e0a`.
- Direct `curl` and Node `axios@1.14.0` calls to Chalk auth succeeded from this machine in ~600ms, so this was not a blanket Chalk outage and not `axios@1.14.1`.
- Hardened TH + ET room heal path to retry only the Chalk auth token exchange on transient timeout/network/5xx errors; left room creation non-retried to avoid duplicate-room risk.
- Exact-pinned axios versions to prevent reinstall drift:
  - TH server / ET server -> `1.14.0`
  - TH client / ET client -> `1.13.6`
- Rechecked local ET endpoint after server restart: `200 OK` and the session now returns persisted `chalk_room_id=970c8c7b-ee33-8ab8-fc86-192bdd7aadfd`.

## 2026-03-31 11:35 PKT
- Hasan reported the pre-join brand mark was visually too large in TH/ET, especially on mobile.
- Root cause split:
  - SDK header image had no hard inline clamp beyond utility classes.
  - ET local apps still consume the published Chalk package, so an SDK-only change would not affect local consumer testing immediately.
- Added an SDK-side clamp in `packages/sdk-react/src/components/full/prejoin-lobby/PreJoinHeader.tsx`.
- Added immediate consumer-side CSS overrides in TH + ET `chalk-room.tsx` so local apps render the smaller header brand mark before any package release.
- Browser-verified on local ET with `agent-browser` after installing missing Playwright Chromium:
  - mobile screenshot: `scratchpad/et-prejoin-logo-consumer-clamped-mobile-2026-03-31.png`
  - desktop screenshot: `scratchpad/et-prejoin-logo-consumer-clamped-desktop-2026-03-31.png`

## 2026-03-31 12:05 PKT
- Hasan clarified TH frontend prod no longer ships through Amplify because of the Bahrain incident; workflow doc was stale.
- Re-validated live AWS state:
  - CloudFront prod distribution: `E1MP2FPR95HKXM`
  - alias: `portal.tuitionhighway.com`
  - origin: `th-lms-portal-use1-emergency-20260324.s3-website-us-east-1.amazonaws.com`
  - viewer-request function: `th-portal-dynamic-route-rewrite`
  - S3 website bucket config exists with `index.html` and `404.html`
- Updated `/Users/macmini/Desktop/Code/th-lms/CHALK_WORKFLOW.md` to mark Amplify as stale/non-prod control plane only, and to document the real prod frontend deploy path as local build -> S3 sync -> CloudFront invalidation.

## 2026-03-31 12:58 PKT
- Hasan reported TH prod classroom routes returning the app-level `404` page after the manual CloudFront deploy.
- Root cause: CloudFront viewer-request function rewrites dynamic routes like `/dashboard/class-room/:meeting_url` to nested static keys (`/dashboard/class-room/[meeting_url]/index.html`), but the published Next artifact only contained flat files (`/dashboard/class-room/[meeting_url].html`).
- Verified the mismatch directly against prod:
  - flat placeholder route key returned `200`
  - nested placeholder route key returned `404 NoSuchKey`
- Implemented durable TH client packaging fix in `th-lms-client/scripts/prepare-static-deploy.js`:
  - copies the static export output into `out/`
  - duplicates every non-root HTML page to a sibling nested `index.html`
  - preserves both flat and nested route shapes so existing CloudFront rewrites and direct static file access both work
- Added `prepare-static-deploy` script to TH client `package.json`.
- Committed + pushed TH client fix: `1d60891b fix(client): emit nested static route fallbacks`.
- Re-synced corrected `out/` artifact to `s3://th-lms-portal-use1-emergency-20260324` and completed CloudFront invalidation `ID2PGPF7JI6IY7MZVL1DBSMYOT`.
- Re-verified live prod:
  - `https://portal.tuitionhighway.com/dashboard/class-room/69ca69956655835e3a64a4cd` -> `200`
  - `https://portal.tuitionhighway.com/dashboard/class-room/%5Bmeeting_url%5D/index.html` -> `200`
- Assessment: this exact bug is TH-only because ET frontend still deploys through Amplify rather than TH's direct CloudFront static export pipeline.

## 2026-03-31 13:36 PKT
- Hasan reported TH still showing `room not found` for session `69cb8134cfbc45203c17ab52` after the room-id persistence patch.
- Debug bundle `chalk-debug-1774945331590.txt` showed TH was joining persisted room UUID `f842069b-b1e7-65ba-2e0d-a56304b64422`, not falling back to the LMS session id.
- Verified the TH session in prod Mongo (`test.sessions`) stores:
  - `meeting_account: "chalk"`
  - `chalk_room_id: "f842069b-b1e7-65ba-2e0d-a56304b64422"`
  - no webhook or post-meeting Chalk fields populated yet
- Queried Chalk directly:
  - room `f842069b-b1e7-65ba-2e0d-a56304b64422` exists and is active
  - room tenant is `9621ac51-fa9e-5a71-ea34-df050fdbfe7c`
- Decoded the client token from the debug bundle and found it belonged to tenant `8bdd43fd-50f8-1ec5-fd3a-fd718ead13c7`, so the browser was authenticating into the wrong Chalk tenant and then trying to join a room owned by another tenant.
- Confirmed live TH frontend bundle in S3 contained the wrong public Chalk key from local `.env.local`, while TH server `.env.prod` had the correct tenant/key.
- Durable fix:
  - updated `th-lms-client/scripts/validate-public-env.js` to mint a Chalk token at build time and fail the prod build if `NEXT_PUBLIC_CHALK_API_KEY` resolves to a tenant different from `NEXT_PUBLIC_CHALK_TENANT_ID`
  - updated `th-lms-client/next.config.js` earlier to disable `next/image` optimization for static S3 + CloudFront hosting
  - updated `/Users/macmini/Desktop/Code/th-lms/CHALK_WORKFLOW.md` to require explicit prod public Chalk env exports for frontend builds
- Rebuilt TH frontend with explicit prod public Chalk envs:
  - `NEXT_PUBLIC_BASE_URL=https://api.tuitionhighway.com/api/v1`
  - `NEXT_PUBLIC_CHALK_API_URL=https://chalk-api.q9labs.ai`
  - `NEXT_PUBLIC_CHALK_WS_URL=wss://chalk-ws.q9labs.ai/ws`
  - `NEXT_PUBLIC_CHALK_API_KEY=<TH prod public Chalk key>`
  - `NEXT_PUBLIC_CHALK_TENANT_ID=9621ac51-fa9e-5a71-ea34-df050fdbfe7c`
- Build validation now logs:
  - `Validated NEXT_PUBLIC_BASE_URL for production build: https://api.tuitionhighway.com`
  - `Validated Chalk public tenant for production build: 9621ac51-fa9e-5a71-ea34-df050fdbfe7c`
- Committed + pushed TH client fixes:
  - `3707ae44 fix(client): disable next image optimizer for static deploy`
  - `fcdeef08 fix(client): validate chalk tenant for prod builds`
- Republished TH frontend to `s3://th-lms-portal-use1-emergency-20260324` and invalidated CloudFront `E1MP2FPR95HKXM` with invalidation `I6HW36BXHJKLHPK0KNXUEKHJU9`.
- Live verification after publish:
  - new build id `NwMh65Z07PsSQOqh1EBcR`
  - live `_app-c4779955b82a2049.js` contains the correct TH prod Chalk key
  - live HTML no longer references `/_next/image`
  - direct asset URLs (`/assets/logo.png`, `/assets/login-img.png`, `/assets/vector-2.png`) return `200`

## 2026-03-31 15:18 PKT
- Hasan reported TH notifications still broken and suspected missing frontend env injection in the manual CloudFront build.
- Tried reading the old TH Amplify app env surface via AWS CLI:
  - `AWS_PROFILE=q9labs aws amplify get-app --app-id d17jmjn2v13h91 --region me-south-1`
  - `aws amplify list-apps`
  - `aws amplify list-branches --app-id d17jmjn2v13h91`
  - All returned `InternalServerErrorException` from the Amplify control plane in `me-south-1`, so the exact old env map could not be read from AWS during this check.
- Audited TH client env usage from source instead. Public vars referenced by code are:
  - `NEXT_PUBLIC_BASE_URL`
  - `NEXT_PUBLIC_CHALK_API_URL`
  - `NEXT_PUBLIC_CHALK_WS_URL`
  - `NEXT_PUBLIC_CHALK_API_KEY`
  - `NEXT_PUBLIC_CHALK_TENANT_ID`
  - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
  - `NEXT_PUBLIC_AWS_PROJECT_REGION`
  - `NEXT_PUBLIC_AWS_COGNITO_IDENTITY_POOL_ID`
  - `NEXT_PUBLIC_AWS_COGNITO_REGION`
  - `NEXT_PUBLIC_AWS_USER_POOLS_ID`
  - `NEXT_PUBLIC_AWS_USER_POOLS_WEB_CLIENT_ID`
  - `NEXT_PUBLIC_AUTH0_BASE_URL`
  - `NEXT_PUBLIC_AUTH0_CLIENT_ID`
  - `NEXT_PUBLIC_AUTH0_ISSUER_BASE_URL`
  - `NEXT_PUBLIC_FIREBASE_API_KEY`
  - `NEXT_PUBLIC_FIREBASE_APP_ID`
  - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
  - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
  - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
  - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
  - `NEXT_PUBLIC_GTM_CONTAINER_ID`
  - `NEXT_PUBLIC_MAPBOX_API_KEY`
  - `NEXT_PUBLIC_ENABLE_CLARITY`
  - `NEXT_PUBLIC_CLARITY_PROJECT_ID`
  - `NEXT_PUBLIC_ENABLE_REDUX_DEV_TOOLS`
- Current manual CloudFront build inputs came only from shell exports plus `.env.local`.
  - `.env.local` provides:
    - `NEXT_PUBLIC_BASE_URL`
    - `NEXT_PUBLIC_CHALK_API_URL`
    - `NEXT_PUBLIC_CHALK_WS_URL`
    - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
    - `NEXT_PUBLIC_CHALK_API_KEY`
    - `NEXT_PUBLIC_CHALK_TENANT_ID`
  - Prod redeploys overrode the backend host and Chalk public vars, but did not inject the broader legacy public env surface that the app still references.
- Verified current live TH frontend bundle through the CloudFront domain `dy9un6ve69k23.cloudfront.net`:
  - present:
    - `backend.tuitionhighway.com/api/v1`
    - `chalk-api.q9labs.ai`
    - the current `NEXT_PUBLIC_VAPID_PUBLIC_KEY` value
  - absent:
    - Firebase public config markers (`firebaseapp.com`, `AIza`)
    - Auth0 markers
    - Mapbox markers
- Important nuance for push notifications:
  - the frontend subscription path depends on `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, and that key is present in the current CloudFront build
  - `public/service_worker.js` is live and serving `200`
  - `usePushNotifications` never calls `Notification.requestPermission()`; it only subscribes if permission is already `granted`
  - so missing public envs are real, but the notification breakage may not be purely an env injection issue

## 2026-03-31 15:42 PKT
- Implemented TH client notification hardening in `th-lms-client`:
  - `usePushNotifications` now requests browser notification permission when the user is authenticated and the permission state is still `default`
  - `PushManager.subscribe` now receives the VAPID key as a `Uint8Array` instead of the raw base64url string
  - existing browser push subscriptions are reused and re-sent to the backend instead of always forcing a brand-new subscription
- Tightened TH frontend build validation:
  - production builds now require `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in addition to the existing base URL + Chalk public envs
  - this closes the silent-manual-build gap where CloudFront deploys could ship without the public key needed for web push
- Updated TH client `CHANGELOG.md` with the notification fix and build-validation guardrail.
- Local gate:
  - `yarn lint` completed with pre-existing warnings only
  - `yarn build` passed with explicit prod-style public env exports
  - `npx tsc --noEmit` did not complete in a reasonable window in this repo, so the build result is the stronger verification available from this pass
- Commit created in `th-lms-client`: `41f835e5 fix(client): harden web push registration`

## 2026-03-31 18:18 PKT
- Hasan said `ship it` for the TH notification fix.
- Pushed TH client `main` to GitHub:
  - `41f835e5 fix(client): harden web push registration`
- TH frontend deploy remains manual through S3 + CloudFront, so rebuilt and republished with explicit prod public envs:
  - `NEXT_PUBLIC_BASE_URL=https://backend.tuitionhighway.com/api/v1`
  - `NEXT_PUBLIC_CHALK_API_URL=https://chalk-api.q9labs.ai`
  - `NEXT_PUBLIC_CHALK_WS_URL=wss://chalk-ws.q9labs.ai/ws`
  - `NEXT_PUBLIC_CHALK_API_KEY=<from th-lms-server .env.prod>`
  - `NEXT_PUBLIC_CHALK_TENANT_ID=9621ac51-fa9e-5a71-ea34-df050fdbfe7c`
  - `NEXT_PUBLIC_VAPID_PUBLIC_KEY=<from th-lms-server .env>`
- Build validation passed:
  - required public env set present
  - base URL validated to `https://backend.tuitionhighway.com`
  - Chalk public tenant validated to `9621ac51-fa9e-5a71-ea34-df050fdbfe7c`
- Synced static export to `s3://th-lms-portal-use1-emergency-20260324`.
- CloudFront invalidation created and completed:
  - distribution `E1MP2FPR95HKXM`
  - invalidation `I1LVJDTFXUR2ECNI1RIT0XGABN`
- Live verification through CloudFront domain `dy9un6ve69k23.cloudfront.net`:
  - current app chunk `/_next/static/chunks/pages/_app-55fd7bdbcff80ec8.js`
  - bundle contains:
    - `backend.tuitionhighway.com/api/v1`
    - VAPID public key
    - `requestPermission`
    - `getSubscription`
    - `Uint8Array.from`

## 2026-04-01 09:36 PKT
- Hasan reported new user reports that `portal.tuitionhighway.com` was not loading.
- Live checks from this shell:
  - initial portal GET returned `403 Forbidden`
  - immediate retry returned `200 OK`
  - repeated smoke checks then stayed healthy:
    - portal HTML: 5/5 requests returned `200`
    - current app chunk `/_next/static/chunks/pages/_app-55fd7bdbcff80ec8.js`: 5/5 requests returned `200`
    - `/assets/logo.png`: 5/5 requests returned `200`
- Current live portal page still points at app chunk `55fd7bdbcff80ec8`, which is the latest shipped TH frontend artifact.
- Backend/API smoke from this shell was less clean:
  - `POST https://backend.tuitionhighway.com/api/v1/login` with a dummy payload timed out on read instead of returning a fast app-level auth error.
- Current assessment:
  - could not reproduce a sustained full frontend outage
  - saw one transient `403` at the edge followed by stable `200`s
  - frontend shell and static assets currently look healthy
  - backend responsiveness remains suspicious and may be what users perceive as the portal not loading/hanging

## 2026-04-01 10:58 PKT
- TH backend external probes all timed out for GET /api/v1/login, POST /api/v1/login, and GET / on backend.tuitionhighway.com (~15s each).
- Portal shell still served 200s earlier, so current user symptom likely backend/API outage rather than full frontend outage.
- AWS Elastic Beanstalk control-plane probe for th-lms-prod-v2 also failed with 502 Bad Gateway instead of returning environment health.

- Confirmed backend.tuitionhighway.com now returns Cloudflare 522 after ~39.5s (origin timeout), while portal.tuitionhighway.com remains healthy 200.
- Remote IP for both portal and backend resolves to Cloudflare edge IPv6 2606:4700:3033::ac43:b637, reinforcing that backend failure is on the Cloudflare->origin path rather than client-side DNS/browser.

## 2026-04-01 12:18 PKT
- Confirmed Cloudflare edge for backend.tuitionhighway.com accepts TCP on 80/443, but active TH prod EB origin th-lms-prod.eba-ddwh75rb.me-south-1.elasticbeanstalk.com times out at raw TCP connect on both 80 and 443.
- This isolates the outage to the EB/ALB origin layer before app HTTP handling. Not a frontend bundle issue and not a pure Cloudflare edge issue.
- AWS me-south-1 control-plane endpoints for STS/EB/ELB also timed out from this machine during investigation, preventing fresh target-health introspection via CLI.
