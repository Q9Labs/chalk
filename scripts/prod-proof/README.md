# Real-call proofs

`pnpm prod:proof` runs all release proofs, including a forced camera layer switch.
It never signs up or deletes an account. Reuse the permanent Tenant in the
1Password `dev` vault, item **Chalk production proof Tenant**.

```sh
pnpm install --frozen-lockfile
pnpm --filter @q9labsai/chalk-client exec playwright install chromium
pnpm prod:proof
pnpm prod:proof smoke
pnpm prod:proof camera-share --force-layer-switch
pnpm prod:proof camera-share # simulcast + share, without the optional limit
pnpm prod:proof export
pnpm prod:proof transcript
pnpm prod:proof reset
```

Install `op` (local configuration only), FFmpeg (`ffmpeg`/`ffprobe`), and ImageMagick (`magick`).
Signed webhook proofs use a temporary Webhook.site receiver. Voice generation uses macOS `say` (Samantha), or Linux `espeak`.
No new JavaScript dependencies are needed; Playwright and esbuild come from the
client SDK workspace. Run from the repository root. Headless Chromium only.

## Configuration and ownership

By default, the local command reads the 1Password Login item named above. It holds
`username`, `password`, `tenant_id`, `api_url`, `web_url`, `proof_origin`,
`inbox_url`, `inbox_password`, `inbox_account_id`, and `webhook_service_url`
(Webhook.site). Identifiers and credentials are loaded at runtime, not checked in.
The API's `/readyz` response must report both Recording and Transcription as
`enabled`. This uses the running API's capability flags; no AWS access is needed.
The old item's AWS fields can remain but are no longer read.

Set `CHALK_PROOF_CONFIG_SOURCE=env` to read those same fields from environment
variables instead. Each field maps to `CHALK_PROOF_` plus its uppercase name;
for example, `api_url` maps to `CHALK_PROOF_API_URL`. Missing required fields fail
before login; `inbox_account_id` is optional, and `webhook_service_url` is required
for smoke's signed webhooks. Local runs still default to 1Password.

### GitHub Actions

`real-call-proof.yml` accepts an environment through manual dispatch or
`workflow_call`; the daily 04:23 UTC schedule selects `production`. A caller uses
`./.github/workflows/real-call-proof.yml` with `environment: nightly` (or
`production`) and grants `contents: read`. The job reads its own environment's
secrets, so callers do not need to pass secrets. No Release workflow is changed.
Runs for the same environment queue without cancelling an active call.

Create these separately in **each** GitHub environment (`production`, `nightly`):

- Secrets: `CHALK_PROOF_USERNAME`, `CHALK_PROOF_PASSWORD`,
  `CHALK_PROOF_INBOX_PASSWORD`.
- Variables: `CHALK_PROOF_TENANT_ID`, `CHALK_PROOF_API_URL`,
  `CHALK_PROOF_WEB_URL`, `CHALK_PROOF_PROOF_ORIGIN`, `CHALK_PROOF_INBOX_URL`,
  `CHALK_PROOF_WEBHOOK_SERVICE_URL`, `CHALK_PROOF_EVIDENCE_RECIPIENT`.
- Optional variable: `CHALK_PROOF_INBOX_ACCOUNT_ID` (not used by smoke).

Use that environment's permanent Tenant and owner, inbox, API/web URLs, and
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

Provision the permanent owner through the product registration flow and create
its Tenant through the normal Tenant creation endpoint. Store inbox credentials
before registration so a failed setup can be recovered. Allow `proof_origin` in
that Tenant's CORS origins once; the command does not change Tenant settings.
Use a loopback HTTP origin with a fixed available port. One run per origin at a
time; another lane or machine may use a different configured origin.

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
retention policy. The permanent owner, Tenant, inbox, and password are retained.
The reset proof only checks arrival of a new email; it does not consume the token.

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
- **reset:** a new reset email arrives for the permanent owner within two minutes.

Default `all` shares one camera/share Recording across the related proofs.
Standalone Export, Transcript, and smoke create a shorter fresh Recording.
`--no-layer-switch` explicitly skips the limit in `all`; do not use it when a
release requires forced-switch evidence. Exit zero means every requested proof
and cleanup passed. A failed Export does not prevent independent Transcript or
reset proofs in `all`.

## Evidence

`.private/prod-proof/<run>/report.json` contains each result. It also holds policy
snapshots, WebRTC stats, the limit and switch evidence, signed event summaries,
MP4, ffprobe output, four frames/contact sheet, Transcript document, and reset
arrival timing. Keep this directory private; do not attach raw files to a public
PR. The command prints phase results and the absolute local artifact path.
Review the contact sheet as one image. Remove local artifacts after the release
handoff; they contain production identifiers but no saved owner credentials.
