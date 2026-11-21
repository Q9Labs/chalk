// @vitest-environment jsdom
// Fault scenario for page.uncaught_error, hop (a) of its chain: an uncaught error event reaches the page-failure listener
// with its real object, and the run reports unhandled_error with that error's fields (observability/fixtures/page.uncaught_error/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it, vi } from "vitest";
import { chainOutbox, handOff, syncClock } from "../../../../../sdks/typescript/client/src/telemetry/chain-frames";
import { appTelemetry } from "../../../../../sdks/typescript/client/src/telemetry/app";
import { installChunkLoadAutoReload, onPageFailure } from "../../lib/chunkReload";

installChunkLoadAutoReload();
const CHAIN = "../../observability/fixtures/page.uncaught_error/chain/";

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("page.uncaught_error fault: uncaught events reach the listener with their objects", () => {
  it("announces unhandled_error with event.error and unhandled_rejection with event.reason", () => {
    const listener = vi.fn();
    const stop = onPageFailure(listener);
    const error = new TypeError("boom");
    window.dispatchEvent(new ErrorEvent("error", { error, message: "boom" }));
    const reason = new RangeError("nope");
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason }));
    stop();
    const calls = listener.mock.calls.map(([cause, detail]) => [cause, detail]);
    expect(calls).toContainEqual(["unhandled_error", error]);
    expect(calls).toContainEqual(["unhandled_rejection", reason]);
  });

  it("positive: the run reports the uncaught error with its real fields", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_300_000);
    await syncClock(outbox);
    appTelemetry(outbox).renderCrashed("unhandled_error", new TypeError("boom"));
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 20, long_task_total_ms_30s: 20, main_ping_max_ms_30s: 13, worker_late_max_ms_30s: 0, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a quiet run reports no uncaught error", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_400_000);
    await syncClock(outbox);
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 15, long_task_total_ms_30s: 15, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
