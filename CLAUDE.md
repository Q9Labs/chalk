# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Chalk** is an ultra low-latency, low-bandwidth optimized real-time video conferencing platform built on Cloudflare RealtimeKit. The primary use case is education (virtual classrooms, tutoring, lectures).

This is a monorepo managed by **Turbo** with **Bun** as the package manager.

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

- Uses Bun workspaces with path aliasing in tsconfig.json
- Path aliases: `@chalk/core`, `@chalk/react`, `@chalk/react-native`, `@chalk/ui`
- SDKs use `--external` flags to avoid bundling React/core dependencies

## Key Architectural Patterns

### SDK Architecture

The SDK is structured in tiers:

1. **@chalk/core** - Low-level WebRTC client, room management, state synchronization
2. **@chalk/react** - React hooks (useRoom, useParticipants, useMedia) and context providers
3. **@chalk/ui** - Reusable UI components (buttons, modals, etc.) using Base UI + TailwindCSS

### Backend Architecture (Go)

The API uses Clean Architecture with clear separation:

- `cmd/main.go` - Entry point
- `internal/config/` - Configuration management
- `internal/domain/` - Business logic and domain types
- `internal/interfaces/http/` - HTTP handlers and middleware
- `internal/infrastructure/` - Data access (PostgreSQL via sqlc), external integrations
- `internal/infrastructure/cloudflare/` - Cloudflare RealtimeKit client

### API Authentication

Two authentication methods:

- **API Key** (`X-API-Key` header) - Server-to-server and basic client requests
- **JWT** (Bearer token) - User sessions and fine-grained permissions

See `apps/api/internal/interfaces/http/middleware/auth.go` for implementation.

### Database Layer

- PostgreSQL via sqlc for type-safe SQL queries
- Database models auto-generated from SQL files in `apps/api/internal/infrastructure/postgres/`
- Tables: tenants, rooms, participants, recordings, audit_logs

## Important Integration Points

### Cloudflare RealtimeKit

The backbone of real-time communication. The API acts as a credential provider:

- Clients request credentials via the `/auth/credentials` endpoint
- Credentials are short-lived JWT tokens signed with Cloudflare private key
- Stored in `apps/api/internal/infrastructure/cloudflare/`

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

Three separate GitHub Actions workflows in `.github/workflows/`:

- `api.yml` - Builds and tests Go backend
- `sdk.yml` - Builds and tests all SDK packages and web app
- `infra.yml` - Validates and applies Terraform changes

Workflows only run on changes to their respective directories (via path filters).

## Response Style

The user is extremely busy and working on multiple projects simultaneously. Hence, in all interactions, plans, and commit messages, you are expected to always be concise and sacrifice grammar for the sake of concision. Additionally, the user may forget certain information due to distractions and the load of their busy schedule, so you must always point back to the big picture and provide context when necessary. Always tell the user what was the issue/fix/feature you worked on, what you did, what files you touched, you're reasoning behind it, and how you did it?
