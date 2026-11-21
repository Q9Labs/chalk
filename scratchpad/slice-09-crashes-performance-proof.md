# Slice 09 — Crashes and performance: proof log

Branch: `obs/slice-09-crashes-performance`
Spec: `docs/plans/hyper-observability/slices/09-crashes-performance.md`

Environment for the fault runs: the real API upload route (`apps/api` Go test),
a real migrated Postgres ledger (`with-postgres.sh`, native PostgreSQL 18.6 —
Docker was unavailable; native `pg_ctl` needs `LC_ALL=C`), the real relay writing
to an Axiom HTTP fake, a Sync kernel row written through Sync's own generated
emitter, an SFU kernel row through the SFU's Go emitter, and the durable
`participant_media_sessions` row read back by `scripts/crash-check/evidence.mjs`
(the `db` reader, itself the emit site for `db.participant_media_sessions`).

Every chain's committed hand-off files under `observability/fixtures/<code>/chain/`
are replayed byte-identically by `node scripts/gates/obs-chain-replay.mjs <code>`
(hop a = vitest fault run emitting kernel frames, hop b = API->Postgres->Axiom +
Sync/SFU/db witnesses, hop d = fixture assembly judged by the real kernel).

Fixed identities: tenant `c1000000-…-0001`, Space `d1000000-…-0001`,
Episode `0f8fad5b-d9cb-469f-a165-70867728950e`, Participant `a1000000-…-0001`,
run `client_session_id` `00000000-0000-4000-8000-000000000004`, receipt time
`1_795_702_000_000` ms.

## Checks

| Check                     | Fault run                                                                                                                                          | Verdict | Hop / module        | Proof                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------- | ------------------------------------------------------------------ |
| `page.crashed`            | `render_throw_at_60s` dev fault: React render throws, `client.render_crashed` (`render_error`, TypeError) + fallback surface `shown`                 | broken  | client_crash / web.space_call    | observability/fixtures/page.crashed/        |
| `page.uncaught_error`     | `window.onerror` + `unhandledrejection` report `client.render_crashed` (`unhandled_error` / `unhandled_rejection`, chunk_load class on one)          | broken  | client_crash / web.space_call    | observability/fixtures/page.uncaught_error/ |
| `page.tab_died`           | tab killed mid-call: next boot reports `client.previous_run` (`in_call`, no clean exit); Sync `gone` close + `participant_media_sessions` disagree   | broken  | tab_gone / sync.socket         | observability/fixtures/page.tab_died/       |
| `perf.ui_unresponsive`    | heartbeat windows with `long_task_max_ms_30s` >= 1 s while `worker_late` stayed on time (main thread, not a suspended process)                       | broken  | client_main / web.space_call     | observability/fixtures/perf.ui_unresponsive/|
| `perf.memory_pressure`    | `client.memory_warning` during the call (heap readings as context)                                                                                 | broken  | client_memory / rn.app_health    | observability/fixtures/perf.memory_pressure/|
| `perf.device_overloaded`  | `client.thermal_changed` at `serious` sustained over 60 s of probe readings                                                                        | broken  | device_thermal / rn.app_health   | observability/fixtures/perf.device_overloaded/|
| `app.crashed`             | app died mid-call: next boot reports `client.previous_run` + `client.app_exit_info` (`REASON_CRASH_NATIVE`); Sync close names the dead seat          | broken  | app_death / rn.app_health        | observability/fixtures/app.crashed/         |
| `app.crashed_at_launch`   | attempt-scope: dead marker `phase=launch`, `js_ready=false`; OS exit reason `REASON_CRASH_NATIVE`                                                  | broken  | device_launch / rn.app_health    | observability/fixtures/app.crashed_at_launch/|
| `app.killed_in_background`| dead marker `app_state=background`, no clean exit; OS exit reason `REASON_USER_REQUESTED` -> expected (OS/user kill named, not a crash)             | expected| app_death / rn.app_health        | observability/fixtures/app.killed_in_background/|

Healthy controls: each symptom's `healthy.json` — a complete call with a marker
scan (`dead_markers: 0` or a clean-exit marker), heartbeats with no stall and a
measured heap under its limit, a nominal thermal probe, normal Sync closes and a
normal durable session — produces no finding with complete coverage.

## The named real crash

`fix/class-crash-and-mic` fixes a call-page render crash: the React render threw
during a busy microphone switch (a TypeError on the media/device path). The
slice observes exactly that class: `client.render_crashed` carries
`render_cause=render_error` with `error_name`/`error_class`, and
`page.crashed`'s finding cites the surface the boundary showed. The dev fault
`render_throw_at_60s` reproduces the same mechanism without touching the product
bug; the cause is never dropped — the API allow-list and Axiom fields carry
`error_name`/`error_class`/`error_fingerprint` end to end.

## Gates and tests

- `node scripts/gates/obs-coverage.mjs`: all 9 slice-9 symptoms covered end to
  end (10 including the foundation's `end.wrong_screen`); `page.crashed` removed
  from `coverage-allowlist.json`.
- `node scripts/gates/obs-chain-replay.mjs <code>`: all 9 chains replay
  byte-identically (needs `LC_ALL=C` for the native Postgres fallback).
- `node scripts/codegen/check-generated.mjs`: 14 checks pass.
- `node --test scripts/diagnose-call/`: 222/222 (nov18 world extended with
  slice-9 witnesses: marker scan, heartbeat+memory, thermal probe, Sync closes;
  an `app.crashed_at_launch` scan on the attempt item).
- Client SDK vitest (`sdks/typescript/client`): 74 tests, telemetry chain writes
  verified. React Native vitest: 7 tests (app-health faults + wiring).
- Web vitest (`page-crashed`, `page-uncaught-error` fault tests): 6 tests; a real
  bug was found and fixed — `CallErrorBoundary` now records the crash surface on
  mount when the error happens on first render (previously `componentDidUpdate`
  never ran and `client.call_crashed` was lost).
- `go test ./apps/api/internal/httpapi -run TestTelemetryChainCrash`: all 9
  subtests pass on real migrated Postgres (API upload -> ledger -> relay/Axiom ->
  Sync/SFU/db witnesses -> committed api-rows/ledger files).

## Design decisions worth noting

- The clock is seeded before kernel records (`syncClock` posts a legacy
  `platform_changed` and flushes), matching real mid-call behaviour: by the time
  a client crashes it has generally completed a clock sample. Rows emitted
  `unsynced` would carry no `est_server_ms` and be dropped by the judge —
  honest, not a workaround.
- RN frames stamp `platform: "ios"` (the registry enum has no `react-native`;
  production stamps the real OS).
- `page.tab_died` matches the dead run against every seat including the current
  one — a rejoining participant is the same seat's earlier generation, so the
  earlier `others`-only filter could never find it.
- `app.crashed`'s healthy control is a fresh boot with no marker at all; a boot
  reporting `REASON_USER_REQUESTED` is an *expected* finding (the person ended
  the app), which the rule states rather than silently passing.
- Fixture-required witnesses must be *present* for a pass (absent suffices only
  for optional witnesses), so the nov18 healthy episodes carry real scan/close/
  probe rows — the same shape the chains prove on Postgres.
- The `db` source is deliberately absent from nov18's watermarks: it backs only
  optional witnesses, and an unread optional source must not be able to stay
  healthy-looking — the soundness suite enforces that every watermark is
  load-bearing.

## Unproved / honest gaps

- No end-to-end run of the *native* modules (`ChalkAppHealth.kt` /
  `ChalkAppHealthModule.swift`) on a device: the RN lane proves the JS wiring
  and the frame shape; the Kotlin/Swift emit sites are compiled but not
  device-run. Their contract is the same `NativeAppHealth` surface the JS tests
  fake.
- `client.timer_throttled` is emitted and timeline-mapped but no rule reads it
  yet (context for `perf.*`; the heartbeat's own `worker_late` field is the
  probe the rules use).
- Android's `REASON_*` exit taxonomy is exercised through the same
  `client.app_exit_info` event as iOS `exit_reason` naming; the enum values the
  rules classify are Android's (`REASON_CRASH_NATIVE`, `REASON_USER_REQUESTED`,
  `REASON_ANR`, …). iOS exit-info reads are declared but iOS reports fewer
  reasons in practice — honest `unknown`, never a pass.
