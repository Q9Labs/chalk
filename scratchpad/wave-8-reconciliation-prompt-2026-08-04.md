# Wave 8 prompt — master, dashboard, and live Episode debugger reconciliation

You are executing Wave 8 of the Chalk vocabulary-and-boundary restructure.
This prompt is binding. The final integrated rename is the source of truth;
older worktrees are evidence sources, not merge authorities.

## Mission

Produce one verified local master line that preserves valuable pre-wave product
work while keeping the canonical Space, Episode, Participant, AccessGrant,
SpaceClient, Entrance, and `<Chalk />` architecture. Reconcile the completed
rename with the dashboard management work and live Episode debugger without
restoring compatibility aliases, stale generated artifacts, or banned product
vocabulary.

## Model and ownership rule

- Luna workers implement every rename, adaptation, and reconciliation change.
- GPT-5.6 Terra xhigh workers review stable Luna handoffs. Reviewers do not edit.
- Root owns source-state capture, Git topology, shared-file integration,
  generated outputs, final decisions, the full gate, browser proof, and the
  local master update.
- No GPT-5.6 Sol worker is used.

## Reviewed transfer strategy

- The initial behavior transfer keeps `VideoConference` deleted after porting;
  no compatibility alias or old public surface is restored.
- The dashboard replay is exactly the unique tail `0c6768c^..0c6768c`, and it
  contributes exactly two migrations. Generated output is excluded from the
  source replay and regenerated only after canonical contracts settle.
- Stale `managed-meeting` material is excluded with the generated output and
  never treated as a source of truth.
- Debugger extraction is allowlist-based: import only behavior named by the
  hashed lane manifests, and keep the debugger behind the account-gated route.
- Luna implements each bounded handoff; Terra xhigh reviews the stable handoff
  and does not edit it. The final exact staged tree is copied to M4 for the
  canonical gate.

## Blocked on

- Waves 1 through 7 are integrated on one clean, verified canonical tip.
- The Wave 3/4 `<Chalk />` and Entrance public surface is final.
- Wave 6 telemetry boundaries and Wave 7 public documentation are final.
- No producer is still writing a dependency consumed by Wave 8.

## Read first

- `GLOSSARY.md`
- `scratchpad/wave-execution-brief-2026-08-03.md`
- every completed wave report and the central execution log
- `/Users/macmini/code/orchestration-guide.md`
- applicable root and nested `AGENTS.md` files

## Evidence sources

Treat both worktrees as read-only throughout Wave 8.

### Dashboard completion

- Worktree: `/Users/macmini/code/chalk/.worktrees/dashboard-completion-integration`
- Branch: `codex/dashboard-completion-integration`
- Audited head: `0c6768c01d92829f2c5ec26c6b698586131d6f31`
- State at audit: clean, no upstream
- `908c9a36` is a structural merge of the pre-wave product line and Wave 1. It
  is not a feature commit and must not be cherry-picked.
- The product commits through `9fc008d8`, plus later mobile commits
  `d60854fc` and `e45395e1`, already belong to local `master`.
- The unique dashboard completion tail is exactly `0c6768c^..0c6768c` and
  contains the Account and Tenant management workflows, Space and Episode
  management, API-key lifecycle, recent-auth enforcement, audit/trace behavior,
  related web UI, and exactly two migrations.

### Live Episode debugger

- Worktree: `/Users/macmini/code/chalk/.worktrees/live-episode-debugger`
- Branch/head: `codex/live-episode-debugger` at
  `c69de85875aca2c33e7889e136f59c41dd97ce0b`
- State at audit: no staged changes, 260 tracked changes, and 257 untracked
  files when enumerated with `git status --porcelain=v1 -uall`.
- Audited tracked binary-diff SHA-256:
  `0138041986542419c3a4154b17e2b4c7eeae7909045f0ad1556ce4e67181f40c`.
- Audited sorted untracked-path-list SHA-256:
  `31d194436b2c4af4b0f828e9b6180fec63912d8e0e44dc376d5e3b99d697892a`.
- This tree mixes unique diagnostics behavior with copied Wave 2 work, stale
  `src/session` internals, old `Room` routes, `VideoConference`, and the retired
  meeting broker. Never apply its whole diff and never modify it in place.

At Wave 8 start, record the exact current heads, status counts, tracked diff
hash, and a content-hash manifest for every untracked file. If the source state
changed since this audit, stop extraction until the new state is inventoried.

## Target topology

1. Create a new isolated Wave 8 worktree and branch from the then-current local
   `master`. Record its exact tip.
2. Merge the final verified Waves 1–7 integration tip into that branch. Resolve
   conflicts in favor of the glossary and canonical package-owned behavior.
   Do not choose an old side wholesale for React, React Native, web routes,
   SDK client internals, generated contracts, the language baseline, or the
   changelog.
3. Replay the functional delta of `0c6768c0` onto the reconciled tree. Do not
   replay `908c9a36`; local master already carries its product-side ancestry and
   the canonical integration tip already carries Wave 1 and its closures.
4. Extract only unique live Episode debugger behavior from the dirty source
   worktree using the hashed lane manifests and their allowlist. Reimplement it
   against final packages and names, and expose it only through the
   account-gated route.
5. Regenerate derived artifacts only after source contracts, migrations, and
   route ownership settle.
6. Update local `master` only after all review, gates, migration proof, and
   browser proof are green. Do not push.

## Inclusion rules

Preserve and adapt:

- Dashboard Account and Tenant access onboarding and switching.
- Space list/create/edit/archive/restore workflows.
- Episode list/detail/start/end and Participant history workflows.
- API-key list/create/reveal-once/rotate/revoke, recent-auth, audit logs,
  idempotency, trace continuity, and safe failure behavior.
- The diagnostics contracts, projections, filters, closed action catalog,
  access checks, API/Sync instrumentation, SDK observers, debugger views,
  exports, gap handling, and generic local tooling.
- Reusable UI primitives that remain necessary after comparing against the
  final `packages/ui` surface.

Do not port:

- copied Wave 2 client/session implementations already replaced by
  `src/access`, `src/connection`, and final `SpaceClient` controllers;
- `VideoConference`, `ConferenceView`, `PreJoinScreen`, `Room`,
  `ChalkSession`, `ParticipantAccess`, host/admin built-in roles, or any
  compatibility alias for them;
- `infrastructure/meeting-broker`, stale `managed-meeting` material, or other
  files superseded by the Episode broker;
- stale SQLC, OpenAPI, TypeScript schema, Sync contract, webhook, route-tree,
  lockfile, or ratchet output copied from an older tree;
- historical gate claims as proof of the reconciled result.

## Producer lanes

Launch these lanes only after the initial master/canonical merge is stable.
They may run in parallel because their mutable source ownership is disjoint.
Root owns every shared seam listed below.

| Lane                   | Luna-owned source                                                                                  | Deliverable                                                                     | Shared resources owned by root                                                              | Stop condition                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Dashboard              | Dashboard API and web management source, dashboard migrations, recent-auth and uptime source       | Canonical Account/Tenant, Space/Episode, API-key, audit, and web workflows      | shared router/package files, generated SQLC/OpenAPI/webhooks, lockfile, baseline, changelog | focused API/web/uptime checks pass and the handoff is quiescent |
| Diagnostics backend    | `packages/diagnostics-contracts`, diagnostics-owned API and Sync source, diagnostics migrations    | Authenticated and observable Episode diagnostics backend on canonical contracts | shared API/Sync wiring, generated schemas, migration assembly                               | contract, API, Sync, security, and projection tests pass        |
| Diagnostics SDK        | Client, React, and React Native diagnostics adapters and render observers                          | Diagnostics on final SpaceClient and closed React/RN surfaces                   | shared package entry points, generated client types, lockfile, baseline                     | SDK tests, typechecks, package builds, and parity checks pass   |
| Diagnostics UI/tooling | Debugger feature views, diagnostics CLI/browser fixture, and still-needed `packages/ui` primitives | Local-first debugger UI, export/copy/gap behavior, and proof tooling            | shared web router/package files, route generation, lockfile, baseline                       | focused UI/tooling tests and local browser fixture pass         |

Before launching a lane, root supplies the exact final source APIs it must
target and the source paths it may consult. Workers do not edit the evidence
worktrees, shared files, generated files, or another lane's ownership.

## Review lanes

After every producer is quiescent:

1. Terra xhigh reviews the dashboard/API-key/recent-auth behavior and migration
   boundaries.
2. Terra xhigh reviews diagnostics contracts, API, Sync, authorization,
   observability, retention, and export safety.
3. Terra xhigh reviews SDK parity, public API shape, debugger UI, tooling, and
   browser security boundaries.

Luna closes review findings in the original ownership lane. A bounded Terra
xhigh re-review checks only the fixes and affected seams.

## Integration and generation order

Root integrates in this order:

1. canonical master merge and conflict resolution;
2. Dashboard source and its two unique migrations;
3. diagnostics contracts and migrations;
4. API and Sync source wiring;
5. SDK source and framework adapters;
6. web/debugger UI and tooling;
7. embedded schema, SQLC, OpenAPI, TypeScript schema, Sync fixtures, webhook
   types, route tree, dependency lock, language baseline, changelog, and public
   documentation generation.

Database changes are release blockers. Reconcile dashboard onboarding/archive/
API-key migrations with diagnostics storage/receipt/operator migrations, keep
checked-in and embedded schema paths identical, and prove clean up, down, and
up behavior plus post-migration queries before declaring the wave complete.

## Verification

- Run focused package and service checks after each producer handoff.
- Run `apps/api/scripts/gate.sh` after Go changes and
  `apps/sync/scripts/gate.sh` after Sync changes.
- Verify diagnostics success and failure paths in traces, metrics, structured
  logs, and safe operator-facing status. Never log credentials or payloads.
- Add or update uptime monitoring for every user-visible deployed component;
  no deployment or monitor mutation occurs in this wave.
- Copy the final exact staged tree to M4, then run the canonical `pnpm run gate`
  over that tree on the M4 host.
- Run any environment-specific sub-gate locally only when the M4 lacks a
  required tool, and report the split proof explicitly.
- Use Helium for real-browser proof of dashboard onboarding/management,
  API-key reveal-once and recent-auth flows, and debugger navigation, stream
  recovery/gap behavior, export/copy, failure, and recovery.
- Re-run the nonhistorical banned-term audit across code, infra, docs, UI,
  telemetry, generated artifacts, and packaged surfaces.

## Definition of done

- Local `master` contains the verified Waves 1–8 result and all valuable local
  master/dashboard/debugger behavior.
- Neither evidence worktree was modified.
- No legacy product alias or banned product vocabulary remains outside explicit
  historical, glossary, ratchet, or negative-compatibility fixtures.
- Migrations and every generated artifact match final source.
- Focused checks, service gates, the exact M4 full gate, package checks, and
  Helium proof are green.
- CHANGELOG/release notes and timestamped session logs describe the final state
  and enumerate deployment-time cutovers without performing them.
- No push, publish, deploy, production access, or external monitor mutation
  occurred.
