# E2E Webhook Pipeline Harness

Pure HTTP-level test harness for the backend pipeline:
simulated Cloudflare recording webhook → recording download → R2 upload → transcription → AI summary/action items → post-meeting webhook delivery.

## Run

1. Copy `apps/e2e/.env.example` → `apps/e2e/.env` and fill values.
2. Ensure `cloudflared` is installed and on your PATH.
3. Run:

```bash
bun run test:e2e
```

`bun run test` will skip this harness by default. To run it explicitly, use `bun run test:e2e`.

If you want missing env vars to fail the run (instead of skipping), use `bun run test:e2e:require` (or pass `--require`).
To require env vars from the root, run `bun run test:e2e:require`.

## Monitor mode

```bash
bun run --cwd apps/e2e test:monitor
```

Keeps the webhook receiver + tunnel running after the first run, so you can re-trigger the pipeline externally and observe incoming deliveries.
