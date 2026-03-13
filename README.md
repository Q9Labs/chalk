# Chalk

Ultra low-latency video conferencing.

Minimal orientation only. Source of truth lives in the code and Terraform files.

## Common commands

```bash
bun install
bun run build
bun run dev
bun run test
bun run lint
bun run check-types
bun run generate
```

## Ground truth

For current behavior, read the owning source directly:

- API: `apps/api/`
- Web app: `apps/web/`
- Mobile app: `apps/mobile/`
- Docs site: `apps/docs/`
- SDKs: `packages/`
- Infra: `infrastructure/terraform/`
- Whisper worker: `infrastructure/whisper-worker/`
- CI/CD: `.github/workflows/`

## Notes

- keep this README small to reduce drift
- avoid treating docs as the contract when code already defines it

## License

Q9Labs — All rights reserved
