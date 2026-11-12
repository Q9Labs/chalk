# Hosted MCP tools

The API shell supplies authenticated, tenant-bound application ports. This package
must not import other API packages (only `authentication`, for the one scope list),
authenticate credentials itself, call the HTTP API, or hold mutable tenant/session
state. Every tool invocation uses the current request's connection. Keep schemas
curated and scope checks action-specific.

A tool is one `Tool` value in `tools.go`: its schema, its scope, and the fields and
scope each action needs. `Bind` adds the handler and panics at startup when the
schema and the Go input disagree. Scope names come from `authentication`; a scope
no credential can be issued is a derived scope there.

Never log arguments, results, credentials, signed URLs, or transcript contents.
Use stateless Streamable HTTP with bounded JSON responses. Tools that issue
credentials require an explicit action; tools cannot expand the caller's scopes.

OAuth lives in the API shell (`apps/api/internal/mcpauth`), not here. It hands this
package the same tenant-bound principal an API key does, with the scopes of the
approved bundle, so tools never learn how a caller signed in.
