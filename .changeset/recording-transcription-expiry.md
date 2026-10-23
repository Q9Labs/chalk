---
"@q9labsai/chalk-client": minor
---

Recordings now report when their transcription source expires, as
`transcription_preparation.expires_at`. A transcript can be requested only
while `transcription_preparation.status` is `ready` and this time is ahead. It
is never later than `source.expires_at`, and it can be much earlier, because a
Space's transcription source window is often shorter than its video retention. The field is
absent when transcription is disabled or no transcription source exists yet.
