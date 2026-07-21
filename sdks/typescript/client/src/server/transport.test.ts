import { describe, expect, it, vi } from "vitest";
import { ChalkAPIError } from "./errors";
import { createServerRequester } from "./transport";

const options = {
  apiBaseURL: "https://api.example.test/base/",
  apiKey: "chalk_sk_test.secret",
  headers: { Authorization: "Bearer replaced", "x-customer": "customer" },
  telemetry: {
    journeyId: "journey",
    rootJourneyId: "journey",
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    tracestate: "chalk=test",
  },
  tenantId: "tenant",
} as const;

describe("server transport", () => {
  it("retries transport failures twice for safe operations and maps an empty success", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const request = createServerRequester(options, options.apiKey, options.apiBaseURL, fetch);

    await expect(request<void>({ expectedStatus: 204, method: "DELETE", path: "/v1/resource", retry: "always" })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[2]!;
    expect(String(url)).toBe("https://api.example.test/base/v1/resource");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${options.apiKey}`);
    expect(headers.get("x-chalk-journey-id")).toBe("journey");
    expect(headers.get("traceparent")).toBe(options.telemetry.traceparent);
    expect(headers.get("tracestate")).toBe("chalk=test");
  });

  it("creates an idempotency key but does not retry when the caller omitted one", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "service_unavailable" } }), { status: 503 }));
    const request = createServerRequester(options, options.apiKey, options.apiBaseURL, fetch);

    await expect(request({ body: { value: true }, expectedStatus: 201, method: "POST", path: "/v1/resource", retry: "caller_idempotency" })).rejects.toMatchObject({ code: "service_unavailable", retryable: true, status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(headers.get("content-type")).toBe("application/json");
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"value":true}');
  });

  it("preserves one caller key across transient response retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const request = createServerRequester(options, options.apiKey, options.apiBaseURL, fetch);

    await expect(request({ expectedStatus: 200, idempotency: { idempotencyKey: "stable-key" }, method: "POST", path: "/v1/resource", retry: "caller_idempotency" })).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("idempotency-key"))).toEqual(["stable-key", "stable-key"]);
  });

  it("maps malformed success JSON to a sanitized non-retryable error", async () => {
    const fetch = vi.fn(async () => new Response("not-json chalk_sk_leak", { status: 200, headers: { "x-request-id": "request-safe" } }));
    const request = createServerRequester(options, options.apiKey, options.apiBaseURL, fetch);

    let failure: unknown;
    try {
      await request({ expectedStatus: 200, method: "GET", path: "/v1/resource", retry: "always" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ChalkAPIError);
    expect(failure).toMatchObject({ code: "invalid_response", requestId: "request-safe", retryable: false, status: 200 });
    expect(String(failure)).not.toContain("chalk_sk_leak");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
