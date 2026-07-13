import { describe, expect, it, vi } from "vitest";
import vectors from "../../../../../contract/webhooks/v1/signature-vectors.json";
import { createWebhookProcessor, toWebhookResponse } from "./processor";
import { getTestOnlyWebhookFixture, signTestOnlyWebhook, TestOnlyInMemoryWebhookInbox } from "./test";

const secret = vectors.secrets[0]!.value;
const realSetTimeout = globalThis.setTimeout;

const requestFor = async (eventName = "participant.joined", timestamp = Number(vectors.webhook_timestamp)) => {
  const fixture = getTestOnlyWebhookFixture(eventName);
  const event = JSON.parse(new TextDecoder().decode(fixture.rawBody)) as { id: string };
  return {
    rawBody: fixture.rawBody,
    headers: await signTestOnlyWebhook({ rawBody: fixture.rawBody, webhookId: event.id, timestamp, secrets: [secret] }),
  };
};

const eventIdFrom = (rawBody: Uint8Array) => (JSON.parse(new TextDecoder().decode(rawBody)) as { id: string }).id;

const unknownEventRequest = async () => {
  const fixture = getTestOnlyWebhookFixture("endpoint.test");
  const body = JSON.parse(new TextDecoder().decode(fixture.rawBody)) as Record<string, unknown>;
  body.event = "future.created";
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const headers = await signTestOnlyWebhook({ rawBody, webhookId: String(body.id), timestamp: Number(vectors.webhook_timestamp), secrets: [secret] });
  return { headers, rawBody };
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const settleBeforeObserver = async <T>(promise: Promise<T>): Promise<T> => {
  const timedOut = Symbol("timed out waiting for receiver result");
  const value = await Promise.race([promise, new Promise<typeof timedOut>((resolve) => realSetTimeout(() => resolve(timedOut), 1_000))]);
  expect(value).not.toBe(timedOut);
  if (value === timedOut) throw new Error("Receiver result was blocked by an observer.");
  return value;
};

describe("createWebhookProcessor", () => {
  it("rejects invalid lease bounds at construction", () => {
    for (const leaseMilliseconds of [0, 1.5, 300_001, Number.POSITIVE_INFINITY]) {
      expect(() => createWebhookProcessor({ secrets: [secret], inbox: new TestOnlyInMemoryWebhookInbox(), handlers: {}, leaseMilliseconds })).toThrow("Webhook leaseMilliseconds must be an integer from 1 through 300000.");
    }
  });

  it("treats invalid receiver secrets as a safe server failure", async () => {
    const malformedSecrets: unknown[] = [["whsec_private-invalid"], null, secret, { 0: secret, length: 1 }, [secret, 7]];
    for (const secrets of malformedSecrets) {
      const processor = createWebhookProcessor({
        secrets: secrets as readonly string[],
        inbox: new TestOnlyInMemoryWebhookInbox(),
        handlers: {},
        toleranceSeconds: Number.MAX_SAFE_INTEGER,
      });
      const processResult = await processor.process(await requestFor());
      expect(processResult).toEqual({ status: 500, outcome: "failed", errorCode: "invalid_secret" });
      expect(JSON.stringify(processResult)).not.toContain("private-invalid");
    }

    const providerProcessor = createWebhookProcessor({
      secrets: async () => null as unknown as readonly string[],
      inbox: new TestOnlyInMemoryWebhookInbox(),
      handlers: {},
      toleranceSeconds: Number.MAX_SAFE_INTEGER,
    });
    expect(await providerProcessor.process(await requestFor())).toEqual({ status: 500, outcome: "failed", errorCode: "invalid_secret" });
  });

  it("narrows handlers, completes once, and acknowledges completed duplicates", async () => {
    const handler = vi.fn(async (event) => {
      expect(event.event).toBe("participant.joined");
      expect(event.data.object.name).toContain("Ada");
    });
    const processor = createWebhookProcessor({ secrets: [secret], inbox: new TestOnlyInMemoryWebhookInbox(), handlers: { "participant.joined": handler }, toleranceSeconds: Number.MAX_SAFE_INTEGER });
    const request = await requestFor();
    expect(await processor.process(request)).toMatchObject({ status: 200, outcome: "processed" });
    expect(await processor.process(request)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns bounded busy responses and a content-free Web Response", async () => {
    const inbox = new TestOnlyInMemoryWebhookInbox({ now: () => 1_000 });
    const request = await requestFor();
    const event = JSON.parse(new TextDecoder().decode(request.rawBody)) as { id: string };
    await inbox.acquire({ eventId: event.id, leaseMilliseconds: 999_000 });
    const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: {}, toleranceSeconds: Number.MAX_SAFE_INTEGER });
    const processResult = await processor.process(request);
    expect(processResult).toMatchObject({ status: 503, outcome: "busy", retryAfterSeconds: 300 });
    const response = toWebhookResponse(processResult);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(await response.text()).toBe("");
  });

  it("normalizes invalid inbox retry values to safe response headers", async () => {
    const request = await requestFor();
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [Number.NEGATIVE_INFINITY, 1],
      [undefined, 1],
      [null, 1],
      ["5", 1],
      [0, 1],
      [-1, 1],
      [1.1, 2],
      [300.1, 300],
      [Number.MAX_VALUE, 300],
    ];
    for (const [retryAfterSeconds, expected] of cases) {
      const inbox = {
        acquire: async () => ({ state: "busy" as const, retryAfterSeconds: retryAfterSeconds as number }),
        complete: async () => undefined,
        release: async () => undefined,
      };
      const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: {}, toleranceSeconds: Number.MAX_SAFE_INTEGER });
      const processResult = await processor.process(request);
      expect(processResult.retryAfterSeconds).toBe(expected);
      expect(toWebhookResponse(processResult).headers.get("retry-after")).toBe(String(expected));
    }
  });

  it("releases a failed handler so a retry can process", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("private body content")).mockResolvedValue(undefined);
    const processor = createWebhookProcessor({ secrets: [secret], inbox: new TestOnlyInMemoryWebhookInbox(), handlers: { "participant.joined": handler }, toleranceSeconds: Number.MAX_SAFE_INTEGER });
    const request = await requestFor();
    expect(await processor.process(request)).toMatchObject({ status: 500, outcome: "failed", errorCode: "handler_failed" });
    expect(await processor.process(request)).toMatchObject({ status: 200, outcome: "processed" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases a known Event with no handler without completing or exposing its body", async () => {
    const request = await requestFor();
    const event = JSON.parse(new TextDecoder().decode(request.rawBody)) as { api_version: number; event: string; id: string };
    const inbox = new TestOnlyInMemoryWebhookInbox();
    const acquire = vi.spyOn(inbox, "acquire");
    const complete = vi.spyOn(inbox, "complete");
    const release = vi.spyOn(inbox, "release");
    const diagnostics: unknown[] = [];
    const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: {}, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic), toleranceSeconds: Number.MAX_SAFE_INTEGER });

    const processResult = await processor.process(request);
    expect(processResult).toEqual({
      apiVersion: event.api_version,
      errorCode: "handler_missing",
      eventId: event.id,
      eventName: event.event,
      outcome: "failed",
      status: 500,
    });
    expect(acquire).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ eventId: event.id, token: "test-lease-1" });
    expect(diagnostics).toEqual([
      { apiVersion: event.api_version, durationMilliseconds: expect.any(Number), eventId: event.id, eventName: event.event, outcome: "processed", phase: "verified" },
      { apiVersion: event.api_version, durationMilliseconds: expect.any(Number), eventId: event.id, eventName: event.event, outcome: "processed", phase: "acquired" },
      { apiVersion: event.api_version, durationMilliseconds: expect.any(Number), eventId: event.id, eventName: event.event, outcome: "failed", phase: "failed" },
    ]);
    const retryResult = await processor.process(request);
    expect(retryResult).toMatchObject({ errorCode: "handler_missing", outcome: "failed", status: 500 });
    expect(JSON.stringify({ diagnostics, processResult, retryResult })).not.toMatch(/Ada|endpoint_id|whsec_/u);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("returns a safe retryable failure when inbox completion fails", async () => {
    const inbox = new TestOnlyInMemoryWebhookInbox();
    const complete = vi.spyOn(inbox, "complete").mockRejectedValueOnce(new Error("database address"));
    const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: { "room.restored": () => undefined }, toleranceSeconds: Number.MAX_SAFE_INTEGER });
    const processResult = await processor.process(await requestFor("room.restored"));
    expect(processResult).toMatchObject({ status: 500, outcome: "failed", errorCode: "inbox_complete_failed" });
    expect(JSON.stringify(processResult)).not.toContain("database address");
    expect(complete).toHaveBeenCalledOnce();
    expect((await processor.process(await requestFor("room.restored"))).outcome).toBe("busy");
  });

  it("recovers after lease expiry and retains completion for 30 days", async () => {
    let currentTime = 0;
    const inbox = new TestOnlyInMemoryWebhookInbox({ now: () => currentTime });
    const request = await requestFor();
    const event = JSON.parse(new TextDecoder().decode(request.rawBody)) as { id: string };
    await inbox.acquire({ eventId: event.id, leaseMilliseconds: 10_000 });
    currentTime = 10_001;
    const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: { "participant.joined": () => undefined }, toleranceSeconds: Number.MAX_SAFE_INTEGER });
    expect((await processor.process(request)).outcome).toBe("processed");
    currentTime += 30 * 24 * 60 * 60 * 1_000 - 1;
    expect((await processor.process(request)).outcome).toBe("duplicate");
  });

  it("acknowledges an authenticated unknown Event and emits bounded diagnostics", async () => {
    const request = await unknownEventRequest();
    const onUnknownEvent = vi.fn(() => {
      throw new Error("observer unavailable");
    });
    const diagnostics: unknown[] = [];
    const processor = createWebhookProcessor({
      secrets: [secret],
      inbox: new TestOnlyInMemoryWebhookInbox(),
      handlers: {},
      onUnknownEvent,
      onDiagnostic: (event) => diagnostics.push(event),
      toleranceSeconds: Number.MAX_SAFE_INTEGER,
    });
    expect(await processor.process(request)).toMatchObject({ status: 200, outcome: "ignored" });
    expect(onUnknownEvent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics)).not.toContain("endpoint_id");
    expect(JSON.stringify(diagnostics)).not.toContain("whsec_");
  });

  it("never lets a pending diagnostic observer block results or inbox transitions", async () => {
    vi.useFakeTimers();
    try {
      const pendingDiagnostic = deferred<void>();
      const diagnostic = vi.fn(() => pendingDiagnostic.promise);
      const request = await requestFor();
      const eventId = eventIdFrom(request.rawBody);

      const processedInbox = new TestOnlyInMemoryWebhookInbox();
      const processedAcquire = vi.spyOn(processedInbox, "acquire");
      const processedComplete = vi.spyOn(processedInbox, "complete");
      const processedRelease = vi.spyOn(processedInbox, "release");
      const processed = createWebhookProcessor({ secrets: [secret], inbox: processedInbox, handlers: { "participant.joined": () => undefined }, onDiagnostic: diagnostic, toleranceSeconds: Number.MAX_SAFE_INTEGER });
      expect(await settleBeforeObserver(processed.process(request))).toMatchObject({ status: 200, outcome: "processed" });
      expect([processedAcquire.mock.calls.length, processedComplete.mock.calls.length, processedRelease.mock.calls.length]).toEqual([1, 1, 0]);

      const duplicateInbox = new TestOnlyInMemoryWebhookInbox();
      const duplicateClaim = await duplicateInbox.acquire({ eventId, leaseMilliseconds: 30_000 });
      if (duplicateClaim.state !== "acquired") throw new Error("Test setup failed to acquire duplicate lease.");
      await duplicateInbox.complete({ eventId, token: duplicateClaim.token });
      const duplicateAcquire = vi.spyOn(duplicateInbox, "acquire");
      const duplicateComplete = vi.spyOn(duplicateInbox, "complete");
      const duplicateRelease = vi.spyOn(duplicateInbox, "release");
      const duplicate = createWebhookProcessor({ secrets: [secret], inbox: duplicateInbox, handlers: {}, onDiagnostic: diagnostic, toleranceSeconds: Number.MAX_SAFE_INTEGER });
      expect(await settleBeforeObserver(duplicate.process(request))).toMatchObject({ status: 200, outcome: "duplicate" });
      expect([duplicateAcquire.mock.calls.length, duplicateComplete.mock.calls.length, duplicateRelease.mock.calls.length]).toEqual([1, 0, 0]);

      const busyInbox = new TestOnlyInMemoryWebhookInbox();
      await busyInbox.acquire({ eventId, leaseMilliseconds: 30_000 });
      const busyAcquire = vi.spyOn(busyInbox, "acquire");
      const busyComplete = vi.spyOn(busyInbox, "complete");
      const busyRelease = vi.spyOn(busyInbox, "release");
      const busy = createWebhookProcessor({ secrets: [secret], inbox: busyInbox, handlers: {}, onDiagnostic: diagnostic, toleranceSeconds: Number.MAX_SAFE_INTEGER });
      expect(await settleBeforeObserver(busy.process(request))).toMatchObject({ status: 503, outcome: "busy" });
      expect([busyAcquire.mock.calls.length, busyComplete.mock.calls.length, busyRelease.mock.calls.length]).toEqual([1, 0, 0]);

      const rejectedInbox = new TestOnlyInMemoryWebhookInbox();
      const rejectedAcquire = vi.spyOn(rejectedInbox, "acquire");
      const rejectedComplete = vi.spyOn(rejectedInbox, "complete");
      const rejectedRelease = vi.spyOn(rejectedInbox, "release");
      const rejected = createWebhookProcessor({ secrets: [secret], inbox: rejectedInbox, handlers: {}, onDiagnostic: diagnostic, toleranceSeconds: Number.MAX_SAFE_INTEGER });
      const tamperedRequest = { ...request, rawBody: request.rawBody.slice() };
      tamperedRequest.rawBody[0] = tamperedRequest.rawBody[0] === 123 ? 91 : 123;
      expect(await settleBeforeObserver(rejected.process(tamperedRequest))).toMatchObject({ status: 401, outcome: "rejected", errorCode: "invalid_signature" });
      expect([rejectedAcquire.mock.calls.length, rejectedComplete.mock.calls.length, rejectedRelease.mock.calls.length]).toEqual([0, 0, 0]);

      const failedInbox = new TestOnlyInMemoryWebhookInbox();
      const failedAcquire = vi.spyOn(failedInbox, "acquire");
      const failedComplete = vi.spyOn(failedInbox, "complete");
      const failedRelease = vi.spyOn(failedInbox, "release");
      const failed = createWebhookProcessor({
        secrets: [secret],
        inbox: failedInbox,
        handlers: { "participant.joined": async () => Promise.reject(new Error("handler unavailable")) },
        onDiagnostic: diagnostic,
        toleranceSeconds: Number.MAX_SAFE_INTEGER,
      });
      expect(await settleBeforeObserver(failed.process(request))).toMatchObject({ status: 500, outcome: "failed", errorCode: "handler_failed" });
      expect([failedAcquire.mock.calls.length, failedComplete.mock.calls.length, failedRelease.mock.calls.length]).toEqual([1, 0, 1]);
      expect(diagnostic).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges unknown Events without awaiting the forward-compatibility observer", async () => {
    vi.useFakeTimers();
    try {
      const request = await unknownEventRequest();
      const inbox = new TestOnlyInMemoryWebhookInbox();
      const acquire = vi.spyOn(inbox, "acquire");
      const complete = vi.spyOn(inbox, "complete");
      const release = vi.spyOn(inbox, "release");
      const pendingObserver = deferred<void>();
      const observer = vi.fn(() => pendingObserver.promise);
      const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: {}, onUnknownEvent: observer, toleranceSeconds: Number.MAX_SAFE_INTEGER });

      expect(await settleBeforeObserver(processor.process(request))).toMatchObject({ status: 200, outcome: "ignored" });
      expect(observer).toHaveBeenCalledOnce();
      expect([acquire.mock.calls.length, complete.mock.calls.length, release.mock.calls.length]).toEqual([1, 1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains synchronous diagnostic throws and asynchronous rejections", async () => {
    let calls = 0;
    const onDiagnostic = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("synchronous observer failure");
      return Promise.reject(new Error("asynchronous observer failure"));
    });
    const inbox = new TestOnlyInMemoryWebhookInbox();
    const processor = createWebhookProcessor({ secrets: [secret], inbox, handlers: { "participant.joined": () => undefined }, onDiagnostic, toleranceSeconds: Number.MAX_SAFE_INTEGER });

    expect(await processor.process(await requestFor())).toMatchObject({ status: 200, outcome: "processed" });
    await Promise.resolve();
    expect(onDiagnostic).toHaveBeenCalledTimes(4);
  });

  it("still awaits typed handlers before completing the inbox lease", async () => {
    const handlerStarted = deferred<void>();
    const handlerCompletion = deferred<void>();
    const inbox = new TestOnlyInMemoryWebhookInbox();
    const complete = vi.spyOn(inbox, "complete");
    const processor = createWebhookProcessor({
      secrets: [secret],
      inbox,
      handlers: {
        "participant.joined": () => {
          handlerStarted.resolve();
          return handlerCompletion.promise;
        },
      },
      toleranceSeconds: Number.MAX_SAFE_INTEGER,
    });

    const processing = processor.process(await requestFor());
    await handlerStarted.promise;
    expect(complete).not.toHaveBeenCalled();
    handlerCompletion.resolve();
    expect(await processing).toMatchObject({ status: 200, outcome: "processed" });
    expect(complete).toHaveBeenCalledOnce();
  });
});
