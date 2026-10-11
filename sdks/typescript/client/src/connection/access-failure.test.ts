import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { requireParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform } from "../space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "./lifecycle";

describe("ConnectionLifecycle Access failure", () => {
  it.each([401, 403, 503])("preserves HTTP %s classification during initial join", async (status) => {
    const platform = createCoreTestPlatform();
    const layer = makeConnectionLifecycleLayer({
      access: () => requireParsedAccessGrant(new Response(null, { status })),
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: platform.dependencies,
    });
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        return yield* lifecycle.join().pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(failure).toMatchObject({ code: status === 503 ? "access_unavailable" : "invalid_access", recoverable: status === 503 });
  });

  it("explains a network failure during initial join without calling it a rejection", async () => {
    const platform = createCoreTestPlatform();
    const layer = makeConnectionLifecycleLayer({
      access: async () => {
        throw new TypeError("Failed to fetch");
      },
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      dependencies: platform.dependencies,
    });
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* Effect.service(ConnectionLifecycleService);
        return yield* lifecycle.join().pipe(Effect.flip);
      }).pipe(Effect.provide(layer)),
    );
    expect(failure).toMatchObject({ code: "access_unavailable", recoverable: true, message: "Could not reach the Space. Check your network and try again." });
  });
});
