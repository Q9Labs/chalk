# Recording whiteboard assets

A Recording timeline points at a whiteboard through `shared_content_changed`
(`sceneId`, `revision`, `stateAssetId`). The asset body has two versioned
formats: a static `recording_whiteboard_state.v1` and a
`recording_whiteboard_history.v1` (an initial state plus revision-ordered
updates). Frozen Recordings keep the static format and must keep exporting. The
decoders live in the shared Recording whiteboard code in the React SDK and the
renderer; `apps/api/internal/recordingpresentation` builds the assets.

## Invariants

- A history belongs to one scene. Clearing the board starts a new scene. Hiding
  does not clear it, and writes made while hidden show when the board returns.
- A timeline shows the history at its `sharedContent.revision`. A later change
  must never appear early, so the decoder rebuilds from the initial state on a
  backwards seek.
- A change keeps its original timestamp, so it shows on the next frame instead
  of in a batch. Chalk does not invent pointer positions the source never
  committed.

## Release order

Release the Render image with both decoders before the API that emits histories.
An old Render rejects a history and fails the Export, which is better than a
stale board. The timeline schema and database do not change. Consumers of the
React Recording view need the updated React package before they read histories.

Roll back the API, never Render, while any frozen history can still be
retried. Activate the API only after the new Render serves every Export,
including retries. The managed release stops runtime services, so deploy
between classes.
