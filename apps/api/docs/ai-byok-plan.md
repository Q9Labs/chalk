# AI BYOK Plan

## Purpose

Add the smallest useful AI service foundation to the API: tenant-level Bring
Your Own Key configuration for OpenRouter. The feature lets a tenant store an
OpenRouter key in its AI provider config and use that key for an authenticated
AI request through Chalk.

This plan intentionally keeps the first slice narrow. It establishes the
boundary for AI calls without building the richer account, policy, usage-ledger,
or async job system.

## Scope

Use the existing tenant `ai_provider_config` JSON field as the source of truth.
The MVP config shape is:

```json
{
  "gateway": "openrouter",
  "api_key": "sk-or-...",
  "default_model": "anthropic/claude-sonnet-4"
}
```

The caller may supply a model for a specific request. If the request omits a
model, the service uses `default_model`.

Rules:

- `gateway` is required.
- The only supported MVP gateway is `openrouter`.
- `api_key` is required.
- A model is required after request and tenant defaults are resolved.
- Tenant HTTP responses redact `api_key`.
- Provider keys are never written to request logs, operation logs, trace events,
  endpoint contract previews, or error responses.

## Deferred

The first implementation does not include:

- Cloudflare AI Gateway.
- Groq or direct OpenAI adapters.
- Multiple AI accounts per tenant.
- Model allowlists or routing policies.
- Usage and cost ledger tables.
- Async generation jobs.
- Zero data retention policy controls.
- Gateway fallback routing.
- A secret backend or encrypted `secret_ref` migration.

## Vocabulary

- Gateway: the API surface Chalk calls. The MVP gateway is OpenRouter.
- Provider: the upstream model owner behind a gateway, such as Anthropic or
  OpenAI. The MVP stores this only when a response exposes it; Chalk does not
  route on provider.
- Model: the concrete model ID sent to the gateway.
- BYOK: a tenant-provided gateway API key stored in tenant AI config for this
  slice.

## Boundaries

Follow `docs/code-standards.md`:

- Keep `cmd/main.go` as the composition root.
- Keep provider-neutral AI behavior under `internal/ai`.
- Keep OpenRouter request signing, endpoint URLs, response decoding, and
  provider error translation under `internal/adapters/openrouter`.
- Do not leak OpenRouter-specific headers, paths, response IDs, or errors into
  HTTP contracts or tenant domain types.
- Use domain-shaped names. In `internal/ai`, core types are `Service`,
  `Config`, and provider-neutral nouns. The OpenRouter package exposes
  `Adapter` and `NewAdapter` or `NewAdapterWithClient`.
- The first port should only cover the first real caller. Do not add generic
  model policy or routing abstractions in this slice.

The implementation chain for a new HTTP surface is:

```text
HTTP endpoint -> service interface -> ai.Service -> ai.Client -> OpenRouter adapter
```

The tenant repository remains responsible only for persisting and returning
tenant config. AI config parsing belongs in the AI boundary or in the HTTP
endpoint before the service call, depending on the route shape.

## Core Package

Add `internal/ai`.

Expected types:

```go
type Gateway string

const GatewayOpenRouter Gateway = "openrouter"

type Config struct {
	Gateway      Gateway
	APIKey       string
	DefaultModel string
}

type Client interface {
	CreateResponse(ctx context.Context, input CreateResponseInput) (Response, error)
}

type Service struct {
	client Client
}
```

Expected errors:

- `ErrInvalidConfig`
- `ErrInvalidGateway`
- `ErrMissingCredentials`
- `ErrInvalidModel`
- `ErrClientUnavailable`
- `ErrProviderUnauthorized`
- `ErrProviderRateLimited`
- `ErrProviderFailed`

The exact method names should follow the first route or product action. If the
first caller is a generic response endpoint, `CreateResponse` is acceptable. If
the first caller is transcription, use transcription-shaped names instead.

## OpenRouter Adapter

Add `internal/adapters/openrouter`.

Responsibilities:

- Build OpenRouter HTTP requests.
- Set `Authorization: Bearer <api_key>`.
- Set `Content-Type: application/json`.
- Optionally set app attribution headers later through non-secret config.
- Decode successful responses into `internal/ai` response types.
- Preserve returned usage in response metadata when present.
- Map gateway errors into `internal/ai` errors:
  - `401` and `403` -> `ErrProviderUnauthorized`
  - `429` -> `ErrProviderRateLimited`
  - other non-2xx responses -> `ErrProviderFailed`

The adapter should support `NewAdapter` for production config and
`NewAdapterWithClient` for `httptest` coverage.

## Tenant Config

Tenant create and update continue to accept `ai_provider_config` as JSON. The
service validates only that it is valid JSON. AI-specific validation happens
when the config is used for an AI call, so existing tenant workflows do not
become coupled to the first AI gateway.

Tenant responses must redact secrets inside `ai_provider_config`. The existing
redaction helper should cover `api_key`; add a focused regression test if it
does not.

## HTTP Contract

The first slice exposes a recording transcription route rather than a generic AI
route. Define it with the route workflow in `docs/route-workflow.md`.

```http
POST /v1/tenants/{tenant_id}/recordings/{recording_id}/transcriptions
```

Request:

```json
{
  "model": "openai/whisper-1",
  "language": "en"
}
```

Response:

```json
{
  "id": "transcript_id",
  "tenant_id": "tenant_id",
  "recording_id": "recording_id",
  "status": "completed",
  "provider": "openrouter",
  "model": "openai/whisper-1",
  "languages": ["en"],
  "text": "Transcript text",
  "metadata": {
    "gateway": "openrouter",
    "usage": {}
  }
}
```

Contract requirements:

- Use an `Endpoint[Request, Response]` factory in the relevant HTTP file.
- Mount under `/v1`.
- Apply `Auth(APIAuthSessionOrBearer)`.
- Authorize the path tenant with `authorization.TenantPolicy.AuthorizeTenant`
  before reading or using tenant AI config.
- Bound the JSON request body with `http.MaxBytesReader`.
- Define stable API errors for invalid AI config, missing credentials,
  unsupported gateway, provider unauthorized, provider rate limited, and provider
  failure.
- Add the endpoint to `PreviewRouteContracts()` if a route is implemented.
- Update the route contract test when the route inventory changes.

The route reads the completed recording artifact from object storage using the
recording row's tenant-owned `storage_key`; it does not accept caller-supplied
audio bytes. This first slice remains synchronous. Async transcription should be
owned by Chalk with a job queue and transcript state transitions rather than
assuming OpenRouter provides async STT.

## Security

The MVP stores BYOK in `ai_provider_config`. This is accepted for speed, but it
means tenant keys are stored in the API database rather than a dedicated secret
backend.

Required safeguards:

- Redact `api_key` from tenant responses.
- Never log authorization headers or raw AI config.
- Never include the API key in trace harness events.
- Return generic credential/provider errors to clients.
- Keep provider response bodies out of logs.
- Do not persist prompt or output bodies outside the response unless a later
  product route explicitly needs storage.

## Tests

Add focused tests for:

- AI config parsing accepts valid OpenRouter config.
- AI config parsing rejects unsupported gateway, missing API key, and missing
  resolved model.
- Tenant create/update responses redact `ai_provider_config.api_key`.
- OpenRouter adapter sends the expected URL, headers, model, and JSON body using
  `httptest`.
- OpenRouter adapter maps `401`, `403`, `429`, and `5xx` into `internal/ai`
  errors.
- Any new HTTP route requires authentication.
- Any new tenant-scoped HTTP route returns `403` for an authenticated caller
  without access to the path tenant.

## Execution Trace Harness

If an HTTP route is added, wire a trace scenario that shows:

- request input with secrets redacted
- authentication
- tenant authorization
- AI config selection with `api_key` redacted
- OpenRouter adapter call metadata without headers
- returned gateway/model/usage metadata
- final HTTP response shape

## Verification

Focused checks during implementation:

```bash
cd apps/api
go test ./internal/ai ./internal/adapters/openrouter ./internal/httpapi ./internal/tenants
go run ./scratchpad/sdk-generator-proof/contractopenapi
scripts/gate.sh
```

Run `scripts/perf-local.sh` when the implementation is complete, per
`apps/api/AGENTS.md`.
