---
name: sfu-publication-lifecycle-formal
description: 'Model-check the CloudflareSFUClient local publication lifecycle with TLA+: pending, confirmed, held, retiring and retired across reconnect, connection replacement, user pause/resume and stop(). Use when a change touches sdks/typescript/client/src/media/client.ts publication lifecycle fields, #markPublicationRetiring, #holdOwnedPublication or #heldPublication, when the "SFU publication lifecycle model" CI check fails, or to prove a stop-wins or pause/resume ordering bug.'
---

# SFU publication lifecycle model

The model is `tools/formal/sfu-publication-lifecycle/SfuPublicationLifecycle.tla`
with its bounds in `SfuPublicationLifecycle.cfg`. `tools/formal/sfu-publication-lifecycle/run.sh` verifies the code
anchors in `anchors`, checks every invariant on the real-code variant, then
proves each broken variant in `breaks` trips the rule it guards. `findings`
lists rules the real code violates today (none yet). Coverage and the CI
command live in `tools/formal/manifest.json`.

```sh
tools/formal/sfu-publication-lifecycle/run.sh
```

TLC needs Java 11+; the jar pin is `tools/formal/tla2tools.sh`. The script runs
every TLC instance under its own `mktemp -d` `TMPDIR`, so parallel runs cannot
race on fingerprint state.

## The states and what they mean

`pending → confirmed → held → retiring → retired`, matching the
`lifecycle` union on `OwnedLocalPublication` in
`sdks/typescript/client/src/media/client.ts`:

- `pending`: publish request in flight, no handle yet.
- `confirmed`: the SFU assigned a publication id (`LocalPublicationHandle`).
- `held`: a `user_pause` retirement parked the publication with its handle
  (`#holdOwnedPublication`), so a resume needs no new publish.
- `retiring`: `#markPublicationRetiring` from any live phase; `handle` is
  null only when it came from `pending`.
- `retired`: terminal; the publication leaves `#ownedPublications`.

## The rules

- `AtMostOneLive`: one source has at most one live publication.
- `ConfirmedHasHandle`, `HeldKeepsHandle`, `ResumedKeepsHandle`: handles are
  always present once confirmed and are reused across pause/resume.
- `RetiringKeepsCourse`, `StopRetiresAll`, `RetiredStaysRetired`: stop wins —
  a late SFU response or a reconnect can never resurrect a publication that
  was asked to retire.

## When it fails

1. An anchor fails: find the new code that replaced the fragment, update the
   anchor and re-check whether the model still describes the transition.
2. An invariant fails on `none`: read the counterexample in the TLC log the
   script prints; the state list is the lifecycle of each slot.
3. A `break` stops tripping its rule: the model lost the ability to see that
   bug — keep the break honest before trusting the green run.

To see whether your change touched covered code:

```sh
git diff --stat <coverage commit> -- $(node tools/formal/select-models.mjs --paths sfu-publication-lifecycle)
```

CI runs the same script as the `sfu-publication-lifecycle` cell of
`.github/workflows/formal-models.yml` when a covered file or this model
changes.
