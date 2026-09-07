# Composio catalog

For integration changes, verify toolkit/tool slugs and scopes against Composio's current [toolkits](https://docs.composio.dev/reference/api-reference/toolkits), [tools](https://docs.composio.dev/reference/api-reference/tools), and [connected accounts](https://docs.composio.dev/reference/api-reference/connected-accounts) APIs. Don't copy the provider catalog into this guide.

- Add services in `internal/integrations/catalog.go`. `ProviderName` is `composio`; Slack, Gmail, etc. are separate Chalk services. Keep Google/Microsoft services granular for consent.
- Map stable Chalk action IDs to verified provider slugs in `AllowedActions`. An unverified service can be connect-only with an empty action list; broad toolkits need explicit allowlists.
- Mark risky writes with `RiskTags`, such as `external_send`, `issue_write`, or `document_write`. Test service granularity, duplicate IDs, and allowlists when changing them.

From `apps/api`, run the live catalog check before merging:

```sh
CHALK_COMPOSIO_API_KEY="$COMPOSIO_API_KEY" CHALK_COMPOSIO_LIVE_TESTS=1 \
go test ./internal/adapters/composio -run Live -count=1
```

Clients post Chalk action IDs and arguments to `/v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions`. The service checks an active connection and its allowlist before mapping the provider slug.

Catalog/scopes checks don't prove execution. Use a disposable connected account for real-action tests; keep keys, raw payloads, and provider request IDs out of Git.
