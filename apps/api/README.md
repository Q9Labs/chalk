# Chalk API

Go control-plane API for Chalk.

Keep process wiring thin in `cmd/main.go`, HTTP in inbound adapters, domain
logic behind composable boundaries, and provider-specific details in adapters.

Public REST routes live under one `/v1` boundary. Operational routes stay
unversioned:

- `/healthz`: process liveness.
- `/readyz`: dependency readiness, currently Postgres.

For the endpoint design and implementation loop, see
[`docs/route-workflow.md`](docs/route-workflow.md).

## Gate

Shell commands below run from the repository root unless a block changes directory.

Inspect the API gate with:

```bash
apps/api/scripts/gate.sh describe
```

## Runtime Config

Config is env-only. Secret managers or platform-specific config systems should
inject environment variables before the API starts.

[`internal/config/config.go`](internal/config/config.go) owns supported environment variables, defaults, and startup validation.

### Service principal (optional)

Set all three variables to enable a backend service caller; leave all unset to
preserve the API-key-only default:

- `CHALK_API_SERVICE_ID`: stable service identity (1–128 characters). Never use a secret here.
- `CHALK_API_SERVICE_SECRETS`: comma-separated bearer secrets, each at least 32 characters. Add a replacement, deploy callers, then remove the old secret; keep the service ID unchanged.
- `CHALK_API_SERVICE_SCOPES`: comma-separated explicit scopes from the API-key scope vocabulary, such as `tenants:read,tenants:write,spaces:read`. No wildcard or implicit full access.

The service may create Tenants with optional `external_id` (1–512 characters),
list only its own Tenants, and use its scopes only within those Tenants.
`POST /v1/tenants` returns the existing Tenant for a repeated
`(service ID, external_id)`, without replacing its name, settings, or policies.
`GET /v1/tenants/by-external-id?external_id=...` looks up only the caller's Tenant.
The calling service is responsible for the request-supplied `external_id` and end-user identity; Tenant ownership is derived only from the authenticated service identity.
Keep this credential server-side. It is never System; the local-only System token
remains unavailable in non-local environments.

With `tenants:read`, services can read their own Tenant including
`cors_allowed_origins`. With `tenants:write`, they can PATCH only
`cors_allowed_origins` on their own Tenants. Including any other field returns
forbidden, even when its value is null. System and Tenant API-key permissions
are unchanged. Services cannot create or rotate API keys containing `tenants:write`, because those keys can change fields beyond CORS. There is no command for adopting existing Tenants.

Set `CHALK_API_TRUSTED_PROXY_CIDRS` to the comma-separated CIDR ranges of the
load balancers or edge proxies allowed to supply `CF-Connecting-IP` or
`X-Forwarded-For` for public-route rate limiting. Non-local environments use
Redis-backed rate limiting through `CHALK_REDIS_URL`.

For local harnesses, set `CHALK_API_RATE_LIMITS=off` with `CHALK_API_ENV=local`
to disable only the authenticated read and write policies. Public-route and
webhook policies remain enabled. `on` (the default when unset or empty) keeps
all policies enabled. Values are case-insensitive and surrounding whitespace
is ignored. Other values are rejected. Startup rejects `off` in every
non-local environment. Do not use this switch to test rate-limit handling.

### Default MediaPlane

`CHALK_DEFAULT_MEDIA_PLANE` selects the deployment-owned MediaPlane used when
a Create Space request omits `media_plane`. The supported deployment default is
`cf_sfu`, because the Dashboard access-grant path is SFU-only. Managed
production requires this setting; generic local and test processes may omit it,
but then Create Space requests must supply a provider. Explicit Space and
Tenant-managed provider configuration uses `cf_sfu`.

An absent Tenant provider configuration may use deployment credentials only
when the Space provider matches this default. A concrete Tenant configuration
remains authoritative, an explicit disable never falls back, and deployment
credentials are never borrowed across providers.

The checked-in local launcher sets `cf_sfu`. The deployment default requires the
Realtime app ID and secret.

The ProviderBridge currently uses the Cloudflare SFU executor independently of
the deployment default. When the bridge is enabled, its Realtime app ID and
secret remain required.

### Production capabilities

Integrations, recording, and transcription are explicit runtime capabilities:

- `CHALK_RECORDING_ENABLED=true|false`
- `CHALK_TRANSCRIPTION_ENABLED=true|false`

All three default to `true` outside `local`, preserving fail-closed production
startup. Local development defaults all three to `false`. A capability-disabled
deployment must set its flag to `false`; omitting provider credentials never
disables a capability implicitly.

```bash
CHALK_RECORDING_ENABLED=false
CHALK_TRANSCRIPTION_ENABLED=false
```

When disabled, the API does not construct the provider or worker services.
Authenticated public routes for that capability return the bounded
`503 service_unavailable` response, and private transcription worker routes are
not mounted. `/readyz` reports each capability as `enabled` or `disabled` on
both ready and dependency-failure responses. The `api.starting` structured log
records the same capability booleans without logging credentials or provider
config.

When transcription is enabled, startup requires a workload secret of at least 32
bytes, a dispatcher Lambda function name, and complete R2 credentials. Invalid
or non-boolean capability flag values are rejected.

### Tenant media limits

These optional non-negative integer settings default to `0` (unlimited), including
when unset. Limits apply independently to every Tenant except the managed public Tenant
(`CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID`, or the Tenant created for local public
invites). They do not replace the engine-wide recording capacity limits, which
still apply to the managed public Tenant.

| Setting                                  | Meaning                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHALK_TENANT_MAX_CONCURRENT_RECORDINGS` | Maximum outstanding recording reservations per Tenant.                                                                                                                                                                                      |
| `CHALK_TENANT_DAILY_RECORDING_MINUTES`   | Reject new recordings when capture time for recordings started in the current UTC day reaches this many minutes. Active recordings count up to now; finished recordings count through capture completion, capped by their capture deadline. |
| `CHALK_TENANT_MAX_LIVE_EPISODES`         | Maximum active or ending Episodes per Tenant, including public-invite Episodes outside the managed public Tenant. Ending Episodes retain their slot until ended.                                                                            |

Daily recording minutes are an admission check, not a mid-recording stop. An
admitted recording may exceed the remaining daily allowance, up to the existing
two-hour per-recording maximum. A recording begun before midnight is charged to
its start day, not split across days. Concurrent recording admission includes
reserved/prewarmed recordings so delayed workers cannot overbook a Tenant.

Live Episode rejections use HTTP 409 and `tenant.live_episode_limit_reached`.
Recording starts are durable Sync commands rather than public REST endpoints;
the private provider bridge records a terminal outcome and returns HTTP 409 with
code `tenant.recording_limit_reached` and reason `tenant_recording_limit_reached`, which Sync recognizes without retrying it.
Transcription operates on existing recordings, so these recording bounds also
bound the source media available for transcription.

## Transcription artifacts

Asynchronous transcription is enabled only when the API can mount the complete
worker boundary. Enabled startup requires R2 and Redis plus
`CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET`,
`CHALK_TRANSCRIPTION_CONTROL_AUDIENCE`, and
`CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME`. The HMAC secret must match the
dispatcher's SSM-managed workload secret; the audience and API release version
are included in every replay-bound signature. The API uses its AWS workload
identity only to enqueue a small asynchronous Lambda wake hint. The minute
dispatcher schedule reconciles lost hints.

Public transcript requests do not accept providers, object keys, queue
priority, retry budgets, or lifecycle state. Recorder-owned committed source
metadata must exist before a request is accepted, and normalized transcript
bytes remain private R2 artifacts exposed through short-lived download URLs.

### Outbound webhook encryption and erasure

Outbound webhook target URLs and replayable one-time responses are encrypted at
rest. Local development may omit webhook encryption configuration and use the
deterministic local-only default. Every non-local environment fails closed
unless it supplies either `CHALK_WEBHOOK_ENCRYPTION_KEY` as one base64-encoded
32-byte key, or a versioned keyring through
`CHALK_WEBHOOK_ENCRYPTION_KEYRING` plus
`CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION`. A keyring entry uses
`version:base64-key`; retain the previous version during a rotation overlap so
existing ciphertext remains decryptable, and make the new version current for
all new writes.

The repository currently uses process-injected AES-GCM keys. It has no KMS or
envelope-key provider, so deployment secret injection and key retirement remain
external operational responsibilities.

User deletion must call `WebhookRepository.EraseUserWebhookEvents` before the
user row is deleted. The hook destroys linked event bodies, terminally fences
their Deliveries, closes an in-flight Attempt as `event_erased`, emits a
content-free terminal journey event, and then removes the user link. This live
erasure path is enforced and directly covered by a PostgreSQL integration test.
The repository does not yet contain a deletion orchestrator or an external
tombstone authority that survives database backup restoration. Therefore a
restored backup can revive pre-erasure webhook bodies or encrypted Endpoint
material and must not be declared ready until an external durable tombstone
reconciler has replayed deletions. Backup restore plus tombstone replay is an
explicit production-readiness blocker, not a capability of the current API.

## Database

The API uses Postgres with `pgx`, `sqlc`, and `goose`. For local Postgres,
migrations, query generation, and schema workflow, see
[`docs/database-workflow.md`](docs/database-workflow.md).

For the full local backing-service set, including Redis:

```bash
apps/api/scripts/dev-services.sh start
```

## Sync participant tokens

Participant admission returns a five-minute Ed25519-signed sync JWT. An
authenticated tenant member can refresh it with
`POST /v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token`.
The refresh path reloads the active participant generation, capabilities, and
admission intent from Postgres before signing.

Production requires `CHALK_SYNC_TOKEN_ISSUER`, `CHALK_SYNC_TOKEN_AUDIENCE`,
`CHALK_SYNC_TOKEN_KEY_ID`, and `CHALK_SYNC_TOKEN_PRIVATE_KEY`. The private key is
the unpadded base64url encoding of a 64-byte Ed25519 private key and must be
supplied through the runtime secret boundary.

## Public Space invites

Public Space links use a dedicated `cspi1` Ed25519 keyring. Hosted environments
must configure all of these values:

- `CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID` identifies the Tenant that owns Spaces
  created from the public Open a Space flow.
- `CHALK_PUBLIC_INVITE_DEFAULT_MEDIA_PLANE` selects the media plane for those
  auto-created Spaces.
- `CHALK_PUBLIC_INVITE_WEB_ORIGIN` is the HTTPS origin used to build canonical
  `/space/{slug}#spaceInviteToken=...` links.
- `CHALK_PUBLIC_INVITE_KEY_ID` and `CHALK_PUBLIC_INVITE_PRIVATE_KEY` select the
  current signing key. The private key is an unpadded base64url Ed25519 private
  key and must stay inside the runtime secret boundary.
- `CHALK_PUBLIC_INVITE_VERIFICATION_KEYS` is a non-empty JSON object that maps
  key IDs to unpadded base64url Ed25519 public keys. It must include the public
  key for the current signing key.

`CHALK_PUBLIC_INVITE_AUTO_LIFECYCLE_SECONDS` controls how long an auto-created
Space may remain active before Chalk ends its live Episode and archives it. It
defaults to one hour and accepts values from 60 through 3600 seconds.

`CHALK_PUBLIC_INVITE_SCHEDULER_INTERVAL_MS` and
`CHALK_PUBLIC_INVITE_SCHEDULER_BATCH` are optional, but they must be set
together. They control the worker that ends an auto-created Space's live
Episode and archives the Space after its creator leaves or its deadline passes.

Keep an outgoing public key in `CHALK_PUBLIC_INVITE_VERIFICATION_KEYS` while
links signed by that key must remain valid. Removing the key invalidates those
links; rotating a Space invite invalidates the prior link through its persisted
generation instead. Local development derives a local-only keyring and creates
or reuses a neutral managed Tenant when these variables are absent. It requires
at least one non-wildcard API CORS origin so canonical links have a safe origin.

Sensitive dashboard mutations use a five-minute, action- and resource-bound
recent-auth proof. Local development uses a deterministic local-only default;
every non-local environment must supply `CHALK_AUTH_RECENT_AUTH_SECRET` with at
least 32 bytes through the runtime secret boundary. The API never logs proof
values or passwords, and API-key credentials cannot obtain or satisfy this
Dashboard Account challenge.

## Managed web SDK credentials

Customer backends authenticate tenant API requests with credentials created by
the API-key lifecycle routes. Raw values use the `chalk_sk_…` namespace and are
shown only by create and rotate responses. Keep them in the backend secret
boundary; browsers receive opaque AccessGrants instead.

An AccessGrant contains separate five-minute Sync and media JWTs. The media
JWT is accepted only by the participant-bound SFU signaling routes and is bound
to the live participant generation, configured media provider, and exact
Cloudflare connection. It is never treated as a tenant principal.

The media signer uses `CHALK_SYNC_TOKEN_PRIVATE_KEY` and
`CHALK_SYNC_TOKEN_KEY_ID`. During signing-key rotation,
`CHALK_MEDIA_TOKEN_VERIFICATION_KEYS` may contain the current and previous
Ed25519 public keys as a JSON object whose values are unpadded base64url. The
entry for the current key ID must match the configured private key. Retain an
outgoing public key for at least five minutes and 30 seconds so already-issued
media credentials remain verifiable through their lifetime and clock-skew
allowance.

Durable Sync media effects use a second, private API listener. Every non-local
environment must set `CHALK_PROVIDER_BRIDGE_ADDRESS`,
`CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE`,
`CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE`,
`CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE`, and
`CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN`; partial configuration is rejected.
The listener requires TLS 1.3 and a verified client certificate whose sole URI
SAN is
`spiffe://<trust-domain>/environment/<CHALK_API_ENV>/sync/<sync-node-uuid>`.
It is separate from the public router and exposes authenticated readiness at
`GET /internal/v1/sync/provider-bridge/ready`.

`CHALK_CLOUDFLARE_REALTIME_BASE_URL` exists only for deterministic local tests
against a protocol-faithful Cloudflare endpoint. Non-local environments reject
it and always use Cloudflare's production SFU endpoint.

## Runtime Smoke

```bash
apps/api/scripts/smoke-healthz.sh
apps/api/scripts/smoke-lifecycle.mjs
```

`smoke-healthz.sh` verifies `/healthz`, `/readyz`, 404, and 405 behavior against
a running API. `smoke-lifecycle.mjs` builds the binary, waits for `/healthz`,
sends `SIGTERM`, and verifies the process exits cleanly within configurable
startup/shutdown budgets.

## Local Observability And Performance

Logging is vendor-neutral and writes structured logs to stdout by default. The
logger attaches stable common fields (`service`, `env`, and `version`) to each
record so deployment infrastructure can ship the same output to CloudWatch,
Loki, Datadog, Better Stack, or another backend later.

Useful production-safe defaults:

```bash
CHALK_API_LOG_FORMAT=json
CHALK_API_LOG_LEVEL=info
CHALK_API_REQUEST_LOGS=errors
CHALK_API_SLOW_REQUEST_MS=250
```

OpenTelemetry traces and metrics export over OTLP/HTTP when an endpoint is
configured. The endpoint is a base URL; the API sends traces to `/v1/traces`
and metrics to `/v1/metrics`.

```bash
CHALK_API_OTLP_ENDPOINT=https://otel.example.com:4318
```

`CHALK_API_OTLP_INSECURE=true` allows an `http://` endpoint only in `local`
environments. The runtime emits Go runtime metrics, HTTP server spans, database
operation spans, Redis rate-limit spans, and Cloudflare media-plane request
spans. It propagates W3C `traceparent` and mirrors or creates the lowercase
`x-chalk-journey-id` response header. Request bodies and operation content are
never included in traces or logs.

`CHALK_API_REQUEST_LOGS` accepts `off`, `errors`, `slow`, `sampled`, or `all`.
Successful request logs are off by default; startup, shutdown, and error logs
still use the shared logger. `sampled` uses `CHALK_API_REQUEST_SAMPLE_RATE`
between `0` and `1`.

Local profiling hooks remain opt-in and are intended for short diagnostic runs:

```bash
cd apps/api
CHALK_API_OPERATION_LOGS=1 CHALK_API_PROFILER=1 CHALK_API_REQUEST_LOGS=all go run ./cmd
```

`CHALK_API_OPERATION_LOGS=1` emits Postgres query timing events to stdout. For
local profiling, it also defaults request logs to `all` unless
`CHALK_API_REQUEST_LOGS` is explicitly set. `CHALK_API_PROFILER=1` mounts Go
profiling handlers under `/debug/pprof`; do not expose it publicly.

## Call problem reports

Set `CHALK_PROBLEM_REPORTS_DISCORD_WEBHOOK_URL` on the **API service only**.
Only HTTPS Discord webhook URLs on `discord.com` or `discordapp.com` are accepted.
An unset value disables reports: availability returns false, the web hides report
entries, and submissions return `503 reports.unavailable`. A nonempty invalid URL
is startup-fatal: the API rejects its configuration and does not start. Never expose this URL in a
`VITE_` setting or the dashboard service. Discord is the record; no new table.

`POST /v1/tenants/{tenant_id}/problem-reports` accepts a signed participant media bearer credential
and `{description, diagnostics?}`. The full Tenant/Space/Episode/generation binding
must exist, but a live media connection is not required. Normal credential expiry
still applies. Descriptions are required (1,000 code points maximum); diagnostics
are optional (2,000 maximum). Hourly ceilings are three reports per participant, twenty per Episode,
thirty per IP and one hundred per owning Tenant. Participant limits run first. Delivery waits for Discord acknowledgement;
failures return 502 with no automatic retry. The form keeps the text for a retry.
The Discord payload contains only the written description, reporter display name
and owner/guest role, call name and call-instance ID (Episode ID), plus diagnostics
only when opted in: connection status, last error code, browser/UA, and app version.
Chalk does not add tenant names, timestamps, account email addresses or credentials.
Diagnostics are unselected by default. Before delivery, the service checks each report
field and the description/diagnostics pair for known Chalk credentials and known secret
formats. The check folds full-width characters, decodes HTML entities and tolerates
inserted separators and zero-width characters. Every intrinsic known-credential character,
including punctuation, must match in order. Provider-key prefixes must start at a token boundary.
Every nonempty configured credential is refused verbatim regardless of length; separator-tolerant matching applies only when its normalized form has at least 16 characters.
Configuration owns one classified secret inventory, including connection URLs and
decoded passwords, signing keys and seeds in raw, base64/base64url and hex forms,
rotated encryption keys, and service credentials. URLs with a userinfo password
are refused even when the password is not configured in Chalk.
This catches accidental pastes, including description/diagnostics splits; deliberate
evasion by the credential's own holder, such as reconstructing it across unrelated
call-name and description fields, is not covered. Other user-provided text
is sent as written with Markdown escaped, including any personal information or
unrecognized secrets the person chooses to include. Only `http://`, `https://` and
`www.` URLs are transformed: query strings and fragments are removed, and inline
code prevents clicks. Bare hosts, commit IDs and file/line/column frames remain text.
Mentions are disabled. Accepted descriptions and opt-in diagnostics are delivered in
full: longer reports use ordered description/diagnostic panels in the same message,
within Discord's 2,000-unit content and 6,000-unit combined embed limits.

### Real-stack report proof

Run on the M4 through the repo runner:

```sh
CHALK_REMOTE_NEEDS_BROWSER=1 scripts/gates/remote.sh -- node apps/web/tests/dashboard/report-proof.mjs
```

The browser drives real OwnerCall and SpacePage menus, delivery failure/retry,
opt-in diagnostics, leave, and failed connect. API, signed credentials, Postgres,
Sync and the built web app are real. Only Discord and the media vendor use local
fixtures. The Discord fixture uses an ephemeral trusted TLS certificate and a
process-local proxy; production destination validation stays enabled. Evidence goes to `artifacts/report-discord` in that checkout.

Live proof additionally requires an injected `CHALK_REPORT_LIVE_WEBHOOK_URL`,
`CHALK_REPORT_LIVE_PROOF=1`, and `CHALK_REPORT_LIVE_ONCE_FILE` pointing to a durable
exclusive-create marker outside the throwaway checkout. It sends only the labelled
owner report and reads that Discord message back. Never retry a live run after
its once marker exists: delivery might already have succeeded. These variables
are test-driver inputs, not production service settings.
