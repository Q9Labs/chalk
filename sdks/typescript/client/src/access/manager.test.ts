import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionAccessRequest } from "../connection/dependencies";
import type { ParsedAccessGrant } from "./grant";
import { ConnectionAccessService, makeConnectionAccessLayer } from "./manager";
import { accessGrant } from "./grant.test.helpers";

describe("ConnectionAccessService", () => {
  it("serializes one replacement when the current media access has expired", async () => {
    const requests: ConnectionAccessRequest[] = [];
    const automaticReplacements: ParsedAccessGrant[] = [];
    const initial = accessGrant(1_000, "initial", "connection-1");
    const replacement = accessGrant(10_000, "replacement", "connection-2");
    const provider = (request: ConnectionAccessRequest) => {
      requests.push(request);
      return Effect.succeed(request.replaceMediaConnection ? replacement : initial);
    };
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      yield* service.subscribeAutomaticMediaReplacement((access) => automaticReplacements.push(access));
      yield* service.initialize();
      yield* TestClock.adjust("1 second");
      const [left, right] = yield* Effect.all([service.ensureFresh("sync_recovery"), service.ensureFresh("sync_recovery")], { concurrency: "unbounded" });
      return { left, right };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(provider, 0)), Effect.provide(TestClock.layer())));

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ replaceMediaConnection: true, expectedParticipantGeneration: 1 });
    expect(automaticReplacements).toEqual([replacement]);
    expect(result.left.media.clientPayload.connectionId).toBe("connection-2");
    expect(result.right.media.clientPayload.connectionId).toBe("connection-2");
  });

  it("rejects a replacement that keeps the expired media binding", async () => {
    const initial = accessGrant(1_000, "initial", "connection-1");
    const provider = (request: ConnectionAccessRequest) => Effect.succeed(request.replaceMediaConnection ? accessGrant(10_000, "replacement", "connection-1") : initial);
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      yield* service.initialize();
      yield* TestClock.adjust("1 second");
      return yield* service.ensureFresh("sync_recovery").pipe(Effect.flip);
    });

    const failure = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(provider, 0)), Effect.provide(TestClock.layer())));

    expect(failure.code).toBe("access.invalid");
  });

  it("accepts a replacement that changes media provider", async () => {
    const initial = accessGrant(1_000, "initial", "connection-1");
    const replacement = rtkAccessGrant(10_000, "replacement", "participant-ref-2");
    const provider = (request: ConnectionAccessRequest) => Effect.succeed(request.replaceMediaConnection ? replacement : initial);
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      yield* service.initialize();
      yield* TestClock.adjust("1 second");
      return yield* service.ensureFresh("sync_recovery");
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(provider, 0)), Effect.provide(TestClock.layer())));

    expect(result.media.provider).toBe("cloudflare_rtk");
  });

  it("rejects an ordinary refresh that changes media provider", async () => {
    const initial = accessGrant(10_000, "initial", "connection-1");
    const replacement = rtkAccessGrant(10_000, "replacement", "participant-ref-2");
    let requests = 0;
    const provider = (_request: ConnectionAccessRequest) => Effect.succeed(requests++ === 0 ? initial : replacement);
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      yield* service.initialize();
      return yield* service.refresh("scheduled_refresh", false).pipe(Effect.flip);
    });

    const failure = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(provider, 0)), Effect.provide(TestClock.layer())));

    expect(failure.code).toBe("access.invalid");
  });
});

function rtkAccessGrant(expiresAt: number, suffix: string, providerSubject: string): ParsedAccessGrant {
  const base = accessGrant(expiresAt, suffix);
  return {
    subject: base.subject,
    sync: base.sync,
    media: {
      token: base.media.token,
      expiresAt: base.media.expiresAt,
      provider: "cloudflare_rtk",
      clientPayload: { providerSubject, token: `rtk-${suffix}` },
    },
  };
}
