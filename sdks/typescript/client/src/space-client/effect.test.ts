import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createEffectSpaceClient } from "./effect";

describe("Effect SpaceClient entry", () => {
  it("constructs through an Effect", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({
            space: "demo",
            getAccess: async () => {
              throw new Error("not joined");
            },
          });
          expect(client.getSnapshot().connection.status).toBe("idle");
        }),
      ),
    );
  });

  it("closes its child scope with the caller scope", async () => {
    const unsubscribeForeground = vi.fn();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createEffectSpaceClient({ space: "demo", getAccess: async () => Promise.reject(new Error("not joined")) }, { whiteboardUrl: null, dependencies: { subscribeForeground: () => unsubscribeForeground } });
        }),
      ),
    );

    expect(unsubscribeForeground).toHaveBeenCalledOnce();
  });

  it("keeps explicit disposal scoped and idempotent", async () => {
    const unsubscribeForeground = vi.fn();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* createEffectSpaceClient({ space: "demo", getAccess: async () => Promise.reject(new Error("not joined")) }, { whiteboardUrl: null, dependencies: { subscribeForeground: () => unsubscribeForeground } });
          yield* client.dispose();
          yield* client.dispose();
        }),
      ),
    );

    expect(unsubscribeForeground).toHaveBeenCalledOnce();
  });
});
