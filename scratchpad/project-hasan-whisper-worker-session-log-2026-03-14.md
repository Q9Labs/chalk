2026-03-14 00:12 PKT
- prod investigation: queued smoke job stayed behind live processing backlog; Redis showed old items stuck in `transcription:jobs:processing`
- telemetry: Axiom shows deploy boot at `2026-03-13 18:43:26Z`, download finished, `faster_whisper` started a `01:09:29` file, VAD completed, then no completion/failure event returned
- confirmed: API logged real timeout for job `836076ce-697e-4b7a-87c1-047650f703d8` after `4h`; same class of old work can be replayed by recovery
- fix: worker now fails jobs older than `WHISPER_MAX_JOB_AGE_SECONDS` before reprocessing; added regression test
- fix: processing-lock refresh moved from in-process thread to separate heartbeat process after prod lock TTL was observed counting down during active transcription
- infra: restored lean prod whisper defaults to `c7i.xlarge` + `4` CPU threads per old rollback note to reduce long-recording stalls on `c7i.large`
