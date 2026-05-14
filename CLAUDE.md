# Chalk

Ultra low-latency video conferencing built on Cloudflare RealtimeKit.

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm check-types
cd apps/api && go run ./cmd/main.go
```

## Project Layout

- `packages/sdk-core`: client logic, room management, transport integration,
  shared types, diagnostics, and webhook helpers.
- `packages/sdk-react`: React hooks and components.
- `packages/sdk-react-native`: React Native bindings and native integrations.
- `packages/chalk-whiteboard`: whiteboard features.
- `packages/ui`: shared UI primitives.
- `apps/api`: Go backend API.
- `apps/web`: web app and local verification surface.
- `apps/docs`: public documentation.
- `apps/mobile`: native demo app.
- `infrastructure`: infrastructure examples and deployable workers.

## Development Guidance

- Packages are the source of truth; apps should mostly be thin wiring and
  verification surfaces.
- Add focused tests for behavior changes.
- Keep public documentation and scratchpad notes free of private customer,
  machine, account, credential, and deployment details.
