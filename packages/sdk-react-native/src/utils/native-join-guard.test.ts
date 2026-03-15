import { describe, expect, it } from "bun:test";
import { canStartNativeJoin } from "./native-join-guard";

describe("canStartNativeJoin", () => {
  it("allows a fresh lobby join", () => {
    expect(canStartNativeJoin("lobby", false, false, false)).toBe(true);
  });

  it("blocks duplicate or stale join attempts", () => {
    expect(canStartNativeJoin("joining", false, false, false)).toBe(false);
    expect(canStartNativeJoin("lobby", true, false, false)).toBe(false);
    expect(canStartNativeJoin("lobby", false, true, false)).toBe(false);
    expect(canStartNativeJoin("lobby", false, false, true)).toBe(false);
  });
});
