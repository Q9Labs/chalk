# Dashboard server

The static site uses named Cloudflare Pages Functions only under `/auth/*` and
`/dashboard-api/*`. `server/` is imported only by those Functions. The production
composition root imports WorkOS, never `tests/dashboard/fixture-provider.ts`.
There is no dashboard database or generic engine proxy.

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

## Engine integration seam

Existing operations use the generated `@q9labsai/chalk-client/effect` client.
Only pending contract operations use `engine.ts`'s typed bridge:

1. `GET /v1/tenants/by-external-id?external_id=...` -> `{id}`.
2. `POST /v1/tenants` with `{name, external_id, cors_allowed_origins}` -> `{id}`;
   the service principal lane must make this atomic and policy-complete.
3. `GET /v1/tenants/{id}/live-episodes?space_ids=<1–30 UUIDs>` -> the API-reads
   lane's `listSpaceLiveEpisodes` response.
4. Intended `GET .../episodes/{id}/attendance` -> the API-reads proposal.
   This route does not exist yet: a missing implementation returns the explicit
   `attendance_api_pending` availability DTO, never fabricated empty attendance.

Move these calls to the generated client after integrating those lane commits.
The service principal must enforce Tenant ownership and key-scope ceilings;
there is deliberately no fallback to System or broad platform authority.

## Local fixture proof

`pnpm --filter web test:dashboard` runs named Pages Functions in real workerd
using `wrangler pages dev`. The harness copies the real route wrappers to a
bounded temporary directory and substitutes only the provider composition root.
It uses the same application, callback, cookie, CSRF, refresh, provisioning and
page dispatch code. No WorkOS/engine secrets are needed. Only the two pending
Tenant provisioning calls are stubbed; all other engine calls fail rather than
being silently mocked. The test's fixtures provide two people, expiring sealed
sessions, single-use PKCE codes, online revocation, and controlled retryable and
terminal refresh failures. Both test and deployed composition roots reject
fixture mode in shared environments; the deployed one rejects it everywhere.

The auth proof does not establish real-engine cross-account isolation,
recording/transcript behavior, real owner call admission, or real Google/Apple setup.
Those require the service-principal and attendance lanes plus integration proof.

## Failure evidence

Pages failures emit a bounded JSON `dashboard.request_failed` event to Cloudflare
Pages/Workers runtime logs with `request_id`, HTTP status, a redacted code, exception category and a bounded
source frame (never the exception message).
The same request ID is returned in `X-Request-ID`. No raw exception, query,
request body, cookie, token or provider response is logged. Pages runtime log
retention/export must be configured by the deployment owner; API and Sync
retain their existing Axiom trace evidence as described in `docs/observability.md`.

## Known generated-contract blocker

The generated `UpdateSpaceRequestSchema` requires internal `{Set, Value}`
OptionalInt32 wrappers for the three duration fields, but the real Go PATCH
endpoint accepts numbers/null or omitted fields. Consequently rename/admission
PATCH is not usable until the API contract/codegen input is corrected and the
client regenerated. This lane cannot change `apps/api/` or `contract/`; do not
ship it or work around the mismatch with an untyped/raw proxy. The scoped review
verified this wire mismatch. Other mutations are separate operations.

## Allowed websites

Developer GET includes `allowedWebsites`. POST `allowed-websites` reads only that setting; POST `set-allowed-websites` takes `origins` and requires an online WorkOS session. Both use the generated public Tenant operations under the authenticated Tenant. Updates accept only HTTPS origins or `http://localhost:<port>` (no credentials, paths, queries or fragments), deduplicate origins, and always retain `https://chalkmeet.com` within the API's 32-origin limit. First sign-in provisions that permanent origin and the environment's dashboard origin. Sign-up is open: no allowlist or waitlist.
