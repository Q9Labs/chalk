# Slice 10 — Recording: proof log

Branch `obs/slice-10-recording`, based on `origin/obs/foundation-int`.
Scope: `observability/registry/areas/recording.json` (facts, events, reasons,
fields, symptoms, witnesses, fault_scenario), ten rules under
`observability/rules/`, kernel emit sites in Sync/API/recorder-worker/SFU/web,
`scripts/diagnose-call/readback.mjs` (r2 object read-back behind the evidence
port), and the fixture/chain layer under `scripts/recording-pipeline/` +
`observability/fixtures/<symptom>/`.

## Environment

- Postgres: a socket-only, throwaway PostgreSQL 16 cluster at
  `/tmp/chalk-pg-s10` (no TCP, seeded `apps/api/db/schema.sql`), selected with
  `CHALK_RECORDING_PSQL_HOST=/tmp/chalk-pg-s10`. OrbStack/Docker was unavailable
  on the run machine (TCC permission broke its VM), so the harness takes a
  direct-psql mode; the docker path is unchanged. No production data touched.
- Deterministic world: fixed IDs (tenant `1111…`, space `2222…`, episode
  `3333…`, recording `4444…`, reservation `5555…`, operation `6666…`, job
  `7777…`) and origin `T0 = 2026-03-01T12:00:00Z`; every row's timestamp is
  stamped relative to T0 so nothing depends on wall time.
- Synthetic chain rows bind to a *different* tenant/job (`OTHER_*`), so they
  carry registry fields one real row cannot co-express without ever satisfying
  the declared subject.

## Per-check fault proofs (real Postgres)

Each fault test seeds the fault, reads evidence back through the real readers,
judges, and hands the world's observations to the chain (`hop a`). Result =
the verdict the rule produced.

| check | seeded fault | result (code → item, hop) | proof file |
|---|---|---|---|
| recording.capture_failed | capture attempt ends `error`, finished `failed` | finding → job, hop `capture_attempt` | `observability/fixtures/recording.capture_failed/positive.json` |
| recording.empty | finished `stopped_without_media` while SFU saw a published track | finding → job, hop `capture_complete` | `observability/fixtures/recording.empty/positive.json` |
| recording.missing_span | pipeline `capturing_segmented` with a stop pair | finding → job, hop `capture_claim` | `observability/fixtures/recording.missing_span/positive.json` |
| recording.never_captured | job pending, no claim/attempt/session (`stopped_before_claim` shape) | finding → job, hop `capture_claim` | `observability/fixtures/recording.never_captured/positive.json` |
| recording.stuck | pipeline leased and unmoved past the stuck bound | finding → job, hop `capture_attempt` | `observability/fixtures/recording.stuck/positive.json` |
| render.failed | render attempt 4 `render_probe` ("rtp timestamp exceeds presentation duration", the #1505 shape) | finding → job, render hop | `observability/fixtures/render.failed/positive.json` |
| recording.artifact_unreadable | committed artifact whose stored bytes mismatch the DB sha (real ffmpeg MP4 → sha256 → readback) | finding → job, hop `artifact_readback` | `observability/fixtures/recording.artifact_unreadable/positive.json` |
| playback.url_expired | mint row + media_error with url_age > lifetime | finding → job, hop `player` | `observability/fixtures/playback.url_expired/positive.json` |
| playback.decode_failed | committed recording + client `media_error` (MEDIA_ERR_DECODE) | finding → job, hop `player` | `observability/fixtures/playback.decode_failed/positive.json` |
| recording.not_ready | render job `terminal_failure`, recording never ready | finding → job, hop `recorder` | `observability/fixtures/recording.not_ready/positive.json` |

Healthy controls: every symptom's `healthy.json` judges `pass` with
`checked === eligible > 0` — coverage is proven, not inferred from UNCHECKED.

## What passed

- `node --test --test-concurrency=1 scripts/recording-pipeline/*.fault.test.mjs` → 10/10 (plain compare mode; serial because all worlds share seeded IDs).
- `node --test scripts/recording-pipeline/recording-fixtures-chain.test.mjs` → 20/20 (positive + healthy for all ten).
- `node scripts/gates/obs-coverage.mjs` → all ten slice-10 symptoms covered end to end; remaining 11 allow-listed symptoms are other slices'.
- `node scripts/gates/obs-chain-replay.mjs` → every slice-10 chain writes exactly the committed files (see "not proved" for the one unrelated failure).
- `pnpm run check:generated` → pass; `pnpm run regen` clean.
- `go build` on the touched API/recorder-worker packages → clean; web `tsc-rs --noEmit` → clean.
- `node --test scripts/gates/obs-coverage.test.mjs` → 10/10.

## Known real faults covered

- capture reporting success with no media → `recording.empty` (the "records no
  media but reports success" fault, via `stopped_without_media` + SFU publish).
- `stopped_before_claim` → `recording.never_captured`.
- "RTP timestamp exceeds presentation duration" render failure (#1505) →
  `render.failed`, seeded as `render_probe` on the final attempt.

## Not proved / limits

- `scripts/gates/obs-chain-replay.mjs` also replays `end.wrong_screen` (slice 8,
  committed upstream, untouched here): its hop a writes a different
  `client-frames.*.json` than committed — a pre-existing staleness on the
  foundation branch, reported for that lane, not fixed here.
- The `faultinject` build-tag hook (`CHALK_RECORDER_FAULT=drop_rtp`) is
  compile-time verified only; the deterministic empty-capture proof goes
  through the seeded-DB path above, not a live worker run.
- Fault tests must run serially (shared seeded IDs); hops declare per-test
  commands so the gate replays them one at a time.
- Emit sites are source-truthful line events (`console.warn` JSON on web,
  kernel ops in Go/Elixir); delivery to the outbox/Axiom is the foundation's
  contract and not re-proved here.
