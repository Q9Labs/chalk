# Documentation hygiene session log — 2026-07-12

- 2026-07-12: Started a Markdown documentation audit. Scope is documentation-only; pre-existing API, sync, webhook, SDK, contract, and generated-code changes are out of scope and will be preserved.
- 2026-07-12: Recorded requested engineering contracts: API work must include observability and tracing, new services must join uptime monitoring, and consumer-facing capabilities such as webhooks must include an SDK consumption surface.
- 2026-07-12: Added operational-completeness rules to the repository instructions, an API-specific telemetry contract, checkable API route workflow requirements, and an observability shipping contract tied to the uptime-worker registry.
- 2026-07-12: Added durable infrastructure guidance for registering and proving service monitors, plus a webhook contract rule that treats the receiver SDK surface as part of feature completion.
- 2026-07-12: Removed the stale `apps/docs` canonical-source reference from the design-system document; that application path no longer exists. The audit found no whole-document deletion that was safe without a product decision.
- 2026-07-12: Hasan approved removing the unimplemented browser Document PiP reference and the completed/stale Cloudflare media-plane execution brief. Kept the sound design as an explicitly aspirational reference.
- 2026-07-12: Removed the stale mobile store-review helper at Hasan's direction rather than retaining a draft whose submission claims could be reused accidentally.
- 2026-07-12: Full repository gate was blocked in `static:fallow` by unrelated SDK dead-code, duplication, and complexity findings. Scoped Markdown formatting and `git diff --check` passed.
