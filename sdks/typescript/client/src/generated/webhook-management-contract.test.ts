import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createChalkEffectClient } from "../client";
import {
  IdempotencyKeyRequiredErrorWireSchema,
  IdempotencyKeyConflictErrorWireSchema,
  IdempotencyKeyExpiredErrorWireSchema,
  InvalidWebhookApiVersionErrorWireSchema,
  InvalidWebhookDeliveryIdErrorWireSchema,
  InvalidWebhookEndpointIdErrorWireSchema,
  InvalidWebhookEventTypeErrorWireSchema,
  InvalidWebhookUrlErrorWireSchema,
  UnsafeWebhookUrlErrorWireSchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryNotFoundErrorWireSchema,
  WebhookDeliveryNotRedeliverableErrorWireSchema,
  WebhookEndpointLimitReachedErrorWireSchema,
  WebhookEndpointNotFoundErrorWireSchema,
  WebhookEndpointRevisionConflictErrorWireSchema,
  WebhookEndpointSchema,
  WebhookEndpointWithSecretSchema,
  WebhookEventErasedErrorWireSchema,
  WebhookEventTypeUnavailableErrorWireSchema,
  type TenantId,
} from "./schemas";

type OpenApiOperation = {
  operationId: string;
  parameters?: Array<{ in: string; name: string; required?: boolean }>;
  requestBody?: { content: { "application/json": { schema: { $ref: string } } } };
  responses: Record<string, { content?: { "application/json"?: { schema: { $ref: string } } } }>;
};

type OpenApiDocument = {
  paths: Record<string, Partial<Record<"delete" | "get" | "patch" | "post", OpenApiOperation>>>;
  components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const openApi = JSON.parse(readFileSync(`${root}contract/generated/openapi.json`, "utf8")) as OpenApiDocument;
const generatedHttpApi = readFileSync(new URL("./http-api.ts", import.meta.url), "utf8");
const generatedOpenApiTypes = readFileSync(new URL("./openapi-types.d.ts", import.meta.url), "utf8");

const routes = [
  ["get", "/v1/tenants/{tenant_id}/webhook-endpoints", "listWebhookEndpoints", undefined, "WebhookEndpointList"],
  ["post", "/v1/tenants/{tenant_id}/webhook-endpoints", "createWebhookEndpoint", "CreateWebhookEndpointRequest", "WebhookEndpointWithSecret"],
  ["get", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "getWebhookEndpoint", undefined, "WebhookEndpoint"],
  ["patch", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "updateWebhookEndpoint", "UpdateWebhookEndpointRequest", "WebhookEndpoint"],
  ["delete", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}", "deleteWebhookEndpoint", undefined, undefined],
  ["get", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries", "listWebhookDeliveries", undefined, "WebhookDeliveryList"],
  ["get", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}", "getWebhookDelivery", undefined, "WebhookDeliveryDetail"],
  ["post", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver", "redeliverWebhookDelivery", undefined, "WebhookDeliveryCreated"],
  ["post", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret", "rotateWebhookEndpointSecret", "RotateWebhookSecretRequest", "RotateWebhookSecretResponse"],
  ["post", "/v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test", "testWebhookEndpoint", undefined, "WebhookDeliveryCreated"],
] as const;

const schemaName = (reference: string | undefined) => reference?.split("/").at(-1);
const parameterNames = (operation: OpenApiOperation) => operation.parameters?.map((parameter) => `${parameter.in}:${parameter.name}${parameter.required ? "!" : ""}`).sort() ?? [];

describe("generated webhook management contract", () => {
  it("serializes and decodes a typed create call through the generated client", async () => {
    const tenantId = "6706bfe4-2015-466a-b197-8ccd3f9e0d9b" as TenantId;
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          api_version: 1,
          created_at: "2026-07-13T10:00:00Z",
          enabled: true,
          event_types: ["participant.joined"],
          id: "8cb63bf4-515d-4b78-bd3b-7f981b05fd65",
          name: "Operations",
          revision: 1,
          secret: "whsec_store_this_once",
          tenant_id: tenantId,
          updated_at: "2026-07-13T10:00:00Z",
          url_redacted: "https://hooks.example.com/***",
        },
        { status: 201 },
      ),
    );
    const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://api.chalk.test", fetch: fetchMock as typeof fetch }));
    const endpoint = await Effect.runPromise(
      client.default.createWebhookEndpoint({
        params: { tenant_id: tenantId },
        headers: { "Idempotency-Key": "create_endpoint_001" },
        payload: {
          api_version: 1,
          enabled: true,
          event_types: ["participant.joined"],
          name: "Operations",
          url: "https://hooks.example.com/chalk",
        },
      }),
    );

    expect(endpoint.secret).toBe("whsec_store_this_once");
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe(`https://api.chalk.test/v1/tenants/${tenantId}/webhook-endpoints`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("create_endpoint_001");
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
      api_version: 1,
      enabled: true,
      event_types: ["participant.joined"],
      name: "Operations",
      url: "https://hooks.example.com/chalk",
    });
  });

  it("exposes all ten routes with their exact bodies in every generated client artifact", () => {
    for (const [method, path, operationId, requestSchema, responseSchema] of routes) {
      const operation = openApi.paths[path]?.[method];
      expect(operation?.operationId).toBe(operationId);
      expect(schemaName(operation?.requestBody?.content["application/json"].schema.$ref)).toBe(requestSchema);

      const successStatus = method === "delete" ? "204" : operationId === "createWebhookEndpoint" || operationId === "redeliverWebhookDelivery" || operationId === "testWebhookEndpoint" ? "201" : "200";
      expect(schemaName(operation?.responses[successStatus]?.content?.["application/json"]?.schema.$ref)).toBe(responseSchema);

      const effectPath = path.replaceAll(/{([^}]+)}/g, ":$1");
      expect(generatedHttpApi).toContain(`HttpApiEndpoint.${method}("${operationId}", "${effectPath}"`);
      expect(generatedOpenApiTypes).toContain(`${method}: operations["${operationId}"]`);
    }
  });

  it("preserves concurrency, idempotency, and delivery filter parameters", () => {
    const operation = (operationId: string) => routes.map(([method, path]) => openApi.paths[path]?.[method]).find((candidate) => candidate?.operationId === operationId)!;

    expect(parameterNames(operation("createWebhookEndpoint"))).toEqual(["header:Idempotency-Key!", "path:tenant_id!"]);
    for (const operationId of ["updateWebhookEndpoint", "deleteWebhookEndpoint"]) {
      expect(parameterNames(operation(operationId))).toEqual(["header:Idempotency-Key!", "header:If-Match!", "path:endpoint_id!", "path:tenant_id!"]);
    }
    for (const operationId of ["rotateWebhookEndpointSecret", "testWebhookEndpoint"]) {
      expect(parameterNames(operation(operationId))).toEqual(["header:Idempotency-Key!", "path:endpoint_id!", "path:tenant_id!"]);
    }
    expect(parameterNames(operation("redeliverWebhookDelivery"))).toEqual(["header:Idempotency-Key!", "path:delivery_id!", "path:endpoint_id!", "path:tenant_id!"]);
    expect(parameterNames(operation("listWebhookDeliveries"))).toEqual(["path:endpoint_id!", "path:tenant_id!", "query:cursor", "query:event_type", "query:page_size", "query:state"]);
  });

  it("returns a one-time secret only from create and rotate", () => {
    expect(Object.keys(openApi.components.schemas.WebhookEndpointWithSecret.properties ?? {})).toContain("secret");
    expect(Object.keys(openApi.components.schemas.RotateWebhookSecretResponse.properties ?? {})).toContain("secret");
    expect(Object.keys(openApi.components.schemas.WebhookEndpoint.properties ?? {})).not.toContain("secret");
    expect(Object.keys(openApi.components.schemas.WebhookEndpointList.properties ?? {})).not.toContain("secret");

    const endpoint = {
      api_version: 1,
      created_at: "2026-07-13T10:00:00Z",
      enabled: true,
      event_types: ["participant.joined"],
      id: "8cb63bf4-515d-4b78-bd3b-7f981b05fd65",
      name: "Operations",
      revision: 1,
      tenant_id: "6706bfe4-2015-466a-b197-8ccd3f9e0d9b",
      updated_at: "2026-07-13T10:00:00Z",
      url_redacted: "https://hooks.example.com/***",
    };
    expect(Schema.decodeUnknownSync(WebhookEndpointSchema)(endpoint)).toEqual(endpoint);
    expect(() => Schema.decodeUnknownSync(WebhookEndpointWithSecretSchema)(endpoint)).toThrow();
  });

  it("keeps Attempt detail and stable webhook error codes decodable", () => {
    const detail = Schema.decodeUnknownSync(WebhookDeliveryDetailSchema)({
      attempt_count: 1,
      attempts: [
        {
          error_code: null,
          finished_at: "2026-07-13T10:00:01Z",
          http_status: 204,
          id: "0544a5d2-01af-4559-8f97-8a782c41ee98",
          latency_milliseconds: 42,
          number: 1,
          outcome: "succeeded",
          started_at: "2026-07-13T10:00:00Z",
        },
      ],
      created_at: "2026-07-13T10:00:00Z",
      endpoint_id: "8cb63bf4-515d-4b78-bd3b-7f981b05fd65",
      endpoint_revision: 1,
      event: { id: "evt_123" },
      event_id: "770e4581-02f1-4bad-adcc-ae69ae9a2d24",
      event_type: "participant.joined",
      id: "1a8f2831-f128-4ed6-8096-4c42fb173ffc",
      next_attempt_at: null,
      state: "succeeded",
      terminal_at: "2026-07-13T10:00:01Z",
      updated_at: "2026-07-13T10:00:01Z",
    });
    expect(detail.attempts[0]).toMatchObject({ http_status: 204, latency_milliseconds: 42, number: 1, outcome: "succeeded" });

    const stableErrors = [
      [IdempotencyKeyConflictErrorWireSchema, "idempotency_key_conflict"],
      [IdempotencyKeyExpiredErrorWireSchema, "idempotency_key_expired"],
      [IdempotencyKeyRequiredErrorWireSchema, "idempotency_key_required"],
      [InvalidWebhookApiVersionErrorWireSchema, "invalid_webhook_api_version"],
      [InvalidWebhookDeliveryIdErrorWireSchema, "invalid_webhook_delivery_id"],
      [InvalidWebhookEndpointIdErrorWireSchema, "invalid_webhook_endpoint_id"],
      [InvalidWebhookEventTypeErrorWireSchema, "invalid_webhook_event_type"],
      [InvalidWebhookUrlErrorWireSchema, "invalid_webhook_url"],
      [UnsafeWebhookUrlErrorWireSchema, "unsafe_webhook_url"],
      [WebhookDeliveryNotFoundErrorWireSchema, "webhook_delivery_not_found"],
      [WebhookDeliveryNotRedeliverableErrorWireSchema, "webhook_delivery_not_redeliverable"],
      [WebhookEndpointLimitReachedErrorWireSchema, "webhook_endpoint_limit_reached"],
      [WebhookEndpointNotFoundErrorWireSchema, "webhook_endpoint_not_found"],
      [WebhookEndpointRevisionConflictErrorWireSchema, "webhook_endpoint_revision_conflict"],
      [WebhookEventErasedErrorWireSchema, "webhook_event_erased"],
      [WebhookEventTypeUnavailableErrorWireSchema, "webhook_event_type_unavailable"],
    ] as const;
    for (const [schema, code] of stableErrors) {
      expect(Schema.decodeUnknownSync(schema)({ error: { code, message: "safe message" } }).error.code).toBe(code);
      expect(() => Schema.decodeUnknownSync(schema)({ error: { code: `${code}_changed`, message: "safe message" } })).toThrow();
    }
  });
});
