# Tenant handover

A Tenant created and owned by a service can be handed over to a person's Chalk dashboard account. The handover is explicit: until the named recipient accepts it, the Tenant and its access do not change.

## Lifecycle

1. The owning service starts a handover with `POST /v1/tenants/{tenant_id}/handovers` and an `Idempotency-Key`. A Chalk operator can start or cancel one with `apps/api/cmd/tenant-handover`.
2. The service sends the recipient to `/dashboard/handover/{handover_id}` on the dashboard origin. The recipient signs in with the account whose verified email matches `recipient_email`, reviews the offer, and accepts it.
3. Acceptance is one database transaction. The recipient's dashboard user becomes an owner member, the Tenant's owning service becomes the configured dashboard service, active API keys for the Tenant are revoked, webhook endpoints are disabled, and queued webhook deliveries are cancelled.
4. The handover row stays as the audit record: initiator, recipient, source and destination service, terminal actor, and timestamps.

Pending offers expire at `expires_at`; reads report `expired` after that time. The owning service or an operator can cancel a pending offer. Create retries with the same idempotency key and body return the original offer; using the key with a different body returns `409 request.idempotency_conflict`. Acceptance and cancellation are naturally safe to retry: the same terminal state is returned when the operation has already happened.

Because pre-handover API keys and webhook endpoints were created while the integration owned the Tenant, acceptance revokes or disables all of the Tenant's existing active keys and enabled endpoints. Keys minted after the dashboard service owns the Tenant are unaffected.

## Service API

```http
POST /v1/tenants/{tenant_id}/handovers
Authorization: Bearer <service secret>
Idempotency-Key: <16-128 ASCII letters, digits, underscores or hyphens>
Content-Type: application/json

{
  "recipient_email": "person@example.com",
  "expires_in_seconds": 604800
}
```

`expires_in_seconds` is optional. The default is seven days; accepted values are 60 seconds through 30 days. Only the service that currently owns the Tenant can start, read, or cancel its handover. Another service, a Tenant API key, and a dashboard user credential cannot use the service-side mutation routes.

Useful service-side routes:

- `POST /v1/tenants/{tenant_id}/handovers` — create an offer.
- `GET /v1/tenants/{tenant_id}/handovers/{handover_id}` — read its state and audit fields.
- `POST /v1/tenants/{tenant_id}/handovers/{handover_id}/cancellation` — cancel a pending offer.

The TypeScript server SDK exposes the same operations:

```ts
const handover = await chalk.tenantHandovers.create({ recipientEmail: "person@example.com" }, { idempotencyKey: crypto.randomUUID() });
const acceptanceURL = `${dashboardOrigin}/dashboard/handover/${handover.id}`;

const current = await chalk.tenantHandovers.get(handover.id);
await chalk.tenantHandovers.cancel(handover.id);
```

## Operator command

Operators use direct database access rather than a production System API principal:

```sh
tenant-handover start \
  -tenant-id <tenant uuid> \
  -email person@example.com \
  -operator <operator identity> \
  -request-key <unique request key>

tenant-handover cancel \
  -tenant-id <tenant uuid> \
  -handover-id <handover uuid> \
  -operator <operator identity>
```

The command reads `CHALK_DATABASE_URL` and the configured dashboard service ID. The operator identity is written to the handover audit record; do not use a customer or integration name as the identity.

## Dashboard acceptance

`/dashboard/handover/{handover_id}` is a standalone signed-in flow. It does not reveal the recipient email in the browser response; it only reports whether the signed-in account's email matches. The wrong account is told to switch account. Acceptance vouches for the provider-verified email and display name through the dashboard service credential.

After acceptance, the dashboard resolves the most recently accepted, still dashboard-owned handover for the account email as the active Tenant. The current dashboard remains single-Tenant at a time; it does not yet provide a Tenant switcher for an account that also has its original provisioned Tenant.
