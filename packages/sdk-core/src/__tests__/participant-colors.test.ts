import { describe, expect, it } from "vitest";
import { getParticipantAvatarRecipe, getParticipantColor, getParticipantGradient, getParticipantInitial, getParticipantInitials } from "../utils/participant-colors.ts";

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

  it("keeps richer initials behavior available from the shared SDK helper", () => {
    expect(getParticipantInitials("Hasan Shoaib")).toBe("HS");
    expect(getParticipantInitials("hasan@q9labs.ai")).toBe("HA");
    expect(getParticipantInitials("foo.bar_baz")).toBe("FB");
  });

  it("builds the shared avatar recipe using web initials semantics", () => {
    const recipe = getParticipantAvatarRecipe("John Doe");

    expect(recipe.initials).toBe("JD");
    expect(recipe.facehashColors).toEqual([recipe.colors.primary, recipe.colors.gradientEnd, recipe.colors.secondary]);
    expect(recipe.gradientStops).toEqual([
      { color: recipe.colors.primary, offset: "0%" },
      { color: recipe.colors.gradientEnd, offset: "50%" },
      { color: recipe.colors.secondary, offset: "100%" },
    ]);
  });

  it("uses custom preference colors in the shared avatar recipe", () => {
    const recipe = getParticipantAvatarRecipe("Hasan", { mode: "custom", from: "#ff00aa", to: "#7c3aed" });

    expect(recipe.avatarGradient).toBe("linear-gradient(135deg, #ff00aa 0%, #7c3aed 100%)");
    expect(recipe.darkerAvatarGradient).toBe("linear-gradient(135deg, #ff00aa 0%, #4c0abd 100%)");
  });
});
