# Slice 13 session log

## Design decisions (registry + rules, committed first)

- Area file `observability/registry/areas/report.json` complete: 30 fields, 18 events, 39 reasons, 1 machine
  (`report.upload_state`), 20 facts, 7 symptoms. Owns `report.` and `live.` prefixes.
- `ids.json` gained `problem_report` (`pr`) kind; `dg`/`CHK-` already existed. `live_request_id` reuses `request` (`rq`).
- Op classification: kernel reasons are closed enums, so dynamic classes (http_404, transport_dns) live in fields:
  `forward_outcome`, `http_status`. Reason codes carry the class family (`report.forward_http`, `report.send_refused`).
- Facts that would read slice-7/9 records (socket close, visibility/freeze, perf_heartbeat, pagehide) are NOT declared:
  those events exist in no branch. Rules implement the spec's fallback attributions (module=unknown / sdk.diagnostics;
  expecteds never fire). Revisit when those slices land.
- `live.client_presence` (db read of telemetry_sources + latest sdk_version) is the cs_ enumeration `live.old_client` needs.
- `report.db`/`report.db_participant`/`report.db_upload`/`live.db_request`/`live.db_client_session`/`report.r2_upload` are
  checker-read events; emit_sites point at the live reader and the dev evidence reader (both pending).
- healthy_absent per rule: all required facts that legitimately don't exist on a quiet Episode.
- settle_ms: cannot_send 600s, send_failed 15s, forward_failed 60s, upload_missing 150s, target_unreachable 60s,
  no_reply 60s, live.upload_missing 150s.
- DIAGNOSTIC_UPLOAD_MIN_SDK_VERSION / LIVE_MIN_SDK_VERSION pinned at 4.0.0 placeholder — confirm against real SDK version.

## Remaining

- Emit-site code: API (migration, commit-first service, upload service, live route, config fact, outcome fact),
  Sync (introspection, socket ack, notify listen, protocol/router flag, 2 contract frames), SDK (bundle, upload,
  v1-client received, entry-url), web (problem-reports op, CallDialogContent surfaces + picker, SpacePage props).
- Checker side: r2.mjs, live/stores.mjs new-source reads, diagnose live command + view + golden, evidence.mjs harness.
- Fixtures/chains/fault tests per check; real-Postgres fault runs; proof log; foundation merge + push.

## Chain regen + coverage green (continuation)

- `live.no_reply` hop-z positive fixed: the prior request's ack sat exactly on the fault's `deliveredAt`
  boundary — `touches` excluded it (half-open) but the citation checker's `overlaps` counted it, so
  "ack absent" couldn't be proven. `obs_live_chain_test.exs` now stamps the whole prior flow a minute
  earlier via `with_obs_clock` + `pin_request_times/3` (prior_ms = @requested_ms - 60_000).
- Chain files raced a concurrent session running `obs-chain-replay.mjs` (it sets files aside to `.replay`);
  transient "no chain files"/no-finding failures were that rotation, not real breakage.
- Final state: hop-a diagnostics 7 files/23 tests, hop-c 6/6, hop-z 14/14 read-mode, and
  `obs-coverage.mjs` reports all six slice-13 symptoms covered end to end.
- `chain.helpers.ts` renamed to `chain.test.helpers.ts` (imports updated) — shared-worktree change.
- Also regenerated `end.wrong_screen` hop-d fixtures (its chain files had been regenerated concurrently);
  coverage gate green again at 8 symptoms.

## Live-readback path fixes (this session)

- `stores.mjs` `declarationSql`: the seats block ended `'[]'::json)),` — one paren too many,
  closing `json_build_object` before the new reports/uploads/requests/sessions entries. psql
  parsed them as bare select columns and errored only at the statement's final `))`. Now
  verified end to end: returns episode/tenant/seats/reports/uploads/requests/sessions.
- `end-wrong-screen-chain.test.mjs` live readback: `world.sessions` now honestly expects both
  the stamped `client_session_id` and the `telemetry_sources` envelope source (`frameSource`).
- Slice-13 SDK fault coverage: `cannot_send` positive gains an earlier send_failed cycle
  (`journey_id` on the surface, the way `CallDialogContent` emits it); `send_failed` positive
  gains a prior blocked+sent cycle (`blocked_reason`, `report_id`, `chk_code`, `http_status`);
  `upload_missing`/`live.upload_missing` positives gain a stored counterpart upload so
  `live_request_id`/`report_id`/`http_status`/`bytes` all appear; `live.no_reply` positive
  gains the prior request's full received+stored flow.
- Result: coverage 8/8, judge 14/14, `obs-chain-replay` all 8 symptoms "wrote exactly the
  committed files", `check:generated` 14/14, sync hop-c via `with-postgres.sh` 2/2.
