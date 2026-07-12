# Execution Trace Harness

Use this when Hasan wants to review a finished Go API change by watching it run as a readable story, not by reading code and tests alone.

## What It Is

The Execution Trace Harness is local developer tooling under
`apps/api/internal/traceharness`, exposed by:

```bash
go run ./cmd/trace
```

It runs scripted scenarios and prints an execution timeline. The first scenario,
`tenant-create`, goes through the real HTTP router and tenant service, then uses
traced local doubles at external boundaries so it can run without Postgres, Redis, email, or storage services.

The goal is confidence and familiarity: show request input, authentication, authorization or policy decisions, service transformations, repository or adapter calls, database/provider-shaped operations, returned data, and final output.

## How To Run

From `apps/api`:

```bash
go run ./cmd/trace
go run ./cmd/trace -scenario all
go run ./cmd/trace -scenario tenant-create
go run ./cmd/trace -scenario integration-execute-action
go run ./cmd/trace -color always
go run ./cmd/trace -style tree
go run ./cmd/trace -format json
```

By default, the command runs every registered scenario in catalog order. Use
`-scenario <name>` to focus on one trace. Text output is for humans. JSON output
is for tools; `-scenario all -format json` prints a JSON array.

`-style` picks the timeline layout: `minimal` (default) uses flat indentation;
`tree` draws box-drawing guides so nesting depth is explicit. Both share the
same palette, aligned key/value columns, and per-event summary.

## When To Add A Scenario

Add or update a scenario when a change introduces behavior Hasan may want to
review end to end:

- a new route or changed HTTP flow
- authorization, scope, role, or tenant-policy behavior
- rate limiting keys, policies, windows, or denial paths
- service-level business behavior that is easier to understand without HTTP
- adapter behavior for email, storage, Cloudflare, Redis, or another provider
- important edge cases: invalid input, missing auth, forbidden access, duplicate
  records, provider failure, cancellation, timeout, rollback, or empty results

Prefer one clear scenario per review question. Do not create one giant trace
that tries to explain the whole application.

## Scenario Families

Use scenario names that make the review target obvious:

- `route:*` for full HTTP flows
- `service:*` for direct domain/service behavior
- `policy:*` for authorization decisions
- `ratelimit:*` for rate-limit decisions
- `adapter:*` for provider request/response/error mapping
- `edge:*` for failure and boundary behavior

The CLI accepts `-scenario all` or any registered scenario name. Keep new names
simple, documented in `Run`, and included in `ScenarioNames` so the full-catalog
trace remains complete.

## Current Scenarios

Run the full catalog in text mode with:

```bash
go run ./cmd/trace -color always
go run ./cmd/trace -scenario all -style tree -color always
```

Run one scenario in text mode with:

```bash
go run ./cmd/trace -scenario <name> -color always
```

Registered scenarios:

- `tenant-create`
- `route:auth-register`
- `route:auth-login`
- `route:auth-logout`
- `route:auth-google-start`
- `route:auth-google-callback`
- `route:me`
- `route:tenant-create`
- `route:tenant-list-system`
- `route:tenant-get-authorized`
- `route:tenant-update-authorized`
- `route:regions-list`
- `route:user-create`
- `route:user-list-system`
- `route:user-get`
- `route:membership-create-owner`
- `route:membership-list-viewer`
- `route:membership-update-owner`
- `route:room-create-member`
- `route:session-create-member`
- `route:session-end-member`
- `route:recording-transcribe`
- `policy:tenant-system-allow`
- `policy:tenant-api-key-scope`
- `policy:tenant-user-role`
- `ratelimit:ip-deny`
- `ratelimit:principal-deny`
- `adapter:postgres-tenant-create`
- `adapter:redis-rate-limit`
- `adapter:cloudflare-r2-signed-url`
- `adapter:cloudflare-sfu-bootstrap`
- `adapter:cloudflare-rtk-join`
- `adapter:resend-send-email`
- `edge:unauthenticated-route`
- `edge:forbidden-tenant-route`
- `edge:invalid-route-id`

## What A Good Trace Shows

A good scenario shows the shape change across boundaries:

- raw input before validation or normalization
- authenticated principal and relevant scopes/roles
- policy requirement and allow/deny reason
- service input after validation/normalization
- repository or adapter input
- database query/provider operation shape, with secrets redacted
- returned row/provider result
- mapped domain object or error
- final HTTP response or service result

Keep sensitive values out of traces. Redact tokens, secrets, provider keys,
production IDs, customer data, and private operational detail.

## Implementation Pattern

1. Add a scenario in `apps/api/internal/traceharness`.
2. Reuse real code for the behavior being reviewed.
3. Use traced local doubles at external boundaries unless the scenario is
   explicitly about a real local dependency.
4. Record events with `Recorder.Add` for point-in-time steps.
5. Use `Recorder.Start` and `Span.End` for operations with a return value,
   duration, or error.
6. Add a focused test that asserts the scenario status/result and the important
   event names.
7. Update this doc or the API README if you add a scenario that other agents
   should know exists.

## Agent Checklist

When finishing Go API work and Hasan asks for harness coverage:

- Add the smallest scenario that proves the new behavior.
- Include the happy path and at least one important edge case when it materially
  improves review confidence.
- Keep output readable in text mode; avoid dumping huge structs.
- Preserve `-format json` for machine-readable output.
- Run `go test ./internal/traceharness ./cmd/trace`.
- Run `apps/api/scripts/gate.sh` after touching Go API code.

Do not commit raw trace output.
