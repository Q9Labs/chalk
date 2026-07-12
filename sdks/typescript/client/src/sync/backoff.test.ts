import { describe, expect, it } from "vitest";
import { calculateBackoffDelay } from "./backoff";

describe("calculateBackoffDelay", () => {
  it("applies deterministic jitter and caps exponential delays", () => {
    expect(calculateBackoffDelay(1, () => 0, { minDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.25 })).toBe(75);
    expect(calculateBackoffDelay(4, () => 1, { minDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.25 })).toBe(500);
  });

  it("rejects invalid attempts, random values, and limits", () => {
    expect(() => calculateBackoffDelay(0, () => 0.5)).toThrow("positive integer");
    expect(() => calculateBackoffDelay(1, () => 1.1)).toThrow("zero through one");
    expect(() => calculateBackoffDelay(1, () => 0.5, { minDelayMs: 10, maxDelayMs: 1, jitterRatio: 0 })).toThrow("invalid backoff options");
  });
});
