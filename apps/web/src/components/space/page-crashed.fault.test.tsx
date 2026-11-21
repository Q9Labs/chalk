// @vitest-environment jsdom
// Fault scenario for page.crashed, hop (a) of its chain: a React render throw reports its real Error, the fallback surface
// commits, and the health row shows the page alive until it died. The chain's later hops post these frames (observability/fixtures/page.crashed/README.md). CHALK_CHAIN_WRITE=1 rewrites them.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { chainOutbox, handOff, syncClock } from "../../../../../sdks/typescript/client/src/telemetry/chain-frames";
import { appTelemetry } from "../../../../../sdks/typescript/client/src/telemetry/app";
import { CallErrorBoundary } from "./CallErrorBoundary";

const CHAIN = "../../observability/fixtures/page.crashed/chain/";

const Thrower = () => {
  throw new Error("dev fault");
};

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("page.crashed fault: a render throw reports its real Error and shows the fallback", () => {
  it("boundary calls onCrash with the thrown Error and onFallbackShown after commit", () => {
    const onCrash = vi.fn();
    const onFallbackShown = vi.fn(() => () => undefined);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => {
      createRoot(host).render(
        <CallErrorBoundary onCrash={onCrash} onFallbackShown={onFallbackShown}>
          <Thrower />
        </CallErrorBoundary>,
      );
    });
    consoleError.mockRestore();
    expect(onCrash).toHaveBeenCalledWith(expect.any(Error));
    expect(onCrash.mock.calls[0][0].message).toBe("dev fault");
    expect(onFallbackShown).toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("positive: crash rows name the real error and the shown fallback", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_100_000);
    await syncClock(outbox);
    const telemetry = appTelemetry(outbox);
    telemetry.renderCrashed("render_error", new TypeError("dev fault"));
    telemetry.crashFallbackShown();
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 20, long_task_total_ms_30s: 20, main_ping_max_ms_30s: 12, worker_late_max_ms_30s: 0, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    expect(frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.render_crashed"))).toEqual([expect.objectContaining({ render_cause: "render_error", error_name: "TypeError", error_class: "other" })]);
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a quiet run's rows show no crash", async () => {
    const { outbox, frames } = chainOutbox(1_795_700_200_000);
    await syncClock(outbox);
    outbox.obs.fact("client.perf_heartbeat", { window_ms: 30_000, visibility: "visible", long_task_max_ms_30s: 15, long_task_total_ms_30s: 15, heap_probe: "unsupported", memory_state: "unsupported" });
    await settle(outbox);
    await outbox.dispose();
    expect(frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.render_crashed"))).toEqual([]);
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
