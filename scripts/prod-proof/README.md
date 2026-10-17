# Production proofs

`pnpm prod:proof` runs all release proofs, including a forced camera layer switch.
It uses an existing Tenant API key from `CHALK_PROOF_API_KEY`. Reuse an operator-provisioned
Tenant dedicated to release proofs.

```sh
pnpm install --frozen-lockfile
pnpm --filter @q9labsai/chalk-client exec playwright install chromium
pnpm prod:proof
pnpm prod:proof smoke
pnpm prod:proof camera-share --force-layer-switch
pnpm prod:proof camera-share # simulcast + share, without the optional limit
pnpm prod:proof export
pnpm prod:proof recording-rejoin
pnpm prod:proof transcript
```

Install `aws`, FFmpeg (`ffmpeg`/`ffprobe`), and ImageMagick (`magick`).
Signed webhook proofs use a temporary Webhook.site receiver. Voice generation uses macOS `say` (Samantha), or Linux `espeak`.
No new JavaScript dependencies are needed; Playwright and esbuild come from the
client SDK workspace. Run from the repository root. Headless Chromium only.

## Configuration and ownership

Supply configuration through the environment: `CHALK_PROOF_TENANT_ID`,
`CHALK_PROOF_API_URL`, `CHALK_PROOF_WEB_URL`, `CHALK_PROOF_PROOF_ORIGIN`,
`CHALK_PROOF_AWS_PROFILE`, `CHALK_PROOF_AWS_REGION`, `CHALK_PROOF_SSM_API_ENV`,
and `CHALK_PROOF_WEBHOOK_SERVICE_URL`. Resolve the existing configuration item's
matching fields with your secret manager alongside the API key. The command
never reads its legacy account or inbox credentials, and it needs no nested
1Password session. The SSM parameter verifies that Recording and Transcription
are enabled; AWS uses the supplied profile.

Have an operator provide a key for that Tenant. Inject it with `2password run`
or your secret manager as `CHALK_PROOF_API_KEY`; never put its value in a command
argument, repository file, or browser response. The bootstrap key needs exactly:

- `api_keys:write`, `api_keys:delete` to create and revoke each run's key.
- `spaces:read`, `spaces:write`, `episodes:read`, `episodes:write` for the Space and Episode lifecycle.
- `recordings:read`, `transcriptions:read`, `transcriptions:write` for artifacts.
- `transcriptions:delete`, `webhooks:write`, `webhooks:delete` for cleanup and signed webhook proofs.

The short-lived key has only the seven Space, Episode, and artifact scopes above.
The runner checks that it cannot read Tenant administration, then verifies a 401
after revocation. The bootstrap key never needs Tenant management, membership,
signing-key management, or account permissions.

Provision the Tenant separately through your deployment's operator tooling.
Allow `proof_origin` in that Tenant's CORS origins once; the command does not
change Tenant settings. Use a loopback HTTP origin with a fixed available port.
Run one proof per origin at a time.

Every run creates its own short-lived API key, Space, Episode, and Recording.
Configure the permanent Tenant once with `transcription_ceiling: on_demand`,
`transcription_default_mode: on_demand`, a nonempty `provider_policy_version`, and
a positive `transcription_source_window_seconds` (for example 86400). A disabled
Tenant ceiling overrides the Space setting. Spaces explicitly use `recording_policy: manual` and
`transcription_policy: on_demand`. Their immutable Episode policy and the
Recording's effective Transcription policy are checked, too.

Cleanup runs even on a failed proof: revoke and test the key, remove the webhook
endpoint and Transcript, close Chromium and the local server and delete the temporary webhook catcher, end the Episode,
and archive the Space. There is no product hard-delete API for Spaces, Episodes,
or Recordings; ended/archived history and Recording artifacts follow the product's
retention policy. The provisioned Tenant and bootstrap API key are retained.

## What counts as proof

- **smoke:** API key, Space, Episode, two live guests, Recording, signed lifecycle
  webhooks correlated to this run's objects, successful Export and MP4 download.
  A temporary Webhook.site URL captures raw signed bodies and headers. They are
  verified locally as they arrive (including the signature timestamp), correlated
  to this run, limited to 50 requests, and deleted during cleanup. No owner
  credentials or API key are sent to the catcher.
- **camera-share:** two generated camera/voice guests and at least two minutes
  of actual Chromium tab capture. Browser-only fixture instrumentation supplies
  three camera send encodings (`q`, `h`, `f`); this does not claim the SDK enables
  simulcast by default. Before limiting, WebRTC stats must show all three moving.
  The optional sender limit uses `setParameters`: 80 kbps, low RID active, upper
  RIDs paused. Stats must show low-layer frames still advancing, upper-layer
  frames stopped, and the receiving camera's resolution falling. This is a
  deterministic sender limit, not a claim about CDP network emulation or a
  natural congestion-control decision. The Recording contains the switch.
  The receiving guest must decode multiple frames in every ten-second window
  throughout the two-minute hold; elapsed time alone cannot pass the proof.
- **export:** successful completion, MP4 download, ffprobe video/audio/duration,
  four evenly spaced frames in a 2-by-2 contact sheet, and Export wall time.
- **recording-rejoin:** two camera/tone guests record for 25 seconds, then guest B's
  browser closes without an SDK leave and rejoins using the same admitted participant.
  Both record for another 25 seconds. Three MP4 frames per before/after window must
  contain each guest's phase-specific background and advancing picture. Three
  three-second audio samples per window must contain each guest's distinct tone
  (440/880 Hz, above -45 dBFS), not just mixed audio energy. The export clock is
  end-aligned; phase colors reject sampling the wrong window. The two-wide contact
  sheet pairs before/after samples. Private timeline and per-guest evidence are
  saved even when media checks fail. This is a standalone proof, not part of `all`.
- **transcript:** on-demand completion and the generated phrases in the document.

Default `all` shares one camera/share Recording across the related proofs.
Standalone Export, Transcript, and smoke create a shorter fresh Recording.
`--no-layer-switch` explicitly skips the limit in `all`; do not use it when a
release requires forced-switch evidence. Exit zero means every requested proof
and cleanup passed. A failed Export does not prevent independent Transcript proofs in `all`.

## Evidence

`.private/prod-proof/<run>/report.json` contains each result. It also holds policy
snapshots, WebRTC stats, the limit and switch evidence, signed event summaries,
MP4, ffprobe output, four frames/contact sheet, Transcript document, and Transcript timing. Keep this directory private; do not attach raw files to a public
PR. The command prints phase results and the absolute local artifact path.
Review the contact sheet as one image. Remove local artifacts after the release
handoff; they contain production identifiers but no saved owner credentials.
