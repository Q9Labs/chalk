# Real-call proofs

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
pnpm prod:proof transcript
```

Install `op` (local configuration only), FFmpeg (`ffmpeg`/`ffprobe`), and ImageMagick (`magick`).
Signed webhook proofs use a temporary Webhook.site receiver. Voice generation uses macOS `say` (Samantha), or Linux `espeak`.
No new JavaScript dependencies are needed; Playwright and esbuild come from the
client SDK workspace. Run from the repository root. Headless Chromium only.

## Configuration and ownership

By default, the local command reads the 1Password item `Chalk production proof Tenant`. It holds
`api_key`, `tenant_id`, `api_url`, `web_url`, `proof_origin`,
and `webhook_service_url`
(Webhook.site). Identifiers and credentials are loaded at runtime, not checked in.
The API's `/readyz` response must report both Recording and Transcription as
`enabled`. This uses the running API's capability flags; no AWS access is needed.
The old item's AWS fields can remain but are no longer read.

Set `CHALK_PROOF_CONFIG_SOURCE=env` to read those same fields from environment
variables instead. Each field maps to `CHALK_PROOF_` plus its uppercase name;
for example, `api_url` maps to `CHALK_PROOF_API_URL`. Missing required fields fail
before creating resources. Local runs still default to 1Password.

### GitHub Actions

`real-call-proof.yml` accepts an environment through manual dispatch or
`workflow_call`; the daily 04:23 UTC schedule selects `production`. A caller uses
`./.github/workflows/real-call-proof.yml` with `environment: nightly` (or
`production`) and grants `contents: read`. The job reads its own environment's
secrets, so callers do not need to pass secrets. No Release workflow is changed.
Both triggers accept a space-separated `proofs` string (default `smoke transcript`).
The reusable workflow exposes `result` (`passed` or `failed`); a failed job still fails
the caller. Runs for the same environment queue without cancelling an active call.

Create these separately in **each** GitHub environment (`production`, `nightly`):

- Secret: `CHALK_PROOF_API_KEY`.
- Variables: `CHALK_PROOF_TENANT_ID`, `CHALK_PROOF_API_URL`,
  `CHALK_PROOF_WEB_URL`, `CHALK_PROOF_PROOF_ORIGIN`,
  `CHALK_PROOF_WEBHOOK_SERVICE_URL`, `CHALK_PROOF_EVIDENCE_RECIPIENT`.

Use that environment's permanent Tenant and scoped API key, API/web URLs, and
allowed loopback proof origin. Do not reuse the production Tenant for nightly.
For unattended runs, the selected GitHub environment must allow the workflow's
ref without a human approval. The command runs on Ubuntu with Chromium, FFmpeg,
ImageMagick, and espeak. The workflow adapts Ubuntu's ImageMagick 6 commands to
the `magick` entry point expected locally.

The job preserves the proof's nonzero exit status and uploads
the proof evidence folder even after failure, encrypted with `age` before upload,
with three-day retention. Set `CHALK_PROOF_EVIDENCE_RECIPIENT` to an age public
recipient (`age1...`); keep the matching private identity outside GitHub. Public
repository artifacts are publicly downloadable, so raw evidence is never uploaded.
The recipient is validated before the call. To read a downloaded artifact locally:

```sh
age --decrypt --identity /absolute/path/to/private-identity.txt evidence.tar.gz.age | tar -xz
```

The decrypted folder contains environment identifiers and call evidence. Keep it
private; never copy raw files to a public PR or issue.

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
