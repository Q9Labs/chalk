# Chalk deps update + Kaadr Chalk vertical-slice prep — 2026-08-15

## Lanes

- **Codex Luna xhigh (priority) — chalk deps** — bridge `1786780041904-52ae3958`, Cmux `workspace:25`. Scope: apps/api Go modules to latest + `apps/api/scripts/gate.sh`; sdks/typescript/{client,react,react-native} deps to latest + per-package build/test + root `pnpm run gate`. No commit; I review and commit.
- **Codex Luna xhigh (priority) — kaadr slice plan** — bridge `1786780042557-d54931cf`, Cmux `workspace:26`. Read-only discovery in both repos; single output `~/code/kaadr/plans/implementation/2026-08-15-chalk-video-call-vertical-slice.md`.

## Decision: provider is Chalk, not Daily

Kaadr's `product.yaml` capability `school_portal.teacher_opportunities_conversation_interview` and the 2026-08-11 P0 log selected Daily for Start-now Video Call. Superseded: the slice uses Chalk (`@q9labsai/chalk-client/server` from `apps/api` via `packages/integrations`; `@q9labsai/chalk-react` in `apps/web`). Kaadr stays authoritative for context, permission, identity, call state, audit; Chalk grants are short-lived provider capabilities.

## Plan landed (12:58)

207-line plan, every Chalk fact quoted with file:line. Verified myself against Chalk source:

1. **Server SDK has no Space lookup/archive** — `ChalkServerClient.spaces` is `{ create }` only (`sdks/typescript/client/src/server/types.ts:178`), while the Go API mounts `getSpace`, `listSpaces`, `archiveSpace`, `restoreSpace` (`apps/api/internal/httpapi/spaces.go:130-138`). Kaadr must persist the Chalk Space ID; SDK should grow `spaces.get/list/archive`.
2. **No public `AccessGrant` parser** — `parseAccessGrant`/`requireAccessGrant` exist in `src/access/grant.ts` but only the type is exported from `space-client/index.ts`; Chalk's own `apps/web/src/lib/chalk-access.ts:226` uses `value as AccessGrant`. Kaadr's strict TS (no `as`) can't implement `GetAccess` without a public parser.
3. Chalk React has no RTL support (physical `left-/right-` classes) — plan isolates the call surface with `dir="ltr"`.
4. CSP hosts: `https://api.chalkmeet.com`, `wss://sync.chalkmeet.com`, plus SFU hosts carried in the grant.
5. Open product question: plan gives both School and Teacher Start-now/Join (peer mode per glossary); School-only initiation would be a core-policy change.

Next: fix gaps 1–2 in Chalk SDK after the deps lane releases the worktree.

## Deps lane stalled on phantom subagents (14:08)

Go side finished at 13:24 (gate passed after a local-network approval), but every one of the lane's six `spawn_agent` calls had failed with "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork." — no SDK worker ever existed. The root then sat in `wait_agent` for ~50 minutes with the SDK manifests untouched. Interrupted it (Escape on `workspace:25`) and sent a steer: no more spawns, do the three SDK manifests + lockfile + gate directly. It resumed at 14:09; package.json edits appeared within a minute.

Lesson for delegation.md: Luna root threads that use `fork_turns: "all"` cannot pass `agent_type`; the prompt should say so, and a `wait_agent` on zero agents should be treated as a stall signal by the watcher.

## Chalk SDK gap 1 fixed locally (14:15)

`sdks/typescript/client/src/server/{types,client,index}.ts`: `spaces.get`, `spaces.list({archived?, cursor?, pageSize?})`, `spaces.archive`, `spaces.restore` wrapping the existing Go routes; `Space` gains `archived` and `archived_at?`; new `SpaceList`, `ListSpacesInput`. GET/archive/restore use `retry: "always"` (archive/restore are `coalesce(archived_at, now())` upserts in `db/queries/spaces.sql:275`, so idempotent). Focused `client.test.ts` passes (8 tests). Full gate deferred until the deps lane finishes with the worktree.

## Gap 2 (public AccessGrant parser) is a ratified decision, not a bug

`space-client/contracts.test.ts:22-24` asserts `parseAccessGrant`/`requireAccessGrant` are NOT on the root surface, from Hasan's `a41325f9` (2026-08-04: "AccessGrant is opaque; customers never construct or inspect it"). Reverted my export. Consequence for Kaadr: `GetAccess` must return `response.json()` (typed `any` → `AccessGrant`) or `as AccessGrant`; both collide with Kaadr's type gates. Needs Hasan's call: (a) export `requireAccessGrant` (accepts a `Response`, still no inspection) and update the contract test, or (b) keep the boundary and let Kaadr carry one justified suppression at its `GetAccess` seam.

## Close-out (14:55)

- Root gate on the shared worktree failed only at the language ratchet: `root/meeting +1`, `root/room +1`, both from another agent's uncommitted `scripts/dev/chalk.test.mjs` (14 Aug 15:45; `meeting-broker`, `CHALK_ROOM_ID`), plus an `apps/api/session -23` from their uncommitted Go edits. Not my files, so left alone.
- Syncpack then flagged the SDK bumps drifting from the rest of the workspace; aligned `@noble/hashes` 2.3.0, `esbuild` 0.28.2, `happy-dom` ^20.11.2, `playwright` ^1.62.1 in transcription-dispatcher, diagnostics-contracts, ui, whiteboard, episode-diagnostics, sdk-web-consumer-e2e. All six type-check and test green.
- Committed from a clean worktree at `.worktrees/deps` (mix deps/\_build copied in so the Sync gate could run offline). Full pre-commit gate passed there for both commits: `20f3e1bf chore(deps)`, `a60d945e feat(client)` spaces get/list/archive/restore. Fast-forwarded master to them.
- Lesson: when the pre-commit ratchet reads other agents' dirty files, a `.worktrees/<name>` checkout is the way to run the gate honestly instead of `--no-verify`.
