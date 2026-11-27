# Re-arm recording transcription

`recording-transcription-rearm` gives an expired, never-claimed transcription
job one fresh source window while its encrypted capture source is still
retained. The normal render-pool claim, preparation, dispatcher and
transcription worker path then produce the transcript. It never edits the
immutable Episode snapshot and a deployment never runs it.

Inject `CHALK_DATABASE_URL` and the `CHALK_R2_*` settings through the operator
environment, never in arguments or logs.

## Inspect, then apply

```sh
(cd apps/api && go run ./cmd/recording-transcription-rearm --batch-size 25)
(cd apps/api && go run ./cmd/recording-transcription-rearm --batch-size 25 --apply --operator "$USER" --reason "restore expired transcription window")
```

Inspect one or more recordings explicitly with repeated `--recording <id>`;
the flags may be combined with a batch inventory. The default is a dry run on
read-only sessions. It verifies that the Tenant and Episode still allow
transcription, capture succeeded, no transcription source or transcript exists,
source cleanup has not started, and the data key, presentation and capture
bundle records exist. It then HEADs every referenced R2 object. A storage error
is reported as `unverifiable`, not as missing.

Apply first requires the renewal-aware migration to be applied. Run it only
after the API rollout carrying this release is complete. It rechecks eligibility
under the recording pipeline and job locks, writes an append-only renewal,
moves the job back to `pending` with a new fencing generation, clears the
terminal error, and records the expired attempt in failure history so the
render execution deadline starts at the re-arm. The new source expiry is the
re-arm time plus the Episode snapshot's transcription source window, capped at
the capture retention deadline and the earliest pending recording-source
cleanup time. Repeating an apply is safe: a job that is already pending, leased
or complete reports `already_rearmed` or `completed` and does not change.

Rolling the API back after a re-arm re-expires renewed jobs because the old
sweep does not read renewals. If a rollback is necessary, expect those jobs to
terminalize again and re-run this command only after the renewal-aware release
is fully restored.

Start with a small batch and watch jobs finish before continuing. Continue a
batch with `--after-recording` set to the report's `next_after_recording`, and
keep that cursor private. If storage could not be verified, rerun the same
batch without moving the cursor. An interrupted apply is safe to repeat.

The command refuses a recording whose capture retention deadline has passed,
whose cleanup has started, whose job was claimed, or whose transcription source
or transcript already exists. After five recorded re-arms the execution-deadline
history reaches the schema's retry bound and the job is reported as
`retry_limit_reached`.

Telemetry uses `CHALK_API_OTLP_ENDPOINT`. Without it, trace IDs stay in the
ledger and nothing is exported.
