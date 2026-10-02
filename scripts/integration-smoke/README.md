# Production integration smoke

Run after the API deploy, from this branch with Node 22+. This uses the branch-built
server, browser, and webhook SDK entries, not registry packages. Endpoint management
uses the documented REST contract because the server SDK has no management wrapper.

```sh
pnpm install --frozen-lockfile
pnpm --filter @q9labsai/chalk-client build
pnpm --filter @q9labsai/chalk-client exec playwright install chromium
```

1. Create/select a Tenant in the dashboard, configure its media plane and Recording
   capacity, and add `http://127.0.0.1:9415` to its allowed origins.
2. Create a bootstrap key with `api_keys:write`, `api_keys:delete`, and every scope
   requested by the script. Keep the key in environment/secret storage.
3. Point a public HTTPS tunnel at `http://127.0.0.1:9415`, for example
   `cloudflared tunnel --url http://127.0.0.1:9415`. Local/private webhook targets
   are rejected by the API. Keep the tunnel running until the script exits.
4. Set `CHALK_API_KEY`, `CHALK_TENANT_ID`, and `CHALK_SMOKE_WEBHOOK_URL` to the
   tunnel's HTTPS URL with `/webhook` appended, then run:

```sh
node scripts/integration-smoke/run.mjs
```

Optional: `CHALK_API_URL` (defaults to `https://api.chalkmeet.com`),
`CHALK_SMOKE_MEDIA_PLANE` (defaults to `cf_sfu`), `CHALK_SMOKE_PORT` (9415).
API and Sync must use the managed `api.*` / `sync.*` hostname convention.

The script creates a one-hour Tenant-scoped key, registers a local receiver, creates
an Automatic Recording Space, and admits two Participants in two isolated Chromium
processes with fake microphones/cameras. It waits for both remote-media views and
`recording.started`, records 60 seconds, ends the Episode, requests an Export, verifies
the Episode and Recording Event signatures using raw bytes, and checks the MP4 download.
Events are deduplicated by ID in memory; this receiver is a smoke test, not a durable
production inbox. It does not test Transcript processing.

It revokes its key, deletes its endpoint, closes both browsers/receiver, and archives
its Space on success or failure. The archived Space and artifacts remain under the
Tenant's retention policy. Stop the task-owned tunnel afterward. No credentials,
grants, signed URLs, or raw Event bodies are written to disk.

The repository's local core disables Capture and Export by default. Transactional
artifact production is covered by the API PostgreSQL gate; it does not prove the
deployed Capture/Export fleet. A production PASS is required for the full media flow.

API-key create and rotate use a fresh UUID Idempotency-Key from the server SDK. They are not retried automatically because their secrets can only be returned once. Build the SDK from this checkout before running the smoke.
