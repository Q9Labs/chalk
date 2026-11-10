# Real-call proofs

`pnpm prod:proof` runs all release proofs, including a forced camera layer switch.
Every recording plan keeps both clients through scheduled credential refresh and
their original five-minute expiry, then checks received audio/video progress and
requires SDK end-for-everyone without a cleanup fallback. The dashboard-specific
shared-browser owner flow is independently required by the `dashboard-engine` Gate lane.

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
CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:proof call-artifacts # three guests, scripted call, automatic Recording and Transcript (about 2 minutes of call; CHALK_PROOF_CAPTURE_RESTART_COMMAND adds a capture-node restart)
pnpm prod:proof leave
pnpm prod:proof offreason # Node only: no browser, media, or ffmpeg
pnpm prod:proof:compare-leave # staging plus an in-memory production baseline config
```

Install `op` (local configuration only), FFmpeg (`ffmpeg`/`ffprobe`), and ImageMagick (`magick`).
Signed webhook proofs use a temporary Webhook.site receiver. Voice generation uses macOS `say` (Samantha), or Linux `espeak`.
No new JavaScript dependencies are needed; Playwright and esbuild come from the
client SDK workspace. Run from the repository root. Automated proofs use headless Chromium.

The Capture pool is shared and small, so one stale Capture job can block every
Recording. Every proof that records reads
`GET /v1/tenants/{tenant_id}/recording-capture-pool` (the proof key's
`recordings:read` scope) while it waits for Capture readiness, after 25 seconds
and again at the 180-second timeout. `call-artifacts` (own SFU, automatic
Recording) also reads it before it creates the Space, so a held slot fails the
run before any call starts. When every slot is held and none belongs to this
proof's Recording, it fails at once with reason `capture-slot-held`. An idle
Capture node scaled to zero reports `slots_total` 0; that pool counts as free
only while no job holds a slot, so any held job still fails the check. The private evidence names the job,
Recording, Episode, claim time and lease expiry; slots held for other Tenants
are counted without identifiers. Otherwise it keeps waiting, and the timeout
message in the private evidence carries the pool readout or why it was
unavailable.

The Leave plan runs the integrity-verified published 5.2.6 client and the candidate
on the same host and backend. It compares five ordinary baseline samples with
five ordinary and five publications-403 candidate samples, and independently
reproduces the old client's premature peer close. It does not start recording.
The separate comparison session uses the currently deployed production backend
for the old SDK and staging for the candidate. Set
CHALK_PROOF_EXPECTED_PRODUCTION_SHA to the full SHA shown by production's
release.json; the comparison refuses to start if the live identity differs and
checks it again before and after measurement. Pass this separately as a direct
process environment variable, not inside CHALK_PROOF_BASELINE_ENV. Supply production's
CHALK*PROOF*\* environment mapping as JSON in CHALK_PROOF_BASELINE_ENV, with
credentials injected only at runtime. Promote requires that session's captured
median and encrypted evidence hash, and uses the captured median for its limit.
The [5.3.1 promote plan](../../docs/releases/5.3.1-promote-plan.md) defines the
relative latency gate and the controlled HTTP fault; protocol acknowledgements
and real SFU cleanup are never mocked. Private comparison and socket evidence
is retained for every sample. Hosted proof files remain in memory until encrypted.

## Action latency

`pnpm prod:latency` times what a person in a call waits for, on the own SFU
(`chalk_sfu`) and on Cloudflare (`cf_sfu`), with the same client on the same
network. Each cycle is a new Space and Episode on one plane with two headless
Chromium guests. Guest 1 acts and guest 2 watches. The planes take turns, so a
slow minute lands on both. The defaults are 20 kept cycles per plane, about
40 seconds each.

```sh
pnpm prod:latency --environment staging --region do-sgp1 --size s-4vcpu-8gb
pnpm prod:latency --environment staging --samples 3 --planes chalk_sfu
xvfb-run -a pnpm prod:latency --environment staging --headed
```

`--lobby-dwell-ms N` (0 to 15000, default 0) makes the second guest call `preconnect()` and wait N ms before its join
timer starts, the way a person waits in a lobby. The Sync socket opened then is already open when `join()` runs, so
`join.prepare` and `join.sync_connect` read 0. Without the flag the join starts cold. Compare runs only with the same
setting. Sync closes a socket that gets no hello within 5 s, so `preconnect` replaces an unused socket every 4 s for
`keepWarmMs` (the proof asks for N + 1 s); the join counts as adopting a socket only when its hello went out on a socket opened before the join started.
Use `--lobby-dwell-ms 10000` to see the keep-warm window: without it the socket from the first second is gone by the join
and `join.sync_connect` reads a full upgrade.

[`features/scorecard/schema.mjs`](../../features/scorecard/schema.mjs) lists every metric id and what it times. Each
watch runs in the receiver's page and polls the SDK snapshot and WebRTC stats
every 10 ms. A video frame counts when it is decoded, and an audio frame counts
when an RTP packet arrives. Both guests run on one host and stamp times with
`performance.timeOrigin + performance.now()`, so sender and receiver times
compare directly. Spin-up is the API create time plus the first admit time
plus the first guest's `join()` until it is live with a connected peer
connection. The browser launch in between is left out, because the API does
the media plane's Episode and join work inside admit.

A cycle is dropped and run again when its admission lands on the other plane
(`wrong_media_plane`, for example when a full own SFU falls back to
Cloudflare), when it fails (`cycle_failed`), or when it can't end the Episode
(`teardown_failed`). A watch that sees nothing within 20 seconds counts as a
`timeout`. The run writes every sample to a private latency report and one
`scorecard-<plane>.json` per plane, in the public `chalk.scorecard/v1` shape,
which `parseScorecard` validates. A scorecard has no hosts, IPs, URLs, Tenant
or Space ids. With the `action.*` budgets in [`perf/budgets.json`](../../perf/budgets.json) (keyed by plane, for example `chalk_sfu.action.leave_ms`),
the run fails on a p95 over budget, on any timeout, or when a plane has fewer
kept cycles than `--samples`.

Each cycle also records the runner's round trip to the SFU and to Sync (read from the SDK's own pings, with no probe traffic), a one-way audio estimate (`media.network_jitter_one_way_ms`: network plus jitter buffer, not mouth to ear), the selected ICE pair of the join (candidate types and check counters), and stage timings inside each action, from a wire trace that only this kit installs in the guests' pages (`latency-trace.mjs`, `latency-stages.mjs`). They go in the sidecar `latency-diagnostics-<plane>.json` beside the card, never in the card, a budget or a verdict: see [Latency diagnostics](../../features/scorecard/README.md#latency-diagnostics).

Other checks cover parts of the same journey:

| Check                                                                                   | What it times                                                                                              | Media plane                              | How it relates                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `firstCallMs` in `perf/budgets.json`                                                    | Cold navigation to one decoded on-screen camera and a visible Leave control, on loopback with fake media   | none: no signaling or network            | The web app's own render cost. `action.join.first_video_ms` is the network and media plane part that it leaves out.                                          |
| `interactionMs` in the same file                                                        | The worst Event Timing duration for trusted clicks                                                         | none                                     | Main-thread response to a click. The toggle metrics start where it ends, at the SDK call.                                                                    |
| Join startup proof (`.github/workflows/gate.yml`, `scripts/web-proof/join-startup.mjs`) | The failure and retry screens under loss and stalls, against a local Sync fixture                          | none: no media                           | Startup correctness under faults, not live latency.                                                                                                          |
| Leave plan (`pnpm prod:proof leave`)                                                    | The `leave()` median until the Sync acknowledgement, from five samples, against the published 5.2.6 client | the Space's plane, Cloudflare by default | `action.leave_ack_ms` uses the same acknowledgement probe (`leave-observation.mjs`), per plane with N samples. The plan keeps its relative gate for promote. |
| `publisher-leaves` in `pnpm prod:sfu-e2e`                                               | One sample of leave until the others drop the publisher                                                    | one plane per run                        | The same definition as `action.leave_ms`, as a pass or fail check.                                                                                           |

## Canary fleet

`pnpm prod:fleet` is the volume half of the M7 canary exit in
[`docs/sfu/milestones.md`](../../docs/sfu/milestones.md#m7--internal-canary-and-live-verification): scripted joins and
fault trials pass, plus at least 200 calls and 50 call-hours with no P1. `pnpm prod:canary` proves the thresholds with
two guests at a time; the fleet runs many 2-to-6-guest calls in parallel on one machine and counts what it ran.

`pnpm prod:canary` reports each join twice. `summary.join` ends on the first 500 ms stats poll that sees video and audio growing at both guests (the long-standing number, rounded up by up to one poll). `summary.joinEvent` (`render-probe.mjs`) ends on the last guest's first presented video frame (`requestVideoFrameCallback` on a hidden muted `<video>`) and first received audio packet (`unmute`), so the poll's delay is not in it. Compare new runs against old ones with `summary.join`.

Every call is a new Episode (in a new Space, or in one of the `--spaces` you list) with real SDK clients in headless
Chromium and generated camera and tones. A call joins its guests, then works through a shuffled script: a microphone
mute and unmute, usually a camera off and on, a screen share in `--screen-fraction` of the calls, a hard leave and
rejoin of one guest in `--rejoin-fraction` of them, and holds between them. Half of the calls end with one guest muted.
`--recording-fraction` of the calls use a Space with an automatic Recording and check afterwards that a Recording
source became available; it needs fresh Spaces, only one such call runs at a time, and it stays at 0 until the Capture pool is
known to be free.

Fault trials are fleet-wide, because every call on the machine shares its media path. Every `--fault-interval-seconds`
the fleet waits until all running calls reach a checkpoint, runs `CHALK_CANARY_FAULT_DOWN`, holds the fault for
`--fault-seconds`, has every call prove that its camera video stalled, runs `CHALK_CANARY_FAULT_UP`, and times how long
each call takes to render again. Each call in a pulse is one fault trial, and no call joins during a pulse. Without
the two commands the run refuses to start; `--fault-interval-seconds 0` turns faults off.

A P1 is one of these, printed as `P1 <reason> <call>` when it happens:

| Reason                  | What it means                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `join_over_limit`       | All guests rendered the others, but later than 10 s after the last guest's join call.                                               |
| `join_not_rendered`     | A guest could not join, or a guest did not render the others within 25 s.                                                           |
| `recovery_over_limit`   | After a fault, media rendered again later than 15 s after the path came back.                                                       |
| `recovery_not_rendered` | After a fault, media did not render again within 30 s.                                                                              |
| `mute_leak`             | A muted microphone's tone was still heard (or its byte rate kept going), or a disabled camera's frames kept reaching another guest. |
| `consent_reenabled`     | Fault recovery turned a muted microphone or a disabled camera back on, or media from it reached other guests.                       |
| `cross_tenant`          | A guest's roster or media included a participant outside its call.                                                                  |

`cross_tenant` is the closest check one Tenant allows: it catches media or roster entries that cross between calls of
the same fleet, not between two Tenants. Other findings (`audio_not_decoded` (a guest with its microphone on was not heard as its tone at another guest, though its bytes advanced; checked after the join, a microphone turn-on, a rejoin and each recovery, see `audio-decode.mjs`), `action_failed`, `detector_blind` (the mute check had nothing to compare against), `fault_not_stalled`, `recording_failed`, and
an errored call such as a failed admission or an Episode that did not end) fail the run without being a P1. A
join time includes a loaded generator: each finding carries the load per core, and the fleet starts no new call while
the load per core is above `--max-load` (0.85). Add machines, not concurrency, when it stays high.

The fleet never picks a target. `--allow-host` names the API host a run may use and must match the proof configuration, so a
configuration that points at production fails unless you named it on purpose. It reads `CHALK_PROOF_*` like every proof,
or a file with `--env-file`. It stops starting calls at the first P1 unless you pass `--no-stop-on-p1`, lets the running
calls end, and writes a summary file and a calls file under `.private/prod-proof/<run>/`. The summary has call
and call-hour counts, join and recovery percentiles, fault trials, findings by reason and `meetsVolumeExit`. Runs on
several machines are one result:

```sh
CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_MEDIA_PLANE=chalk_sfu \
  CHALK_CANARY_FAULT_DOWN='iptables -I OUTPUT -p udp ! --dport 53 -j DROP' \
  CHALK_CANARY_FAULT_UP='iptables -D OUTPUT -p udp ! --dport 53 -j DROP' \
  pnpm prod:fleet --allow-host <api host> --concurrency 6
pnpm prod:fleet --dry-run --calls 20 --call-hours 2   # no API and no browsers: scheduler and summary only
pnpm prod:fleet --merge machine-1/fleet-calls.json machine-2/fleet-calls.json
```

On Instabox, three concurrent three-guest calls measured a load of 0.4 to 0.65 per core on a 4 vCPU machine, so a guest costs
about 0.2 vCPU and a call of 4 guests about one. The camera is 640x360 (`--camera`) to keep that down. The fleet stops
starting calls above `--max-load`, so a machine that is too small runs fewer calls rather than failing. By that measure an
8 vCPU, 16 GiB machine ($0.068 an hour) should fit about 6 calls of 4 guests, and 50 call-hours would take about 8 hours of
wall time; that scale has not been measured. Take the staging lease (`scripts/staging-sfu/staging-lock`) before a run against staging, and release it
afterwards. Fault commands need root on the machine; the example blocks all outgoing UDP except DNS, which stops the media path without naming a node address.

## Manual hosted integrator proof

Run the integrator proof alone. Finish and clean it up before starting any other
browser proof. Do not run it in parallel with hosted join-fault, shared-browser
owner, network-recovery, or automated real-call proofs.

With the same configuration as `pnpm prod:proof`, start the local harness:

```sh
node scripts/prod-proof/integrator.mjs
```

1. Open the printed `/guest1` and `/guest2` URLs in separate browser profiles or
   contexts. Allow microphone and camera access in both. Use an HTTP `127.0.0.1`
   proof origin with an explicit port.
2. Prepare both clients before Join. The buttons stay disabled until both pages
   have granted media permissions and installed the SDK, media fixture, and access
   callback. Click both Join
   buttons promptly once enabled. The server rejects early access and creates
   one shared Episode lazily on the first `getAccess`; browser setup creates only
   the proof key and Space. The empty-Episode linger can otherwise expire while
   browsers are being prepared.
3. Keep both clients live for more than seven minutes. In each page, inspect
   `window.proofHistory`, `window.proofAccessCalls`, and
   `window.proofClient.getSnapshot()`. Require live media and Sync after both
   original grants expire, successful scheduled refresh of both grants,
   increasing bidirectional audio/video RTP counters from
   `window.proofConnections`, bidirectional chat, and zero automatic connection
   reports. Save sanitized evidence in the printed private directory. Creation
   and admission times are saved there; record `window.proofJoinedAt` too.
4. End for everyone through an original client with
   `await window.proofClient.endEpisode()`. Require both clients to observe the
   ended Episode and confirm durable backend completion. Cleanup is not proof
   that SDK end-for-everyone worked.
5. Press Ctrl-C to end any remaining owned Episode, archive the owned Space,
   revoke the proof key, and stop the server. Close both browser contexts before
   starting the next proof. If interrupted, use the run-ID cleanup command below.

The proof bundle that every guest runs is built by `sdk-bundle.mjs`. The Leave proof builds it against the published 5.2.6 baseline client, so only
the current client may import what that release lacks (the lobby `preconnect` helper, behind the `lobby` option). Gate's `proof-bundle` lane runs
`sdk-bundle.test.mjs` whenever `scripts/prod-proof` or the client source changes: it bundles a client entry with and without `preconnect`, the
current source, and the real 5.2.6 package fetched from npm and checked against its published integrity, so a bundle that breaks a nightly cut fails
the pull request that causes it.

The offline ordering regression runs with `node --test
scripts/prod-proof/integrator-session.test.mjs`, in `pnpm test`, and in Gate's
required `self-test` lane. It covers setup longer than the three-minute empty
linger, early access, simultaneous Join, and refresh serialization.

Every two-guest media proof now checks each participant's local microphone and
camera state against every other participant's Sync-derived media state and
actual playback: nonzero audio energy and advancing video frames. It saves
the media-agreement JSON artifact alongside the recording and RTP evidence.
The deployed web proof also checks rendered badges in Chromium and WebKit.

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

The proof Space uses Cloudflare. Set `CHALK_PROOF_MEDIA_PLANE=chalk_sfu`, or the
Real-call proof workflow's `media_plane` input, to run it on the own SFU where the
API's switch is on, as on nightly. The public API always refuses `media_plane: chalk_sfu`, so
set `CHALK_CANARY_SPACE_ID` to a Space an operator moved with
`go run ./cmd/media-settings set`, or leave the plane out where the deployment gives
new Spaces the own SFU (`CHALK_NEW_SPACE_MEDIA_PLANE`). The two-plane latency benchmark
(`prod:latency`) cannot name a plane either, so set `CHALK_PROOF_SPACE_ID_CF_SFU` and
`CHALK_PROOF_SPACE_ID_CHALK_SFU` to Spaces an operator moved (the real-call workflow reads them from
the environment's variables of the same names; the nightly own-SFU lane needs the second one, and the
Cloudflare lane leaves the first unset); it stops at once when a Space
is not on the plane it asked for. `call-artifacts` needs automatic Recording and Transcription, so it reuses
`CHALK_PROOF_SPACE_ID_<PLANE>_AUTOMATIC` instead, a Space with those policies. The proof's
clients declare both media providers, so the Episode binds the Space's choice.
The older Recording, export and transcript proofs need Cloudflare, so use `camera-share`
for the own SFU's call alone and `call-artifacts` for its Recording and Transcript.

### Recording and Transcript of a three-guest call (`call-artifacts`)

`pnpm prod:proof call-artifacts` creates a Space with `recording_policy=automatic` and
`transcription_policy=automatic` on `CHALK_PROOF_MEDIA_PLANE` (default `cf_sfu`) and joins three
headless Chromium guests with a fake camera and microphone. Each guest has its own camera colour.
The call then plays a script (`call-script.mjs` holds its constants and the checks, `call-play.mjs`
plays it) and the Recording must contain it:

1. **Turns.** All three pages start their audio loop from one wall-clock instant, 3 s after every guest is live and the Capture is recording. Each page schedules its sounds on its own `AudioContext` clock anchored on that instant, logs its loop start (`Guest N loop starts at ... (+x ms from the shared start)`), and the proof fails when a page starts more than 150 ms away from it or its clock is late. Two 24-second cycles follow. In its 8-second slot a guest sounds a 0.5 s marker tone (1500, 2000 or 2500 Hz, one per guest), shows a full white picture for 0.4 s at the same instant, and speaks its phrase 1 s later.
2. **Mute and screen share.** Guest 2 holds a 2000 Hz tone for 12 s and then mutes its microphone. Guest 1 shares a tab that plays a 3200 Hz tone (screen audio) and a green square for 24 s, then stops.
3. **Capture-node restart (optional).** When `CHALK_PROOF_CAPTURE_RESTART_COMMAND` is set, the proof runs that shell command once, waits 30 s, and plays one more round of markers for guests 1 and 3. The command is operator-supplied (the capture nodes belong to the recorder fleet controller, not to the proof's Tenant key) and its output is never printed. When unset, the console and the evidence say the restart was skipped.
4. **Host stop.** Guest 3 holds a 2500 Hz tone and the host stops the Recording 10 s later; the tone keeps playing for 18 s more.

The `export` proof downloads the Recording MP4. The `call-artifacts` proof then fails unless:

- `scripts/recorder/analyze-media.mjs` and `ffprobe` find a video stream with decoded frames, an audio stream, and a duration of at least 80% of the scripted call (first marker to host stop);
- `ffmpeg volumedetect` hears sound (peak above -50 dB) and three sampled frames are not black;
- each guest's camera colour is visible and moving in all three sampled frames of the composite;
- each guest's own tile is live in a clear majority of the whole Recording. The proof decodes the composite at two frames per second and, for every sampled interval, takes the largest connected patch of the guest's camera colour, plus any piece of it that a label or border across the tile cut off, as that guest's tile (so another guest's animation in the same colour cannot widen it), checks that the tile fills at least 3% of the frame (so a black tile never counts) and that the picture inside moved since the previous sample (so a frozen tile never counts). A tile with no live interval fails, and so does one live in fewer than 60% of the intervals, so "3/3 guests on camera" proves each guest's video and not the total;
- every guest's marker tone is found, anchored on guest 1's first marker, within 1.5 s of the time the script gives, with speech after it (per-guest audio completeness: tone and phrase for every cycle). Markers inside the restart window are excused;
- the longest silence (`silencedetect` threshold -50 dB, at least 0.5 s) is no longer than the script's own longest gap between sounds plus 2.5 s, which is about 6.6 s for the default phrases. The 8 Nov proof had four silences of 10.9 to 15.7 s because each guest looped on its own clock, so its pauses were never aligned; one shared start and the derived bound catch that;
- each marker's white flash and beep are less than 300 ms apart in the Recording (the A/V sync check; this bound is a first estimate and the first live run calibrates it);
- guest 2's tone ends within 15 s of the mute, the screen's tone and green square within 15 s of the stop, guest 3's tone within 15 s of the host stop, and the file ends no later than 15 s after the host stop. 15 s is the source-lease bound in `docs/sfu/design.md` (the "bounded mute-enforcement window"); the console prints the measured values;
- when `CHALK_PROOF_RECORDER_TRACKS_COMMAND` is set, every guest's markers are also checked in that guest's own recorder track, and the console prints a `Verdict:` line for each. A marker absent from the guest's own track was lost at capture. A marker in its own track but absent from the mix was lost by the mixer. A mix silence longer than the bound that a track covers was lost by the mixer; one that no track covers and the script does not cover is a gap in the script itself. The public API serves only the mixed MP4 and keeps the encrypted bundles behind a key the proof never holds, so the operator supplies the command: it runs once with `CHALK_PROOF_TRACKS_DIR` (an empty private folder in the run's encrypted evidence), `CHALK_PROOF_RECORDING_ID` and `CHALK_PROOF_PARTICIPANT_IDS` (comma separated, in guest order), and writes each participant's decrypted audio to a WAV file named after the participant id. It may leave the bundle and manifest in the folder too; everything there is uploaded only inside the encrypted evidence. Without the command the proof prints that the per-track check was skipped and judges the mix alone;
- the Recording source is `available` (the public API sets that only after Capture completion, so it stands for the sealed encrypted bundles and manifest; the API exposes no bundle objects), has an R2 storage key, did not stop early, and its export is `ready`;
- the Transcript text (`GET /v1/tenants/{tenant_id}/transcripts/{id}/text`) is not empty and contains words from every guest's phrase.

Known limits of the tile check. It attributes a tile to a guest by that guest's camera colour, and the fixture cameras are flat-colour backgrounds with moving squares, so it does not work for real camera pictures. A tile with a thin border that is frozen, next to a larger moving square of the same colour in another tile, can still pass. The earlier three-frame camera check (visible and moving) is unchanged and shares that limit: it boxes every pixel of the guest's colour. The flash check reads whole-frame brightness, so it assumes the composite shows the flashing guest's tile.

The private run folder `.private/prod-proof/<run>/` has the Recording evidence file (duration, bytes, codecs,
decoded frames, audio samples and levels, black, freeze and silence intervals, per-guest camera
checks, and per-guest tile counts: sampled intervals, visible frames, live frames and live share), the script (call-script.json: every guest's loop start and each milestone time) and its measurements (script-evidence.json: marker, flash and tone times, silences, measured end times), the Transcript evidence file (first 300 characters, word count, speaker names, matched
words per guest), the export contact sheet, the recorder's own tracks (the recorder-tracks folder, when the command is set), and the console prints the same summary lines.
Speaker names in the Transcript are reported but not required to match the guests.

### A call held across media-access refreshes (`long-call`)

Short-call proofs never outlive a media-access grant, so a bug that appears only when the SDK renews access (a guest loses the call with `access.invalid`, or a microphone stops publishing while the UI shows it on) passes them. `pnpm prod:proof long-call` holds one call of three headless Chromium guests (synthetic camera and a continuous tone) on `CHALK_PROOF_MEDIA_PLANE` (`chalk_sfu` or `cf_sfu`) for the longer of 10 minutes and two grant lifetimes. A grant lives 5 minutes and the SDK renews it 60 seconds early, so each guest sees a refresh about every 240 seconds, twice in the default 10 minutes. `long-call-criteria.mjs` holds those numbers, and its test fails if either constant in the API or the SDK moves.

Guest 1 turns its microphone off and on at 20 seconds, and guest 2 (the second to join) does the same at 30 seconds, so guest 2 has to keep its peer connection through another guest's mute and its own right after. Guests 1 and 2 then turn their microphone and camera off for 6 seconds at fixed times, and within 8 seconds before and 2 to 6 seconds after each due refresh, so every refresh has a toggle on both sides of it. The due time of a refresh comes from each guest's current grant, not from a fixed 240-second cycle: a media-connection replacement issues a new grant too and moves that guest's next refresh, so each guest's every refresh gets its own toggles, planned again after every grant. It samples every guest every 2 seconds from the SDK snapshot and the page's `getStats`. It fails when:

- a guest's connection status is `failed` or `left`, its last error is `access.invalid`, or an access refresh answers with anything but 201;
- a guest is not `live`, or has no connected peer connection, for more than 10 seconds (a closed peer connection with a connected successor is a replacement, which fails below);
- a peer connection leaves `connected` after it has been connected, for any state including `closed`, or a guest's credential provider issues a media-connection replacement: the proof injects no fault, so the SDK must never need to replace a connection;
- another guest does not decode a guest's tone within 5 seconds of that guest turning its microphone back on, for every re-publish by every guest (`hearAfterUnmute` in `audio-decode.mjs`; advancing bytes do not count), or a turn-on was not checked at every other guest;
- a guest's outbound audio bytes stand still for more than 8 seconds while its microphone shows on;
- a remote tile's inbound audio or video bytes stand still, or the tile is missing, for more than 10 seconds while its sender is on;
- a guest renewed its access fewer than twice (replacements count), never by a scheduled refresh, more than 30 seconds after the refresh was due (its grant's expiry less 60 seconds), or has a grant overdue when the call ends; or a scheduled refresh had no toggle on each side of it within 10 seconds (one in the last 10 seconds of the call has no room for a toggle after it; it is noted, still has to be renewed), because then the call did not test what it must.

It prints one line, `Long call: <guests> guests, <seconds>s, <n> access refreshes seen, <n> mic/camera toggles, <n> failures`, then one `Long call failure:` line per failure, and saves every sample in the run's private evidence folder. Its pass or fail is the proof's result in the job and the nightly; it has no scorecard metric and no budget, because it is a gate, not a measurement.

`pnpm prod:proof long-call --dry-run` prints the duration, thresholds and toggle schedule without configuration or network.

Cost: about 11 minutes of one runner and one shared-node call of three guests; no paid API beyond the SFU. The nightly runs it on `chalk_sfu` in the `own-sfu` job, inside the staging lease, so it adds about 11 minutes to that job. To run it by hand against staging, hold the lease for the whole run (it renews itself): `scripts/staging-sfu/staging-lock --holder <you> --purpose long-call --run-id <id> --wait 600 -- pnpm prod:proof long-call`. On the Cloudflare plane, dispatch `.github/workflows/real-call-proof.yml` with `proofs: long-call` and `media_plane: cf_sfu`; it is not in the nightly.

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

**Audio is decoded, not just received.** `inbound-rtp` bytes keep growing for silence, garbage and for audio that headless Chromium never plays out (`totalAudioEnergy` stays 0 without playout), so a byte counter cannot judge audio. `audio-decode.mjs` adds the further condition every call proof that publishes tones now also meets: guest _n_ publishes a WebAudio oscillator at `toneHz(n)` (440 Hz times _n_), and every other guest feeds the remote microphone track into an `AnalyserNode`, which runs headless without an output device. The tone passes when its FFT bins (the peak of three bins around it) hold at least -50 dBFS, stand at least 25 dB above the median of the other bins, and do so for ten consecutive 100 ms frames. A muted sender passes only when the newest ten frames at those bins are at or below -70 dBFS. A microphone turned back on is a re-publish, and bytes can keep advancing while a listener's receiver is dead, so every proof that re-publishes one (`sfu-e2e audio` for each guest in turn, `fleet`, `long-call`) makes every other guest decode the tone again within 5 seconds of the click, from frames captured after it (`hearAfterUnmute`, given the time taken before the click; a listener page that fails mid-check is a failed pair that names the listener; a probe or Orb check can call it too). Speech calls (`camera-share`, which plays a synthesized voice) have no tone, so they pass when the 100 Hz to 4 kHz band reaches -70 dBFS in at least ten frames (guest 2 of the fixture plays 20 dB under guest 1, so its words peak near -54 dBFS). The failure names each listener and speaker with the peak dB, bin, noise floor and sustained frames, and the evidence JSON keeps them (`audio-decode-*.json`, and `audio` in the `sfu-e2e` report). The thresholds are `decodeCriteria`; `audio-decode.test.mjs` runs the rules against a fake analyser built from a real FFT. The `pnpm prod:sfu-e2e audio` scenario is the direct proof: tone in, tone detected at both other guests, mute, silence, unmute, tone back. Wired in: `camera-share` (after setup and after the credential refresh), `sfu-e2e` (every scenario), `sfu-canary` (each join, each fault recovery, the muted round) and `sfu-classes`.

- **offreason:** Sync's off-reason extension (`media_off_reason`) over the WebSocket
  protocol, with no browser or media. It admits a host and two guests, then for each
  guest has the host stop the camera while no publication exists. The first guest
  uses the candidate SDK (the checkout, or the built entry named by
  CHALK_PROOF_CANDIDATE_SDK_ENTRY, for example an installed package's built entry). The second uses the integrity-verified published 5.2.6 client.
  The candidate's welcome must carry `media_off_reason: true`, and the stopped item
  must be `enabled: false`, `publication_id: null`, `off_reason: "host"` with an
  `off_revision`, and the SDK's decoded media state must keep the same
  `offReason` and `offRevision`, also in a snapshot after the socket closes and
  reopens. Both SDKs must stay live with no unexpected socket close. The 5.2.6 welcome must not carry the field, and its wire item and decoded
  state must be off with no reason or revision, before and after the reopen. A Sync without the extension fails
  the candidate checks, and the baseline item checks need an item for an
  unpublished stop, which only a Sync with the extension projects. The criteria
  live in `off-reason-criteria.mjs`; the evidence is saved in the run directory.
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
catchers, and disables the permanent endpoint only when this run's ownership
record shows it used that endpoint. Ownership is published atomically
with a same-directory temporary file and rename, preserving the key when adding
the catcher. Normal cleanup uses in-memory IDs too. A corrupt file is reported,
but independent Space/Episode cleanup still runs. A run that never exposed a
webhook leaves the endpoint untouched: cleanup rotates its secret, which would
break another run's signature verification.
The workflow's `always()` step uses this file even on cancellation.
It is safe to repeat. No API-key or webhook inventory scope is required.

Before each proof, the sweep lists Spaces and their Episodes only. It ends
proof-labelled Episodes older than two hours and archives their Spaces, never
archiving a Space containing a fresh or foreign Episode. Run keys expire within
55 minutes and need no sweep. An owned empty Space is archived once the Space itself
is older than two hours; fresh Spaces and Spaces with fresh or foreign Episodes
are preserved. Every run that exposes a webhook immediately revokes the previous webhook secret through
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
