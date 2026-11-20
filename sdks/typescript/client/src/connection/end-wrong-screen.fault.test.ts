// Fault scenario for the symptom end.wrong_screen (observability/registry/areas/end.json).
// The Episode ends while the client's end notice is lost and its status read is stale, so a media 403 is taken
// for a revoked credential and the client chooses the connection-lost screen. The test drives the real client,
// captures the call_ended event it really records, and checks that the rule finds the symptom in it.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, symptom } from "../../../../../observability/rules/end.wrong_screen.mjs";
import { CloudflareSFUError } from "../media";
import { legacyEventName } from "../obs/legacy.ts";
import type { ConnectionDependencies, ConnectionMediaFactoryInput } from "./dependencies";
import { joinWithTerminalControl, terminalTestClient, terminalTestPlatform } from "../space-client/terminal.test.helpers";

type Row = { readonly event: string; readonly [field: string]: unknown };

const fixture = (name: "positive" | "healthy"): readonly Row[] => JSON.parse(readFileSync(new URL(`../../../../../observability/fixtures/end.wrong_screen/${name}.json`, import.meta.url), "utf8")).rows;

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

function scenario(statusRead: "active" | "ended") {
  const base = terminalTestPlatform();
  const status = vi.fn<NonNullable<ConnectionDependencies["getEpisodeStatus"]>>().mockResolvedValue(statusRead);
  let onFailure: ConnectionMediaFactoryInput["onFailure"] = () => {};
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      getEpisodeStatus: status,
      createMediaClient: (input: ConnectionMediaFactoryInput) => {
        onFailure = input.onFailure;
        return base.dependencies.createMediaClient(input);
      },
    },
  };
  const telemetry = base.dependencies.telemetry;
  if (!telemetry) throw new Error("the test platform must supply telemetry");
  const recorded = vi.spyOn(telemetry, "record");
  const callEnded = () => recorded.mock.calls.map(([draft]) => draft).filter((draft) => draft.type === "call_ended");
  return { platform, callEnded, ...terminalTestClient(platform), revokeMedia: () => onFailure(new CloudflareSFUError("Publications rejected", "signaling_failed", { status: 403 })) };
}

// The client's row as the reader sees it: the recorded draft under its legacy name, placed where the fixture's
// client row sits in time, in the fixture's Episode.
function clientRow(draft: { readonly type: string; readonly end_reason?: string }, like: Row): Row {
  const event = legacyEventName({ event: "sdk.telemetry", type: draft.type });
  if (!event) throw new Error(`no registry event for ${draft.type}`);
  return { ...like, event, end_reason: draft.end_reason };
}

const evidence = (rows: readonly Row[]) => ({ server_end: rows.filter((row) => row.event === "sync.episode.ended"), client_end: rows.filter((row) => row.event === "client.call_ended") });

describe(symptom, () => {
  it("positive: a stale active status and a lost end notice make the client show connection lost", async () => {
    const test = scenario("active");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.revokeMedia();
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("failed"));
      const [draft, ...extra] = test.callEnded();
      expect(extra).toEqual([]);
      const rows = fixture("positive");
      const [server] = evidence(rows).server_end;
      const like = evidence(rows).client_end.find((row) => row.end_reason === draft?.end_reason);
      if (!draft || !server || !like) throw new Error(`the positive fixture has no client row ending with ${draft?.end_reason}`);
      const hits = evaluate({ server_end: [server], client_end: [clientRow(draft, like)] });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ symptom, client_end_reason: "connection_lost", server_end_reason: "maximum_duration" });
    } finally {
      test.client.dispose();
    }
  });

  it("healthy: a current status read ends the call on the Episode-ended screen", async () => {
    const test = scenario("ended");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.revokeMedia();
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      const [draft] = test.callEnded();
      const rows = fixture("healthy");
      const [server] = evidence(rows).server_end;
      const like = evidence(rows).client_end.find((row) => row.end_reason === draft?.end_reason);
      if (!draft || !server || !like) throw new Error(`the healthy fixture has no client row ending with ${draft?.end_reason}`);
      expect(evaluate({ server_end: [server], client_end: [clientRow(draft, like)] })).toEqual([]);
    } finally {
      test.client.dispose();
    }
  });

  it("the fixtures agree with the rule", () => {
    expect(evaluate(evidence(fixture("positive")))).toHaveLength(1);
    expect(evaluate(evidence(fixture("healthy")))).toEqual([]);
  });
});
