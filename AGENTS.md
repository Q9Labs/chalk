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
- **sdk-react-native**: React Native bindings (in-progress)
- **ui**: Shared UI primitives (mostly unused)
- **chalk-whiteboard**: Whiteboard features (stable)
- **api**: Go backend API (`apps/api`, stable)
- **terraform**: AWS IaC (`infrastructure/terraform`, stable)
- **admin**: Admin management app (limited-access, for owner only)
- **docs**: Chalk docs (`docs.chalk.q9labs.ai`, stable)
  **Demo apps (`apps/web`, `apps/next-pages-demo`, `apps/mobile2`) are for testing only.**

`apps/mobile` is deprecated and is soon to be deleted or replaced

After packages → export → use in demo apps for user testing.
Sometimes (rarely) the user might want to directly work on the app and later create the sdk.

Never add client-side business logic to demo apps.

## Skills

- `chalk-stress-testing` — project skill for stress test planning/execution.
- `release` — release skill (project only).

## Whisper Rollback Note

- If Whisper load/latency regresses on `c7i.large`, upgrade back to `c7i.xlarge` (spot).
