# Chalk

Chalk is an open-source monorepo for low-latency real-time collaboration and communication with the Chalk SFU. A Space is the durable place where Users and Agents participate; each bounded run is an Episode that can leave Recording and Transcript artifacts. The repository contains the Go control-plane API, Elixir SyncEngine, TypeScript/React/React Native SDKs, first-party web and mobile surfaces, reusable whiteboard/UI packages, and supporting infrastructure.

## Project documents

- [Theory](theory.md) — intent, product model and boundaries.
- [Tracker](tracker-human.md) — outcomes and remaining work.
- [tracker.yaml](tracker.yaml) — the only editable outcome inventory.
- [Design](design.md) — visual system and Google Stitch generation guidance.

## Development

Install Git, Node.js, pnpm, and Docker Desktop, OrbStack, or Docker Engine. API, Sync, Postgres, and Redis run in containers on macOS, Linux, and Windows. Go, Elixir/Erlang, and OpenSSL are not host prerequisites.

Follow [Run Chalk locally](docs/getting-started.md) for OS-specific setup, the non-production SFU credential, Android, tests, and the PR workflow.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Wait for `Chalk dev ready`, then open the printed web URL. Use `pnpm dev --profile android` to add Metro. Inspect the stack with `pnpm dev:doctor`, `pnpm dev:smoke`, and `pnpm dev:logs`. Stop it with `pnpm dev:stop`, or remove its local runtime data with `pnpm dev:down`.

Run `pnpm gate` before submitting a change. Open a draft PR, finish checks and self-review, then check the ready cap before marking it ready. See [gate operations](scripts/gates/README.md).

## License

MIT. See [LICENSE](./LICENSE).

## Tracker workflow

Edit `tracker.yaml`, then run `pnpm generate:tracker`. `pnpm check:tracker`
validates states, priorities, sizes, source references and generated-view freshness
as part of the canonical gate.

Do not edit the generated Markdown view.
