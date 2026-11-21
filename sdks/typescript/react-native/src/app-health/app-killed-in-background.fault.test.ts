// Fault scenario for app.killed_in_background, hop (a) of its chain: a backgrounded marker and the OS's kill reason report
// the background death (observability/fixtures/app.killed_in_background/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "../../../client/src/telemetry/chain-frames";
import { scanNativePreviousRun, type NativeAppHealth } from "./run-marker";

const CHAIN = "../../../observability/fixtures/app.killed_in_background/chain/";

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

describe("app.killed_in_background fault: a backgrounded dead marker keeps its app_state", () => {
  it("positive: the marker's last app_state is background and the OS says killed", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_700_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health({ phase: "live", js_ready: true, app_state: "background", pid: 4300, launch_id: "l5", last_elapsed_ms: 300_000 }, { reason: "REASON_LOW_MEMORY", launched_at_ms: 1_795_700_000_000 }));
    await settle(outbox);
    await outbox.dispose();
    const names = frames.flatMap((frame) => frame.events.map((event) => event.name));
    expect(names).toEqual(expect.arrayContaining(["previous_run.read", "client.previous_run", "client.app_exit_info"]));
    const [marker] = frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.previous_run"));
    expect(marker).toMatchObject({ app_state: "background" });
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: the user closed the app themselves", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_800_000, 50, "ios");
    await syncClock(outbox);
    await scanNativePreviousRun(outbox, health({ phase: "live", js_ready: true, app_state: "background", clean_exit: "call_ended", pid: 4301, launch_id: "l6" }, { reason: "REASON_USER_REQUESTED" }));
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
