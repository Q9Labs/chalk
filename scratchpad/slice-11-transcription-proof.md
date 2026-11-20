# Slice 11 — Transcription: proof log

Branch: `obs/slice-11-transcription`
Spec: `docs/plans/hyper-observability/slices/11-transcription.md`

Environment for the fault runs: the local dev stack (api :8080, sync :4100, web :3070)
on isolated containers `chalk-postgres-s11` / `chalk-redis-s11`; real Postgres, real
api.log + dispatcher.jsonl, real artifact-store readback via `CHALK_DIAGNOSE_R2_DIR`.
Each proof world below was captured by `scripts/transcription-dispatcher/world-snapshot.mjs`
from that live stack and is committed verbatim under
`scripts/transcription-dispatcher/chain-inputs/`; the same rows form the fixture
chains under `observability/fixtures/transcript.<code>/`.

## Checks

| Check                        | Fault run                                                                                                                             | Verdict  | Hop / module                   | Proof                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript.failed`          | provider `rejected` -> attempt terminal_failure, job `dead_letter` (`provider_rejected`)                                              | broken   | provider / dispatcher.provider | chain-inputs/transcript.failed.positive.mjs                                                                                                                 |
| `transcript.unreadable`      | accepted transcript whose stored document is deleted from R2 (readback 404 `not_found`)                                               | broken   | store / storage.r2             | chain-inputs/transcript.unreadable.positive.mjs                                                                                                             |
| `transcript.speech_dropped`  | provider `empty` words; accept/finalize still land (`speech_ms` 2300, 0 words)                                                        | broken   | provider / dispatcher.provider | chain-inputs/transcript.speech_dropped.positive.mjs                                                                                                         |
| `transcript.attempt_lost`    | dispatcher claimed (`attempt 1`), process killed, lease expired; no result, no retry                                                  | degraded | chunk / dispatcher.runtime     | chain-inputs/transcript.attempt_lost.positive.mjs (also emits the `lambda evidence_gap ... tail` line: claimed, no `transcript.chunk` terminal op observed) |
| `transcript.stuck`           | `pending` chunk job with `available_at` backdated 6 min                                                                               | broken   | claim / dispatcher.schedule    | chain-inputs/transcript.stuck.positive.mjs                                                                                                                  |
| `transcript.talk_time_stuck` | `--prep-failed` seed: automatic-mode Episode, prep `terminal_failure` 15 min, no transcription; talk-time serves `transcript_pending` | broken   | serve / api.talktime           | chain-inputs/transcript.talk_time_stuck.positive.mjs                                                                                                        |
| `transcript.wake_lost`       | wake `failed`, first claim lands 125 s after job creation (> 90 s)                                                                    | degraded | wake / api.lambdawaker         | chain-inputs/transcript.wake_lost.positive.mjs                                                                                                              |
| `transcript.late`            | finalize completes 65 min after the job was created (> 60 min)                                                                        | degraded | claim / dispatcher.queue       | chain-inputs/transcript.late.positive.mjs                                                                                                                   |

Healthy controls, no finding, complete coverage:

| Item                                                               | World                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| chunk job `712aa20d` (+ Episode `fc53da9b`) — full ok-provider run | chain-inputs/transcript.stuck.healthy.mjs et al.                                                                   |
| finalize job `449afad6` — healthy document stored + r2 `ok`        | chain-inputs/transcript.late.healthy.mjs, transcript.unreadable.healthy.mjs, transcript.speech_dropped.healthy.mjs |
| Episode `fc53da9b` — talk-time serves rows                         | chain-inputs/transcript.talk_time_stuck.healthy.mjs                                                                |

Note: `wake_lost` correctly does not fire on the healthy run where the local wake
fails but the claim lands ~28 s later — the spec's "do not report merely because a
local Lambda wake fails" clause.

## Gates and tests

- `node scripts/gates/obs-coverage.mjs`: exit 0 — all 8 `transcript.*` covered end to end; all 8 removed from `coverage-allowlist.json`.
- `node scripts/gates/obs-chain-replay.mjs`: all 8 transcript chains replay byte-identically (16/16). (`end.wrong_screen` replay drifts — pre-existing on `obs/foundation-int` after the delivery rework, not this slice.)
- `node --test scripts/transcription-dispatcher/*.test.mjs`: 24/24 pass in compare mode.
- `pnpm run regen` + `pnpm run check:generated`: clean.
- `apps/api`: `go build ./...` ok; `go test ./internal/httpapi ./internal/talktime` ok; `go test ./internal/adapters/postgres -run 'Transcript|Transcription'` ok against the migrated dev database (`chalk_dev`).
- `apps/transcription-dispatcher`: `tsc --noEmit` clean; vitest 87/87.

## Issue #1510

A claim that fails URL signing leaves the chunk leased. The slice observes it:
`transcript.claim` is emitted at the Postgres claim boundary including outcome
`url_failed` (`apps/api/internal/httpapi/transcription_worker_claim.go`), so the
checkers can attribute it; `transcript.attempt_lost` then explains the stranded
lease once it expires with neither result nor retry. Behavior unchanged — named,
not fixed.

## Unproved / honest gaps

- `BLIND_SPOT` on problem-report evidence (`report` source): the slice reads no
  user problem-report store, so episode checks list it as a blind spot rather than
  claim coverage. Per the brief this is called out, not folded into the eight.
- `transcript.attempt_lost`'s real run proves the claimed-then-lost path; the
  "retry accepted" alternative is covered by healthy fixture rows, not a separate
  live fault.
- Slice 10's upstream boundary (a retained readable Recording) is assumed by the
  seed; this slice does not re-prove it.

## Decisions

- Episode declarations run through `asof_ms` (not `ended_at`) so post-end
  transcription work can witness Episode checks; `talk_time_stuck` uses
  `settle_ms: 0` because its window already reaches the read instant.
- `transcript.episode` reads policy from
  `episodes.config_snapshot #>> '{artifact_policy,transcription,mode}'`; values
  other than `on_demand`/`automatic` are `disabled`. `spaces.transcription_policy`
  is not consulted.
- db/r2 observations are stamped over the row's lifetime through the read instant
  so post-end rows witness open jobs; job declarations still close at terminal
  time.
- `healthy_absent` is used only where proven absence is itself the healthy claim
  (e.g. `attempt_lost` treats proven-absent claim/retry as passable).
- No production identifiers, tokens, keys, or transcript text in telemetry or
  fixtures; r2 readback never surfaces object keys or document bodies.
