# Changelog

## 5.2.0

### confirmed-call-entry

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

## 5.1.0

- Bound each Sync and whiteboard WebSocket opening attempt to the existing 30-second startup allowance, or to `syncStartupTimeoutMs` when set. `syncStartupTimeoutMs` accepts 1 to 60,000 ms, and each attempt gets at least 10 seconds. The whiteboard retries a timed-out attempt through the existing reconnect backoff, and so does Sync once the call is live, such as after a drop or a return to the foreground. A first join does not retry a Sync socket that never opens: the join fails when its startup wait of `syncStartupTimeoutMs` ends, and a setting below 10 seconds ends the join before the attempt's own 10-second minimum. The client's 10-second default does not apply to React Native.
- Size the call from the enclosing safe-area frame instead of the global window size. Orientation and call-region arrangement now follow the space `Chalk` is given, so a call rendered inside a smaller container, split view or modal lays out for that container rather than the whole screen. Full-screen calls look the same.
- Render registered native WebRTC host components so remote screen shares and camera video no longer disappear when React Native exports the video view as a string.
- Disable reaction sending and media enable controls until Sync is live, and keep recovery notices non-blocking.
- Show plain connection-not-ready and confirmation-timeout media feedback without exposing raw internal exception messages.
- Run the Android module API compatibility check only in the Chalk repository, so an app's `./gradlew check` no longer needs Chalk's test fixtures or the API 30 platform.

## 5.0.1

- Fix the Android 11 crash when joining a call by isolating API 31 audio listeners from React Native module signatures.

## 5.0.0

- Rebuild `Chalk` with a call header, Spotlight and Grid layouts, a dock, People and Chat sheets, and status pages.
- Add `ChalkArrival`, light and dark color schemes, call sounds and haptics, and permission recovery callbacks.
- BREAKING: replace the old layout and theme exports with `ChalkProps`, `ColorScheme`, and `Palette`. Remove the `/appearance` and platform-specific entry points.
- BREAKING: call `onLeave` when the user chooses Home on the post-call page, not immediately after leaving.
- BREAKING: add Expo audio, haptics, clipboard, document picker, file system, and `expo-crypto` peers. Add Reanimated, Worklets, Gesture Handler, and Safe Area Context peers.
- Use the v5 client, whiteboard, and facehash packages.

See the [project changelog](../../../CHANGELOG.md) for the full export removals and migration details.
