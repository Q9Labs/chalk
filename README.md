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

## Cost Formulas (Quick Reference)

- RealtimeKit participant-minutes: `participant_minutes = sessions * avg_minutes * avg_participants`
- RealtimeKit A/V cost: `participant_minutes * 0.002`
- RealtimeKit audio-only cost: `participant_minutes * 0.0005`
- SFU egress estimate (GB): `participant_minutes * avg_downlink_mbps * 0.0075`
- SFU cost: `max(0, sfu_gb - 1000) * 0.05` (1000 GB free pool, then $0.05/GB)

## Notes

- keep this README small to reduce drift
- avoid treating docs as the contract when code already defines it

## License

MIT. See [LICENSE](./LICENSE).
