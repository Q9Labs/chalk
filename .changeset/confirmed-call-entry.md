---
"@q9labsai/chalk-client": minor
"@q9labsai/chalk-react-native": patch
---

Count a person in a call only after they have fully entered it. The built-in
browser and React Native Sync clients ask Sync for entry confirmation on the Sync
URL (`entry_confirmation=1`). When Sync's `welcome` grants it, the client sends
`entered` once Sync is live and media has started, so a failed connection no
longer leaves a ghost participant or an attendance record. Against an older Sync,
the client sends the previous hello and Sync confirms entry at hello as before.

`confirmEntered()` on a custom `createSyncClient` implementation is optional.
Implementing it, and building `V1SyncClient` with `entryConfirmation: true`, adds
the confirmed entry above. Without it, the client never asks for entry
confirmation and Sync confirms the entry at hello, as in 5.0.x. `V1SyncClient`
asks only when it is built with `entryConfirmation: true`.

When entry fails, the client cancels the pending admission through the new
`cancelEpisodeParticipantJoin` endpoint (`POST .../participants/:participant_id/cancel-join`),
and a retry keeps the same person. If Sync reports `entry timeout` because the
pending seat expired before entry, the connection fails as a retryable
`sync_start_failed` instead of rejected access, and the client does not reconnect
the expired seat with the same grant.

The admission contract declares the 409 `participant.not_active` response when
a retried admission names a participant that has already left. The public
`AdmitEpisodeParticipantError` union stays compatible with 5.1.0; this response
uses the existing `HttpClientError` channel, with its code in the response body.
The dashboard reads that code and retries once with a fresh join key.

Rollout: apply the database migration first, then upgrade Sync, then the API and
this client. This client also works with an older Sync, and published 5.0.x
clients keep hello confirmation with the new Sync.
