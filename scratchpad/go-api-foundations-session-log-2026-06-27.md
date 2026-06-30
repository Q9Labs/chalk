# Go API Foundations Session Log

Date: 2026-06-27

## Context

We are preparing the Chalk Go API before implementing endpoints. Hasan wants to
write the first core patterns manually with Codex guiding/reviewing, then let
Codex fill in later pattern-matched endpoints once the foundations are
intentional.

## Tooling Setup

- Local Go is `go1.24.2` at `/usr/local/go/bin/go`.
- Existing `gopls` was `v0.19.1`, which did not expose the MCP command.
- Installed `gopls v0.20.0`, the first stable MCP-capable version that declares
  `go 1.24.2`.
- Smoke-tested `gopls mcp` over stdio from `apps/api`; it initialized, listed
  tools, and `go_workspace` detected module
  `github.com/q9labs/chalk/apps/api`.
- Added Codex MCP config entry `gopls_chalk_api` that starts `gopls mcp` from
  `/Users/macmini/code/chalk/apps/api`.

## Go Gate

Added `apps/api/scripts/gate.sh`:

- sets `GOTOOLCHAIN=${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}`;
- checks Go version;
- checks `gofmt` without mutating;
- runs `go mod tidy -diff`;
- runs `go test ./...`;
- runs `go vet ./...`;
- runs pinned `go tool staticcheck ./...`;
- runs pinned `go tool govulncheck ./...`;
- optionally runs `go test -race ./...` when `CHALK_API_RACE=1`.

Added `apps/api/scripts/format.sh` for intentional `gofmt -w`.

Pinned Go tools in `apps/api/go.mod`:

- `honnef.co/go/tools/cmd/staticcheck@v0.6.1`
- `golang.org/x/vuln/cmd/govulncheck@v1.1.4`

## Gate Toolchain Policy

The system Go binary is still older than the API module target, but
`apps/api/scripts/gate.sh` now uses
`GOTOOLCHAIN=${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}`. This makes the
patched Go version explicit and cacheable without requiring a root-owned
`/usr/local/go` replacement.

`apps/api/go.mod` declares `go 1.25.11` because `govulncheck` reported
standard-library vulnerabilities in the previous `go1.24.4` API toolchain; the
highest fixed version reported was `go1.25.11`.

To force a different patched toolchain locally:

```bash
CHALK_API_GOTOOLCHAIN=go1.25.11+auto apps/api/scripts/gate.sh
```

Plain Go commands inside `apps/api` work with the default `GOTOOLCHAIN=auto`;
do not force `GOTOOLCHAIN=local` unless the system Go install has been patched
to at least `1.25.11`.

## Verified Gate Result

After switching the gate to `go1.25.11+auto`, `apps/api/scripts/gate.sh`
passed:

- format check;
- `go mod tidy -diff`;
- `go test ./...`;
- `go vet ./...`;
- `go tool staticcheck ./...`;
- `go tool govulncheck ./...`.

The vulnerability check reported no reachable vulnerabilities.

The root canonical gate now calls `apps/api/scripts/gate.sh` from
`scripts/gates/commit.sh` when the API app is present. `pnpm run gate:hygiene`
passes with this wiring.

Note: early worksheet/review/gopls evaluation docs were later removed during
handoff cleanup once the implementation, README, gate, and tests carried the
useful decisions.

Added `apps/api/scripts/smoke-healthz.sh`, a post-implementation verifier for
the first manual route slice. It is intentionally not part of the current gate
because the API still has a stub `main.go`.

Added `apps/api/docs/dependency-notes.md` for early `chi` due diligence, then
removed it during docs cleanup once the decision and useful workflow notes moved
into the API README, `AGENTS.md`, and gate descriptions.

`codex mcp get gopls_chalk_api` confirms the server is configured and enabled.
This active session still did not expose the new MCP tool namespace, so a fresh
Codex session may be needed before using `go_workspace` directly.

## Router Architecture Clarification

Hasan clarified that the API should align with
`docs/redesign/north-star.md`: composable, hexagonal boundaries; swappable
`MediaPlane` and `SyncEngine` ports; provider details behind adapters; and a
self-host-friendly app tier.

Updated the API guides to treat `chi` as the chosen router and to recommend:

- one public REST version boundary under `/v1`;
- operational routes such as `/healthz` outside `/v1`;
- Pattern 2 mount functions for root composition and tiny route groups;
- Pattern 4 mounted domain HTTP adapters once a domain has enough routes,
  middleware, ports, or service wiring to own an inbound adapter package;
- HTTP handlers as translators into application/domain services, not as the
  domain layer.

## Lifecycle Gate

Added `apps/api/scripts/smoke-lifecycle.mjs` and wired it into
`apps/api/scripts/gate.sh`. It builds the API binary, starts it on a local port,
measures time until `GET /healthz` returns `200`, sends `SIGTERM`, and measures
time until the process exits cleanly.

Default budgets:

- startup readiness: `3000ms`
- graceful shutdown: `3000ms`

Both are configurable with `CHALK_API_LIFECYCLE_STARTUP_BUDGET_MS` and
`CHALK_API_LIFECYCLE_SHUTDOWN_BUDGET_MS`. The initial local run passed at about
`33-39ms` startup and `2ms` shutdown.

## Config Layer

Added `apps/api/internal/config` as the env-only config boundary. Current
variables:

- `CHALK_API_ADDR`, default `:8080`
- `CHALK_DATABASE_URL`, default
  `postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable`
- `CHALK_DATABASE_MAX_CONNS`, default `10`
- `CHALK_DATABASE_MIN_CONNS`, default `0`

The API binary should stay provider-agnostic: Cloudflare, AWS, shell,
containers, or future self-hosting environments inject config/secrets into the
process environment. The binary reads environment variables and does not call
vendor secret managers during startup.

## Database Foundation

Added a first Postgres foundation around `pgxpool`:

- config remains env-only and provider-agnostic;
- local development defaults to ordinary Postgres on `127.0.0.1:5432`;
- pool sizes are parsed as typed config values;
- `internal/postgres` owns pool construction and pinging, but `cmd/main.go`
  now opens the database before serving; `/healthz` remains process-only while
  `/readyz` pings Postgres;
- `apps/api/scripts/dev-postgres.sh` provides an explicit local Postgres helper
  for OrbStack/Docker-backed development and defaults to `postgres:18.3-alpine`
  to match PlanetScale's supported Postgres 18 minor version.
- local Postgres data lives in the named Docker volume
  `chalk-postgres`, mounted at `/var/lib/postgresql` for the official
  Postgres 18 image layout; `rm` removes only the container, while `wipe`
  removes the container and volume.

## Query And Migration Tooling

Chose `sqlc + pgx` for queries and `goose` for migrations.

- `sqlc v1.30.0` is pinned as a Go tool because newer `v1.31.1` requires Go
  `1.26`; the API module remains on patched Go `1.25.11`.
- `goose v3.27.1` is pinned as a Go tool.
- `sqlc.yaml` generates `pgx/v5` query code into `internal/postgres/db`.
- SQL queries live under `db/queries`; generated files are not edited manually.
- Versioned migrations live under `db/migrations` with `-- +goose Up` and
  `-- +goose Down` sections.
- `scripts/db-generate.sh` runs sqlc generation.
- `scripts/db-migrate.sh` runs goose explicitly; API startup does not apply
  migrations.
