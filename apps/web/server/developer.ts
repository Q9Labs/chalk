import { Schema } from "effect";
import { UUIDSchema, DateTimeStringSchema } from "@q9labsai/chalk-client/effect";
import type { WebhookDeliveryDetail } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { run } from "./engine";
import { keyDTO, webhookDTO } from "./dto";
import type { AllowedWebsitesDTO, DeliveryDTO, DeveloperAction, DeveloperDTO, SecretDTO } from "../src/lib/dashboard/contracts";
export async function developerPage(engine: Engine, cursors: { keyCursor?: string; webhookCursor?: string }): Promise<DeveloperDTO> {
  const params = { tenant_id: engine.tenantId };
  const [keys, webhooks, tenant] = await Promise.all([
    run(engine.api.default.listAPIKeys({ params, query: { page_size: 30, cursor: cursors.keyCursor } })),
    run(engine.api.default.listWebhookEndpoints({ params, query: { page_size: 5, cursor: cursors.webhookCursor } })),
    run(engine.api.tenants.getTenant({ params })),
  ]);
  return {
    allowedWebsites: tenant.cors_allowed_origins,
    keys: keys.api_keys.map(keyDTO),
    webhooks: await Promise.all(
      webhooks.webhook_endpoints.map(async (webhook) => {
        const endpointParams = { ...params, endpoint_id: webhook.id };
        const deliveries = await run(engine.api.default.listWebhookDeliveries({ params: endpointParams, query: { page_size: 1 } }));
        const latest = deliveries.deliveries[0];
        const lastDelivery = latest ? deliveryDTO(await run(engine.api.default.getWebhookDelivery({ params: { ...endpointParams, delivery_id: latest.id } }))) : null;
        return { ...webhookDTO(webhook), lastDelivery };
      }),
    ),
    nextKeyCursor: keys.pagination.next_cursor,
    nextWebhookCursor: webhooks.page.next_cursor,
  };
}

export async function developerMutation(engine: Engine, action: DeveloperAction) {
  const api = engine.api.default;
  const params = { tenant_id: engine.tenantId };
  switch (action.action) {
    case "allowed-websites": {
      const tenant = await run(engine.api.tenants.getTenant({ params }));
      return { allowedWebsites: tenant.cors_allowed_origins } satisfies AllowedWebsitesDTO;
    }
    case "set-allowed-websites": {
      const tenant = await run(engine.api.tenants.updateTenant({ params, payload: { cors_allowed_origins: action.origins } }));
      return { allowedWebsites: tenant.cors_allowed_origins } satisfies AllowedWebsitesDTO;
    }
    case "create-key": {
      const result = await run(api.createAPIKey({ params, headers: { "Idempotency-Key": action.idempotencyKey }, payload: { name: action.name, scopes: action.scopes, expires_at: Schema.decodeUnknownSync(DateTimeStringSchema)(action.expiresAt) } }));
      return { id: result.api_key.id, secret: result.secret } satisfies SecretDTO;
    }
    case "rotate-key": {
      const result = await run(api.rotateAPIKey({ params: { ...params, api_key_id: Schema.decodeUnknownSync(UUIDSchema)(action.keyId) }, headers: { "Idempotency-Key": action.idempotencyKey }, payload: { expires_at: Schema.decodeUnknownSync(DateTimeStringSchema)(action.expiresAt) } }));
      return { id: result.api_key.id, secret: result.secret } satisfies SecretDTO;
    }
    case "revoke-key":
      await run(api.revokeAPIKey({ params: { ...params, api_key_id: Schema.decodeUnknownSync(UUIDSchema)(action.keyId) } }));
      return { ok: true };
    case "create-webhook": {
      const result = await run(api.createWebhookEndpoint({ params, headers: { "Idempotency-Key": action.idempotencyKey }, payload: { name: action.name, url: action.url, enabled: action.enabled, event_types: action.eventTypes, api_version: 1 } }));
      return { webhook: webhookDTO(result), secret: result.secret };
    }
    case "update-webhook":
      return {
        webhook: webhookDTO(
          await run(
            api.updateWebhookEndpoint({
              params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId) },
              headers: { "Idempotency-Key": action.idempotencyKey, "If-Match": `"${action.revision}"` },
              payload: {
                ...(action.name === undefined ? {} : { name: action.name }),
                ...(action.url === undefined ? {} : { url: action.url }),
                ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
                ...(action.eventTypes === undefined ? {} : { event_types: action.eventTypes }),
              },
            }),
          ),
        ),
      };
    case "delete-webhook":
      await run(api.deleteWebhookEndpoint({ params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId) }, headers: { "Idempotency-Key": action.idempotencyKey, "If-Match": `"${action.revision}"` } }));
      return { ok: true };
    case "rotate-webhook-secret": {
      const result = await run(api.rotateWebhookEndpointSecret({ params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId) }, headers: { "Idempotency-Key": action.idempotencyKey }, payload: { revoke_previous_immediately: action.revokePreviousImmediately } }));
      return { id: result.endpoint_id, secret: result.secret } satisfies SecretDTO;
    }
    case "test-webhook": {
      const result = await run(api.testWebhookEndpoint({ params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId) }, headers: { "Idempotency-Key": action.idempotencyKey } }));
      return { deliveryId: result.delivery_id };
    }
    case "webhook-deliveries": {
      const endpointParams = { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId) };
      await run(api.getWebhookEndpoint({ params: endpointParams }));
      const result = await run(api.listWebhookDeliveries({ params: endpointParams, query: { page_size: 5, cursor: action.cursor } }));
      return { deliveries: await Promise.all(result.deliveries.map(async (d) => deliveryDTO(await run(api.getWebhookDelivery({ params: { ...endpointParams, delivery_id: d.id } }))))), nextCursor: result.page.next_cursor };
    }
    case "webhook-delivery": {
      const result = await run(api.getWebhookDelivery({ params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId), delivery_id: Schema.decodeUnknownSync(UUIDSchema)(action.deliveryId) } }));
      return { id: result.id, state: result.state, eventType: result.event_type, attemptCount: result.attempt_count, attempts: result.attempts.map((a) => ({ status: a.http_status, errorCode: a.error_code, finishedAt: a.finished_at })) };
    }
    case "redeliver-webhook": {
      const result = await run(api.redeliverWebhookDelivery({ params: { ...params, endpoint_id: Schema.decodeUnknownSync(UUIDSchema)(action.webhookId), delivery_id: Schema.decodeUnknownSync(UUIDSchema)(action.deliveryId) }, headers: { "Idempotency-Key": action.idempotencyKey } }));
      return { deliveryId: result.delivery_id };
    }
  }
}

function deliveryDTO(delivery: WebhookDeliveryDetail): DeliveryDTO {
  const latest = delivery.attempts.slice().sort((a, b) => b.number - a.number)[0];
  return { id: delivery.id, state: delivery.state, createdAt: delivery.created_at, eventType: delivery.event_type, attempts: delivery.attempt_count, status: latest?.http_status ?? null };
}
