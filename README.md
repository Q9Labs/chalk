# Chalk

Chalk is an open-source monorepo for low-latency real-time collaboration and communication on Cloudflare Realtime. A Space is the durable place where Users and Agents participate; each bounded run is an Episode that can leave Recording and Transcript artifacts. The repository contains the Go control-plane API, Elixir SyncEngine, TypeScript/React/React Native SDKs, first-party web and mobile surfaces, reusable whiteboard/UI packages, and supporting infrastructure.

## Project documents

- [Theory](theory.md) — intent, product model and boundaries.
- [Tracker](tracker-human.md) · [interactive view](tracker-human.html) — outcomes and remaining work.
- [tracker.yaml](tracker.yaml) — the only editable outcome inventory.
- [Design](design.md) — visual system and Google Stitch generation guidance.

[Web SDK quickstart](docs/sdk-web-quickstart.md) documents executable SDK usage.

## Development

Install dependencies with `pnpm install`. The local stack needs OrbStack (or a
Docker-compatible daemon), Go, Elixir/OTP, OpenSSL, and 1Password CLI access
through the configured service account.

Run the core profile with:

```bash
pnpm dev
```

This starts Postgres, Redis, migrations, the Go API, Postgres-backed Sync, SDK
watchers, the web app, and local observability. It waits for readiness and
verifies a real no-track
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

`--fresh` replaces only this checkout's tenant and Space fixture. It leaves
backing services, unrelated rows, and caches in place.

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

## License

MIT. See [LICENSE](./LICENSE).

## Tracker workflow

Edit `tracker.yaml`, then run `pnpm generate:tracker`. `pnpm check:tracker`
validates states, priorities, sizes, source references and generated-view freshness;
`pnpm test:tracker` exercises the tooling. Both are part of the canonical gate.

Run `pnpm serve:tracker` for the read-only viewer at
`http://127.0.0.1:4176/tracker-human.html`. `TRACKER_PORT` overrides the port;
Ctrl-C stops the server. The HTML also opens directly as a file. Do not edit the
generated Markdown or HTML views.
