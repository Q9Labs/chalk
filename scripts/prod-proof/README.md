# Real-call proofs

`pnpm prod:proof [plan...]` runs release proofs against a deployed environment with real headless Chromium guests. The plans, their media planes and flags are in `registry.json` (`pnpm prod:proof --help` lists them), and `index.mjs` holds the code that runs them; the other entry points are the `prod:*` scripts in the root `package.json` (`prod:canary`, `prod:fleet`, `prod:sfu-e2e`, `prod:latency`, `prod:sfu-classes`, `prod:proof:compare-leave`). The dashboard-specific shared-browser owner flow is covered by the `dashboard-engine` Gate lane, not here.

```sh
pnpm install --frozen-lockfile
pnpm --filter @q9labsai/chalk-client exec playwright install chromium
pnpm prod:proof                              # all release proofs, including a forced camera layer switch
pnpm prod:proof smoke
pnpm prod:proof camera-share --force-layer-switch
CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:proof call-artifacts
pnpm prod:proof chat-upload                  # Node only: a chat upload from an origin on no list, through the storage bucket's CORS rule
```

Run from the repository root. You need `op` (local configuration only), FFmpeg (`ffmpeg`, `ffprobe`), ImageMagick (`magick`), and macOS `say` or Linux `espeak` for generated voices. Playwright and esbuild come from the client SDK workspace.

## Shared state and when proofs overlap

- **One live Episode per Space.** A proof Space is reused across runs. Before it creates an Episode in a reused Space, every proof ends a live Episode whose `proof_run_id` names another run (the staging lease serialises proof runs, so that Episode is one a finished run's cleanup left). An Episode with no `proof_run_id` is never ended. If Create Episode still answers 409 `episode.capacity_exceeded`, the proof retries for 90 seconds, then fails with `proof-space-busy`.
- **The Capture pool is small and shared**, so one stale Capture job can block every Recording. Proofs that record read `GET /v1/tenants/{tenant_id}/recording-capture-pool` while waiting for Capture readiness; `call-artifacts` also reads it before creating its Space. When every slot is held and none is this proof's, it fails at once with `capture-slot-held`, and the private evidence names the job, Recording, Episode, claim time and lease expiry (slots of other Tenants are counted without identifiers). A pool scaled to zero counts as free only while no job holds a slot.
- Proofs for one environment must not overlap, including manual runs. The one exception is inside the nightly chalk*sfu run, which holds the staging lease once and runs `call-artifacts` (its own Space) beside `camera-share` and `long-call` (one shared Space, so one after the other); `scripts/staging-sfu/run-proofs` does this. Every proof serves its guests from a `proof_origin` that the Tenant allows by port, so two proofs that run at once need two allowed origins. `call-artifacts` uses `CHALK_PROOF_PROOF_ORIGIN_OWN` (a second loopback origin, allowed in the Tenant) when it is set; otherwise all the nightly proofs run one after another on `CHALK_PROOF_PROOF_ORIGIN`. A proof whose port is already in use fails with `proof-origin-busy`. The runner labels each proof's output but lets `::add-mask::` lines through unlabelled and replaces any other `chalk_sk*` value. Hosted runs are serialised by workflow concurrency (`queue: max`); take the staging lease (`scripts/staging-sfu/staging-lock`) for manual runs against staging.

## Configuration and ownership

By default the command reads the 1Password item `Chalk production proof Tenant` (`api_key`, `tenant_id`, `api_url`, `web_url`, `proof_origin`, `webhook_service_url`, `webhook_endpoint_id`). Set `CHALK_PROOF_CONFIG_SOURCE=env` to read the same fields from `CHALK_PROOF_<UPPERCASE NAME>` variables. Missing fields and redacted or wrong-namespace API keys fail before any resource exists. The API's `/readyz` must report Recording and Transcription as `enabled`.

An operator provides the Tenant and the bootstrap key; inject the key with `2password run` or your secret manager, never in an argument, file or browser response. Allow `proof_origin` (a loopback HTTP origin with a fixed free port) in the Tenant's CORS origins once. Configure the Tenant once with `transcription_ceiling: on_demand`, `transcription_default_mode: on_demand`, a nonempty `provider_policy_version` and a positive `transcription_source_window_seconds`; a disabled ceiling overrides the Space setting.

The bootstrap key needs exactly `api_keys:write`, `api_keys:delete`, `spaces:read`, `spaces:write`, `episodes:read`, `episodes:write`, `recordings:read`, `transcriptions:read`, `transcriptions:write`, `transcriptions:delete` and `webhooks:write`. Each run mints a short-lived key with only the Space, Episode and artifact scopes, checks it cannot read Tenant administration, and verifies a 401 after revocation. One-time endpoint removal also needs `webhooks:delete`.

Every run creates its own key, Space, Episode and Recording. There is no hard-delete API for Spaces, Episodes or Recordings, so ended history and Recording artifacts follow product retention. The Tenant and bootstrap key are kept.

### Media plane

The proof Space uses Cloudflare by default. The public API always refuses `media_plane: chalk_sfu`, so to run on the own SFU set `CHALK_PROOF_MEDIA_PLANE=chalk_sfu` and point at a Space an operator moved with `go run ./cmd/media-settings set` (`CHALK_CANARY_SPACE_ID`), or leave the plane out where the deployment gives new Spaces the own SFU (`CHALK_NEW_SPACE_MEDIA_PLANE`). The two-plane latency benchmark names its Spaces with `CHALK_PROOF_SPACE_ID_CF_SFU` and `CHALK_PROOF_SPACE_ID_CHALK_SFU` and stops at once when a Space is not on the plane it asked for. `call-artifacts` needs automatic Recording and Transcription, so it uses `CHALK_PROOF_SPACE_ID_<PLANE>_AUTOMATIC`. The older Recording, export and transcript proofs need Cloudflare: use `camera-share` for the own SFU's call alone and `call-artifacts` for its Recording and Transcript. `pnpm prod:proof own-sfu-spaces` finds or creates the two own-SFU proof Spaces by slug (`CHALK_PROOF_SPACE_BY_SLUG=true` makes proofs reuse them).

### Recovery times

`pnpm prod:recovery --environment staging --scenario <label> --start-cmd '<command>' [--hold-s N --end-cmd '<command>' --watch-s 90 --guest2-chromium <launcher>]` puts two guests in a live own-SFU call, runs the fault command, waits, runs the end command, and samples both pages every 100 ms. The report in the run's private directory holds, for each direction, whether audio and video were interrupted (a gap above 2 s), the seconds from the end and from the start of the fault until they returned, whether they never did, and the SDK connection statuses seen. The harness does nothing to the call after the fault, so a recovery is the product's own. Server faults (restarting the SFU, stopping the API) need only the command. Client network faults run on a Linux machine with root: `scripts/prod-proof/recovery-rig up` prints a launcher for `--guest2-chromium` that starts guest 2's Chromium in its own network namespace, and `blackout`, `restore` and `change` act on that namespace only. Take the staging lease around each run.

### One-time webhook endpoint (each environment)

Create one disabled endpoint with the bootstrap key. Do not repeat this before each proof.

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

Record the returned ID as `webhook_endpoint_id` locally and as `CHALK_PROOF_WEBHOOK_ENDPOINT_ID` in the GitHub environment. To undo, DELETE `/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}` with `If-Match: "<revision>"` and an idempotency key (with a write-only key, POST `rotate-secret` with `revoke_previous_immediately: true` first to get the revision). Never remove pre-existing endpoints.

## What each proof must show

- **Audio is decoded, not just received.** `inbound-rtp` bytes keep growing for silence, garbage and audio that headless Chromium never plays out, so a byte counter cannot judge audio. `audio-decode.mjs` has guest _n_ publish a WebAudio tone and every other guest analyse the remote track with an `AnalyserNode`; thresholds are `decodeCriteria`. A microphone turned back on is a re-publish, and bytes can keep advancing while a listener's receiver is dead, so proofs that re-publish one make every other guest decode the tone again within 5 seconds of the click (`hearAfterUnmute`). Speech proofs have no tone, so they pass on band energy instead.
- **smoke:** API key, Space, Episode, two live guests, Recording, signed lifecycle webhooks correlated to this run, successful Export and MP4 download. A temporary Webhook.site URL captures raw signed bodies; they are verified locally on arrival, limited to 50 requests and deleted in cleanup, and no owner credential goes to the catcher.
- **camera-share:** two generated camera and voice guests and at least two minutes of Chromium tab capture. Fixture instrumentation supplies three send encodings; this does not claim the SDK enables simulcast by default. The optional sender limit (`setParameters`, 80 kbps, low layer active) must stop upper-layer frames and lower the receiving resolution while low-layer frames keep advancing. It is a deterministic sender limit, not a claim about network emulation or congestion control. The receiver must decode frames in every ten-second window of the hold, so elapsed time alone cannot pass.
- **export, transcript:** Export completes (fourteen-minute limit: ten for a scale-to-zero render worker to start, four for processing) with a downloadable MP4 that ffprobe finds video, audio and duration in, plus a four-frame contact sheet. Transcript completes on demand and contains the generated phrases.
- **recording-rejoin:** a standalone proof, not part of `all`. Two guests record, guest B's browser closes without an SDK leave and rejoins as the same admitted participant, and the Recording must show each guest's phase-specific background, advancing picture and distinct tone before and after.
- **leave:** the candidate and the published 5.2.6 client on the same host and backend. Five baseline samples are compared with five ordinary and five publications-403 candidate samples, and the old client's premature peer close is reproduced independently. The comparison session (`pnpm prod:proof:compare-leave`) runs the old SDK against the live production backend and the candidate against staging. Set `CHALK_PROOF_EXPECTED_PRODUCTION_SHA` (the full SHA production's release manifest reports) as a direct process variable, and production's `CHALK_PROOF_*` mapping as JSON in `CHALK_PROOF_BASELINE_ENV`, with credentials injected only at runtime. Promote requires that session's captured median and encrypted evidence hash. Protocol acknowledgements and real SFU cleanup are never mocked.
- **leave-own-sfu:** two guests on the own SFU, one leaves. The Sync acknowledgement must beat the SDK's deadline, the leaver's tracks must end, and the other guest must drop the leaver while keeping its own capture and the Episode alive.
- **long-call:** one call of three guests held across media-access refreshes. Short proofs never outlive a grant, so a bug that appears only when the SDK renews access (`access.invalid`, a microphone that stops publishing while the UI shows it on) passes them. The criteria and numbers are in `long-call-criteria.mjs`, whose test fails if the API or SDK grant constants move. It is a gate, not a measurement, so it has no scorecard metric or budget. `--dry-run` prints the plan. The nightly runs it on `chalk_sfu` inside the staging lease; for staging by hand run `scripts/staging-sfu/staging-lock --holder <you> --purpose long-call --run-id <id> --wait 600 -- pnpm prod:proof long-call`.
- **call-artifacts:** three guests with distinct camera colours play a scripted call (constants and checks in `call-script.mjs`, playback in `call-play.mjs`) on a Space with automatic Recording and Transcription. The script includes shared-clock marker tones with white flashes, a mute, a screen share and a host stop; the Recording must contain it. Checks include per-guest tile liveness, per-guest tone and speech, the longest silence, A/V sync, end times against the 15-second source-lease bound in `docs/plans/sfu-design.md`, a non-empty Transcript with words from every guest, and an `available` Recording source. Optional operator commands: `CHALK_PROOF_CAPTURE_RESTART_COMMAND` restarts a capture node mid-call (the nodes belong to the fleet controller, not the proof's Tenant), and `CHALK_PROOF_RECORDER_TRACKS_COMMAND` fetches each guest's decrypted recorder track so a lost marker is attributed to capture or to the mixer (without it the proof judges the mix alone). `CHALK_PROOF_TRANSCRIBE=false` skips the Transcript to save provider credit; the proof then sets `on_demand` only while it creates the Episode and restores `automatic` at once. Known limit: the tile check attributes a tile by the fixture camera's flat colour, so it does not work for real camera pictures.

Default `all` shares one camera and share Recording across the related proofs. Standalone Export, Transcript and smoke create a shorter fresh Recording. `--no-layer-switch` skips the limit in `all`; do not use it when a release requires forced-switch evidence. Exit zero means every requested proof and cleanup passed. A failed Export does not stop independent Transcript proofs in `all`.

### Manual hosted integrator proof

Run it alone, and finish and clean it up before any other browser proof. With the same configuration as `pnpm prod:proof`:

```sh
node scripts/prod-proof/integrator.mjs
```

1. Open the printed `/guest1` and `/guest2` URLs in separate browser profiles, allow microphone and camera in both, and use an HTTP `127.0.0.1` proof origin with an explicit port.
2. Click both Join buttons promptly once enabled. The server creates the shared Episode lazily on the first `getAccess`, because the empty-Episode linger (three minutes) would otherwise expire while browsers are prepared.
3. Keep both clients live for more than seven minutes. Inspect `window.proofHistory`, `window.proofAccessCalls`, `window.proofConnections` and `window.proofClient.getSnapshot()`. Require live media and Sync after both original grants expire, a successful scheduled refresh of both, increasing bidirectional audio and video RTP counters, bidirectional chat and zero automatic connection reports. Save sanitized evidence in the printed private directory, including `window.proofJoinedAt`.
4. End for everyone with `await window.proofClient.endEpisode()`. Both clients must observe the end and the backend must confirm completion. Cleanup is not proof that SDK end-for-everyone worked.
5. Press Ctrl-C to end any remaining owned Episode, archive the Space, revoke the key and stop the server. If interrupted, use the cleanup command below.

## Action latency

`pnpm prod:latency` times what a person in a call waits for, on the own SFU (`chalk_sfu`) and Cloudflare (`cf_sfu`), with the same client on the same network. Each cycle is a new Space and Episode with two headless guests: guest 1 acts, guest 2 watches. The planes take turns so a slow minute lands on both.

```sh
pnpm prod:latency --environment staging --region do-sgp1 --size s-4vcpu-8gb
pnpm prod:latency --environment staging --samples 3 --planes chalk_sfu
```

- Both guests run on one host and stamp times with `performance.timeOrigin + performance.now()`, so sender and receiver times compare directly. Each watch polls the SDK snapshot and WebRTC stats every 10 ms; a video frame counts when decoded and an audio frame when an RTP packet arrives. [`features/scorecard/schema.mjs`](../../features/scorecard/schema.mjs) lists every metric and what it times.
- Spin-up is the API create time plus the first admit time plus the first guest's `join()` until live with a connected peer connection. The browser launch is left out because the API does the media plane's Episode and join work inside admit.
- `--lobby-dwell-ms N` makes the second guest call `preconnect()` and wait N ms before its join timer starts, like a person in a lobby, so `join.prepare` and `join.sync_connect` read 0. Sync closes a socket with no hello within 5 s, so `preconnect` replaces an unused socket every 4 s for the dwell. Compare runs only with the same setting.
- `--path <mode>` forces how the second guest reaches the SFU, to price each way in: `direct` (default), `relay-udp`, `relay-tcp`, `relay-tls` (TURN over TLS, port 443 when offered), `blocked-no-relay` (no UDP and no TURN server; the join is expected to fail and the cycle records `joined: false` and timed-out join metrics) and `blocked-relay-tls` (no UDP, TURN over TLS). Relay modes rewrite the guest's ICE servers and set `iceTransportPolicy: relay` in the page; blocked modes launch Chromium with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. Only guest 2 takes the path, so the join metrics and every `action.*` metric include the forced leg on the receiving side; the sender stays direct. Compare runs of one path with a `direct` run from the same host, because the card has no field for the path.
- A cycle is dropped and rerun when admission lands on the other plane (`wrong_media_plane`, for example when a full own SFU falls back to Cloudflare), fails (`cycle_failed`) or cannot end its Episode (`teardown_failed`). A watch that sees nothing in 20 seconds is a `timeout`.
- It writes a private report and one `scorecard-<plane>.json` per plane in the public `chalk.scorecard/v1` shape (no hosts, IPs, URLs or Tenant or Space IDs). It fails on a p95 over the `action.*` budgets in [`perf/budgets.json`](../../perf/budgets.json), on any timeout, or when a plane has fewer kept cycles than `--samples`.
- Diagnostics (round trips, one-way audio estimate, selected ICE pair, stage timings from a wire trace that only this kit installs) go to the sidecar `latency-diagnostics-<plane>.json`, never into a card, budget or verdict. See [Latency diagnostics](../../features/scorecard/README.md#latency-diagnostics).

## Canary and fleet

`pnpm prod:canary` proves the thresholds with two guests at a time. `pnpm prod:fleet` is the volume half of the canary exit: scripted joins and fault trials pass, plus at least 200 calls and 50 call-hours with no P1. It runs many 2-to-6-guest calls in parallel on one machine, each a new Episode with real SDK clients and generated media, working through a shuffled script of mutes, camera toggles, screen shares, rejoins and holds. Fractions and limits are flags of `fleet.mjs`.

- **Joins are reported twice.** `summary.join` ends on the first 500 ms stats poll that sees growing audio and video at both guests (rounded up by up to one poll) and is the number to compare with old runs. `summary.joinEvent` (`render-probe.mjs`) ends on the last guest's first presented frame and first received audio packet.
- **Faults are fleet-wide**, because every call on the machine shares its media path. At each interval the fleet waits for all running calls to reach a checkpoint, runs `CHALK_CANARY_FAULT_DOWN`, holds, has every call prove its camera stalled, runs `CHALK_CANARY_FAULT_UP` and times each call's recovery. Without both commands the run refuses to start; `--fault-interval-seconds 0` turns faults off. The commands need root; the example blocks outgoing UDP except DNS, which stops media without naming a node address.
- **A P1** prints as `P1 <reason> <call>`. The reasons are in `fleet-criteria.mjs`: slow or missing join rendering, slow or missing recovery after a fault, a muted microphone or disabled camera still reaching others (`mute_leak`), fault recovery re-enabling muted media (`consent_reenabled`), and media or roster crossing calls (`cross_tenant`, the closest check one Tenant allows). Other findings fail the run without being a P1.
- **Load decides capacity.** Each finding carries the load per core, and the fleet starts no new call above `--max-load`. Add machines, not concurrency, when load stays high. On a 4 vCPU Instabox machine a guest cost about 0.2 vCPU; larger-machine scale is unmeasured.
- **The fleet never picks a target.** `--allow-host` names the API host a run may use and must match the proof configuration, so a configuration pointing at production fails unless named on purpose. It stops starting calls at the first P1 unless `--no-stop-on-p1`, and writes a summary and a calls file under `.private/prod-proof/<run>/`. Runs on several machines merge with `pnpm prod:fleet --merge <calls files>`; `--dry-run` exercises the scheduler without an API or browsers.

```sh
CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_MEDIA_PLANE=chalk_sfu \
  CHALK_CANARY_FAULT_DOWN='iptables -I OUTPUT -p udp ! --dport 53 -j DROP' \
  CHALK_CANARY_FAULT_UP='iptables -D OUTPUT -p udp ! --dport 53 -j DROP' \
  pnpm prod:fleet --allow-host <api host> --concurrency 6
```

## GitHub Actions

`.github/workflows/real-call-proof.yml` runs by manual dispatch, `workflow_call`, and a daily timer on production (05:41 UTC). A failed timer run posts its link to the production alerts Discord channel. Both triggers take a space-separated `proofs` string (default `smoke transcript`). The workflow exposes `result` (`passed` or `failed`); it may be absent on cancellation or runner loss, so callers must fail closed: require job success and `result == 'passed'`, as promote does. Callers use `./.github/workflows/real-call-proof.yml` with `environment: nightly` (or `production`), grant `contents: read`, and forward the secret explicitly or use `secrets: inherit`:

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

Define these in each GitHub environment (`production`, `nightly`), using that environment's own Tenant, never production's for nightly: secret `CHALK_PROOF_API_KEY`; variables `CHALK_PROOF_TENANT_ID`, `CHALK_PROOF_API_URL`, `CHALK_PROOF_WEB_URL`, `CHALK_PROOF_PROOF_ORIGIN` (and for the nightly `CHALK_PROOF_PROOF_ORIGIN_OWN`), `CHALK_PROOF_WEBHOOK_SERVICE_URL`, `CHALK_PROOF_WEBHOOK_ENDPOINT_ID`, `CHALK_PROOF_EVIDENCE_RECIPIENT`. For unattended runs the environment must allow the workflow's ref without human approval.

Public repository artifacts are publicly downloadable, so evidence is encrypted with `age` to the public recipient in `CHALK_PROOF_EVIDENCE_RECIPIENT` (`age1...`, validated before the call; keep the private identity outside GitHub), uploaded even after failure, with three-day retention. Public logs carry fixed phases, statuses and allowlisted reason codes only; raw errors stay in the encrypted evidence, and dynamic credentials are registered with GitHub masking. To read an artifact:

```sh
age --decrypt --identity /absolute/path/to/private-identity.txt evidence.tar.gz.age | tar -xz
```

The decrypted folder holds environment identifiers and call evidence. Keep it private and never copy raw files to a public PR or issue.

## Evidence

`.private/prod-proof/<run>/report.json` holds each result, with policy snapshots, WebRTC stats, signed event summaries, the MP4, ffprobe output, the contact sheet, Transcript document and timing. The command prints phase results and the absolute path. Review the contact sheet as one image. Remove local artifacts after the release handoff; they contain production identifiers but no saved owner credentials.

## Cancellation and recovery

Each invocation has a unique run ID (`CHALK_PROOF_RUN_ID` overrides it; 1 to 51 letters, digits, underscores or hyphens). Run keys expire after 55 minutes. Keys and Spaces are named `chalk-proof:<run-id>`, and Space and Episode metadata hold `proof_run_id`. Recover a cancelled invocation from its private local ownership file; the workflow's `always()` step does the same, and it is safe to repeat:

```sh
pnpm prod:proof cleanup <run-id>
```

Cleanup uses the bootstrap key: it revokes the saved run key first, ends Episodes, archives Spaces, deletes Transcripts and catchers, and disables the permanent endpoint only when this run's record shows it used that endpoint. A corrupt ownership file is reported, but Space and Episode cleanup still runs. Local disposal has a 15-second deadline per resource; after a deadline it kills the Chromium process group, closes server connections or aborts the collector, writes failure evidence and continues.

Judgment behind the design:

- The sweep before each proof lists Spaces and Episodes only. It ends proof-labelled Episodes older than two hours and archives their Spaces, never one holding a fresh or foreign Episode, because live Episodes are what keep recorder machines running. Run keys need no sweep.
- Each environment reuses one operator-provisioned webhook endpoint, because Chalk's API cannot discover a catcher whose creation response was lost. A run that exposes a webhook rotates the endpoint's secret (which also supplies the PATCH revision without a read scope), points it at its catcher and enables it; cleanup rotates again and PATCHes `enabled: false`, never deleting or creating an endpoint. A run that never exposed a webhook leaves the endpoint untouched, because rotating would break another run's signature verification. A lost runner can leave the endpoint enabled at a dead catcher; the next run re-points it.
- A key-creation response lost before its ID is saved still leaves a key until its 55-minute expiry. Cleanup treats `409 api_key.inactive` as already revoked.
- Gate's `proof-bundle` lane runs `sdk-bundle.test.mjs`, which bundles the proof entry against the current source and the real 5.2.6 package checked against its npm integrity; only the current client may import what 5.2.6 lacks (the lobby `preconnect` helper).
