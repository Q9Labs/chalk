# Slice 11 (Transcription) session log

## Proofs complete (real Postgres, chalk-postgres-s11)

All 8 checks have real-Postgres fault proofs through the diagnose kernel path:

| Check | Fault | Result | Hop | World |
|-------|-------|--------|-----|-------|
| transcript.failed | provider `rejected` -> dead_letter | broken | provider | /tmp/s11-failed.mjs |
| transcript.unreadable | r2 document deleted after accept | broken | serve | /tmp/s11-unreadable.mjs |
| transcript.speech_dropped | provider `empty` words | broken | provider | /tmp/s11-speech.mjs |
| transcript.attempt_lost | claimed, dispatcher killed, lease expired | degraded | chunk | /tmp/s11-attempt.mjs |
| transcript.stuck | pending job, available_at -6min | broken | claim | /tmp/s11-stuck.mjs |
| transcript.talk_time_stuck | --prep-failed seed, talk-time pending | broken | serve | /tmp/s11-talk.mjs |
| transcript.wake_lost | wake delay 120s | degraded | wake | /tmp/s11-wake.mjs |
| transcript.late | completion +65min | degraded | claim | /tmp/s11-late.mjs |

Healthy control: job 712aa20d + episode fc53da9b (/tmp/s11-healthy.mjs) and
finalize job 449afad6 (/tmp/s11-healthy-fin.mjs) -> healthy, coverage complete.

## Commits
- 3819b9b7c9 area registry + 8 rules
- 6e76880a40 dispatcher Node kernel + emit sites
- 7f55feee23 Go API instrumentation (claim incl. issue #1510 url_failed,
  finalize_claim/accept/retry, document_read, talk_time_served, status)
- 7a5dd78035 evidence reader + world-snapshot + local-run harness
- 2e9d4e9dfd witness coverage fixes + regen

## Verification
- go build ./... : ok
- go test httpapi, talktime, postgres (Transcript|Transcription): ok vs chalk_dev
- pnpm run regen: regen-ok
- coverage gate + fixtures + fault tests: delegated (agent 69425cdd), in flight
