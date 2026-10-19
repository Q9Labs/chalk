import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createChalkEffectClient } from "@q9labsai/chalk-client/effect";
import { run } from "./engine";

const privateDetail = "private-response-token-email-and-name";
afterEach(() => vi.restoreAllMocks());

describe("engine failure diagnostics through the real SDK decoder", () => {
  it.each([
    { status: 503, body: JSON.stringify({ error: { code: "service.unavailable", message: privateDetail } }), expected: { engine_code: "service.unavailable" } },
    { status: 400, body: JSON.stringify({ error: { code: "request.invalid", message: privateDetail } }), expected: { engine_code: "request.invalid" } },
    { status: 502, body: privateDetail, expected: { engine_status: 502, sdk_error_tag: "HttpClientError", sdk_error_reason: "DecodeError" } },
    { status: 201, body: JSON.stringify({ unexpected: privateDetail }), expected: { sdk_error_tag: "SchemaError" } },
  ])("logs a bounded cause for a $status response without its contents", async ({ status, body, expected }) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: "https://engine.example.test", fetch: async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }) }));
    await expect(run(api.tenants.createTenant({ payload: { name: privateDetail } }))).rejects.toMatchObject({ status: 502, code: "engine_unavailable" });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dashboard.engine_failed", ...expected });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
  });

  it("logs the SDK transport tag without the network error message", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = await Effect.runPromise(
      createChalkEffectClient({
        baseUrl: "https://engine.example.test",
        fetch: async () => {
          throw new TypeError(privateDetail);
        },
      }),
    );
    await expect(run(api.tenants.createTenant({ payload: { name: privateDetail } }))).rejects.toMatchObject({ status: 502, code: "engine_unavailable" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "dashboard.engine_failed", sdk_error_tag: "HttpClientError", sdk_error_reason: "TransportError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateDetail);
  });
});
