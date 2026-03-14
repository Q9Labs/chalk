import { describe, expect, it } from "bun:test";
import { getParticipantColor, getParticipantGradient, getParticipantInitial } from "../utils/participant-colors.ts";

describe("participant colors", () => {
  it("returns the same palette for the same participant seed", () => {
    expect(getParticipantColor("Hasan")).toEqual(getParticipantColor("Hasan"));
  });

  it("respects custom gradient preferences", () => {
    const colors = getParticipantColor("Hasan", { mode: "custom", from: "#ff00aa", to: "#7c3aed" });
    expect(colors.primary).toBe("#ff00aa");
    expect(colors.gradientEnd).toBe("#7c3aed");
  });

  it("builds a stable gradient string and initial", () => {
    expect(getParticipantGradient("Hasan")).toContain("linear-gradient");
    expect(getParticipantInitial("hasan")).toBe("H");
  });
});
