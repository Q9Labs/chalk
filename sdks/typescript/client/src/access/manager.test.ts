import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { ConnectionAccessService, makeConnectionAccessLayer } from "./manager";
import type { ParsedAccessGrant } from "./grant";
import { ACCESS_SUBJECT, accessGrant } from "./grant.test.helpers";

const START = Date.parse("2026-07-21T12:00:00.000Z");
describe("ConnectionAccessService", () => {
  it("uses TestClock for the R1 refresh window and supplies the current media proof", async () => {
    const first = accessGrant(START + 61_000, "first", "connection-1");
    const second = accessGrant(START + 300_000, "second", "connection-1");
    const requests: unknown[] = [];
    const harness = accessHarness((request) =>
      Effect.sync(() => {
        requests.push(request);
        return requests.length === 1 ? first : second;
      }),
    );

    await expect(harness.initialize()).resolves.toEqual(first);
    await harness.runtime.runPromise(TestClock.adjust(1_000));
    await expect(harness.runtime.runPromise(harness.service.getMediaToken())).resolves.toEqual(second.media.token);
    expect(requests[1]).toEqual({ reason: "scheduled_refresh", replaceMediaConnection: false, currentMediaToken: first.media.token, expectedParticipantGeneration: 1 });

    await harness.runtime.dispose();
  });

  it("keeps a RealtimeKit refresh bound to the provider subject", async () => {
    const first = rtkAccessGrant(START + 61_000, "first", "participant-ref");
    const second = rtkAccessGrant(START + 300_000, "second", "participant-ref");
    const harness = accessHarness((request) => Effect.succeed(request.currentMediaToken === undefined ? first : second));

    await harness.initialize();
    await harness.runtime.runPromise(TestClock.adjust(1_000));
    await expect(harness.runtime.runPromise(harness.service.getMediaToken())).resolves.toEqual(second.media.token);

    await harness.runtime.dispose();
  });

  it("rejects a RealtimeKit refresh that changes the provider subject", async () => {
    const first = rtkAccessGrant(START + 300_000, "first", "participant-ref");
    const changed = rtkAccessGrant(START + 300_000, "second", "other-participant-ref");
    let calls = 0;
    const harness = accessHarness(() => Effect.sync(() => (calls++ === 0 ? first : changed)));

    await expectRefreshRejected(harness);
  });

  it("rejects a refresh that changes identity or replaces media outside recovery", async () => {
    const first = accessGrant(START + 300_000, "first", "connection-1");
    const changed = { ...accessGrant(START + 300_000, "second", "connection-2"), subject: { ...ACCESS_SUBJECT, participantId: "participant-2" } };
    let calls = 0;
    const harness = accessHarness(() => Effect.sync(() => (calls++ === 0 ? first : changed)));

    await expectRefreshRejected(harness);
  });

  it("replaces the media connection after access is rejected", async () => {
    const first = accessGrant(START + 300_000, "first", "connection-1");
    const replacement = accessGrant(START + 300_000, "replacement", "connection-2");
    const requests: unknown[] = [];
    const harness = accessHarness((request) =>
      Effect.sync(() => {
        requests.push(request);
        return requests.length === 1 ? first : replacement;
      }),
    );

    await harness.initialize();
    await expect(harness.runtime.runPromise(harness.service.refreshAfterRejection())).resolves.toEqual(replacement);
    expect(requests[1]).toEqual({ reason: "access_retry", replaceMediaConnection: true, currentMediaToken: first.media.token, expectedParticipantGeneration: 1 });

    await harness.runtime.dispose();
  });

  it("replaces one expired Join grant before publishing it", async () => {
    let calls = 0;
    const harness = accessHarness(() => Effect.sync(() => (calls++ === 0 ? accessGrant(START - 1, "expired", "connection-1") : accessGrant(START + 300_000, "fresh", "connection-1"))));

    await expect(harness.initialize()).resolves.toMatchObject({ media: { clientPayload: { connectionId: "connection-1" } } });
    expect(calls).toBe(2);

    await harness.runtime.dispose();
  });
});

function runtimeFor(provider: Parameters<typeof makeConnectionAccessLayer>[0]) {
  return ManagedRuntime.make(makeConnectionAccessLayer(provider).pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 hour" }))));
}

function accessHarness(provider: Parameters<typeof makeConnectionAccessLayer>[0]) {
  const runtime = runtimeFor(provider);
  const service = runtime.runSync(Effect.service(ConnectionAccessService));
  return {
    runtime,
    service,
    initialize: async () => {
      await runtime.runPromise(TestClock.setTime(START));
      return runtime.runPromise(service.initialize());
    },
  };
}

async function expectRefreshRejected(harness: ReturnType<typeof accessHarness>): Promise<void> {
  await harness.initialize();
  await expect(harness.runtime.runPromise(harness.service.refresh("scheduled_refresh", false))).rejects.toMatchObject({ _tag: "ConnectionAccessFailure", code: "access.invalid" });
  await harness.runtime.dispose();
}

function rtkAccessGrant(expiresAt: number, suffix: string, providerSubject: string): ParsedAccessGrant {
  const grant = accessGrant(expiresAt, suffix);
  return {
    ...grant,
    media: {
      ...grant.media,
      provider: "cloudflare_rtk",
      clientPayload: { providerSubject, token: `rtk-${suffix}` },
    },
  };
}
