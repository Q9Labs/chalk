# Tenant CORS session log

## 2026-08-29 15:25 UTC

The current CORS policy is deployment-wide. Tenant management already has an
authorized PATCH contract, so Tenant CORS will extend that contract with a
bounded exact-origin list. Preflight will resolve only canonical
`/v1/tenants/{tenant_id}` paths, and the policy cache will be bounded and short
lived so browser traffic does not add a database query per request.

## 2026-08-29 15:54 UTC

The API, generated TypeScript SDK, and Dashboard now expose the Tenant
allowlist. Exact deployment origins remain available for the first-party
Dashboard on every route, while a deployment wildcard cannot bypass a Tenant
policy. The first dogfood pass found that an empty Postgres array became JSON
`null`; the HTTP mapper now preserves it as `[]`, with a regression test.

The migration passed an explicit Up, Down, and Up cycle at version 20260829160000. Focused Go tests, the web type check and 17 tests, and the
`route:tenant-update-authorized` execution trace pass. The API gate's Go,
database, and test lanes passed, but its sync migration lane selected system
Elixir 1.14 instead of the installed mise Elixir 1.19 toolchain; rerun the gate
through mise after dogfood.

## 2026-08-29 16:01 UTC

The clean dogfood pass saved and refreshed `http://localhost:3070` and
`https://app.example.com`, rejected hosted HTTP without losing form input, and
fit a 375px viewport without horizontal overflow. The 20.7-second H.264 proof
was validated and uploaded as `media/daring-dove-moon/tenant-cors-final-desktop.mp4`.
The API gate passed in full through mise's Erlang 28 and Elixir 1.19 toolchain.
