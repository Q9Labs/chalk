# Slice 11: Transcription

This slice proves, for every Recording that should get a transcript, that the transcript was made, stored, readable and served. When one wasn't, it names the hop and module that lost it. It starts when slice 10 has proved a retained, readable Recording artifact and ends when the transcript document is stored and served, including the talk-time view derived from it. SWE-2 builds it and owns the prefix `transcript.` only. It depends on C1 (kernel calls, `formatHandle` handles `ep_`, `rec_`, `job_`, the Node Lambda handler wrapper), C2 (`ProofBundle`, three-state values, verdict fields, backstops), C3 (`evidence_gap`, watermarks), C4 (compact grammar), slice 10 (admission), slice 12 (webhooks that announce transcripts) and slice 14 (database-down attribution). Every file:line below is at `b3dc1d3afa`.

## 1. Scope

**Journey.** The policy is the Episode's snapshot, `episodes.config_snapshot #>> '{artifact_policy,transcription,mode}'`, read the way `apps/api/db/queries/episode_talk_time.sql:14` reads it (any value other than `on_demand` or `automatic` means `disabled`). Never read `spaces.transcription_policy` (`apps/api/db/schema.sql:261`); it is the Space default, not what the Episode ran with. Under `automatic`, slice 10 commits the admission (`apps/api/internal/adapters/postgres/transcription_admission.go:19`, called from `apps/api/internal/adapters/postgres/recording_render.go:296` and `:384`). Under `on_demand`, a Dashboard Account calls POST `/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts` (`apps/api/internal/httpapi/transcription_artifacts.go:84`). The journey ends when GET `/v1/tenants/{tenant_id}/transcripts/{transcript_id}/document` (`apps/api/internal/httpapi/transcription_document.go:41`) and GET `/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/talk-time` (`apps/api/internal/httpapi/episode_talk_time.go:68`) serve it.

**Population.** Every Recording of the Episode that has a `transcriptions` row, plus every Recording with `status = completed` when the mode is `automatic`. A Recording with no row under `on_demand` or `disabled` is `not_applicable`. A transcription with `status = deleted` or `deleted_at` set is `not_applicable` for every rule.

**Files owned (edit only these):**
- Dispatcher: `apps/transcription-dispatcher/src/index.ts`, `apps/transcription-dispatcher/src/queue.ts`, `apps/transcription-dispatcher/src/transcriber.ts`, `apps/transcription-dispatcher/src/finalizer.ts`; `package.json` only to add C1's Node package.
- API: `apps/api/internal/adapters/aws/lambdawaker/waker.go`; `apps/api/internal/httpapi/transcription_worker.go`, `apps/api/internal/httpapi/transcription_worker_claim.go`, `apps/api/internal/httpapi/transcription_finalize.go`, `apps/api/internal/httpapi/transcription_document.go`, `apps/api/internal/httpapi/episode_talk_time.go`; `apps/api/internal/talktime/service.go`; `apps/api/internal/adapters/postgres/transcript_jobs.go`, `apps/api/internal/adapters/postgres/transcript_results.go`, `apps/api/internal/adapters/postgres/transcription_finalizer.go`.
- Checker: `scripts/diagnose-call/rules-transcript.mjs (new)` and `scripts/diagnose-call/scenarios-transcript.mjs (new)`; the `findingsOf` wiring at `scripts/diagnose-call/rules.mjs:282`; new row readers in `scripts/diagnose-call/database.mjs`; `lambda` and `r2` in `SOURCE_NAMES` at `scripts/diagnose-call/gaps.mjs:6`; in `scripts/diagnose-call/sources.mjs`, the r2 readback, the local log reader and the transcript read window (section 4).
- Harness: `scripts/transcription-dispatcher/local-run.mjs (new)` (section 6).

## 2. Symptom catalogue

| Code | Meaning | Who is affected | Severity |
|---|---|---|---|
| `transcript.failed` | A transcription job reached `dead_letter`, or the transcription reached `terminal_failure`. No transcript will exist without a new request. | The Tenant and its Dashboard Accounts. | high |
| `transcript.unreadable` | The transcription is `complete` but its stored document is missing, differs from the recorded size, sha256 or content type, or fails `transcript.v1` validation; or the API failed to read a document that is in fact readable. | The Tenant and its Dashboard Accounts. | high |
| `transcript.attempt_lost` | A claimed chunk attempt's lease expired with no accepted result and no accepted retry, so the work was silently dropped and waits for lease recovery. | Operators; the transcript is delayed. | medium |
| `transcript.stuck` | A transcription stopped moving: a job waits unclaimed, a transcription sits mid-pipeline with no open job, or an `automatic` Recording never got a transcription. | The Tenant and its Dashboard Accounts. | medium |
| `transcript.late` | The transcript completed more than 60 minutes after the transcription row was created. | The Tenant and its Dashboard Accounts. | medium |
| `transcript.speech_dropped` | The dispatcher measured at least 2000 ms of speech in the audio, but the stored document has zero cues. | The Tenant and every Participant whose words are missing. | medium |
| `transcript.talk_time_stuck` | Talk-time answers `transcript_pending` for an Episode where no transcript can arrive. | Dashboard Accounts viewing the Episode. | medium |
| `transcript.wake_lost` | The API's wake call to the dispatcher failed, and the first claim came more than 90 s after the job was created. | Operators only. | low |

## 3. Witnesses

`db` is the authority for every outcome. These are copies and count as one witness wherever they appear:
- The dispatcher's error code (`apps/transcription-dispatcher/src/errors.ts:111`), the `transcript.job_retry` decision that receives it (`apps/api/internal/httpapi/transcription_worker.go:95` takes `terminal` and the code from the dispatcher's body) and `artifact_jobs.error_code` are one cause witness.
- `transcription_attempts.provider_observed_duration_ms` (`apps/api/db/schema.sql:2459`) and `quality.segmentCount` (`apps/api/db/schema.sql:2467`) are both dispatcher reports, written from `durationMs: speechMs` and `segments.length` (`apps/transcription-dispatcher/src/mai-provider.ts:51`) through `apps/transcription-dispatcher/src/transcriber.ts:142`. They are one witness. The final document read back from `r2` is independent of them, because the finalizer builds it from the stored chunk results and the checker reads the bytes itself.
- `dashboard.talk_time_unavailable` (`apps/web/server/engine.ts:154`) logs only an error type; no rule uses it.

Dispatcher logs go to `console.info` and `console.warn` only (`apps/transcription-dispatcher/src/index.ts:45-48`), and `package.json:13` has no telemetry dependency, so `lambda` is a missing source until C1's Lambda wrapper ships its events. Until then every rule step that needs `lambda` reports `partial(lambda)`.

| Symptom | Witnesses |
|---|---|
| `transcript.failed` | `db` `artifact_jobs` `state`, `error_code`, `attempt_count`, `attempt_limit`, `terminal_at` (`apps/api/db/schema.sql:2361`) and `transcriptions.status` (`apps/api/db/schema.sql:2278`, values checked at `:2305`): exist; slice adds readers `db.transcription` and `db.transcription_job` in `scripts/diagnose-call/database.mjs`. `api` decision `transcript.job_retry`: missing, slice adds it in `apps/api/internal/httpapi/transcription_worker.go`. `lambda` op `transcript.chunk` error: missing, slice adds it in `apps/transcription-dispatcher/src/transcriber.ts`. The three are one cause witness; `db` alone decides the outcome. |
| `transcript.unreadable` | `r2` readback of `artifact_key` (bytes, size, sha256, content type, `transcript.v1` validation as `apps/api/internal/transcripts/document.go:151` does): missing, slice adds it in `scripts/diagnose-call/sources.mjs`. `api` op `transcript.document_read`: missing, slice adds it in `apps/api/internal/httpapi/transcription_document.go` and `apps/api/internal/talktime/service.go`, because `apps/api/internal/httpapi/transcription_document.go:68` and `:74` answer 500 with no logged cause. The completion check (`apps/api/cmd/transcription_authority.go:94`) ran once at completion and proves nothing about now. |
| `transcript.attempt_lost` | `db` `artifact_jobs.state = leased` with `lease_expires_at`, or a recovered row with `error_code = lease_expired` (`apps/api/db/queries/artifact_jobs.sql:282`): exist. `api` decisions `transcript.claim`, `transcript.job_complete`, `transcript.job_retry` for that job and attempt: missing, slice adds them. `lambda` op `transcript.chunk`: missing. A killed or timed-out Lambda can't report itself, so `db` decides; `api` and `lambda` only pick the module. |
| `transcript.stuck` | `db` `artifact_jobs.available_at`, `lease_expires_at`, `transcriptions.updated_at`, `recordings.completed_at`, `recording_jobs` kind `transcription` (`apps/api/db/schema.sql:2675`): exist; slice adds reader `db.recording_transcription_job`. `api` decisions `transcript.claim` and `transcript.finalize_claim`: missing, slice adds them. Lease recovery runs only inside a claim (`apps/api/internal/adapters/postgres/transcript_jobs.go:27`), so an expired lease can stay `leased` for hours; rules read `lease_expires_at`, never `state` alone. |
| `transcript.late` | `db` `transcriptions.created_at`, `completed_at`: exist. One source is enough at medium. |
| `transcript.speech_dropped` | `db` accepted `transcription_attempts` rows with `provider = 'openrouter'` (the MAI provider's name, `apps/transcription-dispatcher/src/mai-provider.ts:27`): exist; slice adds reader `db.transcription_attempt`. `r2` readback cue count: missing, slice adds it. Two independent witnesses. |
| `transcript.talk_time_stuck` | `db` Recording status, transcription row, `recording_jobs` kind `transcription`, open `artifact_jobs`: exist. `api` fact `transcript.talk_time_served` with `status`: missing, slice adds it in `apps/api/internal/httpapi/episode_talk_time.go`. Independent: `db` is the stored shape, `api` is the live answer. |
| `transcript.wake_lost` | `api` decision `transcript.wake` with `job_id`: missing, slice adds it in `apps/api/internal/adapters/aws/lambdawaker/waker.go`; today `transcription.wake_failed` (`apps/api/internal/adapters/aws/lambdawaker/waker.go:57`, `:75`, `:82`) has no `job_id`, and `wake_queued` (`:85`) proves only that the event was queued. `api` `transcript.claim` decision time for the first `leased` claim: missing, slice adds it. `db` `artifact_jobs.created_at`: exists. Never use `transcription_attempts.started_at`: attempt rows are created only when a result is accepted (`apps/api/internal/adapters/postgres/transcript_results.go:93`), so it is result time. |

## 4. Rule conditions

Missing data never yields healthy: a rule that lacks a witness returns the gap named here, and healthy comes only from the sealed `ProofBundle`. `asof` is the checker's run time. "Open job" means an `artifact_jobs` row of the transcription in `pending`, `leased` or `retryable`. The checker reads `api` and `lambda` rows from the transcription's `created_at` minus 5 min to the later of `completed_at` and `asof`, because `episodeWindow` in `scripts/diagnose-call/sources.mjs:24-30` stops at `ended_at` plus 60 min and would miss them. `db` unreadable makes every rule here `unchecked`. No rule here returns EXPECTED; a slice rule never emits UNEXPLAINED, BLIND_SPOT, WITNESS_DISAGREEMENT or UNCHECKED, the checker does.

Hops are `admission`, `wake`, `claim`, `chunk`, `provider`, `accept`, `finalize`, `store`, `serve`. Modules are `dispatcher.provider`, `dispatcher.runtime`, `dispatcher.assignment`, `dispatcher.queue`, `api.transcription_worker`, `api.transcripts`, `api.talktime`, `api.lambdawaker`, `storage.r2`, `dispatcher.schedule`.

**Error code map** (used by `failed` and `late`): `provider_timeout`, `provider_schema_invalid`, `provider_rate_limited`, `provider_unavailable`, `provider_rejected` (`apps/transcription-dispatcher/src/errors.ts:103-109`) give module `dispatcher.provider`, hop `provider`. `lease_expired`, `timeout`, `dispatcher_failure`, `network_failure` give `dispatcher.runtime`, hop `chunk`. `control_api_rejected` gives `api.transcription_worker`, hop `accept`. `assignment_invalid`, `chunk_download_retryable` give `dispatcher.assignment`, hop `chunk`. Any other code gives `dispatcher.queue`, hop `chunk`. A job of kind `transcription_finalize` always gets hop `finalize`.

| Symptom | BROKEN or DEGRADED | Gap |
|---|---|---|
| `transcript.failed` | BROKEN when `transcriptions.status = terminal_failure`, or any job has `state = dead_letter` while status is not `complete`, `deleted` or `terminal_failure`. The cause is the `dead_letter` job with the latest `terminal_at`, mapped by the error code map. `terminal_failure` with no `dead_letter` job gives hop `accept`, module `api.transcripts`, fact `terminal_failure with no dead_letter job`. | `api` or `lambda` rows missing give `partial(api)` or `partial(lambda)` on the cause only; the outcome stands. |
| `transcript.unreadable` | BROKEN when `status = complete` and any of: `artifact_key`, `artifact_size` or `artifact_content_type` is null (so `DocumentReady`, `apps/api/internal/transcripts/document.go:230`, is false); the readback returns 404; byte size differs from `artifact_size`; sha256 differs from `artifact_sha256`; content type is not `application/json`; validation as at `apps/api/internal/transcripts/document.go:151` fails. Hop `store`, module `storage.r2`. DEGRADED when the readback passes but a `transcript.document_read` op in the window ended `error`: hop `serve`, module `api.transcripts`. | No `CHALK_DIAGNOSE_R2_*` and no `CHALK_DIAGNOSE_R2_DIR` gives `partial(r2)`. Null `artifact_sha256` gives `partial(r2)` with reason `no_checksum`; size and validation still run. |
| `transcript.attempt_lost` | DEGRADED for each chunk job and attempt where `db` shows `state = leased` with `lease_expires_at <= asof`, or `error_code = lease_expired`, and no `transcript.job_complete` `accepted` or `transcript.job_retry` exists for that job and attempt. Hop `chunk`. Module `api.transcription_worker` when that attempt's `transcript.claim` decision was `url_failed`, `invalid_assignment` or `lease_stale` (the claim handler leased the job and then failed, section 7). Otherwise `dispatcher.runtime`. | No `api` rows gives `partial(api)` and module `unknown`. `lambda` rows that show `dispatcher_claimed` (`apps/transcription-dispatcher/src/queue.ts:58`) or the invoke op start with no `transcript.chunk` terminal for that job give `partial(lambda)` and an `evidence_gap`. No `lambda` rows at all gives `partial(lambda)`. |
| `transcript.stuck` | BROKEN on any of: (s1) an open job in `pending` or `retryable` with `available_at <= asof - 5 min`; (s2) a job `leased` with `lease_expires_at <= asof - 5 min`; (s3) status `transcribing`, `verifying` or `retryable_failure`, no open job, and `transcriptions.updated_at <= asof - 30 min` (hop `accept`, module `api.transcripts`); (s4) mode `automatic`, Recording `completed` with `completed_at <= asof - 30 min`, no transcription row and no `recording_jobs` row of kind `transcription` (hop `admission`, module `api.transcripts`). For s1 and s2, hop `claim`: no `transcript.claim` or `transcript.finalize_claim` decision at all in the last 5 min gives `dispatcher.schedule` (the 1-minute schedule, `infrastructure/transcription-dispatcher/resources.ts:82`, or its `state` at `:84`); claims ran but every one returned `none` gives `api.transcription_worker`. s2 may fire with `attempt_lost` for the same job; both stand. | No `api` rows gives `partial(api)` and module `unknown` for s1 and s2. |
| `transcript.late` | DEGRADED when `status = complete` and `completed_at - created_at > 60 min`. Hop and module from the first job of the transcription with `attempt_count > 1`, by the error code map applied to that job's latest `error_code`; with no such job, hop `claim`, module `dispatcher.queue`. | None: `db` decides. |
| `transcript.speech_dropped` | BROKEN when `status = complete`, every chunk has an accepted attempt with `provider = 'openrouter'`, the sum of their `provider_observed_duration_ms` is `>= 2000`, and the `r2` readback has 0 cues. Hop `provider`, module `dispatcher.provider`, with `hypothesis: provider returned no words for audio the -45 dB gate (apps/transcription-dispatcher/src/speech-audio.ts:6) counted as speech; falsified by playback with no voices`. | A chunk whose accepted attempt is from another provider gives `partial(db)` with reason `no_speech_measure`. No readback gives `partial(r2)`. |
| `transcript.talk_time_stuck` | BROKEN when no Recording of the Episode has a `complete` transcription, at least one Recording counts as in progress by `transcriptInProgress` (`apps/api/internal/talktime/service.go:177`), and every such Recording is dead for at least 10 min. Dead means (a) mode `automatic`, Recording `completed`, no transcription row, and the latest `recording_jobs` kind `transcription` row is `terminal_failure` or `cancelled` with `terminal_at <= asof - 10 min`, or there is no such row and `completed_at <= asof - 10 min`; or (b) status `preparing`, `transcribing`, `verifying` or `retryable_failure`, no open job, and `updated_at <= asof - 10 min`. Hop `serve`, module `api.talktime`. A Recording in `pending` or `processing` is in progress, not dead. | No `transcript.talk_time_served` fact gives `partial(api)`; `db` still decides. A served status other than `transcript_pending` goes in the disagreement field. |
| `transcript.wake_lost` | DEGRADED when a `transcript.wake` decision for job J has `outcome = failed` and the first `transcript.claim` decision with `outcome = leased` for any job of J's transcription is more than 90 s after J's `created_at`, or there is none and `asof - created_at > 90 s`. Hop `wake`, module `api.lambdawaker`. A failed wake followed by a claim within 90 s is no finding. | No `transcript.wake` decision for a job gives `partial(api)`. |

## 5. Boundaries to adopt the kernel at

| Kernel call | Name | file:line | Note |
|---|---|---|---|
| `op` | `transcript.dispatcher.invoke` | `apps/transcription-dispatcher/src/index.ts:57` | Through C1's Lambda wrapper. Field `source` (`reconcile`, see `apps/transcription-dispatcher/src/dispatcher.ts:11`). |
| `op` | `transcript.chunk` | `apps/transcription-dispatcher/src/transcriber.ts:29` | `ok` after `control.complete` (`:68`) returns; `expected(late_completion)` on the 409 path (`:72`); `error(<safeErrorCode>)` in `reportAssignmentFailure` (`:148`). Fields `job_id`, `attempt`. |
| `op` | `transcript.finalize` | `apps/transcription-dispatcher/src/finalizer.ts:24` | `ok` at `:44`, `expected(late_completion)` at `:47-50`, `error` at `:54`. Add `job_id` and `cue_count`. |
| `decision` | `transcript.wake` | `apps/api/internal/adapters/aws/lambdawaker/waker.go:55` | `queued` at `:85`, `failed` at `:57`, `:75`, `:82`, each with `job_id`. |
| `decision` | `transcript.claim` | `apps/api/internal/httpapi/transcription_worker_claim.go:91` | One per job: `leased` when appended at `:126`; `invalid_assignment` `:99`; `lease_stale` `:107`; `url_failed` `:112`, `:117`, `:122`. One per call with `count=0`: `none` `:92`, `repository_error` `:95`. Fields `job_id`, `attempt`. |
| `decision` | `transcript.finalize_claim` | `apps/api/internal/httpapi/transcription_finalize.go:105` | `leased` or `none` (`:106`), with `job_id`. |
| `decision` | `transcript.job_retry` | `apps/api/internal/httpapi/transcription_worker.go:96` | After `service.Retry` returns: `retryable` or `dead_letter`, `error_code`, `attempt`. |
| `decision` | `transcript.job_complete` | `apps/api/internal/httpapi/transcription_worker.go:168` | `rejected(result.verification_failed)` at `:169`; `accepted` after `AcceptResult` (`:177`) returns nil; `error` at `:178-180`. |
| `decision` | `transcript.finalize_accept` | `apps/api/internal/httpapi/transcription_finalize.go:187` | `rejected(artifact.verification_failed)` at `:187`; `accepted` after `CompleteFinalizer` (`:191`) returns nil. |
| `decision` | `transcript.finalize_retry` | `apps/api/internal/httpapi/transcription_finalize.go:233` | After `RetryFinalizer` returns: `retryable` or `dead_letter`, `error_code`. |
| `op` | `transcript.document_read` | `apps/api/internal/httpapi/transcription_document.go:51`, `apps/api/internal/talktime/service.go:153` | Document route: `ok` `:77`, `expected(not_ready)` `:56`, `error(object_get)` `:61`, `error(artifact_mismatch)` `:68`, `error(decode)` `:74`. Talk-time: `error` at `:155`, `:159`, `:163`, `:168`, `ok` at `:170`. Never the body. |
| `fact` | `transcript.talk_time_served` | `apps/api/internal/httpapi/episode_talk_time.go:80` | `status` and the count of in-progress Recordings. |
| `transition` | `transcription_job` | `apps/api/internal/adapters/postgres/transcript_jobs.go:40`, `:61`, `:73`, `:120`, `:133`; `apps/api/internal/adapters/postgres/transcript_results.go:123`; `apps/api/internal/adapters/postgres/transcription_finalizer.go:36`, `:53`, `:73`, `:140` | After each commit returns nil. Recovered rows carry reason `lease_expired`. `:133` (Cancel) autocommits; emit after it returns. |
| `transition` | `transcript` | `apps/api/internal/adapters/postgres/transcription_finalizer.go:140` | `verifying` to `complete`, after commit. |

Don't add a transition at `apps/api/internal/adapters/postgres/transcript_jobs.go:127` (`Complete` has no production caller for transcripts). Admission commits inside slice 10's render transaction; don't edit `apps/api/internal/adapters/postgres/recording_render.go`. The checker reads admission from `db`.

## 6. Fault scenarios

All run on the local dev stack, which turns transcription on (`scripts/dev/dashboard-seed.mjs:13`) and serves artifacts from `<runtimeRoot>/dashboard-artifacts/__local-dashboard-artifacts` (`scripts/dev/dashboard-artifacts.mjs:5`), mounted read-only into the API (`scripts/dev/containers.mjs:39`). Orbs don't run transcription today, so no scenario uses one.

**Harness `scripts/transcription-dispatcher/local-run.mjs (new)`.** It imports `resolveDevConfig` (`scripts/dev/config.mjs:137`) for paths, the API URL and `databaseName`, and runs SQL with `docker exec <postgres container> psql -U postgres -d <databaseName>` as `scripts/dev/verify-stack.mjs:68` does. API calls send `Bearer <systemToken>` from `seed.json (dev runtime file)`, as `scripts/dev/verify-stack.mjs:71` does; any 401 or 403 exits non-zero.
1. `seed [--policy on_demand|automatic] [--no-request] [--prep-failed]` inserts by SQL a Tenant, a `cf_sfu` Space, an Episode ended 3 h ago with the given `config_snapshot` mode (default `on_demand`), a `completed` Recording, its transcription source, one source chunk using the columns of `CreateRecordingTranscriptionSourceChunk` (`apps/api/db/queries/transcription_sources.sql:41`) and a speaker-turn manifest that `apps/transcription-dispatcher/src/speaker-turn-manifest.ts:44` accepts, with one 5000 ms turn. Follow `apps/api/internal/adapters/postgres/restored_helpers_ext_test.go:113` for the other rows. It copies `apps/transcription-dispatcher/test/fixtures/mai-speech.flac` (16 kHz mono, 5.0 s) to the chunk's key in the host directory. Unless `--no-request`, it POSTs the request route and exits non-zero unless exactly one `transcription_chunk` job is `pending`. `--prep-failed` inserts a `recording_jobs` row of kind `transcription` in `terminal_failure` with `terminal_at = now() - interval '15 minutes'` and no transcription row. It prints `ep=<id> rec=<id> job=<id>`.
2. `run [--delay-seconds N]` waits N seconds, runs `pnpm --filter @chalk/transcription-dispatcher build`, installs a `globalThis.fetch` shim, then imports `buildHandler` from `apps/transcription-dispatcher/dist/index.js (build output)` (`apps/transcription-dispatcher/src/index.ts:12` reads `globalThis.fetch` at `:14`). It prints its pid, then calls the handler with `{source:"reconcile"}` until a call claims 0 jobs, at most 5 times. Env: `CONTROL_API_BASE_URL=https://control.chalk.invalid`, `CONTROL_API_AUDIENCE=chalk-control-api`, `CHALK_ENVIRONMENT=local`, `CHALK_RELEASE_ID=dev`, `CODESWITCH_PROVIDER=mai`, `DEEPINFRA_ENABLED=true`, `DEEPINFRA_ADAPTER_CONTRACT_VERSION=deepinfra-native-whisper-turbo.v1`, `DEEPINFRA_CORPUS_DIGEST` set to 64 zeros, `CLOUDFLARE_AI_ENABLED=false`, `TRANSCRIPTION_PRIVACY_GATE_ACCEPTED=true`, `TRANSCRIPTION_PROVIDER_TIMEOUT_MS=120000`, and every other variable `apps/transcription-dispatcher/src/config.ts` requires at a value inside its bound. Secrets: `workloadAuth` is the secret at `scripts/dev/dashboard-seed.mjs:20`, `openRouterToken` and `deepInfraToken` are `fake`. `console.info` and `console.warn` append JSON lines to `.logs/dev/dispatcher.jsonl`.
3. The shim forwards `https://control.chalk.invalid/<path>` to `<api url>/<path>` unchanged (the workload signature covers the path, not the host). It serves GET and PUT under `/__local-dashboard-artifacts/` from and to the host directory, `.flac` as `audio/flac` and `.json` as `application/json`. It answers `openrouter.ai` by `CHALK_FAKE_PROVIDER`: `ok` gives 200 `{"text":"hello there","segments":[{"start":0.1,"end":1.0,"text":"hello there"}],"words":[{"word":"hello","start":0.1,"end":0.5},{"word":"there","start":0.5,"end":1.0}],"usage":{"cost":0}}`; `rejected` gives 400 (terminal by `apps/transcription-dispatcher/src/errors.ts:93`); `empty` gives 200 `{"text":"","segments":[],"words":[],"usage":{"cost":0}}`; `hang` never resolves. Any other host fails the run.
4. `talk-time <ep>` calls the talk-time GET and prints the status.

**Checker inputs.** `CHALK_DIAGNOSE_LOCAL_LOGS=.logs/dev` makes `scripts/diagnose-call/sources.mjs` read `api.log` as `api` and `dispatcher.jsonl` as `lambda` (JSON lines, skip lines that don't parse) instead of Axiom. `CHALK_DIAGNOSE_R2_DIR=<host artifact dir>` reads `r2` from disk; in other environments `CHALK_DIAGNOSE_R2_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` drive a SigV4 GET built with `node:crypto`, with no new dependency. Run `pnpm diagnose:call <ep> --slice transcript`; `--slice transcript` runs only these rules and computes coverage over `db`, `api`, `lambda` and `r2`. Values in angle brackets come from the run; every other character must match.

| # | Fault | Steps | Expected output |
|---|---|---|---|
| 1 | Provider rejects | `seed`; `CHALK_FAKE_PROVIDER=rejected run` | below |
| 2 | Lambda killed mid-chunk | `seed`; `CHALK_FAKE_PROVIDER=hang run`; `kill -9 <pid>` once `dispatcher_claimed` is in `dispatcher.jsonl`; `update artifact_jobs set lease_expires_at = now() - interval '1 minute' where id = '<job>'` | below |
| 3 | Provider returns no words | `seed`; `CHALK_FAKE_PROVIDER=empty run` | below |
| 4 | Stored document vanishes | `seed`; `CHALK_FAKE_PROVIDER=ok run`; `rm` the file at the transcription's `artifact_key` under the host directory | below |
| 5 | Talk-time pending forever | `seed --policy automatic --no-request --prep-failed`; `talk-time <ep>` prints `transcript_pending` | below |
| 6 | Wake lost | `seed` (the dev stack has no Lambda, so the wake fails at `apps/api/internal/adapters/aws/lambdawaker/waker.go:57` or `:82`; the decision takes `input.JobID`, `apps/api/internal/transcripts/service_types.go:164`); `CHALK_FAKE_PROVIDER=ok run --delay-seconds 120` | below |
| 7 | Late | `seed`; `CHALK_FAKE_PROVIDER=ok run`; `update transcriptions set created_at = completed_at - interval '65 minutes' where recording_id = '<rec>'` | below |

```text
episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
F-xxxx transcript.failed job_xxxx +mm:ss hop=provider module=dispatcher.provider
fact: job dead_letter error_code=provider_rejected attempt=1/4 [db]; expected completed
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=degraded coverage=partial(lambda) asof=<t> rules=<n>
F-xxxx transcript.attempt_lost job_xxxx +mm:ss hop=chunk module=dispatcher.runtime
fact: lease expired, no accepted result or retry for attempt 1 [api,db]; expected result within lease
gap: lambda evidence_gap after dispatcher_claimed
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
F-xxxx transcript.speech_dropped rec_xxxx +mm:ss hop=provider module=dispatcher.provider
fact: speech_ms=<ms> segments=0 [db]; final document 0 cues [r2]; expected cues
hypothesis: provider returned no words for audio the -45 dB gate counted as speech; falsified by playback with no voices
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
F-xxxx transcript.unreadable rec_xxxx +mm:ss hop=store module=storage.r2
fact: readback 404 [r2]; transcription complete [db]; expected object with recorded size and sha256
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
F-xxxx transcript.talk_time_stuck ep_xxxx +mm:ss hop=serve module=api.talktime
fact: no transcription, transcription prep terminal_failure 15 min ago [db]; talk-time transcript_pending [api]; expected no pending
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=degraded coverage=complete asof=<t> rules=<n>
F-xxxx transcript.wake_lost job_xxxx +mm:ss hop=wake module=api.lambdawaker
fact: wake failed [api]; first claim +<s>s after job created [api,db]; expected within 90s
next: diagnose evidence F-xxxx

episode ep_xxxx outcome=degraded coverage=complete asof=<t> rules=<n>
F-xxxx transcript.late rec_xxxx +mm:ss hop=claim module=dispatcher.queue
fact: completed 65 min after created [db]; expected within 60 min
next: diagnose evidence F-xxxx
```

In scenario 3, `<ms>` is about 2300 for this fixture; if it reads below 2000, the scenario is invalid, not passing. Scenario 2 must not also print `transcript.stuck`, because the lease expired only 1 minute ago.

**Healthy control.** `seed`, then `CHALK_FAKE_PROVIDER=ok run` started within 90 s of the seed, with both checker inputs set. The local wake fails here too, and that must not produce `transcript.wake_lost`. The Space is `cf_sfu` (`scripts/dev/dashboard-seed.mjs:50`). Expected, with no `transcript.*` finding, no gap line and no backstop:

```text
episode ep_xxxx outcome=healthy coverage=complete asof=<t> rules=<n>
```

Deleting any one witness from a positive fixture in `scripts/diagnose-call/scenarios-transcript.mjs (new)` (the `api` rows, the `lambda` rows, the `r2` readback, or one `db` reader) must yield a gap line, never `outcome=healthy coverage=complete`.

## 7. Out of scope and traps

- A 202 from the wake, a 200 from `complete`, a resolved `fetch` or a `dispatcher_completed` log (`apps/transcription-dispatcher/src/transcriber.ts:69`) is not proof of a transcript. Only a `complete` row plus a passing `r2` readback is.
- The dispatcher error code, `transcript.job_retry` and `artifact_jobs.error_code` are one witness, and so are `provider_observed_duration_ms` and `quality.segmentCount`. Never count them twice.
- Never derive healthy from the absence of a dispatcher error. With no `lambda` source the coverage is `partial(lambda)`, never `complete`.
- An empty document is not proof of silence; `speech_dropped` decides from the audio measurement.
- Never log or emit transcript text, cue text, audio, display names (`DisplayNameSnapshot`), signed URLs, lease tokens, object keys, provider tokens, workload signatures or authorization headers. Counts, codes and handles only. Don't add redaction and don't remove existing hashes; C1 owns that.
- Wrap only the rows in section 5 with kernel calls.
- Don't fix these two bugs here; report them, their fixes are separate changes. First, the claim handler leases jobs and then answers 500 or 503 at `apps/api/internal/httpapi/transcription_worker_claim.go:99-124`, which orphans that job's lease and the lease of every job already appended in the batch for the 15-minute `WorkLeaseDuration` (`apps/api/internal/transcripts/work_authority.go:7`). Second, `transcriptInProgress` (`apps/api/internal/talktime/service.go:177`) counts a dead Recording as in progress, so talk-time stays pending forever.
- The checker never writes to the database and never calls `RecoverExpired` (`apps/api/internal/transcripts/service_lifecycle.go:84`, no production caller).
- Webhooks for transcript start and completion (`apps/api/internal/adapters/postgres/transcript_jobs.go:69`, `apps/api/internal/adapters/postgres/transcription_finalizer.go:136`) are slice 12. Recording render and transcription audio preparation (`recording_jobs` kind `transcription`) are slice 10; this slice only reads their end state. A database outage answering 503 (`apps/api/internal/adapters/postgres/transcript_repository_failure.go:20`) is slice 14; this slice reports only the job state it leaves.
- Don't edit C1 to C4 contracts, sibling slice files or `infrastructure/transcription-dispatcher/config.ts`. Shipping dispatcher telemetry in production is an operator step.
