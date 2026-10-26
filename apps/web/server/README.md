# Dashboard server

The static site uses named Cloudflare Pages Functions only under `/auth/*` and
`/dashboard-api/*`. `server/` is imported only by those Functions. The production
composition root imports `oauth.ts`, never `tests/dashboard/fixture-provider.ts`.
There is no dashboard database or generic engine proxy. The production web build
emits the advanced-mode directory `dist/client/_worker.js/` with an “index.js”
entrypoint and its generated “\_routes.json”. The release archive preserves this
directory while site/docs paths remain static.

## Build output

`build:dashboard-functions` uses the lockfile's Wrangler 4.107.0 with
`wrangler pages functions build --outdir dist/client/_worker.js`. Do not use
`--outfile`: that flag writes a multipart upload envelope, not JavaScript, and
`wrangler pages deploy` cannot compile it as a Pages worker. The dashboard suite
requires the directory and “index.js”, syntax-checks every JavaScript module, and
scans all those modules for fixture identity code. Both the Pages deployment and
the web Release archive consume the same validated directory. The fixture e2e
harness compiles named Functions separately; the OAuth smoke harness excludes
“\_worker.js” regardless of whether it is a file or directory.

## Browser contract

Import DTOs and request schemas from `src/lib/dashboard/contracts.ts`.
All responses, including errors and redirects, are `Cache-Control: no-store`.
POST JSON with `Origin` exactly equal to `DASHBOARD_ORIGIN` and `X-CSRF-Token`
obtained from `GET /auth/session`. Apple is the only cross-site POST exception:
its callback accepts only form data with `Origin: https://appleid.apple.com`,
bound to an unexpired, provider-specific sealed login transaction and its state.
All other mutation routes retain exact-Origin and session-bound CSRF checks.

- `GET /dashboard-api/call-invite?spaceId=...`: only the invite URL. Uses one
  tenant lookup and one scoped invite read; a missing invite retains the engine's
  existing write admission guard before lazy creation.

- `GET /auth/start?provider=google|apple&returnTo=/dashboard`: provider redirect.
  Google uses authorization code + S256 PKCE, state and nonce, scopes
  `openid email profile`. Apple uses code, state, nonce, scopes `name email`,
  and `response_mode=form_post` (Apple does not support PKCE).
- `GET /auth/callback/google`: code/state callback.
- `POST /auth/callback/apple`: form code/state and optional first-sign-in `user`.
  Both callbacks clear their own login transaction on success or failure.
- `GET /auth/session`: profile plus session-bound CSRF token, no provider tokens.
  An expired/invalid session returns 401 `sign_in_required`: sign in again.
- `POST /auth/sign-out`: strict empty JSON object. Clears session and binding
  cookies; clear this account's local bookmarks when `clearLocalBookmarks` is true.
  This is local sign-out, not Google/Apple account logout or token revocation.
- `GET /dashboard-api/home?cursor=...`: owned, unarchived Spaces and one activity
  read for them. Invite links are fetched only on copy/share, not per row: invite reads
  mint tokens and consume the engine write bucket. `POST`: `HomeAction`.
- `GET /dashboard-api/call?spaceId=...&cursor=...`: call, signed invite and Episode
  history. `POST`: `CallAction` (settings, rotate link, knocks, end for everyone).
- `GET /dashboard-api/call-status?spaceId=...`: current Episode ID/state and
  unexpired pending knocks. Two tenant reads, independent of expanded history.
- `GET /dashboard-api/call-metadata?kind=recording|transcript&spaceId=...&id=...`:
  one tenant read for a transcript, or two for a recording and its latest transcripts.
  Recording polling includes pending audio preparation, so new automatic transcripts appear.
  Call pages share one metadata request per ten seconds between the live roster and pending artifacts.
- `GET /dashboard-api/home-status?spaceIds=...&home=1`: Home's check. Live state, whether it
  is archived, last active time and recent people for up to 300 Spaces in one tenant read
  (`listSpaceActivity`), plus one read for the five newest unarchived Spaces; when any of them
  isn't listed, the answer carries them as the first page (one more read for their activity).
  Without `home=1`, the call page's roster
  check: the full live roster from `listSpaceLiveEpisodes`, one read for up to 30 Spaces.
  The server derives Tenant authority from the session.
- `GET /dashboard-api/past-session?spaceId=...&episodeId=...&cursor=...`: Episode,
  recordings and attendance. `POST`: `PastSessionAction` (artifact URLs,
  transcripts, export, deletion). Artifact URLs expire; request again on expiry.
- `GET /dashboard-api/developer?keyCursor=...&webhookCursor=...`: keys and webhooks.
  `POST`: `DeveloperAction`. Secret mutations return only the newly minted,
  user-requested secret. Updates require revision and stable idempotency keys.

Joined-only bookmarks use the public invite/call client. Owner `join` prepares
an Entrance, creates/reuses a live Episode and admits an owner Guest.
`refresh-access` is media reconnection, not an identity-session refresh: it takes
only a Space ID and optional current media token. Participant identity and
generation come from a session-bound, purpose-sealed HttpOnly seat cookie.
Nothing accepts arbitrary Participant IDs or promotes joined-only calls.
The server never returns provider tokens, credentials, Tenant configuration,
service bearer, storage keys, webhook events or raw engine responses.

Visible Call and Home pages check status every five seconds. Each Home check is one
request for every shown row and then the archived calls Home holds, up to 300 IDs, and Home
updates its rows from the answer. An archived call is hidden in its place and shows again
when it is restored elsewhere. Calls made elsewhere go on top from the first page;
when that page holds no call Home already has, Home reloads its list down to where its last
row sat, two tenant reads per page of five.
Stable status never reloads page history. A changed
Episode or knock set reloads the expanded page once. Hidden pages pause checks
and refresh once on return; failed background reads retain ready content.

## Identity and session

Both providers' ID tokens are verified with WebCrypto against their HTTPS JWKS,
including RS256 signature, issuer, audience (and authorized party), numeric
issuance/expiry times and nonce. Issuance allows at most 60 seconds of future
clock skew and cannot be later than expiry; expiry is checked without skew.
Google email is profile data only when `email_verified` is boolean `true`.
Keys are loaded on exchange, not on dashboard reads. Google's `sub` and
Apple's `sub` are the identities; email is profile data, not an account key.
Apple's client secret is an ES256 JWT signed from the PKCS#8 key with a five-minute
expiry, `iss=APPLE_TEAM_ID`, `sub=APPLE_SERVICES_ID`, and
`aud=https://appleid.apple.com`.

Our AES-GCM sealed session contains provider, subject, a random session ID,
display name, email, optional avatar URL and an absolute expiry 30 days after
sign-in. There are no refresh tokens, rolling sessions or refresh endpoint.
Provider outages do not invalidate an already issued session. Provider-side
revocation is not checked during this 30-day lifetime. Signing out removes the
browser cookie; a copied cookie remains valid until its absolute expiry or a
`SESSION_SECRET` rotation. This is the deliberate stateless-session trade-off.

HTTPS session/binding cookies are host-only `__Host-chalk_*` with
`Secure; HttpOnly; SameSite=Lax; Path=/`. The ten-minute Apple login cookie alone
uses `SameSite=None; Secure`, so the browser sends it on Apple's cross-site POST.
Google's login cookie stays Lax. Loopback HTTP local/test uses `local_chalk_*`
names, never production names. Cookie purposes are authenticated separately.

Apple sends name only on the first authorization. When present, it is kept in
the sealed session. A repeat sign-in started from a valid same-account session
retains it if Apple omits it. With no database, it cannot be recovered after
cookie loss/expiry; email is the fallback. Google and Apple sign-ins are separate
accounts even if their emails match. There is no account linking or migration.

## Runtime bindings

Set all values per Pages environment; never expose credentials through `VITE_*`.
`config.ts` validates these bindings:

| Value                         | Meaning                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `CHALK_ENVIRONMENT`           | `local`, `test`, `staging`, `nightly`, or `production`; identity namespace |
| `CHALK_API_ORIGIN`            | Engine URL; HTTPS required outside local/test                              |
| `DASHBOARD_ORIGIN`            | Exact dashboard origin, no trailing slash; HTTPS outside local/test        |
| `DASHBOARD_IDENTITY_PROVIDER` | `oauth` (default) or `fixture` (local/test only)                           |
| `GOOGLE_CLIENT_ID`            | Google's web OAuth client ID                                               |
| `GOOGLE_CLIENT_SECRET`        | Secret web-client credential                                               |
| `APPLE_SERVICES_ID`           | Apple's web Services ID, not an app bundle ID                              |
| `APPLE_TEAM_ID`               | Apple developer team ID                                                    |
| `APPLE_KEY_ID`                | ID of the Sign in with Apple signing key                                   |
| `APPLE_PRIVATE_KEY`           | Secret PKCS#8 PEM Apple key (preserve actual newlines)                     |
| `SESSION_SECRET`              | Secret, at least 32 random characters; rotation invalidates all cookies    |
| `DASHBOARD_SERVICE_TOKEN`     | Secret constrained engine service bearer, never System or a user API key   |

The fixture still needs placeholder provider values but never uses credentials.
Production Functions reject fixture mode even with a local environment setting.
No D1, KV, R2 or other dashboard storage binding is needed.

Callback URLs are derived from `DASHBOARD_ORIGIN`, never accepted from a caller:

| Environment | Google                                               | Apple                                               |
| ----------- | ---------------------------------------------------- | --------------------------------------------------- |
| Local       | `http://localhost:8788/auth/callback/google`         | `http://localhost:8788/auth/callback/apple`         |
| Staging     | `https://staging.chalkmeet.com/auth/callback/google` | `https://staging.chalkmeet.com/auth/callback/apple` |
| Production  | `https://chalkmeet.com/auth/callback/google`         | `https://chalkmeet.com/auth/callback/apple`         |

Register Google's exact authorized redirect URIs. Set the Google consent screen
app name/domain to Chalk/chalkmeet.com, verify the domain, and publish the consent
screen for real users. Register Apple's web domains and HTTPS return URLs on the
Services ID. Apple rejects HTTP/localhost return URLs: the local Apple URL above
is only for fixture coverage; real Apple smoke must use staging or production
HTTPS. Apple's cross-site login cookie also requires HTTPS.

## Security boundaries

The login transaction cookie has a ten-minute Max-Age and an absolute expiry
inside its AES-GCM sealed payload. The handler checks that expiry, state and
provider before exchange. Tampering with its nonce invalidates the seal. A
nonce mismatch inside a signed ID token is only observable after exchange; it
is rejected before Tenant resolution or session creation.

Clearing the cookie is not atomic transaction consumption. There is deliberately
no shared transaction store or dashboard database: Google and Apple authorization
codes are single-use. Replaying an original transaction cookie can reach the token
endpoint again until expiry, but the provider rejects its consumed code, so that
replay cannot create a second session. Real-adapter tests exercise this boundary;
fixture identity remains only for the real Pages/engine e2e journeys. The
production-adapter callback suite runs through `wrangler pages dev` in workerd,
not Node; only its token/JWKS endpoint addresses point at local HTTP fixtures.

JWKS are cached per isolate according to response Cache-Control, capped at one
hour (five minutes when max-age is absent), with Age deducted. No-cache/no-store
and zero max-age disable reuse. Concurrent loads share one request. An unknown
kid triggers one refetch, with a 30-second refresh cooldown to bound repeated
unknown-key requests. A failed refresh fails authentication; stale keys are not
used after expiry. Token and JWKS response bodies, including errors, are limited
to 64 KiB while streaming; HTTP calls have a ten-second deadline and reject
redirects with `redirect: "manual"` and fixed `identity_<provider>_redirect`
errors. `redirect: "error"` is unsupported by Workers even though Node accepts
it. Server fetches do not set `cache`; the engine wrapper also uses manual
redirects. The workerd suite exercises `AbortSignal.timeout`, PKCS#8 P-256
ES256 signing, RS256 verification, AES-GCM, HMAC and SHA-256. Production server
code uses no Buffer API. The Node test driver uses Buffer only outside Workers.
Logs retain fixed error codes, request IDs and error types, never raw
request input, provider response text, tokens, cookies or stack lines.

See [Google's OIDC verification guidance](https://developers.google.com/identity/openid-connect/openid-connect)
and [Apple's verification guidance](https://developer.apple.com/documentation/signinwithapple/verifying-a-user).

## Engine integration

Every operation uses the generated `@q9labsai/chalk-client/effect` client.
`resolveTenant` finds the authenticated user's `<provider>:<environment>:<sub>`
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

## Verification

Run heavy checks on the M4 (never a paid timing box):

```sh
CHALK_REMOTE_NEEDS_BROWSER=1 bash scripts/gates/remote.sh -- bash apps/web/tests/dashboard/check.sh
CHALK_REMOTE_NEEDS_BROWSER=1 bash scripts/gates/remote.sh -- pnpm exec bash scripts/gates/commit.sh --base origin/master
```

The dashboard check builds the production worker, proves fixture code is absent,
checks types and local-key/JWKS token verification, then runs isolated PostgreSQL,
the real API and real named Pages Functions in workerd. Successful engine calls
are real; the recording transport injects only 429 failures. Fixture identity
covers both providers, state/nonce/PKCE mismatches, Apple POST route/Origin
restrictions, callback replay, expiry, sign-out, A/B resource isolation,
Origin/CSRF, Tenant idempotency, response redaction and throttling. RSA keys are
generated locally and served over HTTP for bad-signature/audience/issuer/expiry/
nonce cases. The Apple ES256 client-secret signature, header and claims are checked.
No real provider or media vendor credentials are needed.

## Manual real-provider smoke

After the lead registers redirects/domains and installs all runtime bindings:

1. On staging HTTPS, open `/auth/start?provider=google`. Confirm Chalk's consent
   screen, complete sign-in, and check `/auth/session` and `/dashboard-api/home`
   return 200 with `Cache-Control: no-store`. Repeat sign-in: same Tenant.
2. Start Apple from a fresh browser profile with `/auth/start?provider=apple`.
   Complete Apple ID/2FA. In Network verify the callback is a POST to
   `/auth/callback/apple`, followed by `/dashboard`. Check name/email/session and
   Home; first authorization should retain name. Reauthorize from that session
   to verify retention when Apple omits the first-sign-in profile.
3. With both sign-ins using the same email, verify separate dashboard accounts.
   Read the session's CSRF token, POST `{}` to `/auth/sign-out` with exact Origin
   and `X-CSRF-Token`, and confirm the cookies disappear and session returns 401.
4. Rejected consent/state must return the provider-specific sign-in error, never
   a dashboard session. Record only status/route/request ID, not codes or cookies.
5. Repeat steps on production after promotion with its own runtime values.

For a local Google-only smoke, build web, inject the seven OAuth values through
`2password run --env NAME=op://…` (or `2password env run` with an untracked
reference template), then run the owned, bounded local stack:

```sh
DASHBOARD_ENGINE_DEADLINE_SECONDS=1800 DASHBOARD_OAUTH_SMOKE_SECONDS=1800 bash apps/web/tests/dashboard/real-engine.sh bash apps/web/tests/dashboard/oauth-smoke.sh
```

`apps/web/tests/dashboard/oauth-smoke.sh` writes bindings only to a mode-0600 temporary `.dev.vars`, never
CLI binding arguments. It owns and cleans up Pages on exit, owner loss or deadline.
It creates an ephemeral session secret unless supplied; restarting invalidates
local sessions. Apple is not smoke-tested on HTTP localhost. Live Sync and vendor
media still need their separate operator checks.

## Failure evidence

Pages failures emit a bounded JSON `dashboard.request_failed` event to Cloudflare
Pages/Workers runtime logs with `request_id`, HTTP status, a redacted code, exception category and a bounded
source frame (never the exception message).
The same request ID is returned in `X-Request-ID`. No raw exception, query,
request body, cookie, token or provider response is logged. Pages runtime log
retention/export must be configured by the deployment owner; API and Sync
retain their existing Axiom trace evidence as described in `docs/observability.md`.

## Allowed websites

Developer GET includes `allowedWebsites`. POST `allowed-websites` reads only that setting; POST `set-allowed-websites` takes `origins`. Both use the generated public Tenant operations under the authenticated Tenant. Updates accept only HTTPS origins or `http://localhost:<port>` (no credentials, paths, queries or fragments), deduplicate origins, and always retain `https://chalkmeet.com` and the configured `DASHBOARD_ORIGIN` within the API's 32-origin limit. First sign-in provisions that permanent origin and the environment's dashboard origin. Sign-up is open: no allowlist or waitlist.

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
`recordingsNextCursor` identifies an incomplete recording list. Past sessions
read one page of up to 100 transcript summaries per recording (the API maximum);
the overview keeps five. Transcript cursors are neither returned nor followed.
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

To reproduce the unsupported-redirect regression without editing production
source, run `node apps/web/tests/dashboard/oauth-runtime.mjs --redirect-error`
after building the client SDK. It deliberately changes only the copied test
worker's redirect mode and must fail its first successful Google callback with
zero token exchanges. Run without the flag for the passing workerd suite. Both
runs own and clean up their Pages process, local HTTP server and sandbox.
