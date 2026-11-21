# Real web-call proof

`pnpm web:proof` creates a temporary Space and Episode in the configured proof
Tenant, enters the deployed web app through its invite and Entrance screen, and
joins a second participant with the existing proof-kit SDK guest. Both publish
generated camera frames and tones. Exact assertions require advancing received
video frames and a positive incoming audio level on both sides. The web app must
also show the guest's live video tile. Both leave before
cleanup ends the Episode, archives the Space, and revokes the temporary key.

The runner authenticates with the environment's proof Tenant key. It does not
check account sign-in; the browser uses the real public-invite flow and
never receives that key. This suite does not claim to test account sign-in.

## Run

Install the root dependencies, then `pnpm exec e2e-web install chromium --with-deps`.
The SDK guest uses its own pinned Playwright: also run
`pnpm --filter @q9labsai/chalk-client exec playwright install --with-deps chromium`.
Use the environment variables documented in [the proof kit](../prod-proof/README.md)
and set `CHALK_PROOF_CONFIG_SOURCE=env`. `CHALK_PROOF_WEB_URL` selects the deployed
web base URL; its build must target the same API as `CHALK_PROOF_API_URL`.
The same test runs on nightly and production without changing selectors.
The API must be ready, but recording and transcription can be disabled: this
proof tests the live web call, not media processing. The separate recording and
transcript proofs still require both media capabilities before a nightly can hold.

The proof Space is on Cloudflare by default. `CHALK_PROOF_MEDIA_PLANE=chalk_sfu` runs the call on the Chalk SFU
instead: the public API cannot create such a Space, so set `CHALK_PROOF_SPACE_ID_CHALK_SFU` to a Space an operator moved with
`media-settings` (manual Recording, on-demand Transcription, open admission). The run turns that Space's public invite on
for the call and off again afterwards, and ends the Episode it made. `CHALK_PROOF_WEBKIT=1` adds Playwright WebKit (an
iPad Safari profile) beside Chromium. `CHALK_PROOF_JOIN_ORDER=web-first` or `guest-first` fixes which side is in the
Episode before the other joins; unset, the SDK guest starts while the web app opens.

Run browser suites in a configured checkout, not a developer laptop. For hosted runs, `.github/workflows/web-call-proof.yml` accepts an environment (production) and returns `result=passed` only when the test, cleanup and encrypted evidence upload pass. A manual dispatch takes `media_plane` (`cf_sfu` by default). The cut's own web lane runs on a throwaway stack (`.github/workflows/nightly-proofs.yml`). This workflow and the real-call proof share one environment lock because proof cleanup resets the webhook.

Tests live in `tests/*.e2e.ts` and use TesterArmy `e2e` with `@e2e-dev/web`. Retries are disabled, so a failing cut stays failed.

Private screenshots and cleanup reports are in `.private/prod-proof/<run-id>/`.
The full e2e result folder, `.private/web-proof/e2e`, is encrypted too, including
failure screenshots and assertion details.
The runner always attempts cleanup; the hosted workflow repeats cleanup after
failure or cancellation with `pnpm prod:proof cleanup <run-id>`. Existing product
retention keeps archived Space/Episode history. No recording starts in this test.

## Listen-only join and access renewal

For the Chalk SFU regression, use the [nightly stack](../nightly-stack/boot) on
Linux with `--web-https`. Build the web app with `VITE_API_URL` and
`VITE_PUBLIC_APP_URL` set to `https://127.0.0.1:8000` and `VITE_CHALK_SYNC_URL`
set to `wss://127.0.0.1:8000/v1/sync`. WebKit requires HTTPS to store the
guest credential cookie.

Install Edge and WebKit with `pnpm exec playwright install --with-deps msedge webkit`.
Load the stack's `proof.env`, unset `CHALK_PROOF_SPACE_ID_CHALK_SFU`, and point
`NODE_EXTRA_CA_CERTS` at the stack's `web-ca.crt`. Run
`xvfb-run -a node scripts/web-proof/listen-only.mjs`. The proof switches Edge
to a real background tab and injects the visibility change in WebKit. Both
use real media and wait over five minutes. The report and screenshots go
under `.private/web-proof/`.

## Student before owner

`node scripts/web-proof/student-first.mjs` checks that a collaborator can join an
active Episode before an owner, then receive the owner's video without a reload.
It also checks Episode-creation idempotency using the server SDK. It does not
cover application access preparation, account sign-in, or recordings.

Run it on Instabox with the local stack ready, Chromium installed, and the server
SDK built. Supply a local Tenant's key and ID through `CHALK_PROOF_API_KEY` and
`CHALK_PROOF_TENANT_ID` without printing them. `CHALK_PROOF_API_URL`,
`CHALK_PROOF_SYNC_URL`, and `CHALK_PROOF_WEB_URL` can override the local URLs;
the script rejects non-loopback hosts. Results go to
`.private/web-proof/student-first`, or `CHALK_STUDENT_FIRST_DIRECTORY` if set.
The script closes its browsers, ends the Episode, and archives the Space; a
cleanup failure fails the proof.
