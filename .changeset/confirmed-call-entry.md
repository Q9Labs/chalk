---
"@q9labsai/chalk-client": minor
---

Count a person in a call only after they have fully entered it. The client asks
Sync for entry confirmation on the Sync URL (`entry_confirmation=1`). When Sync's
`welcome` grants it, the client sends `entered` once Sync is live and media has
started, so a failed connection no longer leaves a ghost participant or an
attendance record. Against an older Sync, the client sends the previous hello and
Sync confirms entry at hello as before. Custom `createSyncClient` implementations
must now provide `confirmEntered()`.

When entry fails, the client cancels the pending admission through the new
`cancelEpisodeParticipantJoin` endpoint (`POST .../participants/:participant_id/cancel-join`),
and a retry keeps the same person. If Sync reports `entry timeout` because the
pending seat expired before entry, the connection fails as a retryable
`sync_start_failed` instead of rejected access, and the client does not reconnect
the expired seat with the same grant.

Rollout: apply the database migration first, then upgrade Sync, then the API and
this client. This client also works with an older Sync, and published 5.0.x
clients keep hello confirmation with the new Sync.
