import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { createChalkEffectClient } from "./client";
import { CreateTenantRequestSchema, FindTenantByExternalIDQueryParamsSchema, TenantSchema } from "./generated/schemas";

it("creates and finds a Tenant with an opaque external account ID through the generated client", async () => {
  const externalID = "workos:test:user_example";
  const tenant = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Personal Tenant",
    external_id: externalID,
    cors_allowed_origins: [],
    default_media_plane: null,
    media_plane_provider_config: null,
    storage_provider_config: null,
    logo_key: null,
    website: null,
    transcription_ceiling: "on_demand",
    transcription_default_mode: "on_demand",
    provider_policy_version: "test-policy",
    recording_retention_seconds: 3600,
    transcript_retention_seconds: 3600,
    transcription_source_window_seconds: 3600,
    updated_at: "2026-10-18T12:00:00Z",
    created_at: "2026-10-18T12:00:00Z",
  };
  const client = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://chalk.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST") {
          expect(await request.json()).toEqual({ name: tenant.name, external_id: externalID });
          return Response.json(tenant, { status: 201 });
        }
        expect(new URL(request.url).searchParams.get("external_id")).toBe(externalID);
        return Response.json(tenant);
      },
    }),
  );
  const created = await Effect.runPromise(client.tenants.createTenant({ payload: Schema.decodeUnknownSync(CreateTenantRequestSchema)({ name: tenant.name, external_id: externalID }) }));
  const found = await Effect.runPromise(client.tenants.findTenantByExternalID({ query: Schema.decodeUnknownSync(FindTenantByExternalIDQueryParamsSchema)({ external_id: externalID }) }));
  expect(created).toEqual(tenant);
  expect(found).toEqual(Schema.decodeUnknownSync(TenantSchema)(tenant));
});
