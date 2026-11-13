# Flow 5: the host removes or demotes a student

A host removes a student, or changes the student's role from collaborator to observer. `HostActsOnStudent.tla` is the TLA+ model, `HostActsOnStudent.cfg` lists the rules TLC checks, `HostActsOnStudent.view.mjs` gives the chart its words, `chart.mmd` is the Mermaid text and `chart.svg` is the rendered chart. The header of `HostActsOnStudent.tla` names the code that each step mirrors.

Make the files again with the `/statechart` skill from this folder, then render `chart.mmd` with `pele@1.9.0` as the skill's render reference describes. Use a new `OUT` folder outside the repo and copy `chart.mmd` here.

```sh
/statechart HostActsOnStudent.tla --config HostActsOnStudent.cfg --view HostActsOnStudent.view.mjs --out OUT
```

## Rules that break

Both break at the same state, "Host told it failed, but the student is an observer with the camera on".

- **When the host sees "failed", nothing changed.**
- **When the host has the outcome, a student who is an observer has no camera in the class.**

Path for both: the host makes the student an observer, stopping the camera fails. `persist_pending_role_transition` commits the role event first, then installs publication fences and queues one source-stop child per lost source (`apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_planner.ex:171-244`). If a child fails, `settle_role_transition_parent` fails the parent and rejects the receipt with `external_operation_failed` (`apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_settlement.ex:56-90`). That branch does not undo the role event, and only the success branch deletes the fences. So the host reads "failed" while the role has changed, and the camera may still be delivered. Traced against the code, not run. A terminal child failure can also mean the target is already gone, so "may" is the honest word here.

Removal holds: a failed removal is put back to active after 100 tries (`apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex:26,1076`), so the host sees "Could not remove" and the student is still in.

## What the chart hides and leaves out

It hides no step except the closing no-op at the end states. It leaves out screen share and microphone as separate sources, the host retrying a failed demotion, and the student's own screens ("You were removed from <call>").
