# Composio Catalog Maintenance

Use this when adding or changing an integration service or action. Composio
toolkit/tool names can drift, so treat this doc as workflow guidance, not as a
permanent copy of Composio's catalog.

Last source check: 2026-07-06.

## Source References

- Composio generated docs bundle: https://docs.composio.dev/llms-full.txt
- Toolkits API reference: https://docs.composio.dev/reference/api-reference/toolkits
- Tools API reference: https://docs.composio.dev/reference/api-reference/tools
- Connected accounts API reference: https://docs.composio.dev/reference/api-reference/connected-accounts
- OpenAPI snapshot endpoint used for adapter checks: https://backend.composio.dev/api/v3.1/openapi.json

## Add A Service

1. Verify the current Composio toolkit slug from the source references or live
   API.
2. Add a `ServiceEntry` in `internal/integrations/catalog.go`.
3. Keep Chalk IDs provider-neutral: `IntegrationProvider` is `composio`; Slack,
   Gmail, Linear, etc. are services.
4. For Google/Microsoft suites, prefer separate Chalk services so users grant
   access granularly.
5. Add or update catalog tests when the new service changes granularity,
   duplicate-ID behavior, or large-toolkit allowlist rules.

## Add An Action

1. Verify the exact Composio tool slug and required scopes against the current
   tools/scopes APIs.
2. Add the slug to the service's `AllowedActions`; broad toolkits must not ship
   without explicit action allowlists.
3. Tag risky writes with `RiskTags` such as `external_send`, `issue_write`, or
   `document_write`.
4. Run the live Composio catalog test before merging:

```bash
CHALK_COMPOSIO_API_KEY="$COMPOSIO_API_KEY" CHALK_COMPOSIO_LIVE_TESTS=1 \
go test ./internal/adapters/composio -run Live -count=1
```

Never commit the API key, raw provider payloads, or provider request IDs.
