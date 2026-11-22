import { describe, expect, it } from "vitest";
import { ClockEstimator } from "./clock.ts";

function clocks() {
  const state = { mono: 1_000, wall: 1_700_000_000_000 };
  return { state, estimator: new ClockEstimator({ mono: () => state.mono, wall: () => state.wall }) };
}

describe("ClockEstimator", () => {
  it("is unsynced until a round trip gives it a sample", () => {
    const { estimator } = clocks();
    expect(estimator.stamp()).toEqual({ client_mono_ms: 1_000, client_wall_ms: 1_700_000_000_000, clock_epoch: 0, clock_state: "unsynced" });
  });

  it("bounds the error by half the round trip and grows it with the sample's age", () => {
    const { state, estimator } = clocks();
    estimator.sample(900, 1_000, 1_800_000_000_000);
    expect(estimator.stamp()).toMatchObject({ clock_state: "synced", est_server_ms: 1_800_000_000_050, clock_err_ms: 50 });
    state.mono += 100_000;
    state.wall += 100_000;
    expect(estimator.stamp()).toMatchObject({ est_server_ms: 1_800_000_100_050, clock_err_ms: 70 });
  });

  it("uses the sample with the tightest bound", () => {
    const { estimator } = clocks();
    estimator.sample(500, 1_000, 1_800_000_000_000);
    estimator.sample(990, 1_000, 1_800_000_000_100);
    expect(estimator.stamp()).toMatchObject({ est_server_ms: 1_800_000_000_105, clock_err_ms: 5 });
  });

  it("drops its samples and starts a new epoch when the wall clock steps", () => {
    const { state, estimator } = clocks();
    estimator.sample(900, 1_000, 1_800_000_000_000);
    state.wall += 60_000;
    expect(estimator.detectJump()).toBe(60_000);
    expect(estimator.stamp()).toMatchObject({ clock_state: "unsynced", clock_epoch: 1 });
    expect(estimator.detectJump()).toBeUndefined();
  });
});
