# Real web-call proof

`pnpm web:proof` creates a temporary Space and Episode in the configured proof
Tenant, enters the deployed web app through its invite and Entrance screen, and
joins a second participant with the existing proof-kit SDK guest. Both publish
generated camera frames and tones. Exact assertions require advancing received
video frames and a positive incoming audio level on both sides. The web app must
also show the guest's live video tile. Both leave before
cleanup ends the Episode, archives the Space, and revokes the temporary key.

Chalk currently has no account sign-in screen. The runner authenticates with the
environment's proof Tenant key; the browser uses the real public-invite flow and
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

Run browser suites in a configured M4 checkout, not a developer laptop. Keep its
proof configuration and evidence in that checkout. For hosted runs,
`web-call-proof.yml` accepts an environment and returns `result=passed` only
when the test, cleanup, and encrypted evidence upload pass. Nightly runs it after
deploy and after the recording/transcript proof. Both workflows share the same
environment lock because existing proof cleanup resets the webhook. Both must pass to hold a cut;
the deployment record retains `real_call_proof_result` and `web_e2e_result`.

Tests live in `tests/*.e2e.ts` and use TesterArmy `e2e` with `@e2e-dev/web`.
There are no agent steps, model calls, or replay-cache entries to commit.
Retries are disabled, so a failing cut stays failed rather than passing on retry.

Private screenshots and cleanup reports are in `.private/prod-proof/<run-id>/`.
The full e2e result folder, `.private/web-proof/e2e`, is encrypted too, including
failure screenshots and assertion details.
The runner always attempts cleanup; the hosted workflow repeats cleanup after
failure or cancellation with `pnpm prod:proof cleanup <run-id>`. Existing product
retention keeps archived Space/Episode history. No recording starts in this test.
