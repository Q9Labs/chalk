# Chalk API

Go control-plane API for Chalk. Keep process wiring thin in `cmd/main.go`, HTTP in inbound adapters, domain logic behind composable boundaries, and provider-specific details in adapters.

Public REST routes live under `/v1`. Operational routes (`/healthz`, `/readyz`) stay unversioned. For the endpoint design loop see [`docs/route-workflow.md`](docs/route-workflow.md); for Postgres, `sqlc` and `goose` see [`docs/database-workflow.md`](docs/database-workflow.md).

Run `apps/api/scripts/gate.sh describe` from the repository root to inspect the gate. `apps/api/scripts/dev-services.sh start` starts local Postgres and Redis. `apps/api/scripts/smoke-lifecycle.mjs` smoke-tests a running API and a clean SIGTERM exit.

## Runtime config

Config is env-only. [`internal/config/config.go`](internal/config/config.go) owns every variable, default and startup validation, so read it instead of a list here. The notes below are the parts the code cannot explain.

**Capabilities.** `CHALK_RECORDING_ENABLED` and `CHALK_TRANSCRIPTION_ENABLED` default to `true` outside `local` and `false` in `local`. Missing provider credentials never disable a capability: a deployment that does not want one must set its flag to `false`. A disabled capability returns `503 service_unavailable` on its public routes, and `/readyz` reports each capability as `enabled` or `disabled`.

**Rate limits.** `CHALK_API_RATE_LIMITS=off` is allowed only with `CHALK_API_ENV=local` and disables only the authenticated read and write policies. Do not use it to test rate-limit handling. `CHALK_API_TRUSTED_PROXY_CIDRS` lists the proxies allowed to supply `CF-Connecting-IP` or `X-Forwarded-For`. Non-local environments rate-limit through Redis.

**Direct door.** `CHALK_API_DIRECT_URL` is advertised as `directSignalingUrl` in own-SFU join grants (see `docs/operators/direct-sync-path.md`). Leaving it empty turns the direct door off for new joins without a web deploy.

**Service principal.** `CHALK_API_SERVICE_ID`, `CHALK_API_SERVICE_SECRETS` and `CHALK_API_SERVICE_SCOPES` are all set or all unset. To rotate a secret, add the new one, deploy callers, then remove the old one; keep the ID unchanged. The service is never System. It owns Tenants it creates (repeated `POST /v1/tenants` with the same `external_id` returns the existing Tenant unchanged), sees only those, and with `tenants:write` may PATCH only `cors_allowed_origins`. Services cannot create or rotate API keys that carry `tenants:write`.

**Media plane choice.** A new Episode starts on the first of these that names a plane: the kill switch (`media-settings new-episodes --state off|on`, stored in the database with an audit row, so it needs no restart; `CHALK_SFU_NEW_EPISODES=off` is a deploy-time floor under it; it sends every new Episode to `cf_sfu` and leaves live Episodes alone), the Space's `media_plane_setting`, the Tenant's `default_media_plane`, then `CHALK_DEFAULT_MEDIA_PLANE`. `CHALK_SFU_ALLOWED_SPACES` applies on top. `CHALK_DEFAULT_MEDIA_PLANE` may be `cf_sfu` or `chalk_sfu`; `chalk_sfu` needs `CHALK_SFU_ENABLED=true` and `CHALK_SFU_CAPTURE_ENABLED=true` (recording and transcription of an own-SFU Episode need capture) and keeps the Cloudflare application settings required, because Cloudflare stays the fallback for old clients, the kill switch and Episodes already bound to it. A Space or Tenant that stores no plane follows the default; one that stores `cf_sfu` stays on Cloudflare. The public API never accepts `chalk_sfu`; only an operator sets it, with `cmd/media-settings` (see `infrastructure/sfu/README.md`). A stored choice counts only while the legacy `media_plane` column still equals it, so a write by the previous release after a rollback wins. A live Episode always resolves from its stored binding.

`CHALK_NEW_SPACE_MEDIA_PLANE`, `CHALK_NEW_SPACE_RECORDING_POLICY` and `CHALK_NEW_SPACE_TRANSCRIPTION_POLICY` set defaults for Create Space requests that omit them. They affect new Spaces only, never public-invite Spaces (those use `CHALK_PUBLIC_INVITE_DEFAULT_MEDIA_PLANE`), and a Tenant with its own provider setup keeps the deployment default. To roll back, unset the variable and restart. An Episode still starts on Cloudflare when no node has room, or when the client SDK does not declare `chalk_sfu` in `X-Chalk-Media-Providers` (every web SDK before 5.5.0) and a Cloudflare application is configured. Where none is, or once `CHALK_SFU_CLIENT_SUNSET` has passed, that client gets 409 `media.client_unsupported`, a clear upgrade error. Startup validation in `internal/config` enforces the SFU prerequisites.

**Tenant media limits.** `CHALK_TENANT_MAX_CONCURRENT_RECORDINGS`, `CHALK_TENANT_DAILY_RECORDING_MINUTES` and `CHALK_TENANT_MAX_LIVE_EPISODES` default to `0` (unlimited) and skip the managed public Tenant. The daily minutes limit is an admission check, not a mid-recording stop: an admitted recording may run past the allowance, up to the four-hour recording maximum, and counts against its start day. Recording starts are durable Sync commands, so the private provider bridge records the terminal outcome (`tenant.recording_limit_reached`, HTTP 409) and Sync does not retry it.

**Transcription.** Enabled startup needs R2, Redis, a workload secret of at least 32 bytes that matches the dispatcher's SSM secret, the control audience and the dispatcher function name. The API only enqueues a small Lambda wake hint; the minute schedule reconciles lost hints. Public transcript requests never choose providers, keys, priority or retry budgets.

**Webhook encryption.** Outbound webhook URLs and replayable one-time responses are encrypted with process-injected AES-GCM keys (no KMS). Non-local environments need either `CHALK_WEBHOOK_ENCRYPTION_KEY` or a keyring plus current version. During rotation keep the previous version in the keyring so old ciphertext stays readable.

User deletion must call `WebhookRepository.EraseUserWebhookEvents` before deleting the user row. There is no deletion orchestrator or external tombstone authority yet, so a restored backup can revive erased webhook bodies and Endpoint material. Do not declare a restore ready until deletions are replayed; this is a production-readiness blocker.

**Sync and media tokens.** Participant admission returns a five-minute Ed25519 sync JWT, refreshed through the participant `sync-token` route, which reloads generation, capabilities and admission intent from Postgres. The AccessGrant's media JWT is accepted only by participant-bound SFU signaling routes and is never a tenant principal. It is signed with the sync key. When rotating that key, keep the outgoing public key in `CHALK_MEDIA_TOKEN_VERIFICATION_KEYS` for at least five minutes and 30 seconds. One person on several devices is admitted as one Participant per device, sharing `identity_external_id` or `identity_id` (mutually exclusive). The backend must derive that value from its own authenticated subject, because two people given the same key are treated as one person.

**Provider bridge.** Durable Sync media effects use a second private listener (TLS 1.3, client certificate whose sole URI SAN is `spiffe://<trust-domain>/environment/<CHALK_API_ENV>/sync/<sync-node-uuid>`). Every non-local environment must configure all `CHALK_PROVIDER_BRIDGE_*` variables; partial config is rejected.

**Cloudflare.** `CHALK_CLOUDFLARE_REALTIME_BASE_URL` is for local protocol-faithful tests only; non-local environments reject it. TURN credentials (`CHALK_CLOUDFLARE_TURN_KEY_ID` and `CHALK_CLOUDFLARE_TURN_API_TOKEN`, created by [`infrastructure/cloudflare-turn`](../../infrastructure/cloudflare-turn/README.md)) are set both or neither. They are issued only to callers tied to an accountable owner; guests of the managed public Tenant and tenant-managed Cloudflare accounts get STUN only. If TURN is missing or Cloudflare fails, the join still succeeds with STUN.

**Public invites.** Links are ten-letter codes at `/{abc-defg-hij}`; legacy `cspi1` Ed25519 links stay valid. Hosted environments must set the `CHALK_PUBLIC_INVITE_*` variables defined in `internal/config`. Keep an outgoing public key in `CHALK_PUBLIC_INVITE_VERIFICATION_KEYS` while links it signed must stay valid; removing it invalidates them, while rotating a Space invite invalidates the old link through its stored generation. Native requests with `X-Chalk-Client: react-native` get a legacy link unless they also send `X-Chalk-Invite-Format: code`, which keeps shipped builds working.

## Observability

Logs are structured JSON-capable stdout with stable `service`, `env` and `version` fields. Traces and metrics export over OTLP/HTTP when `CHALK_API_OTLP_ENDPOINT` is set (a base URL; the API adds `/v1/traces` and `/v1/metrics`). The API propagates W3C `traceparent` and mirrors or creates the lowercase `x-chalk-journey-id` response header. A valid `baggage: session.id=<uuid>` becomes a span and log attribute; other baggage is ignored. Request bodies and operation content never enter traces or logs. Successful request logs are off by default (`CHALK_API_REQUEST_LOGS`).

For a short local profiling run, `cd apps/api && CHALK_API_OPERATION_LOGS=1 CHALK_API_PROFILER=1 CHALK_API_REQUEST_LOGS=all go run ./cmd` logs Postgres query timing and mounts `/debug/pprof`. Never expose the profiler publicly.

## Call problem reports

Set `CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL` on the API service only, never in a `VITE_` setting or the dashboard service. Unset disables reports (availability is false, submissions return `503 reports.unavailable`); a nonempty URL that is not an HTTPS `discord.com` or `discordapp.com` webhook stops startup. Discord is the record; there is no table. Delivery waits for Discord's acknowledgement and failures return 502 with no retry, because the form keeps the text. The report carries the description, display name and role, Space name and Episode ID, and diagnostics only when the user opts in. User text is Markdown-escaped, mentions are disabled, and URL query strings and fragments are stripped. Limits and the payload shape live in `internal/problemreports` and `internal/adapters/discordreports`.

Run the real-stack proof on Instabox after pushing:

```sh
box run -- 'pnpm install --frozen-lockfile && pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium && node apps/web/tests/dashboard/report-proof.mjs'
```

Only Discord and the media vendor are local fixtures. Evidence goes to `artifacts/report-discord`. A live proof also needs `CHALK_REPORT_LIVE_WEBHOOK_URL`, `CHALK_REPORT_LIVE_PROOF=1` and `CHALK_REPORT_LIVE_ONCE_FILE` (a durable marker outside the checkout). Never retry a live run once the marker exists, because delivery may already have succeeded.
