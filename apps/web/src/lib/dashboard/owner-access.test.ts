import { Clock, Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ManualClock } from "../../../../../sdks/typescript/client/tests/helpers/manual-clock";
import { parseParsedAccessGrant, requireParsedAccessGrant } from "../../../../../sdks/typescript/client/src/access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../../../../../sdks/typescript/client/src/space-client/core.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "../../../../../sdks/typescript/client/src/connection/lifecycle";
import { getConnectionFailureDetail } from "../../../../../sdks/typescript/client/src/space-client/failure-detail";
import { DashboardRequestError } from "./client";
import { dashboardAccessFailure } from "./owner-access";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { label: "denial", error: new DashboardRequestError(403, "resource_not_found"), terminal: true },
  { label: "conflict", error: new DashboardRequestError(409, "engine_conflict"), terminal: true },
  { label: "5xx", error: new DashboardRequestError(502, "engine_unavailable"), terminal: false },
  { label: "network", error: new TypeError("Failed to fetch"), terminal: false },
])("classifies dashboard $label during scheduled refresh and a command using the manual-clock SDK", async ({ error, terminal }) => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const startedAt = Date.now();
  const expiresAt = new Date(startedAt + 61000).toISOString();
  const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
  const access = vi.fn(async (request?: import("../../../../../sdks/typescript/client/src/connection/dependencies").ConnectionAccessRequest) => {
    if (request?.reason === "join") return { ...grant, sync: { ...grant.sync, expiresAt }, media: { ...grant.media, expiresAt } };
    return requireParsedAccessGrant(dashboardAccessFailure(error));
  });
  const advance = async (milliseconds: number) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
      manual.advance(100);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* Effect.service(ConnectionLifecycleService);
      yield* lifecycle.join();
      yield* Effect.promise(() => advance(2000));
      const expectedCode = terminal ? "invalid_access" : "access_unavailable";
      expect(lifecycle.getDiagnostics()).toContainEqual(expect.objectContaining({ event: "access_refresh_failed", code: expectedCode }));
      expect(lifecycle.getSnapshot()).toMatchObject(terminal ? { state: "failed", failure: { code: "invalid_access", recoverable: false } } : { state: "live", failure: null });
      const calls = access.mock.calls.length;
      yield* Effect.promise(() => advance(10000));
      if (terminal) expect(access).toHaveBeenCalledTimes(calls);
      else expect(access.mock.calls.length).toBeGreaterThan(calls);
      const systemClock = yield* Effect.service(Clock.Clock);
      const clock = {
        currentTimeMillisUnsafe: lifecycle.nowUnsafe,
        currentTimeMillis: Effect.sync(lifecycle.nowUnsafe),
        currentTimeNanosUnsafe: () => BigInt(lifecycle.nowUnsafe()) * 1000000n,
        currentTimeNanos: Effect.sync(() => BigInt(lifecycle.nowUnsafe()) * 1000000n),
        sleep: systemClock.sleep.bind(systemClock),
      };
      const command = vi.fn(() => Effect.succeed("sent"));
      const result = yield* Effect.result(lifecycle.runCommand(command).pipe(Effect.provideService(Clock.Clock, clock)));
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: terminal ? "invalid_state" : expectedCode } });
      expect(command).not.toHaveBeenCalled();
      if (terminal) expect(getConnectionFailureDetail({ code: "access.invalid" })).toContain("Access to this call was rejected");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        makeConnectionLifecycleLayer({
          access,
          apiBaseURL: "https://api.chalk.test",
          syncURL: "wss://sync.chalk.test/v1/sync",
          dependencies: { ...platform.dependencies, clock: { now: () => startedAt + manual.now(), setTimeout: (callback, delay) => manual.setTimeout(callback, delay), clearTimeout: (handle) => manual.clearTimeout(handle) }, getEpisodeStatus: async () => "active" },
        }),
      ),
    ),
  );
});
