# Chalk

Ultra low-latency video conferencing for education (Built ontop of Cloudflare RealtimeKit, leveraging Cloudflare's global network).
Monorepo: Turbo + Bun. Packages → GitHub Packages `@q9labs/*`.

## Commands

```bash
bun install                    # Install deps
bun run dev|build|test|lint    # All packages
bun run check-types            # Type check
bun run generate               # Re-generate openapi.yml when suitable after making changes to the apps/api
cd apps/api && go run ./cmd/main.go # Run API server
```

## Scratchpad Notes

- Session/progress notes live in `scratchpad/`, not repo root.
- Prefer `chalk-<owner>-session-log-YYYY-MM-DD.md`.

## Testing Rules

- For UX changes or any user-facing feature/behavior change, do both: add/update the appropriate automated tests and verify in a real browser flow with the Agent Browser CLI.
- Use Agent Browser to exercise the changed flow end-to-end the way a user would: load the app, navigate the affected surfaces, interact with controls, and confirm the visible result.
- During browser verification, check realistic viewport scale/zoom/layout conditions as well, so spacing, overflow, clipping, responsiveness, and visual hierarchy are validated under normal viewing conditions.
- Prefer verifying in the Chalk demo/user-facing app that exposes the changed behavior after the package-level implementation is complete.
- Do not treat browser verification as optional for user-facing work unless the feature cannot be exercised locally; if blocked, state exactly what prevented Agent Browser testing.
- Agent Browser verification does not replace automated coverage. Keep writing tests wherever they fit; for bug fixes or previously broken behavior, add a regression test when feasible. Browser testing is the user-level proof on top.

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
- **admin**: Admin management app (limited-access, for owner only)
- **docs**: Chalk docs (`docs.chalk.q9labs.ai`, stable)
  **Demo apps (`apps/web`, `apps/next-pages-demo`) are for testing only.**

After packages → export → use in demo apps for user testing.
Sometimes (rarely) the user might want to directly work on the app and later create the sdk.

Never add client-side business logic to demo apps.

## SDK-First Guardrail

- For any product behavior, bug fix, feature, UX, observability, auth, networking, retries, or error handling: implement first in the Chalk package that owns it.
- Owner package examples: `sdk-core`, `sdk-react`, `chalk-whiteboard`, `ui` (not app-level first).
- Consumer apps should only do thin wiring/config, branding, and app-specific integration unless explicitly requested otherwise.
- Do not ship app-only logic as the primary fix when it should live in a Chalk package.
- If an app-only workaround is unavoidable, label it temporary and open/complete the SDK/package follow-up before closing the task.

## Skills

- `chalk-stress-testing` — project skill for stress test planning/execution.
- `release` — release skill (project only).

## Whisper Rollback Note

- If Whisper load/latency regresses on `c7i.large`, upgrade back to `c7i.xlarge` (spot).

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
