import { describe, expect, it } from "vitest";
import { reportAssignmentFailure } from "../src/transcriber.js";
import { AssignmentError, ProviderError } from "../src/errors.js";
import { classifyProviderStatus, openRouterReason } from "../src/provider-failure.js";
import type { DispatcherLogger, RetryInput } from "../src/types.js";

const lease = { jobId: "job-1", attempt: 1, leaseToken: "lease-token" };
const journey = { journeyId: "journey-1" };

async function report(error: unknown) {
  const retries: RetryInput[] = [];
  const logs: Array<{ event: string; fields?: Record<string, string | number | boolean> }> = [];
  const control = { retry: async (input: RetryInput) => void retries.push(input) };
  const logger: DispatcherLogger = { info: () => undefined, warn: (event, fields) => void logs.push({ event, fields }) };
  await reportAssignmentFailure(error, lease, journey, control, logger);
  return { retries, logs: logs.filter(({ event }) => event === "dispatcher_assignment_failed") };
}

describe("reporting a failed assignment", () => {
  it("logs the code, the provider status and the reason of a terminal failure, and reports it to the control plane", async () => {
    const { retries, logs } = await report(new ProviderError("OpenRouter request failed", "nonretryable", { status: 402 }));
    expect(retries).toMatchObject([{ jobId: "job-1", attempt: 1, errorCode: "provider_rejected", terminal: true }]);
    expect(logs).toEqual([{ event: "dispatcher_assignment_failed", fields: { jobId: "job-1", journeyId: "journey-1", errorCode: "provider_rejected", kind: "nonretryable", terminal: true, attempt: 1, providerStatus: 402, reason: "OpenRouter request failed" } }]);
  });

  it("logs a retryable failure as not terminal", async () => {
    const { logs } = await report(new AssignmentError("chunk download failed", true));
    expect(logs[0]?.fields).toMatchObject({ errorCode: "chunk_download_retryable", terminal: false, reason: "chunk download failed" });
  });

  it("names a fixed-message error by its message and any other error only by its class", async () => {
    expect((await report(new AssignmentError("audio duration bound exceeded"))).logs[0]?.fields).toMatchObject({ errorCode: "assignment_invalid", terminal: true, reason: "audio duration bound exceeded" });
    expect((await report(new Error("PUT https://bucket.example/chunk?signature=secret failed"))).logs[0]?.fields).toMatchObject({ errorCode: "dispatcher_failure", terminal: true, reason: "Error" });
    expect((await report(new SyntaxError("Unexpected token in https://bucket.example/chunk?signature=secret"))).logs[0]?.fields).toMatchObject({ reason: "SyntaxError" });
  });

  it("retries an OpenRouter 402 after a wait, and still ends other 4xx failures", async () => {
    expect(classifyProviderStatus(402, "openrouter")).toBe("retryable");
    expect(classifyProviderStatus(402, "deepinfra")).toBe("nonretryable");
    expect(classifyProviderStatus(401, "openrouter")).toBe("nonretryable");
    const before = Date.now();
    const { retries, logs } = await report(new ProviderError("OpenRouter request failed", classifyProviderStatus(402, "openrouter"), { status: 402 }));
    expect(retries).toMatchObject([{ attempt: 1, terminal: false }]);
    expect(Date.parse(retries[0]?.retryAt ?? "")).toBeGreaterThanOrEqual(before + 20_000);
    expect(logs[0]?.fields).toMatchObject({ providerStatus: 402, kind: "retryable", terminal: false });
    const named = await report(new ProviderError("OpenRouter request failed", "retryable", { status: 402, providerCode: "in_flight_budget_exhausted" }));
    expect(named.logs[0]?.fields).toMatchObject({ providerReason: "in_flight_budget_exhausted" });
    const numeric = await report(new ProviderError("Cloudflare request failed", "retryable", { status: 408, providerCode: "3007" }));
    expect(numeric.logs[0]?.fields).toMatchObject({ providerReason: "3007" });
    const echoed = await report(new ProviderError("DeepInfra request failed", "nonretryable", { status: 400, providerCode: "Bearer sk-secret echoed" }));
    expect(echoed.logs[0]?.fields).not.toHaveProperty("providerReason");
    expect((await report(new ProviderError("OpenRouter request failed", "nonretryable", { status: 401 }))).retries[0]?.retryAt).toBeUndefined();
  });

  it("keeps only the short reason word from an OpenRouter error body", async () => {
    const body = (reason: unknown) => new Response(JSON.stringify({ error: { message: "free text with sk-or-v1-secret", code: 402, metadata: { reason } } }), { status: 402 });
    expect(await openRouterReason(body("in_flight_budget_exhausted"))).toBe("in_flight_budget_exhausted");
    expect(await openRouterReason(body("Contains Spaces and sk-or-v1-secret"))).toBeUndefined();
    expect(await openRouterReason(new Response("not json", { status: 402 }))).toBeUndefined();
    expect(await openRouterReason(new Response(JSON.stringify({ error: { message: "x" } }), { status: 402 }))).toBeUndefined();
  });
});
