import { describe, expect, it } from "vitest";
import { callCountdown } from "./countdown";
const deadline = new Date(3600000).toISOString();
describe("call countdown", () => {
  it("warns once at 10, 5 and 1 minutes", () => {
    for (const minutes of [10, 5, 1]) {
      const seconds = minutes * 60;
      expect(callCountdown(deadline, 3600000 - seconds * 1000, seconds + 1)).toEqual({ seconds, warning: minutes });
      expect(callCountdown(deadline, 3600000 - (seconds - 1) * 1000, seconds).warning).toBeNull();
    }
  });
  it("shows only the applicable warning on joining late or waking a hidden tab", () => {
    expect(callCountdown(deadline, 3600000 - 480000).warning).toBe(10);
    expect(callCountdown(deadline, 3600000 - 240000).warning).toBe(5);
    expect(callCountdown(deadline, 3600000 - 30000, 700).warning).toBe(1);
  });
  it("re-arms after an extension resets the previous sample", () => {
    expect(callCountdown(deadline, 3000000, 600).warning).toBeNull();
    expect(callCountdown(deadline, 3000000).warning).toBe(10);
  });
  it("does not warn after expiry or without a usable deadline", () => {
    expect(callCountdown(deadline, 3600000)).toEqual({ seconds: 0, warning: null });
    expect(callCountdown(null, 0)).toEqual({ seconds: null, warning: null });
    expect(callCountdown("invalid", 0)).toEqual({ seconds: null, warning: null });
  });
});
