# Chalk

Chalk is an open-source monorepo for low-latency video conferencing on Cloudflare RealtimeKit. It contains the Go control-plane API, Elixir SyncEngine, TypeScript/React/React Native SDKs, first-party web and mobile surfaces, reusable whiteboard/UI packages, and supporting infrastructure.

The core room, session, admission, media-adapter, Sync v1, webhook, and telemetry boundaries are implemented. Chalk is still under active development: the hosted web product, public docs app, durable chat, native whiteboard, production recorder/transcription qualification, and managed operations are not complete.

Use these files instead of inferring product readiness from a component or route name:

- [`product.yaml`](./product.yaml) — canonical, machine-readable capability inventory
- [`checklist.md`](./checklist.md) — the same inventory as a domain-grouped checklist
- [`architecture.html`](./architecture.html) — interactive technical architecture and open boundary gaps
- [`docs/redesign/north-star.md`](./docs/redesign/north-star.md) — intended end state and deliberate v1 exclusions

## Development

Install dependencies with `pnpm install`. The local stack needs OrbStack (or a
Docker-compatible daemon), Go, Elixir/OTP, OpenSSL, and 1Password CLI access
through the configured service account.

Run the core profile with:

```bash
pnpm dev
```

This starts Postgres, Redis, migrations, the Go API, Postgres-backed Sync, the
local Wrangler Worker and Durable Object broker, SDK watchers, the web app,
and local observability. It waits for readiness and verifies a real no-track
connection through the Cloudflare SFU before it prints the summary. All Chalk
listeners use `127.0.0.1`; this command is for local development and never
touches production.

The mobile profile adds Expo and the existing simulator/device localhost
bridges after the core is ready:

```bash
pnpm dev --profile mobile
```

No connected device is a warning. A mobile-only failure leaves the ready core
running and marks the profile degraded.

The runtime reads exactly one approved non-production local Cloudflare SFU
`API_CREDENTIAL` from 1Password. The item must identify Chalk/SFU, include
`app_id` and `app_secret`, and not be marked production. The launcher reads it
at startup with an explicit vault on the item lookup, passes the values only
to the API child, and never writes or logs them. Zero or multiple matching
items stop startup.

The ready summary uses these localhost endpoints:

| Service | URL                                                                  |
| ------- | -------------------------------------------------------------------- |
| Web     | `http://127.0.0.1:3070`                                              |
| Broker  | `http://127.0.0.1:8787/local-chalk`                                  |
| API     | `http://127.0.0.1:8080`                                              |
| Sync    | `ws://127.0.0.1:4100/v1/sync`                                        |
| Grafana | `http://127.0.0.1:3000/d/chalk-observability-v1/chalk-observability` |
| Logs    | `.logs/dev-server.log`                                               |

Use the small command surface for inspection and cleanup:

```bash
pnpm dev:status
pnpm dev:logs                 # all services
pnpm dev:logs -- api          # one service
pnpm dev:smoke
pnpm dev:stop
pnpm dev --fresh              # recreate this checkout's local fixture
pnpm dev:reset                # destructive: asks before removing local state
pnpm dev:reset -- --yes       # skip only the confirmation prompt
```

`--fresh` replaces only this checkout's tenant, Space, broker key, and local
Durable Object fixture. It leaves backing services, unrelated rows, and caches
in place.

The core uses a dedicated `chalk_dev` database inside the shared
`chalk-postgres` container. A normal stop keeps that database and its volume.

`Ctrl-C` and `pnpm dev:stop` stop only processes and containers owned by the
runtime. They preserve Postgres and Redis volumes, observability data, package
caches, and other reusable local state. `dev:reset` is the destructive path:
it lists the owned containers, volumes, Worker state, and private runtime
directory, then drops and recreates only `chalk_dev`. It removes the Redis and
observability state while preserving the shared `chalk-postgres` container and
`chalk-postgres` volume. It acts only after the runtime has stopped. Run the
normal command again to restore the stack.

Run `pnpm run gate` for the canonical repository quality gate;
`pnpm run gate:explain` describes its checks.

## Cost model

[`scratchpad/chalk-infra-cost-model-2026-07-12.md`](./scratchpad/chalk-infra-cost-model-2026-07-12.md) contains dated planning assumptions and formulas. It is a model, not a current hosting-price guarantee. The interactive calculator is [`scratchpad/chalk-cost-calculator.html`](./scratchpad/chalk-cost-calculator.html).

## License

MIT. See [LICENSE](./LICENSE).
