# Test coverage audit: what #634 deleted on the M12 path

Commit `b8e7ca75a` (#634, "prune redundant suites") deleted about 650 test
files. This audit covers the packages on the
[M12](milestones.md#m12--full-cutover-and-monitoring-parity) path: capture and
recording, placement, admission, Sync binding and signalling across the API, the
SFU, Sync, the recorder and the SDK media client.

For each package the audit names what #634 deleted, what covers the behaviour on
master, and what is still missing. "Restored" means the test came back from
`b8e7ca75a^` and passes against current code. "Gone on purpose" means the test
described behaviour that no longer exists, or master already covers it.

A test counts as restored only after a break-it check: a temporary change to the
production code, made in a worktree and reverted, that makes a named test fail.
Where a check was too costly, the restore PR says "not mutated". Statement
coverage figures come from `go test -cover` with and without the restored files.

## Restored

| Layer                                                                                                                                                                             | PR    | Files                                                                                                   | What it guards                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API capture signalling and coordinator                                                                                                                                            | #1035 | 8 (`capturesignaling`, `recordercapture`, `captureplane`, `captureplan`, `captureproviders`, `httpapi`) | Capture epochs, plan revisions and fencing, envelope digest, idempotent replay, gone and unavailable tracks, stop, completion-only claims                                                            |
| Recorder capture worker                                                                                                                                                           | #1040 | 19 suites plus fixtures                                                                                 | Stale epoch in a bundle append, privacy of muted media, duplicate and replayed packets, stop and salvage, expired lease, drain handoff, hard deadline                                                |
| API Postgres capture                                                                                                                                                              | #1044 | 11                                                                                                      | Provider outage, concurrent stop, salvage and retention, publication drain, dispatch safety, retirement                                                                                              |
| API placement, admission, Sync binding                                                                                                                                            | #1048 | 22                                                                                                      | Media plane binding and signalling, Chalk SFU allowlist, admission policy, Sync mTLS identity, provider operations, provider bridge cleanup, publication liveness and receive health                 |
| SFU media, config, control, fencing                                                                                                                                               | #1050 | 22                                                                                                      | Allocator and admission accounting, source authority, forwarding, NACK, drain, load truth, session, transport, config validation, source fencing over real UDP                                       |
| API Postgres and HTTP: admission, Episode binding, source leases, SFU liveness and signalling observation                                                                         | #1054 | 18                                                                                                      | Public admission outcome, replay, lock, cancellation and cleanup, Episode create and public join binding, source lease rows, provider operation observation, SFU liveness and signalling observation |
| Sync (Elixir): Episode admission order, coordinator recovery, publication reconciliation, provider bridge clients, media-off reasons, screen-share leases, stateholder, retention | #1055 | 49                                                                                                      | The Sync half of binding and signalling; 294 tests pass                                                                                                                                              |
| SDK media, sync, connection, space-client                                                                                                                                         | #1051 | 64 plus helpers                                                                                         | Receive health, camera uplink, subscription delivery, viewer layer, Sync v1 client and dial timeout, join concurrency, media convergence and recovery, capture lifecycle                             |

## Covered on master, nothing restored

| Package                                          | Behaviour                                                                             | Covering test on master                                                                                       | Action                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api/internal/adapters/chalksfu`            | Placement, recovery, retire, reserve, protocol skew, ICE restart, source leases (M11) | The package's existing tests, 84.4% statement coverage; the old live relay test added no coverage             | None. Old `ice_restart` and `source_leases` tests no longer compile against the M11 harness. |
| `apps/api/internal/providerbridge`               | Chalk SFU executor binding and sources                                                | None on master; the old `sfu_executor*` and `source_leases` tests use the pre-M11 node and binding signatures | Missing, see below                                                                           |
| `apps/api/internal/adapters/mediaplaneproviders` | Provider registry telemetry                                                           | None; the old registry test calls a constructor M11 changed                                                   | Missing, see below                                                                           |
| SFU `internal/media`                             | Layers, impairment, stalls, pprof, race                                               | the live support harness and the `tests/live_*` suites in `features/media/sfu/tests`                          | Gone on purpose                                                                              |
| Recorder worker                                  | Render, transcript, control-plane client, readiness suites                            | Not capture; unchanged by M12                                                                                 | Gone on purpose, outside this audit                                                          |
| Recorder worker                                  | Two-hour clock-drift soak                                                             | the track clock suite covers the clock logic; the soak needs `ffmpeg`                                         | NEEDS LIVE                                                                                   |

## Missing: no test fails if the behaviour breaks

| Package                                                                      | Behaviour                                           | Why not restored                                                                             | Where to start                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `providerbridge`                                                             | Chalk SFU executor: binding, source grants, retire  | Old tests no longer compile after M11 changed `BindingOf` and the node factory               | Rewrite against the current `BindingOf`, which returns a revision as well |
| `adapters/mediaplaneproviders`                                               | Registry resolution telemetry                       | `newService` and the telemetry type changed                                                  | Rewrite against current `newService`                                      |
| `adapters/cloudflare/sfu`                                                    | 23 legacy provider tests                            | Cloudflare SFU is the rollback provider, not the M12 own-SFU path; one test remains          | Triage only if M12 changes the rollback path                              |
| `recorderfleet`, `recordingbundle`, `recordingpresentation`, `adapters/pion` | Recording fleet, bundle, presentation, Pion adapter | Not capture; not on the M12 cutover path                                                     | Decide when recording playback joins M12                                  |
| `internal/control` (SFU)                                                     | HTTP handlers and errors                            | Restored tests reach 2.7% of statements                                                      | New handler tests                                                         |
| Sync stateholder, durable leave, socket and external operation suites        | 55 restored tests fail on missing support functions | Rewrite the Postgres seeding and WebSocket client support modules, then restore              |
| `internal/telemetry` (SFU)                                                   | Process stats, export                               | Restored tests reach 73% of statements; random breaks of nil and empty-config guards survive | New tests for the exporter guards                                         |

## Sync (Elixir)

#634 deleted 85 files under `apps/sync/test`; 11 remained. The restore brings
back the suites that pass against master with the support modules they use.
Not restored, because they call support functions master no longer has
(`seed_webhook_endpoint`, `seed_admission_request`, `TestWSClient.close`):
durable leave, entry interleavings, the external operation consumer and lanes,
participant devices, stateholder attendance, lifecycle and webhook concurrency,
dropped presence, the socket webhook and the socket suite. Those need the
support functions rewritten first. The reliability, operations and sync-breaker
campaigns need a multi-node harness and stay out. No Elixir test was mutated:
the PR says so.

## Not checked

- A real SFU with real browsers, packet loss and the production node: NEEDS LIVE. The `tests/live_*` suites and the live media smoke are the proof.
- Recorder fleet capture on real nodes, decoded playback, audio and video sync, and transcription: NEEDS LIVE.
- Live capture slot cost under load: NEEDS LIVE.
- Surviving mutants: see each restore PR. They mark input validators and nil guards that no test feeds a bad value.
