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

Sync assigns each entry a participant-local generation and returns it in
`welcome`. The client resumes that generation through the `entry_generation`
WebSocket query, even after refreshing its credential. Confirmation advances
ownership only forward and voids older pending Leaves. Acceptance and completion
both fence a Leave against the confirmed generation, so reattaching the same
seat cannot let the previous mount remove it. Previous Sync ignores this query.
Legacy sockets receive a server generation internally without changing their
welcome frame, and still confirm at hello. Participants created before seat
storage acquire it on their first live hello. When recovery replaces the Sync
client, it confirms the replacement entry before reporting recovery complete.
Completed startup also survives reconnecting from an older Sync to an upgraded
one. Recovery can finish while a previous entry's Leave is pending, and an
uncertain confirmation reply checks that entry's generation before acknowledging it.
A claimed Leave blocks later entry
admission until its provider work settles. An entry admitted before that claim
defers the older provider work until confirmation or its two-minute startup
lease expires, preventing old cleanup from closing the new entry's media.

Rollout: apply the database migrations first, then upgrade Sync, then the API and
this client. This client also works with an older Sync, and published 5.0.x
clients keep hello confirmation with the new Sync.
