# Execution strategy map — 2026-08-03

The whole remaining pipeline from wave zero to done, laid out for Hasan's
comments and approval before any worker launches. Every design input named
here is ratified; the map is about order, ownership, and gates. Comment on
any numbered item; C1–C4 at the bottom are the open calls.

## Standing worker doctrine (applies to every wave)

- Each worker: own `.worktrees/<name>`, own branch, detached nohup launch,
  strict-scope clause in the prompt, DOES NOT commit (orchestrator owns the
  commit after skeptical review of the diff against the worker's report).
- Sol high waves (1 and 2): ONE attempt each, no auto-review second pass;
  Claude's skeptical diff review is the only gate.
- Luna max waves (3–6): mechanical execution of ratified sheets, same
  review gate. Marketing (wave 7) is Claude directly, no worker.
- Full remote gate green before any wave merges; ratchet counts may only
  fall.

## The map

### 0. Wave zero merge — NOW, blocked on one command from Hasan

`refactor/sync-v1-renumber` is gate-green and reviewed. Git refuses the
merge over another agent's uncommitted `README.md` + `checklist.md` edits,
and the permission classifier (correctly) refuses to let me stash others'
work. Their diff is backed up at
`/tmp/other-agent-readme-checklist-2026-08-03.patch`. Hasan runs:

```
! git stash push -m "park around wave-zero merge" -- README.md checklist.md && git merge refactor/sync-v1-renumber && git stash pop
```

If the pop conflicts I restore their edits from the backup patch.

### 0b. Post-merge chores — Claude, immediately after 0

- `pnpm run language:ratchet:update` (counts drop massively), commit.
- Grep the four master commits that drifted past the worktree base
  (a374a7c5, 4413d5e0, f3dee209, 2def479b) for fresh v3/legacy-sync
  references; fix any stragglers.
- Merge `refactor/ui-primitives-consolidation` (f60a4b8f), dropping its
  stray `.pnpm-store/`.
- Remove the sync-renumber worktree + the two recoverable /tmp dirs.

### 1. Contract wave — Sol high, one attempt

- Implements `scratchpad/space-episode-schema-design-2026-08-03.md`:
  squash migrations to a clean baseline; spaces/episodes/members tables;
  ONE capability namespace (23-cap closed set, default bundles
  owner/collaborator/observer); chat/whiteboard writes stamped with a live
  episode_id; kill host_exit_policy + one-host-per-session; console
  bounded context untouched.
- Go API + DB + webhook/contract surfaces; `noun.condition` error codes.
- Boundary fixes folded in per the ruling "never touch the system twice":
  httpapi composition god package, room-actions four-owner split,
  contract-codegen rename to its fixture-proof role.

### 2. Client SDK wave — Sol high, one attempt, after 1 merges

- Implements `scratchpad/client-sdk-split-design-2026-08-03.md` plus the
  construction seam from `scratchpad/public-surface-design-2026-08-03.md`:
  SpaceClient (flat lifecycle + media/chat/participants/reactions/
  whiteboard controllers), internal Connection coordinator, one
  SpaceSnapshot store, AccessGrant + `getAccess`, R1 access-refresh
  requirement, Effect-TS core with Promise public surface.
- Media-plane contract moves out of sync types into its neutral home.
- Sequential after wave 1 because it consumes the renamed contract.

### 3. React/RN wave — Luna max, after 2

- FIRST: React-wave design short sheet co-designed live with Hasan —
  final hook names, `<Chalk />` interior component tree (SpaceView, Stage,
  Entrance, panels; old UI-shape catalog in git history as input).
- Then the worker: `<Chalk />`, `<ChalkProvider>`, `<Entrance />`,
  prebuilt components bound to the SpaceSnapshot store only; kill the
  forwarding mirrors; RN ClientSession gets its true name here.
- Hasan's UI pass (new design system mockups, theme token LIST) starts
  after this wave lands; `theme` mechanism ships in-wave, tokens follow.

### 4. Apps wave — Luna max, after 3

- Web + mobile apps adopt the new SDK surface and vocabulary; turnkey
  copy strings finalized here (partly Hasan's, with the UI pass).

### 5. Infra/broker wave — Luna max

- FIRST: broker MeetingSession true-name short sheet with Hasan (edge
  lease concept).
- Then: broker + infra renames all the way down (env vars, stack names);
  Go sessionlifecycle→Episode, Elixir Live.Session + Sessions.Coordinator
  true names land where their code lives (this wave or 1, whichever owns
  the files — worker scope clause decides, no overlap).

### 6. Observability wave — Luna max

- Span names, dashboards, alerts, digests to the new vocabulary.

### 7. Marketing/docs — Claude directly, last

- Site copy, README, docs sweep; ratchet reaches zero; glossary's "target
  not present" caveat deleted.

## Open calls for Hasan

- **C1 — Waves 5 and 6 in parallel?** They touch disjoint surfaces; could
  run as two isolated workers at once. Recommendation: yes, parallel.
- **C2 — Where does your UI pass slot?** Map assumes: after wave 3
  merges, overlapping waves 4–6. Confirm or move.
- **C3 — Apps wave model.** Luna max per standing assignment; if the app
  adoption turns out judgment-heavy mid-flight, promote to Sol rather
  than let Luna improvise. Approve the promotion rule?
- **C4 — Anything missing or mis-ordered?**
