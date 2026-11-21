// Fault scenario for app.crashed_at_launch, hop (a) of its chain: a launch marker that never reached js_ready, and the OS
// crash reason, report the launch death (observability/fixtures/app.crashed_at_launch/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "../../../client/src/telemetry/chain-frames";
import { scanNativePreviousRun, type NativeAppHealth } from "./run-marker";

const CHAIN = "../../../observability/fixtures/app.crashed_at_launch/chain/";

const health = (marker: Record<string, unknown> | null, exit: { reason: string } | null): NativeAppHealth => ({
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

describe("app.crashed_at_launch fault: a launch marker with js_ready false is the whole story", () => {
  it("positive: phase launch, js_ready false, OS crash reason", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_500_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health({ phase: "launch", js_ready: false, pid: 4200, launch_id: "l3", launched_at_ms: 1_795_700_500_000, last_elapsed_ms: 4_000 }, { reason: "REASON_CRASH", launched_at_ms: 1_795_700_500_000 }));
    await settle(outbox);
    await outbox.dispose();
    const names = frames.flatMap((frame) => frame.events.map((event) => event.name));
    expect(names).toEqual(expect.arrayContaining(["previous_run.read", "client.previous_run", "client.app_exit_info"]));
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("a platform with no exit answer maps to no_exit_reason", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_600_000, 50, "ios");
    await scanNativePreviousRun(outbox, health({ phase: "launch", js_ready: false, pid: 4200 }, null));
    await outbox.flush();
    const [exit] = frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.app_exit_info"));
    expect(exit).toMatchObject({ exit_reason: "no_exit_reason" });
    await outbox.dispose();
  });

  it("healthy: a launch that reached js_ready was not a launch death", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_600_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health({ phase: "live", js_ready: true, app_state: "active", clean_exit: "call_ended", pid: 4201, launch_id: "l4" }, { reason: "REASON_USER_REQUESTED" }));
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
