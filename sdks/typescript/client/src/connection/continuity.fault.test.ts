import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../../../scripts/diagnose-call/diagnose.mjs";
import { unwrapRow } from "../../../../../scripts/diagnose-call/live/world.mjs";
import { CATALOGUE } from "../../../../../scripts/diagnose-call/proof/catalogue.mjs";
import { completeWatermarks, judgeFixture, observationsFromRows, ruleResult } from "../../../../../scripts/diagnose-call/proof/rows.mjs";
import { parseAccessGrant, parseParsedAccessGrant } from "../access/grant";
import { createCoreTestPlatform, opaqueAccessGrant } from "../space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import type { TelemetryEvent } from "../telemetry/types";
import type { ConnectionSyncFactoryInput } from "./dependencies";

const findings = {
  "access.connection_lost": { outcome: "broken", hop: "access_refresh" },
  "reconnect.dead_live": { outcome: "broken", hop: "transport_liveness" },
  "background.resume_stalled": { outcome: "degraded", hop: "resume" },
} as const;
type Symptom = keyof typeof findings;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function join({ denyRefresh = false }: { denyRefresh?: boolean } = {}) {
  const platform = createCoreTestPlatform();
  const firstExpiry = Date.now() + 65_000;
  let checkSync: ConnectionSyncFactoryInput["onLinkCheck"];
  const client = createSpaceClientForPlatform(
    {
      space: "test",
      getAccess: async () => opaqueAccessGrant(1),
    },
    {
      connectionAccess: async (request) => {
        const reason = request?.reason;
        if (denyRefresh && reason !== "join") throw new Error("Access service is unreachable");
        const grant = parseParsedAccessGrant(opaqueAccessGrant(1));
        const expires_at = new Date(reason === "join" ? firstExpiry : Date.now() + 3_600_000).toISOString();
        return parseAccessGrant({
          subject: { tenant_id: grant.subject.tenantId, space_id: grant.subject.spaceId, episode_id: grant.subject.episodeId, participant_id: grant.subject.participantId, participant_generation: grant.subject.participantGeneration },
          media: { token: grant.media.token, expires_at, provider: grant.media.provider, client_payload: grant.media.clientPayload },
          sync: { token: grant.sync.token, expires_at },
          telemetry: { token: `header.${btoa(JSON.stringify({ aud: "chalk-telemetry" })).replace(/=+$/, "")}.fixture`, expires_at: new Date(firstExpiry + 3_600_000).toISOString() },
        });
      },
      dependencies: {
        ...platform.dependencies,
        createSyncClient: (input) => {
          checkSync = input.onLinkCheck;
          return platform.dependencies.createSyncClient(input);
        },
      },
    },
  );
  await client.join({ microphone: false, camera: false });
  return {
    client,
    emit: platform.outbox.emit,
    freshContact: () => checkSync?.({ result: "verified", pingSentMono: Date.now() }),
    peer: (state: "connected" | "failed") => {
      const previous = platform.media.getSnapshot();
      platform.media.emit({ ...previous, connection: { phase: "live", peerConnectionState: state, iceConnectionState: state } });
    },
    async records(type: TelemetryEvent["type"], result: TelemetryEvent["continuity_result"]) {
      await vi.waitFor(async () => {
        await platform.outbox.outbox.flush();
        expect(platform.outbox.accepted).toContainEqual(expect.objectContaining({ type, continuity_result: result }));
      });
      return platform.outbox.accepted;
    },
  };
}

type Fixture = Parameters<typeof judgeFixture>[0];
async function runRule(code: Symptom, arm: "positive" | "healthy", events: readonly TelemetryEvent[]) {
  const input: Fixture = JSON.parse(readFileSync(new URL(`../../../../../observability/fixtures/${code}/${arm}.json`, import.meta.url), "utf8"));
  if (input.declaration.kind !== "episode") throw new Error("The fault fixture must declare an Episode");
  const affected = input.declaration.seats[0]?.participant;
  const templates = input.rows.filter((row) => row.participant_id === affected);
  const recorded = events.flatMap((event) => {
    const template = templates.find((row) => row.event === `client.${event.type}`);
    if (!template) return [];
    // The fault harness supplies only the authority stamp and calibrated time that live ingest lacks.
    return [
      unwrapRow({
        event: "sdk.telemetry",
        type: event.type,
        attributes: {
          ...template,
          event: "sdk.telemetry",
          event_id: event.event_id,
          seq: event.seq,
          est_server_ms: input.declaration.window.from_ms + 120_000 + event.elapsed_ms,
          continuity_result: event.continuity_result,
        },
      }),
    ];
  });
  const controls = input.rows.filter((row) => row.participant_id !== affected);
  const rows = [...recorded, ...controls];
  const { dropped, verdict } = judgeFixture({ ...input, rows }, CATALOGUE, code);
  expect(dropped).toEqual([]);
  const result = ruleResult(verdict, code);
  if (arm === "positive") {
    expect(result.findings).toBe(1);
    expect(verdict.findings.find((finding) => finding.code === code)).toMatchObject({ subject: `pt:${affected}`, module: "sdk.connection", upstream: "unknown" });
  } else {
    expect(result).toMatchObject({ findings: 0, checked: 2, eligible: 2 });
    for (const eventName of new Set(recorded.map((row) => row.event))) {
      const missing = judgeFixture({ ...input, rows: [...recorded.filter((row) => row.event !== eventName), ...controls] }, CATALOGUE, code);
      expect(ruleResult(missing.verdict, code)).toMatchObject({ findings: 0, checked: 1, eligible: 2 });
    }
  }

  const directory = mkdtempSync(joinPath(tmpdir(), "chalk-continuity-"));
  try {
    const source = joinPath(directory, "world.mjs");
    const { declaration, asof_ms } = input;
    const evidence = {
      observations: observationsFromRows(rows).observations,
      watermarks: completeWatermarks(declaration, CATALOGUE, asof_ms),
    };
    writeFileSync(
      source,
      "export default " +
        JSON.stringify({
          asof_ms,
          tenants: [{ id: declaration.tenant, name: "Test", tz: "UTC" }],
          people: [],
          declarations: [declaration],
          sessions: [],
          evidence: { [declaration.id]: evidence },
          history: [{ item: declaration.id, asof_ms, evidence }],
        }),
    );
    const output = await run([declaration.id, "--fixture", source]);
    expect(output).toMatchObject({ code: 0, err: "" });
    const line = output.out.split("\n").find((line) => line.startsWith("f_") && line.includes(` ${code} `));
    if (arm === "positive") {
      const { outcome, hop } = findings[code];
      expect(line, output.out).toContain(` ${outcome} ${code} pt_`);
      expect(line).toContain('("Seat A")');
      expect(line).toContain(`hop=${hop} module=sdk.connection upstream=unknown`);
    } else {
      expect(line).toBeUndefined();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("continuity observations", () => {
  it.each([true, false])("judges access.connection_lost when refresh denied=%s", async (denyRefresh) => {
    const test = await join({ denyRefresh });
    try {
      for (let elapsed = 0; elapsed < 120_000; elapsed += 1000) {
        await vi.advanceTimersByTimeAsync(1000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(test.client.getSnapshot().connection.status).toBe(denyRefresh ? "failed" : "live");
      const events = await test.records("grant_check", denyRefresh ? "expired" : "verified");
      await runRule("access.connection_lost", denyRefresh ? "positive" : "healthy", events);
    } finally {
      test.client.dispose();
    }
  });

  it.each([
    { state: "failed", suspend: "hidden", wake: "visible" },
    { state: "connected", suspend: "hidden", wake: "visible" },
    { state: "failed", suspend: "background", wake: "foreground" },
    { state: "connected", suspend: "background", wake: "foreground" },
  ] as const)("judges reconnect.dead_live and background.resume_stalled after $wake with a $state peer", async ({ state, suspend, wake }) => {
    const test = await join();
    try {
      test.emit(suspend);
      if (suspend === "hidden") test.emit("frozen");
      test.emit(wake);
      test.freshContact();
      test.peer(state);
      const events = await test.records("resume_check", state === "failed" ? "dead_live" : "verified");
      const arm = state === "failed" ? "positive" : "healthy";
      await runRule("reconnect.dead_live", arm, events);
      await runRule("background.resume_stalled", arm, events);
    } finally {
      test.client.dispose();
    }
  });
});
