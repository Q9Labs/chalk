# Dashboard server

The static site uses named Cloudflare Pages Functions only under `/auth/*` and `/dashboard-api/*` (in `apps/web/functions`). The local dev launcher also serves these handlers. The production composition root imports `oauth.ts`, never `tests/dashboard/fixture-provider.ts`. There is no dashboard database and no generic engine proxy.

Import DTOs and request schemas from `src/lib/dashboard/contracts.ts`; routes and handlers are the source of truth for the HTTP surface.

## Sign in on a local preview

Run the repository's `pnpm dev`, or open an Orb running that command. Open `/dashboard/sign-in`, select **Continue with Google** or **Continue with Apple**, then select **Ada**. Both buttons use the same local OAuth fixture; neither contacts a real identity provider. Select **Malik** for an empty account.

Ada has three past calls: Product planning with a transcript and a short synthetic audio recording, Design review with no recording, and Weekly catch-up with a failed recording. Each session has three attendees. Developer lists a Local development API key. These are real API/Postgres records; only identity and artifact storage are local fixtures. Restarting dev preserves the seed rather than adding duplicates.

The middleware is installed programmatically by `scripts/local-dev.mjs`, never by `vite.config.ts` or a deploy-time flag. The production Pages entrypoint still rejects fixture identity, and the production-bundle check rejects fixture code in deployed output.

On the Orb machine, run `node apps/web/tests/dashboard/local-dev-browser.mjs <public-origin> <evidence-directory>` to verify sign-in, Home, Call, session transcript and playback, Developer, Sessions, Recordings, and the empty owner.

## Build

`build:dashboard-functions` runs `wrangler pages functions build --outdir dist/client/_worker.js`. Do not use `--outfile`: it writes a multipart upload envelope, not JavaScript, and `wrangler pages deploy` cannot compile it. Pages deployment and the web Release archive consume the same validated `_worker.js/` directory. The dashboard suite scans every module in it for fixture identity code.

## Browser contract

- Every response, including errors and redirects, is `Cache-Control: no-store`, except `GET /dashboard-api/favicon`.
- JSON POSTs need `Origin` equal to `DASHBOARD_ORIGIN` and the `X-CSRF-Token` from `GET /auth/session`. Apple's callback is the only cross-site POST: it accepts form data with `Origin: https://appleid.apple.com`, bound to an unexpired, provider-specific sealed login transaction.
- Home and Call status checks poll while visible (`useLoad` in `apps/web/src/components/dashboard/AppShell.tsx` sets the interval). Home asks for up to `HOME_STATUS_ROWS` Space IDs in one request, because invite reads mint tokens and spend the engine write bucket, so invite links are fetched only on copy or share. Hidden pages pause and refresh once on return.
- The sessions and recordings lists have no tenant-wide Episode read. Each request fans out over the newest Spaces and is bounded; `truncated` reports a bound cut the scan. The cursor is a stateless `{time, id}` position.
- The favicon route fetches icons itself so a visitor never contacts the site. It accepts only public `https` DNS names, re-checks every redirect, and never serves SVG. Workers cannot see which address a name resolves to, so private-address refusal relies on the platform. A miss returns 204 and the page draws a lettered tile.
- The server never returns provider tokens, credentials, Tenant configuration, the service bearer, storage keys, webhook events or raw engine responses.
- Owner `join` creates or reuses a live Episode and admits an owner Guest. `refresh-access` is media reconnection, not an identity refresh. The server mints a sealed seat handle bound to user, session, Space and join key; the client supplies no Participant identity or generation, and nothing accepts arbitrary Participant IDs. Each tab keeps its own handle so concurrent cookie writes cannot replace its authority. One HttpOnly cookie caches a few recent seats for older loaded bundles and the "You" marker in past sessions; `POST /auth/clear-owner-seats` and sign-out clear it. A bundle without a join key falls back to the old single-seat path; an unknown key never falls back to the latest seat.
- `update-webhook` patches only the fields the person changed. Omit `url` unless a new destination was entered, because the DTO holds a redacted URL that must never be submitted as the destination.
- `create-transcript` requires explicit languages (the engine returns an empty languages array otherwise, which breaks the generated response schema), and the engine refuses it when any transcript already exists for that recording, so a failed-transcript retry needs an engine endpoint.
- Worst-case engine request counts per page are structural bounds, not measurements. The engine's service read limit applies across requests, so pages never expand an unbounded list per row and never auto-retry. Rate limits surface as `engine_rate_limited` with `Retry-After: 60`.

## Identity and session

- Both providers' ID tokens are verified with WebCrypto against their HTTPS JWKS. Identity is the provider `sub`; email is profile data, not an account key. Google and Apple sign-ins are separate accounts even with the same email, and there is no linking.
- Google uses code + S256 PKCE, state and nonce. Apple uses code, state, nonce and `response_mode=form_post`; Apple has no PKCE, and sends the user's name only on first authorization, so a repeat sign-in from a valid same-account session keeps it.
- The sealed AES-GCM session expires `SESSION_SECONDS` after sign-in. There are no refresh tokens or rolling sessions, and provider revocation is not checked. Signing out only removes the browser cookie, so a copied cookie stays valid until expiry or a `SESSION_SECRET` rotation. This is the deliberate stateless trade-off.
- HTTPS cookies are host-only `__Host-chalk_*` with `Secure; HttpOnly; SameSite=Lax`. Only the ten-minute Apple login cookie uses `SameSite=None`, so the browser sends it on Apple's cross-site POST. Loopback HTTP uses `local_chalk_*` names.
- Clearing the login transaction cookie is not atomic consumption, and there is deliberately no shared transaction store. Replaying the cookie can reach the token endpoint again, but the provider rejects the consumed code, so no second session is created.
- Workers constraints that shaped `oauth.ts`: `redirect: "error"` is unsupported (use `redirect: "manual"` with fixed `identity_<provider>_redirect` errors); production server code uses no Buffer; JWKS are cached per isolate with a one-hour cap, one refetch for an unknown `kid`, and a 30-second refresh cooldown. Logs hold fixed error codes and request IDs, never input, tokens or cookies.
- To reproduce the unsupported-redirect regression, run `node apps/web/tests/dashboard/oauth-runtime.mjs --redirect-error` after building the client SDK. It must fail the first Google callback with zero token exchanges.

## Runtime bindings

`config.ts` validates the bindings and is the list. Set them per Pages environment and never expose credentials through `VITE_*`. `DASHBOARD_SERVICE_TOKEN` must equal one of the engine's `CHALK_API_SERVICE_SECRETS`; Pages never uses a System token. The fixture provider is local and test only.

The engine needs this service principal:

```
CHALK_API_SERVICE_ID=<stable dashboard service id>
CHALK_API_SERVICE_SECRETS=<comma-separated rotation secrets>
CHALK_API_SERVICE_SCOPES=tenants:read,tenants:write,spaces:read,spaces:write,episodes:read,episodes:write,recordings:read,recordings:write,transcriptions:read,transcriptions:write,transcriptions:delete,api_keys:read,api_keys:write,api_keys:delete,webhooks:read,webhooks:write,webhooks:delete
```

It also needs `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` with the Cloudflare SFU credentials so owned calls work. Key creation accepts only non-Tenant scopes, and rotation sends only expiry.

Callback URLs are derived from `DASHBOARD_ORIGIN` as `<origin>/auth/callback/google` and `<origin>/auth/callback/apple`. Register Google's exact redirect URIs, set the consent screen to Chalk/chalkmeet.com, verify the domain and publish it. Register Apple's domains and HTTPS return URLs on the Services ID. Apple rejects HTTP and localhost, so real Apple smoke needs staging or production.

First sign-in provisions the Tenant with the permanent `https://chalkmeet.com` allowed website and the environment's `DASHBOARD_ORIGIN`; both are always retained. Sign-up is open.

## Verification

The Gate's `dashboard-engine` lane runs `apps/web/tests/dashboard/check-engine.sh http` for dashboard, SDK dependency and API changes, and the `dashboard-refresh` lane runs `check-engine.sh refresh`, the owner call across the real five-minute media-access lifetime. A pull request runs the refresh lane only for the inputs it exercises; the merge queue runs it for every change. It drives the real API and named Pages Functions in workerd with an isolated database; only the engine transport injects 429s. Heavy checks run on the M4, not a paid timing box:

```sh
CHALK_REMOTE_NEEDS_BROWSER=1 bash scripts/gates/remote.sh -- bash apps/web/tests/dashboard/check.sh
```

`apps/web/tests/dashboard/owner-refresh.mjs` runs in the same lane. It holds two owner tabs in one browser across the real media-token refresh and expiry, makes 300 joins across 12 other Spaces to prove cookies survive, and ends for everyone over real Sync. The promote and nightly real-SFU `prod:proof` separately checks post-refresh media.

## Manual real-provider smoke

After redirects, domains and bindings are installed, on staging HTTPS (then production after promotion):

1. Open `/auth/start?provider=google`, confirm Chalk's consent screen, and check `/auth/session` and `/dashboard-api/home` return 200 with `no-store`. A second sign-in must land on the same Tenant.
2. From a fresh profile, open `/auth/start?provider=apple`. The callback must be a POST to `/auth/callback/apple` followed by `/dashboard`, and the first authorization must keep the name.
3. Sign in with both providers on one email and confirm separate accounts. POST `{}` to `/auth/sign-out` with exact Origin and CSRF token; cookies must disappear and the session must return 401.
4. A rejected consent or state must give the provider-specific sign-in error, never a session. Record only status, route and request ID.

For a local Google-only smoke, inject the OAuth values with `2password run --env NAME=op://…`, then:

```sh
DASHBOARD_ENGINE_DEADLINE_SECONDS=1800 DASHBOARD_OAUTH_SMOKE_SECONDS=1800 bash apps/web/tests/dashboard/real-engine.sh bash apps/web/tests/dashboard/oauth-smoke.sh
```

The smoke script writes bindings only to a mode-0600 temporary `.dev.vars` and cleans up Pages on exit. Apple is not smoke-tested on HTTP localhost.

## Failure evidence

Pages failures emit a bounded JSON `dashboard.request_failed` event with `request_id`, status, a redacted code, exception category and a bounded source frame, never the exception message. The same ID is returned in `X-Request-ID`. The deployment owner must configure Pages runtime log retention; API and Sync evidence is described in `docs/observability.md`.
