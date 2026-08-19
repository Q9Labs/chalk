# Chalk Episode broker

The broker is the server-side `AccessGrant` boundary for Chalk web and native
clients. Cloudflare routes `https://chalkmeet.com/local-chalk/*` to this Worker
before the Pages origin. The supervised local stack proxies the same path to
Wrangler, while the web app's local backend remains its narrow development
fallback.

Each new Space invite receives a 256-bit capability token and maps to one
SQLite-backed `EpisodeLease` Durable Object. The lease persists its deadline,
creator and Participant credentials, Participant identities, Participant
generations, and the lease's Space ID. A new invite creates one isolated,
one-hour Cloudflare SFU Space. The first `AccessGrant` creates its Episode in
that Space. Joining the invite reuses the same Space. Creator cleanup or the
deadline ends the Episode and archives the Space. The API key, tenant, legacy
Space fallback, and transport endpoints remain Worker bindings and never enter
client bundles.

The hard limits are an 8,192-byte JSON body, an 80-character display name, 32
Participant credentials per Episode, a 60-minute Episode deadline, 20
credential-creation attempts per minute for an anonymous source, 10 new Spaces
per minute across the Worker, and 120 authenticated broker calls per Participant
credential per minute. Creator cleanup ends the Episode, archives its Space,
and deletes the lease rows and alarm. Participant
cleanup deletes only that Participant's durable credential state. The Durable
Object alarm repeats creator cleanup at the deadline, while the Episode's own
remaining maximum duration is the independent upper bound.
`CHALK_EPISODE_DEADLINE_SECONDS` supports short local alarm proofs and is
clamped to 3,600 seconds in code.

## Local development

`pnpm dev` is the supported local path. It starts the real Worker and the
SQLite-backed Durable Object with the app, API, and Sync endpoints on
localhost. The supervisor bootstraps disposable local Space data, maps the
canonical credential names at the Worker adapter, and passes them through the
child environment. Credentials never appear in `--var` arguments, tracked
files, browser code, or logs.

To run the checked-in Worker proof, use:

```bash
pnpm test:e2e
```

## Staged production cutover

This is a breaking route migration. Do not run a direct deployment from the
checked-in production configuration: its route can replace the currently
serving Worker. Execute every item below in order with the production owner;
record the target account, Worker, namespace, route, and verification evidence
outside the public repository.

- [ ] Confirm the target Cloudflare account, the current Worker serving
      `chalkmeet.com/local-chalk/*`, and an isolated staging route. Provision
      `chalk-episode-broker` with no production route first. Its
      `EPISODE_LEASES` / `EpisodeLease` namespace is intentionally fresh; do not
      attempt to rename or reuse the legacy Durable Object namespace.
- [ ] Configure the target Worker before exposing it: set the `CHALK_API_KEY`,
      `CHALK_TENANT_ID`, and `CHALK_SPACE_ID` secrets; set
      `CHALK_APP_ORIGIN`, `CHALK_API_URL`, `CHALK_SYNC_URL`, and
      `CHALK_EPISODE_DEADLINE_SECONDS`; and verify the
      `CREATE_RATE_LIMITER` and `EPISODE_RATE_LIMITER` bindings resolve in the
      target account. `CHALK_SPACE_ID` must identify an active `cf_sfu` provider
      Space owned by `CHALK_TENANT_ID`.
- [ ] On the isolated route, verify the target Worker health endpoint, browser
      cookie flow, native opaque-credential flow, initial and refreshed
      `AccessGrant`s, Participant cleanup, creator cleanup, alarm expiry, and
      structured trace/log emission. Confirm the user-visible monitor is checking
      the target before the production route changes.
- [ ] Ship the coordinated Wave 3 native and Wave 4 web clients. They must use
      `/participant-credentials`, `/access-grants`, and
      `/participant-credentials/cleanup`, the `spaceInviteToken` and
      `participantCredentialId` fields, and the browser
      `__Secure-chalk_participant_credential` cookie. There are no compatibility
      aliases, so block the route transfer until those releases are available.
- [ ] Freeze only legacy credential creation. Keep legacy access refresh and
      cleanup available, record the final credential-creation time, and observe
      remaining legacy traffic and Durable Object alarms.
- [ ] Drain legacy leases for at least the maximum 3,600-second lease lifetime
      plus an explicit operational margin, measured from that final creation time.
      Do not transfer the route until the drain evidence shows no active legacy
      lease or credential traffic.
- [ ] Transfer `chalkmeet.com/local-chalk/*` atomically to the target Worker.
      Re-run health, new browser and native creation/resume, `AccessGrant` refresh,
      Participant and creator cleanup, deadline alarm, trace/log, and monitor
      proofs on the exact production route.
- [ ] Keep the legacy Worker, namespace, bindings, and rollback evidence for
      the agreed retention window. If production proof fails, restore the prior
      route together with the matching client release; credentials created by the
      target require a fresh credential after that rollback. Do not delete either
      namespace during rollback.
- [ ] Retire the legacy Worker only after the retention window, zero-traffic
      evidence, and the production owner approve the final cleanup.

The committed production route disables `workers.dev` and preview URLs, so the
target is reachable only through the narrow `chalkmeet.com/local-chalk/*`
route after transfer. Browser requests require an exact
`Origin: https://chalkmeet.com`; native requests use the platform's normal
no-`Origin` form. Every state-changing route requires a JSON `POST`.

The shared client contract has two plural resources:

- `POST /participant-credentials` creates, joins, or resumes an opaque
  Participant credential. Browser callers receive the credential only through
  the `HttpOnly` cookie; native callers receive `participantCredentialId` and
  `spaceInviteToken` in the response.
- `POST /access-grants` issues or refreshes an opaque `AccessGrant`. Browser
  callers identify through the cookie; native callers submit the two opaque
  credential values.
- `POST /participant-credentials/cleanup` removes a Participant credential or
  ends the Episode when the credential belongs to its creator.

## Local proof

Wrangler exercises the actual Worker, SQLite Durable Object, alarm storage,
and rate-limit bindings. Supply disposable local values on the command line
and point `CHALK_API_URL` at a local fake or development API. Never place
credentials in a tracked file.

The checked-in end-to-end proof starts a service-bound fake Chalk API and two
local Wrangler runtimes. It verifies one isolated Space per new invite, same
Space reuse for invite joins, browser and native admission, `AccessGrant`
refresh, Participant cleanup, creator Episode end, Space archive, and
deadline-driven expiry:

```bash
node test/wrangler-e2e.mjs
```

For interactive development, start Wrangler with disposable bindings:

```bash
pnpm exec wrangler dev --local \
  --var CHALK_APP_ORIGIN:http://127.0.0.1:8787 \
  --var CHALK_API_KEY:local-test \
  --var CHALK_TENANT_ID:local-test-tenant \
  --var CHALK_SPACE_ID:local-test-space \
  --var CHALK_API_URL:http://127.0.0.1:8790 \
  --var CHALK_SYNC_URL:ws://127.0.0.1:8791/v1/sync \
  --port 8787
```
