# Chalk Account Boundary Naming

Date: 2026-05-16

## TLDR

Locked decision: Chalk uses `Organization` / `org` as the top-level account
boundary. Do not use `tenant` or `project` naming in the public model, SDK,
docs, API routes, token claims, or architecture notes unless this decision is
explicitly reopened.

Related notes:

- [chalk-top-level-actors-2026-05-14.md](chalk-top-level-actors-2026-05-14.md)
- [chalk-domain-model-2026-05-14.md](chalk-domain-model-2026-05-14.md)
- [chalk-session-lifecycle-2026-05-15.md](chalk-session-lifecycle-2026-05-15.md)

## Decision

Use this hierarchy:

```text
Organization
  -> Room
      -> Session
```

`Organization` is the customer-facing account, billing, membership, API key,
configuration, and access boundary.

## Naming Rules

- Use `Organization` in prose and product docs.
- Use `org` in compact identifiers and SDK/API surfaces where shorter naming is
  appropriate.
- Use `org_id` in database columns, token claims, logs, and events.
- Do not introduce `tenant_id` as a parallel architecture noun.
- Do not introduce `project_id` as a nested product boundary.

## Examples

API-style examples:

```text
/orgs/:orgId/api-keys
/orgs/:orgId/rooms
/orgs/:orgId/webhooks
```

Token/event claim examples:

```text
org_id
room_id
session_id
participant_id
```

SDK-style examples:

```ts
const org = await chalk.orgs.get(orgId);
const room = await org.rooms.create();
const session = await room.createSession();
```

## Rationale

`Organization` is clear to customers and broad enough to own billing,
membership, API keys, webhooks, rooms, sessions, and usage. Avoiding `tenant`
and `project` keeps the model smaller and prevents three different names from
describing the same top-level boundary.
