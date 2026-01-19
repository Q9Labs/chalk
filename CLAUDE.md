# Chalk

Ultra low-latency video conferencing for education (Cloudflare RealtimeKit).
Monorepo: Turbo + Bun. Packages → GitHub Packages `@q9labs/*`.

## Commands

```bash
bun install                    # Install deps
bun run dev|build|test|lint    # All packages
bun run check-types            # Type check
cd apps/api && go run ./cmd/main.go
```

## Where to Write Code

**Packages first, then demo in apps:**

- **sdk-core**: Client logic, WebRTC, room management
- **sdk-react**: React hooks, components
- **sdk-react-native**: React Native bindings
- **ui**: Shared UI primitives
- **chalk-whiteboard**: Whiteboard features
- **api**: Go backend (`apps/api`)
- **terraform**: AWS IaC (`infrastructure/terraform`)

**Demo apps (`apps/web`, `apps/next-pages-demo`, `apps/mobile`) are for testing only.**
After packages → export → use in demo apps for user testing.

Never add client-side business logic to demo apps.
