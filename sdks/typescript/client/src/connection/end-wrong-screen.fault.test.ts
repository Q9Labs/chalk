// Fault scenario for the symptom end.wrong_screen (observability/registry/areas/end.json).
// The Episode ends while the client's end notice is lost and its status read is stale, so a media 403 is taken
// for a revoked credential and the client chooses the connection-lost screen. The test drives the real client,
// captures the call_ended event it really records, puts it in the fixture in place of the row it stands for, and judges the
// fixture the way diagnose does (scripts/diagnose-call/proof/rows.mjs), with the rule from observability/rules.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { symptom } from "../../../../../observability/rules/end.wrong_screen.mjs";
import { CATALOGUE } from "../../../../../scripts/diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../../../../../scripts/diagnose-call/proof/rows.mjs";
import { CloudflareSFUError } from "../media";
import { legacyEventName } from "../obs/legacy.ts";
import type { ConnectionDependencies, ConnectionMediaFactoryInput } from "./dependencies";
import { control, joinWithTerminalControl, terminalTestClient, terminalTestPlatform } from "../space-client/terminal.test.helpers";
import { callEndNotice } from "../space-client/call-length";
import type { TelemetryDraft } from "../telemetry/types";

type Row = { readonly event: string; readonly [field: string]: unknown };
type Fixture = Parameters<typeof judgeFixture>[0] & { readonly rows: Row[] };

const fixture = (name: "positive" | "healthy"): Fixture => JSON.parse(readFileSync(new URL(`../../../../../observability/fixtures/end.wrong_screen/${name}.json`, import.meta.url), "utf8"));

const judged = (input: Fixture) => {
  const { verdict, dropped } = judgeFixture(input, CATALOGUE, symptom);
  expect(dropped).toEqual([]);
  return { verdict, ...ruleResult(verdict, symptom) };
};

// The fixture with its client row that ended like the draft replaced by the row the client really recorded.
function withRecorded(name: "positive" | "healthy", draft: TelemetryDraft | undefined): Fixture {
  const input = fixture(name);
  if (input.declaration.kind !== "episode") throw new Error("the fault fixture must describe an Episode");
  const firstSeat = input.declaration.seats[0]?.participant;
  const index = input.rows.findIndex((row) => row.event === "client.call_ended" && row.participant_id === firstSeat);
  const like = input.rows[index];
  if (!draft || !like) throw new Error(`the ${name} fixture needs the first seat's terminal record`);
  return { ...input, rows: input.rows.map((row, at) => (at === index ? clientRow(draft, like) : row)) };
}

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
function clientRow(draft: TelemetryDraft, like: Row): Row {
  const event = legacyEventName({ event: "sdk.telemetry", type: draft.type });
  if (!event) throw new Error(`no registry event for ${draft.type}`);
  return { ...like, event, end_reason: draft.end_reason, episode_end_reason: draft.episode_end_reason };
}

describe(symptom, () => {
  it("keeps Sync's maximum-duration reason through terminal settlement", async () => {
    const test = scenario("active");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.platform.emitSync({ ...test.platform.sync.getSnapshot(), control: { ...control, status: "ended", endReason: "maximum_duration", participants: [] } });
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      expect(callEndNotice(test.client.getSnapshot().connection.episodeEndReason).title).toBe("The call reached its time limit");
      const drafts = test.callEnded();
      expect(drafts).toEqual([{ type: "call_ended", end_reason: "time_limit", episode_end_reason: "maximum_duration" }]);
      expect(judged(withRecorded("healthy", drafts[0]))).toMatchObject({ findings: 0, checked: 2, eligible: 2 });
      const recorded = withRecorded("healthy", { type: "call_ended", episode_end_reason: "maximum_duration", end_reason: "episode_ended" });
      expect(judged(recorded).findings).toBe(1);
    } finally {
      test.client.dispose();
    }
  });

  it("positive: a stale active status and a lost end notice make the client show connection lost", async () => {
    const test = scenario("active");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.revokeMedia();
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("failed"));
      const [draft, ...extra] = test.callEnded();
      expect(extra).toEqual([]);
      const { verdict, findings } = judged(withRecorded("positive", draft));
      expect(findings).toBe(1);
      expect(verdict.findings.find((finding) => finding.code === symptom)).toMatchObject({ outcome: "broken", hop: "client_end", module: "sdk.connection", observed: "the Episode ended (maximum_duration) and the client showed connection_lost" });
    } finally {
      test.client.dispose();
    }
  });

  it("a current status read avoids a failure screen without proving the client knew the time limit", async () => {
    const test = scenario("ended");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      test.revokeMedia();
      await vi.waitFor(() => expect(test.ended).toHaveBeenCalledOnce());
      const [draft] = test.callEnded();
      expect(judged(withRecorded("healthy", draft))).toMatchObject({ findings: 0, checked: 1, eligible: 2 });
    } finally {
      test.client.dispose();
    }
  });

  it.each(["left", "removed"] as const)("classifies %s without claiming an Episode end", async (ending) => {
    const test = scenario("active");
    try {
      await joinWithTerminalControl(test.client, test.platform);
      if (ending === "left") await test.client.leave();
      else test.platform.emitSync({ ...test.platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "participant_removed" }, control: null });
      await vi.waitFor(() => expect(test.client.getSnapshot().connection.status).toBe("left"));
      expect(test.ended).not.toHaveBeenCalled();
      expect(test.callEnded()).toEqual([{ type: "call_ended", end_reason: ending }]);
    } finally {
      test.client.dispose();
    }
  });

  it("the fixtures agree with the rule", () => {
    expect(judged(fixture("positive")).findings).toBe(1);
    expect(judged(fixture("healthy"))).toMatchObject({ findings: 0, checked: 2, eligible: 2 });
  });

  it.each(["sync.episode.ended", "client.call_ended"])("stays unchecked without the %s witness", (missing) => {
    const healthy = fixture("healthy");
    expect(judged({ ...healthy, rows: healthy.rows.filter((row) => row.event !== missing) })).toMatchObject({ findings: 0, checked: 0, eligible: 2 });
  });
});
