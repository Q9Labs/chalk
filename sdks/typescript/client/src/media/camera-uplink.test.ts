import { describe, expect, it } from "vitest";
import { CameraUplinkPolicy, cameraUplinkBitrate } from "./camera-uplink";

describe("camera uplink policy", () => {
  it.each([666_000, 999_999, 400_000])("keeps the half-size layer on when %i bit/s cannot carry the full-size layer", (bitrate) => {
    const policy = new CameraUplinkPolicy();
    for (let i = 0; i < 20; i++) expect(policy.sample(bitrate, true)).toBe(true);
  });

  it("restores the half-size layer at once when the estimate collapses", () => {
    expect(new CameraUplinkPolicy().sample(666_000, false)).toBe(true);
  });

  it("pauses the half-size layer only after five consecutive constrained samples", () => {
    const policy = new CameraUplinkPolicy();
    for (let i = 0; i < 4; i++) expect(policy.sample(1_200_000, true)).toBe(true);
    expect(policy.sample(1_200_000, true)).toBe(false);
  });

  it("holds the layer in the band between starved and pausable", () => {
    const policy = new CameraUplinkPolicy();
    for (let i = 0; i < 20; i++) expect(policy.sample(1_100_000, true)).toBe(true);
    for (let i = 0; i < 20; i++) expect(policy.sample(1_100_000, false)).toBe(false);
  });

  it("restarts the pause count after a starved or missing sample", () => {
    for (const interruption of [800_000, undefined, 1_100_000]) {
      const policy = new CameraUplinkPolicy();
      for (let i = 0; i < 4; i++) policy.sample(1_200_000, true);
      policy.sample(interruption, true);
      expect(policy.sample(1_200_000, true)).toBe(true);
    }
  });

  it.each([
    [1_199_999, true, true],
    [1_200_000, true, false],
    [1_499_999, true, false],
    [1_500_000, true, true],
    [1_999_999, false, false],
    [2_000_000, false, true],
  ])("at %i bit/s with the half-size layer %s settles on %s after five samples", (bitrate, lowActive, settled) => {
    const policy = new CameraUplinkPolicy();
    let result = lowActive;
    for (let i = 0; i < 5; i++) result = policy.sample(bitrate, lowActive);
    expect(result).toBe(settled);
  });

  it("does not pause on a brief dip", () => {
    const policy = new CameraUplinkPolicy();
    for (let i = 0; i < 4; i++) policy.sample(1_200_000, true);
    policy.sample(1_600_000, true);
    for (let i = 0; i < 4; i++) expect(policy.sample(1_200_000, true)).toBe(true);
  });

  it("requires five consecutive healthy samples to restore the half-size layer", () => {
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
