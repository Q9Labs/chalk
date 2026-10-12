# Recording whiteboard assets

A `recording_presentation.v1` timeline still uses `shared_content_changed` with
`{kind: "whiteboard", sceneId, revision, stateAssetId}`. The asset kind remains
`whiteboard_state`. The asset body supports two explicitly versioned formats:

- `recording_whiteboard_state.v1`: `schemaVersion`, `sceneId`, `revision`,
  `appState`, and canonically ordered `elements`. Existing frozen Recordings keep
  this format and must continue to Export.
- `recording_whiteboard_history.v1`: `schemaVersion`, `initial` (an entire
  `recording_whiteboard_state.v1` object), and `updates`. Each update has a
  strictly increasing `revision` and a nonempty `elements` array of winning
  wire elements, including deletion tombstones. Revisions may skip empty
  updates and presentation/permission operations. Replay replaces elements by
  ID and orders the resulting scene by element index, then ID.

A history asset belongs to one scene. Clearing creates a new scene and a new
initial state; hiding does not clear the scene. Writing while hidden is retained
and appears when the board is presented again. A timeline selects a history's
state at its `sharedContent.revision`; later changes must not be visible early.
The shared decoder supports backwards seeks by rebuilding from the initial
state. Render's time-ordered pass applies each change once and retains only its
latest painted canvas. The history is capped at 64 MiB; the existing 256-asset,
100,000-event and 64-MiB timeline bounds remain unchanged.

Each winning submitted change retains its original timestamp. At 15 fps, it
appears on the next frame (less than 66.7 ms quantization), not in multi-second
batches. This does not invent intermediate pointer positions absent from the
committed source.

## Compatibility and release

Release the Render image with both asset decoders **before** the API that emits
histories. An old Render accepts the unchanged timeline but rejects a history
asset's schema when painting; the Export fails, rather than silently showing a
stale board. A new Render accepts both old static assets and new histories.
`recording_presentation.v1` does not change: the separately versioned asset
body gains `recording_whiteboard_history.v1`. No database migration or SDK wire
protocol change is introduced here. The React Recording view also uses the
shared decoder; consumers of that view need the updated Chalk React package
before reading new history assets. The Render bundles it from source.

The companion large-board work requires Sync's changed-element commit, then
the widened receipt migration before API/Sync restart. Activate this API only
after the new Render is available for every Export, including retries. Existing
frozen presentations remain readable; unfrozen older capture sources are
rebuilt with the new format, including legacy full-board resends. The managed
release stops runtime services: deploy between classes, not during one. Rollback
must keep the new Render while any frozen history assets can still be retried.
