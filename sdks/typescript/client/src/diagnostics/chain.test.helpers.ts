import { expect, vi } from "vitest";
import { SCHEMA_VER } from "../obs/registry";
import { TelemetryOutbox } from "../telemetry/outbox";
import type { LedgerFrame, TelemetryPlatform } from "../telemetry/types";

/**
 * The deterministic telemetry platform a report/live fault scenario drives: one clock moves only while a send is in
 * flight or the scenario advances it, ids count up, and every posted ledger frame is kept for the hand-off file.
 * `performance.now` is the same clock, so `duration_ms` and `shown_ms` in the committed files are stable.
 * Mirrors `connection/end-wrong-screen.fault.test.ts`.
 */
const WALL_ORIGIN = 1_795_599_000_000;

export function chainTelemetry() {
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
      mono += 40;
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: WALL_ORIGIN + mono };
    },
  };
  const outbox = new TelemetryOutbox({ platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform: "web" }, obsMode: "closed" });
  // Bind the credential of the scenario's join so queued records post, as `connection/lifecycle.ts` binds on entry.
  const tenantId = "ten_00000000000040008000000000000107";
  outbox.bind({ current: () => ({ tenantId, subject: tenantId, token: "telemetry-token", expiresAt: WALL_ORIGIN + 3_600_000 }), refresh: () => Promise.resolve() });
  const monotonic = vi.spyOn(performance, "now").mockImplementation(() => mono);
  return {
    outbox,
    frames,
    advance: (ms: number) => void (mono += ms),
    restore: () => monotonic.mockRestore(),
    /**
     * The client's join-time sync: the flags snapshot it posts on entry is flushed, the send's server_ms answer samples the
     * estimator, and every later record stamps est_server_ms like any client mid-call does. Records before it stay unsynced.
     */
    sync: async () => {
      outbox.obs.setFlags({});
      await outbox.flush();
    },
  };
}

// A frame as JSON without its records' schema_ver: the registry's content hash changes with any registry edit, so the
// hand-off is compared without it, and each record's hash is checked against the registry it was built from instead.
const withoutSchemaVer = (text: string): unknown => JSON.parse(text, (key, value: unknown) => (key === "schema_ver" ? undefined : value));

/**
 * The client-kernel hand-off the API chain test relays: the test file supplies `file.read`/`file.write` so this helper
 * stays free of node APIs (it typechecks outside `*.test.ts`). Write runs first, like `compareChainJSON`, so a first
 * `CHALK_CHAIN_WRITE` creates the committed file the read then verifies.
 */
export function handOff(frames: readonly LedgerFrame[], file: { readonly read: () => string; readonly write?: (text: string) => void }): void {
  for (const event of frames.flatMap((frame) => frame.events)) if ("kind" in event) expect(event.schema_ver).toBe(SCHEMA_VER);
  const text = `${JSON.stringify(frames, null, 2)}\n`;
  file.write?.(text);
  expect(withoutSchemaVer(text)).toEqual(withoutSchemaVer(file.read()));
}
