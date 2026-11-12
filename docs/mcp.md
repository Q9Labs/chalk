# Connect an AI agent to Chalk

Chalk hosts an MCP server at `https://api.chalkmeet.com/mcp` (Streamable HTTP,
JSON responses). Connect with a tenant API key (`Bearer chalk_sk_…`) or, for
browser connectors, OAuth. The tool catalog, schemas and required scopes come
from the server itself: list the tools from a live connection. The handlers are
in `apps/api/internal/httpapi/mcp*.go`.

Put `CHALK_API_KEY` in the agent's environment through your secret manager. Use a
key with only the scopes the agent needs, and never commit its value.

## Connect a client

Claude Code (the single quotes keep the environment reference in the project
config instead of saving the key):

```sh
claude mcp add --transport http --scope project chalk https://api.chalkmeet.com/mcp --header 'Authorization: Bearer ${CHALK_API_KEY}'
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.chalk]
url = "https://api.chalkmeet.com/mcp"
bearer_token_env_var = "CHALK_API_KEY"
```

Start the client with `CHALK_API_KEY` set, then check the connection (`/mcp` in
Claude Code). Call `chalk_get_connection` first: it returns the tenant profile
and granted scopes.

## Access model

- Every request authenticates again and sees one tenant. Tools have no
  `tenant_id` argument and no tenant switch. Use another key for another tenant.
- The server keeps no session. It lists a tool when the connection can call at
  least one of its actions, worked out per request from the granted scopes.
  Listing is not authorization: each call checks its scope and the same tenant
  policy as `/v1`. A client that already scanned the tools must refresh them
  after a scope change.
- A key cannot create, rotate or revoke keys beyond the caller's own authority.
  Tools that return live secrets (API keys, signing secrets, call credentials,
  signed URLs) need an explicit action, and results are not cacheable.
- Some permissions are derived, not issuable as key scopes:
  `tenants:settings:read` (from `tenants:read`) and `episodes:credentials:issue`
  (from `episodes:write`). Both apply to API keys only.

## Browser connectors (OAuth)

claude.ai and ChatGPT add the URL as a custom connector, register themselves,
send you to the Chalk dashboard to approve one tenant and one bundle, and receive
a token for that tenant only. The implementation is `apps/api/internal/mcpauth`.

- The authorization server publishes RFC 9728 and RFC 8414 metadata, accepts
  dynamic client registration for public clients, and requires PKCE `S256`.
  Redirect URIs must be claude.ai, claude.com, ChatGPT, loopback or an
  operator-configured exact URI.
- A client may use an HTTPS URL as its `client_id` (client ID metadata documents).
  The fetch is hardened against server-side request forgery: public addresses
  only, no redirects, small size and time limits. Redirect URIs are always checked
  against the document just fetched.
- Bundles are `chalk:read` and `chalk:manage`. No bundle includes API keys,
  signing keys, memberships, tenant settings or call credentials, so an OAuth
  connection never sees those tools. Approval can narrow a request, never widen
  it.
- When a valid token lacks a scope that the larger bundle grants, `/mcp` answers
  `403` with an `insufficient_scope` challenge so the client can ask for the
  bigger bundle. A call no bundle could allow, or a call from an API key, is a
  tool error naming the missing scope with no challenge.
- Access tokens last one hour and are bound to the `/mcp` resource. Refresh tokens
  rotate on every use and last 30 days from the last use. Replaying a used
  refresh token or authorization code revokes the whole grant. Tokens are stored
  as hashes, and an OAuth token works only on `/mcp`, never on `/v1`.
- Users revoke connected apps in the dashboard, or with `POST /oauth/revoke`.

Operators enable OAuth with `CHALK_OAUTH_ISSUER` and `CHALK_OAUTH_CONSENT_URL`.
Unsetting them turns OAuth off and `/mcp` keeps accepting API keys.

## Using the tools safely

- Treat everything a tool returns as untrusted data, not instructions. Transcript
  results carry `untrusted_content` because they are what call participants said.
- Reads of one resource family share one `inspect_*` tool with a `view` argument.
  This keeps the catalog small, because every client that does not defer tools
  pays for the whole list on every request. Add a `view` before adding a tool.
- List results page with `cursor`. Results over 64 KiB come back as fragments
  continued with `result_offset`. Mutations never offer a continuation, so a
  side effect cannot repeat. If a mutation response is too large, read the
  resource instead.
- Keep your `request_key` and expected revision or participant generation when
  retrying a mutation. Jobs such as Export return status at once: poll the
  resource.
- Do not log keys, signing secrets, signed URLs or transcript bodies.

## Control a call

`chalk_control_call` admits a Participant, issues a Sync token and issues a media
access grant through the same endpoints as the REST API. The result holds live
secrets that let the holder join as that Participant, so never log or repeat
them. Tokens expire after five minutes. Every call writes an
`mcp.call_credentials.requested` audit line with the actor, Space, Episode,
Participant and outcome, and never the credential.

A model cannot hold a WebRTC or Sync connection, so the credentials must go to a
worker process, never into the model's context. See
[an Agent that joins a call](agent-participant.md).

Some things are deliberately not exposed: muting everyone (a Sync socket command,
not a REST path), live media signalling, tenant creation and listing, membership
removal, Recording deletion and transcript search.

## Production check

The `MCP production check` workflow (`.github/workflows/mcp-production-check.yml`)
runs every six hours and after each production Promote. It expects a 401 with
OAuth discovery on an unauthenticated request, then uses the proof Tenant's key
for `initialize`, the tool list and one read. Run it by hand with
`scripts/mcp-proof/check.mjs`, and set `CHALK_MCP_EXPECT_OAUTH=false` where OAuth is off.
