---
name: verify-chalk
description: Launch Chalk (web, API, Sync, Postgres, Redis) headless on one machine, check it, drive a real call in Chromium with fake camera and microphone through the non-production Cloudflare SFU, and capture evidence into .verify/<run-id>/. Use when a task needs proof that Chalk's web app works as a user sees it.
---

# Verify Chalk

Chalk is a real-time collaboration platform. A user opens a Space's invite link in a browser, enters a name, joins a call, and talks, shares video and draws on a whiteboard. This skill runs the repo's own `pnpm dev` stack and drives that path with Playwright. Read [features/README.md](features/README.md) before you drive anything: it lists the journeys and their selectors.

Only one Chalk runtime can own a machine. `pnpm dev` refuses to start a second one, and `pnpm dev:status` names the owning checkout. Never drive a runtime your run did not start.

## Launch

Run from the repo root. The command is the same on a Mac with OrbStack and on a headless Linux box.

```sh
export CHALK_CLOUDFLARE_REALTIME_APP_ID=...        # non-production Chalk/SFU item, app_id
export CHALK_CLOUDFLARE_REALTIME_APP_SECRET=...    # non-production Chalk/SFU item, app_secret
export PUBLIC_ORIGIN=http://localhost:3070         # optional, see below
pnpm install --frozen-lockfile
pnpm dev                                           # run it in tmux or another session that stays alive
```

- With both SFU variables set the launcher does not call the 1Password CLI. With neither set it reads the item through `op` as before. Setting only one fails startup.
- `PUBLIC_ORIGIN` is the origin a person or browser uses to reach the web app. It sets the Sync token issuer, the CORS list, the Vite host allow-list and the browser's Sync WebSocket URL. Unset, the issuer stays `http://chalk.local`.
- Chalk's guest cookie is `__Host-chalk_space_guest_*` and is `Secure`. A browser only stores it on `https://` origins or on `localhost`. Use `http://localhost:3070` (or `http://<name>.localhost:3070`, which Chromium resolves to loopback) for a plain-HTTP run. A real remote origin needs HTTPS in front of port 3070. A name such as `http://chalk-orb.test` fails: the browser cannot resolve it.
- From an empty data dir the first run starts Postgres and Redis containers, pulls their images, compiles the API, runs `mix deps.get` and compile for Sync, runs migrations, creates a tenant and a Space, and enables the Space's public invite. Plan for about 3 GB of memory for the stack and about 6 GB with two Chromium contexts, so keep other work off the box while you drive.

Ready means the supervisor printed `Chalk dev ready`. That line only appears after a seeded guest has arrived through the invite page and left again, using the web origin. The seed is in .private/chalk-dev/seed.json (mode 0600, git-ignored) and holds `tenantId`, `spaceId`, `invite.path`, `systemToken`, `urls`. The `systemToken` is a credential: read it, never copy it into evidence.

## Doctor

```sh
pnpm dev:doctor
```

Read-only. It prints JSON `{ "ok": true|false, "checks": [...] }` and exits 0 only when every check passes. The checks are owner, build (the running revision equals `HEAD`), services, api, sync, web and sign-in. Run it before every drive and whenever anything looks off. A failing check names the stage. Do not drive on a failed doctor.

## Drive

Use the existing harness. Pick the journey in [features/README.md](features/README.md).

- **Join a call (real path).** `node .agents/skills/verify-chalk/scripts/join-call.mjs <run-id>`. Two Chromium contexts arrive through the seeded invite, publish the fake camera and microphone from `scripts/web-proof/media.mjs` (`webMediaFixture`), see each other's video advance through the Cloudflare SFU, and leave. Exit 0 means every step passed.
- **Sync socket reuse.** `node .agents/skills/verify-chalk/scripts/socket-reuse.mjs <run-id> [--web <origin>] [--lobby-ms N] [--leave-ms N]`. One browser tab waits in the lobby, joins, leaves and rejoins, and the script counts the Sync WebSocket upgrades it made and how many started after each Join press (zero means the join used a socket that was already open).
- **Existing Playwright specs.** `tests/call.e2e.ts` and `tests/board.e2e.ts` run against a deployed proof tenant through `pnpm test:e2e`. Their selectors are the source for the feature files. They need proof-tenant credentials that this skill does not hold.
- **UI-only previews.** `pnpm --dir apps/web exec vite --config vite.call-states.config.ts` serves `http://127.0.0.1:3071/call-states.html?state=<id>` with no API and no SFU. Use it for layout and state checks only, never as proof of a real call.

Prefer ARIA roles and names (`Join call`, `Video tile for <name>`, `Leave call`) over CSS. Controls on the stage hide until you hover the `Space stage` region, so hover first.

## Evidence

Evidence goes to `.verify/<run-id>/` (git-ignored). Choose a unique `<run-id>`, for example the UTC time plus the feature id.

- result.json: journey, run id, origin, verdict and every step with its time.
- `screenshots/`: entrance and in-call screenshots per participant, and a failure screenshot on error.
- `video/`: one recording per participant (webm).
- console.json and network.json: browser console and every `/v1` response (method, path, status).
- diagnostics.json: written only when a join-call step fails. Per page: tile and track state, first-frame times, WebRTC stats (inbound and outbound video counters, ICE and transport state, selected candidate pair type), console errors and failed `/v1` requests (status, error code).
- attendance.json: the API's attendance for the Episode, read back with the system token.

Proof standards: enter through the invite page and the buttons a user presses, not internal setters; check the resulting state in the page (decoded frames of the remote tile must increase) and through a second view (the API attendance lists both people); keep the SFU real. Only the camera and microphone are fakes. The helper scans every text artifact for the run's credentials and exits 3 if one appears. If it does, delete the artifact and fix the leak before you share anything.

## Cleanup

```sh
pnpm dev:down
```

`down` runs `stop`, then `reset --yes`: it stops the processes this runtime started, drops the `chalk_dev` database, clears Redis state and removes `.private/chalk-dev`. It leaves the shared Postgres container and the pulled images in place. It never touches `.verify/`. After cleanup, `ls .verify/<run-id>` must still list the evidence. Delete scratch secret files you wrote. Run `down` after a failed iteration too, so no port stays bound. Do not kill processes by name.
