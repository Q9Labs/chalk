---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": patch
---

Preserve startup and exhausted-recovery error codes and recoverability across
join rejections, snapshots, and error events. Add the public
`connection.sync_hello_timeout` code for the Sync startup handshake deadline;
existing Sync/SFU/access/environment codes retain their meaning. Integrators
should handle the new code alongside `connection.sync_start_failed` and keep a
fallback for future additions. React failed screens show stage-specific guidance
and a code reference without exposing provider messages. Recoverable device
capture warnings still allow joining with devices off.
