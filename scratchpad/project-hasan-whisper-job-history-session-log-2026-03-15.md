2026-03-15 17:58 PKT
- goal: durable Whisper job history in Postgres; admin visibility for historical processed jobs + metadata
- shape: new `whisper_transcription_jobs` table + sqlc queries + provider write-path hooks + admin list/stats routes
- note: router admin test needed `Admin.Enabled=true`; route registration is config-gated
2026-03-15 18:21 PKT
- tightened metadata: persist `audio_storage_path`, not presigned `audio_url`
- added live processing admin view by reading Redis `:processing` list and joining `whisper_job_id` back to Postgres history rows
