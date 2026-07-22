# Chalk meeting broker

The meeting broker is the server-side boundary for the public web room. Cloudflare routes `https://chalkmeet.com/local-chalk/*` to this Worker before the Pages origin, while localhost keeps using `apps/web/scripts/local-chalk-backend.mjs` through the Vite proxy.

Each new meeting receives a 256-bit capability token and maps to one SQLite-backed Durable Object. The object persists the meeting lifetime, host, browser sessions, participant identities, and participant generations. It creates an idempotent Chalk session in one pre-provisioned room only when the SDK first requests access, then admits that browser and returns the short-lived participant access response. The API key, tenant, room, and transport endpoints remain Worker bindings and never enter the browser bundle.

The hard limits are an 8,192-byte JSON body, an 80-character display name, 32 browser sessions per meeting, a 60-minute meeting/cookie/session lifetime, 20 browser-session attempts per minute for an anonymous source, and 120 authenticated broker calls per browser session per minute. The host's cleanup ends the Chalk session and deletes the meeting's SQLite rows and alarm. Guest cleanup deletes only that guest's durable browser state. The Durable Object alarm repeats host-style cleanup at expiry, while the Chalk session's own remaining maximum duration is the independent upper bound. `CHALK_MEETING_LIFETIME_SECONDS` exists for short local alarm proofs but is clamped to 3,600 seconds in code.

## Deployment bindings

Deploy from this directory only after the pre-provisioned production room exists and all five required bindings are available:

```bash
pnpm exec wrangler secret put CHALK_API_KEY
pnpm exec wrangler secret put CHALK_TENANT_ID
pnpm exec wrangler secret put CHALK_ROOM_ID
pnpm exec wrangler deploy
```

`CHALK_ROOM_ID` must identify an active `cf_sfu` room owned by `CHALK_TENANT_ID`. The production API and Sync endpoints are committed as `https://api.chalkmeet.com` and `wss://sync.chalkmeet.com/v3/sync`. The committed route disables `workers.dev` and preview URLs, so production is reachable only through the narrow `chalkmeet.com/local-chalk/*` route. Verify `GET https://chalkmeet.com/local-chalk/health` after deployment; all state-changing routes require an exact `Origin: https://chalkmeet.com` and JSON `POST`.

## Local proof

Wrangler can exercise the actual Worker, SQLite Durable Object, alarm storage, and rate-limit bindings. Supply disposable local values on the command line and point `CHALK_API_URL` at a local fake or development API; never place credentials in a tracked file.

The checked-in end-to-end proof starts a service-bound fake Chalk API and two local Wrangler runtimes, verifies that browser-session creation has no upstream side effects, then exercises host admission, access refresh, capability-based guest admission, guest deletion, host meeting end, and alarm-driven expiry:

```bash
node test/wrangler-e2e.mjs
```

For interactive development, start Wrangler with disposable bindings:

```bash
pnpm exec wrangler dev --local \
  --var CHALK_APP_ORIGIN:http://127.0.0.1:8787 \
  --var CHALK_API_KEY:local-test \
  --var CHALK_TENANT_ID:local-test-tenant \
  --var CHALK_ROOM_ID:local-test-room \
  --var CHALK_API_URL:http://127.0.0.1:8790 \
  --var CHALK_SYNC_URL:ws://127.0.0.1:8791/v3/sync \
  --port 8787
```
