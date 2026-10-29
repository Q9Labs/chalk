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
pnpm prod:proof recording-rejoin
pnpm prod:proof transcript
```

Install `op` (local configuration only), FFmpeg (`ffmpeg`/`ffprobe`), and ImageMagick (`magick`).
Signed webhook proofs use a temporary Webhook.site receiver. Voice generation uses macOS `say` (Samantha), or Linux `espeak`.
No new JavaScript dependencies are needed; Playwright and esbuild come from the
client SDK workspace. Run from the repository root. Headless Chromium only.

## Configuration and ownership

By default, the local command reads the 1Password item `Chalk production proof Tenant`. It holds
`api_key`, `tenant_id`, `api_url`, `web_url`, `proof_origin`,
`webhook_service_url` (Webhook.site), and `webhook_endpoint_id`.
Identifiers and credentials are loaded at runtime, not checked in.
The API's `/readyz` response must report both Recording and Transcription as
`enabled`. This uses the running API's capability flags; no AWS access is needed.
The old item's AWS fields can remain but are no longer read.

Set `CHALK_PROOF_CONFIG_SOURCE=env` to read those same fields from environment
variables instead. Each field maps to `CHALK_PROOF_` plus its uppercase name;
for example, `api_url` maps to `CHALK_PROOF_API_URL`. Missing required fields fail
before creating resources. Redacted or wrong-namespace API keys fail before any
HTTP request. Local runs still default to 1Password.

### One-time webhook setup (each environment)

Using the existing bootstrap key, create **one** disabled endpoint named after
this proof. Do not run this setup before each proof. Inject the configuration
variables above, then run:

```sh
node --input-type=module <<'JS'
import { randomUUID } from "node:crypto";
const e = process.env;
const response = await fetch(new URL(`/v1/tenants/${e.CHALK_PROOF_TENANT_ID}/webhook-endpoints`, e.CHALK_PROOF_API_URL), {
  method: "POST",
  headers: { Authorization: `Bearer ${e.CHALK_PROOF_API_KEY}`, Origin: e.CHALK_PROOF_WEB_URL, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ name: "Chalk real-call proof", url: e.CHALK_PROOF_WEBHOOK_SERVICE_URL, enabled: false, api_version: 1, event_types: ["episode.started", "episode.ended", "recording.started", "recording.completed", "transcript.completed"] }),
});
if (!response.ok) throw new Error(`Endpoint setup failed: HTTP ${response.status}`);
console.log((await response.json()).id);
JS
```

Record only the returned non-secret ID as `webhook_endpoint_id` in local proof
configuration and `CHALK_PROOF_WEBHOOK_ENDPOINT_ID` in that GitHub environment.
Setup undo is DELETE `/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}`
with `If-Match: "<revision>"` and an idempotency key. With a write-only bootstrap,
POST `rotate-secret` with `revoke_previous_immediately: true` to obtain the current
revision first. Do not remove pre-existing endpoints as part of proof setup.

### GitHub Actions

`.github/workflows/real-call-proof.yml` accepts an environment through manual dispatch or
`workflow_call`, and a timer runs it on production every day at 05:41 UTC. A failed timer run
posts its run link to the production alerts Discord channel (`CHALK_ALERTS_DISCORD_WEBHOOK_URL`
in the `production` environment). A caller uses
`./.github/workflows/real-call-proof.yml` with `environment: nightly` (or
`production`) and grants `contents: read`. The job reads its own environment's
secrets. Reusable callers must also satisfy the declared secret contract using
explicit forwarding or `secrets: inherit` (example below). No Release workflow is changed.
Both triggers accept a space-separated `proofs` string (default `smoke transcript`).
The reusable workflow exposes `result` (`passed` or `failed`); a failed job still fails
the caller. `result` may be absent on cancellation or runner loss. Callers must
fail closed: require job success **and** `result == 'passed'` (as promote does).
Runs for the same environment queue in order (`queue: max`), so no run cancels another.

Create these separately in **each** GitHub environment (`production`, `nightly`):

- Secret: `CHALK_PROOF_API_KEY`.
- Variables: `CHALK_PROOF_TENANT_ID`, `CHALK_PROOF_API_URL`,
  `CHALK_PROOF_WEB_URL`, `CHALK_PROOF_PROOF_ORIGIN`,
  `CHALK_PROOF_WEBHOOK_SERVICE_URL`, `CHALK_PROOF_WEBHOOK_ENDPOINT_ID`,
  `CHALK_PROOF_EVIDENCE_RECIPIENT`.

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
- `transcriptions:delete`, `webhooks:write` for cleanup and signed webhook proofs.

The short-lived key has only the seven Space, Episode, and artifact scopes above.
The runner checks that it cannot read Tenant administration, then verifies a 401
after revocation. The bootstrap key never needs Tenant management, membership,
signing-key management, account permissions, or API-key/webhook inventory scopes.
One-time endpoint removal additionally requires `webhooks:delete`.

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

Export completion has a fourteen-minute limit: ten minutes for a scale-to-zero
render worker to start (the fleet controller's default startup limit), plus four
minutes for processing. Failed or unavailable Exports still fail immediately;
pending jobs cannot wait indefinitely. The offline export regression replays a
successful 246.610-second cold-start Export that exceeded the old four-minute
limit. It runs in Gate's required `self-test` lane and `pnpm test`.

## Cancellation and recovery

Each invocation uses a unique run ID (`CHALK_PROOF_RUN_ID` overrides the generated
ID, 1–51 letters, digits, underscores or hyphens). Keys expire after 55 minutes.
Keys and Spaces use `chalk-proof:<run-id>` names; Space and Episode metadata hold
`proof_run_id`. Each environment reuses one operator-provisioned webhook endpoint.
Transcripts are owned through their labeled Space and Episode.

Recover a canceled invocation using its private local ownership file:

```sh
pnpm prod:proof cleanup <run-id>
```

Cleanup uses the bootstrap key and fresh bounded requests, revokes the saved run
key first, ends Episodes, archives Spaces, and deletes Transcripts, webhook
catchers, and disables the permanent endpoint. Ownership is published atomically
with a same-directory temporary file and rename, preserving the key when adding
the catcher. Normal cleanup uses in-memory IDs too. A corrupt file is reported,
but independent Space/Episode cleanup and configured-endpoint disabling still run.
The workflow's `always()` step uses this file even on cancellation.
It is safe to repeat. No API-key or webhook inventory scope is required.

Before each proof, the sweep lists Spaces and their Episodes only. It ends
proof-labelled Episodes older than two hours and archives their Spaces, never
archiving a Space containing a fresh or foreign Episode. Run keys expire within
55 minutes and need no sweep. An owned empty Space is archived once the Space itself
is older than two hours; fresh Spaces and Spaces with fresh or foreign Episodes
are preserved. Every run immediately revokes the previous webhook secret through
`rotate-secret`, then PATCHes the same endpoint to its catcher URL and enables it.
Rotation supplies the PATCH revision without a read scope. Cleanup rotates again
to recover the current revision and PATCHes `enabled: false`; it never deletes or
creates an endpoint. A lost runner can leave that single endpoint enabled at a
dead catcher; the next invocation rotates and re-points it, without consuming
another endpoint slot. Proofs for an environment must not overlap, including
manual/local runs; workflow concurrency serializes hosted runs.
A key-creation response lost before its ID is saved still leaves a key until its
55-minute expiry. The next proof recovers live Episodes, the leftovers that keep
recorder machines running. Product retention still applies to ended/archived
history and Recordings. A catcher whose creation response is lost cannot be
discovered through Chalk's API.

Reusable callers must forward the declared secret explicitly:

```yaml
jobs:
  proof:
    uses: ./.github/workflows/real-call-proof.yml
    with:
      environment: nightly
      proofs: smoke transcript
    secrets:
      CHALK_PROOF_API_KEY: ${{ secrets.CHALK_PROOF_API_KEY }}
```

`secrets: inherit` is also supported (including the promote workflow). Configure
the environment variables and evidence recipient in the selected environment.
Every workflow invocation generates a UUID suffix for its encrypted evidence
artifact; a first proof and rollback proof retain separate artifacts.
Public logs contain fixed phases/statuses and bounded error classes only. Raw
errors stay in private evidence, encrypted before upload. Dynamically received
API, webhook and guest access credentials are registered with GitHub masking.

### Time and failure bounds

Capture readiness and source finalization each allow three minutes. Export, audio
preparation, and transcript completion each allow four minutes. Episode shutdown
allows two minutes, and signed-event delivery allows three minutes. These replace
the old 15/20-minute waits; the default smoke/transcript pair has 35 minutes 40 seconds
of nominal sequential polling and fixture waits, before setup, request overhead, downloads, and cleanup. The `all` command allows
29 minutes 45 seconds of nominal polling and fixture waits.
The complete proof step is capped at 40 minutes, inside a 50-minute job. Each
run key lasts 55 minutes, and the stale sweep waits two hours. Cleanup treats
`409 api_key.inactive` as already revoked.

Local disposal has a 15-second deadline per resource. After a deadline or disposal
failure, cleanup kills the Chromium process group, closes server connections, or
aborts the collector, then writes failure evidence and continues cleanup. Public
failures expose only allowlisted reason codes and API status/code pairs; raw
messages and stacks remain in the private encrypted evidence.
