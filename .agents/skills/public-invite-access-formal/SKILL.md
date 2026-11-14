---
name: public-invite-access-formal
description: 'Model-check the public invite, arrival and access grants in the Go API with TLA+. Use when a change touches the public invite (rotate, enable, disable), arrival creation or state transitions, the knock admission request and the host decision, open-Space joins, the Sync token issue SQL, Leave or refresh of a public guest, or the auto Space lifecycle worker (publicinvites/, publicinviteapp/, postgres public_invites.go, public_episode_admission.go, episode_public_join.go), when CI''s "Public invite access model" check fails, or to prove an invite or admission ordering bug.'
---

# Public invite access model

A public invite lets a stranger into a Space. This is a security boundary, so the model states exactly what the Go API promises and checks it in every order the steps can happen in. One guest arrives through the invite, the Space admits them by `knock` (the host decides) or `open` (the API joins them), and the API hands out grants (a Sync participant, a Sync token on refresh). Meanwhile an admin can rotate or disable the invite, the arrival can expire, the Episode can end, the Space can be archived by the auto lifecycle worker, and the guest can leave or refresh at any moment. Each of those is a separate transaction or call, so tests reach the bad orderings only by luck.

`tools/formal/public-invite-access/PublicInviteAccess.tla` models those steps and checks these rules, in both modes:

| Rule                           | Plain sentence                                                                                                     | Harm when it breaks                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AdmittedOnlyOnValidInvite`    | A knock guest is admitted only while the invite, Space, Episode and arrival they knocked on are all still valid.   | A guest who knocked on an invite that was rotated or disabled, or in a Space that ended, still gets in and holds a Sync participant. |
| `NoApprovalOfStaleRequest`     | A host approval is accepted only for a request whose invite, Space, Episode and arrival are still valid.           | A host approves a stale request, so Sync admits a guest the host never meant to let in.                                              |
| `DecisionOnce`                 | A request has one decision: it is never both approved and denied.                                                  | A guest is denied and admitted at once, so the host's screen and the guest's access disagree.                                        |
| `NoGrantToInactiveParticipant` | A refresh token goes only to an active participant of an active Episode.                                           | A guest who left, or whose call ended, gets a token that can still reach the call.                                                   |
| `NoNewAccessInArchivedSpace`   | An archived Space takes no new knock and no new open-Space join.                                                   | A closed Space keeps admitting strangers and starts new calls in it.                                                                 |
| `TerminalStays`                | A rejected, left or unavailable arrival never changes, and an admitted one never goes back to pending.             | A turned-away or departed guest becomes admitted again through a stale write.                                                        |
| `ArchiveLeavesNoActiveEpisode` | An auto Space that the lifecycle worker archived has no Episode that is still active. Ending ("ending") is enough. | The Space is archived, so it disappears from the dashboard, while a call in it keeps running.                                        |
| `OpenedRoomTurnsNoOneAway`     | A guest who waits at a knock Space is not turned away when the host opens the Space.                               | The host opens the room to let people in, and every waiting guest is told the invite is unavailable.                                 |

All seven hold on the real code at the bounds below. Two fixes keep them true:

- **Archive then end again.** A guest can start an Episode between the worker's first `EndEpisode` and `ArchiveSpace`. An archived Space takes no new guest, so `LifecycleWorker.process` calls `EndEpisode` once more after the archive (request key `end-after-archive`) and only then marks the lifecycle archived. `TestLifecycleWorkerLeavesNoActiveEpisodeInArchivedSpace` and the Postgres replay `TestArchiveLeavesNoActiveEpisode` cover it. The model step is `LifecycleEndAfterArchive`; the variant `archive_without_second_end` drops it.
- **Open admits the waiting.** When the host changes a knock Space to open, `pendingGuestArrivalValid` accepts open mode and `ArrivalStatus` calls `admitPendingArrival`, the same grant and admit that `Arrive` does for an open Space. The model steps are `HostOpensSpace` and `OpenedAdmit`; the variant `open_turns_away` brings the old turn-away back. `TestStatusAdmitsWaitingGuestWhenHostOpensSpace` covers it. The host's pending request is not decided any more, because its provenance needs mode knock.

`tools/formal/public-invite-access/findings` lists rules that break on the real code and is empty now. `tools/formal/public-invite-access/run.sh` checks every listed rule still breaks, so a new finding goes there until it is fixed.

## What the code promises, and what it does not

- Collecting a knock grant (`UpdateArrivalState` with `RequirePending`) takes the invite, Space, Episode, arrival and participant locks and checks `publicAdmissionProvenanceValid`, so the checks and the write are one transaction. `DecideAdmissionRequest` does the same for the host decision, and keeps the operation name of a reserved decision (`admit_participant` or `deny_admission`).
- Open mode has no admission request. `GrantPublicAccess` calls `JoinPublic`, which never reads the arrival, and then `UpdateArrivalState` without `RequirePending`. Only `arrivalTransitionAllowed` guards that write, so a guest who left meanwhile keeps a live Sync participant for a moment but the arrival stays `left`. The same holds when the open or account path fails the transition: the participant stays and nothing discards the grant. This is a ghost participant, which the code does not promise to avoid, and it is not a rule here. Sync has no disconnect reaping, so ghosts are normal after a guest walks away.
- An `ending` Episode counts as live for a join (`GetLiveEpisodeForPublicJoin` and `LockLiveEpisodeForUpdate` use `status in ('active', 'ending')`), so a guest cannot start a second call while the first ends, and the join then fails with `ErrEpisodeNotActive`.
- An admitted guest in an archived Space can still refresh (`RefreshAccess` does not check the Space). Only the new knock and the new join check the archive. This is why `NoGrantToInactiveParticipant` is about the participant and the Episode and not the Space.

## Does my change touch the model?

Run this, with the commit from the coverage record below:

```sh
git diff --stat e1814ad6e012e33d3966b6da6a2fadafbb18a25b -- apps/api/internal/publicinvites apps/api/internal/publicinviteapp apps/api/internal/adapters/postgres/public_invites.go apps/api/internal/adapters/postgres/public_episode_admission.go apps/api/internal/adapters/postgres/episode_public_join.go apps/api/db/queries/sync_lifecycle.sql apps/api/db/queries/episode_live.sql
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Commit: `e1814ad6e012e33d3966b6da6a2fadafbb18a25b`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

- `Rotate`, `SetInviteEnabled`: `Runtime.RotateInvite` and `Runtime.UpdateInvite` in `apps/api/internal/publicinvites/service.go`. Arrival creation checks the current generation of an enabled invite.
- `Arrive`: `Runtime.Arrive` and `Service.CreateArrival` (`apps/api/internal/publicinvites/service.go`).
- `Knock`: `PublicInviteRepository.CreateAdmissionRequest` (`apps/api/internal/adapters/postgres/public_episode_admission.go`): invite, Space and arrival locks, the archived Space refusal, `ensurePublicLiveEpisode`, the provenance check, then the joining participant.
- `Decide`: `PublicInviteRepository.DecideAdmissionRequest` (`apps/api/internal/adapters/postgres/public_episode_admission.go`): the lock order, the operation-name fence (`GetAdmissionDecisionOperationName`), the provenance check, `createOrRetryAdmissionDecision` and `ReserveEpisodeAdmissionDecision`.
- `SyncApply`, `SyncEndsEpisode`, `SyncLeaves`, `RequestExpires`: Sync applies the reserved decision, ends the Episode, finishes a leave and expires a request. They are inputs to this model and are covered by the `sync-entry-leave-formal` and Sync tests, not here.
- `CollectEnds`, `CollectGrant`, `CollectCommit`: `Runtime.resolvePendingAdmission` and `Runtime.finishPendingArrival` (`apps/api/internal/publicinvites/service.go`), `accessPort.GrantPublicAccess` (`apps/api/internal/publicinviteapp/access.go`) and `UpdateArrivalState` (`apps/api/internal/adapters/postgres/public_invites.go`) with `publicAdmissionProvenanceValid` and `arrivalTransitionAllowed`.
- `OpenRead`, `OpenGrant`, `OpenCommit`: `Runtime.Arrive`, `EpisodeLifecycleRepository.JoinPublic` (`apps/api/internal/adapters/postgres/episode_public_join.go`) and `UpdateArrivalState` without `RequirePending`.
- `LeavePending`, `LeaveRevoke`, `LeaveFinish`: `Runtime.Leave`, `accessPort.RevokePublicAccess` and `EpisodeLifecycleRepository.LeavePublic`.
- `RefreshRead`, `RefreshIssue`, `RefreshFails`: `Runtime.RefreshAccess` and `accessPort.RefreshPublicAccess`, with the `GetSyncTokenSubject` query in `apps/api/db/queries/sync_lifecycle.sql`.
- `HostOpensSpace`, `OpenedAdmit`, `OpenedTurnsAway`: `Runtime.ArrivalStatus`, `Runtime.admitPendingArrival` and `Runtime.pendingGuestArrivalValid` (`apps/api/internal/publicinvites/service.go`). `OpenedTurnsAway` exists only in the variant `open_turns_away`.
- `LifecycleEnd`, `LifecycleEndAfterArchive`, `LifecycleArchive`: `LifecycleWorker.process` (`apps/api/internal/publicinvites/lifecycle_worker.go`) and `lifecycleActions.EndEpisode` and `ArchiveSpace` (`apps/api/internal/publicinviteapp/lifecycle_actions.go`).
- `HostEndsEpisode`, `ArrivalExpires`: the host ending a call, and the arrival's `expires_at` passing.

Each repository action is one Postgres transaction. The guest's own calls (a collection, a refresh, a Leave) are modeled as separate steps with a read and a later write, because the code reads in one transaction and writes in another. If a change merges or splits transactions, the model's steps are wrong and must change too.

`tools/formal/public-invite-access/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/public-invite-access/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes a minute or two. It does four things, and fails if any one fails:

1. It checks that every fragment in `anchors` is still in its file. `run.sh --anchors` runs only this, in a second.
2. It runs TLC on `PublicInviteAccess.cfg` in `knock` and in `open` mode (2 invite generations, `Break = "none"`), which is the real code, and needs every rule in the cfg to hold. That is 2,172 distinct states in `knock` mode and 1,416 in `open` mode.
3. It runs each rule in `findings` on the real code and needs it to break, so the check also fails when someone fixes the finding without updating the files.
4. It runs each broken variant in `breaks` on one worker, checking only the rule that variant is listed for, and needs TLC to report that rule as broken. This proves the check can still fail.

`run.sh --tlc` skips the anchors. Set `FORMAL_OUT` to keep the TLC logs in a folder you choose; the last line prints the folder.

CI runs `tools/formal/public-invite-access/run.sh` in `.github/workflows/formal-public-invite-access.yml` when a covered file or this model changes.

Real code breaks, shown once: each variant in `breaks` mirrors a one-line edit of the Go. Applied to the real code, a Postgres test fails for six of the seven: `TestDashboardCallPublicKnockReachesEpisodeAdmission` for `collect_skips_provenance`, `decide_skips_provenance` and `decide_not_fenced`, `TestPublicArrivalTerminalStateStays` for `transition_unchecked`, and `TestPublicInviteArchivedSpaceTakesNoGuests` for `join_ignores_archive` and `knock_ignores_archive`. No test shows `issue_skips_participant`, because the database cancels a participant's join seat when the participant leaves or the Episode ends, which hides the extra conditions in the token SQL. The model keeps that variant because the SQL conditions are the guard that the code relies on for an active participant.

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/public-invite-access/PublicInviteAccess.view.mjs` as the view so that states and steps use the words of a guest and a host. The model is over the chart budget of 500 states, so `/statechart` draws a chart only for a rule that breaks. To see the finding, copy the cfg, set `MaxGen = 1` and add `ArchiveLeavesNoActiveEpisode` to its `INVARIANTS`.

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `PublicInviteAccess.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A rule breaks on `Break = "none"`.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug. Each step maps to one transaction or call, so a replay is a Postgres-backed Go test that drives those calls in that order, like the one for the finding. If the replay shows the bug, report it with the path in Chalk's words and leave the rule as it is. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the step.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `breaks` line before you change anything. Do not delete the variant.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `PublicInviteAccess.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard (add its name to `BreakNames` and use it in the action), and the rule it protects.
4. Run `tools/formal/public-invite-access/run.sh`. All rules must hold on the real code and every variant must break.
5. Move the commit in this file to the commit you checked, and update the coverage record and the paths in `git diff` above.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- One guest, one invite, one Space. Several guests, the Episode capacity limit and the per-tenant live Episode limit are not modeled.
- Admission modes are fixed for a run. Changing a Space's admission policy while guests wait is not modeled, and the legacy knock path (`KnockArrivalID`, `decideLegacyAdmissionRequest`) is left out.
- Sync is a few steps (apply a decision, end an Episode, finish a leave, expire a request). Its own ordering is covered by `tools/formal/sync-entry-leave`, and its seats, entries and generations are not modeled here.
- Time is a few events: the arrival and the request expire, the lifecycle worker runs. The worker's claim lease, its retries and its deadline are left out. The guest's identity (guest credential, account, media proof) and the provider binding are not modeled.
- Each model action is one transaction, as the code orders them. A crash between two of a guest's own calls is covered only where the model keeps them as two steps (a collection's read and commit, a Leave's revoke and finish, a refresh's read and issue).
- A ghost participant is not a rule. After a failed or late write the participant can stay in Sync until the Episode ends. The code does not promise otherwise.
- Bounds: 2 invite generations, in each mode. More generations add no new order of the rules here, because a rotate only needs to differ from the arrival's generation.
