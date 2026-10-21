---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react": patch
"@q9labsai/chalk-react-native": patch
---

Preserve startup and exhausted-recovery error codes and recoverability across
join rejections, snapshots, and error events. Add the public
`connection.sync_hello_timeout` code for the Sync startup handshake deadline;
existing Sync/SFU/access/environment codes retain their meaning. Integrators
should handle the new code alongside `connection.sync_start_failed` and keep a
fallback for future additions. React failed screens show stage-specific guidance
and a code reference without exposing provider messages. Recoverable device
capture warnings still allow joining with devices off.
Media changes before Sync is live return recoverable `connection.invalid_state`
with plain join/reconnect guidance. Failed surfaces without a known code omit
the reference instead of inventing one.

Exhausted media confirmations use existing recoverable `media.timeout` only for
media commands. Reaction acknowledgement timeouts use existing recoverable
`collaboration.unavailable` with unconfirmed-delivery wording. Native media
toasts show safe mapped guidance instead of raw exception messages.
