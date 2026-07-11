import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChalkEffectClient } from "./client";
import { ChalkOperationPolicies, type Email, type TenantId } from "./generated/schemas";

const tenantId = "11111111-1111-4111-8111-111111111111" as TenantId;
const email = "person@example.com" as Email;

describe("createChalkEffectClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects auth and custom headers into generated HttpApi client requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          ai_provider_config: null,
          created_at: "2026-07-09T00:00:00Z",
          default_media_plane: null,
          default_region: null,
          id: tenantId,
          logo_key: null,
          media_plane_provider_config: null,
          name: "Acme",
          storage_provider_config: null,
          updated_at: "2026-07-09T00:00:00Z",
          website: null,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const client = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://api.chalk.test",
        auth: { type: "bearer", token: "test-token" },
        fetch: fetchMock as typeof fetch,
        headers: { "X-Chalk-Test": "yes" },
      }),
    );

    const tenant = await Effect.runPromise(client.tenants.getTenant({ params: { tenant_id: tenantId } }));

    expect(tenant.name).toBe("Acme");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);

    expect(String(input)).toBe("https://api.chalk.test/v1/tenants/11111111-1111-4111-8111-111111111111");
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("x-chalk-test")).toBe("yes");
  }, 20_000);

  it("decodes generated tagged API errors", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
          "X-RateLimit-Limit": "10",
          "X-RateLimit-Remaining": "0",
        },
      });
    });
    const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://api.chalk.test", fetch: fetchMock as typeof fetch }));

    await expect(Effect.runPromise(client.auth.login({ payload: { email, password: "secret" } }))).rejects.toMatchObject({
      _tag: "RateLimitedError",
      error: {
        code: "rate_limited",
        message: "Too many requests",
      },
    });
  }, 20_000);

  it("exposes generated request body and rate-limit policy metadata", () => {
    expect(ChalkOperationPolicies.createRoom).toEqual({
      maxBodyBytes: 1_048_576,
      rateLimit: {
        limit: 60,
        policy: "v1.authenticated.write",
        windowSeconds: 60,
      },
    });
  });
});
