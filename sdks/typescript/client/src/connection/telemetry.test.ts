import { describe, expect, it } from "vitest";
import { parseAccessGrant, parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createTestOutbox } from "../telemetry/outbox.test.helpers";
import { ConnectionLifecycleService, makeConnectionLifecycleLayer } from "./lifecycle";
import { callEndReason, telemetryCredential } from "./telemetry";

const facts = { removedByHost: false, episodeEndConfirmed: false, episodeEndReason: undefined, timedOut: false } as const;

describe("callEndReason", () => {
  it("calls the end Sync reports as maximum_duration a time limit", () => {
    expect(callEndReason("live", "left", { ...facts, episodeEndConfirmed: true, episodeEndReason: "maximum_duration" })).toBe("time_limit");
  });
});

describe("the telemetry credential of a grant", () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const token = (audience: string) => `${encode({ alg: "EdDSA" })}.${encode({ aud: audience })}.signature`;
  const withTelemetry = (telemetry: unknown) => {
    const base: Record<string, unknown> = { ...opaqueAccessGrant(1) };
    return { ...base, telemetry };
  };

  it("is preferred over the media token, for the same subject", () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const grant = parseParsedAccessGrant(withTelemetry({ token: token("chalk-telemetry"), expires_at: expiresAt }));
    expect(telemetryCredential(grant)).toEqual({ tenantId: "tenant-1", subject: "tenant-1/episode-1/participant-1", token: token("chalk-telemetry"), expiresAt: Date.parse(expiresAt) });
  });

  it("survives the opaque envelope the access manager passes around", () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const grant = parseParsedAccessGrant(parseAccessGrant(withTelemetry({ token: token("chalk-telemetry"), expires_at: expiresAt })));
    expect(grant.telemetry).toEqual({ token: token("chalk-telemetry"), expiresAt });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["of another audience", { token: token("chalk-media"), expires_at: new Date().toISOString() }],
    ["without a date", { token: token("chalk-telemetry") }],
  ])("falls back to the media token when it is %s, and the grant still parses", (_name, telemetry) => {
    const grant = parseParsedAccessGrant(withTelemetry(telemetry));
    expect(grant.telemetry).toBeUndefined();
    expect(telemetryCredential(grant)?.token).toBe(grant.media.token);
  });
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
  const endings = (telemetry: ReturnType<typeof createTestOutbox>) => telemetry.accepted.filter((event) => event.name === "client.call_ended").map((event) => event.end_reason);

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
        const request = outbox.requests.find((candidate) => candidate.events.some((event) => event.name === "client.call_ended"));
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
