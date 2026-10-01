import { describe, expect, it } from "vitest";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";

describe("camera uplink policy", () => {
  it("pauses only the extra layer below the full-camera budget", () => {
    const policy = new CameraUplinkPolicy();
    expect(policy.sample(800_000, true)).toBe(false);
    expect(policy.sample(400_000, false)).toBe(false);
    expect(policy.sample(1_500_000, true)).toBe(true);
  });

  it("requires five consecutive healthy samples to restore the extra layer", () => {
    const policy = new CameraUplinkPolicy();
    for (let i = 0; i < 4; i++) expect(policy.sample(2_000_000, false)).toBe(false);
    expect(policy.sample(2_000_000, false)).toBe(true);
  });

  it("resets recovery after a weak or missing sample and on camera replacement", () => {
    const policy = new CameraUplinkPolicy();
    policy.sample(2_000_000, false);
    expect(policy.sample(1_900_000, false)).toBe(false);
    policy.sample(2_000_000, false);
    expect(policy.sample(undefined, false)).toBe(false);
    policy.sample(2_000_000, false);
    policy.reset();
    for (let i = 0; i < 4; i++) expect(policy.sample(2_000_000, false)).toBe(false);
  });

  it.each([undefined, 0, -1, NaN, Infinity])("leaves configured layers alone when bitrate is unavailable: %s", (bitrate) => {
    expect(new CameraUplinkPolicy().sample(bitrate, true)).toBe(true);
    expect(new CameraUplinkPolicy().sample(bitrate, false)).toBe(false);
  });

  it("uses only a live selected or nominated candidate pair", () => {
    expect(
      cameraUplinkBitrate([
        { type: "candidate-pair", state: "failed", nominated: true, availableOutgoingBitrate: 10 },
        { type: "candidate-pair", state: "succeeded", nominated: false, availableOutgoingBitrate: 20 },
        { type: "candidate-pair", state: "succeeded", nominated: true, availableOutgoingBitrate: 800_000 },
      ]),
    ).toBe(800_000);
    expect(cameraUplinkBitrate([{ type: "candidate-pair", state: "succeeded", selected: true, availableOutgoingBitrate: 400_000 }])).toBe(400_000);
    expect(cameraUplinkBitrate([])).toBeUndefined();
  });
});
