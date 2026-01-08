# CLAUDE.md

## Project Overview

**Chalk** - Ultra low-latency video conferencing for education (Cloudflare RealtimeKit).
Monorepo: **Turbo** + **Bun**. Packages → GitHub Packages `@q9labs/*`.

## Commands

```bash
bun install                    # Install deps
bun run dev|build|test|lint    # All packages
bun run check-types            # Type check
```

Per-package: `cd packages/sdk-core && bun run dev|build|test`

**API (Go 1.22+):**

```bash
cd apps/api && go run ./cmd/main.go    # Run
cd apps/api && go test ./...           # Test
```

## Structure

| Path                        | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `packages/sdk-core`         | Vanilla JS SDK - WebRTC client, room mgmt              |
| `packages/sdk-react`        | React hooks (useRoom, useParticipants, useMedia, etc.) |
| `packages/sdk-react-native` | React Native bindings (WIP)                            |
| `packages/chalk-whiteboard` | Chalk Whiteboard with Excalidraw                       |
| `packages/ui`               | UI components (Base UI + Tailwind v4)                  |
| `apps/web`                  | Demo app (Vite + React 19 + TanStack Router)           |
| `apps/api`                  | Go backend (Gin + PostgreSQL + sqlc)                   |
| `infrastructure/terraform`  | AWS IaC (VPC, ECS, Aurora, ElastiCache)                |

## SDK Architecture

Layered: `chalk-core` → `chalk-react` → `chalk-react-native` + `chalk-ui`

| Feature       | Description                                            |
| ------------- | ------------------------------------------------------ |
| OpenAPI types | `apps/api/openapi.yaml` → `src/generated/api-types.ts` |
| TokenProvider | JWT refresh callback (replaces deprecated apiKey)      |
| Transforms    | Auto snake_case ↔ camelCase                           |
| Result<T>     | Type-safe errors without exceptions                    |

## Backend (Go)

Clean Architecture:

- `cmd/main.go` - Entry point
- `internal/domain/` - Business logic (RoomService, ParticipantService, RecordingService)
- `internal/interfaces/http/` - Handlers + middleware (JWT, API key)
- `internal/infrastructure/` - postgres (sqlc), cloudflare, redis, auth, storage

## Authentication

| Type                     | Usage                              | Endpoints                                 |
| ------------------------ | ---------------------------------- | ----------------------------------------- |
| API Key (`ck_live_*`)    | Server-to-server, tenant API       | `/api/v1/auth/token`, `/api/v1/tenants`   |
| JWT (15min + 7d refresh) | Room ops, participants, recordings | `/api/v1/rooms/*`, `/api/v1/recordings/*` |

## CI/CD

| Workflow    | Trigger                       | Jobs                                                    |
| ----------- | ----------------------------- | ------------------------------------------------------- |
| `api.yml`   | `apps/api/**`                 | lint → test → build → docker (GHCR)                     |
| `sdk.yml`   | `packages/**`                 | type-check → lint → test → build → publish              |
| `infra.yml` | `infrastructure/terraform/**` | validate → plan → apply (dev/staging auto, prod manual) |

## Development Workflow

1. Identify affected packages
2. Make changes
3. DB changes? Update `schema.sql` → `sqlc generate`
4. `bun run check-types && bun run test`
5. Test in `apps/web`

**Infra changes:** Edit `.tf` → `terraform plan` → `terraform apply`

## Key Notes

- **Always use Bun** - `bun` not `node`, `bun run` not `npm run`
- **TypeScript strict mode** enabled, no unused vars
- **Turbo caching** - `build` depends on `^build`
- **RealtimeKit** - API provides credentials, Cloudflare handles WebRTC
- **Demo app only** - `apps/web` is reference impl, real UI in Phase 2

## UI & Theme Guide (minimal)

- Primary brand color: `packages/sdk-react/src/styles/variables.css` (`--chalk-brand`, `--chalk-brand-hover`) for SDK UI.
- Web app theme tokens: `apps/web/src/styles.css` (`--primary`, `--sidebar-primary`) for landing + app chrome.
- Meeting room demo styling uses Tailwind theme tokens in `apps/web/src/features/room/components/**` and `apps/web/src/routes/room/$roomId.tsx`.
- Light/dark: toggle root class (`html.dark` / `html.light`) in `apps/web/src/routes/__root.tsx`; SDK also reads `data-chalk-theme`.
