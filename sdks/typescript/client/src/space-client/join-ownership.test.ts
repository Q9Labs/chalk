import { Effect, Exit, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createEffectSpaceClient } from "./effect";

it("keeps the shared join alive when its first waiter is interrupted", async () => {
  const platform = createCoreTestPlatform();
  let release = () => {};
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getAccess = vi.fn(async () => {
    await admission;
    return opaqueAccessGrant("join");
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({ space: "test", getAccess }, platform);
          const first = yield* Effect.forkScoped(client.join({ microphone: false, camera: false }));
          yield* Effect.promise(() => vi.waitFor(() => expect(getAccess).toHaveBeenCalledOnce()));
          const second = yield* Effect.forkScoped(client.join({ microphone: false, camera: false }), { startImmediately: true });
          yield* Fiber.interrupt(first);
          const third = yield* Effect.forkScoped(client.join({ microphone: false, camera: false }), { startImmediately: true });
          release();
          expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true);
          expect(Exit.isSuccess(yield* Fiber.await(third))).toBe(true);
          expect(getAccess).toHaveBeenCalledOnce();
          expect(client.getSnapshot().connection.status).toBe("live");
        }),
      ),
    );
  } finally {
    release();
  }
});

it("cancels the owned admission and all join waiters on explicit leave", async () => {
  const platform = createCoreTestPlatform();
  let release = () => {};
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getAccess = vi.fn(async () => {
    await admission;
    return opaqueAccessGrant("join");
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({ space: "test", getAccess }, platform);
          const first = yield* Effect.forkScoped(client.join({ microphone: false, camera: false }));
          yield* Effect.promise(() => vi.waitFor(() => expect(getAccess).toHaveBeenCalledOnce()));
          const second = yield* Effect.forkScoped(client.join({ microphone: false, camera: false }), { startImmediately: true });
          yield* client.leave();
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
          expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
          release();
          yield* client.join({ microphone: false, camera: false });
          expect(getAccess).toHaveBeenCalledTimes(2);
          expect(client.getSnapshot().connection.status).toBe("live");
        }),
      ),
    );
  } finally {
    release();
  }
});
