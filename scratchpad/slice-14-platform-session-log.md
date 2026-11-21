# Slice 14 platform — session log

Worktree: `/Users/agents/.t3/worktrees/chalk/obs-slice-14-platform-3d1f0529a9d43f13`, branch `obs/slice-14-platform` off `origin/obs/foundation-int` (head a6acf3b9fd). Task: implement all 8 platform checks, emitters, rules, fixtures, fault proof. No PR, no prod touches. Commit trailers: `Co-Authored-By: GPT-6.2 Sol <noreply@openai.com>`.

## Kernel facts learned
- Fixture rows: kernel rows carry `name` + `kind:"fact"`; legacy rows (host collector, http.request) carry no name/kind and match `event.legacy.match` fields exactly. rows.mjs requires `event_id` + `est_server_ms` on every row (reader stamps them for legacy log rows). `env` (build group) binds platform rows to the item (`subject.environment`).
- `value` map keeps only scalars; `source_id`, `seq`, `release_sha`, `flags_hash`, `module`, `schema_ver` land in `o.value`. `duration_ms` sets the observation window `[est, est+dur]` and is an envelope field allowed on any row (rowProblems checks fields.get(name) on all declared fields incl envelope).
- Watermarks: `completeWatermarks()` synthesizes `source|*` watermarks for fixture sources; per-seat `client` source watermarks can't exist for platform items (always not_read → keep client witnesses `required:false`).
- `check.mjs` ports: `population.items(scope)`, `evidence.fingerprint/read` → `{observations, watermarks, fingerprint}`, `store.get/put(entry,{expect})`. Reference impl: `proof/fixture-world.mjs` `openWorld(world, {catalogue, rules, store})`.
- Findings cite only `o.id`s present in readings; `fact.absent` requires `provenAbsent` (reading absent, or complete + no observation overlaps the claimed window).
- `failClosed`: pass needs every required reading `present` or absent-listed in `healthy_absent`.
- `obs.Configure` is NOT wired in main() today — must add `obs.Configure(Config{Module:"api", Env, ReleaseSHA:cfg.Observability.Version, Logger: diagnostics logger, Platform:"server"})` for obs.Fact to emit (closed mode panics on violations; open counts).
- Go kernel can't pin event_id/est_server_ms — fault tests use a `pinnedSink` slog.Handler that rewrites `event_id`/`est_server_ms`/`source_id` when writing chain files (like slice-11's pattern; seq already per-source).
- `with-postgres.sh -- <cmd>`: isolated PG (docker or native pg18), migrations applied, exports `CHALK_DATABASE_URL`.
- DEPLOY_LEAD_MS=30min, DEPLOY_SLACK_MS=120s (host-change-check.mjs).
- Collector rows: `{chalk_alert_stream:"production-state-v2", chalk_alert_rule:"database-unreachable"|"runtime-health", chalk_alert_value:0|1, chalk_alert_reason, _time}` — JSON snapshots posted to Axiom ingest (hardcoded `https://api.axiom.co/v1/datasets/<ds>/ingest`, token+dataset from `OTEL_EXPORTER_OTLP_LOGS_HEADERS`).
- http.request rows: `{event:"http.request", method, path, route, status, bytes, duration_ms, outcome:"ok"|"error"(>=400), error_code?, service_version?}` via slog → OTLP. OTel resource adds `service.version`+`deployment.environment.name`.
- `obs.flags_snapshot` exists in obs.json with `emit_sites:[]` — must append `{path:"apps/api/internal/obs/flags.go",literal:"EventObsFlagsSnapshot"}` (spec-directed; C1 owns the event, kernel emits it).
- Modules: api,sync,sfu,recorder_capture,recorder_render,transcription_dispatcher,recording_renderer,sdk,web,mobile,checker. Fault components: web,react,rn,sdk,mobile,ios,api,sync,sfu,cf,recorder,dispatcher,postgres,storage,host,tenant + network/unknown.
- Envs: local,test,nightly,staging,production. Datasets: lifecycle,requests,media-stats,infra,logs.

## Design decisions (all spec-driven)
Fields (new, all sensitivity:null): `sample_seq` int; `db_status` enum ok|unavailable(ping_timeout)|unavailable(connect_failed); `db_unreachable` int(0/1); `max_conns,total_conns,acquired_conns,idle_conns,constructing_conns,acquire_count,empty_acquire_count,empty_acquire_wait_ms,canceled_acquire_count,active_backends,idle_in_tx_backends,lock_waiters,max_lock_wait_ms,blocker_xact_age_ms` int; `blocker_application_name,blocker_usename` string; `lock_status` enum ok|failed; `stmt_status` enum ok|unavailable(extension_missing)|unavailable(permission_denied); `stmt_top` string "qid:calls:ms;..."; `component,release_id,commit,run_id,host_boot_id,previous_boot_end,service_version,target,host,route,method,error_code,outcome`... check registry first for name clashes; `marker_kind` enum deploy|rollback|auto_rollback|failed; `started_ms,finished_ms,changed_at_ms,bucket_start_ms` int; `media_plane_scope` enum space|tenant|kill_switch; `old_plane,new_plane` string; `http_status` int; `status` int(http); `edge_status,origin_status` int; `path_class` enum asset|health|space_page|other; `content_class` enum html|other; `ua_class` enum bot|browser; `requests` int; `tick_status` string (ok|error(code)); `uptime_status` enum ok|failed|unavailable(fetch_failed); `down` int(0/1); `chalk_alert_rule,chalk_alert_reason,chalk_alert_stream` string; `chalk_alert_value` int; `flags_hash,release_sha,env,duration_ms,est_server_ms,event_id,seq,source_id,module,platform,schema_ver,clock_state,kind,name,client_session_id,device_id` are envelope/existing.

Events: `db.health_sample`(fact,infra,server,[api],emit `apps/api/internal/adapters/postgres/health_poller.go` literal `obs.EventDbHealthSample`); `host.db_reachable`(fact,infra,server,[],legacy{chalk_alert_rule:"database-unreachable"},emit site `infrastructure/observability/production-alerts/collector_health.go` literal `ruleDatabase`); `host.runtime_health`(same,legacy rule `runtime-health`,literal `ruleRuntimeHealth`); `release.marker`(fact,infra,server,[checker],emit `scripts/releases/release-marker.mjs` literal `"release.marker"`); `release.started`(fact,infra,server,[api,sync,recorder_capture,recorder_render],emit sites main.go/application.ex/worker.go); `api.service_version`,`sync.service_version`,`db.media_plane_change` (reader-minted,modules[],emit `scripts/diagnose-call/platform-sources.mjs`); `api.http_request`(fact,requests,server,[api],legacy{event:"http.request"},emit `apps/api/internal/observability/http.go` literal `"http.request"`); `edge.http_rollup`(fact,requests,server,[checker],emit edge.ts); `edge.collector_tick`(fact,infra,server,[checker],emit edge.ts); `edge.uptime_check`(fact,infra,server,[checker],emit index.ts).

Facts:
- `db.reachable` state/item: `db.health_sample`(api,claim db_unreachable), `host.db_reachable`(host,claim chalk_alert_value) — both "0/1", 1=unreachable → kernel disagree when they differ in overlapping windows.
- `db.pool` event/item: `db.health_sample`(api,claim total_conns)
- `db.lock` event/item: `db.health_sample`(api,claim lock_waiters)
- `api.request` event/item: `api.http_request`(api,claim status, failure_claims "500".."599" all)
- `release.marker` event/item: `release.marker`(release,claim marker_kind)
- `release.running` event/item: `api.http_request`(api,claim service_version), `api.service_version`(api,claim service_version), `sync.service_version`(sync,claim service_version), `release.started`(api,sync,recorder_capture,recorder_render,claim release_id)
- `release.client` event/item: `obs.flags_snapshot`(client,claim release_sha)
- `db.change` event/item: `db.media_plane_change`(db,claim media_plane_scope)
- `flags.snapshot` event/item: `obs.flags_snapshot`(api,claim flags_hash)
- `flags.boot` event/item: `release.started`(api,claim host_boot_id)
- `edge.bucket` event/item: `edge.http_rollup`(edge,claim requests)
- `edge.tick` event/item: `edge.collector_tick`(edge,claim tick_status)
- `edge.origin_up` state/item: `edge.uptime_check`(edge,claim down), `host.runtime_health`(host,claim chalk_alert_value)
- `host.runtime` event/item: `host.runtime_health`(host,claim chalk_alert_reason)

Symptoms (all item=platform, per=item):
- db.unreachable: req `db.reachable`[api,host]
- db.pool_saturated: req `db.pool`[api]
- db.lock_wait: req `db.lock`[api]; opt `api.request`[api]
- release.version_skew: req `release.marker`[release], `release.running`[api,sync]; opt `release.client`[client]
- release.failures_after_change: req `release.marker`[release], `db.change`[db], `edge.bucket`[edge], `api.request`[api], `edge.tick`[edge]; opt `flags.snapshot`[api], `flags.boot`[api], `release.running`[api,sync]
- flags.unrecorded_change: req `flags.snapshot`[api], `flags.boot`[api], `release.marker`[release]
- edge.origin_unreachable: req `edge.bucket`[edge], `edge.tick`[edge], `edge.origin_up`[edge,host]
- edge.asset_failures: req `edge.bucket`[edge], `edge.tick`[edge]; opt `release.marker`[release]
Reason: `release.deploy_restart` expected.

Chains: Go fault test `apps/api/internal/adapters/postgres/health_poller_fault_test.go` drives real sampleOnce vs real PG (closed port→connect_failed; real pool saturation via held conns; real ACCESS EXCLUSIVE lock wait), pinned sink → chain/samples.*.json. `apps/api/cmd/boot_facts_chain_test.go`? (package main test OK) drives real boot-facts emitters → flags snapshot/started rows. `scripts/releases/release-marker.chain.test.mjs` drives real poster against stub Axiom → marker rows. `infrastructure/uptime-worker/edge.chain.test.mjs` drives real collect with stub GraphQL+ingest → rollup/tick/uptime rows. Hop (b) per code: `scripts/diagnose-call/proof/platform-chain.test.mjs` assembling+judging fixtures.

Emitter wiring: main.go after `api.starting` (~L129): obs.Configure + `obs.Fact(release.started,{release_id:cfg.Observability.Version,host_boot_id,previous_boot_end})` + `obs.SetFlags(ctx, {sfu_new_episodes,default_media_plane,public_invite_default_media_plane,request_logs,sfu_capture_enabled,sfu_colocated_capture,recording,transcription,whiteboard_files,direct_signaling_enabled})`; after server goroutine (~L720): `go postgres.RunHealthPoller(signalCtx, pool, cfg.Database.URL)`. pool.go: `RuntimeParams["application_name"]="chalk-api"`. worker.go StartWorker: obs.Configure+Fact(release.started, release_id=CHALK_RECORDER_VERSION). application.ex start/2: zero-length OTel span `release.started` w/ release_id from CHALK_SYNC_RELEASE_ID.

coverage-allowlist has NO platform entries (symptoms undeclared → won't appear in coverage graph until platform.json has them; gate only checks declared symptoms). Keep them off the allowlist and implement fully.

## Done (resumed after disk fix)
- All 8 chains replay byte-identically under `obs-chain-replay.mjs` (pinned `duration_ms`/`max_lock_wait_ms` like `est_server_ms`).
- Coverage: all 8 platform symptoms covered end to end; `check:generated` 14/14; diagnose-call tests 230 pass; api `go build ./...` clean; client kernel vitest 30/30.
- Honest split kept: server kernel emits `obs.flags_snapshot`; client TS emits `client.flags_snapshot`.
- Proof log: `scratchpad/slice-14-platform-proof.md` (force-added; scratchpad is gitignored).
- Pre-existing drift: `end.wrong_screen` (slice 11) still fails unscoped replay — not this slice.
- Unverified: full `mix compile` of application.ex (Hex deps not fetched; format check clean).
