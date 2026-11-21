// Fault scenario for app.crashed, hop (a) of its chain: the previous process's live marker and the OS's crash exit reason
// report the crash, and the dead run's own JS fatal and render-crash rows name its cause (observability/fixtures/app.crashed/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "../../../client/src/telemetry/chain-frames";
import { appTelemetry } from "../../../client/src/telemetry/app";
import { scanNativePreviousRun, type NativeAppHealth } from "./run-marker";

const CHAIN = "../../../observability/fixtures/app.crashed/chain/";

const health = (marker: Record<string, unknown> | null, exit: { reason: string; launched_at_ms?: number } | null): NativeAppHealth => ({
  markReady: () => undefined,
  markFatal: () => undefined,
  markCallEnded: () => undefined,
  setAppState: () => undefined,
  readMarker: () => Promise.resolve(marker),
  readExitInfo: () => Promise.resolve(exit),
  lowMemory: () => Promise.resolve(false),
  thermalState: () => Promise.resolve("nominal"),
});

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("app.crashed fault: a dead foreground run's marker and OS exit reach the next run", () => {
  it("positive: marker, exit reason, js_fatal and render crash rows reach the ledger", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_300_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health({ phase: "live", js_ready: true, app_state: "active", pid: 4100, launch_id: "l1", launched_at_ms: 1_795_700_000_000, last_elapsed_ms: 300_000 }, { reason: "REASON_CRASH", launched_at_ms: 1_795_700_000_000 }));
    outbox.obs.fact("client.app_js_fatal", { error_name: "TypeError", error_class: "other", error_fingerprint: "aabbccddee01", app_state: "active" });
    appTelemetry(outbox).renderCrashed("render_error", new TypeError("undefined is not an object"));
    await settle(outbox);
    await outbox.dispose();
    const names = frames.flatMap((frame) => frame.events.map((event) => event.name));
    expect(names).toEqual(expect.arrayContaining(["previous_run.read", "client.previous_run", "client.app_exit_info", "client.app_js_fatal", "client.render_crashed"]));
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a fresh boot finds no dead run", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_400_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health(null, null));
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
