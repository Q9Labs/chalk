# Hosted MCP

The API shell supplies authenticated, tenant-bound application ports. This feature
must not import applications, authenticate credentials itself, call the HTTP API,
or hold mutable tenant/session state. Every tool invocation uses the current
request's principal. Keep schemas curated and scope checks action-specific.

Never log arguments, results, credentials, signed URLs, or transcript contents.
Use stateless Streamable HTTP with bounded JSON responses. Tools that issue
credentials require an explicit action; tools cannot expand the caller's scopes.
