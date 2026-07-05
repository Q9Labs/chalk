# Chalk

Open-source, cross-platform, ultra low-latency video conferencing built from scratch.

Jitsi and BigBlueButton are dependable but dated and hard to deploy. Zoom and Google Meet are polished but closed and costly. Chalk closes the gap: a flexible, robust core that small and medium teams can self-host from $30 and run secure, private calls on their own terms.

- **Self-hosted and private** — own your stack, no per-minute fees or vendor lock-in
- **Cross-platform** — Android, iOS, and web
- **Low latency** — runs on Cloudflare's global network
- **Extensible** — built to embed into your own applications
- **AI-native by design** — built as a foundation for AI tutoring, where a low-latency assistant can live inside the lesson

Six months in and on our second iteration.

---

What follows is minimal orientation only. Source of truth lives in the code and Terraform files.

## Common commands

```bash
pnpm install
pnpm run build
pnpm run dev
pnpm run test
pnpm run lint
pnpm run check-types
pnpm run generate
```

## Cost Model

See [`scratchpad/chalk-media-cost-model-2026-06-15.md`](./scratchpad/chalk-media-cost-model-2026-06-15.md) for the parametric media cost model, or open [`scratchpad/chalk-cost-calculator.html`](./scratchpad/chalk-cost-calculator.html) in a browser for the live calculator.

## Notes

- keep this README small to reduce drift
- avoid treating docs as the contract when code already defines it

## License

MIT. See [LICENSE](./LICENSE).
