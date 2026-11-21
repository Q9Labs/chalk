// Fault scenario for perf.memory_pressure, hop (a) of its chain: a low-memory warning plus a heap near its limit is the
// pressure's evidence (observability/fixtures/perf.memory_pressure/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "./chain-frames";

const CHAIN = "../../../observability/fixtures/perf.memory_pressure/chain/";

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("perf.memory_pressure fault: the warning row and the heap rows agree", () => {
  it("positive: a memory_warning row and a 93%-of-limit heap", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_900_000);
    await syncClock(outbox);
    outbox.obs.fact("client.memory_warning", { app_state: "active", low_memory: true });
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 20, long_task_total_ms_30s: 20, main_ping_max_ms_30s: 14, worker_late_max_ms_30s: 0, heap_probe: "measured", memory_state: "measured", heap_used_mib: 3_800, heap_limit_mib: 4_096, low_memory: true });
    await settle(outbox);
    await outbox.dispose();
    const names = frames.flatMap((frame) => frame.events.map((event) => event.name));
    expect(names).toContain("client.memory_warning");
    expect(names).toContain("client.perf_heartbeat");
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a measured heap far below its limit", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_000_000);
    await syncClock(outbox);
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 15, long_task_total_ms_30s: 15, heap_probe: "measured", memory_state: "measured", heap_used_mib: 320, heap_limit_mib: 4_096 });
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
