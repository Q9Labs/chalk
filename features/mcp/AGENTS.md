# Hosted MCP

The API shell supplies authenticated, tenant-bound application ports. This feature
must not import applications, authenticate credentials itself, call the HTTP API,
or hold mutable tenant/session state. Every tool invocation uses the current
request's principal. Keep schemas curated and scope checks action-specific.

Never log arguments, results, credentials, signed URLs, or transcript contents.
Use stateless Streamable HTTP with bounded JSON responses. Tools that issue
credentials require an explicit action; tools cannot expand the caller's scopes.

OAuth lives in the API shell (`apps/api/internal/mcpauth`), not here. It hands this
module the same tenant-bound principal an API key does, with the scopes of the
approved bundle, so tools never learn how a caller signed in.
