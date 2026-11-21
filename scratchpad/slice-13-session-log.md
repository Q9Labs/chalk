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
