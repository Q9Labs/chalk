// Fault scenario for the symptom end.wrong_screen (observability/registry/areas/end.json), hop (a) of its chain.
// The Episode ends while the client's end notice is lost and its status read is stale, so a media 403 is taken for a revoked
// credential and the client chooses the connection-lost screen; in the healthy control the status read is current and the
// client chooses the Episode-ended screen. The test drives the real client, connection, kernel and outbox, and compares the
// ledger frames the outbox posts with the committed hand-off files. The API test posts the same files, and the rows it writes
// become the fixture diagnose judges (observability/fixtures/end.wrong_screen/README.md). CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { symptom } from "../../../../../observability/rules/end.wrong_screen.mjs";
import { CloudflareSFUError } from "../media";
import { SCHEMA_VER } from "../obs/registry";
import { TelemetryOutbox } from "../telemetry/outbox";
import type { LedgerFrame, TelemetryPlatform } from "../telemetry/types";
import type { ConnectionDependencies, ConnectionMediaFactoryInput } from "./dependencies";
import { joinWithTerminalControl, terminalTestClient, terminalTestPlatform } from "../space-client/terminal.test.helpers";

type Run = "positive" | "healthy";

const CHAIN = new URL("../../../../../observability/fixtures/end.wrong_screen/chain/", import.meta.url);
const framesFile = (run: Run) => new URL(`client-frames.${run}.json`, CHAIN);

// Where the kernel's clock estimate places the client's end record, and how long each round trip takes: the fault's record is
// 1.2 s after the Episode's end, the control's 0.3 s after it. The server answers with its time halfway through the trip.
const SERVER: { readonly [run in Run]: { readonly estimateMs: number; readonly roundTripMs: number } } = {
  positive: { estimateMs: 1_795_600_001_200, roundTripMs: 80 },
  healthy: { estimateMs: 1_795_600_000_300, roundTripMs: 50 },
};
const WALL_ORIGIN = 1_795_599_000_000;

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

// A telemetry platform whose clocks move only while a request is in flight, so every stamp is the same on every run, and a
// server that settles every seq and says its time. It keeps the frames it took.
function chainTelemetry(run: Run) {
  const { estimateMs, roundTripMs } = SERVER[run];
  const frames: LedgerFrame[] = [];
  let mono = 1_000;
  let ids = 0;
  const platform: TelemetryPlatform = {
    now: () => mono,
    wall: () => WALL_ORIGIN + mono,
    uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    online: () => true,
    hidden: () => false,
    subscribe: () => () => undefined,
    send: async (request) => {
      const frame: LedgerFrame = JSON.parse(request.body);
      frames.push(frame);
      mono += roundTripMs;
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: estimateMs - roundTripMs / 2 };
    },
  };
  const outbox = new TelemetryOutbox({ platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform: "web" }, obsMode: "closed" });
  return { outbox, frames };
}

function scenario(run: Run) {
  const base = terminalTestPlatform();
  const now = Date.now();
  const telemetry = chainTelemetry(run);
  const status = vi.fn<NonNullable<ConnectionDependencies["getEpisodeStatus"]>>().mockResolvedValue(run === "positive" ? "active" : "ended");
  let onFailure: ConnectionMediaFactoryInput["onFailure"] = () => {};
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      clock: { ...base.dependencies.clock, now: () => now },
      telemetry: telemetry.outbox,
      getEpisodeStatus: status,
      createMediaClient: (input: ConnectionMediaFactoryInput) => {
        onFailure = input.onFailure;
        return base.dependencies.createMediaClient(input);
      },
    },
  };
  return { platform, telemetry, ...terminalTestClient(platform), revokeMedia: () => onFailure(new CloudflareSFUError("Publications rejected", "signaling_failed", { status: 403 })) };
}

// A frame as JSON without its records' schema_ver: the registry's content hash changes with any registry edit, so the hand-off is
// compared without it, and each record's hash is checked against the registry it was built from instead.
const withoutSchemaVer = (text: string): unknown => JSON.parse(text, (key, value: unknown) => (key === "schema_ver" ? undefined : value));

function handOff(run: Run, frames: readonly LedgerFrame[]): void {
  for (const event of frames.flatMap((frame) => frame.events)) if ("kind" in event) expect(event.schema_ver).toBe(SCHEMA_VER);
  const text = `${JSON.stringify(frames, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(framesFile(run), text);
  expect(withoutSchemaVer(text)).toEqual(withoutSchemaVer(readFileSync(framesFile(run), "utf8")));
}

async function drive(run: Run, ended: (test: ReturnType<typeof scenario>) => void): Promise<readonly LedgerFrame[]> {
  const test = scenario(run);
  try {
    await joinWithTerminalControl(test.client, test.platform);
    // Settle what the join recorded, so the end record is stamped against a server clock sample, as on a live call.
    await test.telemetry.outbox.flush();
    test.revokeMedia();
    await vi.waitFor(() => ended(test));
    await test.telemetry.outbox.flush();
    await test.telemetry.outbox.dispose();
    return test.telemetry.frames;
  } finally {
    test.client.dispose();
  }
}

const endRecords = (frames: readonly LedgerFrame[]) => frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.call_ended"));

describe(symptom, () => {
  it("positive: a stale active status and a lost end notice make the client show connection lost", async () => {
    const frames = await drive("positive", (test) => expect(test.client.getSnapshot().connection.status).toBe("failed"));
    expect(endRecords(frames)).toEqual([expect.objectContaining({ kind: "fact", end_reason: "connection_lost", clock_state: "synced", est_server_ms: 1_795_600_001_200, clock_err_ms: 40 })]);
    handOff("positive", frames);
  });

  it("healthy: a current status read ends the call on the Episode-ended screen", async () => {
    const frames = await drive("healthy", (test) => expect(test.client.getSnapshot().connection.status).toBe("left"));
    const [record, ...extra] = endRecords(frames);
    expect(extra).toEqual([]);
    expect(record).toMatchObject({ kind: "fact", clock_state: "synced", est_server_ms: 1_795_600_000_300, clock_err_ms: 25 });
    expect(["episode_ended", "time_limit"]).toContain(record?.end_reason);
    handOff("healthy", frames);
  });
});
