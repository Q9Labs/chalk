# SFU publication lifecycle model

TLA+ model of `SFUClient`'s five-state local publication lifecycle
(`sdks/typescript/client/src/media/client.ts`): every owned publication moves
`pending → confirmed → held → retiring → retired` while reconnect, connection
replacement, user pause/resume and `stop()` race asynchronous SFU publish
responses.

Run it:

```sh
tools/formal/sfu-publication-lifecycle/run.sh
```

The script verifies the code anchors, proves every invariant holds of the
"none" variant, then proves each `Break` variant in `breaks` violates the rule
it guards. TLC runs with an isolated `mktemp -d` `TMPDIR`, so parallel
executions never share fingerprint state.

## What the model covers

- `pending`: a publish request is in flight; a response may confirm it, fail
  it, or land after the publication already went `retiring` (`LateConfirm` —
  the response attaches the handle but cannot resurrect the publication).
- `confirmed`: the publication carries the SFU publication id.
- `held`: a `user_pause` retirement that keeps the bundle transport parks the
  publication with its handle for reuse (`#holdOwnedPublication`).
- `retiring`: entered from `pending` (no handle), `confirmed` or `held` with a
  `LocalPublicationRetirementCause`; a late response can still attach a handle.
- `retired`: terminal; the slot goes idle for the next publication.
- `Reconnect`: a `confirmed` or `held` publication on a replaced connection
  retires — `#heldPublication` only reuses a publication on the current
  connection.
- `Stop`: `stop()` retires every owned publication at once and wins over any
  response still in flight.
- Publish/retire serialization: the publish path awaits `#retirement` before
  it publishes, so `Create` is disabled while another publication is still
  live or retiring. A publication retired while `pending` keeps waiting for
  its response because `#retiringOwnedPublications` only closes ones that
  carry a handle.

## Rules checked

| Rule                  | Meaning                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `AtMostOneLive`       | one source never has two live publications; reuse finds the confirmed/held one first |
| `ConfirmedHasHandle`  | confirmed and held publications always carry the SFU id                              |
| `HeldKeepsHandle`     | a parked publication keeps the handle it was confirmed with                          |
| `ResumedKeepsHandle`  | resuming a held publication reuses the parked handle, no second publish              |
| `RetiringKeepsCourse` | once retiring, a publication never returns to a live phase (stop wins)               |
| `StopRetiresAll`      | after `stop()` nothing is left live                                                  |
| `RetiredStaysRetired` | no late response or reconnect recreates a retired publication                        |

## Bounds and assumptions

Two publication slots and three SFU ids bound the state space; that is enough
to overlap a replacement (`pending`) with its predecessor (`retiring`). The
model abstracts SDP negotiation, tracks and connection internals to the
lifecycle fields, and assumes one media source per slot — the per-source rules
in the client are symmetric. Liveness (a `retiring` publication eventually
closes) is not checked; the model proves no transition returns to a live
phase, which is the user-facing risk.
