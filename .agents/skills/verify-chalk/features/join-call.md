# Join a call by invite

A person opens a Space's invite link, types a name on the entrance screen, joins the call, and sees and hears the other people through the media plane. When they leave, the call page shows a left state and the API records their attendance.

## Sub-features

- `join-entrance` shows the entrance screen with a `Your name` field and a `Join call` button.
- `join-arrive` admits the guest: the page posts a public invite arrival and receives the guest cookie.
- `join-tiles` shows a `Video tile for <name>` for every participant, including the person themself.
- `join-video` delivers each participant's camera to the others through the SFU.
- `join-attendance` records every guest on the Episode, readable through the API.
- `join-leave` ends the guest's session and shows `Rejoin`.

## How to get to it (user POV)

- Open the invite link, `<PUBLIC_ORIGIN><invite.path>` (the path comes from .private/chalk-dev/seed.json). Type a name in `Your name`, then choose `Join call`.
- Open the same URL that another participant's page shows after they joined. The second person joins the same Episode.

## Driving it with Playwright (join-call script)

Preconditions:

- `pnpm dev:doctor` reports `"ok": true` and the sign-in check passes.
- The web origin is `localhost` or HTTPS.
- The run id is new: `.verify/<run-id>/` does not exist.
- `playwright` and its Chromium are installed.

- **Run the journey.** Run `node .agents/skills/verify-chalk/scripts/join-call.mjs <run-id>`. Exit code `0` and `"pass": true` in `.verify/<run-id>/result.json`.
- **Enter and join.** Each participant goes to the invite path, runs `getByLabel("Your name", { exact: true }).fill(<name>)` and `getByRole("button", { name: "Join call", exact: true }).click()`. A button named `Video tile for <name>` appears within 60 s.
- **Both tiles.** Each page shows `Video tile for Verify A` and `Video tile for Verify B`.
- **Publish.** Hover `getByRole("region", { name: "Space stage" })`, then click `Unmute microphone` and `Turn on camera`.
- **Own video.** Each page's own tile decodes a frame within 60 s. If not, the step fails with `sender never published`, so a receiver is never blamed for a sender that sent nothing.
- **Receive video.** The other person's tile decodes a first frame within 60 s (a miss fails with `60 s timeout`), then `video.getVideoPlaybackQuality().totalVideoFrames` read twice, three seconds apart, rises by more than 5. result.json stores the first-frame time per page under `measurements` and both frame counts.
- **Attendance.** Read `GET /v1/tenants/<tenantId>/spaces/<spaceId>/episodes`, then `.../episodes/<id>/attendance` with `Authorization: Bearer <systemToken>`. attendance.json lists both names.
- **Leave.** Hover the stage, click `Leave call`. A button named `Rejoin` appears.
- **Proof.** `.verify/<run-id>/screenshots/Verify-A-in-call.png` shows the other person's moving test pattern and the person's own mirrored tile. `video/*.webm` shows the whole session.

## Gotchas

- The guest cookie is `__Host-` prefixed and `Secure`. On an origin that is neither `localhost` nor HTTPS the arrival POST returns 201 but the browser drops the cookie, so the page never shows a tile. A non-resolvable `PUBLIC_ORIGIN` also breaks the Sync WebSocket (`ERR_NAME_NOT_RESOLVED` in console.json).
- A guest can leave only with the cookie and the `X-Chalk-Arrival-Handle` header. A bare DELETE answers 404 `arrival.unavailable`.
- console.json shows a few `Failed to load resource ... 406` lines for non-API resources. They did not affect the journey. Treat a new `/v1` status of 4xx or 5xx in network.json as a failure.
- Without Cloudflare SFU credentials the API cannot create a media session, so tiles never publish. The journey must then fail. Do not skip the video step.
- The test pattern is the repo's fake camera, so a passing run proves the SFU path and the page, not a real camera or microphone.
