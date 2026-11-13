import { Effect } from "effect";
import { vi } from "vitest";
import { ManualClock } from "../../tests/helpers/manual-clock";
import { parseParsedAccessGrant, requireParsedAccessGrant } from "../access/grant";
import { ChalkAPIError } from "../server/errors";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import type { ConnectionAccessRequest } from "./dependencies";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer, type ConnectionLifecycleCapability } from "./lifecycle";

/** Sanitized SDK 5.2.4 report timing: the join grant's media token expires 60s after this refresh. */
export const accessRefreshedAt = 10834;

export function mediaRecoveryFixture(backoffMs?: readonly number[], conflictSource: "server" | "response" = "server") {
  const platform = createCoreTestPlatform();
  const manual = new ManualClock();
  const startedAt = Date.now();
  let binding = "connection-1";
  let generation = 1;
  const clock = { now: () => startedAt + manual.now(), setTimeout: (callback: () => void, delay: number) => manual.setTimeout(callback, delay), clearTimeout: (handle: unknown) => manual.clearTimeout(handle) };
  const mediaPhase = (phase: "live" | "recovering" | "failed") => {
    const snapshot = platform.media.getSnapshot();
    platform.media.emit({ ...snapshot, failure: phase === "failed" ? { code: "peer_connection_failed", recoverable: true } : null, connection: { ...snapshot.connection, phase } });
  };
  const restart = vi.fn(async () => {});
  const status = vi.fn<NonNullable<import("./dependencies").ConnectionDependencies["getEpisodeStatus"]>>().mockResolvedValue("active");
  const media = platform.dependencies.createMediaClient({ access: parseParsedAccessGrant(opaqueAccessGrant(1)), credential: async () => "unused", onFailure: () => {}, onScreenEnded: () => {} });
  const stopMedia = vi.spyOn(media, "stop");
  const stopSync = vi.spyOn(platform.sync, "stop");
  const createSync = vi.fn(platform.dependencies.createSyncClient);
  let failMedia: (cause: unknown, binding?: string) => void = () => {};
  const access = vi.fn(async (request: ConnectionAccessRequest) => {
    if (request.replaceMediaConnection && request.expectedMediaConnectionId !== undefined && request.expectedMediaConnectionId !== binding) {
      if (conflictSource === "response") return requireParsedAccessGrant(Response.json({ error: { code: "participant.connection_superseded" } }, { status: 409 }));
      throw new ChalkAPIError({ code: "participant.connection_superseded", status: 409, retryable: false });
    }
    if (request.replaceMediaConnection) binding = `connection-${++generation}`;
    const grant = opaqueAccessGrant(generation, String(generation), binding);
    const expires_at = new Date(startedAt + (request.reason === "join" ? accessRefreshedAt + 60000 : 3600000)).toISOString();
    return parseParsedAccessGrant({ ...grant, sync: { ...grant.sync, expires_at }, media: { ...grant.media, expires_at } });
  });
  return {
    startedAt,
    access,
    restart,
    status,
    stopMedia,
    stopSync,
    createSync,
    mediaPhase,
    failMedia: (cause: unknown, binding?: string) => failMedia(cause, binding),
    setBinding: (value: string) => {
      binding = value;
    },
    getBinding: () => binding,
    advanceTo: async (target: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      while (manual.now() < target) {
        manual.advance(Math.min(100, target - manual.now()));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    },
    run: (exercise: (lifecycle: ConnectionLifecycleCapability) => Promise<void>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* Effect.service(ConnectionLifecycleService);
          yield* lifecycle.join();
          yield* Effect.promise(() => exercise(lifecycle));
        }).pipe(
          Effect.scoped,
          Effect.provide(
            makeConnectionLifecycleLayer({
              access,
              recovery: { backoffMs },
              apiBaseURL: "https://api.chalk.test",
              syncURL: "wss://sync.chalk.test/v1/sync",
              dependencies: {
                ...platform.dependencies,
                clock,
                getEpisodeStatus: status,
                createSyncClient: createSync,
                createMediaClient: (input) => {
                  failMedia = input.onFailure;
                  return { ...media, restart };
                },
              },
            }),
          ),
        ),
      ),
  };
}
