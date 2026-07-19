# Chalk

Chalk is an open-source monorepo for low-latency video conferencing on Cloudflare RealtimeKit. It contains the Go control-plane API, Elixir SyncEngine, TypeScript/React/React Native SDKs, first-party web and mobile surfaces, reusable whiteboard/UI packages, and supporting infrastructure.

The core room, session, admission, media-adapter, Sync v3, webhook, and telemetry boundaries are implemented. Chalk is still under active development: the hosted web product, public docs app, durable chat, native whiteboard, production recorder/transcription qualification, and managed operations are not complete.

Use these files instead of inferring product readiness from a component or route name:

- [`product.yaml`](./product.yaml) — canonical, machine-readable capability inventory
- [`checklist.md`](./checklist.md) — the same inventory as a domain-grouped checklist
- [`architecture.html`](./architecture.html) — interactive technical architecture and open boundary gaps
- [`docs/redesign/north-star.md`](./docs/redesign/north-star.md) — intended end state and deliberate v1 exclusions

## Development

Install dependencies with `pnpm install`. Run `pnpm run gate` for the canonical repository quality gate; `pnpm run gate:explain` describes its checks.

## Cost model

[`scratchpad/chalk-infra-cost-model-2026-07-12.md`](./scratchpad/chalk-infra-cost-model-2026-07-12.md) contains dated planning assumptions and formulas. It is a model, not a current hosting-price guarantee. The interactive calculator is [`scratchpad/chalk-cost-calculator.html`](./scratchpad/chalk-cost-calculator.html).

## License

MIT. See [LICENSE](./LICENSE).
