// Fault scenario for page.tab_died, hop (a) of its chain: a marker the dead run left reports it, and the next run's scan
// emits the op and the marker row (observability/fixtures/page.tab_died/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "./chain-frames";
import { noPing, scanPreviousRuns } from "./previous-run";
import type { RunMarker } from "./run-marker";

const CHAIN = "../../../observability/fixtures/page.tab_died/chain/";

const dead: RunMarker = { cs: "00000000-0000-4000-8000-000000000099", phase: "live", visibility: "visible", last_elapsed_ms: 91_000, written_ms: Date.now() - 120_000 };

const storage = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
};

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("page.tab_died fault: a dead run's marker reports the run it left", () => {
  it("the scan reports the dead marker and forgets its key", async () => {
    const store = storage({ "chalk.run_marker.00000000-0000-4000-8000-000000000099": JSON.stringify(dead) });
    const { outbox } = chainOutbox(1_795_700_500_000);
    const reported = await scanPreviousRuns(outbox, { storage: store, ownCs: outbox.clientSessionId, ping: noPing });
    expect(reported).toHaveLength(1);
    expect(store.getItem("chalk.run_marker.00000000-0000-4000-8000-000000000099")).toBeNull();
  });

  it("positive: the scan's op and the dead marker's row reach the ledger", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_500_000);
    await syncClock(outbox);
    await scanPreviousRuns(outbox, { storage: storage({ "chalk.run_marker.00000000-0000-4000-8000-000000000099": JSON.stringify(dead) }), ownCs: outbox.clientSessionId, ping: noPing });
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 20, long_task_total_ms_30s: 20, main_ping_max_ms_30s: 11, worker_late_max_ms_30s: 0, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    const events = frames.flatMap((frame) => frame.events.map((event) => event.name));
    expect(events).toContain("previous_run.read");
    expect(events).toContain("client.previous_run");
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a boot with no dead marker reports no_marker", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_600_000);
    await syncClock(outbox);
    await scanPreviousRuns(outbox, { storage: storage({}), ownCs: outbox.clientSessionId, ping: noPing });
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 15, long_task_total_ms_30s: 15, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    expect(frames.flatMap((frame) => frame.events.map((event) => event.name))).not.toContain("client.previous_run");
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
