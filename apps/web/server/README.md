# Dashboard server

The static site uses named Cloudflare Pages Functions only under `/auth/*` and
`/dashboard-api/*`. `server/` is imported only by those Functions. The production
composition root imports WorkOS, never `tests/dashboard/fixture-provider.ts`.
There is no dashboard database or generic engine proxy. The production web build
emits `dist/client/_worker.js` and its generated `_routes.json`, so the existing
release archive includes the Functions while site/docs paths remain static.

## Browser contract

Import DTOs and request schemas from `src/lib/dashboard/contracts.ts`.
All responses, including errors and redirects, are `Cache-Control: no-store`.
POST JSON with `Origin` equal to `DASHBOARD_ORIGIN` and `X-CSRF-Token` obtained
from `GET /auth/session`. GET dashboard endpoints never refresh or provision.
An expired session returns `RefreshRequiredDTO` (401) with a CSRF token derived
from the still-valid signed binding cookie, so a new tab can bootstrap refresh
without cached JS state. Follow it with `POST /auth/refresh`;
retry a 503 later without discarding the cookie. A terminal refresh clears it.
Serialize refresh in the UI; WorkOS owns its 30-second replay-grace semantics.

- `GET /auth/start?provider=google|apple&returnTo=/dashboard`: PKCE redirect.
- `GET /auth/callback`: fixed code/state callback; clears the login transaction.
- `GET /auth/session`: profile plus session-bound CSRF token, no provider tokens.
- `POST /auth/refresh`, `POST /auth/sign-out`: strict empty JSON object.
  Sign-out revokes the provider session; clear this account's local bookmarks
  when `clearLocalBookmarks` is true.
- `GET /dashboard-api/home?cursor=...`: owned, unarchived Spaces and one batch live
  read. `POST`: `HomeAction`.
- `GET /dashboard-api/call?spaceId=...&cursor=...`: call, signed invite and Episode
  history. `POST`: `CallAction` (settings, rotate link, knocks, end for everyone).
- `GET /dashboard-api/past-session?spaceId=...&episodeId=...&cursor=...`: Episode, recordings,
  and attendance availability. `POST`: `PastSessionAction` (artifact URLs,
  transcripts, export, deletion). Artifact URLs are short-lived; request again
  on expiry. The caller never supplies storage keys.
- `GET /dashboard-api/developer?keyCursor=...&webhookCursor=...`: keys and webhooks. `POST`:
  `DeveloperAction`. Secret-creation/rotation returns only the newly minted
  user-requested secret; list/read DTOs cannot contain secrets. Webhook update
  and deletion require the displayed revision and a stable idempotency key.

Joined-only bookmarks use the existing public invite/call client. Owner `join`
prepares the Entrance, creates/reuses a live Episode and admits an owner Guest.
`refresh-access` takes only a Space ID and optional current media token (absence requests a replacement media connection): the
Participant identity and generation come from a session-bound, purpose-sealed
HttpOnly seat cookie. No action accepts an arbitrary Participant ID or promotes
a joined-only call to owned status.
The server does not return Tenant configuration, WorkOS tokens, service bearer,
provider credentials, recording storage keys, webhook events or raw responses.

## Bindings

Set non-secret vars per Pages environment in `wrangler.toml` / Pages settings:
`CHALK_ENVIRONMENT` (`local|test|staging|production`), `CHALK_API_ORIGIN`,
`DASHBOARD_ORIGIN` (exact origin, no trailing slash), `WORKOS_CLIENT_ID`,
`WORKOS_REDIRECT_URI` (exactly `<DASHBOARD_ORIGIN>/auth/callback`), and
`DASHBOARD_IDENTITY_PROVIDER=workos`.

Provision these **secret** bindings from 1Password vault `dev` into Pages;
never commit values, print them, or expose them through `VITE_*`:

- `WORKOS_API_KEY`: environment's WorkOS server key.
- `WORKOS_COOKIE_PASSWORD`: >=32 random characters; rotating it invalidates login
  transactions, CSRF bindings and all sealed sessions.
- `DASHBOARD_SERVICE_TOKEN`: engine's dedicated, explicitly scoped service bearer,
  not System and not a user's API key. Tenant identity is always resolved from
  `workos:<CHALK_ENVIRONMENT>:<WorkOS user ID>` on each request, never browser input.

Configure WorkOS Google and Apple connections only, the fixed callback URI, and
access-token lifetime **at most 300 seconds**. The adapter rejects longer-lived
JWTs. Sensitive operations additionally query WorkOS's online session list;
revoked/expired sessions cannot create or rotate credentials, delete resources,
archive a call, or end an Episode. A WorkOS outage fails closed for these actions. Webhook updates are also online-
gated because changing their destination can redirect sensitive deliveries.
No D1, KV, R2 or other dashboard storage bindings are required.

HTTPS uses `__Host-chalk_session` and similarly prefixed login/binding cookies,
with `Secure; HttpOnly; SameSite=Lax; Path=/` and no Domain attribute. Explicit
loopback HTTP local/test configurations use `local_chalk_*`, never the production
cookie names. Login transaction and CSRF binding cookies are AES-GCM sealed with
separate authenticated purposes. Both have bounded expiry.

## Engine integration

Every operation uses the generated `@q9labsai/chalk-client/effect` client.
`resolveTenant` finds the authenticated user's `workos:<environment>:<user id>`
external ID. Only the sign-in callback provisions on an authoritative 404;
429s never cause creation. Dashboard API errors return `engine_rate_limited`,
`retryable: true`, `retryAfterSeconds: 60`, and `Retry-After: 60`. Callback failures
redirect to `/dashboard/sign-in?failed=google` or `failed=apple`, using the
provider sealed in the login transaction. The bounded failure log retains the
request ID and failure code. There are no automatic retries.
Attendance returns one row per Participant seat, with first join and last leave;
seats are never merged, and ended-session leave times come from the API.

The API service principal requires exactly:

```
CHALK_API_SERVICE_ID=<stable dashboard service id>
CHALK_API_SERVICE_SECRETS=<comma-separated rotation secrets>
CHALK_API_SERVICE_SCOPES=tenants:read,tenants:write,spaces:read,spaces:write,episodes:read,episodes:write,recordings:read,recordings:write,transcriptions:read,transcriptions:write,transcriptions:delete,api_keys:read,api_keys:write,api_keys:delete,webhooks:read,webhooks:write,webhooks:delete
```

Configure `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` and the matching Cloudflare SFU
credentials on the engine so owned calls can use its deployment default.
Pages' `DASHBOARD_SERVICE_TOKEN` must match one service secret. No System token
is used by Pages. Key creation accepts only the explicit non-Tenant scope enum;
rotation sends only expiry, never scopes. The engine also refuses rotation of
legacy keys containing `tenants:write`.

## Local real-engine proof

`bash apps/web/tests/dashboard/real-engine.sh` prepares isolated PostgreSQL,
runs migrations and the real local API, then drives the named Pages Functions
in workerd through `wrangler pages dev` using only the fixture identity provider.
Run heavy checks through `scripts/gates/remote.sh`; PostgreSQL's `psql` client
must be installed on that disposable box. No WorkOS or vendor secrets are needed.
The transport records requests and can inject a 429, but forwards all successful
operations to the production API. Ended Episode/provider Artifact rows are seeded
in PostgreSQL; no recording or transcription vendor is called, and Sync is not
needed for those ended-session reads or cross-account rejection checks.

The proof covers two account bootstraps, repeat binding, every named foreign-ID
mutation, foreign Space/Episode reads, persisted Space rename/admission and
Allowed websites, seat attendance, Origin/CSRF, refresh/revocation, online-gated
secret creation/rotation, response credential redaction, and callback throttling.
The owner join path uses generated direct admission only after resolving the
signed-in person's Tenant. Its server-derived UUIDv8 Participant ID hashes a
versioned domain, Tenant, owner, Space, Episode and idempotency key. Retrying a
join with the same key returns the same seat; a deliberate new join uses a new
key. Guests and invites retain policy admission. The proof checks owner grants
for open and knock Episodes, guest policy waiting and same-key replay. Ephemeral
Ed25519 signing keys and a strict local Cloudflare session-allocation endpoint
exercise actual API signing without vendor credentials. The completed leave
state for a new-seat check is a database fixture, not a Sync handshake.
Real Google/Apple WorkOS setup, live Sync and vendor media remain separate
operator smoke checks.

## Real WorkOS smoke check

Runs the real named Pages Functions and local engine against **WorkOS Staging**
(Google and Apple), not the fixture identity provider. Build the web assets first.
From the repository root:

```sh
DASHBOARD_ENGINE_DEADLINE_SECONDS=1800 DASHBOARD_WORKOS_SMOKE_SECONDS=1800 bash apps/web/tests/dashboard/real-engine.sh bash apps/web/tests/dashboard/workos-smoke.sh
```

Open `http://localhost:8788`. Only `q9labs.ai@gmail.com` can use Google while the
consent screen is in Testing. The script injects the Staging API key with
`2password run`, writes secret bindings only into a private temporary directory
outside the repo, and generates a fresh cookie password per run. Ctrl-C or the
30-minute deadline stops Pages and the harness's API, vendor fixture, Redis and
Postgres. Never use production credentials. The engine remains disposable local
state; this does not prove live Sync or vendor media. Shell checks prove the
signed-out 401 and Google/Apple authorization redirects; completing sign-in and
dashboard actions requires a browser operator.

`real-engine.sh` accepts an optional final command (arguments are preserved); no
arguments still runs exactly `pnpm --filter web run test:dashboard`. Its watchdog
uses `DASHBOARD_ENGINE_DEADLINE_SECONDS` (default 240 seconds). The smoke server
uses `DASHBOARD_WORKOS_SMOKE_SECONDS` (default 1800 seconds); set both for a longer
operator session.

## Failure evidence

Pages failures emit a bounded JSON `dashboard.request_failed` event to Cloudflare
Pages/Workers runtime logs with `request_id`, HTTP status, a redacted code, exception category and a bounded
source frame (never the exception message).
The same request ID is returned in `X-Request-ID`. No raw exception, query,
request body, cookie, token or provider response is logged. Pages runtime log
retention/export must be configured by the deployment owner; API and Sync
retain their existing Axiom trace evidence as described in `docs/observability.md`.

## Allowed websites

Developer GET includes `allowedWebsites`. POST `allowed-websites` reads only that setting; POST `set-allowed-websites` takes `origins` and requires an online WorkOS session. Both use the generated public Tenant operations under the authenticated Tenant. Updates accept only HTTPS origins or `http://localhost:<port>` (no credentials, paths, queries or fragments), deduplicate origins, and always retain `https://chalkmeet.com` within the API's 32-origin limit. First sign-in provisions that permanent origin and the environment's dashboard origin. Sign-up is open: no allowlist or waitlist.

## Webhook edits

`update-webhook` requires `webhookId`, `revision` and `idempotencyKey`; `name`,
`url`, `enabled` and `eventTypes` are optional patches. Send only fields the person
changed. In particular, omit `url` unless a new destination was entered: the DTO
contains a redacted URL and must never be submitted as the real destination.

## Dashboard summaries and limits

Home returns five calls per page, each with its canonical invite URL, and Call
returns the same URL. Invite read errors propagate, including rate limits. `lastActiveAt`
is the latest Episode's end time, or its start time while active. `recentPeople`
contains at most five seats from that Episode, ordered by first join descending.
These are names, not avatar URLs. Empty history returns `null` and an empty list.

Call returns five Episodes per page. Each row contains its attendance count and
up to five recordings. Each recording includes up to five transcript summaries.
`recordingsNextCursor` and `transcriptsNextCursor` identify incomplete lists. The
Past session page and transcript action expose their existing paginated reads.
`live` uses the batch live-Episode read, independently of the history cursor.
The API does not return a total Episode count, so the DTO does not invent one.

Developer returns five webhooks per page, each with `lastDelivery` or `null`.
Delivery lists return five rows per page, with event type, attempt count, and the
latest attempt's HTTP status. A delivery with no HTTP response has `status: null`.
API keys include nullable `lastUsedAt`. Mutation responses do not fetch summaries.

Including Tenant resolution, worst-case engine request counts are 18 for Home,
41 for Call, 14 for Developer, and 8 for a delivery list. These are structural
bounds, not measured throughput. The service read limit is 300 per minute across
requests. There is no per-row expansion of an unbounded page and no auto-retry.

`AttendanceDTO.isYou` is true only for a seat in the server-sealed owner cookie
that matches the signed-in user, session, Space, Episode, and cookie lifetime.
The browser supplies no viewer or Participant ID. Other seats remain false,
including older seats whose cookies expired or were replaced. Durable self-labels
across devices and sign-ins need an engine identity-to-owner mapping.

`CueDTO.speaker` preserves the transcript's name and Participant reference when
present. Missing identity returns `null`; missing speaker name stays `null`.

`create-call` accepts an omitted name and uses `New call`. `create-transcript`
requests transcription for an owned recording using the generated operation and
a stable idempotency key and one to sixteen explicit languages. Omitted languages
produce an engine success response with an empty languages array, which violates
the generated response schema. There is no silent English default. The dashboard
rejects omitted languages before sending the mutation. The engine rejects requests when any transcript already
exists for that recording. A failed-transcript retry therefore still needs an
engine endpoint. Deleting a transcript does not remove that restriction.
