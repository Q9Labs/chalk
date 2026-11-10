import { describe, expect, it } from "vitest";
import { reportAssignmentFailure } from "../src/dispatcher.js";
import { AssignmentError, ProviderError } from "../src/errors.js";
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
    expect(logs).toEqual([{ event: "dispatcher_assignment_failed", fields: { errorCode: "provider_rejected", kind: "nonretryable", terminal: true, attempt: 1, providerStatus: 402, reason: "OpenRouter request failed" } }]);
  });

  it("logs a retryable failure as not terminal", async () => {
    const { logs } = await report(new AssignmentError("chunk download failed", true));
    expect(logs[0]?.fields).toMatchObject({ errorCode: "chunk_download_retryable", terminal: false, reason: "chunk download failed" });
  });

  it("names a plain Error by its message and a library error only by its class", async () => {
    expect((await report(new Error("audio duration bound exceeded"))).logs[0]?.fields).toMatchObject({ errorCode: "dispatcher_failure", terminal: true, reason: "audio duration bound exceeded" });
    expect((await report(new SyntaxError("Unexpected token in https://bucket.example/chunk?signature=secret"))).logs[0]?.fields).toMatchObject({ reason: "SyntaxError" });
  });
});
