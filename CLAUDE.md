# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Chalk** is an ultra low-latency, low-bandwidth optimized real-time video conferencing platform built on Cloudflare RealtimeKit. Primary use case: education (virtual classrooms, tutoring, lectures).

Monorepo managed by **Turbo** with **Bun** as package manager. All SDK packages published to GitHub Packages under `@q9labs/*` scope.

## Essential Commands

### Package Management & Setup

```bash
bun install              # Install all dependencies
bun run clean           # Clean build artifacts and node_modules
```

### Development

```bash
bun run dev             # Run all packages in dev mode (concurrent)
bun run build           # Build all packages
bun run check-types     # Type check all packages
bun run test            # Run all tests
bun run lint            # Run linters
```

### Development by Package

When working on a specific package or app, navigate to its directory and use its local scripts:

```bash
cd packages/sdk-core
bun run dev             # Watch mode for sdk-core
bun run build           # Build sdk-core
bun test                # Run sdk-core tests
```

Same applies to `apps/web`, `packages/sdk-react`, etc.

### Web App Development

```bash
cd apps/web
bun run dev             # Start Vite dev server on port 3000
bun run build           # Build for production
bun run preview         # Preview production build
bun run test            # Run Vitest tests
```

### API Development

The Go API is in `apps/api/`. Development requires Go v1.22+:

```bash
cd apps/api
go run ./cmd/main.go    # Run the API server locally
go test ./...           # Run all tests with coverage
```

## Monorepo Architecture

### Directory Structure

```
chalk/
├── packages/
│   ├── sdk-core/              # Vanilla JS SDK - low-level real-time client
│   ├── sdk-react/             # React hooks & components built on sdk-core
│   ├── sdk-react-native/      # React Native bindings (not yet implemented)
│   └── ui/                    # UI components library (Base UI + Tailwind)
├── apps/
│   ├── web/                   # Vite + React demo/reference application
│   └── api/                   # Go backend (Gin + PostgreSQL + WebSocket)
├── infrastructure/
│   └── terraform/             # AWS infrastructure as code (VPC, ECS, RDS, etc.)
└── .github/workflows/         # CI/CD pipelines (separate for API, SDK, infra)
```

### Workspace Configuration

- Bun workspaces with path aliasing in tsconfig.json
- **Path aliases**: `@q9labs/chalk-core`, `@q9labs/chalk-react`, `@q9labs/chalk-react-native`, `@q9labs/chalk-ui`
- SDKs use `--external` flags to avoid bundling React/core dependencies
- All packages published to GitHub Packages (not npm)

## Key Architectural Patterns

### SDK Architecture

Layered architecture with progressive abstraction:

1. **@q9labs/chalk-core** - Low-level WebRTC client (RealtimeKit wrapper), room management, type-safe API client with auto-transforms
2. **@q9labs/chalk-react** - React hooks (useRoom, useParticipants, useMedia, useDevices, useChat, useRecording) and ChalkProvider context
3. **@q9labs/chalk-react-native** - React Native bindings with platform-specific hooks (useBluetoothAudio, useSpeakerphone, usePermissions, useAudioRouting)
4. **@q9labs/chalk-ui** - Reusable UI component library (Base UI + TailwindCSS v4) with no Chalk-specific logic

**Key Features (v0.0.5):**

- **OpenAPI-first types**: Auto-generated from `apps/api/openapi.yaml` → `src/generated/api-types.ts`
- **TokenProvider pattern**: Dynamic JWT refresh callback for browser-safe auth (replaces deprecated apiKey)
- **Payload transforms**: Auto snake_case ↔ camelCase conversion between Go API and JS/TS
- **Result<T> type**: Type-safe error handling without exceptions
- **EventEmitter**: Token expiry events, auth failures

### Backend Architecture (Go)

Clean Architecture with strict layer separation:

- `cmd/main.go` - Entry point (server bootstrap, client initialization, graceful shutdown)
- `internal/config/` - Configuration management (env vars, validation)
- `internal/domain/` - Business logic (RoomService, ParticipantService, RecordingService, AuthDomain)
- `internal/interfaces/http/` - HTTP handlers (rooms, participants, recordings, tenants, auth) and middleware (JWT, API key auth)
- `internal/interfaces/websocket/` - Real-time messaging hub and client management
- `internal/infrastructure/` - Data access and external integrations:
  - `postgres/` - Type-safe queries via sqlc (tables: tenants, rooms, participants, recordings, audit_logs)
  - `cloudflare/` - RealtimeKit credential provider (meeting create/get/end)
  - `redis/` - Room state pub/sub and rate limiting
  - `auth/` - JWT generation/validation, API key hashing (bcrypt), token refresh
  - `storage/` - R2 (hot) and S3 (cold) recording archive with lifecycle manager

### API Authentication

Two-tier authentication system:

1. **API Key** (`X-API-Key` header or `Authorization: Bearer ck_*`)
   - Server-to-server requests, tenant API access
   - Format: `ck_live_<32 base64>` (production) or `ck_test_<...>` (testing)
   - Hashed with bcrypt for storage
   - Endpoints: `/api/v1/auth/token`, `/api/v1/tenants`

2. **JWT** (Bearer token with 15-min expiry)
   - Room operations, participant management, recordings
   - Refresh tokens for long-lived sessions (7 days)
   - HS256 signing with configurable secret
   - Claims: TenantID, RoomID, DisplayName, Role (host/participant), Permissions
   - Endpoints: All `/api/v1/rooms/*` and `/api/v1/recordings/*` paths

See `apps/api/internal/infrastructure/auth/` and `apps/api/internal/interfaces/http/middleware/auth.go`.

### Database Layer

- PostgreSQL via sqlc for type-safe SQL queries
- Database models auto-generated from SQL files in `apps/api/internal/infrastructure/postgres/`
- Tables: tenants, rooms, participants, recordings, audit_logs

## Important Integration Points

### Web App Status

`apps/web` is now **demo-only** application (not production UI):

- Built with Vite, React 19, TanStack Router v1, Nitro SSR
- Primarily demonstrates SDK usage patterns
- Real production UI being built as reusable components in Phase 2 (46 components planned)
- See `phase-2-ui-implementation.md` for roadmap (transcription, theming, interactive tours, accessibility)

### Cloudflare RealtimeKit

Backbone of real-time communication. The API acts as credential provider:

- WebRTC signaling: `@cloudflare/realtimekit@^1.2.2` (JS) and RealtimeKit API (Go)
- Clients request room credentials via API
- Short-lived credentials signed with Cloudflare private key
- Provider: `apps/api/internal/infrastructure/cloudflare/client.go`

### Frontend-Backend Communication

Web app (`apps/web`) uses the Go API as the backend:

- Room creation, user management, recording control
- WebSocket upgrade handled by Cloudflare RealtimeKit, not the API

### Testing Strategy

- **SDK packages**: Use `bun test` (Bun's built-in test runner)
- **Web app**: Vitest for unit/integration tests with jsdom
- **Go API**: Standard `go test` with table-driven tests

## Development Workflow

### Adding a New Feature

1. Identify which package(s) it affects (core SDK? React hooks? UI components? API?)
2. Make changes to the relevant package(s)
3. Update `internal/infrastructure/postgres/schema.sql` if database changes needed
4. Regenerate sqlc files: `sqlc generate` in `apps/api/`
5. Run `bun run check-types` to catch type errors
6. Run `bun run test` to ensure tests pass
7. Test in the web app (`apps/web`) or your own test application

### Publishing SDK Updates

SDKs are built with Bun and output to `dist/`:

- `npm publish` from within each package (future CI/CD integration)
- Currently used via workspace dependencies

### Infrastructure Changes

Changes to AWS infrastructure:

1. Modify `.tf` files in `infrastructure/terraform/`
2. Test with `terraform plan` in the relevant environment directory
3. Apply with `terraform apply`
4. CI/CD will validate via GitHub Actions

## Important Notes on Tooling

### Bun Usage

Per AGENTS.md, **always prefer Bun over Node.js**:

- `bun <file>` instead of `node`
- `bun run <script>` instead of `npm run`
- `bun test` instead of Jest/Vitest (though web app uses Vitest)
- Bun automatically loads `.env` files

### TypeScript Configuration

- **Strict mode enabled** across all packages
- **Path aliases** for monorepo imports
- **No unused locals/parameters** enforced
- **bundler** module resolution for optimal tree-shaking

### Turbo Configuration

Turbo caches build outputs to `dist/` for each package. Task dependencies:

- `build` depends on `^build` (upstream packages build first)
- `test` depends on `build`
- `check-types` depends on `^build`
- `lint` depends on `^build`

## Environment Variables

Common environment variables (check `.env.example` files):

- `DATABASE_URL` - PostgreSQL connection string (API)
- `CLOUDFLARE_API_TOKEN` - Cloudflare API authentication
- `API_URL` - Frontend API endpoint
- `CI` - Set by GitHub Actions for conditional behavior

## Debugging & Troubleshooting

- **Type errors**: Run `bun run check-types` to see all TypeScript errors
- **Build failures**: Check if upstream packages built successfully with `bun run build`
- **Test failures**: Run individual package tests with `cd packages/xxx && bun test`
- **API issues**: Check logs in `apps/api/cmd/main.go` and add debug logging as needed

## CI/CD Pipelines

Three **independent** GitHub Actions workflows triggered by path changes:

### 1. `api.yml` (Go Backend)

- Triggers: Changes in `apps/api/**`
- Jobs: lint (`golangci-lint`) → test (`go test -race -coverprofile`) → build (Linux amd64) → docker (multi-arch)
- Docker: Multi-platform image (amd64, arm64) → GitHub Container Registry (master push only)
- Coverage: Upload to codecov

### 2. `sdk.yml` (JavaScript/TypeScript)

- Triggers: Changes in `packages/**`, `package.json`, `bun.lock`
- Jobs: type-check (`bun check-types`) → lint → test → build → publish (on version tags)
- Publish: All 4 packages to GitHub Packages (@q9labs/chalk-core, etc.) with version tag
- Artifacts: Individual `dist/` outputs per package

### 3. `infra.yml` (Terraform)

- Triggers: Changes in `infrastructure/terraform/**`
- Environment progression: dev → staging → prod
- Jobs per env: validate (format + modules) → plan (artifact) → apply (auto for dev/staging, manual for prod)
- Modules: VPC, ECS, Aurora Serverless, ElastiCache, API Gateway, Secrets, WAF, monitoring, ECR

## Recent Major Changes (v0.0.5 - Dec 2025)

### OpenAPI-First SDK Development

- **Single source of truth**: `apps/api/openapi.yaml` (2,175 lines)
- **Auto-generated types**: `packages/sdk-core/src/generated/api-types.ts`
- **Regenerate**: `bun run generate:types` (Turbo task watches openapi.yaml)
- **Benefit**: SDK types always in sync with API spec, type-safe at boundaries

### TokenProvider Authentication Pattern

Replaced deprecated `apiKey` with browser-safe JWT refresh:

```typescript
// Old (deprecated)
const client = new ChalkClient({ apiKey: "ck_live_..." });

// New (recommended)
const client = new ChalkClient({
  tokenProvider: async () => {
    const res = await fetch("/api/chalk-token");
    return res.json().token;
  },
});
```

### Recording Lifecycle Management

New **ParticipantService** and **RecordingService** in `internal/domain/`:

- Start/stop recordings with state tracking
- Automatic R2 (hot) → S3 Glacier (cold) archival
- Recording ready webhooks from Cloudflare
- Full lifecycle manager in `internal/infrastructure/storage/lifecycle.go`

### Web App Consolidation

`apps/web` streamlined to **demo-only**:

- Focus on SDK integration patterns
- Real UI components being built in Phase 2

## Response Style

The user is extremely busy and working on multiple projects simultaneously. Hence, in all interactions, plans, and commit messages, you are expected to always be concise and sacrifice grammar for the sake of concision. Additionally, the user may forget certain information due to distractions and the load of their busy schedule, so you must always point back to the big picture and provide context when necessary. Always tell the user what was the issue/fix/feature you worked on, what you did, what files you touched, you're reasoning behind it, and how you did it?
