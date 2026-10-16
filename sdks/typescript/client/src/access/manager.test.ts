import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { ConnectionAccessRequest } from "../connection/dependencies";
import type { ParsedAccessGrant } from "./grant";
import { ConnectionAccessService, makeConnectionAccessLayer } from "./manager";
import { accessGrant } from "./grant.test.helpers";

describe("ConnectionAccessService", () => {
  it("classifies an initial provider timeout as unavailable", async () => {
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      const pending = yield* Effect.forkChild(service.initialize().pipe(Effect.flip));
      yield* TestClock.adjust("7 seconds");
      return yield* Fiber.join(pending);
    });
    const failure = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(() => Effect.never)), Effect.provide(TestClock.layer())));
    expect(failure.code).toBe("access.unavailable");
  });

  it("releases a stalled access refresh so a later request can proceed", async () => {
    let requests = 0;
    const provider = () => (requests++ === 0 ? Effect.never : Effect.succeed(accessGrant(30_000, "replacement", "connection-2")));
    const program = Effect.gen(function* () {
      const service = yield* ConnectionAccessService;
      const stalled = yield* Effect.forkChild(service.initialize(), { startImmediately: true });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("7 seconds");
      const failure = yield* Fiber.join(stalled).pipe(Effect.flip);
      const next = yield* service.initialize();
      return { failure, next };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(makeConnectionAccessLayer(provider)), Effect.provide(TestClock.layer())));

    expect(result.failure.code).toBe("access.unavailable");
    expect(result.next.media.clientPayload.connectionId).toBe("connection-2");
    expect(requests).toBe(2);
  });

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
});
