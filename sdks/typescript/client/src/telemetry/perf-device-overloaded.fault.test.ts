// Fault scenario for perf.device_overloaded, hop (a) of its chain: a measured critical pressure/thermal row is the
// overloaded device's evidence (observability/fixtures/perf.device_overloaded/README.md). CHALK_CHAIN_WRITE=1 rewrites the hand-off.
import { describe, expect, it } from "vitest";
import { chainOutbox, handOff, syncClock } from "./chain-frames";

const CHAIN = "../../../observability/fixtures/perf.device_overloaded/chain/";

async function settle(outbox: ReturnType<typeof chainOutbox>["outbox"]) {
  await outbox.flush();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("perf.device_overloaded fault: the pressure probe reports critical", () => {
  it("positive: a measured critical cpu_pressure row", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_100_000);
    await syncClock(outbox);
    outbox.obs.fact("client.thermal_changed", { probe_state: "measured", cpu_pressure: "critical", thermal_state: "critical", app_state: "active", visibility: "visible" });
    await settle(outbox);
    await outbox.dispose();
    const [row] = frames.flatMap((frame) => frame.events.filter((event) => event.name === "client.thermal_changed"));
    expect(row).toMatchObject({ probe_state: "measured", cpu_pressure: "critical" });
    handOff(CHAIN + "client-frames.positive.json", frames, (got, want) => expect(got).toEqual(want));
  });

  it("healthy: a measured nominal pressure row", async () => {
    const { outbox, frames } = chainOutbox(1_795_701_200_000);
    await syncClock(outbox);
    outbox.obs.fact("client.thermal_changed", { probe_state: "measured", cpu_pressure: "nominal", visibility: "visible" });
    await settle(outbox);
    await outbox.dispose();
    handOff(CHAIN + "client-frames.healthy.json", frames, (got, want) => expect(got).toEqual(want));
  });
});
