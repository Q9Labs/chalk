
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
