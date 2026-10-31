import { describe, expect, it } from "vitest";
import { CameraEffectPerformance } from "./camera-effect-performance";

describe("camera effect frame rate", () => {
  it("allows warm-up, then falls back after three seconds below 15 fps", () => {
    const meter = new CameraEffectPerformance();
    for (let time = 0; time < 4000; time += 100) expect(meter.record(time)).toBeUndefined();
    expect(meter.record(4000)).toBeCloseTo(31 / 3);
  });
  it("keeps usable processing active across measurement windows", () => {
    const meter = new CameraEffectPerformance();
    for (let frame = 0; frame < 240; frame++) expect(meter.record((frame * 1000) / 24)).toBeUndefined();
  });
  it("starts a new warm-up after a pause or an effect change", () => {
    const meter = new CameraEffectPerformance();
    meter.record(0);
    meter.record(2000);
    meter.reset();
    expect(meter.record(100_000)).toBeUndefined();
    expect(meter.record(100_500)).toBeUndefined();
  });
});
