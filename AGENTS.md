# Chalk

Ultra low-latency video conferencing (Built ontop of Cloudflare RealtimeKit, leveraging Cloudflare's global network).
Monorepo: Turbo + Bun. Packages → GitHub Packages `@q9labs/*`.

## Commands

```bash
bun install                    # Install deps
bun run dev|build|test|lint    # All packages
bun run check-types            # Type check
bun run generate               # Re-generate openapi.yml when suitable after making changes to the apps/api
cd apps/api && go run ./cmd/main.go # Run API server
```

## Database Migration Note

- Treat DB schema changes as ship blockers. If code or generated queries reference new columns/tables/indexes, apply migrations locally and in prod, then verify the exact schema exists in both places before closing.
- Never assume checked-in SQL means prod/local already has it. Verify with direct schema queries when it matters.
- For Chalk API specifically, keep file migrations and embedded runtime migrations in `apps/api/internal/infrastructure/postgres/postgres.go` in sync. If one side misses a migration, prod drift can survive deploys.
- Prefer automation over memory. PlanetScale Postgres can be migrated from GitHub Actions like normal Postgres. Recommended default: automated deploy-time migration or startup migration, plus post-deploy schema verification. Manual-only is not reliable enough here.

## Testing Rules

- For UX changes or any user-facing feature/behavior change, do both: add/update the appropriate automated tests and verify in a real browser flow with the Agent Browser CLI.
- Use Agent Browser to exercise the changed flow end-to-end the way a user would: load the app, navigate the affected surfaces, interact with controls, and confirm the visible result.
- During browser verification, check realistic viewport scale/zoom/layout conditions as well, so spacing, overflow, clipping, responsiveness, and visual hierarchy are validated under normal viewing conditions.
- Prefer verifying in the Chalk demo/user-facing app (`apps/web`, `http://localhost:3070`) that exposes the changed behavior after the package-level implementation is complete.
- Do not treat browser verification as optional for user-facing work unless the feature cannot be exercised locally; if blocked, state exactly what prevented Agent Browser testing.
- Agent Browser verification does not replace automated coverage. Keep writing tests wherever they fit; for bug fixes or previously broken behavior, add a regression test when feasible. Browser testing is the user-level proof on top.
- UI polish note: for in-product placeholders/empty states/guard rails, keep typography on-brand with Chalk theme tokens (`font-app`, `font-display` where applicable) and verify both light + dark mode before closing.
- Take screenshots with the Agent Browser for an extra level of verification

## Cost Formulas (Quick Reference)

- RealtimeKit participant-minutes: `participant_minutes = sessions * avg_minutes * avg_participants`
- RealtimeKit A/V cost: `participant_minutes * 0.002`
- RealtimeKit audio-only cost: `participant_minutes * 0.0005`
- SFU egress estimate (GB): `participant_minutes * avg_downlink_mbps * 0.0075`
- SFU cost: `max(0, sfu_gb - 1000) * 0.05` (1000 GB free pool, then $0.05/GB)

## Where to Write Code

**Packages first, then demo in apps:**

Why? Because the sdk's are the source of truth. Demo apps are just for testing and verification.

All apps & packages:

- **sdk-core**: Client logic, WebRTC, room management (stable)
- **sdk-react**: React hooks, components (stable)
- **ui**: Shared UI primitives (mostly unused)
- **chalk-whiteboard**: Whiteboard features (stable)
- **api**: Go backend API (`apps/api`, stable)
- **terraform**: AWS IaC (`infrastructure/terraform`, stable)
- **docs**: Chalk docs (`docs.chalk.q9labs.ai`, stable)
- **web**: Chalk brand facing application + application to test before releasing to consumers (`apps/web`)

After packages → export → use in demo apps for user testing.
Sometimes (rarely) the user might want to directly work on the app and later create the sdk.

Never add client-side business logic to demo apps.

## Consumer Rollout Shorthand

- If Hasan says `update the consumers`, default meaning:
  - `TH LMS` -> `/Users/macmini/Desktop/Code/th-lms`
  - `ET LMS` -> `/Users/macmini/Desktop/Code/et-lms`
  - `CollabDash` -> `/Users/macmini/Desktop/Code/collabdash`
- Do not assume all three every time. Ask which ones.
- For each consumer, use its local `CHALK_WORKFLOW.md` in the workspace root as the first source of truth for infra, bump steps, deploy order, verification, and rollback.
- Default execution strategy:
  - keep release/version choice, risk calls, and final deploy decisions local
  - delegate consumer-specific dry runs, repo reading, CI polling, and bounded deploy prep to `gpt-5.4-mini` subagents
  - one mini subagent per consumer when scopes are independent
- Mini-subagent rule (instruct it):
  - if anything unusual appears, docs look stale, infra does not match the workflow, a command may crash prod, or confidence drops on a prod-impacting step, the mini subagent must stop and escalate back instead of guessing
  - minis are for support work, not final prod-risk decisions

## SDK-First Guardrail

- For any product behavior, bug fix, feature, UX, observability, auth, networking, retries, or error handling: implement first in the Chalk package that owns it.
- Owner package examples: `sdk-core`, `sdk-react`, `chalk-whiteboard`, `ui` (not app-level first).
- Consumer apps should only do thin wiring/config, branding, and app-specific integration unless explicitly requested otherwise.
- Do not ship app-only logic as the primary fix when it should live in a Chalk package.
- If an app-only workaround is unavoidable, label it temporary and open/complete the SDK/package follow-up before closing the task.
- Keep product language consistent & role-neutral by default; avoid `student` / `teacher` framing unless an integration explicitly requires it, and prefer the existing neutral terms already used in the codebase for consistency.

## Skills

- `release` — release skill (project only).

## Whisper Rollback Note (old)

- If Whisper load/latency regresses on `c7i.large`, upgrade back to `c7i.xlarge` (spot).

## Async Autonomy Note

- If Hasan says he's stepping away for a few hours: proceed autonomously end-to-end.
- Finish implementation, run the full gate, and do browser verification without waiting for another prompt.

## Artsy Vibe Note (On-Demand Mode)

Purpose: keep refactor discussions expressive + structured when Hasan explicitly asks for "artsy vibe" (or equivalent).
Default mode remains concise engineering communication.

- Invocation rule:
  - Use artsy vibe only when Hasan requests it.
  - Do not keep artsy narration active across turns unless re-requested.
  - If not requested, use normal concise mode.

- Narrative frame: use design language.
  - "Composition" (modules), "rhythm" (state flow), "palette" (naming), "texture" (DX), "negative space" (deleted complexity).
- Communication shape:
  - Start with the high-level aesthetic intent.
  - Then concrete structure: boundaries, ownership, contracts, data flow.
  - Then implementation cuts: what moves, what stays, what gets removed.
- Refactor preference:
  - Orchestrator files thin.
  - Stateful logic in focused hooks/services.
  - Events and lifecycle contracts explicit.
  - No duplicated truth (`status` + parallel booleans that can drift).
- Naming standard:
  - Prefer precise domain terms over vague stage/phase metaphors.
  - One concept = one word = one source of truth.
- Example style for explanations: collapsed-by-default.
  - Show "facade" first.
  - Expand internals only when requested.

```ts
// VideoConference.tsx (facade / collapsed view)
export function VideoConference(props: VideoConferenceProps) {
  const vm = useVideoConferenceController(props);
  return <VideoConferenceView {...vm} />;
}

// useVideoConferenceController.ts (expanded on demand)
// - join orchestration
// - room lifecycle wiring
// - manager composition
// - view-model mapping
```

- Review lens in artsy mode:
  - "What tension exists?" (duplication, drift risk, hidden coupling)
  - "What can be simplified?" (merge parallel states, isolate effects)
  - "What line should be bolder?" (clear API boundaries, event grammar)
