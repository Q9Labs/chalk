// Fault scenario for perf.ui_unresponsive, hop (a) of its chain: a window whose long-task max passes the rule's
// threshold is the unresponsive UI's evidence (observability/fixtures/perf.ui_unresponsive/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "./chain-frames";

const CHAIN = "../../../observability/fixtures/perf.ui_unresponsive/chain/";

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("perf.ui_unresponsive fault: a wedged main thread's heartbeat says so", () => {
  it("positive: the 30 s window's long tasks cross the threshold", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_700_000);
    await syncClock(outbox);
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 8_400, long_task_total_ms_30s: 21_000, main_ping_max_ms_30s: 6_000, worker_late_max_ms_30s: 0, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    const [heartbeat] = frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.perf_heartbeat"));
    expect(heartbeat).toMatchObject({ long_task_max_ms_30s: 8_400 });
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: the window's long tasks stay short", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_800_000);
    await syncClock(outbox);
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 40, long_task_total_ms_30s: 80, main_ping_max_ms_30s: 5, worker_late_max_ms_30s: 0, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
