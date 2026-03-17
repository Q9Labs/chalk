2026-03-15 17:58 PKT
- goal: durable Whisper job history in Postgres; admin visibility for historical processed jobs + metadata
- shape: new `whisper_transcription_jobs` table + sqlc queries + provider write-path hooks + admin list/stats routes
- note: router admin test needed `Admin.Enabled=true`; route registration is config-gated
2026-03-15 18:21 PKT
- tightened metadata: persist `audio_storage_path`, not presigned `audio_url`
- added live processing admin view by reading Redis `:processing` list and joining `whisper_job_id` back to Postgres history rows
2026-03-15 07:07 UTC
- pushed `master`; API deploy run `23101078245` green; web run `23101078247` green
- verified prod DB table exists: `whisper_transcription_jobs`, row count `0`
- real prod whisper soak passed on 20m27s public Librivox chapter
- prod test job `27cc175b-041e-4184-a55e-1b0741aad9ac`
- worker log: `Processing audio with duration 20:27.620`, VAD removed `00:58.692`, completion logged at `02:06:12 UTC`
- result summary: `status=completed`, `language=en`, `duration_seconds=1227`, `word_count=2904`, `processing_time_seconds=264.18`
2026-03-15 07:18 UTC
- prod add-participant failure traced to missing `rooms.screen_annotation_state`
- root cause: checked-in migration `013_screen_annotations.sql` existed, but embedded runtime migrations skipped it
- applied `013_screen_annotations.sql` to prod and local `chalk` DB
- patched embedded migrations in `apps/api/internal/infrastructure/postgres/postgres.go`
2026-03-15 07:29 UTC
- persistent note requested: DB migrations must be applied + verified locally and prod every time schema changes land
- AGENTS updated with migration vigilance note and recommendation to automate PlanetScale Postgres migrations in GitHub Actions / deploy path
