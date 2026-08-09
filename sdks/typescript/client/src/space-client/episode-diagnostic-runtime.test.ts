import { describe, expect, it, vi } from "vitest";
import { EpisodeDiagnosticRuntime, type EpisodeDiagnosticCredential, type EpisodeDiagnosticExporter } from "./episode-diagnostic-runtime";

const NOW = Date.parse("2026-08-04T10:00:00.000Z");

describe("EpisodeDiagnosticRuntime", () => {
  it("is a permanent no-op for a grant without a diagnostic credential", () => {
    const runtime = makeRuntime().runtime;

    expect(runtime.startOperation("chat.send", { count: 1 })).toBeUndefined();
    runtime.observe({ name: "chat.send", phase: "intent", state: "started", attributes: { count: 1 } });

    expect(runtime.inspect()).toMatchObject({ ring: [], queue: [], credentialGeneration: null });
  });

  it("strictly redacts content and preserves only allowlisted safe metadata", () => {
    const { runtime } = makeRuntime();
    runtime.rotateCredential(credential(1));

    runtime.observe({
      name: "chat.send",
      phase: "intent",
      state: "started",
      attributes: {
        count: 2,
        text: "private message",
        filename: "roadmap.pdf",
        response_class: "accepted",
        reason: "https://private.example.test/value",
        arbitrary: "not allowlisted",
      },
    });

    expect(runtime.inspect().ring[0]?.attributes).toEqual({ count: 2, response_class: "accepted" });
    expect(JSON.stringify(runtime.inspect().ring)).not.toContain("private message");
    expect(JSON.stringify(runtime.inspect().ring)).not.toContain("roadmap.pdf");
    expect(JSON.stringify(runtime.inspect().ring)).not.toContain("private.example.test");
  });

  it("bounds ring and queue by count and emits a gap after overflow", () => {
    const { runtime } = makeRuntime({ maxRingEvents: 3, maxQueueEvents: 2 });
    runtime.rotateCredential(credential(1));

    for (let count = 1; count <= 5; count += 1) {
      runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { count } });
    }

    const snapshot = runtime.inspect();
    expect(snapshot.ring.length).toBeLessThanOrEqual(3);
    expect(snapshot.queue.length).toBeLessThanOrEqual(2);
    expect(snapshot.ring.some((event) => event.name === "coverage.gap")).toBe(true);
  });

  it("bounds retained observations by encoded bytes and age", () => {
    let now = NOW;
    const { runtime } = makeRuntime({ now: () => now, maxRingBytes: 1_100, maxQueueBytes: 1_100, maxRingAgeMs: 10, maxQueueAgeMs: 10 });
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "a".repeat(200) } });
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "b".repeat(200) } });

    expect(runtime.inspect().queue.length).toBeLessThan(2);
    now += 11;
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { count: 1 } });

    expect(runtime.inspect().ring.some((event) => event.attributes?.response_class === "a".repeat(200))).toBe(false);
    expect(runtime.inspect().ring.some((event) => event.name === "coverage.gap")).toBe(true);
  });

  it("rotates delivery authority and never exports with the replaced credential", async () => {
    const { runtime, timers, calls } = recordingRuntime();
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "participant.join", phase: "observed", state: "observed", attributes: { status: "authorized" } });
    runtime.rotateCredential(credential(2));

    await flushRecorded(timers, calls);

    expect(calls[0]?.token).toBe(credential(2).token);
    expect(calls[0]?.body.producer).toMatchObject({ id: "sdk", generation: 2 });
    expect(calls[0]?.endpoint).toBe("https://api.chalk.test/_internal/episode-diagnostic-events");
  });

  it("ignores stale generations and retains local evidence when delivery authority is removed", () => {
    const { runtime } = makeRuntime();
    runtime.rotateCredential(credential(2));
    runtime.observe({ name: "chat.send", phase: "intent", state: "started" });
    runtime.rotateCredential(credential(1));

    expect(runtime.inspect().credentialGeneration).toBe(2);
    runtime.rotateCredential(null);
    runtime.observe({ name: "chat.send", phase: "validation", state: "observed" });

    expect(runtime.startOperation("chat.send")).toBeUndefined();
    expect(runtime.inspect()).toMatchObject({ credentialGeneration: null });
    expect(runtime.inspect().ring).toHaveLength(1);
    expect(runtime.inspect().queue).toHaveLength(1);
  });

  it("retains queued evidence after credential expiry and resumes delivery on rotation", async () => {
    let now = NOW;
    const { runtime, timers, calls } = recordingRuntime({ now: () => now, maxQueueAgeMs: 2 * 60 * 60 * 1000 });
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "authorized" } });
    now = Date.parse(credential(1).expiresAt) + 1;
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "revoked" } });

    expect(runtime.inspect().queue).toHaveLength(1);
    expect(runtime.inspect().credentialGeneration).toBeNull();

    runtime.rotateCredential({ ...credential(2), expiresAt: new Date(now + 60_000).toISOString() });
    await flushRecorded(timers, calls, 2);
    expectAuthorizedBatch(calls);
  });

  it("stops capture for invalid credentials and excludes revoked observations after reauthorization", async () => {
    const { runtime, timers, calls } = recordingRuntime();
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.send", phase: "intent", state: "started", attributes: { response_class: "authorized" } });
    runtime.rotateCredential({ ...credential(1), token: "not-a-jwt" });
    runtime.observe({ name: "chat.send", phase: "observed", state: "observed", attributes: { response_class: "revoked" } });

    expect(runtime.startOperation("chat.send")).toBeUndefined();
    expect(runtime.inspect().queue).toHaveLength(1);

    runtime.rotateCredential(credential(2));
    await flushRecorded(timers, calls);
    expectAuthorizedBatch(calls);
  });

  it("does not finish an operation after its credential generation is revoked", async () => {
    const { runtime, timers, calls } = recordingRuntime();
    runtime.rotateCredential(credential(1));
    const operation = runtime.startOperation("chat.send");
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    expect(runtime.observePromise(operation, delayed)).toBe(delayed);

    runtime.rotateCredential(null);
    operation?.observe("observed", "validation");
    operation?.notObservable("recipient_projection", "recipient_not_connected");
    operation?.succeed();
    runtime.rotateCredential(credential(2));
    finish();
    await delayed;
    operation?.fail("late_failure");

    const operationEvents = runtime.inspect().ring.filter((event) => event.producerOperationRef === operation?.ref);
    expect(operationEvents.map((event) => event.phase)).toEqual(["intent"]);
    await flushRecorded(timers, calls);
    expect(calls[0]?.body.events.filter((event) => event.producerOperationRef === operation?.ref)).toHaveLength(1);
    expect(calls[0]?.body.events.some((event) => event.producerOperationRef === operation?.ref && event.phase !== "intent")).toBe(false);
  });

  it("aborts a blocked export and cancels its retry handle on credential removal", async () => {
    let firstSignal: AbortSignal | undefined;
    let calls = 0;
    const { runtime, timers } = makeRuntime({
      exporter: async (request) => {
        calls += 1;
        firstSignal = request.signal;
        if (calls === 1) {
          await new Promise<never>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("export aborted")), { once: true }));
        }
        return undefined;
      },
    });
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "authorized" } });
    timers.shift()?.();
    await vi.waitFor(() => expect(calls).toBe(1));

    runtime.rotateCredential(null);
    expect(firstSignal?.aborted).toBe(true);
    expect(timers).toHaveLength(0);
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { response_class: "revoked" } });

    runtime.rotateCredential(credential(2));
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    timers.shift()?.();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(runtime.inspect().queue).toHaveLength(0);
  });

  it("removes a batch only after every Event receives a durable acknowledgement", async () => {
    const fetch = intakeFetch((body) => ({
      diagnosticReference: "chalkdiag:v1:localhost:diagnostic",
      committedCursor: body.events.length,
      accepted: body.events.map((event, index) => ({ eventId: event.eventId, cursor: index + 1 })),
      duplicates: [],
      conflicts: [],
    }));
    const { runtime, timers } = makeRuntime({ exporter: undefined, fetch });
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { count: 1 } });

    timers.shift()?.();
    await vi.waitFor(() => expect(runtime.inspect().queue).toHaveLength(0));

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${credential(1).token}`);
  });

  it("accepts mixed intake outcomes and quarantines only fingerprint conflicts", async () => {
    const fetch = intakeFetch((body) => ({
      diagnosticReference: "chalkdiag:v1:localhost:diagnostic",
      committedCursor: 2,
      accepted: [{ eventId: body.events[0]?.eventId, cursor: 1 }],
      duplicates: [{ eventId: body.events[1]?.eventId, cursor: 2 }],
      conflicts: [{ eventId: body.events[2]?.eventId, code: "fingerprint_mismatch" }],
    }));
    const { runtime, timers } = makeRuntime({ exporter: undefined, fetch });
    runtime.rotateCredential(credential(1));
    for (let count = 0; count < 3; count += 1) runtime.observe({ name: "chat.page", phase: "paged", state: "observed", attributes: { count } });

    timers.shift()?.();
    await vi.waitFor(() => expect(runtime.inspect().queue).toHaveLength(0));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runtime.inspect().quarantine).toHaveLength(1);
    expect(runtime.inspect().quarantine[0]?.eventId).toBe(runtime.inspect().ring[2]?.eventId);
  });

  it("keeps operation and W3C correlation stable without changing the observed promise", async () => {
    const { runtime } = makeRuntime();
    runtime.rotateCredential(credential(1));
    const operation = runtime.startOperation("screen.start");
    const productPromise = Promise.resolve("product-result");

    const returned = runtime.observePromise(operation, productPromise);
    expect(returned).toBe(productPromise);
    await expect(returned).resolves.toBe("product-result");

    const events = runtime.inspect().ring.filter((event) => event.producerOperationRef === operation?.ref);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.producerOperationRef))).toEqual(new Set([operation?.ref]));
    expect(new Set(events.map((event) => event.correlation?.journeyId)).size).toBe(1);
    expect(events.every((event) => event.correlation?.traceId?.length === 32 && event.correlation.spanId?.length === 16)).toBe(true);
  });

  it("emits release, retry, and HMAC-safe provider correlation", () => {
    const { runtime } = makeRuntime({ release: { id: "sdk-4.0.1", sourceCommit: "abc123" } });
    runtime.rotateCredential(credential(1));
    const operation = runtime.startOperation("chat.retry", undefined, undefined, undefined, {
      retryGroupRef: "chat-group-1",
      attempt: 2,
      provider: { storage: "hmac", value: "hmac-v1-abcdef" },
    });

    expect(runtime.inspect().ring[0]).toMatchObject({
      producerOperationRef: operation?.ref,
      release: { id: "sdk-4.0.1", sourceCommit: "abc123" },
      correlation: { retryGroupRef: "chat-group-1", attempt: 2, providerId: "hmac-v1-abcdef" },
    });
  });

  it("swallows exporter failures and preserves a rejected product promise identity", async () => {
    const { runtime } = makeRuntime({ exporter: async () => Promise.reject(new Error("storage unavailable")) });
    runtime.rotateCredential(credential(1));
    const operation = runtime.startOperation("reaction.send");
    const productError = new Error("product failure");
    const productPromise = Promise.reject(productError);
    productPromise.catch(() => undefined);

    expect(runtime.observePromise(operation, productPromise)).toBe(productPromise);
    await expect(productPromise).rejects.toBe(productError);
    expect(runtime.inspect().ring.at(-1)).toMatchObject({ name: "reaction.send", state: "failed" });
  });

  it("uses a bounded retry budget and immediately exports the exhausted-delivery gap", async () => {
    let attempts = 0;
    const exporter = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("offline");
    });
    const { runtime, timers } = makeRuntime({ exporter, maxRetryAttempts: 2, retryDelayMs: 1 });
    runtime.rotateCredential(credential(1));
    runtime.observe({ name: "chat.page", phase: "paged", state: "observed" });

    timers.shift()?.();
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    timers.shift()?.();
    await vi.waitFor(() => expect(runtime.inspect().queue.some((event) => event.name === "coverage.gap")).toBe(true));

    expect(exporter).toHaveBeenCalledTimes(2);
    expect(exporter.mock.calls[0]?.[0].body.events[0]?.eventId).toBe(exporter.mock.calls[1]?.[0].body.events[0]?.eventId);
    expect(timers.length).toBeGreaterThan(0);
    expect(runtime.inspect().ring.some((event) => event.name === "coverage.gap" && event.attributes?.reason === "delivery_retry_exhausted")).toBe(true);

    timers.shift()?.();
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledTimes(3));
    expect(exporter.mock.calls[2]?.[0].body.events).toEqual([expect.objectContaining({ name: "coverage.gap", attributes: expect.objectContaining({ reason: "delivery_retry_exhausted" }) })]);
    await vi.waitFor(() => expect(runtime.inspect().queue).toHaveLength(0));
  });
});

function recordingRuntime(overrides: Partial<ConstructorParameters<typeof EpisodeDiagnosticRuntime>[0]> = {}) {
  const calls: Parameters<EpisodeDiagnosticExporter>[0][] = [];
  return { ...makeRuntime({ exporter: async (request) => void calls.push(request), ...overrides }), calls };
}

async function flushRecorded(timers: Array<() => void>, calls: readonly unknown[], timerCount = 1): Promise<void> {
  for (let index = 0; index < timerCount; index += 1) timers.shift()?.();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
}

function expectAuthorizedBatch(calls: readonly Parameters<EpisodeDiagnosticExporter>[0][]): void {
  expect(calls[0]?.body.events).toHaveLength(1);
  expect(calls[0]?.body.events[0]?.attributes).toEqual({ response_class: "authorized" });
}

function makeRuntime(overrides: Partial<ConstructorParameters<typeof EpisodeDiagnosticRuntime>[0]> = {}) {
  let id = 0;
  const timers: Array<() => void> = [];
  const runtime = new EpisodeDiagnosticRuntime({
    apiBaseUrl: "https://api.chalk.test/v1?ignored=yes",
    createId: () => `sdk-id-${++id}`,
    now: () => NOW,
    setTimeout: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
    exporter: async () => undefined,
    ...overrides,
  });
  return { runtime, timers };
}

type IntakeBody = { events: Array<{ eventId: string }> };

function intakeFetch(buildResponse: (body: IntakeBody) => Record<string, unknown>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as IntakeBody;
    return Response.json(buildResponse(body));
  });
}

function credential(generation: number): EpisodeDiagnosticCredential {
  return {
    token: jwt("chalk-diagnostics", generation),
    expiresAt: "2026-08-04T11:00:00.000Z",
    generation,
    intakePath: "/_internal/episode-diagnostic-events",
  };
}

function jwt(audience: string, generation = 1): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({ aud: audience, generation })}.signature`;
}
