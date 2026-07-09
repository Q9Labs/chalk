# AI Service Session Log - 2026-07-08

## 2026-07-08

- Hasan wants AI service planning for `apps/api`.
- Initial adapters discussed: OpenRouter, Groq, Cloudflare AI Gateway.
- Current direction:
  - Defer Groq and direct OpenAI for now.
  - Treat OpenRouter and Cloudflare AI Gateway as gateways, not underlying model providers.
  - Track upstream provider separately, such as Anthropic, OpenAI, Google, Meta, etc.
  - Track model separately from gateway and provider.
  - Avoid opinionated product behavior at first; the API should mostly expose provider/gateway calls through Chalk boundaries.
  - Support both app-wide credentials and tenant BYOK.
  - Preserve cost breakdowns per request.
  - Prefer async execution where provider/gateway support exists.
  - Make zero data retention configurable per tenant.
  - Allow tenants to choose permitted models.

## Notes From Docs

- OpenRouter exposes response usage with token counts, optional cost, BYOK marker,
  and cost details.
- OpenRouter supports per-request zero data retention routing via `provider.zdr`.
- Cloudflare AI Gateway supports request metadata via `cf-aig-metadata`.
- Cloudflare AI Gateway supports per-request log suppression via
  `cf-aig-collect-log: false`.
- Cloudflare AI Gateway universal endpoint supports provider/endpoint routing and
  fallback-style arrays, but async support needs more design verification per
  operation/provider.

## 2026-07-09

- Hasan clarified the core issue is semantics around config and tenant ownership.
- Tenants should be able to bring multiple AI accounts, not just one tenant-level
  provider config blob.
- Every AI generation should persist normalized usage/cost data, including input
  tokens, output tokens, cached tokens, and cost.
- The planning model should use user stories to expose missing concepts before
  implementation.
- Current likely vocabulary:
  - gateway: the API surface Chalk calls, such as OpenRouter or Cloudflare AI
    Gateway.
  - provider: the upstream model owner, such as Anthropic, OpenAI, Google, Meta,
    etc.
  - model: the concrete model identifier selected for a generation.
  - account: the credential/config bundle used for a gateway call; tenants may
    have multiple accounts per gateway/provider.
  - generation: a persisted AI invocation/job with request metadata, result
    metadata, status, and normalized usage/cost ledger rows.

## 2026-07-09 Minimal Scope Decision

- Hasan decided the richer AI account, policy, model allowlist, async generation,
  and usage-ledger design should not be implemented now.
- Current scope is simple BYOK only.
- Future planning should not silently reintroduce the larger model unless Hasan
  explicitly reopens it.
- Wrote the implementation planning spec at `apps/api/docs/ai-byok-plan.md`.
- The spec folds in `apps/api/docs/code-standards.md` and
  `apps/api/docs/route-workflow.md`, especially provider-neutral core boundaries,
  adapter-owned provider details, endpoint contract definitions, auth/authz,
  route contract preview updates, and focused tests.
