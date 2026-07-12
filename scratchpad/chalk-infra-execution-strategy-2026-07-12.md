# Chalk Infrastructure Execution Strategy

Status: Ratified 2026-07-12. This document is the execution plan for the
readiness spec: every gate requirement from the previously ratified
Phase 0-5 plan is preserved and mapped in the phase-to-milestone table
below; only scheduling and grouping changed.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`. Its
settled decisions, canonical terms, non-goals, anti-slop rules, and approval
boundaries bind all execution work. Companion specs hold the recorder,
transcription, observability, and cost detail.

Owner: Hasan Shoaib

## Why milestones replace the serial phases

The ratified phases were sequenced by infrastructure layer, which had two
costs. First, the riskiest unknowns — the GPU real-time factor, capture
density, and PlanetScale PS-10 write throughput — were measured in Phase 3,
after months of build work, even though each can be measured in days for
tens of dollars and each can invalidate ratified constants. Second, the
lanes (platform, capture, render, transcription, observability, IaC) share
only thin, already-specified interfaces, yet the phases forced them into one
serial queue with one all-or-nothing staging gate.

The replacement model: measure first (spikes), build in parallel (lanes),
integrate serially (milestones). No ratified gate is weakened; the full
Phase 3 gate is still required before production recording enablement — it
is now M4. The app-tier standing-approval path in the rules below is the
one scheduling exception, and it never enables recording.

## Execution model

    M0 de-risk ──▶ lanes build in parallel ──▶ M1 local slice
      ──▶ M2 staging core ──▶ M3 recording slice ──▶ M4 scale qualification
      ──▶ M5 production plan and promotion

Rules:

- Milestones are serial integration gates; between milestones, lanes advance
  in parallel and a failure blocks only its own lane.
- A later milestone never inherits an unmet earlier gate, with one ratified
  exception: under the 2026-07-12 standing approval, app-tier M5 may follow
  the M2 gate directly, with production recording admission disabled and
  verified as disabled until the M3 and M4 gates pass.
- Workers produce evidence, never verdicts. Hasan (or the orchestrating
  agent he designates) judges gates from the execution ledger.
- Numeric limits live in the parent spec and companions; execution documents
  reference them and never restate or adjust them.
- Production mutation happens only inside M5, which retains the two-approval
  database bootstrap, fresh OpenTofu plan, exact release approval, and
  live-verification gates. Hasan's 2026-07-12 standing approval satisfies
  both approvals for the initial creation and first promotion, with each
  action's full approval payload recorded in the execution ledger
  immediately before execution; every later production action pauses for
  his explicit approval.

## Context manifests

Each worker reads the parent spec plus only the companions its lane names:

| Lane | Scope | Additional reading |
| ---- | ----- | ------------------ |
| Platform | Go API and Elixir sync packaging, boot state machine, health authority, deploy/rollback, Stateholder proofs | parent only |
| Capture | SGP1 native selective capture, reservations, bundles, fencing | recorder spec |
| Render | TOR1 GPU composite, deadline scheduling, envelope decryption | recorder spec |
| Transcription | Speaker-turn consumption, ASR adapters, Lambda dispatcher | recorder spec (artifact jobs), transcription spec |
| Observability | Telemetry, uptime services, status, alerting | observability spec |
| IaC and release | OpenTofu states, release ledger, CI identity, plan/policy/cost checks | cost model |

Lane interfaces are already specified: the PostgreSQL artifact-job tables and
recorder control API (capture/render/transcription against platform), the
release manifest (every lane against IaC), and the telemetry contract (every
lane against observability).

## Execution ledger

Execution status and evidence live in
`scratchpad/chalk-infra-execution-ledger.md`, created at M0. Workers append
dated evidence links and measured results there, and mirror each recorded
gate pass by ticking the execution checklist below. The ledger and the
checklist boxes are the only mutable execution surfaces; spec content
changes only through reviewed amendments.

## Execution checklist

Tick a box only after its evidence is recorded in the execution ledger: the
ledger holds the proof, this list holds the at-a-glance, resumable state.

- [ ] S1 GPU render factor measured — constant confirmed or re-ratified
- [ ] S2 capture density measured — constant confirmed or re-ratified
- [ ] S3 PS-10 write path measured — constant confirmed or re-ratified
- [ ] M0 inventory, provider verification, and policy encodings recorded
- [ ] M0 gate passed
- [ ] M1 thin slice: one meeting captured, rendered, transcribed, and
      deleted on a clean local host
- [ ] M1 gate passed: complete local runtime build/start/exercise/restart
- [ ] M2 foundation gate passed: clean plans, state recovery,
      protected-resource no-delete proof, no production apply
- [ ] M2 gate passed: staging core proven recoverable without recorder
      capacity
- [ ] M3 gate passed: single recording end to end on production providers
- [ ] M4 gate passed: the full ratified Phase 3 gate at scale
- [ ] M5 approval payloads recorded under the 2026-07-12 standing approval
- [ ] M5 gate passed: live production verification recorded (app-tier
      promotion verifies recording admission disabled)
- [ ] Production recording enabled after M3 and M4 gates, under explicit
      approval

## Milestone 0 — De-risk and inventory

Supersedes Phase 0 and adds three measurement spikes. Spikes use disposable,
staging-scoped resources and tokens, are destroyed when their measurement is
recorded, log their actual cost in the usage ledger, and create no
production capacity. The handoff must permit this bounded staging-scoped
spike spend.

Spikes (new — each ends in "constant confirmed" or "re-ratify now"):

- S1 GPU render factor: one TOR1 RTX 4000 Droplet renders a synthetic
  two-hour capture corpus; measure the real-time factor and full qualified
  service time. Validates or invalidates the >=15x minimum, the ten-node
  ending-together ceiling, and the TOR1 cost lines before the renderer is
  built for real.
- S2 capture density: one SGP1 CPU-Optimized Droplet with a receive-only
  Pion prototype against a real staging SFU app; measure whether two or four
  meetings per node hold at the 3-4 Mbps budget. Decides the six-versus-
  eleven-node fleet and its cost line.
- S3 database write path: an HA PS-10 branch; replay the sync transactional
  write pattern (100 accepted commands per second with event-history
  appends), `FOR UPDATE SKIP LOCKED` lease polling, and journey intake;
  measure headroom against the 30 percent gate. The parent spec already
  names the database the likely first constraint; this prices that risk
  before anything depends on it.

Inventory and verification (from Phase 0):

- record the ratified spec revision and the active implementation scope;
- approve a read-only inventory of existing provider resources;
- identify preserved R2 buckets and any reusable state backend without
  writing identifiers into the public repo;
- produce the first dated cost estimate;
- map every runtime variable and secret owner;
- verify that Grafana permits the two company-controlled Free accounts,
  prove their separate recovery and quota boundaries, and block for a newly
  ratified backend if it does not;
- verify Workers Paid account limits, the Cloudflare status path, and the
  Grafana-to-operator email route, including initial, repeat, recovery, and
  test delivery outside Cloudflare;
- verify DigitalOcean SGP1 CPU and TOR1 RTX 4000 availability, contracted
  GPU access, a team burst quota of at least twenty-one nodes, the
  eleven-capture and ten-render role limits for either active environment,
  and API creation limits without creating production capacity;
- verify the DeepInfra model/version catalog, environment account boundary,
  200-request quota, price, spending controls, DPA, subprocessors,
  processing-location and logging terms, plus the Cloudflare Workers AI
  fallback price, quota, and token boundary; no customer audio is sent
  during inventory;
- encode the ratified DigitalOcean capture/render bindings, the $110
  production fixed warning, $15 staging fixed warning, $200 combined fixed
  ceiling, and separate recording usage ledger in plan and policy checks;
- encode the ratified data-class retention, RPO/RTO, absent legal hold, and
  deletion propagation in configuration, tests, and public policy text.

Gate: the ratified spec revision is recorded, the active execution thread
explicitly names its permitted milestones and provider-write scope, and each
spike's evidence is in the ledger with a confirm-or-re-ratify outcome.

## Milestone 1 — Local vertical slice

From Phase 1, with one ordering rule added: build the thinnest end-to-end
path first — one meeting captured, rendered, transcribed, and deleted on a
clean local host — before broadening any lane. Integration defects surface
at the interfaces, so the slice is the cheapest place to find them.

Completion checklist (from Phase 1):

- add production API, sync, recorder-capture, and recorder-render images;
- add the systemd Quadlet production runtime, pinned Podman/systemd host
  contract, canonical boot state machine, and a compatible local
  production-shaped runtime definition;
- run optional bounded Redis acceleration alongside PostgreSQL Sync
  authority;
- implement the static SPA runtime-config contract and PostgreSQL job
  leasing;
- implement recording reservations, usage holds, the recorder control API,
  native selective capture, encrypted capture bundles, the layout timeline,
  fenced resume, native GPU composition, speaker-turn and overlap manifests,
  transcription chunks, provider-neutral ASR adapters, normalized transcript
  storage, and a deterministic multi-track multilingual media corpus;
- integrate the observability lane and prove its local telemetry pipeline
  and journey ledger from a clean host;
- add health, shutdown, resource, configuration, and image tests;
- prove both supported architectures;
- close the application blockers needed to boot staging.

Gate: a clean local host can build, start, migrate, exercise API, WebSocket,
and segmented recorder flows, stop, and restart the complete runtime.

## Milestone 2 — Foundation and staging core

Phase 2 plus the non-recorder staging proofs from Phase 3. Staging comes
online and is proven recoverable before any recorder capacity exists in it.

Foundation (from Phase 2):

- implement remote encrypted state and native locking;
- implement GitHub OIDC and protected environment roles;
- implement modules, policy checks, and cost checks;
- declare only shared PlanetScale organization prerequisites; create no
  environment database container in foundation;
- declare/import protected Cloudflare resources;
- configure GHCR release publishing and signature verification;
- declare the managed telemetry integration, environment-specific collector
  credentials, component uptime services, environment-isolated Grafana email
  contact points and notification policies, versioned runbook bindings, and
  status projection infrastructure;
- implement the external EventBridge/Lambda staging lease controller,
  conditional activation record, heartbeat, drift alerts, and bounded
  cleanup;
- implement separate DigitalOcean SGP1 capture and TOR1 render modules,
  one-time role-bound identity bootstrap, reservation-aware zero-idle
  scalers, 20-meeting/ten-render-node bounds, worker and lease
  reconciliation, encrypted bundle lifecycle, and fixed-versus-usage cost
  controls;
- implement the scale-to-zero AWS transcription Lambda module, private
  digest-addressed release artifacts, environment-scoped SSM credentials,
  bounded concurrency, primary/fallback policy, temporary-object lifecycle,
  and per-attempt cost telemetry;
- implement isolated environment release ledgers and conditional-transition
  tests.

Foundation gate: clean plans, state recovery proof, protected-resource
no-delete proof, and no production apply.

Staging core (from Phase 3):

- idempotently create or adopt the staging PlanetScale database container,
  then create its persistent non-HA branch, roles, backup policy, and
  configuration;
- create the persistent staging Pages, Tunnel, R2, SFU app, SSM
  configuration, Grafana account integration, and monitoring;
- activate the app node through a bounded lease and prove automatic expiry,
  drain, scale-to-zero, root-volume deletion, and honest `Dormant` status;
- create an isolated leased HA database rehearsal branch, prove restore and
  failover with the same release, return to PS-5, and prove role revocation
  and branch deletion even after an injected cleanup failure;
- deploy the exact release manifest;
- run migrations and full end-to-end verification;
- prove every component probe, telemetry signal path, public status
  projection, and alert route independently;
- replace the app node from scratch;
- reactivate from zero and prove the stable release reconstructs without
  manual repair or prior-node state;
- exercise deploy rollback, partial-release recovery, Stateholder recovery,
  health-triggered replacement, and secret rotation;
- prove a full node loss recovers acknowledged Sync outcomes from PostgreSQL
  without relying on node-local or Redis state;
- disable each monitoring path and prove the independent path alerts.

Gate: staging exists, deploys the exact release manifest, and passes every
non-recorder functional, failure, recovery, security, and observability
check listed above.

## Milestone 3 — Staging recording slice

The recorder path proven end to end at small scale on the real production
providers and classes, before any scale qualification spend.

- activate minimal staging capture and render capacity and prove reservation
  prewarm, the unscheduled start hold, selective bundle capture, native
  composite rendering, speaker-turn manifest finalization, track-aware
  transcription, authorization, retention, erasure, reconciliation, and
  cleanup on single recordings — one scheduled, one unscheduled;
- prove worker and node-loss resume with fenced replacement and explicit gap
  attribution at slice scale;
- prove envelope encryption before cross-region processing, memory-only
  plaintext handling, job-key revocation, normal one-hour bundle deletion,
  and 24-hour orphan cleanup;
- run the ratified multilingual/noise/overlap corpus through the pinned
  DeepInfra and Cloudflare models, prove normalized-schema parity, timing
  and speaker-attribution thresholds, opaque provider payloads, DeepInfra's
  50-request internal cap, 429/backoff behavior, conditional single-result
  commit, forced circuit-breaker fallback, and no full-track minute
  multiplication;
- run a full composite-recording-to-transcript staging canary to terminal
  state, then the same corpus with DeepInfra disabled and Cloudflare active.

Gate: a complete recording reaches terminal state on the production capture,
render, and transcription providers with every lifecycle, encryption,
attribution, and deletion contract observed at slice scale.

## Milestone 4 — Scale qualification

The remainder of the ratified Phase 3 gate: everything that proves the
launch ceilings rather than the mechanism. The parent spec's Capacity
Qualification and Admission section governs the app-tier targets.

- prove 20 simultaneous native captures using the real direct-SFU path,
  first at the four-room/40-participant/16-Mbps per-node target and then at
  the two-room/20-participant/8-Mbps fallback when required; exercise both
  20 three-person rooms and the five-ten-person-plus-fifteen-three-person
  stress mix; record CPU, memory, packet loss, keyframe latency, bandwidth,
  object rate, and the effect of losing one full node while the N+1 spare
  accepts its jobs;
- render a deterministic corpus representing 20 two-hour meetings ending
  together and prove the ten-node ceiling commits every 720p30 artifact
  within every deadline sub-budget with a per-node factor of at least 15x
  and a qualified service time at or below ten minutes per two-hour job;
  record node readiness, queue, input, render, upload, verification,
  recovery reserve, GPU decode/encode utilization, CPU, memory, local bytes,
  output quality, retries, and teardown;
- replace the app node during active capture and render work; prove the
  30-minute autonomy envelope and 20-minute minimum authority at failure
  onset, conditional uploads, no overlapping attempt, post-recovery
  object/lease reconciliation, explicit authority-expiry outcome, and
  complete usage settlement;
- run the app-tier 100-participant capacity qualification on the staging
  `t4g.medium` and leased HA PS-10, including the room shapes, six-hour
  soak, 150-participant burst, step-up to first failure, and the 70 percent
  admission-ceiling derivation defined in the parent spec;
- benchmark cold scale-out, spare recovery, SFU ingress, both DigitalOcean
  transfer pools, R2 operations/storage, and cost per recorded minute at 50,
  80, and 100 percent of the launch workload;
- replace the 2,000-hour planning range with an observed reservation replay
  and provider-billed-minute forecast, including a full-month Cloudflare
  fallback.

Gate: staging passes every defined functional, failure, recovery, security,
observability, and cost check — the complete ratified Phase 3 gate.

## Milestone 5 — Production plan and promotion

Phases 4 and 5, with the standing-approval execution path. Under the
2026-07-12 standing approval, M5 may run app-tier first: once the M2 gate
passes, production creation and the first promotion may proceed with
recording admission disabled in production. The M3 and M4 gates remain
required before production recording enablement, which is a later
production action needing explicit approval.

Production plan:

- when the production PlanetScale database container does not yet exist,
  produce its signed bootstrap action manifest and record it in the
  execution ledger; the standing approval covers that action alone;
- after the approved bootstrap records the immutable database ID, return to
  this step and produce a fresh production OpenTofu plan;
- produce the production OpenTofu plan and release promotion preview;
- show the cost delta, data lifecycle matrix, recovery objectives,
  migration, rollback, recorder capacity, fixed platform forecast,
  separately funded usage allocation, per-minute cost, pinned transcription
  provider/model/version, fallback exposure, and live checks;
- confirm the exact target and proposed release manifest.

Plan gate: the full approval payload for the exact production action is
recorded in the execution ledger. The 2026-07-12 standing approval satisfies
it for the initial creation and first promotion; later production actions
pause for Hasan's explicit approval.

Production creation and promotion:

- if this is the first approved database-bootstrap action, idempotently
  create or adopt only the production PlanetScale database container, verify
  and record its immutable ID, stop, and return to the plan step;
- apply the approved production plan;
- create the protected HA branch, roles, backup policy, and configuration
  only through that second approved plan;
- promote the exact staging release;
- run live schema, revision, API, sync, Pages, DNS, TLS, and two-client
  meeting verification; run the bounded synthetic recording verification and
  artifact cleanup once recording is enabled, and on an app-tier promotion
  verify instead that recording admission is disabled;
- record evidence and stop.

Gate: the intended live revision completes the user flow. When recording is
enabled, the approved recorder fleet must also produce and clean up the
synthetic artifact; an app-tier promotion passes with recording admission
verified as disabled. Infrastructure code, green unit tests, or provider
dashboards alone do not pass.

## Execution handoff contract

This strategy is ready for a fresh implementation worker. Work begins at M0.
Lanes advance in parallel between milestones; a later milestone never
inherits an unmet earlier gate, apart from the ratified app-tier M5
exception. Verification gates, benchmarks, provider
inventory, and exact prices are execution work rather than invitations to
redesign the settled architecture.

The active execution handoff must name:

- the permitted milestone range, whether it includes staging provider
  writes, whether it includes the bounded M0 spike spend, and the bounded
  usage budget for spikes, qualification runs, and synthetic recordings;
- the exact private AWS account/profile, Cloudflare account and zone,
  DigitalOcean team/project, SGP1 capture and TOR1 GPU quota, environment-
  and role-scoped automation-token references, PlanetScale organization,
  Grafana account owners, DeepInfra account and environment-token
  references, Cloudflare Workers AI account/token references, GitHub
  environments, and 1Password vault to bind during inventory;
- the company-controlled operator email address for Grafana notifications;
- whether the worker stops at a reviewed staging plan, continues through a
  verified staging apply, or continues through M5 app-tier production
  creation and first promotion under the standing approval.

These bindings stay in the active private execution context or `.private/`,
not in the public spec. If a required binding is absent, the worker may
continue local implementation and read-only discovery but stops before the
affected provider write. The worker tests Grafana k6 browser support first
for the two-client media proof; an observed capability or allowance failure
returns to Hasan with evidence and priced alternatives rather than selecting
another paid runner silently.

Production mutation stays inside M5's two-approval bootstrap, fresh-plan,
exact-release, and live-verification mechanics. Hasan's 2026-07-12 standing
approval authorizes only the initial creation and first promotion; each
action's approval payload must be in the execution ledger before it runs,
and every later production action pauses for his explicit approval.

## Phase-to-milestone map

| Ratified phase | Now lives in |
| -------------- | ------------ |
| Phase 0 — ratification and inventory | M0 (plus new spikes S1-S3) |
| Phase 1 — packaging and local runtime | M1 |
| Phase 2 — bootstrap and foundation | M2 (foundation half) |
| Phase 3 — staging | M2 (staging core), M3 (recording slice), M4 (scale) |
| Phase 4 — production plan | M5 |
| Phase 5 — production creation and promotion | M5 |

The Phase 3 gate is preserved intact as the M4 gate; M2 and M3 are interim
integration points inside it, not weakenings of it.

## Open recommendation awaiting ratification

From the 2026-07-12 spec review. Not ratified; execution follows the
ratified text until Hasan explicitly adopts it.

Reduce the launch recording ceiling (for example, five simultaneous
recordings) and raise it post-launch. This shrinks the M4 ending-together
proof from ten GPU nodes to two or three and cuts qualification cost and
duration substantially; the architecture is ceiling-agnostic.
