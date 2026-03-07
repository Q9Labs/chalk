# Chalk

Ultra low-latency video conferencing for education. Built on Cloudflare RealtimeKit.

## Monorepo Structure

```
chalk/
├── packages/
│   ├── sdk-core/              # @q9labs/chalk-core — Vanilla JS/TS SDK
│   ├── sdk-react/             # @q9labs/chalk-react — React hooks & components
│   ├── sdk-react-native/      # @q9labs/chalk-react-native — React Native SDK
│   ├── chalk-whiteboard/      # @q9labs/chalk-whiteboard — Excalidraw sync engine
│   └── ui/                    # @q9labs/chalk-ui — Headless UI primitives (Base UI + Tailwind)
├── apps/
│   ├── api/                   # Go backend (Gin, sqlc, Clean Architecture)
│   ├── web/                   # Demo app (Vite + React 19 + TanStack Router)
│   ├── ios/                   # Native iOS app (WIP)
│   ├── android/               # Native Android app (WIP)
│   ├── native/                # Native app specs + findings (living docs)
│   ├── docs/                  # Documentation site (Astro + Starlight)
│   └── e2e/                   # End-to-end test suite
├── infrastructure/
│   ├── terraform/             # AWS IaC (ECS, Aurora, ElastiCache, WAF, etc.)
│   └── whisper-worker/        # Whisper transcription service (Python)
├── tests/                     # Load testing (Artillery, k6, WebRTC)
└── .github/workflows/         # CI/CD (api-lean.yml, infra-lean.yml, sdk.yml, web.yml, whisper-worker.yml)
```

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) 1.1+ · [Go](https://go.dev) 1.24+ · [Terraform](https://terraform.io) 1.5+ (optional)

```bash
bun install          # Install deps
bun run build        # Build all packages
bun run dev          # Dev mode (all packages)
bun run test         # Run tests
bun run check-types  # Type check
bun run generate     # Generate OpenAPI types from apps/api/openapi.yaml
```

### Mobile

Native app specs + integration notes live in `apps/native/`.

## Architecture

### Backend

| Layer         | Tech                                                |
| ------------- | --------------------------------------------------- |
| Framework     | Go + Gin, Clean Architecture                        |
| Database      | PostgreSQL (Aurora Serverless v2) via sqlc          |
| Cache         | Redis (ElastiCache) — room state, rate limiting     |
| Auth          | API Key + JWT (15-min expiry, 7-day refresh)        |
| Real-time     | WebSocket for participant state & recording updates |
| Transcription | Whisper worker (Python, ECS)                        |

### Frontend SDKs

| Layer              | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `sdk-core`         | Client logic, WebRTC, room management, token refresh |
| `sdk-react`        | React hooks, context, Storybook component library    |
| `sdk-react-native` | RN bindings, platform-specific hooks, RTCManager     |
| `chalk-whiteboard` | Excalidraw sync engine + React integration           |
| `ui`               | Headless primitives (Base UI + Tailwind)             |

- OpenAPI-driven types auto-generated from `apps/api/openapi.yaml`
- Automatic `snake_case` <-> `camelCase` conversion (Go <-> JS)
- `Result<T>` error handling (no exceptions)
- `TokenProvider` pattern for secure JWT refresh

### Real-Time

- **WebRTC:** Cloudflare RealtimeKit (SFU), < 5 Mbps per participant
- **Signaling:** WebSocket upgrade via API

### Storage

| Tier      | Service       | Purpose                             |
| --------- | ------------- | ----------------------------------- |
| Hot       | Cloudflare R2 | Immediate access                    |
| Cold      | S3 Glacier    | Long-term archival                  |
| Lifecycle | Automatic     | R2 -> S3 after recording completion |

### Infrastructure

| Resource | Service                           |
| -------- | --------------------------------- |
| Compute  | EC2 `t4g.micro` (prod-lean)       |
| Database | PlanetScale Postgres              |
| Cache    | Upstash Redis                     |
| CDN/WAF  | Cloudflare edge + Caddy TLS       |
| DNS      | Cloudflare DNS                    |
| Secrets  | SSM Parameter Store               |
| IaC      | Terraform (dev/prod-lean)         |

## License

Q9Labs — All rights reserved
