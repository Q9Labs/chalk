# Chalk

Chalk is an open-source monorepo for low-latency real-time collaboration and communication on Cloudflare Realtime. A Space is the durable place where Users and Agents participate; each bounded run is an Episode that can leave Recording and Transcript artifacts. The repository contains the Go control-plane API, Elixir SyncEngine, TypeScript/React/React Native SDKs, first-party web and mobile surfaces, reusable whiteboard/UI packages, and supporting infrastructure.

## Project documents

- [Theory](theory.md) — intent, product model and boundaries.
- [Tracker](tracker-human.md) — outcomes and remaining work.
- [tracker.yaml](tracker.yaml) — the only editable outcome inventory.
- [Design](design.md) — visual system and Google Stitch generation guidance.

## Development

Install dependencies with `pnpm install`. The local stack needs OrbStack (or a Docker-compatible daemon), Go, Elixir/OTP and OpenSSL, plus a Cloudflare SFU credential.

```bash
pnpm dev                    # core: Postgres, Redis, API, Sync, SDK watchers, web
pnpm dev --profile mobile   # core plus Expo and the simulator/device bridges
```

`pnpm dev` is for local development and never touches production. It prints the endpoints, a seeded Tenant and a Space on the `cf_sfu` media plane once a seeded guest can join and leave through the web origin. Use that Space for local end-to-end runs. Logs go to `.logs/dev-server.log`.

The credential is one non-production Cloudflare SFU `API_CREDENTIAL` item in 1Password that identifies Chalk/SFU and has `app_id` and `app_secret`. Zero or multiple matching items stop startup. On a headless machine set `CHALK_CLOUDFLARE_REALTIME_APP_ID` and `CHALK_CLOUDFLARE_REALTIME_APP_SECRET` instead (both, or startup fails). Set `PUBLIC_ORIGIN` when the web port sits behind another origin.

Inspect and clean up with `pnpm dev:status`, `dev:logs`, `dev:smoke`, `dev:doctor`, `dev:stop` and `dev:down`. `pnpm dev --fresh` recreates only this checkout's Tenant and Space. `pnpm dev:reset` is destructive and asks first. Only one local runtime can own a machine, so worktrees share its ports, database and containers. `dev:status` names the owner.

Run `pnpm run gate` for the canonical quality gate. `pnpm run gate:explain` describes its checks.

## License

MIT. See [LICENSE](./LICENSE).

## Tracker workflow

Edit `tracker.yaml`, then run `pnpm generate:tracker`. `pnpm check:tracker`
validates states, priorities, sizes, source references and generated-view freshness
as part of the canonical gate.

Do not edit the generated Markdown view.
