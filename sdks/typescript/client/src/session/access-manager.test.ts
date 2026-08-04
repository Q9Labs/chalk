import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { ConnectionAccessService, makeConnectionAccessLayer } from "./access-manager";
import { ACCESS_SUBJECT, accessGrant } from "./access-grant.test.helpers";

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

  it("rejects a refresh that changes identity or replaces media outside recovery", async () => {
    const first = accessGrant(START + 300_000, "first", "connection-1");
    const changed = { ...accessGrant(START + 300_000, "second", "connection-2"), subject: { ...ACCESS_SUBJECT, participantId: "participant-2" } };
    let calls = 0;
    const harness = accessHarness(() => Effect.sync(() => (calls++ === 0 ? first : changed)));

    await harness.initialize();
    await expect(harness.runtime.runPromise(harness.service.refresh("scheduled_refresh", false))).rejects.toMatchObject({ _tag: "ConnectionAccessFailure", code: "access.invalid" });

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
