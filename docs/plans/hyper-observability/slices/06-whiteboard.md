# Slice 6: whiteboard

## 1. Scope and item

An Episode's whiteboard has its own Sync socket, a durable Postgres scene and revision, and a client replica. Follow an edit from the SDK's pending store through the Sync write and fan-out to each recipient. Observe draw access, snapshot assembly for new subscribers, and the effective follow state. Do not change who can draw, when a board opens or how a camera follows.

**Population.** Judge the Episode's declared Participant seats. The current Episode declaration does not independently say which seats subscribed to the board or which edits they were present for. No board rows does not mean the board was unused. Keep the corresponding checks unknown until their positive witnesses exist. Do not treat a seat that joined after an edit as having missed its live broadcast.

**Files owned.** The board transport and factory in the TypeScript client, the existing web and native whiteboard follow owners, the Sync whiteboard socket modules and a board-specific observation helper, the closed SDK telemetry vocabulary and its generated contracts, the board registry, rules, fixtures, proof harness and output fixtures. Reuse the foundation's event delivery, authority, and verdict interfaces.

## 2. Symptom catalogue

| Code | User words | Party | Outcome |
|---|---|---|---|
| `board.edit_not_committed` | “My drawing didn't show up for them” | Author | Broken when the SDK definitively fails this edit before it can send or after a terminal refusal other than access denial. |
| `board.out_of_sync` | “The board is out of sync” | Recipient | Broken when a same-scene update skips a revision at the SDK after a baseline. |
| `board.draw_denied` | “I can't draw” | The Participant without access | Expected when the SDK resolved draw access to blocked or a draw was refused for lack of permission. |
| `board.snapshot_mismatch` | “The board was missing when I joined” | Snapshot recipient | Broken when the assembled snapshot differs in revision or element count from the same Sync snapshot request. |

Follow state is an observed transition between independent, manual and automatic following. It is not a finding by itself: current auto-follow is intentional behavior, and changing it is out of scope.

## 3. Witnesses

| Witness | Source | Meaning |
|---|---|---|
| `board.client_edit` | Author SDK | Stored locally, submitted, committed, denied or failed, keyed by the operation ID. |
| `board.sync_edit` | Sync | New commit, duplicate receipt or refused operation, keyed by the operation ID. A successful new commit is after the repository transaction. |
| `board.sync_delivery` | Sync | An update queued for the socket's actual push, keyed by recipient, scene and revision. This is not a client receipt. |
| `board.client_delivery` | Recipient SDK | Complete update delivered to subscribers, its previous baseline, and whether the revision jumped. Multipart frames count once. |
| `board.client_draw` | SDK | Initial and changed resolved draw access, plus draw permission refusals. |
| `board.sync_snapshot`, `board.client_snapshot` | Sync and recipient SDK | Counts and scene/revision paired by the snapshot request ID. Sync reads the durable scene; the client reports only after all pages assemble. |
| `board.follow` | SDK UI | Effective follow mode and target after commit. No camera coordinates, cursor samples or board contents. |

Every client witness is scoped by the SDK telemetry credential and outbox source. Board correlation identifiers are validated UUIDs, not new public handle kinds. Keep scene IDs and revisions separate; a scene change legitimately resets the revision.

## 4. Rule conditions

A finding needs positive evidence even if the enclosing source has incomplete delivery. Passing needs the required positive rows and the kernel's completeness checks. In particular:

- A locally failed store or a terminal non-access refusal gives `board.edit_not_committed`. For a stored or sent edit, require the positively observed successful author receipt and the matching durable Sync commit (a duplicate receipt is allowed). A policy refusal is handled by `board.draw_denied`, not reported as storage loss.
- A skipped revision is a recipient replica observation. A matching Sync push supplies upstream evidence; a missing push does not prove Sync lost it. Do not infer a drop from the absence of an update. To pass, require observed updates with the same scene/revision on both sides of the recipient socket.
- A measured blocked draw state or a permission refusal gives `board.draw_denied`. Open, closed and read-only boards are not conflated. To pass, require an affirmative allowed state.
- A pair of snapshot witnesses for the same Participant and request ID must agree on scene, revision and count. A mismatch is a finding. An incomplete or missing pair remains unknown. Equal metadata does not prove exact element content.

## 5. Boundaries to adopt the kernel at

- SDK `whiteboard/v1-client.ts`: record submit, pending-store result, send/commit and terminal refusal; welcome and draw-access changes; complete updates and assembled snapshots. Do not count snapshots as edit delivers. Send typed facts through the existing SDK outbox.
- Sync `transport/socket_whiteboard_v1/{operations,failure,delivery,snapshot}.ex`: record the repository result outside its transaction, the actual socket push, and snapshot pages prepared from a durable read. Scope fields from the authenticated socket identity.
- Web `SpaceStage.tsx` and native `ContentTile.tsx`: observe the effective follow state at the committed owner. Do not touch the camera or the follow selection.

## 6. Fault scenarios

Drive the real SDK transport against a dev Sync server and Postgres, with two Participant seats and a late third seat. Run the same journey with each fault independently. Save kernel findings and coverage; a fixture exercising the rule is not a substitute for the stack run.

| Fault | Injection | Expected finding detail |
|---|---|---|
| Local edit never sent | Pending-store write rejects without touching Sync | `board.edit_not_committed`, author, `hop=local_store module=sdk.whiteboard` |
| Recipient drops one update | Suppress one complete update on one recipient socket, then deliver the next | `board.out_of_sync`, recipient, `hop=replica module=sdk.whiteboard` |
| Draw denied | Change draw policy through the board API and try a draw as the blocked Participant | `board.draw_denied`, blocked Participant, `hop=policy module=sdk.whiteboard` |
| Late snapshot truncated | Remove an element from a valid snapshot page for the late Participant without modifying the server snapshot | `board.snapshot_mismatch`, late Participant, `hop=snapshot module=sdk.whiteboard` |

Healthy control: both initial seats draw and receive each other's edit; the late seat gets the durable board. No board findings. A late seat with no live edits intentionally remains unchecked for edit and live delivery. Check each symptom's fixture with its required witnesses removed; none may pass on missing rows.

## 7. Out of scope and traps

No scheduled checker, no changes to draw/follow behavior, and no bulk camera or board replay collector unless the fault runs show that these observations cannot distinguish a fault that replay distinguishes. The metadata excludes element bodies, coordinates, files, names, claims and credentials. A replica revision is not proof of a painted canvas or identical content. A final dropped frame with no later baseline is not a proven revision gap. Recovering a later snapshot does not erase a proved earlier gap.
