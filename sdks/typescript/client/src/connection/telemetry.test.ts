import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createTestOutbox } from "../telemetry/outbox.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "./lifecycle";
import { callEndReason, createOutageClock, mediaCredential } from "./telemetry";

const facts = { removedByHost: false, episodeEndConfirmed: false, episodeEndReason: undefined, timedOut: false };

describe("callEndReason", () => {
  it.each([
    ["live", "failed", facts, "connection_lost"],
    ["joining", "failed", facts, "join_failed"],
    ["live", "left", facts, "left"],
    ["live", "left", { ...facts, removedByHost: true }, "removed"],
    ["live", "left", { ...facts, episodeEndConfirmed: true }, "episode_ended"],
    ["live", "left", { ...facts, episodeEndConfirmed: true, episodeEndReason: "time_limit" }, "time_limit"],
    ["reconnecting", "left", { ...facts, timedOut: true }, "connection_lost"],
  ] as const)("names %s to %s with %j as %s", (from, to, given, expected) => {
    expect(callEndReason(from, to, given)).toBe(expected);
  });
});

describe("outage clock", () => {
  it("times from the first begin to end, and says nothing when no outage was open", () => {
    let now = 1000;
    const clock = createOutageClock(() => now);
    expect(clock.end()).toBeUndefined();
    clock.begin();
    now = 4000;
    clock.begin();
    now = 6500;
    expect(clock.end()).toBe(5500);
    expect(clock.end()).toBeUndefined();
  });
});

it("reads the media credential of a grant, and none without one", () => {
  const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
  expect(mediaCredential(grant)).toEqual({ tenantId: grant.subject.tenantId, subject: `${grant.subject.tenantId}/${grant.subject.episodeId}/${grant.subject.participantId}`, token: grant.media.token, expiresAt: Date.parse(grant.media.expiresAt) });
  expect(mediaCredential(null)).toBeNull();
});

describe("a call tells the server how it ended", () => {
  const run = async (exercise: (lifecycle: Effect.Success<ReturnType<typeof lifecycleOf>>, outbox: ReturnType<typeof createTestOutbox>) => Effect.Effect<void, unknown>) => {
    const platform = createCoreTestPlatform();
    const telemetry = createTestOutbox({ bound: false });
    const layer = makeConnectionLifecycleLayer({
      apiBaseURL: "https://api.chalk.test",
      syncURL: "wss://sync.chalk.test/v1/sync",
      access: async () => parseParsedAccessGrant(opaqueAccessGrant(1)),
      dependencies: { ...platform.dependencies, telemetry: telemetry.outbox },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* exercise(yield* lifecycleOf(), telemetry);
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    return telemetry;
  };
  const endings = (telemetry: ReturnType<typeof createTestOutbox>) => telemetry.accepted.filter((event) => event.type === "call_ended").map((event) => event.end_reason);

  it("says left after a leave", async () => {
    const telemetry = await run((lifecycle, outbox) =>
      Effect.gen(function* () {
        yield* lifecycle.join();
        yield* lifecycle.leave();
        yield* Effect.promise(() => outbox.outbox.flush());
      }),
    );
    expect(endings(telemetry)).toEqual(["left"]);
  });

  it("says page_closed when the page goes away in a call, and only then", async () => {
    const telemetry = await run((lifecycle, outbox) =>
      Effect.gen(function* () {
        outbox.emit("closing");
        yield* lifecycle.join();
        outbox.emit("closing");
        yield* Effect.promise(() => outbox.outbox.flush());
      }),
    );
    expect(endings(telemetry)).toEqual(["page_closed", "left"]);
    expect(telemetry.requests.every((request) => request.send.keepalive)).toBe(true);
  });

  it("sends the end of a call at once on leave, with keepalive, without waiting for a timer or a flush", async () => {
    let sentAtLeave: readonly (string | undefined)[] = [];
    let keepalive = false;
    await run((lifecycle, outbox) =>
      Effect.gen(function* () {
        yield* lifecycle.join();
        yield* lifecycle.leave();
        const request = outbox.requests.find((candidate) => candidate.events.some((event) => event.type === "call_ended"));
        sentAtLeave = request?.events.map((event) => event.end_reason) ?? [];
        keepalive = request?.send.keepalive ?? false;
      }),
    );
    expect(sentAtLeave).toContain("left");
    expect(keepalive).toBe(true);
  });

  it("still says left when the client is disposed in a call, because the teardown records before telemetry closes", async () => {
    const telemetry = await run((lifecycle) => lifecycle.join());
    await telemetry.outbox.flush();
    expect(endings(telemetry)).toEqual(["left"]);
    expect(telemetry.accepted.map((event) => event.seq)).toEqual([...telemetry.accepted.keys()]);
  });
});

function lifecycleOf() {
  return Effect.service(ConnectionLifecycleService);
}
