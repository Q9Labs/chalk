## Highlights

- Hardened `@q9labs/chalk-core` webhook handling for Express consumers with strict content-type/body/header checks, exact 400/401/413/415 responses, parser-error middleware, normalized signature handling, and attached delivery/body metadata on the request.
- Enriched final Chalk webhook delivery logs so the last delivery event now tells you whether recording, transcript, summary, action items, and errors were actually present in the payload.

## Technical Notes

- Added new exports from `@q9labs/chalk-core`: `chalkWebhookParserErrorMiddleware`, `normalizeChalkSignatureHeader`, and stricter Express webhook adapter option types.
- Added regression coverage for exact webhook adapter status mapping and request context enrichment.
