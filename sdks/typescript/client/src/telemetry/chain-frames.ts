import { readFileSync, writeFileSync } from "node:fs";
import { SCHEMA_VER } from "../obs/registry";
import { TelemetryOutbox } from "./outbox";
import type { LedgerFrame, TelemetryPlatform } from "./types";

const WALL_ORIGIN = 1_795_599_000_000;

/**
 * The chain's deterministic outbox (see observability/fixtures READMEs): clocks only move while a send is in
 * flight, ids are sequential, and every post is captured so the hand-off file is the real kernel's frames.
 */
export function chainOutbox(serverMs: number, roundTripMs = 50, platform: "web" | "ios" = "web") {
  const frames: LedgerFrame[] = [];
  let mono = 1_000;
  let ids = 0;
  const fake: TelemetryPlatform = {
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
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: serverMs - roundTripMs / 2 };
    },
  };
  const outbox = new TelemetryOutbox({ platform: fake, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform }, obsMode: "closed" });
  outbox.bind({ current: () => ({ subject: "chain", token: "chain", expiresAt: 9_999_999_999_999 }), refresh: () => Promise.resolve() });
  return { outbox, frames };
}

/**
 * Gives the estimator its round-trip sample so the records that follow stamp `synced` with `est_server_ms` — the state a
 * participant's client is in by the time a call has run long enough to crash. The record it posts is of the legacy
 * vocabulary, which the proof rows skip rather than drop.
 */
export async function syncClock(outbox: TelemetryOutbox): Promise<void> {
  outbox.record({ type: "platform_changed", platform_state: "online" });
  await outbox.flush();
}

/**
 * Writes the outbox's posted frames to the chain file under CHALK_CHAIN_WRITE=1, and compares them otherwise, so a
 * record whose fields changed fails here. schema_ver is left out of the comparison — any registry edit changes it — and
 * each record's hash is checked against the registry it was built from instead.
 */
export function handOff(file: string, frames: readonly LedgerFrame[], expect: (value: unknown, want: unknown) => void): void {
  for (const event of frames.flatMap((frame) => frame.events)) if ("kind" in event) expect(event.schema_ver, SCHEMA_VER);
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === "schema_ver" ? undefined : v)));
  const text = `${JSON.stringify(frames, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(file, text);
  expect(strip(JSON.parse(text)), strip(JSON.parse(readFileSync(file, "utf8"))));
}
