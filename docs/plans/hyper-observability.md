# Hyper observability, v2

Code facts about what existed before the foundation come from the inventory at origin/master a09ae4232 ([inventory-ids.md](hyper-observability/inventory-ids.md)); names of the foundation's own code, files and commands are current. Inputs: a code inventory, model consults and two independent reviews, the founder's direction.

Direction from the founder:
- He wants a formal or verifiable proof of coverage, and a wrapper for every app.
- One coherent ID scheme, with version, build and flags on every event.
- Every server log and every successful operation reaches the store. Add release and rollback markers and database health. Email alerts are fine for now.
- Privacy is out of scope for now ("keep it empty").
- No automatic checker scheduling, because an agent will drive it later.
- Look up by day, tenant, time, name or any ID. Use symptom codes. Show patterns for a Participant across Episodes.
- The CLI should be LLM-friendly and token efficient.
- No phases. Lay down a foundation, then split the work vertically.

## 0. What "proven coverage" means

The honest claim is **verified coverage of the symptoms in the registry, for a named build, environment and observation window, under stated assumptions**. It is not coverage of reality. Coverage is proven in five layers. Each layer closes a different class of gap, so no single layer is enough on its own.

Chalk keeps its TLA+ models under `tools/formal/` (client recovery, Episode lifecycle, external operations, media control, public invite access, recording pipeline, screen-share lease, Sync entry and leave, and the telemetry delivery model of layer 3), each with anchors, broken variants and a run.sh. Layers 3 and 4 extend this practice instead of starting a new one.

Corrections from the Sol judge, applied below:
- The delivery model covers **durably enqueued** events, not everything emitted. A client that vanishes with no persisted high-water mark has an unknown tail, not an exact missing range.
- Lifecycle agreement is two small obligations added to `ClientRecovery.tla`, not a new product model. Agreement on the end state alone would miss bug 1.
- The verdict is three separate fields (outcome, evidence coverage, disagreement), not one precedence lattice.
- Passing traces can refute conformance with the model, but they can't prove that the code refines it.

| # | Layer | Invariant | Kind of proof | What it can't see |
|---|---|---|---|---|
| 1 | Coverage graph | Every symptom in the registry has the full chain: required witnesses, registry facts, events and fields, emit sites, a rule, a positive fixture, a healthy fixture and a fault scenario. | Graph totality checked in CI by `scripts/gates/obs-coverage.mjs`, which judges both fixtures through the diagnose kernel, plus a code search that confirms each emit site exists. | Symptoms that aren't in the registry. |
| 2 | Kernel totality | Every boundary crossing, operation, state transition, server decision and user-visible surface emits exactly one typed terminal record. | By construction: generated types and the kernel API force an outcome, and lint bans any bypass. | Logic bugs that return `ok` with wrong behavior, and anything outside our code (OS, browser). |
| 3 | Delivery conservation | Every durably enqueued record is either stored once (idempotent under retries, partial acceptance, eviction and reload) or covered by a stored drop record. A source that vanishes without a persisted high-water mark becomes an open evidence gap with an unknown tail, and the seat it covers is unchecked. | The TLA+ model in `tools/formal/telemetry-delivery`, checked. CI validates the traces of real integration tests against the model, so the model and the code can't drift apart. | Behavior the model doesn't include. |
| 4 | Lifecycle agreement | Two obligations, added to the existing `ClientRecovery.tla`. First, a listen-only connection that never opened survives provider idle expiry and grant renewal against a dead binding, either by recovering or by degrading within a bound. Second, once the authoritative end reason is known, the screen that renders is never a false failure, even when the end notice is late or lost. | Model check, and the broken variants of today's code must produce counterexamples. This is the check that would have caught 18 Nov bugs 1 and 2. | Machines that aren't modeled. |
| 5 | Verdict soundness | A missing, stale or wrong-identity witness never yields a healthy verdict, and deleting evidence never erases a `broken` finding that is already proven. | By construction: `healthy` can only be built from a sealed `ProofBundle` for a profile chosen independently of the telemetry. Missing board data must never mean "board unused". Metamorphic tests delete, age, swap and contradict witnesses. | A witness that is complete but wrong. Section 4 covers that. |

On top of the five layers there is **empirical completeness**, which can't be a proof because reality isn't a closed model. We measure it instead.

- **Diagnosis mutation score:** scripted Participants run on the real stack while we inject 40 to 60 real faults. The score is the share of faults diagnosed with the right symptom, the right Participant and the right module. Healthy control runs must produce 0% false `broken` verdicts. A slide in the score is a gap.
- **Runtime backstops:**
  - A failure or problem report that no check explains becomes `UNEXPLAINED`.
  - A problem report that arrives after the verdict, or a report stream that could not be read completely, becomes `BLIND_SPOT`.
  - Two witnesses that disagree produce `WITNESS_DISAGREEMENT`.

Each miss becomes a new symptom in the registry, so the registry converges on reality.

We formally model only the two protocols in layers 3 and 4. Modeling the whole codebase or the UI would turn the models into a burden that agents route around.

## 1. The observability kernel (the wrapper)

**One registry** (`observability/registry/`) is the single source: `observability/registry/core.json` (kinds, outcomes, items, sources, fault components), `observability/registry/ids.json`, `observability/registry/envelope.json`, and one area file per slice under `observability/registry/areas/` with its facts, symptoms, fields, events, reasons and machines. `scripts/codegen/obs-registry.mjs` is wired into `pnpm run regen` and `pnpm run check:generated`, and it generates:
- typed kernels: TypeScript (`createKernel` in `sdks/typescript/client/src/obs/kernel.ts`), Go (the `obs` package, from `observability/kernel/go` into `apps/api/internal/obs` and `features/media/sfu/internal/obs`) and Elixir (`ChalkSync.Obs` in `apps/sync/lib/chalk_sync/obs.ex`). The Lambda and the compositor have no kernel yet; slices 10 and 11, which own them, add a Node one from the same registry;
- the Axiom field schema and field budget, the coverage graph, the CLI's symptom and reason tables and the full registry, all in `observability/generated/`.

Every field carries a `sensitivity` slot, left `null` for now. That is "keep privacy empty": nothing gets redacted today, and redaction becomes a config change later.

**Five kernel calls,** the same in every kernel (the per-language signatures are the table in `observability/registry/README.md`):
- `op(name, fields, work, { classify })`: forces exactly one terminal outcome, which is `ok`, `expected(code)` or `error(code)`. An uncaught or unclassified error becomes `error(unclassified)` and is counted as unexplained.
- `transition(machine, from, to, trigger, trail, { reason })`: checked against state machines declared as data in the area files. The machines cover connection lifecycle, publication, share, board follow, Episode lifecycle, recording job and transcription job.
- `decision(name, decision, fields, reason)`: required on every server admission, refusal, timeout, close and limit, recorded after the commit. The same `decision_id` and `reason_code` travel back in the protocol payload, so the client logs the exact code the server used.
- `surface(name, fields)`: records when a surface is shown, and the dismiss call it returns records when it goes away, with the duration. It covers banners, dialogs, toasts, prejoin errors and end screens, through an `<ObservedSurface>` component in web and React Native that the first slice recording a surface adds to a shared package. This is not a rewrite of the UI.
- `fact(name, fields)` for point records.

**Boundaries instrumented automatically,** with no work per feature:
- **Go (API, SFU, recorder):** HTTP middleware that logs every request, 2xx included, as one wide event; the SFU signaling and WebSocket wrappers; a pgx tracer; R2 and Cloudflare API clients; the job runner; the compositor subprocess.
- **Elixir (Sync):** Phoenix socket and channel telemetry, Ecto hooks, the reducer wrapper, and an OTLP Logger backend. The OTLP backend fixes Sync logs that today go only to stdout.
- **TypeScript (SDK, web, mobile):**
  - wrapped `fetch` and the wrapped Sync socket;
  - the SDK's own peer-connection module logs every track change, negotiation, ICE or connection state change, and error (no global `RTCPeerConnection` proxy);
  - wrapped `mediaDevices`;
  - the React ErrorBoundary.
  - The heartbeat timer records the time it was scheduled for and the time it fired, so throttling is visible. Other timers aren't wrapped.
- **Lambda:** a handler wrapper that flushes before it returns.

**Runtime rule:** the kernel fails open in production. An export failure increments counters and never throws into call code or fails startup. In CI and tests it fails closed.

**The kernel is a shared vocabulary and generated schema, not a new runtime.** It sits on what each language already has: Go middleware, OTel and slog; Elixir Logger and Telemetry, including Sync's direct Postgrex calls (`apps/sync/lib/chalk_sync/stateholder/postgres/command_decision.ex:21`); TypeScript's transport and Effect boundaries; and a small Node job adapter. `transition` is emitted by the existing state owner and never duplicates a state machine in a table. `decision` fires at the authoritative commit, and `surface` fires at committed display. Logical operations are kept apart from retry attempts and cancellations. A caught error isn't automatically a fault.

**Enforcement:**
- CI checks that every declared boundary adopts the kernel, and it tracks operations left unfinished after a kill or hang.
- Bypass lint applies to the named adapters.
- A rule against silent catches, meaning a catch that neither rethrows nor reports through the kernel, applies at the named recovery boundaries. A deliberate one needs an adjacent justification.
- Vague reason codes and tautological fixtures are caught by end-to-end fault assertions, not by lint.

**What the kernel can't do:** it proves presence, not truth. An agent can also satisfy lint with a vague `op("run")` or a fixture that bakes the bug in. The mutation score and the cross-witness rules are the defense against that kind of compliance theater, and review should look at new symptoms and new faults rather than counting wrappers.

## 2. One coherent trail of IDs

**Today** (Luna, file:line in `docs/plans/hyper-observability/inventory-ids.md`):
- `journey_id` is minted on every API request unless the client sends `x-chalk-journey-id`, which the SDK never does (`apps/api/internal/observability/journey.go:20`).
- The SDK outbox makes one `traceparent` for the client's whole lifetime (`sdks/typescript/client/src/telemetry/outbox.ts:55`).
- The outbox's client session id lives as long as one SDK client. The W3C baggage `session.id` on API requests and the Sync `hello` is a different UUID, one per browser tab or app launch, so the two never match. The baggage id is dropped before durable work; the client session id is the telemetry ledger's source key (`telemetry_sources.source_id`).
- Other IDs:
  - `operation_id`, seq and event IDs;
  - the Participant ID plus `generation`;
  - `admission_request_id`;
  - `connection_id`, `cloudflare_connection_id` and `provider_session_id`;
  - `recording_id`, `job_id`, `attempt` and `capture_epoch`;
  - the webhook delivery ID.
- The word "session" means five things: the dashboard's word for an Episode, a media provider session, the SDK client session, the per-tab baggage `session.id`, and the dashboard sign-in.
- Telemetry carries an unkeyed SHA-256 of the Participant ID.

**Domain facts that shape the design** (GLOSSARY, schema):
- A Participant is a per-Episode seat. It keeps its ID across reconnects and gets a new one on rejoin. So the Participant already is the "attendance", and we don't need a new attendance ID.
- The person behind Participants across Episodes is a User or Agent. They are keyed by `identities.external_id` and `display_name`, unique per tenant.
- `participants.name` is nullable.
- A tenant has an `id` and a `name`, and no slug.

**Design:**

| Prefix | Meaning | Minted by | Lifetime |
|---|---|---|---|
| `ten_` | tenant | API | durable |
| `spc_` | Space | API | durable |
| `ep_` | Episode | API | one Episode |
| `pt_` | Participant (seat) | API | one seat; a rejoin gets a new one, and `generation` fences the admission incarnation |
| `usr_` / `agt_` | User or Agent behind a Participant | API | durable (`external_id`, `display_name` alongside) |
| `dev_` | device: a persistent browser profile or app install | client | until storage is cleared; `device_ephemeral=true` when storage is unavailable (an iframe that partitions it, for example) |
| `cs_` | client session: one SDK client object, from construction through disposal; the telemetry source (`source_id`) of its records | client (the outbox), before auth | one SDK client; owns `seq`; a join attempt is keyed by it |
| `mc_` / `pm_` | media connection, with the provider's session id beside it as `provider_media_id` | API / provider | one connection |
| `sc_` | Sync connection | Sync | one socket |
| `jr_` | journey: one user action (join, unmute, share, refresh, report) | client, at action start | one action, carried on every event and request it causes, through Sync frames, SFU signaling, job rows and Lambda payloads; W3C trace and span IDs link to it |
| `rq_`, `tr_`, `sp_` | request attempt, W3C trace and span | receiving server / OpenTelemetry | one attempt; a retry is a new request in the same journey |
| `op_`, `dc_` | kernel op and server decision | kernel | one record |
| `rec_`, `job_`, `whd_`, `adm_` | recording, job, webhook delivery and admission request | API | carry `ep_` and the `jr_` that caused them |
| `ev_`, `bt_` | event row and delivery batch | the emitter / the batcher or ingest | durable |
| `fl_` | flag set, the `flags_hash` | the kernel's flags snapshot | one flag map |
| `dg_`, `ak_`, `wh_` | diagnostic upload, API key and webhook endpoint | API | durable |
| `f_` | finding | checker | durable |
| `CHK-XXXX` | human diagnostic code shown in Report a problem and a settings sheet | client | derived from the first 20 bits of the `cs_` id, so it is resolved only within a scope and every candidate is returned |

- **Journey, request attempt and trace stay distinct, but linked.** Today the outbox uses one traceparent for its whole lifetime on batch uploads, so treating journey and trace as the same ID would merge unrelated actions. Instead, the client mints an action context (journey) when each action starts and stamps every event and request with it. The API accepts that context instead of minting its own, and the ledger keeps its UUID contract.
- **"Session" alone never names an id.** `observability/registry/ids.json` lists its four meanings: the dashboard's word for an Episode, the media provider's session (stored as `provider_media_id`), the SDK client session (`cs_`) and the dashboard sign-in, which is a credential that is never logged or looked up.
- **Prefixes are display and lookup syntax only.** The kinds live in `observability/registry/ids.json`, and handles come from one implementation, `formatHandle` and `parseHandle` in `sdks/typescript/client/src/obs/ids.ts`, with generated Go and Elixir twins. Rows store canonical typed values, and the reader normalizes old hashes and aliases. The CLI tells apart the four things called "session" (Episode, SDK client, provider media connection, dashboard auth session), and the last is never looked up. Database keys don't change, so there's no migration.
- **Raw IDs and names in telemetry.** With privacy off, the Participant hash goes away. Credentials, tokens and full signaling bodies are never logged: that is a security rule, not a privacy one.
- **Envelope on every row** (`observability/registry/envelope.json`):
  - delivery: `event_id`, `seq`, `batch_id`, `source_id`, `next_seq`, and on the batches and drop records that need them `end`, `dropped_seqs`, `drop_reason` and `dropped_source_id` (section 5);
  - the trail IDs up to the row's level;
  - `module`, `env`, `release_sha`, `app_version`, `app_build`, `sdk_version`, `platform` and `schema_ver`;
  - `flags_hash`, resolved by the `obs.flags_snapshot` fact that carries the full flag map, logged at boot, at join and on every change;
  - `client_mono_ms`, `client_wall_ms`, `est_server_ms`, `clock_err_ms`, `clock_state` and `clock_epoch`.

  There is no flag service, so the "flags" are the config switches, the media-plane kill switch and the call caps.

## 3. Collection

The v1 journey table still holds. v2 adds the following.

**Client flight recorder (the biggest single gain):**
- A 10-minute ring buffer in memory holds:
  - per-second `getStats` deltas per track;
  - the candidate pair and `qualityLimitationReason`;
  - mic RMS and peak before WebRTC, from a light AudioWorklet;
  - device labels and output `sinkId`;
  - `<video>` geometry and `readyState`, and `<audio>` playout state;
  - every kernel record at debug level;
  - console errors and warnings;
  - request metadata;
  - the surface stack;
  - visibility and focus;
  - the board camera at about 5 Hz while it moves, tagged with its cause (`user_pan`, `auto_follow(pt_)`, `fit_content`, `sync_op`).
- It writes a checkpoint of priority-0 events to IndexedDB (web) or a local file (React Native) every 5 s, and flushes on `pagehide` with `sendBeacon`.
- It compresses in a Web Worker and uploads to R2 through a presigned URL on:
  - a local anomaly (unmuted but silent for more than 5 s, a crash, a media or ICE error, a long freeze, more than 5 camera jumps in 2 s);
  - a problem report;
  - every call end, since that costs pennies at our volume;
  - a remote request.

**Live introspection:** `diagnose live <who>` sends one Sync control message. The client uploads its state, flight recorder and surface tree right away, and the CLI prints the handle.

**Server ground truth:**
- The SFU writes per-second stats per track (rx/tx packets, voiced packets, PLI/NACK, loss, bitrate) to R2 for each Episode. It sends 15-second rollups and every state change or error, with codes, to Axiom.
- Every Cloudflare SFU signaling request and response is logged with `mc_` and `tr_` as metadata (the call, its status, track names and error codes), never the full body or SDP.
- While recording, the recorder emits per-second audio activity and video frame presence for each track, which makes it a third witness.
- The board is replayed from Sync's op log plus each viewer's camera ring.

**Every server log reaches Axiom:** the Sync Logger, the full SFU journal, on-demand recorder workers (their bootstrap environment is missing OTLP today), the transcription Lambda, and successful API requests.

**Platform:**
- Release and rollback markers from each Alchemy deploy and each worker start, read by checks as the `release` witness source; they also declare the platform's day for its checks.
- The checker compares the version clients actually report with the deployed version.
- A change stream for config and caps.
- A Postgres health poller every 30 s: `pg_stat_activity`, lock waits, pool saturation from pgxpool `Stat()`, `pg_stat_statements` deltas, and a backup and restore marker. Today there is only a pool ping and a reachability check from the collector (`apps/api/internal/adapters/postgres/readiness.go:20`, `infrastructure/observability/production-alerts/collector_health.go:36`).
- Cloudflare Worker edge logs, so a broken deploy can't look like "0 joins, 0 errors".

**Journeys and failure classes Gemini added:**
- The embed boundary: the iframe `allow` policy, partitioned storage, host CSP blocking ingest, `postMessage` handshake timeouts, and a host page that collapses the iframe to 0×0.
- Boot and asset failures: a broken chunk after a deploy, an unsupported browser, or an ad blocker. These need a boot-level beacon on a first-party path. Today the ingest path contains "telemetry", which blocklists match.
- The listening half of audio: autoplay `NotAllowedError`, a suspended AudioContext, a muted element, a dead Bluetooth sink, OS audio focus loss.
- The ICE and TURN layer: TURN credential expiry, UDP blocked so traffic falls back to TCP or TLS relay, candidate switches mid-call.
- Native React Native: crashes before JS runs (a marker is read on the next launch), AVAudioSession interruptions and route changes, Android background kills, thermal state.
- Quiet degradation: long tasks, memory growth over the hour, black video tiles while packets still arrive, lip-sync drift, and Sync split-brain (two Participants on different board or roster revisions).
- After the call: recording playback failures (an expired signed URL, a decode error) and SFU sessions that leak after the Episode ends.

**Instead of a 30 s snapshot:**
- An immediate event on every state change.
- A 30 s heartbeat that carries rollups instead of point samples, such as `mic_rms_max_db_30s`, `freeze_ms_30s`, `min_rx_fps_30s`, `camera_auto_jumps_30s`, plus a state digest.
- The per-second flight recorder for detail.
- On web, the heartbeat runs in a Dedicated Worker, which hidden-tab throttling hits less. A tick that comes more than 1.5 times late emits `timer_throttled` with the time hidden.
- Hooks on `freeze`, `resume` and `pagehide`, and on React Native `AppState`, NetInfo and audio session events.
- Server witnesses (Sync pong, SFU flow) tell a throttled tab apart from a dead one.

**Cut:**
- Continuous DOM replay. Video and canvas don't replay in rrweb, and recording the DOM costs CPU on cheap devices. The surfaces, tile geometry and board replay show more for much less.
- Continuous profiling. Expose `pprof` on demand instead.
- A 24/7 browser fleet. One periodic canary pair is enough: 2 scripted clients send a 440 Hz tone and test video, and the canary also checks that every field survives a round trip into Axiom.

## 4. Correctness (the details must be right, not only present)

- **Cross-witness chains:** two or more independent witnesses for every key fact, and a disagreement is a finding on its own.
  - Audio chain: mic RMS → outbound RTP → SFU ingress (voiced) → SFU egress → remote inbound → remote playout.
  - Control chain: the screen the client showed and its reason code ↔ the server's end record.
  - Presence chain: client track state ↔ Sync room state ↔ the SFU track table.
- **Three-state readings:**
  - a rule reads every fact as `present`, `absent` (complete coverage proves no such row exists) or `unknown`;
  - a record leaves out a value it doesn't have, so 0, "" or "unknown" never stand in for missing;
  - units as name suffixes (`_ms`, `_bytes`, `_bps`, `_pct`).
- **Facts are kept apart from hypotheses.** A finding lists proven facts, then its hypothesis and what would falsify it. "Zero voiced packets" is a fact; "wrong mic" is a hypothesis until the device label proves it.
- **`expected` findings need tight causal preconditions.** For example, `end.time_limit` requires the authoritative end reason `time_limit` and an error within 10 s of the end. A raw status code is never enough. An `expected` finding names its registry reason code and has no module.
- **Clock alignment:** every ack returns the server time, and the client keeps an offset and an error bound equal to half the minimum RTT. A clock jump (a wall vs monotonic gap over 2 s) is an event. All times are stored in UTC, and the CLI converts time zones only when it prints.
- **Ingest gate:**
  - The API validates against the registry.
  - In production, unknown keys go into an `extra_unregistered` map field and raise an alert, and the CI build fails on them.
  - The shipper watches every Axiom response for `column_limit_drop` and emails at once.
- **Ground-truth rehearsals** use a 440 Hz tone against silence. The measured values must land in calibrated ranges, not match exact packet counts. Two logs that copy the same decision don't count as independent witnesses.
- Golden tests at emit sites; closed enums.
- Verdicts carry the rules hash (`rules=`, over the kernel, each rule file and its registry entry) and records carry `schema_ver`, so trends compare like for like and a changed rule makes stored verdicts stale.
- The kernel measures its own cost in `obs_overhead_ms` and `obs_bytes`, and a flag switches the cadence from 1 Hz to 0.2 Hz.

## 5. Delivery and storage

- **A telemetry token separate from the media grant:** send-only, 24-hour, scoped to ingest and R2 upload.
  - Today the outbox uses the 5-minute media grant, which the SDK renews 60 s before expiry (`sdks/typescript/client/src/access/manager.ts:4`).
  - So events are lost only when renewal keeps failing past expiry, and those are exactly the calls that die.
- **The telemetry ledger settles every batch (C3).** A client source is its client session; every batch names its `batch_id`, `source_id` and `next_seq`, and the ledger settles each record once by its source and `seq`, so a retried batch stores nothing twice. A source ends with `end=closed` or, when a successor finds it dead, `end=abandoned`. A drop record accounts for what the client gave up on: `dropped_seqs` as half-open `[from, to)` ranges (at most 64), a `drop_reason` of `queue_full`, `credential_expired` or `refused`, and `dropped_source_id` for a predecessor's seqs. A source that never closed, or a range it never accounted for, is an open gap, so the seat it covers is unchecked.
- **Sources are bound to their first Participant** at the ledger (`apps/api/internal/telemetrydelivery/binding.go`). A later Participant of the same User or Agent (a rejoin) is a successor and may write; anyone else is refused with `source_bound`, so a Participant that learns another source's id can't hide its gaps. A guest has no successors.
- **Half the outbox queue is reserved for priority-0 records.** Stats are dropped first.
- **First-party ingest path.**
- **Axiom Cloud with five datasets split by shape:**
  - `lifecycle` (envelope, transitions, ops, decisions, surfaces);
  - `requests` (HTTP including 2xx, Sync frames, SFU signaling);
  - `media-stats` (rollups);
  - `infra` (DB, releases, flags, canary);
  - `logs` (free-form, in map fields).

  The registry enforces the field budget.
- **If Axiom Cloud isn't approved,** don't build on the free plan. Use structured Postgres tables plus R2, which is workable at tens of Episodes a day, or Honeycomb.
- **Postgres** holds expected populations (it already does), findings with proof copies, problem reports and `CHK` codes.
- **R2** holds flight recorders, SFU per-second stats and live dumps, indexed by trail IDs.
- **Alerts** go by email to the owner: field drops, schema violations, a silent canary, and `broken` findings from on-demand runs. Self-watching the pipeline comes later.

## 6. Checking (on demand, agent-first)

- **No scheduler.** `diagnose check` is the writer. An agent, or a person, calls it for an item, a tenant's day or everything since a date (`diagnose check ep_9feb`, `diagnose check TH 2026-11-18`, `diagnose check --tenant TH --since 7d`).
- **The verdict has three fields:**
  - outcome: `broken`, `degraded`, `expected`, `healthy` or `unknown`, where `healthy` needs complete coverage, no finding and no disagreement;
  - evidence coverage: `complete` or `partial(<names>)` with `checked=c/e`, and `unchecked` or `stale` for an item with no current verdict;
  - disagreement: a list of witness conflicts.

  `unchecked` and `stale` stay visible and never mean healthy.
- **`check` judges more than ended Episodes.** Its items are Episodes (open ones included), attempts that never became an Episode (keyed by their client session `cs_`), post-call jobs, and one UTC day each of a Space, a Tenant and the platform. Each item's proof profile is chosen from the authority's declaration before any telemetry is read. It rechecks a stored result when its rows or rules change, and shows the result as stale until someone reruns it. Without a scheduler there's no guarantee of when a problem is detected, and that is the accepted trade.
- **Fetching:**
  - Queries page by time until the source is exhausted, so nothing is silently truncated.
  - A result over the API cap is a `gap:` line, so coverage is partial and the result is never read as complete.
  - Per-second data comes from R2.
- **Rules** follow one model ([docs/diagnose.md](../diagnose.md), "Add a check"). A symptom and its facts are declared in the slice's area file under `observability/registry/areas/`; the behaviour is `observability/rules/<code>.mjs` (`symptom`, `expected`, `applies`, `decide`, optional `settle_ms`); the fixtures are `observability/fixtures/<code>/positive.json` and `observability/fixtures/<code>/healthy.json`; and `scripts/gates/obs-coverage.mjs` judges both through the diagnose kernel, next to a fault scenario that drives the real code. `end.wrong_screen` is the worked example.

## 7. Symptoms and lookup

- **Dedicated symptom codes**, in product language and stable for agents, each under its slice's prefix. Examples: `admission.unresolved`, `join.no_media`, `audio.not_heard`, `audio.cant_hear`, `video.frozen`, `share.wont_stop`, `board.view_jumped`, `access.connection_lost`, `end.wrong_screen`, `end.time_limit` (expected), `rejoin.refused`, `page.crashed`, `recording.not_ready`.
  - A finding is a symptom with an outcome, a party, a time, the first hop that diverged, the module that owns it (`<component>.<area>` from the registry's fault components, or `network` or `unknown`), whether the hop upstream of it is witnessed, and the rows that prove it. An `expected` finding names its reason code instead of a module.
  - Report a problem gets a symptom picker that maps to these codes.
- **Lookup by any ID or name:**
  - `diagnose <anything>` resolves by handle or raw hex prefix, by `CHK` code, by a tenant's name or ID, by a Participant's or User's name, ID or `external_id`, or by session ID.
  - "Session ID" is accepted in its three lookup meanings (Episode, client session, provider media session), and a `via:` line says which one matched.
  - An ambiguous name lists its candidates.
- **Patterns across Episodes:** a Participant is a seat, so the cross-Episode view keys on the User behind it. A guest has no User, so it falls back to `dev_` and the name.
  - `diagnose participant usr_th-1041 --since 30d` groups a person's findings by symptom, device, browser, network, release and SFU path, and says what is common.
  - `diagnose pattern audio.not_heard --since 30d` does the same across everyone, and `--tenant TH` narrows it to one tenant.

## 8. CLI shape for agents

- **Commands:**

  | Command | Purpose |
  |---|---|
  | `<anything>` | universal resolver: a handle, raw id, session id, `CHK` code, tenant or person name |
  | `day` | sweep a tenant's day of Episodes, attempts and jobs |
  | `episode`, `attempt`, `job` | one item in depth |
  | `space`, `tenant`, `platform` | one UTC day of a Space, a Tenant or an environment |
  | `evidence` | why a finding's proof is sufficient |
  | `participant`, `pattern` | patterns across Episodes |
  | `window` | a tenant's items in a time window |
  | `check` | run the checker |
  | `report`, `live` | a problem report; ask a running client for its state (slice 13 adds both) |
  | `trace` | raw Axiom rows and R2 slices (not built yet) |
  | `coverage` | the five counts, blind spots and the last mutation score (not built yet) |
  | `symptoms` | the registry's symptom table (not built yet) |

  [docs/diagnose.md](../diagnose.md) is the reference for the commands that exist.

- **Output contract** (the line grammar in [docs/diagnose.md](../diagnose.md), with goldens in `scripts/diagnose-call/golden/`):
  - Line 1 is the header: the scope (`episode ep_x tenant=T`, `attempt cs_x tenant=T`, `job job_x tenant=T`, `space spc_x <day>`, `tenant ten_x <day>`, `platform production <day>`, or a sweep such as `day T <date>`), then `outcome=`, `coverage=`, `checked=c/e`, `asof=` and `rules=`. Status and gaps are never truncated.
  - One scoped time anchor comes next. An Episode, attempt or job view prints times relative to it, a Space, Tenant or platform day (anchored at 00:00 UTC) prints UTC clock times, and sweeps print local clock times.
  - Records are deterministic, one per line. A finding is `f_x <outcome> <code> <party> <when>` with `hop=`, `module=`, `upstream=`, `reason=` and `ev=` as they apply; a party is a bare handle with an optional name (`pt_4c1e(Haris)`) or `all`; a `fact:` cites only `ev_` handles or `[proven absent]`; and a hypothesis line appears only when an upstream witness supports it.
  - Handles are stable and resolvable within their scope, and a collision returns the candidates.
  - **Every finding says why its proof is sufficient** in `diagnose evidence f_x`: what was expected, what was observed, the source watermark for its window, a reproducible proof query, and what would falsify an absence or an attribution.
  - `--limit` and a stable cursor are the main controls. `--budget` is optional, because it depends on the tokenizer.
  - Output omitted on purpose (`more: N omitted by limit`) is labeled differently from a source that wasn't read completely (a `gap:` line).
  - `--json` returns compact versioned objects. Columnar JSON is used only for dense tables, after it is measured.

  ```text
  day TH 2026-11-18 outcome=broken coverage=partial checked=4/6 partial=2 stale=1 unchecked=1 asof=2026-11-19T01:00Z rules=c1f4c2c8
  anchor=2026-11-17T19:00Z local=2026-11-18T00:00+05:00 tz=Asia/Karachi
  admission.unresolved broken attempts=1 cs_6d5e
  audio.not_heard broken episodes=1 people=1 ep_9feb
  recording.not_ready degraded jobs=1 job_4a3b
  end.time_limit expected episodes=1 ep_9feb
  gap: stale ep_31aa 11:00 was=healthy
  gap: partial ep_9feb 14:45 missing=board
  gap: partial job_4a3b 15:45 missing=open
  gap: unchecked ep_7a21 16:00
  next: diagnose check TH 2026-11-18
  next: diagnose attempt cs_6d5e
  ```

  ```text
  episode ep_9feb tenant=TH outcome=broken coverage=partial(board) checked=9/13 asof=2026-11-19T01:00Z rules=c1f4c2c8
  anchor=2026-11-18T09:45Z local=14:45+05:00 dur=60m seats=4
  f_5b55 broken audio.not_heard pt_4c1e(Haris) +07:10..+10:40 hop=sfu_ingress module=unknown upstream=unknown ev=ev_a1f3
  fact: SFU ingress 10480 packets, 0 voiced [ev_a1f3]
  fact: microphone unmuted [ev_c9d0]
  f_d2a1 expected end.time_limit all +60:00 reason=end.time_limit ev=ev_0b9e
  report ev_2b3c pt_b2d4(Sana) +11:30 "Haris's audio not audible" explained_by=f_5b55
  gap: board.view_jumped all 4 seats: board.camera not emitted by client 3.1.0
  next: diagnose evidence f_5b55
  next: diagnose participant usr_th-1041 --since 30d
  ```
- **Measured** with the o200k tokenizer on the same Episode content when the format was chosen (samples in `docs/plans/hyper-observability/`). The goldens are recounted with `uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`.

  | Format | Tokens |
  |---|---|
  | Today's shape | 894 (full UUIDs and hashes dominate) |
  | Fable's text | 270 |
  | Compact grammar | 187 |
  | Pretty JSON | 422 |
  | Compact JSON | 265 |

## 9. How the work splits (no phases)

**Foundation: four locked contracts, merged first.** Only the contracts block the slices, because without them parallel agents invent incompatible IDs and schemas. Each contract is a separate lane.
- C1, IDs and envelope:
  - the trail table and action context;
  - host app version, build and SDK version;
  - effective flags or a resolvable snapshot ID;
  - clock and uncertainty;
  - the generated registry, and the coverage-graph check in CI (`scripts/gates/obs-coverage.mjs`).
- C2, witnesses:
  - the `ProofBundle` and the proof profile per item: Episode, attempt, job, and the Space, Tenant and platform days;
  - three-state readings;
  - the three verdict fields;
  - the rule model: facts and symptoms in the area files, `observability/rules/<code>.mjs`, and fixtures the coverage gate judges through the kernel.
- C3, acknowledgment:
  - stable batch and event IDs, partial acks, dedupe, source watermarks, drop records and source ends;
  - source binding to the first Participant and its successors;
  - the telemetry token;
  - P0 reservation;
  - the delivery TLA+ model.
- C4, output: the line grammar above, with `--json` objects.

Work that runs alongside the contracts and doesn't block them:
- server log shipping, including 2xx;
- the on-demand recorder OTLP;
- Sync Logger export;
- release and rollback markers;
- the readback canary;
- email alerts;
- Axiom Cloud, if approved.

**Vertical slices**, all in parallel once the contracts are merged. Each slice adopts the kernel in its own modules and owns its area file, symptom codes, rules and fixtures, fault scenarios, and CLI lines. [The slice contract](hyper-observability/slices/README.md) is what every slice extends. The bigger collectors (the flight recorder, live dumps, uploads at every call end, board replay) ship inside the slices that need them, and each must show what it adds to diagnosis in that slice's fault runs.

1. Entry: dashboard, invite, admission, prejoin, embed and boot.
2. Join and media connection, including listen-only.
3. The audio chain: being heard and hearing.
4. Video.
5. Screen share.
6. Whiteboard.
7. Access, reconnection and background.
8. Call end and rejoin.
9. Crashes and performance, on web and native.
10. Recording and rendering.
11. Transcription.
12. Webhooks and tenant integration.
13. Report a problem and live introspection.
14. Platform: DB, releases, flags, Cloudflare edge.

**Time-boxed:** export the 18 Nov rows as fixtures before Axiom deletes them, around 18 Dec.
